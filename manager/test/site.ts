// A site directory for tests: the repository's own compose.yml and examples,
// a `.env` written through the real encoder, and a scripted
// `docker compose config` that answers what Compose would.
import {
    copyFileSync,
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DockerRequest, DockerResponse } from '../src/docker/transport.ts';
import * as env from '../src/env.ts';
import { readSettings } from '../src/site.ts';
import {
    failed,
    json,
    ok,
    type CreatedContainer,
    type Harness,
    type ProgramResult,
} from './helpers.ts';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A bundle manifest, loosely typed so tests can break it. */
export type Manifest = Record<string, any>;

/** One of the exporter's manifest fixtures, fresh each time. */
export const fixture = (kind: string): Manifest =>
    JSON.parse(
        readFileSync(
            join(REPO, 'tests', 'fixtures', 'migration-bundle-v1', `${kind}.json`),
            'utf8',
        ),
    );

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

// --- An image-mode site ---------------------------------------------------------

/** The Ghost image every fake pull resolves to. */
export const INDEX = `sha256:${'1'.repeat(64)}`;
export const REFERENCE = `ghost@${INDEX}`;

/**
 * The stack's files as the manager image carries them, in a directory of
 * their own that the harness removes, with GD_* pointing at them as the
 * image's environment does.
 */
export function imageStack(h: Harness): string {
    const stack = realpathSync(mkdtempSync(join(tmpdir(), 'gd-stack-')));
    for (const file of ['compose.yml', 'compose.ipv6.yml', '.env.example', 'ghost.env.example']) {
        copyFileSync(join(REPO, file), join(stack, file));
    }
    for (const directory of ['caddy', 'mysql-init']) {
        cpSync(join(REPO, directory), join(stack, directory), { recursive: true });
    }
    h.env.GD_STACK_DIR = stack;
    h.env.GD_LAUNCHER_SOURCE = join(REPO, 'ghost-docker');
    h.env.GD_SOURCE = 'image';
    const cleanup = h.cleanup;
    h.cleanup = () => {
        rmSync(stack, { recursive: true, force: true });
        cleanup();
    };
    return stack;
}

export interface ImageApi {
    /** Ghost's tags the registry has, and the version each is; `6-next-alpine` is 6.67.0. */
    readonly ghost?: Readonly<Record<string, string>>;
    /** The manager image's ID; it has no repository digest. */
    readonly manager?: () => string;
    /** Each tag pulled, in order. */
    readonly pulls?: string[];
}

/** The daemon's answers about the images an image-mode command reads. */
export const imageApi =
    ({ ghost = { '6-next-alpine': '6.67.0' }, manager, pulls }: ImageApi = {}) =>
    ({ method, path, query }: DockerRequest): DockerResponse | undefined => {
        if (method === 'POST' && path === '/images/create') {
            const tag = query?.tag ?? '';
            pulls?.push(tag);
            return query?.fromImage !== 'ghost' || tag in ghost
                ? { status: 200, body: Buffer.from('{"status":"Pulled"}\n') }
                : json(404, { message: `manifest for ghost:${tag} not found` });
        }
        const tag = /^\/images\/ghost:(.+)\/json$/.exec(path)?.[1];
        if (method === 'GET' && tag !== undefined && tag in ghost) {
            return json(200, {
                Id: INDEX,
                RepoDigests: [REFERENCE],
                Config: {
                    Env: [
                        `GHOST_VERSION=${ghost[tag]}`,
                        'GHOST_CONTENT=/home/ghost/content',
                        'GHOST_INSTALL=/home/ghost',
                    ],
                },
            });
        }
        if (method === 'GET' && path === '/images/ghost-docker:checkout/json') {
            return json(200, {
                Id: manager?.() ?? `sha256:${'2'.repeat(64)}`,
                RepoDigests: [],
                Config: { Env: [] },
            });
        }
        return undefined;
    };

/** A one-shot root container doing to the site what it would on a real host: `mv` and `rm`. */
export function rootContainer(spec: CreatedContainer): { status: number } | undefined {
    const site = spec.binds.find((bind) => bind.endsWith(':/site'))?.split(':')[0];
    const onHost = (path: string) => join(site!, path.replace(/^\/site\/?/, ''));
    if (spec.entrypoint[0] === 'mv') {
        const target = onHost(spec.cmd.at(-1)!);
        for (const source of spec.cmd.slice(0, -1)) {
            renameSync(onHost(source), join(target, source.split('/').pop()!));
        }
        return { status: 0 };
    }
    if (spec.entrypoint[0] === 'rm') {
        for (const path of spec.cmd) {
            rmSync(onHost(path), { recursive: true, force: true });
        }
        return { status: 0 };
    }
    return undefined;
}

/**
 * `docker compose config --format json` of a site, as Compose resolves it:
 * the project's name, and each service in `images` with its image, the data
 * mounts `.env` places, and the project's network.
 */
export function resolvedProject(
    dir: string,
    images: Record<string, string>,
    mounts: Record<string, { type: string; source: string; target: string }[]> = {},
): string {
    const settings = readSettings(dir);
    const get = (key: string, fallback: string) => settings?.get(key) || fallback;
    const at = (path: string) => (isAbsolute(path) ? path : join(dir, path));
    const project = get('COMPOSE_PROJECT_NAME', basename(dir));
    const data: Record<string, { type: string; source: string; target: string }[]> = {
        ghost: [
            {
                type: 'bind',
                source: at(get('UPLOAD_LOCATION', './data/ghost')),
                target: get('GHOST_CONTENT_PATH', '/home/ghost/content'),
            },
        ],
        db: [
            {
                type: 'bind',
                source: at(get('MYSQL_DATA_LOCATION', './data/mysql')),
                target: '/var/lib/mysql',
            },
            {
                type: 'bind',
                source: join(dir, 'mysql-init'),
                target: '/docker-entrypoint-initdb.d',
            },
        ],
    };
    return JSON.stringify({
        name: project,
        services: Object.fromEntries(
            Object.entries(images).map(([service, image]) => [
                service,
                {
                    image,
                    environment: {},
                    volumes: [...(data[service] ?? []), ...(mounts[service] ?? [])],
                    networks: { ghost_network: null },
                },
            ]),
        ),
        networks: { ghost_network: { name: `${project}_ghost_network` } },
    });
}

// --- A running site, for backup and recovery ---------------------------------------

/** What a scripted site's Compose, MySQL and one-shot containers do, and their state. */
export interface ScriptedSite {
    /** Every `docker-compose` run, by its arguments after the project options. */
    readonly compose: string[][];
    /** What each `up` answers, in order; then success. */
    ups: ProgramResult[];
    /** What each `down` answers, in order; then success. */
    downs: ProgramResult[];
    /** The services running: what `up` started, until `down` or `stop`; none at first. */
    readonly running: Set<string>;
    /** Ghost's database, table by table, as the site's MySQL holds it. */
    rows: Record<string, number>;
    /** Run as `up` starts every service: what a release's migrations do to `rows`. */
    onUp: () => void;
}

const SITE_DUMP =
    '-- MySQL dump\nCREATE TABLE `posts` (id int);\n-- Dump completed on 2026-10-09\n';

/** The site's content and MySQL's data directory, with a file in each. */
export function writeSiteData(dir: string): void {
    mkdirSync(join(dir, 'data', 'ghost', 'images'), { recursive: true });
    writeFileSync(join(dir, 'data', 'ghost', 'images', 'photo.jpg'), 'jpeg');
    mkdirSync(join(dir, 'data', 'mysql'), { recursive: true });
    writeFileSync(join(dir, 'data', 'mysql', 'ibdata1'), 'the database');
}

/**
 * A site with a database to dump and load. A dump records
 * `rows`; the scratch check and a load answer what it recorded. `config` is
 * what the test's own Compose answers, and is given the images Compose
 * resolves for a backup to record.
 */
export function scriptSite(
    h: Harness,
    config: (args: string[]) => ProgramResult | undefined,
    images: Record<string, string> = {
        ghost: REFERENCE,
        db: `mysql:8.0.44@sha256:${'4'.repeat(64)}`,
    },
): ScriptedSite {
    const site: ScriptedSite = {
        compose: [],
        ups: [],
        downs: [],
        running: new Set(),
        rows: { posts: 3, users: 1, migrations: 120 },
        onUp: () => {},
    };
    let dumped: Record<string, number> = {};

    h.daemon.run = (spec) =>
        spec.entrypoint[0] === 'sh'
            ? {
                  status: 0,
                  stdout: spec.cmd
                      .map(
                          (database) =>
                              `== ${database}\n${Object.entries(dumped)
                                  .map(([table, rows]) => `${table}\t${rows}`)
                                  .join('\n')}\n`,
                      )
                      .join(''),
              }
            : rootContainer(spec);
    h.daemon.sql = (sql) => {
        if (sql.includes('information_schema')) {
            return [[String(Object.keys(site.rows).length)]];
        }
        if (sql.includes('COUNT(*)')) {
            return Object.entries(site.rows).map(([table, rows]) => [table, String(rows)]);
        }
        return undefined;
    };
    h.daemon.composeRun = (args) => {
        site.compose.push(args);
        switch (args[0]) {
            case 'config': {
                const answer = config(args);
                if (answer === undefined || answer.exitCode !== 0) {
                    return answer;
                }
                const project = JSON.parse(String(answer.stdout));
                // The name, the data mounts and the network, as Compose resolves them.
                const resolved = JSON.parse(resolvedProject(h.dir, images));
                for (const [service, image] of Object.entries(images)) {
                    project.services[service] = {
                        ...resolved.services[service],
                        ...project.services[service],
                        image,
                    };
                }
                return ok(JSON.stringify({ ...resolved, ...project, services: project.services }));
            }
            case 'up': {
                // What `up --wait` starts stays running, healthy or not.
                const named = args.slice(args.indexOf('--wait-timeout') + 2);
                if (named.length === 0) {
                    site.onUp();
                }
                for (const service of named.length > 0 ? named : ['ghost', 'db']) {
                    site.running.add(service);
                }
                return site.ups.shift() ?? ok('');
            }
            case 'down': {
                const answer = site.downs.shift() ?? ok('');
                if (answer.exitCode === 0) {
                    site.running.clear();
                }
                return answer;
            }
            case 'stop':
                if (args.includes('db')) {
                    site.running.delete('db');
                } else {
                    site.running.clear();
                }
                return ok('');
            case 'ps':
                return ok(
                    [...site.running]
                        .map((service) =>
                            JSON.stringify({
                                Service: service,
                                State: 'running',
                                Health: 'healthy',
                            }),
                        )
                        .join('\n') + '\n',
                );
            case 'exec':
                if ((args[args.indexOf('-c') + 1] ?? '').includes('mysqldump')) {
                    dumped = { ...site.rows };
                    return ok(SITE_DUMP);
                }
                // Loading a dump, into the new, empty database.
                site.rows = { ...dumped };
                return ok('');
            default:
                return ok('');
        }
    };
    return site;
}
