// Compose has no API: it is a program that talks to the daemon itself. The
// manager runs the client that is in this image, under one contract:
//
//   docker compose --project-directory DIR -f DIR/compose.yml ...
//
// `--project-directory`, never `-C`, and an explicit `-f`. COMPOSE_FILE is not
// inherited, because it changes override auto-loading; nor are the other
// COMPOSE_* settings, which belong to the site's own `.env`, nor anything else
// of the manager's own environment, which Compose would interpolate over
// `.env`. The site's compose.override.yml is used when it exists, as plain
// `docker compose` uses it, and other overrides are opted into with
// GD_COMPOSE_OVERRIDES (docs/configuration.md).
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { Io } from './io.ts';
import type { Exec } from './process.ts';
import { COMPOSE_FILE, COMPOSE_OVERRIDE_FILE } from './site.ts';

/** The version of the Compose client in this image. */
export async function composeVersion(exec: Exec): Promise<string | null> {
    const result = await exec({ timeout: 20_000 })`docker-compose version --short`;
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
    readonly timeoutMs?: number;
    /** Set for this run only, over the site's `.env`; for example COMPOSE_PROFILES. */
    readonly env?: Readonly<Record<string, string>>;
    /** Standard input, for `exec -T`; none when absent. */
    readonly input?: string | Readable;
}

/**
 * The `-f` list: compose.yml, the site's compose.override.yml when there is
 * one, then each override GD_COMPOSE_OVERRIDES names, relative to the site.
 */
export function composeFiles(dir: string, overrides = ''): string[] {
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
    return files.flatMap((file) => ['-f', file]);
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

export async function compose(
    io: Io,
    dir: string,
    args: readonly string[],
    { timeoutMs = 120_000, env, input }: ComposeOptions = {},
): Promise<ComposeResult> {
    const command = io.exec({
        timeout: timeoutMs,
        env: composeEnvironment(io, env),
        extendEnv: false,
    });
    const result = await (input === undefined
        ? command
        : command({
              stdin: 'pipe',
              input,
          }))`docker-compose --project-directory ${dir} ${composeFiles(dir, io.env.GD_COMPOSE_OVERRIDES)} ${args}`;
    return {
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? result.shortMessage ?? ''),
        timedOut: Boolean(result.timedOut),
    };
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

const resolvedService = z.looseObject({
    environment: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
});

const resolvedProject = z.looseObject({
    services: z.record(z.string(), resolvedService).default({}),
});

export type ResolvedProject = z.infer<typeof resolvedProject>;

export type ConfigResult = { ok: true; project: ResolvedProject } | { ok: false; reason: string };

/**
 * The project as Compose resolves it. Pure parsing, so it needs no daemon and
 * works before anything has started. `$` in values comes back as `$$`, which
 * is undone here so values compare with decoded ones.
 */
export async function composeConfig(io: Io, dir: string): Promise<ConfigResult> {
    const result = await compose(io, dir, ['config', '--format', 'json'], { timeoutMs: 60_000 });
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

// --- `docker compose ps` ------------------------------------------------------

const publisher = z.looseObject({
    URL: z.string().default(''),
    TargetPort: z.number().default(0),
    PublishedPort: z.number().default(0),
    Protocol: z.string().default('tcp'),
});

const psEntry = z.looseObject({
    Service: z.string().default(''),
    State: z.string().default(''),
    Health: z.string().default(''),
    ExitCode: z.number().default(0),
    Publishers: z.array(publisher).nullable().default([]),
});

export type ServiceState = z.infer<typeof psEntry>;

/**
 * Every container of the project, stopped ones included, one JSON object per
 * line (Compose 2.21 and later; the minimum is 2.24).
 */
export async function composePs(io: Io, dir: string): Promise<ServiceState[] | null> {
    const result = await compose(io, dir, ['ps', '--all', '--format', 'json'], {
        timeoutMs: 60_000,
    });
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
