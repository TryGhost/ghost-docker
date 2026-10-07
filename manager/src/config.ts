// Validating the configuration split (docs/configuration.md).
//
//   .env        Compose and operator settings, including infrastructure
//               credentials. Read by Compose for interpolation; never passed
//               into the Ghost container.
//   ghost.env   Ghost application settings only; the ghost service's only
//               env_file.
//
// Only what nothing else catches is checked. A missing URL or
// DATABASE_PASSWORD is left to compose.yml's own `:?` guards, which report it
// at the point of use. Requirements are by mode rather than `:?` guards on
// optional-service variables, because Compose interpolates inactive services
// too.
//
// Two lists are derived rather than written down, so they cannot drift: the
// keys the container owns (what `docker compose config` says Ghost receives)
// and the operator settings (what compose.yml interpolates).
import { join } from 'node:path';
import { composeConfig } from './compose.ts';
import { inspectImage } from './docker/client.ts';
import * as env from './env.ts';
import { modeOf, readIfExists } from './fs.ts';
import type { Io } from './io.ts';
import {
    COMPOSE_FILE,
    ENV_EXAMPLE_FILE,
    ENV_FILE,
    GHOST_ENV_FILE,
    hostOf,
    OPTIONAL_PROFILES,
    SITE_MODES,
    siteMode,
    unknownProfiles,
} from './site.ts';

export interface Finding {
    readonly level: 'error' | 'warning';
    readonly file: string;
    readonly message: string;
}

/** Keys required in `.env` that nothing else would catch, by mode. */
export const REQUIRED_KEYS = {
    common: [
        'COMPOSE_PROFILES',
        'COMPOSE_PROJECT_NAME',
        'SITE_MODE',
        'PROJECT_DIR',
        'GHOST_VERSION',
    ],
    production: ['URL'],
} as const;

/** Modes that hold credentials and are still private. */
const PRIVATE_MODES = new Set([0o600, 0o400, 0o640]);

const error = (file: string, message: string): Finding => ({ level: 'error', file, message });
const warning = (file: string, message: string): Finding => ({ level: 'warning', file, message });

/** The variables compose.yml interpolates, from compose.yml itself. */
export function operatorVariables(composeText: string): Set<string> {
    return new Set(
        [...composeText.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!),
    );
}

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
    const declared = values.SITE_MODE;
    if (mode !== null && declared && declared !== mode) {
        findings.push(
            error(
                file,
                `SITE_MODE=${declared} does not match the site mode in COMPOSE_PROFILES (${mode})`,
            ),
        );
    }

    const required = [
        ...REQUIRED_KEYS.common,
        ...(mode === 'production' ? REQUIRED_KEYS.production : []),
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

    findings.push(...interpolated(file, text), ...privacy(file, path));
    return findings;
}

/**
 * `ghost.env` holds Ghost application settings only. Two mistakes matter, and
 * both are detected rather than listed:
 *
 *  - a key the container owns. Compose `environment` overrides `env_file`, so
 *    setting it here looks effective and is silently ignored. Detected by
 *    asking Compose what the container actually receives.
 *  - an operator setting in the wrong file. Detected from the variables
 *    compose.yml interpolates, the settings .env.example documents,
 *    COMPOSE_*, and whatever `.env` defines.
 */
export async function validateGhostEnv(io: Io, dir: string): Promise<Finding[]> {
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

    const resolved = await composeConfig(io, dir);
    const container = resolved.ok ? resolved.project.services.ghost?.environment : undefined;
    if (container === undefined) {
        findings.push(
            warning(
                file,
                `the Compose configuration could not be resolved, so container-owned keys were not checked${resolved.ok ? '' : `: ${resolved.reason.split('\n').at(-1)}`}`,
            ),
        );
    }
    const isOperatorKey = operatorKeyTest(dir);

    for (const [key, value] of Object.entries(values)) {
        // env_file is merged into the service environment, so every ghost.env
        // key appears there. A different value means an explicit
        // `environment` entry took precedence.
        const effective = container?.[key];
        if (effective !== undefined && effective !== value) {
            findings.push(
                error(
                    file,
                    `${key} is set by the container (${effective || '<empty>'}) and is ignored in ${file}`,
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

/** Does KEY belong in `.env`? */
export function operatorKeyTest(dir: string): (key: string) => boolean {
    const known = new Set([
        ...operatorVariables(readIfExists(join(dir, COMPOSE_FILE)) ?? ''),
        ...documentedVariables(readIfExists(join(dir, ENV_EXAMPLE_FILE)) ?? ''),
        ...env.keys(readIfExists(join(dir, ENV_FILE)) ?? ''),
    ]);
    return (key) => key.startsWith('COMPOSE_') || known.has(key);
}

export async function validate(io: Io, dir: string): Promise<Finding[]> {
    return [...(await validateEnv(io, dir)), ...(await validateGhostEnv(io, dir))];
}
