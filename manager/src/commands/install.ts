// `install`: a local or production site, configured, started and verified.
//
// The order matters, and each part has one reason to be where it is. `run`
// takes the parts in this order, each in a function of its own:
//
//   1. Refusals that need nothing: options, an existing site, files the
//      payload would overwrite. Nothing has been changed, except that an
//      import first removes what an earlier, unfinished one left behind.
//   2. With --import, the bundle, which says what kind of site this is and
//      which Ghost version it runs. `Importing` (import.ts) is everything an
//      import adds, called at its points below.
//   3. Preflight (doctor's checks), ports Docker knows are taken, the exact
//      Ghost image. Still nothing has been changed.
//   4. Writing: payload and launcher (image mode), `.env`, `ghost.env`, data
//      directories, an import's content and database, routes, metadata. From
//      here a failure removes what this installation created (undo.ts), so
//      the same command can simply be run again.
//   5. Starting and verifying, unless --no-start.
//
// Installation never stops or reconfigures anything already running. A port
// held by a Docker container is refused before anything is written; one held
// by anything else is found when Compose starts the services, whose error
// names it.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ACME_EMAIL, isHostname, SITE_FILE, writeRoutes } from '../caddy.ts';
import { compose } from '../compose.ts';
import { z } from 'zod';
import { defineCommand, flag, refused } from '../command.ts';
import { validate } from '../config.ts';
import { loadContext, type Context } from '../context.ts';
import { listContainers, stoppedSiteContainers } from '../docker/client.ts';
import * as env from '../env.ts';
import { CliError, EXIT, UsageError } from '../errors.ts';
import { atomicWrite, PRIVATE } from '../fs.ts';
import { resolveGhost, type ResolvedGhost } from '../ghost.ts';
import { clearUnfinishedImport, Importing, importConflict } from '../import.ts';
import type { Io, Prompter } from '../io.ts';
import { SCHEMA_VERSION, writeMetadata } from '../meta.ts';
import {
    isCheckout,
    makeDirectories,
    managerPin,
    payloadConflicts,
    payloadFiles,
    stackDir,
    writeLauncher,
    writePayload,
} from '../payload.ts';
import { failed, printChecks } from '../report.ts';
import {
    DATA_DIRS,
    ENV_FILE,
    GHOST_ENV_FILE,
    MAILPIT_DATA_DIR,
    META_FILE,
    readSettings,
    siteFacts,
    type SiteMode,
} from '../site.ts';
import { ALL_PROFILES, Created } from '../undo.ts';
import { verifyIngress } from '../verify.ts';
import {
    channelOption,
    releaseOf,
    releaseOption,
    requestedRelease,
    type ManagerRelease,
    type Requested,
} from './common.ts';
import { collect } from './doctor.ts';

/** Where a local site's port search starts, and how far it goes. */
export const DEFAULT_PORT = 2368;
/** Where the search for Mailpit's inbox port starts. */
export const DEFAULT_MAILPIT_PORT = 8025;
const PORT_SEARCH = 200;
const PRODUCTION_PORTS = { http: 80, https: 443 } as const;
/** Compose waits this long for health checks; pulls and builds come before it. */
export const READY_TIMEOUT_SECONDS = 600;

/** The services `--with` can name. */
const OPTIONAL_SERVICES = ['activitypub', 'mailpit'];

/** `--with a,b`: each service once. Whether it suits the site's mode is plan's to say. */
const services = z.string().transform((list, ctx) => {
    const refuse = (message: string) => {
        ctx.addIssue({ code: 'custom', message, input: list });
        return z.NEVER;
    };
    const named: string[] = [];
    for (const service of list.split(',').map((item) => item.trim())) {
        if (service === '' || named.includes(service)) {
            continue;
        }
        if (service === 'local' || service === 'production') {
            return refuse(
                'selects optional services; the site mode comes from --local or --domain',
            );
        }
        if (service === 'analytics') {
            // Its tinybird-login job is an interactive browser login, and
            // Ghost waits for the Tinybird jobs, so it cannot start here.
            return refuse(
                'analytics is set up after installation: its Tinybird login is interactive.\n' +
                    '  Install without it, then follow TINYBIRD.md.',
            );
        }
        if (!OPTIONAL_SERVICES.includes(service)) {
            return refuse(
                `names an unknown optional service: ${service} (${OPTIONAL_SERVICES.join(', ')})`,
            );
        }
        named.push(service);
    }
    return named;
});

const hostname = z
    .string()
    .refine(isHostname, refused('must be a hostname, not a URL'))
    .transform((value) => value.toLowerCase());

const options = z
    .object({
        local: flag('A local site: Ghost and MySQL on 127.0.0.1:PORT.'),
        domain: hostname
            .optional()
            .describe('A production site on this domain: Ghost, MySQL and Caddy with HTTPS.'),
        adminDomain: hostname
            .optional()
            .describe('Serve Ghost Admin on a separate domain. Production only.'),
        email: z
            .string()
            .regex(ACME_EMAIL, refused('must be an email address'))
            .optional()
            .describe(
                'The ACME account email Let’s Encrypt sends expiry and incident notices to. Production only.',
            ),
        port: z
            .string()
            .refine(
                (input) => /^\d+$/.test(input) && Number(input) >= 1 && Number(input) <= 65_535,
                refused('must be a port number'),
            )
            .transform(Number)
            .optional()
            .describe(
                'The loopback port Ghost is published on. Default: the first at or above 2368 that no container publishes.',
            ),
        version: z
            .string()
            .optional()
            .describe(
                'A Ghost version (6.3.1) or image tag (6-alpine). Resolved to an exact digest.',
            ),
        with: services
            .default([])
            .describe('Optional per-site services: activitypub, and mailpit for a local site.'),
        import: z
            .string()
            .min(1, { error: 'needs the path of a migration bundle' })
            .optional()
            .describe(
                'Import a local Ghost-CLI site from the bundle `ghost migrate-export` made: a directory, .tgz, .tar or .zip.',
            ),
        channel: channelOption(
            'Install the newest release on this channel: stable or beta. The launcher resolves it.',
        ),
        release: releaseOption(
            'Install this release, vX.Y.Z or vX.Y.Z-beta.N. The launcher resolves it.',
        ),
        noPrompt: flag('Never ask: every input must be an option.'),
        noStart: flag('Write the configuration and routes; start nothing.'),
    })
    .superRefine((flags, ctx) => {
        const conflict =
            (flags.local && flags.domain !== undefined
                ? 'choose one site mode: --local, or --domain example.com, not both'
                : null) ??
            (flags.channel !== undefined && flags.release !== undefined
                ? 'choose --channel or --release, not both'
                : null) ??
            (flags.import === undefined ? null : importConflict(flags));
        if (conflict !== null) {
            ctx.addIssue({ code: 'custom', message: conflict });
        }
    });

type Flags = z.output<typeof options>;

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
        domain = (
            await ask!.text('Its domain (example.com):', (answer) =>
                isHostname(answer) ? null : 'a hostname such as example.com, not a URL',
            )
        ).toLowerCase();
    }

    const adminDomain = flags.adminDomain ?? '';
    const email = flags.email ?? '';
    if (mode === 'local') {
        for (const [option, value] of [
            ['--admin-domain', flags.adminDomain],
            ['--email', flags.email],
        ] as const) {
            if (value !== undefined) {
                throw new UsageError(`${option} applies to production sites only`);
            }
        }
    } else {
        if (adminDomain !== '' && adminDomain === domain) {
            throw new UsageError('--admin-domain must differ from --domain');
        }
        if (flags.with.includes('mailpit')) {
            throw new UsageError(
                "--with mailpit is for local sites only: it would catch a production site's real mail",
            );
        }
    }
    return { mode, domain, adminDomain, email, services: flags.with };
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

/** The first port at or above `start` (Ghost's default) that is not taken. */
export function choosePort(taken: ReadonlySet<number>, start = DEFAULT_PORT): number {
    for (let port = start; port < start + PORT_SEARCH; port += 1) {
        if (!taken.has(port)) {
            return port;
        }
    }
    throw new CliError(
        `every port from ${start} to ${start + PORT_SEARCH - 1} is taken` +
            (start === DEFAULT_PORT ? '; choose one with --port' : ''),
    );
}

// --- The installation ---------------------------------------------------------

const heading = (io: Io, title: string) => io.stdout(`\n${title}\n`);
const ok = (io: Io, label: string, detail = '') =>
    printChecks(io, [{ status: 'ok', label, detail }]);

/** The site directory, and what installation would write into it. */
interface Target {
    readonly io: Io;
    readonly context: Context;
    readonly dir: string;
    /** A checkout of the repository, whose files are used in place. */
    readonly clone: boolean;
    readonly stack: string;
    /** The payload's files, relative to `stack`; none in a checkout. */
    readonly files: readonly string[];
}

/** Everything decided before the first write. */
interface Site extends Target {
    readonly flags: Flags;
    readonly intent: Plan;
    readonly port: number;
    /** Where Mailpit's inbox is published, with --with mailpit. */
    readonly mailpitPort: number | null;
    readonly ghost: ResolvedGhost;
    /** The manager image the launcher is pinned to; none in a checkout. */
    readonly pin: string | null;
    readonly project: string;
    readonly profiles: string;
    readonly production: boolean;
    readonly url: string;
    /** This manager's release, and the channel the site follows. */
    readonly release: ManagerRelease;
}

export const installCommand = defineCommand({
    brief: 'Install a local or production site into the site directory, start it, and verify it. See docs/install.md.',
    options,
    async run(flags, _positionals, io) {
        // 1. Refusals. The options were checked as they were parsed.
        const release = requestedRelease(flags.channel, flags.release, '--release');
        const context = loadContext(io.env);
        const dir = context.siteDir;
        if (io.cwd() !== dir) {
            throw new CliError(
                `working in ${io.cwd()}, but the launcher gave the site directory as ${dir}`,
            );
        }
        await clearUnfinishedImport(io, context, dir, flags.import !== undefined);
        const target = refuseOccupied(io, context, dir);

        // 2. The bundle, then 3. everything decided before the first write.
        const importing =
            flags.import === undefined ? null : await Importing.read(io, dir, flags.import, flags);
        let site: Site;
        try {
            site = await prepare(target, flags, release, importing);
        } catch (error) {
            importing?.abandon();
            throw error;
        }

        // 4, 5. Writing, starting and verifying. From here on a failure
        // removes what this installation created.
        const created = new Created(io, context, dir);
        try {
            await createSite(site, created, importing);
        } catch (error) {
            return await undoInstall(site, created, importing, error);
        }
        printSummary(site, importing);
        return EXIT.ok;
    },
});

/** Refuses a directory that already holds a site, or files the payload would write over. */
function refuseOccupied(io: Io, context: Context, dir: string): Target {
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
    for (const data of [...DATA_DIRS, MAILPIT_DATA_DIR]) {
        const path = join(dir, data);
        if (existsSync(path) && readdirSync(path).length > 0) {
            throw new CliError(
                `${path} is not empty. A new site is never installed over existing data. Nothing has been changed.`,
            );
        }
    }
    return { io, context, dir, clone, stack, files };
}

// --- Before anything is written -----------------------------------------------

/** An import is of a local site, with no optional services but Mailpit (importConflict). */
const imported = (flags: Flags): Plan => ({
    mode: 'local',
    domain: '',
    adminDomain: '',
    email: '',
    services: flags.with,
});

/** Decides everything about the site, changing nothing. */
async function prepare(
    target: Target,
    flags: Flags,
    requested: Requested,
    importing: Importing | null,
): Promise<Site> {
    const { io, context, dir, clone } = target;
    const release = releaseOf(requested, io.env);
    // Asked only now, so nobody answers questions to be told the directory is taken.
    const intent = importing === null ? await plan(flags, io.prompt) : imported(flags);
    await preflight(io, context);
    const { port, mailpitPort } = await sitePorts(
        io,
        intent.mode,
        flags.port,
        intent.services.includes('mailpit'),
    );

    heading(io, 'Resolving the Ghost image');
    const ghost = await io.busy('Resolving the Ghost image', () =>
        importing === null ? resolveGhost(io, flags.version) : importing.resolveGhost(),
    );
    ok(io, 'ghost', `${ghost.image}:${ghost.tag} is Ghost ${ghost.version}, ${ghost.reference}`);

    const pin = clone
        ? null
        : await io.busy('Resolving the manager image', () => managerPin(io, context));

    const production = intent.mode === 'production';
    return {
        ...target,
        flags,
        intent,
        port,
        mailpitPort,
        ghost,
        pin,
        project: projectName(intent.mode, intent.domain, dir),
        profiles: [intent.mode, ...intent.services].join(','),
        production,
        url: production ? `https://${intent.domain}` : `http://localhost:${port}`,
        release,
    };
}

/** Doctor's checks: Docker, the platform and the site directory. */
async function preflight(io: Io, context: Context): Promise<void> {
    heading(io, 'Checking this host');
    const checks = await io.busy('Checking Docker and the site directory', () =>
        collect(context, io),
    );
    printChecks(io, checks);
    if (failed(checks)) {
        throw new CliError('preflight failed. Nothing has been changed on this host.');
    }
}

/**
 * The ports Ghost, and with --with mailpit Mailpit's inbox, are published on.
 * Any port the site needs that a container already publishes is refused,
 * naming the container. Where Docker would publish over a port a host process
 * holds (io.hostListens), Ghost's port must also be free on the host: a
 * chosen one skips it, a requested one is refused. Mailpit's is always
 * chosen, the same way.
 */
async function sitePorts(
    io: Io,
    mode: SiteMode,
    requested: number | undefined,
    mailpit: boolean,
): Promise<{ port: number; mailpitPort: number | null }> {
    // A stopped site's ports count as taken: it would fail to start again.
    const running = await listContainers(io.docker);
    const stopped = await stoppedSiteContainers(io.docker);
    const containers = [...running, ...stopped];
    const published = new Set(containers.flatMap((container) => container.publishedPorts));
    const port = requested ?? (await freeOnHost(io, published));
    const mailpitPort = mailpit
        ? await freeOnHost(io, new Set([...published, port]), DEFAULT_MAILPIT_PORT)
        : null;
    const wanted = [
        port,
        ...(mode === 'production' ? [PRODUCTION_PORTS.http, PRODUCTION_PORTS.https] : []),
    ];
    const holders = new Map<number, string>();
    for (const container of containers) {
        for (const busy of container.publishedPorts.filter((each) => wanted.includes(each))) {
            holders.set(
                busy,
                running.includes(container)
                    ? `in use by the Docker container ${container.name}`
                    : `taken by the Docker container ${container.name}, which is stopped and publishes it when it starts`,
            );
        }
    }
    if (holders.size > 0) {
        const lines = [...holders].map(([busy, holder]) => `  port ${busy} is already ${holder}`);
        throw new CliError(
            `${lines.join('\n').trimStart()}\n` +
                (holders.has(port)
                    ? `  Choose another port for Ghost with --port.`
                    : '  A production site needs ports 80 and 443 for Caddy. Free them first.') +
                '\n  Nothing was stopped. Nothing has been changed.',
        );
    }
    if (requested !== undefined && !published.has(port) && (await io.hostListens(port))) {
        throw new CliError(
            `port ${port} is already in use on this host by something outside Docker, such as a\n` +
                '  Ghost-CLI site (`ghost ls` lists those). Docker here would publish the site on it\n' +
                '  anyway, and the other program would keep answering. Choose another port with --port.\n' +
                '  Nothing has been changed.',
        );
    }
    return { port, mailpitPort };
}

/** The first port no container publishes and, where that can be told, nothing on the host holds. */
async function freeOnHost(
    io: Io,
    published: ReadonlySet<number>,
    start = DEFAULT_PORT,
): Promise<number> {
    const taken = new Set(published);
    for (;;) {
        const port = choosePort(taken, start);
        if (!(await io.hostListens(port))) {
            return port;
        }
        taken.add(port);
    }
}

// --- Writing, starting and verifying --------------------------------------------

/**
 * Everything this does is recorded in `created`, so that a failure removes
 * exactly that.
 */
async function createSite(site: Site, created: Created, importing: Importing | null) {
    importing?.begin(created);
    heading(site.io, 'Writing the site');
    writeStack(site, created);
    writeEnv(site, created);
    await writeGhostEnv(site, created, importing);
    makeDataDirectories(site, created, importing !== null);
    await validateConfiguration(site);
    await importing?.load(created, site.profiles, site.ghost.version);
    writeSiteRoutes(site, created);
    writeSiteMetadata(site, created);
    if (site.flags.noStart) {
        site.io.stdout('\nNot starting: --no-start was given.\n');
        await importing?.stop();
    } else {
        await startAndVerify(site, created);
    }
    importing?.finish(created);
}

/** In image mode, the stack's files and the launcher; a checkout's are used in place. */
function writeStack(site: Site, created: Created) {
    const { io, dir, clone, stack, files, pin } = site;
    if (clone) {
        return;
    }
    writePayload(dir, stack, files, created);
    created.save();
    ok(io, 'stack files', `compose.yml, caddy/, mysql-init/, tinybird/ from the manager image`);
    writeLauncher(dir, io.env, { image: pin!, channel: site.release.channel }, created);
    created.save();
    ok(io, 'ghost-docker', `the launcher, pinned to ${pin!}`);
}

function writeEnv(site: Site, created: Created) {
    const { io, dir, intent, ghost, production } = site;
    const settings: [string, string][] = [
        ['COMPOSE_PROFILES', site.profiles],
        ['SITE_MODE', intent.mode],
        ['COMPOSE_PROJECT_NAME', site.project],
        ['PROJECT_DIR', dir],
        ['NODE_ENV', production ? 'production' : 'development'],
        ['URL', site.url],
        ['GHOST_IMAGE', ghost.image],
        ['GHOST_VERSION', ghost.tag],
        ['GHOST_IMAGE_REF', ghost.reference],
        ['GHOST_CONTENT_PATH', ghost.contentPath],
        ['GHOST_TINYBIRD_PATH', ghost.tinybirdPath],
        ['GHOST_PORT', String(site.port)],
        ...(site.mailpitPort === null
            ? []
            : [['MAILPIT_PORT', String(site.mailpitPort)] as [string, string]]),
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
        if (intent.adminDomain) {
            settings.push(['ADMIN_URL', `https://${intent.adminDomain}`]);
        }
    }
    const path = join(dir, ENV_FILE);
    created.file(path);
    atomicWrite(
        path,
        env.serializeAll(
            settings,
            '# Generated site settings. See .env.example for the optional ones.\n' +
                '# Write values with ./ghost-docker config set .env KEY VALUE, which encodes them for Compose.\n',
        ),
        PRIVATE,
    );
    ok(io, ENV_FILE, 'Compose and operator settings, with generated database passwords');
}

async function writeGhostEnv(
    { io, dir, project, intent }: Site,
    created: Created,
    importing: Importing | null,
) {
    const path = join(dir, GHOST_ENV_FILE);
    const mailpit = intent.services.includes('mailpit');
    // The source site's configuration, without what the container owns, and
    // with Mailpit, without the source's mail transport.
    const carried = await importing?.ghostEnv(mailpit);
    created.file(path);
    atomicWrite(path, ghostEnvTemplate(project, intent.services) + (carried?.text ?? ''), PRIVATE);
    ok(io, GHOST_ENV_FILE, carried?.detail ?? 'Ghost application settings');
    for (const { key, reason } of carried?.skipped ?? []) {
        printChecks(io, [{ status: 'note', label: 'not carried', detail: `${key}: ${reason}` }]);
    }
}

/**
 * Bind mount sources must exist before the daemon resolves them, or it
 * creates them as root. Ownership inside is the images' own business.
 */
function makeDataDirectories({ io, dir, intent }: Site, created: Created, isImport: boolean) {
    const dirs = [...DATA_DIRS, ...(intent.services.includes('mailpit') ? [MAILPIT_DATA_DIR] : [])];
    for (const data of dirs) {
        const path = join(dir, data);
        const before = created.directories.length;
        makeDirectories(path, created.directories);
        // An import writes into them even when they were there, empty.
        if (created.directories.length > before || isImport) {
            created.data.push(path);
        }
    }
    created.save();
    ok(io, 'data', `${dirs.slice(0, -1).join(', ')} and ${dirs.at(-1)}`);
}

async function validateConfiguration({ io, dir, intent }: Site) {
    const findings = await io.busy('Validating the configuration', () => validate(io, dir));
    const errors = findings.filter((finding) => finding.level === 'error');
    if (errors.length > 0) {
        throw new CliError(
            `the generated configuration did not validate; please report this:\n${errors.map((finding) => `  ${finding.file}: ${finding.message}`).join('\n')}`,
        );
    }
    ok(io, 'configuration', `.env and ghost.env are valid for a ${intent.mode} site`);
}

/** A production site's Caddy routes. Written once; from here on the file is the operator's. */
function writeSiteRoutes({ io, dir, production, project, intent }: Site, created: Created) {
    if (!production) {
        return;
    }
    const { domain, adminDomain, email, services } = intent;
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

function writeSiteMetadata(site: Site, created: Created) {
    const { io, dir, clone, intent, ghost } = site;
    const { commit, version, channel } = site.release;
    created.file(join(dir, META_FILE));
    writeMetadata(dir, {
        schemaVersion: SCHEMA_VERSION,
        installedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        mode: intent.mode,
        channel: clone ? null : channel,
        source: clone ? 'checkout' : 'image',
        stack: {
            version,
            commit,
            ref: clone ? null : version,
            image: site.pin,
            previous: null,
        },
        site: {
            project: site.project,
            dir,
            url: site.url,
            domain: intent.domain || null,
            adminDomain: intent.adminDomain || null,
        },
        ghost: {
            image: ghost.image,
            tag: ghost.tag,
            version: ghost.version,
            digest: ghost.digest,
        },
        profiles: site.profiles.split(','),
        payload: created.checksums,
        migrations: [],
    });
    ok(io, META_FILE, 'installation metadata');
}

async function startAndVerify({ io, dir }: Site, created: Created) {
    heading(io, 'Starting the services');
    created.project = true;
    const up = await io.busy(
        'Pulling images, starting the services and waiting for them to be healthy',
        () =>
            compose(
                io,
                dir,
                ['up', '--detach', '--wait', '--wait-timeout', String(READY_TIMEOUT_SECONDS)],
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
        throw new CliError('the site started, but it is not reachable through its own ingress');
    }
}

// --- The outcome ----------------------------------------------------------------

/**
 * Reports a failure after the first write, and removes what this
 * installation created, so the same command can be run again.
 */
async function undoInstall(
    { io, dir }: Site,
    created: Created,
    importing: Importing | null,
    error: unknown,
): Promise<never> {
    io.stderr(`\n${describe(error)}\n`);
    importing?.markIncomplete();
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
    if (importing !== null && (await importing.keptForInspection(created))) {
        throw new CliError('the import failed.');
    }
    io.stderr(
        `\nThe ${importing === null ? 'installation' : 'import'} did not complete. Removing what it created\n`,
    );
    const leftovers = await io.busy('Removing what the installation created', () =>
        created.remove(),
    );
    if (leftovers.length > 0) {
        io.stderr(
            `Some of it could not be removed:\n${leftovers.map((item) => `  ${item}\n`).join('')}`,
        );
    } else if (importing !== null) {
        io.stderr(
            `${dir} is as it was before the import. The bundle and the source site were not changed.\n`,
        );
    } else {
        io.stderr(`${dir} is as it was before. Nothing that was already running was stopped.\n`);
    }
    throw new CliError(
        `${importing === null ? 'installation' : 'the import'} failed; fix the error above and run the same command again.`,
    );
}

function printSummary(site: Site, importing: Importing | null) {
    const { io, flags, intent, url, production, ghost } = site;
    const admin = intent.adminDomain ? `https://${intent.adminDomain}` : url;
    const next = flags.noStart
        ? ['Nothing is running. Start the site with: docker compose up -d']
        : production
          ? [
                "Point the domain's DNS at this host; Caddy then obtains a certificate, and",
                './ghost-docker check reports it. Configure mail (see ghost.env), then open',
                'Ghost Admin and create the owner account.',
            ]
          : importing !== null
            ? ["Sign in to Ghost Admin with the source site's staff accounts."]
            : ['Open Ghost Admin and create the owner account.'];
    io.stdout(
        [
            '',
            'Ghost is installed.',
            '',
            `  Site         ${url}`,
            `  Ghost Admin  ${admin}/ghost/`,
            `  Project      ${site.project} (${site.profiles}), in ${site.dir}`,
            `  Ghost        ${ghost.version}, ${ghost.reference}`,
            `  Loopback     127.0.0.1:${site.port}`,
            ...(site.mailpitPort === null
                ? []
                : [`  Mailpit      http://127.0.0.1:${site.mailpitPort}, the mail Ghost sends`]),
            ...(importing === null ? [] : [`  Imported     ${importing.description}`]),
            '',
            '.env and ghost.env hold the credentials; back them up.',
            ...next,
            '',
        ].join('\n'),
    );
}

const describe = (error: unknown) =>
    error instanceof CliError
        ? `error: ${error.message}`
        : `error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;

/**
 * Written fresh rather than copied from the example, whose SMTP block is a
 * placeholder: a site shipping with smtp.example.com fails to send mail in a
 * way that looks like a Ghost bug. With Mailpit, mail goes to it; the
 * operator owns these lines afterwards.
 */
export function ghostEnvTemplate(project: string, services: readonly string[]): string {
    const mailpit = services.includes('mailpit');
    return [
        `# Ghost application settings for ${project}; see ghost.env.example.`,
        '# Write values with ./ghost-docker config set ghost.env KEY VALUE, which encodes',
        mailpit
            ? '# them for Compose. Mail goes to Mailpit, whose inbox is at MAILPIT_PORT in .env.'
            : '# them for Compose. Staff invites and password resets need mail__* (SMTP) set.',
        '',
        // ActivityPub (and analytics, added later) need Ghost's public API.
        ...(services.includes('activitypub') ? [env.serialize('labs__publicAPI', 'true')] : []),
        ...(mailpit ? mailpitMail(project).map(([key, value]) => env.serialize(key, value)) : []),
        '',
    ].join('\n');
}

/** Ghost's SMTP settings for the site's own Mailpit, by its unique alias. */
export const mailpitMail = (project: string): [string, string][] => [
    ['mail__transport', 'SMTP'],
    ['mail__options__host', `mailpit-${project}`],
    ['mail__options__port', '1025'],
    ['mail__options__secure', 'false'],
];

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
