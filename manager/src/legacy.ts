// Migration 0001-compose-profiles: an installation of the released `main`
// layout, moved onto this one. It is how such a site comes to `self-update`
// (docs/install.md#moving-from-the-released-main-layout).
//
// A `main` installation is a git clone that updates with `git pull`. It has no
// launcher and no metadata; its compose.yml has no site-mode profiles; its one
// `.env` is both Compose's settings and Ghost's configuration; its Caddyfile
// is an untracked, hand-edited file; it runs a Ghost-CLI-layout Ghost image.
// The served launcher, run in it as `self-update`, starts this release's
// manager, which finds no metadata and that layout, and does the following:
//
//   1. Works out everything, changing nothing: the project's name, as Compose
//      and the running containers have it, so volumes and certificates stay
//      the site's; the Ghost version that runs, and the `next` image of
//      exactly it; the new `.env`, `ghost.env` and routes, resolved by Compose
//      with the operator's overrides and loaded by Caddy. Anything it cannot
//      carry over stops it here, saying what to resolve.
//   2. Keeps a copy of every file it will write, stops Ghost (and
//      ActivityPub), writes the release's files and the site's own, and takes
//      a checked backup of the databases and content.
//   3. Starts the site on the new layout and verifies it.
//
// Recovery follows self-update's (docs/architecture.md#recovery): before
// startup is attempted the old files are put back and Ghost started again as
// it was; after, the services are stopped, the old files put back, and the
// data left as it is, for the operator.
//
// Completion is recorded by what it writes: the metadata. A site with it is
// never migrated again, so a second run is an ordinary self-update.
import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { refuseMovedData, siteOverrides, takeBackup } from './backup.ts';
import { renderRoutes, SITE_FILE } from './caddy.ts';
import { freeOnHost } from './commands/install.ts';
import { releaseOf, type ManagerRelease, type Requested } from './commands/common.ts';
import {
    compose,
    composeConfig,
    composeError,
    composeVariables,
    upAndWait,
    type ComposeInputs,
} from './compose.ts';
import { documentedVariables, findingErrors, validate } from './config.ts';
import type { Context } from './context.ts';
import { inspectImage, runOnce } from './docker/client.ts';
import * as env from './env.ts';
import { CliError, describeError, EXIT } from './errors.ts';
import { atomicWrite, PRIVATE, readIfExists } from './fs.ts';
import { MINIMUM_IMPORT_VERSION, resolveExactGhost, type ResolvedGhost } from './ghost.ts';
import type { Io } from './io.ts';
import {
    GLOBAL_FILE,
    KEPT_CADDYFILE,
    LEGACY_CADDYFILE,
    carryCaddyfile,
    fillEnvironment,
    LEGACY_SNIPPETS,
} from './legacy/caddy.ts';
import {
    readLegacyEnv,
    refuseInterpolated,
    splitLegacyEnv,
    type SplitEnv,
} from './legacy/config.ts';
import { acquireLock } from './lock.ts';
import { isoSeconds, SCHEMA_VERSION, writeMetadata, type Metadata } from './meta.ts';
import {
    LAUNCHER,
    launcherContent,
    managerPin,
    payloadFiles,
    sha256,
    stackDir,
} from './payload.ts';
import { takenPorts } from './ports.ts';
import { git } from './process.ts';
import { describeServices, runningServices, Snapshot, stopServices } from './recovery.ts';
import { observeSite, resolveConfig, resolveSite, type ResolvedSite } from './resolved.ts';
import { heading, ok, printChecks } from './report.ts';
import {
    COMPOSE_FILE,
    ENV_EXAMPLE_FILE,
    ENV_FILE,
    GHOST_ENV_FILE,
    hostOf,
    META_FILE,
    OPERATOR_FILES,
    readSettings,
    siteFacts,
    splitProfiles,
    UPDATE_DIR,
    type SiteFacts,
    type SiteSettings,
} from './site.ts';
import { verifySite } from './verify.ts';
import { atLeast } from './versions.ts';
import { WriterPause } from './writers.ts';

export const MIGRATION = '0001-compose-profiles';
const FROM = 'the released main layout';

/** How long pulling the release's images may take. */
const PULL_MS = 30 * 60 * 1000;
/** The optional profiles `main` had. */
const MAIN_PROFILES = ['analytics', 'activitypub'];
const HOSTED_ACTIVITYPUB = 'https://ap.ghost.org';
/** Where preflight stages the new `.env` and Caddy files, inside the site so the daemon sees them. */
const STAGED = 'staged';

/**
 * A site with no metadata whose `.env` is `main`'s: a DOMAIN, and none of the
 * settings every site of this layout has.
 */
export const isReleasedMainLayout = (settings: SiteSettings): boolean =>
    settings.get('DOMAIN') !== undefined &&
    settings.get('URL') === undefined &&
    settings.get('SITE_MODE') === undefined;

function refuse(message: string): never {
    throw new CliError(`${message}\n  Nothing has been changed.`);
}

/** Everything decided before the first change. */
interface Plan {
    readonly io: Io;
    readonly dir: string;
    readonly release: ManagerRelease;
    /** The manager image the site's launcher is pinned to. */
    readonly pin: string;
    readonly project: string;
    readonly profiles: string[];
    readonly domain: string;
    readonly adminDomain: string;
    readonly ghost: ResolvedGhost;
    /** The services running before the migration, which it stops and may start again. */
    readonly running: string[];
    readonly stack: string;
    /** The release's files, relative to the stack. */
    readonly files: string[];
    readonly env: string;
    readonly ghostEnv: string;
    readonly split: SplitEnv;
    readonly routes: string;
    readonly global: string | null;
    /** main's snippets, by name, for LEGACY_SNIPPETS. */
    readonly snippets: Readonly<Record<string, string>>;
    readonly hadCaddyfile: boolean;
    /** Overrides other than compose.override.yml, relative to the site. */
    readonly overrides: string[];
    readonly port: number;
}

/**
 * `self-update` in a site of the released main layout. Returns the exit
 * status, or throws a CliError.
 */
export async function migrateReleasedMain(
    io: Io,
    context: Context,
    site: SiteFacts,
    requested: Requested,
    check: boolean,
): Promise<number> {
    const dir = site.dir;
    io.stdout(
        `${dir} is an installation of ${FROM}, with no ${META_FILE}.\n` +
            `Moving it onto this release's layout (migration ${MIGRATION}).\n`,
    );
    if (context.source !== 'image') {
        refuse(
            'this manager was built from a checkout, and the migration writes the release’s files\n' +
                '  from a published manager image. Run the served launcher in the site directory:\n' +
                '    curl -fsSL https://docker.ghost.org/install.sh | bash -s -- self-update',
        );
    }
    if (existsSync(join(dir, UPDATE_DIR))) {
        refuse(
            `${join(dir, UPDATE_DIR)} is left from a migration or update that did not finish, and holds\n` +
                '  the files it would have put back. Once the site is as it should be, remove it and run this again.',
        );
    }

    const staged = join(dir, UPDATE_DIR, STAGED);
    let plan: Plan;
    try {
        plan = await prepare(io, context, site, requested, staged);
    } finally {
        rmSync(join(dir, UPDATE_DIR), { recursive: true, force: true });
    }
    if (check) {
        return report(plan);
    }
    const lock = acquireLock(dir, `migration ${MIGRATION} from ${FROM}`);
    try {
        return await apply(plan);
    } finally {
        lock.release();
    }
}

// --- Working it out --------------------------------------------------------------

async function prepare(
    io: Io,
    context: Context,
    site: SiteFacts,
    requested: Requested,
    staged: string,
): Promise<Plan> {
    const dir = site.dir;
    const release = releaseOf(requested, io.env);
    const text = readFileSync(join(dir, ENV_FILE), 'utf8');
    const legacy = readLegacyEnv(text);
    const old = legacy.values;
    if (old.COMPOSE_FILE !== undefined) {
        refuse(
            '.env sets COMPOSE_FILE, which the manager does not use: it names Compose files itself.\n' +
                '  Remove it, and name any extra file with GD_COMPOSE_OVERRIDES when you run this again\n' +
                '  (docs/configuration.md#the-compose-invocation-contract).',
        );
    }
    const domain = (old.DOMAIN ?? '').toLowerCase();
    const adminDomain = (old.ADMIN_DOMAIN ?? '').toLowerCase();
    for (const [key, value] of [
        ['DOMAIN', domain],
        ['ADMIN_DOMAIN', adminDomain],
    ] as const) {
        if ((key === 'DOMAIN' || value !== '') && hostOf(`https://${value}/`) !== value) {
            refuse(`.env's ${key} is ${JSON.stringify(value)}, which is not a domain.`);
        }
    }
    const oldProfiles = splitProfiles(old.COMPOSE_PROFILES ?? '');
    const unknown = oldProfiles.filter((profile) => !MAIN_PROFILES.includes(profile));
    if (unknown.length > 0) {
        refuse(
            `COMPOSE_PROFILES in .env names ${unknown.join(', ')}; ${FROM} had only ${MAIN_PROFILES.join(' and ')}.`,
        );
    }
    for (const key of ['DATABASE_PASSWORD', 'DATABASE_ROOT_PASSWORD']) {
        if (!old[key]) {
            refuse(`.env has no ${key}, which ${FROM} required.`);
        }
    }

    heading(io, `Checking the installation`);
    const stack = stackDir(io.env);
    const files = payloadFiles(stack);
    await refuseEditedStack(io, dir, files);
    ok(io, 'stack files', 'unedited, so the release’s replace them');

    // The old layout, as Compose resolves it with the operator's overrides:
    // the project's name, and what Ghost received.
    const before = await io.busy('Resolving the Compose project', () => resolveSite(io, dir));
    const project = before.project;
    const oldConfig = await composeConfig(io, dir);
    const oldVariables = await composeVariables(io, dir);
    if (project === '' || !oldConfig.ok || oldVariables === null) {
        refuse(
            'Compose cannot resolve the installation as it is: check it with docker compose config.',
        );
    }
    const received = Object.fromEntries(
        Object.entries(oldConfig.project.services.ghost?.environment ?? {}).map(([key, value]) => [
            key,
            value ?? '',
        ]),
    );
    const overrides = siteOverrides(before);
    ok(io, 'project', `${project}, kept, with its volumes and Caddy’s certificates`);

    const containers = await observeSite(io, before);
    const running = containers
        .filter((each) => each.state === 'running')
        .map((each) => each.service);
    const ghostContainer = containers.find(
        (each) => each.service === 'ghost' && each.state === 'running',
    );
    if (ghostContainer === undefined || !running.includes('db')) {
        refuse(
            'Ghost and its database must be running, so the version Ghost runs can be kept and its data\n' +
                '  backed up. Start the site as it is (docker compose up -d), then run this again.',
        );
    }
    const image = await inspectImage(io.docker, ghostContainer.imageId);
    const version = image?.env.GHOST_VERSION;
    if (!image?.repoDigests.some((digest) => digest.startsWith('ghost@')) || !version) {
        refuse(
            `Ghost runs ${ghostContainer.image}, which is not the official ghost image, so there is no image of\n` +
                '  this layout to move it to. Run the official image (remove the override that changes it).',
        );
    }
    if (!atLeast(version, MINIMUM_IMPORT_VERSION)) {
        refuse(
            `this site runs Ghost ${version}, and this layout's images start at Ghost ${MINIMUM_IMPORT_VERSION}.\n` +
                '  A migration never changes Ghost. Upgrade it on the layout it runs now, then run this again:\n' +
                '    docker compose pull ghost && docker compose up -d',
        );
    }
    ok(io, 'ghost', `${version}, running`);

    heading(io, 'Resolving the images');
    const ghost = await io.busy(`Resolving the image of Ghost ${version}`, () =>
        resolveExactGhost(io, version),
    );
    ok(
        io,
        'ghost',
        `${ghost.image}:${ghost.tag}, ${ghost.reference}: the same version, this layout's image`,
    );
    const pin = await io.busy('Resolving the manager image', () => managerPin(io, context));

    // Ghost was not published on main; here it is, on the loopback interface.
    const port = await freeOnHost(
        io,
        (await takenPorts(io)).published,
        Number(old.GHOST_PORT) > 0 ? Number(old.GHOST_PORT) : undefined,
    );
    const profiles = ['production', ...oldProfiles];
    const generated: [string, string][] = [
        ['COMPOSE_PROFILES', profiles.join(',')],
        ['SITE_MODE', 'production'],
        ['COMPOSE_PROJECT_NAME', project],
        ['PROJECT_DIR', dir],
        ['NODE_ENV', 'production'],
        ['URL', `https://${domain}`],
        ...(adminDomain ? [['ADMIN_URL', `https://${adminDomain}`] as [string, string]] : []),
        ['GHOST_IMAGE', ghost.image],
        ['GHOST_VERSION', ghost.tag],
        ['GHOST_IMAGE_REF', ghost.reference],
        ['GHOST_CONTENT_PATH', ghost.contentPath],
        ['GHOST_TINYBIRD_PATH', ghost.tinybirdPath],
        ['GHOST_PORT', String(port)],
        ['RESTART_POLICY', 'unless-stopped'],
        ['HTTP_PORT', old.HTTP_PORT || '80'],
        ['HTTPS_PORT', old.HTTPS_PORT || '443'],
        ['DATABASE_HOST', 'db'],
        ['DATABASE_PORT', '3306'],
        ['DATABASE_NAME', 'ghost'],
        ['DATABASE_USER', old.DATABASE_USER || 'ghost'],
        ['DATABASE_PASSWORD', old.DATABASE_PASSWORD!],
        ['DATABASE_ROOT_PASSWORD', old.DATABASE_ROOT_PASSWORD!],
        ['DATABASE_EXTRA_DATABASES', 'activitypub'],
        ['UPLOAD_LOCATION', old.UPLOAD_LOCATION || './data/ghost'],
        ['MYSQL_DATA_LOCATION', old.MYSQL_DATA_LOCATION || './data/mysql'],
    ];

    // The new layout, as Compose would resolve it with these settings and the
    // operator's overrides, staged where Compose and the daemon can read it.
    mkdirSync(staged, { recursive: true, mode: 0o700 });
    const inputs: ComposeInputs = {
        files: [join(stack, COMPOSE_FILE), ...before.files.slice(1)],
        envFile: join(staged, ENV_FILE),
    };
    atomicWrite(inputs.envFile, env.serializeAll(generated), PRIVATE);
    const draft = await composeConfig(io, dir, inputs);
    const newVariables = await composeVariables(io, dir, inputs);
    if (!draft.ok || newVariables === null) {
        refuse(
            `Compose cannot resolve this release's layout with the site's settings and overrides:\n  ${draft.ok ? 'its variables could not be listed' : draft.reason}`,
        );
    }
    const documented = new Set([
        ...documentedVariables(readIfExists(join(dir, ENV_EXAMPLE_FILE)) ?? ''),
        ...documentedVariables(readFileSync(join(stack, ENV_EXAMPLE_FILE), 'utf8')),
    ]);
    const isOperatorKey = (key: string) =>
        key.startsWith('COMPOSE_') ||
        oldVariables.has(key) ||
        newVariables.has(key) ||
        documented.has(key);
    refuseInterpolated(text, new Set(legacy.keys.filter(isOperatorKey)));
    const split = splitLegacyEnv({
        legacy,
        generated: new Set(generated.map(([key]) => key)),
        isOperatorKey,
        isInterpolated: (key) => newVariables.has(key),
        container: new Set(Object.keys(draft.project.services.ghost?.environment ?? {})),
        received,
    });
    const envText = env.serializeAll(
        [...generated, ...split.operator],
        `# Site settings, moved from ${FROM} by migration ${MIGRATION}. See .env.example\n` +
            '# for the optional ones. Write values with ./ghost-docker config set .env KEY VALUE,\n' +
            '# which encodes them for Compose. Ghost’s own configuration is in ghost.env.\n',
    );
    atomicWrite(inputs.envFile, envText, PRIVATE);
    const ghostEnv = env.serializeAll(
        split.ghost,
        `# Ghost application settings for ${project}, moved from .env by migration\n` +
            `# ${MIGRATION}; see ghost.env.example. Write values with ./ghost-docker config set\n` +
            '# ghost.env KEY VALUE, which encodes them for Compose.\n\n',
    );

    const after = await resolveConfig(io, dir, inputs);
    if (after.services.ghost?.image !== ghost.reference) {
        refuse(
            `with the site's overrides, the ghost service would run ${after.services.ghost?.image ?? 'nothing'}, not\n` +
                `  ${ghost.reference}. Remove the override that sets its image, then run this again.`,
        );
    }
    const draftSite = siteFacts(dir, {
        get: (key) => env.toRecord(envText)[key],
    });
    try {
        refuseMovedData(draftSite, after);
    } catch (error) {
        refuse(
            `${(error as Error).message.replace(/ Nothing has been changed\.$/, '')}\n` +
                '  The migration backs the site up first, and a backup handles data only in ./data.',
        );
    }
    ok(io, 'configuration', `.env and ghost.env for a production site, resolved by Compose`);

    // The routes, loaded by the Caddy image the site will run. ActivityPub
    // goes where main sent it, which with the profile on was still the hosted
    // service unless ACTIVITYPUB_TARGET said otherwise: moving it would move
    // the site's followers.
    const values = {
        domain,
        adminDomain,
        activitypub: old.ACTIVITYPUB_TARGET || HOSTED_ACTIVITYPUB,
    };
    const original = readIfExists(join(dir, LEGACY_CADDYFILE));
    let routes: string;
    let global: string | null = null;
    // main's snippets, read before the release replaces them; git has shown them unedited.
    const snippets: Record<string, string> = {};
    if (original === undefined) {
        routes = renderRoutes({
            project,
            domain,
            adminDomain,
            email: '',
            activitypub: /^(?:https?:\/\/)?activitypub:8080$/.test(values.activitypub),
        });
    } else {
        ({ site: routes, global } = carryCaddyfile(original, values));
        const kept = join(dir, 'caddy', 'snippets');
        for (const name of existsSync(kept) ? readdirSync(kept) : []) {
            snippets[name] = fillEnvironment(readFileSync(join(kept, name), 'utf8'), values);
        }
    }
    await validateRoutes(io, staged, stack, after, routes, global, snippets);
    ok(
        io,
        SITE_FILE,
        original === undefined
            ? 'written: there was no caddy/Caddyfile'
            : 'carried over from caddy/Caddyfile, and loaded by Caddy',
    );

    return {
        io,
        dir,
        release,
        pin,
        project,
        profiles,
        domain,
        adminDomain,
        ghost,
        running: [...new Set(running)],
        stack,
        files,
        env: envText,
        ghostEnv,
        split,
        routes,
        global,
        snippets,
        hadCaddyfile: original !== undefined,
        overrides,
        port,
    };
}

/**
 * The release replaces every stack file `main` tracked, so one the operator
 * changed would be lost. Git, which installed the site, says which they are:
 * changed in the work tree, or by a commit no remote has.
 */
async function refuseEditedStack(io: Io, dir: string, files: readonly string[]): Promise<void> {
    const top = await git(io, dir, ['rev-parse', '--show-toplevel']);
    if (!top.ok || top.stdout.trim() !== dir) {
        refuse(
            `${dir} is not a git checkout. ${FROM} is installed with git clone, and without its history it\n` +
                '  cannot be told whether compose.yml or the Caddy snippets were edited, which the release replaces.',
        );
    }
    const tracked = await git(io, dir, ['ls-files', '--', ...files]);
    const paths = tracked.stdout.split('\n').filter(Boolean);
    if (!tracked.ok || paths.length === 0) {
        refuse(
            'git does not list the stack’s files in this checkout, so it is not one of ' +
                FROM +
                '.',
        );
    }
    const status = await git(io, dir, [
        'status',
        '--porcelain',
        '--untracked-files=no',
        '--',
        ...paths,
    ]);
    const remotes = await git(io, dir, ['for-each-ref', '--format=%(refname)', 'refs/remotes']);
    if (!status.ok || !remotes.ok) {
        refuse(`git cannot read the checkout: ${status.stderr || remotes.stderr}`);
    }
    if (remotes.stdout.trim() === '') {
        refuse(
            'the checkout has no remote-tracking branches, so its own commits cannot be told apart from\n' +
                '  released ones. Fetch from https://github.com/TryGhost/ghost-docker.git, then run this again.',
        );
    }
    const local = await git(io, dir, [
        'log',
        '--format=',
        '--name-only',
        'HEAD',
        '--not',
        '--remotes',
        '--',
        ...paths,
    ]);
    const edited = [
        ...new Set([
            ...status.stdout
                .split('\n')
                .filter((line) => line.trim() !== '')
                .map((line) => line.slice(3)),
            ...local.stdout.split('\n').filter(Boolean),
        ]),
    ].sort();
    if (edited.length > 0) {
        refuse(
            `these files of the stack were changed here, and the release replaces them:\n` +
                edited.map((file) => `    ${file}\n`).join('') +
                '  Move each change into compose.override.yml (Compose) or a .caddy file of your own\n' +
                '  (docs/caddy.md) once the site is migrated, put the files back (git checkout -- <file>),\n' +
                '  and run this again.',
        );
    }
}

/**
 * The routes as the stack's Caddyfile imports them, loaded by `caddy
 * validate` in the image the site will run, with no network. What it refuses,
 * a reload would too.
 */
async function validateRoutes(
    io: Io,
    staged: string,
    stack: string,
    after: ResolvedSite,
    routes: string,
    global: string | null,
    snippets: Readonly<Record<string, string>>,
): Promise<void> {
    const caddy = join(staged, 'caddy');
    cpSync(join(stack, 'caddy'), caddy, { recursive: true });
    atomicWrite(join(staged, SITE_FILE), routes, 0o644);
    writeSnippets(staged, snippets);
    if (global !== null) {
        atomicWrite(join(staged, GLOBAL_FILE), global, 0o644);
    }
    const image = after.services.caddy?.image;
    if (!image) {
        refuse('Compose resolves no caddy service for the production layout.');
    }
    const pulled = await io.busy(
        'Pulling the release’s images, while the site keeps running',
        () =>
            compose(io, {
                dir: after.dir,
                inputs: { files: after.files, envFile: join(staged, ENV_FILE) },
                timeout: PULL_MS,
            })`pull --quiet --ignore-buildable`,
    );
    if (pulled.exitCode !== 0) {
        refuse(`the release's images could not be pulled: ${composeError(pulled)}`);
    }
    const validated = await io.busy('Loading the routes in Caddy', () =>
        runOnce(io.docker, {
            image,
            entrypoint: ['caddy'],
            cmd: ['validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
            binds: [{ source: caddy, target: '/etc/caddy', readOnly: true }],
            network: 'none',
        }),
    );
    if (validated.status !== 0) {
        const said = (validated.stderr || validated.stdout).trim().split('\n').slice(-6);
        refuse(
            'Caddy does not load the routes carried over from caddy/Caddyfile:\n' +
                said.map((line) => `    ${line}\n`).join('') +
                '  They are carried as written, with DOMAIN, ADMIN_DOMAIN and ACTIVITYPUB_TARGET filled in\n' +
                "  and main's snippets kept beside them. Change caddy/Caddyfile so they load, then run\n" +
                '  this again.',
        );
    }
}

/** main's snippets beside the carried routes, which import them. */
function writeSnippets(root: string, snippets: Readonly<Record<string, string>>): void {
    for (const [name, content] of Object.entries(snippets)) {
        mkdirSync(join(root, LEGACY_SNIPPETS), { recursive: true, mode: 0o755 });
        atomicWrite(join(root, LEGACY_SNIPPETS, name), content, 0o644);
    }
}

// --- --check -----------------------------------------------------------------------

function report(plan: Plan): number {
    const { io, split } = plan;
    io.stdout(
        [
            '',
            `The migration would move this site onto ${describeRelease(plan.release)}, and change nothing else:`,
            `  Ghost        ${plan.ghost.version}, from the image of this layout: ${plan.ghost.reference}`,
            `  Project      ${plan.project} (${plan.profiles.join(',')}), its volumes kept`,
            `  .env         operator settings; ${split.operator.length} carried besides the generated ones`,
            `  ghost.env    ${split.ghost.length} Ghost settings, from .env`,
            ...split.dropped.map(
                ({ key, reason }) => `               ${key} not carried: ${reason}`,
            ),
            `  Routes       ${SITE_FILE}${plan.hadCaddyfile ? ', from caddy/Caddyfile, kept as caddy/Caddyfile.local' : ''}`,
            `  Loopback     Ghost published on 127.0.0.1:${plan.port}`,
            `  Launcher     ./${LAUNCHER}, pinned to ${plan.pin}`,
            '',
            'Ghost would be stopped for a backup, then the site started on the new layout.',
            '',
        ].join('\n'),
    );
    return EXIT.ok;
}

const describeRelease = (release: ManagerRelease): string =>
    release.version ?? 'this manager’s release';

// --- Changing it -------------------------------------------------------------------

/** Every path the migration writes, relative to the site: what its snapshot holds. */
function touched(plan: Plan): string[] {
    return [
        ...new Set([...OPERATOR_FILES, ...plan.overrides, ...plan.files, LAUNCHER, KEPT_CADDYFILE]),
    ];
}

async function apply(plan: Plan): Promise<number> {
    const { io, dir } = plan;
    heading(io, 'Keeping the current files');
    const snapshot = new Snapshot(dir, touched(plan));
    snapshot.take();
    ok(io, UPDATE_DIR, `.env, the Caddyfile, and the files the migration writes`);

    const pause = new WriterPause(io, dir, 'the migration');
    let servicesChanged = false;
    let backup: string | null = null;
    try {
        heading(io, 'Stopping Ghost');
        await pause.stop(plan.running);

        heading(io, 'Writing the new layout');
        const metadata = write(plan);

        const findings = await io.busy('Validating the configuration', () => validate(io, dir));
        const errors = findingErrors(findings);
        if (errors) {
            throw new CliError(`the migrated configuration does not validate:\n${errors}`);
        }
        ok(io, 'configuration', 'valid');

        heading(io, 'Backing up the site');
        backup = await takeBackup({
            io,
            site: siteFacts(dir, readSettings(dir)!),
            metadata,
            consistent: true,
            pause,
            migrating: true,
        });
        ok(io, 'backup', `${relative(dir, backup)}, checked`);

        heading(io, 'Starting the site');
        const pull = await io.busy(
            'Pulling the images this release names',
            () => compose(io, { dir, timeout: PULL_MS })`pull --quiet --ignore-buildable`,
        );
        if (pull.exitCode !== 0) {
            throw new CliError(`the images could not be pulled: ${composeError(pull)}`);
        }
        // Set before attempting up: even a failed start may migrate data or accept writes.
        servicesChanged = true;
        pause.end();
        await upAndWait(io, dir, 'Starting the services and waiting for them to be healthy');
        ok(io, 'services', 'healthy, by their own health checks');

        await verifySite(io, dir);
    } catch (error) {
        return recover(plan, snapshot, pause, backup, servicesChanged, error);
    }
    snapshot.remove();
    summarize(plan, backup!);
    return EXIT.ok;
}

/** The release's files, the site's own, and the metadata, written last. */
function write(plan: Plan): Metadata {
    const { io, dir, stack, files } = plan;
    const checksums: Record<string, string> = {};

    if (plan.hadCaddyfile) {
        copyFileSync(join(dir, LEGACY_CADDYFILE), join(dir, KEPT_CADDYFILE));
        ok(io, KEPT_CADDYFILE, 'your caddy/Caddyfile, kept for reference');
    }
    for (const file of files) {
        const source = join(stack, file);
        const target = join(dir, file);
        const content = readFileSync(source);
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        atomicWrite(target, content, statSync(source).mode & 0o777);
        checksums[file] = sha256(content);
    }
    ok(io, 'stack files', `${files.length} files of ${describeRelease(plan.release)}`);
    const launcher = launcherContent(io.env, { image: plan.pin, channel: plan.release.channel });
    atomicWrite(join(dir, LAUNCHER), launcher, 0o755);
    checksums[LAUNCHER] = sha256(launcher);
    ok(io, LAUNCHER, `the launcher, pinned to ${plan.pin}`);

    atomicWrite(join(dir, ENV_FILE), plan.env, PRIVATE);
    ok(io, ENV_FILE, 'operator settings, with the same credentials and project');
    atomicWrite(join(dir, GHOST_ENV_FILE), plan.ghostEnv, PRIVATE);
    ok(io, GHOST_ENV_FILE, `${plan.split.ghost.length} Ghost settings, moved from .env`);
    for (const { key, reason } of plan.split.dropped) {
        printChecks(io, [{ status: 'note', label: 'not carried', detail: `${key}: ${reason}` }]);
    }
    atomicWrite(join(dir, SITE_FILE), plan.routes, 0o644);
    writeSnippets(dir, plan.snippets);
    if (plan.global !== null) {
        atomicWrite(join(dir, GLOBAL_FILE), plan.global, 0o644);
    }
    ok(io, SITE_FILE, 'the site’s routes; yours to edit');

    const metadata: Metadata = {
        schemaVersion: SCHEMA_VERSION,
        installedAt: isoSeconds(),
        updatedAt: null,
        mode: 'production',
        channel: plan.release.channel,
        source: 'image',
        stack: {
            version: plan.release.version,
            ref: plan.release.version,
            image: plan.pin,
            previous: null,
        },
        site: {
            project: plan.project,
            dir,
            url: `https://${plan.domain}`,
            domain: plan.domain,
            adminDomain: plan.adminDomain || null,
        },
        ghost: {
            image: plan.ghost.image,
            tag: plan.ghost.tag,
            version: plan.ghost.version,
            digest: plan.ghost.digest,
        },
        profiles: plan.profiles,
        payload: checksums,
    };
    writeMetadata(dir, metadata);
    ok(io, META_FILE, `installation metadata: migration ${MIGRATION} is done once this is written`);
    return metadata;
}

/** Before startup: the old files back, Ghost started again. After: the operator decides. */
async function recover(
    plan: Plan,
    snapshot: Snapshot,
    pause: WriterPause,
    backup: string | null,
    servicesChanged: boolean,
    error: unknown,
): Promise<number> {
    const { io, dir } = plan;
    io.stderr(`\n${describeError(error)}\n`);
    io.stderr(`\nThe migration did not complete. Putting ${FROM}'s files back\n`);
    const problems: string[] = [];
    if (servicesChanged) {
        const stopped = await stopServices(io, dir, 'Stopping the migrated site');
        if (stopped.error !== null) {
            problems.push(`the services could not be stopped: ${stopped.error}`);
        }
    }
    if (problems.length === 0) {
        try {
            snapshot.restore();
        } catch (restoreError) {
            problems.push(`the files could not be put back: ${(restoreError as Error).message}`);
        }
    }
    const resumed = [...pause.paused];
    if (problems.length === 0 && !servicesChanged) {
        try {
            await pause.resume();
        } catch (resumeError) {
            problems.push((resumeError as Error).message);
        }
    }

    const kept =
        backup === null
            ? []
            : [`The backup taken for the migration is kept in ${relative(dir, backup)}.`];
    if (servicesChanged || problems.length > 0) {
        const running = await runningServices(io, dir);
        const filesBack = problems.length === 0;
        io.stderr(
            [
                '',
                'The site needs you.',
                ...problems.map((problem) => `  ${problem}`),
                ...(servicesChanged
                    ? [
                          'The new layout’s services started before the migration failed, and Ghost may have accepted',
                          `writes since the backup. Nothing was loaded over them. Ghost ${plan.ghost.version} ran on the data`,
                          'either way: the migration never changes Ghost’s version.',
                      ]
                    : []),
                describeServices(running),
                ...(filesBack ? [`The files are ${FROM}'s again.`] : []),
                '',
                ...(filesBack
                    ? [
                          'Start the site as it was, on its data as it is: docker compose up -d',
                          ...(backup === null
                              ? []
                              : [
                                    `The databases and content as they were before the migration started anything are in`,
                                    `${relative(dir, backup)} (checked). Once the cause is fixed and the migration has run,`,
                                    `./ghost-docker restore --yes ${relative(dir, backup)} puts them back.`,
                                ]),
                      ]
                    : kept),
                '',
                `The files as they were before the migration are in ${snapshot.root}/files.`,
                `Once the site is as it should be, remove ${snapshot.root}.`,
                '',
            ].join('\n'),
        );
        throw new CliError('the migration failed, and the site needs the operator.');
    }
    snapshot.remove();
    io.stderr(
        [
            '',
            `Restored: the site is on ${FROM} again, with its files as they were` +
                (resumed.length > 0
                    ? `. ${resumed.join(' and ')}, stopped for the migration, ${resumed.length > 1 ? 'are' : 'is'} running again.`
                    : '.'),
            ...kept,
            '',
        ].join('\n'),
    );
    throw new CliError(`the migration failed; ${FROM} was restored.`);
}

function summarize(plan: Plan, backup: string): void {
    const { io, dir } = plan;
    io.stdout(
        [
            '',
            `Moved from ${FROM} to ${describeRelease(plan.release)}.`,
            '',
            `  Site         https://${plan.domain}`,
            `  Ghost        ${plan.ghost.version}, ${plan.ghost.reference}, the same version`,
            `  Project      ${plan.project} (${plan.profiles.join(',')})`,
            `  Loopback     127.0.0.1:${plan.port}`,
            `  Backup       ${relative(dir, backup)}, of the site before it started on the new layout`,
            '',
            'From now on:',
            '  - Update the stack with ./ghost-docker self-update, never git pull: this directory',
            '    is now installed from the manager image, and its stack files are the release’s.',
            '  - Ghost’s own settings are in ghost.env; .env holds the rest.',
            `  - The routes are in ${SITE_FILE}${plan.hadCaddyfile ? `; your old Caddyfile is ${KEPT_CADDYFILE}` : ''}.`,
            ...(plan.global === null ? [] : [`  - Its global options are in ${GLOBAL_FILE}.`]),
            '',
        ].join('\n'),
    );
}
