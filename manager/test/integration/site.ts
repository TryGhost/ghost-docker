// Real sites for the integration tests: the repository's compose.yml and
// stack files, a `.env` through the real encoder, and an override that
// publishes no host port. Started and taken down with the image's Compose.
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose, composeError, composePs, type ServiceState } from '../../src/compose.ts';
import { inspectContainer } from '../../src/docker/client.ts';
import * as env from '../../src/env.ts';
import { processIo, type Io } from '../../src/io.ts';
import { onSiteNetwork } from '../../src/network.ts';
import { readSettings, siteFacts, type SiteFacts } from '../../src/site.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Shared with run.sh, which mounts it at its own path and cleans up after it. */
const WORK = process.env.GD_INTEGRATION_DIR;
const RUN = process.env.GD_INTEGRATION_RUN ?? randomBytes(4).toString('hex');
if (!WORK) {
    throw new Error(
        'run these through manager/test/integration/run.sh, which sets GD_INTEGRATION_DIR',
    );
}

/** Names of this run: gd-it-RUN-name, which run.sh removes if a test could not. */
export const named = (name: string): string => `gd-it-${RUN}-${name}`;

/**
 * The manager's own Io, quiet, with `overrides`; its site network is joined
 * through this Io, so an override reaches the join too.
 */
export function realIo(overrides: Partial<Io> = {}): Io {
    const io: Io = {
        ...processIo,
        stdout: () => undefined,
        stderr: () => undefined,
        ...overrides,
    };
    io.siteNetwork = (services, wanted, work) => onSiteNetwork(io, services, wanted, work);
    return io;
}

/** Every service the tests start publishes nothing on the host. */
export const NO_HOST_PORTS = `services:
  ghost:
    ports: !reset []
  caddy:
    ports: !reset []
  mailpit:
    ports: !reset []
`;

export interface TestSite {
    readonly dir: string;
    readonly project: string;
    /** What Compose says now. */
    services: () => Promise<ServiceState[]>;
    facts: () => SiteFacts;
    /** Starts these services, without what they depend on, and waits for them. */
    up: (...services: string[]) => Promise<void>;
    /** `compose down`, which removes the site's network; its result is the test's. */
    down: () => Promise<{ ok: boolean; error: string }>;
}

export interface SiteOptions {
    readonly profiles: string;
    readonly url?: string;
    readonly adminUrl?: string;
    /** compose.override.yml; NO_HOST_PORTS when absent. */
    readonly override?: string;
    /** caddy/sites/site.caddy. */
    readonly caddy?: string;
}

export function makeSite(io: Io, name: string, options: SiteOptions): TestSite {
    const dir = join(WORK!, name);
    const project = named(name);
    mkdirSync(dir, { recursive: true });
    cpSync(join(REPO, 'compose.yml'), join(dir, 'compose.yml'));
    for (const directory of ['caddy', 'mysql-init']) {
        cpSync(join(REPO, directory), join(dir, directory), { recursive: true });
    }
    const secret = () => randomBytes(12).toString('hex');
    writeFileSync(
        join(dir, '.env'),
        env.serializeAll([
            ['COMPOSE_PROJECT_NAME', project],
            ['COMPOSE_PROFILES', options.profiles],
            ['SITE_MODE', options.profiles.includes('production') ? 'production' : 'local'],
            ['URL', options.url ?? 'http://localhost:2368'],
            ['ADMIN_URL', options.adminUrl ?? ''],
            ['DATABASE_PASSWORD', secret()],
            ['DATABASE_ROOT_PASSWORD', secret()],
        ]),
        { mode: 0o600 },
    );
    writeFileSync(join(dir, 'compose.override.yml'), options.override ?? NO_HOST_PORTS);
    if (options.caddy !== undefined) {
        writeFileSync(join(dir, 'caddy', 'sites', 'site.caddy'), options.caddy);
    }

    return {
        dir,
        project,
        services: async () => {
            const services = await composePs(io, dir);
            if (services === null) {
                throw new Error(`docker compose ps failed for ${project}`);
            }
            return services;
        },
        facts: () => siteFacts(dir, readSettings(dir)!),
        up: async (...services) => {
            const result = await compose(
                io,
                dir,
                ['up', '--detach', '--wait', '--wait-timeout', '300', '--no-deps', ...services],
                { timeoutMs: 1_200_000 },
            );
            if (result.exitCode !== 0) {
                throw new Error(`${project} did not start: ${composeError(result)}`);
            }
        },
        down: async () => {
            const result = await compose(
                io,
                dir,
                ['down', '--volumes', '--remove-orphans', '--timeout', '5'],
                { timeoutMs: 300_000 },
            );
            return { ok: result.exitCode === 0, error: composeError(result) };
        },
    };
}

/** The networks the manager's own container is on now. */
export async function managerNetworks(io: Io): Promise<string[]> {
    const self = await inspectContainer(io.docker, io.containerId()!);
    if (self === null) {
        throw new Error(`the daemon has no container ${io.containerId()}`);
    }
    return self.endpoints.map((endpoint) => endpoint.network).sort();
}

/** The ID of the running container of `service`, as Compose lists it. */
export async function containerOf(site: TestSite, service: string): Promise<string> {
    const state = (await site.services()).find(
        (entry) => entry.Service === service && entry.State === 'running',
    );
    if (!state) {
        throw new Error(`${site.project} has no running ${service}`);
    }
    return state.ID;
}
