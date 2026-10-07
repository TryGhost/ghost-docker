// A site directory for tests: the repository's own compose.yml and examples,
// a `.env` written through the real encoder, and a scripted
// `docker compose config` that answers what Compose would.
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as env from '../src/env.ts';
import { failed, ok, type Harness } from './helpers.ts';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The keys compose.yml sets for Ghost itself, which override ghost.env. */
const containerOwned = (values: Record<string, string>): Record<string, string> => ({
    NODE_ENV: values.NODE_ENV ?? 'production',
    url: values.URL ?? '',
    admin__url: values.ADMIN_URL ?? '',
    server__host: '0.0.0.0',
    server__port: '2368',
    paths__contentPath: values.GHOST_CONTENT_PATH ?? '/home/ghost/content',
    database__client: 'mysql',
    database__connection__password: values.DATABASE_PASSWORD ?? '',
});

export const LOCAL: Record<string, string> = {
    COMPOSE_PROFILES: 'local',
    SITE_MODE: 'local',
    COMPOSE_PROJECT_NAME: 'ghost-local-site',
    PROJECT_DIR: '',
    NODE_ENV: 'development',
    URL: 'http://localhost:2368',
    GHOST_VERSION: '6-next-alpine',
    GHOST_PORT: '2368',
    DATABASE_PASSWORD: 'app-password',
    DATABASE_ROOT_PASSWORD: 'root-password',
};

export const PRODUCTION: Record<string, string> = {
    ...LOCAL,
    COMPOSE_PROFILES: 'production',
    SITE_MODE: 'production',
    COMPOSE_PROJECT_NAME: 'ghost-example-com',
    NODE_ENV: 'production',
    URL: 'https://example.com',
};

export function writeEnvFile(path: string, values: Record<string, string | undefined>): void {
    const entries = Object.entries(values).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
    );
    writeFileSync(path, env.serializeAll(entries), { mode: 0o600 });
}

/**
 * Make `h.dir` a site: the stack's files, `.env` from `values`, an optional
 * `ghost.env`, and Compose answering `config` from them.
 */
export function makeSite(
    h: Harness,
    values: Record<string, string | undefined>,
    ghostEnv?: Record<string, string>,
): void {
    for (const file of ['compose.yml', '.env.example', 'ghost.env.example']) {
        copyFileSync(join(REPO, file), join(h.dir, file));
    }
    mkdirSync(join(h.dir, 'caddy'), { recursive: true });
    cpSync(join(REPO, 'caddy'), join(h.dir, 'caddy'), { recursive: true });
    writeEnvFile(join(h.dir, '.env'), { ...values, PROJECT_DIR: values.PROJECT_DIR || h.dir });
    if (ghostEnv) {
        writeEnvFile(join(h.dir, 'ghost.env'), ghostEnv);
    }
    const resolve = h.daemon.composeRun;
    h.daemon.composeRun = (args, environment) => {
        if (args[0] === 'config' && args.includes('json')) {
            const settings = { ...values };
            for (const key of ['URL', 'DATABASE_PASSWORD'] as const) {
                if (!settings[key]) {
                    return failed(1, `required variable ${key} is missing a value`);
                }
            }
            const environment = {
                ...ghostEnv,
                ...containerOwned(settings as Record<string, string>),
            };
            // Compose re-escapes `$` in what it prints.
            const printed = Object.fromEntries(
                Object.entries(environment).map(([key, value]) => [
                    key,
                    value.replaceAll('$', () => '$$'),
                ]),
            );
            return ok(
                JSON.stringify({
                    name: settings.COMPOSE_PROJECT_NAME,
                    services: { ghost: { environment: printed } },
                }),
            );
        }
        return resolve?.(args, environment);
    };
}
