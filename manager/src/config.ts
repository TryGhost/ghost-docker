// Validate the configuration split (docs/configuration.md). Derive operator keys
// and container-owned values from Compose instead of maintaining parallel lists.
// Compose interpolates inactive services too; optional requirements are mode-specific.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { composeConfig, composeVariables, splitComposeFile, type ConfigResult } from './compose.ts';
import { inspectImage } from './docker/client.ts';
import * as env from './env.ts';
import { CliError } from './errors.ts';
import { modeOf, readIfExists } from './fs.ts';
import type { Io } from './io.ts';
import { ok, type Check } from './report.ts';
import {
    COMPOSE_OVERRIDE_FILE,
    ENV_EXAMPLE_FILE,
    ENV_FILE,
    GHOST_ENV_FILE,
    hasProfile,
    hostOf,
    INFRA_PROFILE,
    layoutOf,
    MEMBER_PROFILE,
    OPTIONAL_PROFILES,
    profileConflict,
    SITE_MODES,
    siteMode,
    splitProfiles,
    unknownProfiles,
} from './site.ts';

export interface Finding {
    readonly level: 'error' | 'warning';
    readonly file: string;
    readonly message: string;
}

/** Keys required in `.env` that nothing else would catch, by mode. */
export const REQUIRED_KEYS = {
    common: ['COMPOSE_PROFILES', 'COMPOSE_PROJECT_NAME', 'SITE_MODE', 'PROJECT_DIR'],
    /** compose.yml does not `:?`-guard these: the shared Caddy's directory has none. */
    site: ['GHOST_VERSION', 'DATABASE_PASSWORD', 'DATABASE_ROOT_PASSWORD'],
    production: ['URL'],
    /** Behind the shared Caddy, and in its own directory. */
    shared: ['INGRESS_NETWORK'],
} as const;

/** Modes that hold credentials and are still private. */
const PRIVATE_MODES = new Set([0o600, 0o400, 0o640]);

const error = (file: string, message: string): Finding => ({ level: 'error', file, message });
const warning = (file: string, message: string): Finding => ({ level: 'warning', file, message });

function privacy(file: string, path: string): Finding[] {
    const mode = modeOf(path);
    if (mode === undefined || PRIVATE_MODES.has(mode)) {
        return [];
    }
    return [
        warning(
            file,
            `mode is ${mode.toString(8).padStart(4, '0')}; it holds credentials and should be 0600`,
        ),
    ];
}

const interpolated = (file: string, text: string): Finding[] =>
    env
        .lint(text)
        .map((key) =>
            error(
                file,
                `${key}: the value is interpolated by Compose (an unescaped $); write $$ for a literal dollar sign, or set it with ./ghost-docker config set`,
            ),
        );

/** `.env`, for the mode it declares. */
export async function validateEnv(io: Io, dir: string): Promise<Finding[]> {
    const file = ENV_FILE;
    const path = join(dir, file);
    const text = readIfExists(path);
    if (text === undefined) {
        return [error(file, `${path} is missing`)];
    }
    let values: Record<string, string>;
    try {
        values = env.toRecord(text);
    } catch (problem) {
        return [error(file, (problem as Error).message)];
    }
    const findings: Finding[] = [];

    const profiles = values.COMPOSE_PROFILES ?? '';
    if (profiles === '') {
        return [
            error(
                file,
                `COMPOSE_PROFILES is not set; it must name exactly one site mode (${SITE_MODES.join(', ')})`,
            ),
        ];
    }
    if (layoutOf(profiles) === INFRA_PROFILE) {
        return [
            ...validateInfra(file, values),
            ...interpolated(file, text),
            ...privacy(file, path),
        ];
    }
    const mode = siteMode(profiles);
    if (mode === null) {
        findings.push(
            error(
                file,
                `COMPOSE_PROFILES=${profiles} must name exactly one site mode (${SITE_MODES.join(', ')})`,
            ),
        );
    }
    const unknown = unknownProfiles(profiles);
    if (unknown.length > 0) {
        findings.push(
            error(
                file,
                `unknown profile(s) in COMPOSE_PROFILES: ${unknown.join(', ')} (optional profiles are ${OPTIONAL_PROFILES.join(', ')})`,
            ),
        );
    }
    for (const profile of splitProfiles(profiles)) {
        const conflict = mode === null ? null : profileConflict(mode, profile);
        if (conflict !== null) {
            findings.push(error(file, `COMPOSE_PROFILES selects ${profile}, which ${conflict}`));
        }
    }
    const declared = values.SITE_MODE;
    if (mode !== null && declared && declared !== mode) {
        findings.push(
            error(
                file,
                `SITE_MODE=${declared} does not match the site mode in COMPOSE_PROFILES (${mode})`,
            ),
        );
    }

    const member = hasProfile(profiles, MEMBER_PROFILE);
    const required = [
        ...REQUIRED_KEYS.common,
        ...REQUIRED_KEYS.site,
        ...(mode === 'production' ? REQUIRED_KEYS.production : []),
        ...(member ? REQUIRED_KEYS.shared : []),
    ];
    for (const key of required) {
        if (values[key] === undefined) {
            findings.push(error(file, `${key} is required for mode ${mode ?? 'unknown'}`));
        } else if (values[key] === '') {
            findings.push(error(file, `${key} is empty`));
        }
    }

    // A production site is served by Caddy, over HTTPS, on the host its URL
    // names; that host is the site's domain.
    if (mode === 'production') {
        for (const key of ['URL', 'ADMIN_URL']) {
            const url = values[key];
            if (url && (!url.startsWith('https://') || hostOf(url) === '')) {
                findings.push(
                    error(
                        file,
                        `${key} must be https://, with a domain, for production: got ${url}`,
                    ),
                );
            }
        }
    }

    if (member) {
        findings.push(...externalIngress(file, values));
    }

    // The extra databases are created once, on first initialisation. A custom
    // ActivityPub database name that is not in that list never exists.
    const activitypubDatabase = values.ACTIVITYPUB_DATABASE_NAME;
    if (activitypubDatabase) {
        const extra = values.DATABASE_EXTRA_DATABASES ?? 'activitypub';
        // mysql-init splits the list on commas and whitespace alike.
        if (!extra.split(/[\s,]+/).includes(activitypubDatabase)) {
            findings.push(
                error(
                    file,
                    `ACTIVITYPUB_DATABASE_NAME=${activitypubDatabase} is not listed in DATABASE_EXTRA_DATABASES (${extra})`,
                ),
            );
        }
    }

    // The image layout moved between variants. Ask the image where it keeps
    // content rather than mapping tag names, which would drift. Skipped when
    // the image has not been pulled.
    const reference =
        values.GHOST_IMAGE_REF ||
        (values.GHOST_VERSION ? `${values.GHOST_IMAGE || 'ghost'}:${values.GHOST_VERSION}` : '');
    if (reference) {
        const image = await inspectImage(io.docker, reference).catch(() => null);
        const expected = image?.env.GHOST_CONTENT;
        const configured = values.GHOST_CONTENT_PATH || '/home/ghost/content';
        if (expected && expected !== configured) {
            findings.push(
                error(
                    file,
                    `GHOST_CONTENT_PATH is ${configured} but ${reference} keeps its content in ${expected}; set GHOST_CONTENT_PATH and GHOST_TINYBIRD_PATH to match the image`,
                ),
            );
        }
    }

    // Compose merges compose.override.yml only when COMPOSE_FILE is unset, or
    // names it: one an operator wrote and the list leaves out is not run.
    const composeFile = values.COMPOSE_FILE ?? '';
    if (
        composeFile !== '' &&
        existsSync(join(dir, COMPOSE_OVERRIDE_FILE)) &&
        !splitComposeFile(dir, composeFile, values.COMPOSE_PATH_SEPARATOR || ':').includes(
            join(dir, COMPOSE_OVERRIDE_FILE),
        )
    ) {
        findings.push(
            warning(
                file,
                `COMPOSE_FILE does not name ${COMPOSE_OVERRIDE_FILE}, so the site does not run it; add it to COMPOSE_FILE, or remove the file`,
            ),
        );
    }

    findings.push(...interpolated(file, text), ...privacy(file, path));
    return findings;
}

/**
 * The shared Caddy's directory: Caddy alone, so `infra` and nothing else,
 * on the network the manager created for it.
 */
function validateInfra(file: string, values: Record<string, string>): Finding[] {
    const findings: Finding[] = [];
    const profiles = splitProfiles(values.COMPOSE_PROFILES ?? '');
    if (profiles.length !== 1) {
        findings.push(
            error(
                file,
                `COMPOSE_PROFILES=${values.COMPOSE_PROFILES} selects the shared Caddy (${INFRA_PROFILE}), which runs Caddy alone: remove ${profiles.filter((profile) => profile !== INFRA_PROFILE).join(', ')}`,
            ),
        );
    }
    if (values.SITE_MODE && values.SITE_MODE !== INFRA_PROFILE) {
        findings.push(
            error(
                file,
                `SITE_MODE=${values.SITE_MODE} does not match COMPOSE_PROFILES (${INFRA_PROFILE})`,
            ),
        );
    }
    for (const key of [...REQUIRED_KEYS.common, ...REQUIRED_KEYS.shared]) {
        if (values[key] === undefined) {
            findings.push(error(file, `${key} is required for the shared Caddy`));
        } else if (values[key] === '') {
            findings.push(error(file, `${key} is empty`));
        }
    }
    return [...findings, ...externalIngress(file, values)];
}

/** The shared Caddy's network is the manager's, so Compose must not create or remove it. */
const externalIngress = (file: string, values: Record<string, string>): Finding[] =>
    values.INGRESS_EXTERNAL === 'true'
        ? []
        : [
              error(
                  file,
                  `INGRESS_EXTERNAL must be true: ${values.INGRESS_NETWORK || 'the network'} is the shared Caddy's, which no Compose project creates or removes`,
              ),
          ];

/**
 * `ghost.env` holds Ghost application settings only. Two mistakes matter, and
 * both are detected rather than listed:
 *
 *  - a key the container owns. Compose `environment` overrides `env_file`, so
 *    setting it here looks effective and is silently ignored. Detected by
 *    asking Compose what the container actually receives.
 *  - an operator setting in the wrong file. Detected from the variables
 *    Compose interpolates, the settings .env.example documents,
 *    COMPOSE_*, and whatever `.env` defines.
 *
 * `resolved` is the project as the caller already resolved it from the files
 * as they are now; without it, Compose is asked here.
 */
export async function validateGhostEnv(
    io: Io,
    dir: string,
    resolved?: ConfigResult,
): Promise<Finding[]> {
    const file = GHOST_ENV_FILE;
    const path = join(dir, file);
    const text = readIfExists(path);
    // Optional: a site can run entirely on container-owned configuration.
    if (text === undefined) {
        return [];
    }
    let values: Record<string, string>;
    try {
        values = env.toRecord(text);
    } catch (problem) {
        return [error(file, (problem as Error).message)];
    }
    const findings: Finding[] = [];

    resolved ??= await composeConfig(io, dir);
    const container = resolved.ok ? resolved.project.services.ghost?.environment : undefined;
    if (container === undefined) {
        findings.push(
            warning(
                file,
                `the Compose configuration could not be resolved, so container-owned keys were not checked${resolved.ok ? '' : `: ${resolved.reason.split('\n').at(-1)}`}`,
            ),
        );
    }
    // Unresolved, the warning above already says so: no key is called misplaced.
    const isOperatorKey = await operatorKeyTest(io, dir).catch(() => () => false);

    for (const [key, value] of Object.entries(values)) {
        // env_file is merged into the service environment, so every ghost.env
        // key appears there. A different value means an explicit
        // `environment` entry took precedence. Neither value is shown: the
        // container's own are database passwords and the like.
        const effective = container?.[key];
        if (effective !== undefined && effective !== value) {
            findings.push(
                error(
                    file,
                    `${key} is set by the container, which takes precedence, so it is ignored in ${file}; remove it`,
                ),
            );
            continue;
        }
        if (isOperatorKey(key)) {
            findings.push(error(file, `${key} is an operator setting and belongs in ${ENV_FILE}`));
        }
    }

    findings.push(...interpolated(file, text), ...privacy(file, path));
    return findings;
}

/**
 * The settings `.env.example` documents, commented out or not: the operator
 * settings the manager reads itself (ADMIN_URL, ...) as well as the
 * ones Compose interpolates.
 */
export function documentedVariables(exampleText: string): Set<string> {
    return new Set(
        [...exampleText.matchAll(/^#?[ \t]*([A-Z_][A-Z0-9_]*)=/gm)].map((match) => match[1]!),
    );
}

/**
 * Does KEY belong in `.env`? Compose's variables are read from Compose itself;
 * `.env.example` and `.env` also place the ones an override no longer uses.
 */
export async function operatorKeyTest(io: Io, dir: string): Promise<(key: string) => boolean> {
    const interpolated = await composeVariables(io, dir);
    if (interpolated === null) {
        throw new CliError(
            "Compose could not list the variables the site's Compose files use, so it is not known which\n" +
                '  keys belong in .env. Check compose.yml with: docker compose config',
        );
    }
    const known = new Set([
        ...interpolated,
        ...documentedVariables(readIfExists(join(dir, ENV_EXAMPLE_FILE)) ?? ''),
        ...env.keys(readIfExists(join(dir, ENV_FILE)) ?? ''),
    ]);
    return (key) => key.startsWith('COMPOSE_') || known.has(key);
}

/** Findings as report lines: errors as errors, the rest as warnings. */
export const findingChecks = (findings: readonly Finding[]): Check[] =>
    findings.map((finding) => ({
        status: finding.level === 'error' ? 'error' : 'warn',
        label: finding.file,
        detail: finding.message,
    }));

/** The errors among `findings`, one indented line each; empty when there are none. */
export const findingErrors = (findings: readonly Finding[]): string =>
    findings
        .filter((finding) => finding.level === 'error')
        .map((finding) => `  ${finding.file}: ${finding.message}`)
        .join('\n');

export async function validate(io: Io, dir: string, resolved?: ConfigResult): Promise<Finding[]> {
    return [...(await validateEnv(io, dir)), ...(await validateGhostEnv(io, dir, resolved))];
}

/**
 * After an update has written what the site runs: Compose must resolve the
 * project, which validate() alone only warns about, and the configuration must
 * validate, both with `target`, what was written ("Ghost 6.4.0", "this release").
 */
export async function requireValid(io: Io, dir: string, target: string): Promise<void> {
    const resolved = await io.busy('Resolving the Compose project', () => composeConfig(io, dir));
    if (!resolved.ok) {
        throw new CliError(`Compose cannot resolve the project with ${target}: ${resolved.reason}`);
    }
    const findings = await io.busy('Validating the configuration', () =>
        validate(io, dir, resolved),
    );
    const errors = findingErrors(findings);
    if (errors) {
        throw new CliError(`the configuration does not validate with ${target}:\n${errors}`);
    }
    ok(io, 'configuration', `valid with ${target}`);
}
