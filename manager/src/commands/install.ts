// `install`: a local or production site, configured, started and verified.
//
// The order matters, and each part has one reason to be where it is:
//
//   1. Refusals that need nothing: options, an existing site, files the
//      payload would overwrite. Nothing has been changed.
//   2. Preflight (doctor's checks), ports Docker knows are taken, the exact
//      Ghost image. Still nothing has been changed.
//   3. Writing: payload and launcher (image mode), `.env`, `ghost.env`, data
//      directories, routes, metadata. From here a failure removes what this
//      installation created, so the same command can simply be run again.
//   4. Starting and verifying, unless --no-start.
//
// Installation never stops or reconfigures anything already running. A port
// held by a Docker container is refused before anything is written; one held
// by anything else is found when Compose starts the services, whose error
// names it.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { removeStaging } from '../bundle/stage.ts';
import { ACME_EMAIL, isHostname, SITE_FILE, writeRoutes } from '../caddy.ts';
import { compose, composeError } from '../compose.ts';
import { defineCommand, type Options, type Values } from '../command.ts';
import { validate } from '../config.ts';
import { loadContext, type Context } from '../context.ts';
import { listContainers, runOnce } from '../docker/client.ts';
import * as env from '../env.ts';
import { CliError, EXIT, UsageError } from '../errors.ts';
import { atomicWrite, PRIVATE, readIfExists } from '../fs.ts';
import { resolveExactGhost, resolveGhost } from '../ghost.ts';
import {
    importSite,
    MARKER,
    markIncomplete,
    readBundle,
    refuseImportOptions,
    sourceConfig,
} from '../import.ts';
import type { Io, Prompter } from '../io.ts';
import { SCHEMA_VERSION, writeMetadata, type Metadata } from '../meta.ts';
import {
    isCheckout,
    makeDirectories,
    managerPin,
    payloadConflicts,
    payloadFiles,
    stackDir,
    writeLauncher,
    writePayload,
    type Written,
} from '../payload.ts';
import { failed, printChecks } from '../report.ts';
import {
    DATA_DIRS,
    ENV_FILE,
    GHOST_ENV_FILE,
    META_FILE,
    readSettings,
    siteFacts,
    type SiteMode,
} from '../site.ts';
import { verifyIngress } from '../verify.ts';
import { managerVersion } from '../versions.ts';
import { collect } from './doctor.ts';

/** Where a local site's port search starts, and how far it goes. */
export const DEFAULT_PORT = 2368;
const PORT_SEARCH = 200;
const PRODUCTION_PORTS = { http: 80, https: 443 } as const;
/** Compose waits this long for health checks; pulls and builds come before it. */
const READY_TIMEOUT_SECONDS = 600;

const parsePort = (input: string): number => {
    if (!/^\d+$/.test(input) || Number(input) < 1 || Number(input) > 65_535) {
        throw new UsageError(`--port must be a port number: got '${input}'`);
    }
    return Number(input);
};

const options = {
    local: { type: 'boolean', brief: 'A local site: Ghost and MySQL on 127.0.0.1:PORT.' },
    domain: {
        type: 'string',
        brief: 'A production site on this domain: Ghost, MySQL and Caddy with HTTPS.',
    },
    'admin-domain': {
        type: 'string',
        brief: 'Serve Ghost Admin on a separate domain. Production only.',
    },
    email: {
        type: 'string',
        brief: 'The ACME account email Let’s Encrypt sends expiry and incident notices to. Production only.',
    },
    port: {
        type: 'string',
        brief: 'The loopback port Ghost is published on. Default: the first at or above 2368 that no container publishes.',
    },
    version: {
        type: 'string',
        brief: 'A Ghost version (6.3.1) or image tag (6-alpine). Resolved to an exact digest.',
    },
    with: { type: 'string', brief: 'Optional per-site services: activitypub.' },
    import: {
        type: 'string',
        brief: 'Import a local Ghost-CLI site from the bundle `ghost migrate-export` made: a directory, .tgz, .tar or .zip.',
    },
    'no-prompt': { type: 'boolean', brief: 'Never ask: every input must be an option.' },
    'no-start': {
        type: 'boolean',
        brief: 'Write the configuration and routes; start nothing.',
    },
} as const satisfies Options;

type Flags = Values<typeof options>;

// --- What to install ---------------------------------------------------------

interface Plan {
    readonly mode: SiteMode;
    readonly domain: string;
    readonly adminDomain: string;
    readonly email: string;
    readonly services: readonly string[];
}

/** What the options ask for, and at a terminal, what they leave out. */
async function plan(flags: Flags, prompt: Prompter | null): Promise<Plan> {
    if (flags.local && flags.domain !== undefined) {
        throw new UsageError('choose one site mode: --local, or --domain example.com, not both');
    }
    const ask = flags.noPrompt ? null : prompt;
    let mode: SiteMode | null = flags.local
        ? 'local'
        : flags.domain !== undefined
          ? 'production'
          : null;
    if (mode === null) {
        if (ask === null) {
            throw new UsageError('choose a site mode: --local, or --domain example.com');
        }
        mode = await ask.choose<SiteMode>('What kind of site?', [
            { name: 'Local: for themes and trying Ghost, on 127.0.0.1', value: 'local' },
            { name: 'Production: on a domain, with HTTPS', value: 'production' },
        ]);
    }
    let domain = flags.domain ?? '';
    if (mode === 'production' && domain === '') {
        domain = await ask!.text('Its domain (example.com):', (answer) =>
            isHostname(answer) ? null : 'a hostname such as example.com, not a URL',
        );
    }

    const adminDomain = flags.adminDomain ?? '';
    const email = flags.email ?? '';
    if (mode === 'local') {
        for (const [flag, value] of [
            ['--admin-domain', flags.adminDomain],
            ['--email', flags.email],
        ] as const) {
            if (value !== undefined) {
                throw new UsageError(`${flag} applies to production sites only`);
            }
        }
    } else {
        for (const [flag, value] of [
            ['--domain', domain],
            ['--admin-domain', adminDomain],
        ] as const) {
            if (value !== '' && !isHostname(value)) {
                throw new UsageError(`${flag} must be a hostname, not a URL: got '${value}'`);
            }
        }
        domain = domain.toLowerCase();
        if (adminDomain !== '' && adminDomain.toLowerCase() === domain) {
            throw new UsageError('--admin-domain must differ from --domain');
        }
        if (email !== '' && !ACME_EMAIL.test(email)) {
            throw new UsageError(`--email must be an email address: got '${email}'`);
        }
    }

    const services: string[] = [];
    for (const service of (flags.with ?? '').split(',').map((item) => item.trim())) {
        if (service === '') {
            continue;
        }
        if (service === 'local' || service === 'production') {
            throw new UsageError(
                '--with selects optional services; the site mode comes from --local or --domain',
            );
        }
        if (service === 'analytics') {
            // Its tinybird-login job is an interactive browser login, and
            // Ghost waits for the Tinybird jobs, so it cannot start here.
            throw new UsageError(
                '--with analytics is set up after installation: its Tinybird login is interactive.\n' +
                    '  Install without it, then follow TINYBIRD.md.',
            );
        }
        if (service !== 'activitypub') {
            throw new UsageError(`unknown optional service: ${service} (activitypub)`);
        }
        if (!services.includes(service)) {
            services.push(service);
        }
    }
    return { mode, domain, adminDomain: adminDomain.toLowerCase(), email, services };
}

// --- Identity -----------------------------------------------------------------

/** A lowercase, dash-separated token that Compose accepts in a project name. */
export const slug = (value: string): string =>
    value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

/**
 * The site's stable identity, and the suffix of every service's network
 * alias. Derived once and kept in `.env`, so it does not change when the
 * directory is renamed. Local names come from the directory so two local
 * sites on one host do not collide.
 */
export function projectName(mode: SiteMode, domain: string, dir: string): string {
    if (mode === 'production') {
        return `ghost-${slug(domain)}`;
    }
    return `ghost-local-${slug(basename(dir)) || 'site'}`;
}

/** 192 bits, hex: nothing in it a dotenv file, a shell or MySQL treats specially. */
export const secret = (): string => randomBytes(24).toString('hex');

/** The first port at or above the default that no container publishes. */
export function choosePort(taken: ReadonlySet<number>): number {
    for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_SEARCH; port += 1) {
        if (!taken.has(port)) {
            return port;
        }
    }
    throw new CliError(
        `every port from ${DEFAULT_PORT} to ${DEFAULT_PORT + PORT_SEARCH - 1} is published by a container; choose one with --port`,
    );
}

/** `vX.Y.Z` is stable, a `-beta.N` is beta, `edge-...` is edge; anything else is no channel. */
export function channelOf(version: string): Metadata['channel'] {
    if (/^v\d+\.\d+\.\d+$/.test(version)) {
        return 'stable';
    }
    if (/^v\d+\.\d+\.\d+-beta\.\d+$/.test(version)) {
        return 'beta';
    }
    return version.startsWith('edge') ? 'edge' : null;
}

// --- Undo -------------------------------------------------------------------

/** Every profile, so whatever a failed installation started is found. */
const ALL_PROFILES = 'local,production,analytics,activitypub';

const journalSchema = z.object({
    files: z.array(z.string().startsWith('/')),
    directories: z.array(z.string().startsWith('/')),
    data: z.array(z.string().startsWith('/')),
    project: z.boolean(),
});

/**
 * What this installation created, so that a failure removes exactly that and
 * leaves the directory as it was.
 *
 * An import also keeps this record in its marker file as it goes, so that an
 * import killed before it could clean up is removed by the next one.
 */
class Created implements Written {
    readonly checksums: Record<string, string> = {};
    readonly files: string[] = [];
    readonly directories: string[] = [];
    /** Data directories, which containers may have filled with files they own. */
    readonly data: string[] = [];
    /** Compose has created something for this project: a network, containers, volumes. */
    project = false;
    /** The import marker, when this is an import. */
    journal: string | null = null;

    private readonly io: Io;
    private readonly context: Context;
    private readonly dir: string;

    constructor(io: Io, context: Context, dir: string) {
        this.io = io;
        this.context = context;
        this.dir = dir;
    }

    /**
     * What an unfinished import's marker recorded. A marker that cannot be
     * read stands for everything an import writes besides the payload.
     */
    static fromJournal(io: Io, context: Context, dir: string): Created {
        const created = new Created(io, context, dir);
        created.journal = join(dir, MARKER);
        let recorded: z.infer<typeof journalSchema>;
        try {
            recorded = journalSchema.parse(JSON.parse(readIfExists(created.journal) ?? ''));
        } catch {
            recorded = {
                files: [ENV_FILE, GHOST_ENV_FILE, META_FILE].map((file) => join(dir, file)),
                directories: [],
                data: DATA_DIRS.map((data) => join(dir, data)),
                project: true,
            };
        }
        // Only ever inside this site directory, whatever the file says.
        const inside = (path: string) => path.startsWith(`${dir}/`);
        created.files.push(...recorded.files.filter(inside));
        created.directories.push(...recorded.directories.filter(inside));
        created.data.push(...recorded.data.filter(inside));
        created.project = recorded.project && existsSync(join(dir, ENV_FILE));
        return created;
    }

    file(path: string) {
        this.files.push(path);
        this.save();
    }

    /** Records what has been created so far in the import marker, if there is one. */
    save() {
        if (this.journal === null) {
            return;
        }
        const { files, directories, data, project } = this;
        atomicWrite(
            this.journal,
            `${JSON.stringify({ files, directories, data, project }, null, 2)}\n`,
            PRIVATE,
        );
    }

    async remove(): Promise<string[]> {
        const leftovers: string[] = [];
        if (this.project) {
            // Every profile, so whatever was started is found; the .env it
            // interpolates is still in place.
            const down = await compose(
                this.io,
                this.dir,
                ['down', '--volumes', '--remove-orphans', '--timeout', '20'],
                {
                    timeoutMs: 300_000,
                    env: { COMPOSE_PROFILES: ALL_PROFILES },
                },
            );
            if (down.exitCode !== 0) {
                leftovers.push(
                    `the project's containers (docker compose down failed: ${composeError(down, 2)})`,
                );
            }
        }
        if (this.data.length > 0) {
            leftovers.push(...(await this.removeData()));
        }
        for (const file of [...this.files].reverse()) {
            rmSync(file, { force: true });
        }
        for (const directory of [...this.directories].reverse()) {
            try {
                rmdirSync(directory);
            } catch {
                if (existsSync(directory)) {
                    leftovers.push(directory);
                }
            }
        }
        if (this.journal !== null) {
            removeStaging(this.dir);
            // Kept while anything is left, so the next import tries again.
            if (leftovers.length === 0) {
                rmSync(this.journal, { force: true });
            }
        }
        return leftovers;
    }

    /**
     * MySQL's data directory belongs to MySQL's user once it has run, so it is
     * removed as root, in a short-lived container that does only that.
     */
    private async removeData(): Promise<string[]> {
        const targets = this.data.filter((path) => existsSync(path));
        if (targets.length === 0) {
            return [];
        }
        if (this.context.image !== null) {
            await runOnce(this.io.docker, {
                image: this.context.image,
                entrypoint: ['rm', '-rf', '--'],
                cmd: targets.map((path) => `/site/${path.slice(this.dir.length + 1)}`),
                binds: [{ source: this.dir, target: '/site' }],
                user: '0:0',
                network: 'none',
                timeoutMs: 120_000,
            });
        }
        for (const path of targets) {
            try {
                rmSync(path, { recursive: true, force: true });
            } catch {
                // Reported below, as what is left.
            }
        }
        return targets.filter((path) => existsSync(path));
    }
}

// --- The installation ---------------------------------------------------------

const heading = (io: Io, title: string) => io.stdout(`\n${title}\n`);
const ok = (io: Io, label: string, detail = '') =>
    printChecks(io, [{ status: 'ok', label, detail }]);

export const installCommand = defineCommand({
    brief: 'Install a local or production site into the site directory, start it, and verify it. See docs/install.md.',
    options,
    async run(flags, _positionals, io) {
        // Before anything is looked at: a bad port is a usage error.
        const requestedPort = flags.port === undefined ? undefined : parsePort(flags.port);
        const bundle = flags.import;
        if (bundle !== undefined) {
            refuseImportOptions(flags);
        }
        const context = loadContext(io.env);
        const dir = context.siteDir;
        if (io.cwd() !== dir) {
            throw new CliError(
                `working in ${io.cwd()}, but the launcher gave the site directory as ${dir}`,
            );
        }

        // Everything an unfinished import wrote went into a directory it had
        // verified free, and it never served anything, so nothing in it is
        // worth keeping; but only an import may clear it.
        if (existsSync(join(dir, MARKER))) {
            if (bundle === undefined) {
                throw new CliError(
                    `an earlier import into ${dir} did not finish, so it holds a partial site\n` +
                        '  that cannot be started. Run the import again, which removes what it left behind first:\n' +
                        '    ./ghost-docker install --import BUNDLE',
                );
            }
            io.stdout('Removing what an earlier, unfinished import left behind\n');
            const leftovers = await io.busy('Removing the unfinished import', () =>
                Created.fromJournal(io, context, dir).remove(),
            );
            if (leftovers.length > 0) {
                throw new CliError(
                    `some of what the earlier import left could not be removed:\n${leftovers.map((item) => `  ${item}`).join('\n')}`,
                );
            }
        }

        for (const file of [ENV_FILE, META_FILE]) {
            if (existsSync(join(dir, file))) {
                throw new CliError(
                    `${join(dir, file)} already exists, so this directory already holds a site.\n` +
                        '  Install into a new, empty directory instead. Nothing has been changed.',
                );
            }
        }
        const clone = isCheckout(context, dir);
        const stack = stackDir(io.env);
        const files = clone ? [] : payloadFiles(stack);
        if (!clone) {
            const conflicts = payloadConflicts(dir, files);
            if (conflicts.length > 0) {
                throw new CliError(
                    `${dir} already has ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ', …' : ''}, which installation would write.\n` +
                        '  Install into a new, empty directory, or move these aside. Nothing has been changed.',
                );
            }
        }
        for (const data of DATA_DIRS) {
            const path = join(dir, data);
            if (existsSync(path) && readdirSync(path).length > 0) {
                throw new CliError(
                    `${path} is not empty. A new site is never installed over existing data. Nothing has been changed.`,
                );
            }
        }

        // --- The bundle, before anything else is decided ---
        // It says what kind of site this is and which Ghost version it runs.
        // A refusal from here until the site is written removes the staging
        // directory, and the directory is as it was.
        const staged = bundle === undefined ? null : await readBundle(io, dir, bundle, flags);

        const prepare = async () => {
            // Asked only now, so nobody answers questions to be told the directory is taken.
            const intent: Plan =
                staged === null
                    ? await plan(flags, io.prompt)
                    : { mode: 'local', domain: '', adminDomain: '', email: '', services: [] };

            // --- Preflight ---
            heading(io, 'Checking this host');
            const checks = await io.busy('Checking Docker and the site directory', () =>
                collect(context, io),
            );
            printChecks(io, checks);
            if (failed(checks)) {
                throw new CliError('preflight failed. Nothing has been changed on this host.');
            }

            // --- Ports Docker knows are taken ---
            const containers = await listContainers(io.docker);
            const published = new Set(containers.flatMap((container) => container.publishedPorts));
            const port = requestedPort ?? choosePort(published);
            const wanted = [
                port,
                ...(intent.mode === 'production'
                    ? [PRODUCTION_PORTS.http, PRODUCTION_PORTS.https]
                    : []),
            ];
            const holders = new Map<number, string>();
            for (const container of containers) {
                for (const busy of container.publishedPorts.filter((each) =>
                    wanted.includes(each),
                )) {
                    holders.set(busy, container.name);
                }
            }
            if (holders.size > 0) {
                const lines = [...holders].map(
                    ([busy, name]) =>
                        `  port ${busy} is already in use by the Docker container ${name}`,
                );
                throw new CliError(
                    `${lines.join('\n').trimStart()}\n` +
                        (holders.has(port)
                            ? `  Choose another port for Ghost with --port.`
                            : '  A production site needs ports 80 and 443 for Caddy. Free them first.') +
                        '\n  Nothing was stopped. Nothing has been changed.',
                );
            }

            // --- The exact Ghost image ---
            // An import happens at the source site's version; upgrading is a
            // separate step.
            heading(io, 'Resolving the Ghost image');
            const ghost = await io.busy('Resolving the Ghost image', () =>
                staged === null
                    ? resolveGhost(io, flags.version)
                    : resolveExactGhost(io, staged.manifest.ghost.version),
            );
            ok(
                io,
                'ghost',
                `${ghost.image}:${ghost.tag} is Ghost ${ghost.version}, ${ghost.reference}`,
            );

            const pin = clone
                ? null
                : await io.busy('Resolving the manager image', () => managerPin(io, context));
            return { intent, port, ghost, pin };
        };
        let prepared: Awaited<ReturnType<typeof prepare>>;
        try {
            prepared = await prepare();
        } catch (error) {
            if (staged !== null) {
                removeStaging(dir);
            }
            throw error;
        }
        const { intent, port, ghost, pin } = prepared;

        // --- From here on a failure removes what this installation created ---
        const created = new Created(io, context, dir);
        const { mode, domain, adminDomain, email, services } = intent;
        const project = projectName(mode, domain, dir);
        const profiles = [mode, ...services].join(',');
        const production = mode === 'production';
        const url = production ? `https://${domain}` : `http://localhost:${port}`;
        // Writing, starting and verifying. Everything it creates is recorded in
        // `created`, so a failure removes exactly that.
        const createSite = async () => {
            if (staged !== null) {
                // From the first change until the site is verified.
                created.journal = join(dir, MARKER);
                created.save();
            }
            heading(io, 'Writing the site');
            if (!clone) {
                writePayload(dir, stack, files, created);
                created.save();
                ok(
                    io,
                    'stack files',
                    `compose.yml, caddy/, mysql-init/, tinybird/ from the manager image`,
                );
                writeLauncher(dir, io.env, pin!, created);
                created.save();
                ok(io, 'ghost-docker', `the launcher, pinned to ${pin!}`);
            }

            const settings: [string, string][] = [
                ['COMPOSE_PROFILES', profiles],
                ['SITE_MODE', mode],
                ['COMPOSE_PROJECT_NAME', project],
                ['PROJECT_DIR', dir],
                ['NODE_ENV', production ? 'production' : 'development'],
                ['URL', url],
                ['GHOST_IMAGE', ghost.image],
                ['GHOST_VERSION', ghost.tag],
                ['GHOST_IMAGE_REF', ghost.reference],
                ['GHOST_CONTENT_PATH', ghost.contentPath],
                ['GHOST_TINYBIRD_PATH', ghost.tinybirdPath],
                ['GHOST_PORT', String(port)],
                ['RESTART_POLICY', production ? 'unless-stopped' : 'no'],
                ['DATABASE_HOST', 'db'],
                ['DATABASE_PORT', '3306'],
                ['DATABASE_NAME', 'ghost'],
                ['DATABASE_USER', 'ghost'],
                ['DATABASE_PASSWORD', secret()],
                ['DATABASE_ROOT_PASSWORD', secret()],
            ];
            if (production) {
                settings.push(
                    ['HTTP_PORT', String(PRODUCTION_PORTS.http)],
                    ['HTTPS_PORT', String(PRODUCTION_PORTS.https)],
                );
                if (adminDomain) {
                    settings.push(['ADMIN_URL', `https://${adminDomain}`]);
                }
            }
            const envPath = join(dir, ENV_FILE);
            created.file(envPath);
            atomicWrite(
                envPath,
                env.serializeAll(
                    settings,
                    '# Generated site settings. See .env.example for the optional ones.\n' +
                        '# Write values with ./ghost-docker config set .env KEY VALUE, which encodes them for Compose.\n',
                ),
                PRIVATE,
            );
            ok(io, ENV_FILE, 'Compose and operator settings, with generated database passwords');

            const ghostEnvPath = join(dir, GHOST_ENV_FILE);
            // The source site's configuration, without what the container owns.
            const carried = staged === null ? null : await sourceConfig(io, dir, staged.manifest);
            created.file(ghostEnvPath);
            atomicWrite(
                ghostEnvPath,
                ghostEnvTemplate(project, services.length > 0) +
                    (carried === null || carried.settings.length === 0
                        ? ''
                        : env.serializeAll(
                              carried.settings,
                              `# Carried over from ${staged!.manifest.url} by install --import.\n`,
                          )),
                PRIVATE,
            );
            ok(
                io,
                GHOST_ENV_FILE,
                carried === null
                    ? 'Ghost application settings'
                    : `${carried.settings.length} Ghost settings carried over from the source site`,
            );
            for (const { key, reason } of carried?.skipped ?? []) {
                printChecks(io, [
                    { status: 'note', label: 'not carried', detail: `${key}: ${reason}` },
                ]);
            }

            // Bind mount sources must exist before the daemon resolves them, or it
            // creates them as root. Ownership inside is the images' own business.
            for (const data of DATA_DIRS) {
                const path = join(dir, data);
                const before = created.directories.length;
                makeDirectories(path, created.directories);
                // An import writes into them even when they were there, empty.
                if (created.directories.length > before || staged !== null) {
                    created.data.push(path);
                }
            }
            created.save();
            ok(io, 'data', DATA_DIRS.join(' and '));

            const findings = await io.busy('Validating the configuration', () => validate(io, dir));
            const errors = findings.filter((finding) => finding.level === 'error');
            if (errors.length > 0) {
                throw new CliError(
                    `the generated configuration did not validate; please report this:\n${errors.map((finding) => `  ${finding.file}: ${finding.message}`).join('\n')}`,
                );
            }
            ok(io, 'configuration', `.env and ghost.env are valid for a ${mode} site`);

            if (staged !== null) {
                await importSite(io, dir, staged, profiles, ghost.version, () => {
                    created.project = true;
                    created.save();
                });
            }

            if (production) {
                // Written once; from here on the file is the operator's.
                created.file(join(dir, SITE_FILE));
                writeRoutes(dir, {
                    project,
                    domain,
                    adminDomain,
                    email,
                    activitypub: services.includes('activitypub'),
                });
                ok(
                    io,
                    SITE_FILE,
                    `routes for ${[domain, adminDomain].filter(Boolean).join(' and ')}; yours to edit`,
                );
            }

            const { commit, version } = managerVersion();
            created.file(join(dir, META_FILE));
            writeMetadata(dir, {
                schemaVersion: SCHEMA_VERSION,
                installedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
                mode,
                channel: clone ? null : channelOf(version),
                source: clone ? 'checkout' : 'image',
                stack: {
                    version: version === 'dev' || version === 'checkout' ? null : version,
                    commit: commit || null,
                    ref: clone ? null : version === 'dev' ? null : version,
                    image: pin,
                },
                site: {
                    project,
                    dir,
                    url,
                    domain: domain || null,
                    adminDomain: adminDomain || null,
                },
                ghost: {
                    image: ghost.image,
                    tag: ghost.tag,
                    version: ghost.version,
                    digest: ghost.digest,
                },
                profiles: profiles.split(','),
                payload: created.checksums,
                migrations: [],
            });
            ok(io, META_FILE, 'installation metadata');

            if (flags.noStart) {
                io.stdout('\nNot starting: --no-start was given.\n');
                if (staged !== null) {
                    // The import needed the database, and Ghost once for a
                    // rows-only bundle. Nothing is left running; the data stays.
                    const down = await io.busy('Stopping what the import started', () =>
                        compose(io, dir, ['down', '--remove-orphans', '--timeout', '20'], {
                            timeoutMs: 300_000,
                        }),
                    );
                    if (down.exitCode !== 0) {
                        throw new CliError(
                            `the services the import started could not be stopped: ${composeError(down, 2)}`,
                        );
                    }
                }
            } else {
                heading(io, 'Starting the services');
                created.project = true;
                const up = await io.busy(
                    'Pulling images, starting the services and waiting for them to be healthy',
                    () =>
                        compose(
                            io,
                            dir,
                            [
                                'up',
                                '--detach',
                                '--wait',
                                '--wait-timeout',
                                String(READY_TIMEOUT_SECONDS),
                            ],
                            { timeoutMs: (READY_TIMEOUT_SECONDS + 900) * 1000 },
                        ),
                );
                if (up.exitCode !== 0) {
                    throw startFailure(up.stderr || up.stdout, up.timedOut);
                }
                ok(io, 'services', 'healthy, by their own health checks');

                heading(io, 'Verifying the site');
                const verified = await io.busy('Reaching the site through its ingress', () =>
                    verifyIngress(io, siteFacts(dir, readSettings(dir)!)),
                );
                printChecks(io, verified);
                if (failed(verified)) {
                    throw new CliError(
                        'the site started, but it is not reachable through its own ingress',
                    );
                }
            }
            if (staged !== null) {
                // Verified, or deliberately not started: either way, now a site.
                removeStaging(dir);
                rmSync(join(dir, MARKER), { force: true });
                created.journal = null;
            }
        };

        try {
            await createSite();
        } catch (error) {
            io.stderr(`\n${describe(error)}\n`);
            if (staged !== null) {
                // Whatever happened, a partial site must not be startable.
                markIncomplete(dir);
            }
            if (created.project) {
                const logs = await io.busy("Reading the services' logs", () =>
                    compose(io, dir, ['logs', '--no-color', '--tail', '30'], {
                        timeoutMs: 60_000,
                        env: { COMPOSE_PROFILES: ALL_PROFILES },
                    }),
                );
                if (logs.stdout.trim()) {
                    io.stderr(`\nThe services' last words:\n${logs.stdout.trimEnd()}\n`);
                }
            }
            if (staged !== null && io.env.GD_IMPORT_KEEP_FAILED === '1') {
                // Kept for inspection, not left running.
                if (created.project) {
                    await io.busy('Stopping what the import started', () =>
                        compose(io, dir, ['stop', '--timeout', '20'], {
                            timeoutMs: 300_000,
                            env: { COMPOSE_PROFILES: ALL_PROFILES },
                        }),
                    );
                }
                io.stderr(
                    `\nThe import did not complete. GD_IMPORT_KEEP_FAILED is set, so what it created was\n` +
                        `kept for inspection in ${dir}. It cannot be started; running the import\n` +
                        'again removes it first.\n',
                );
                throw new CliError('the import failed.');
            }
            io.stderr(
                `\nThe ${staged === null ? 'installation' : 'import'} did not complete. Removing what it created\n`,
            );
            const leftovers = await io.busy('Removing what the installation created', () =>
                created.remove(),
            );
            if (leftovers.length > 0) {
                io.stderr(
                    `Some of it could not be removed:\n${leftovers.map((item) => `  ${item}\n`).join('')}`,
                );
            } else if (staged !== null) {
                io.stderr(
                    `${dir} is as it was before the import. The bundle and the source site were not changed.\n`,
                );
            } else {
                io.stderr(
                    `${dir} is as it was before. Nothing that was already running was stopped.\n`,
                );
            }
            throw new CliError(
                `${staged === null ? 'installation' : 'the import'} failed; fix the error above and run the same command again.`,
            );
        }

        const admin = adminDomain ? `https://${adminDomain}` : url;
        const next = flags.noStart
            ? ['Nothing is running. Start the site with: docker compose up -d']
            : production
              ? [
                    "Point the domain's DNS at this host; Caddy then obtains a certificate, and",
                    './ghost-docker check reports it. Configure mail (see ghost.env), then open',
                    'Ghost Admin and create the owner account.',
                ]
              : staged !== null
                ? ["Sign in to Ghost Admin with the source site's staff accounts."]
                : ['Open Ghost Admin and create the owner account.'];
        io.stdout(
            [
                '',
                'Ghost is installed.',
                '',
                `  Site         ${url}`,
                `  Ghost Admin  ${admin}/ghost/`,
                `  Project      ${project} (${profiles}), in ${dir}`,
                `  Ghost        ${ghost.version}, ${ghost.reference}`,
                `  Loopback     127.0.0.1:${port}`,
                ...(staged === null
                    ? []
                    : [`  Imported     ${staged.manifest.kind} bundle of ${staged.manifest.url}`]),
                '',
                '.env and ghost.env hold the credentials; back them up.',
                ...next,
                '',
            ].join('\n'),
        );
        return EXIT.ok;
    },
});

const describe = (error: unknown) =>
    error instanceof CliError
        ? `error: ${error.message}`
        : `error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;

/**
 * Written fresh rather than copied from the example, whose SMTP block is a
 * placeholder: a site shipping with smtp.example.com fails to send mail in a
 * way that looks like a Ghost bug.
 */
function ghostEnvTemplate(project: string, optionalServices: boolean): string {
    return [
        `# Ghost application settings for ${project}; see ghost.env.example.`,
        '# Write values with ./ghost-docker config set ghost.env KEY VALUE, which encodes',
        '# them for Compose. Staff invites and password resets need mail__* (SMTP) set.',
        '',
        // Both optional services need Ghost's public API.
        ...(optionalServices ? [env.serialize('labs__publicAPI', 'true')] : []),
        '',
    ].join('\n');
}

/**
 * Why `up` failed, in Compose's own words. Docker names a port it could not
 * bind; its wording changes between versions, so it is quoted, not parsed.
 */
function startFailure(output: string, timedOut: boolean): CliError {
    const said = output
        .trim()
        .split('\n')
        .slice(-8)
        .map((line) => `  ${line}`)
        .join('\n');
    return new CliError(
        `${timedOut ? 'the services did not finish starting before the deadline' : 'the services did not start and become healthy'}. Compose said:\n${said}\n` +
            '  If a port is already in use, choose another for Ghost with --port; a production\n' +
            '  site needs 80 and 443 free for Caddy. Nothing that was already running was stopped.',
    );
}
