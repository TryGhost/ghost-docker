// Compose has no API: it is a program that talks to the daemon itself. The
// manager runs the client that is in this image, as a template tag:
//
//   await compose(io, { dir, profiles })`up --detach --wait db`
//
// which runs `docker-compose --project-directory DIR -f DIR/compose.yml ...`.
//
// `--project-directory`, never `-C`, and an explicit `-f`. COMPOSE_FILE is not
// inherited, because it changes override auto-loading; nor are the other
// COMPOSE_* settings, which belong to the site's own `.env`, nor anything else
// of the manager's own environment, which Compose would interpolate over
// `.env`. The site's compose.override.yml is used when it exists, as plain
// `docker compose` uses it, and other overrides are opted into with
// GD_COMPOSE_OVERRIDES (docs/configuration.md).
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { TemplateExpression } from 'execa';
import { z } from 'zod';
import { CliError } from './errors.ts';
import type { Io } from './io.ts';
import { COMPOSE_FILE, COMPOSE_OVERRIDE_FILE } from './site.ts';

/** The version of the Compose client in this image. */
export async function composeVersion(io: Io): Promise<string | null> {
    const result = await compose(io, { timeout: 20_000 })`version --short`;
    const version = result.stdout.trim();
    return result.exitCode === 0 && version ? version : null;
}

export interface ComposeResult {
    /** Null when Compose could not be run at all, or was killed at the deadline. */
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
}

export interface ComposeOptions {
    /** The site: adds --project-directory and its -f files. Left out, the command is not about one site. */
    readonly dir?: string;
    /** COMPOSE_PROFILES for this run, over the site's `.env`; ALL_PROFILES is every one. */
    readonly profiles?: string;
    /** How long Compose may run before it is killed: two minutes unless set. */
    readonly timeout?: number;
    /** Standard input, for `exec -T`; none when absent. */
    readonly input?: string | Readable;
    /** A file standard output is written to, rather than read into `stdout`. */
    readonly output?: string;
}

/** The fields of execa's result that a ComposeResult is made from. */
interface Ran {
    readonly exitCode?: number;
    readonly stdout?: unknown;
    readonly stderr?: unknown;
    readonly shortMessage?: string;
    readonly timedOut?: boolean;
}

/** Runs `docker-compose` with the template as its arguments. */
export type Compose = (
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
) => Promise<ComposeResult>;

/**
 * The `-f` list: compose.yml, the site's compose.override.yml when there is
 * one, then each override GD_COMPOSE_OVERRIDES names, relative to the site.
 */
export function composeFiles(dir: string, overrides = ''): string[] {
    return composeFileList(dir, overrides).flatMap((file) => ['-f', file]);
}

/** The Compose files a site runs with, in the order Compose merges them. */
export function composeFileList(dir: string, overrides = ''): string[] {
    const files = [join(dir, COMPOSE_FILE)];
    if (existsSync(join(dir, COMPOSE_OVERRIDE_FILE))) {
        files.push(join(dir, COMPOSE_OVERRIDE_FILE));
    }
    for (const override of overrides.split(',').map((item) => item.trim())) {
        const file = isAbsolute(override) ? override : join(dir, override);
        if (override && !files.includes(file)) {
            files.push(file);
        }
    }
    return files;
}

/**
 * What Compose needs of our environment to find itself and the daemon.
 * Nothing else is passed on: Compose interpolates the shell's variables in
 * preference to `.env`, so the manager's own (the image sets
 * NODE_ENV=production) would silently override the site's settings.
 */
const PASSED_THROUGH = [
    'PATH',
    'HOME',
    'TMPDIR',
    'DOCKER_HOST',
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
];

/** The environment Compose runs in: only what it needs, and `extra`. */
export function composeEnvironment(
    io: Pick<Io, 'env'>,
    extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of PASSED_THROUGH) {
        const value = io.env[key];
        if (value !== undefined) {
            environment[key] = value;
        }
    }
    return { ...environment, ...extra };
}

/** `docker-compose ${project} ` in front of a caller's own template. */
const prefixed = (parts: readonly string[]): string[] => [
    'docker-compose ',
    ` ${parts[0]}`,
    ...parts.slice(1),
];

/**
 * Compose as a template tag, as execa is one: interpolated values are whole
 * arguments, never re-split, and an array is several.
 */
export function compose(
    io: Io,
    { dir, profiles, timeout = 120_000, input, output }: ComposeOptions = {},
): Compose {
    const run = io.exec({
        timeout,
        env: composeEnvironment(io, profiles === undefined ? {} : { COMPOSE_PROFILES: profiles }),
        extendEnv: false,
        ...(input === undefined ? {} : { stdin: 'pipe', input }),
        ...(output === undefined ? {} : { stdout: { file: output } }),
    });
    const project =
        dir === undefined
            ? []
            : ['--project-directory', dir, ...composeFiles(dir, io.env.GD_COMPOSE_OVERRIDES)];
    return async (strings, ...values) => {
        const template = Object.assign(prefixed(strings), { raw: prefixed(strings.raw) });
        // Typed loosely: execa infers nothing useful from options built at runtime.
        const result: Ran = await run(
            template as unknown as TemplateStringsArray,
            project,
            ...(values as TemplateExpression[]),
        );
        return {
            exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
            stdout: String(result.stdout ?? ''),
            stderr: String(result.stderr ?? result.shortMessage ?? ''),
            timedOut: Boolean(result.timedOut),
        };
    };
}

/**
 * Every profile, as Compose itself spells it, so whatever a site started is
 * found, including profiles added later.
 */
export const ALL_PROFILES = '*';

/** How long stopping a site's services may take. */
const STOP_MS = 300_000;

/** `down` of a site's services, with the profiles given; its volumes only when asked. */
export const composeDown = (
    io: Io,
    dir: string,
    { volumes = false, profiles }: { volumes?: boolean; profiles?: string } = {},
): Promise<ComposeResult> =>
    compose(io, {
        dir,
        profiles,
        timeout: STOP_MS,
    })`down ${volumes ? ['--volumes'] : []} --remove-orphans --timeout 20`;

/** `stop` of a site's services, with the profiles given. */
export const composeStop = (io: Io, dir: string, profiles?: string): Promise<ComposeResult> =>
    compose(io, { dir, profiles, timeout: STOP_MS })`stop --timeout 20`;

/** How long `up --wait` gives the services to become healthy. */
export const READY_SECONDS = 600;

/**
 * `up --detach --wait` for `services`, or every service the profiles select,
 * with time beyond the wait to pull their images.
 */
export const composeUp = (
    io: Io,
    dir: string,
    services: readonly string[] = [],
    profiles?: string,
): Promise<ComposeResult> =>
    compose(io, {
        dir,
        profiles,
        timeout: (READY_SECONDS + 900) * 1000,
    })`up --detach --wait --wait-timeout ${READY_SECONDS} ${services}`;

/**
 * Every service up and healthy, behind a spinner, or an error in Compose's
 * own words, then `hint`. Docker names a port it could not bind; its wording
 * changes between versions, so it is quoted, not parsed.
 */
export async function upAndWait(io: Io, dir: string, spinner: string, hint = ''): Promise<void> {
    const up = await io.busy(spinner, () => composeUp(io, dir));
    if (up.exitCode !== 0) {
        const said = composeError(up, 8)
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n');
        throw new CliError(
            `${up.timedOut ? 'the services did not finish starting before the deadline' : 'the services did not start and become healthy'}. Compose said:\n${said}${hint ? `\n${hint}` : ''}`,
        );
    }
}

/** Compose's own last words: the final non-empty lines of its stderr. */
export const composeError = (result: ComposeResult, lines = 6): string =>
    result.timedOut
        ? 'docker compose did not finish before its deadline'
        : result.stderr
              .split('\n')
              .map((line) => line.trimEnd())
              .filter((line) => line !== '')
              .slice(-lines)
              .join('\n');

// --- `docker compose config` --------------------------------------------------

const resolvedMount = z.looseObject({
    type: z.string(),
    source: z.string().default(''),
    target: z.string(),
});

const resolvedService = z.looseObject({
    image: z.string().optional(),
    restart: z.string().optional(),
    environment: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
    volumes: z.array(resolvedMount).default([]),
    networks: z.record(z.string(), z.unknown()).default({}),
    labels: z.record(z.string(), z.string()).default({}),
});

const resolvedProject = z.looseObject({
    name: z.string().default(''),
    services: z.record(z.string(), resolvedService).default({}),
    networks: z
        .record(z.string(), z.looseObject({ name: z.string().optional() }).nullable())
        .default({}),
});

export type ResolvedProject = z.infer<typeof resolvedProject>;

export type ConfigResult = { ok: true; project: ResolvedProject } | { ok: false; reason: string };

/**
 * The project as Compose resolves it. Pure parsing, so it needs no daemon and
 * works before anything has started. `$` in values comes back as `$$`, which
 * is undone here so values compare with decoded ones.
 */
export async function composeConfig(io: Io, dir: string): Promise<ConfigResult> {
    const result = await compose(io, { dir })`config --format json`;
    if (result.exitCode !== 0) {
        return { ok: false, reason: composeError(result) || 'docker compose config failed' };
    }
    try {
        const project = resolvedProject.parse(JSON.parse(result.stdout));
        for (const service of Object.values(project.services)) {
            for (const [key, value] of Object.entries(service.environment ?? {})) {
                service.environment![key] = value === null ? '' : value.replaceAll('$$', '$');
            }
        }
        return { ok: true, project };
    } catch {
        return {
            ok: false,
            reason: 'docker compose config printed something that is not its JSON',
        };
    }
}

// --- `docker compose ls` -------------------------------------------------------

const lsEntry = z.looseObject({
    Name: z.string(),
    Status: z.string().default(''),
    ConfigFiles: z.string().default(''),
});

export interface ComposeProject {
    readonly name: string;
    /** As Compose summarises it: `running(3)`, `exited(2)`. */
    readonly status: string;
    /** Where its first Compose file is: a site's directory. */
    readonly dir: string;
}

/** Every Compose project on the daemon, stopped ones included; null when Compose failed. */
export async function composeProjects(io: Io): Promise<ComposeProject[] | null> {
    const result = await compose(io)`ls --all --format json`;
    if (result.exitCode !== 0) {
        return null;
    }
    try {
        return z
            .array(lsEntry)
            .parse(JSON.parse(result.stdout))
            .map((project) => ({
                name: project.Name,
                status: project.Status,
                dir: dirname(project.ConfigFiles.split(',')[0] ?? ''),
            }));
    } catch {
        return null;
    }
}

// --- `docker compose config --variables` ------------------------------------

const variables = z.record(z.string(), z.unknown());

/**
 * The variables the project interpolates, as Compose reads them: compose.yml
 * and every override in use, merged, so one an override removes the only use
 * of is not among them. `$$` is a literal and is not among them either.
 */
export async function composeVariables(io: Io, dir: string): Promise<Set<string> | null> {
    const result = await compose(io, { dir })`config --variables --format json`;
    if (result.exitCode !== 0) {
        return null;
    }
    try {
        return new Set(Object.keys(variables.parse(JSON.parse(result.stdout))));
    } catch {
        return null;
    }
}

// --- `docker compose ps` ------------------------------------------------------

const publisher = z.looseObject({
    URL: z.string().default(''),
    TargetPort: z.number().default(0),
    PublishedPort: z.number().default(0),
    Protocol: z.string().default('tcp'),
});

const psEntry = z.looseObject({
    /** The container's ID, which the Engine API is asked about. */
    ID: z.string().default(''),
    Service: z.string().default(''),
    State: z.string().default(''),
    Health: z.string().default(''),
    ExitCode: z.number().default(0),
    Publishers: z.array(publisher).nullable().default([]),
});

export type ServiceState = z.infer<typeof psEntry>;

/**
 * Every container of the project, stopped ones included, one JSON object per
 * line (Compose 2.21 and later; the minimum is 2.24). Compose lists only the
 * services its profiles enable, so a site whose `.env` does not select them
 * yet, such as one being imported, passes them in `profiles`.
 */
export async function composePs(
    io: Io,
    dir: string,
    profiles?: string,
): Promise<ServiceState[] | null> {
    const result = await compose(io, { dir, profiles })`ps --all --format json`;
    if (result.exitCode !== 0) {
        return null;
    }
    const text = result.stdout.trim();
    if (text === '') {
        return [];
    }
    try {
        return text.split('\n').map((line) => psEntry.parse(JSON.parse(line)));
    } catch {
        return null;
    }
}
