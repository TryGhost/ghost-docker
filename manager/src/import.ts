// Importing a staged bundle into a new site: its configuration, its content
// and its database. A portable bundle has none to load: Ghost creates an empty
// one, and its content JSON and members CSV are Ghost Admin's to import. The order and the policy are install's; `Importing` is
// what install calls, at its points, when --import is given. The contract is
// docs/bundle-v1.md and docs/architecture.md#installation-and-import.
//
// The pieces that print nothing and decide no order are in import/:
// config.ts, what ghost.env receives; database.ts, the client, the dump
// filter and the row counts.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { lt } from 'semver';
import { CONTENT_ROOT, type BundleManifest } from './bundle/manifest.ts';
import { BundleRefused, removeStaging, stageBundle, type StagedBundle } from './bundle/stage.ts';
import { isHostname } from './caddy.ts';
import { ServiceUnreachable } from './clients.ts';
import {
    ALL_PROFILES,
    compose,
    composeDown,
    composeError,
    composeStop,
    composeUp,
} from './compose.ts';
import type { Context } from './context.ts';
import * as env from './env.ts';
import { CliError, UsageError } from './errors.ts';
import { atomicWrite, readIfExists } from './fs.ts';
import { MINIMUM_IMPORT_VERSION, resolveExactGhost, type ResolvedGhost } from './ghost.ts';
import { replaceMailTransport, sourceConfig, type CarriedConfig } from './import/config.ts';
import { checkRows, countOf, loadFile, tableCount, withSiteDatabase } from './import/database.ts';
import type { Io } from './io.ts';
import { ok, printChecks } from './report.ts';
import { DATA_DIRS, ENV_FILE, type SiteMode } from './site.ts';
import { Created } from './undo.ts';

/** Present from the first change an import makes until it has been verified. */
export const MARKER = '.ghost-docker-import';

/**
 * What `.env` selects while an import is in progress: no service, so plain
 * `docker compose up` in a directory whose import was interrupted starts
 * nothing. The import's own Compose runs pass the real profiles.
 */
export const INCOMPLETE_PROFILE = 'import-incomplete';

// --- What install calls --------------------------------------------------------

/** Why these options cannot be combined with --import, if they cannot. */
export function importConflict(flags: { with: readonly string[] }): string | null {
    // Mailpit only replaces the mail transport; anything else would change
    // what the imported site is.
    const others = flags.with.filter((service) => service !== 'mailpit');
    if (others.length > 0) {
        return (
            `--with ${others.join(',')} cannot be combined with --import; only mailpit can. Import the\n` +
            '  site first, then enable optional services; see docs/configuration.md.'
        );
    }
    return null;
}

/** Where an imported site is served: its mode, and a production site's domains. */
export interface ImportedAddress {
    readonly mode: SiteMode;
    readonly domain: string;
    readonly adminDomain: string;
}

/**
 * The host a production site is served on, from one of the bundle's URLs.
 * Caddy serves a site over HTTPS on the default port at a domain's root, so a
 * URL it cannot serve as it is, which would change the site's address, is
 * refused; the option names the domain to serve it on instead.
 */
export function servedHost(url: string, field: string, option: string): string {
    const host = hostOf(url);
    const parsed = host === '' ? null : new URL(url);
    const why =
        parsed === null || !isHostname(host)
            ? 'it has no domain name'
            : parsed.protocol !== 'https:'
              ? 'it is plain http, and a production site here is served over HTTPS'
              : parsed.port !== ''
                ? `it has a port, ${parsed.port}, and a production site here is served on 443`
                : parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== ''
                  ? `it has a path, ${parsed.pathname}, and a production site here is served at its domain's root`
                  : parsed.username !== '' || parsed.password !== ''
                    ? 'it has credentials in it'
                    : null;
    if (why === null) {
        return host;
    }
    throw new CliError(
        `the bundle's ${field} is ${url}, which this production site cannot be served at: ${why}.\n` +
            (isHostname(host)
                ? `  Serving it at https://${host} changes its address; to do that, add ${option} ${host}.\n`
                : `  Name the domain to serve it on with ${option}.\n`) +
            '  Nothing has been changed.',
    );
}

/** A URL's host, lowercased; empty for one that does not parse. */
function hostOf(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

/**
 * Everything an unfinished import wrote went into a directory it had verified
 * free, and it never served anything, so nothing in it is worth keeping; but
 * only an import may clear it.
 */
export async function clearUnfinishedImport(
    io: Io,
    context: Context,
    dir: string,
    isImport: boolean,
): Promise<void> {
    const marker = join(dir, MARKER);
    if (!existsSync(marker)) {
        return;
    }
    if (!isImport) {
        throw new CliError(
            `an earlier import into ${dir} did not finish, so it holds a partial site\n` +
                '  that cannot be started. Run the import again, which removes what it left behind first:\n' +
                '    ./ghost-docker install --import BUNDLE',
        );
    }
    io.stdout('Removing what an earlier, unfinished import left behind\n');
    const leftovers = await io.busy('Removing the unfinished import', () =>
        Created.fromJournal(io, context, dir, marker).remove(),
    );
    if (leftovers.length > 0) {
        throw new CliError(
            `some of what the earlier import left could not be removed:\n${leftovers.map((item) => `  ${item}`).join('\n')}`,
        );
    }
}

/**
 * An import, as install takes it. Install calls each of these at its point in
 * the installation and, without --import, none of them.
 */
export class Importing {
    readonly manifest: BundleManifest;

    private readonly io: Io;
    private readonly dir: string;
    private readonly staged: StagedBundle;

    private constructor(io: Io, dir: string, staged: StagedBundle) {
        this.io = io;
        this.dir = dir;
        this.staged = staged;
        this.manifest = staged.manifest;
    }

    /**
     * The bundle, staged and checked. It says what kind of site this is and
     * which Ghost version it runs, so it is read before anything else is
     * decided. A refusal from here until the site is written calls `abandon`.
     */
    static async read(
        io: Io,
        dir: string,
        bundle: string,
        flags: { version?: string },
    ): Promise<Importing> {
        return new Importing(io, dir, await readBundle(io, dir, bundle, flags));
    }

    /** What the summary says was imported. */
    get description(): string {
        return `${this.manifest.kind} bundle of ${this.manifest.url}`;
    }

    /**
     * What is left to the operator. A database bundle brought the staff
     * accounts with it; a portable one is imported through Ghost Admin.
     */
    get nextSteps(): string[] {
        if (this.manifest.kind !== 'portable') {
            return ["Sign in to Ghost Admin with the source site's staff accounts."];
        }
        const [content, members] = [
            this.manifest.database.path,
            this.manifest.database.members,
        ].map(placedAt);
        // A zero-byte members export means the source had no members.
        const hasMembers = statSync(join(this.dir, members!), { throwIfNoEntry: false })?.size;
        return [
            'Open Ghost Admin, create the owner account, then import:',
            `  ${content} in Settings, Import/Export`,
            ...(hasMembers ? [`  ${members} in Members, Import`] : []),
            'and activate the theme in Settings, Design. A portable export carries no',
            'integrations, staff logins or Stripe connection; set those up again.',
        ];
    }

    /** Refused before anything was written: the directory is as it was. */
    abandon(): void {
        removeStaging(this.dir);
    }

    /** An import happens at the source site's version; upgrading is a separate step. */
    resolveGhost(): Promise<ResolvedGhost> {
        return resolveExactGhost(this.io, this.manifest.ghost.version);
    }

    /**
     * The bundle says what kind of site it is. A production site is served on
     * the source's domains unless options name others; a local one takes none.
     * Served on another domain, it is a copy elsewhere, and the source's admin
     * domain is not carried to it: only --admin-domain gives it one.
     */
    address(flags: {
        local: boolean;
        domain?: string;
        adminDomain?: string;
        email?: string;
    }): ImportedAddress {
        const { sourceInstallType, url, adminUrl } = this.manifest;
        if (sourceInstallType === 'local') {
            for (const [option, value] of [
                ['--domain', flags.domain],
                ['--admin-domain', flags.adminDomain],
                ['--email', flags.email],
            ] as const) {
                if (value !== undefined) {
                    throw new UsageError(
                        `${option} applies to production sites, and this bundle is of a local site,\n` +
                            '  which is imported as one.',
                    );
                }
            }
            return { mode: 'local', domain: '', adminDomain: '' };
        }
        if (flags.local) {
            throw new UsageError(
                `--local cannot be combined with this bundle: it is of a production site (${url}),\n` +
                    '  which is imported as one, on its domain or the one --domain names.',
            );
        }
        const domain = flags.domain ?? servedHost(url, 'url', '--domain');
        if (flags.adminDomain !== undefined || !adminUrl) {
            return { mode: 'production', domain, adminDomain: flags.adminDomain ?? '' };
        }
        if (domain !== hostOf(url)) {
            printChecks(this.io, [
                {
                    status: 'warn',
                    label: 'admin domain',
                    detail:
                        `not carried: the source served Ghost Admin at ${adminUrl}, but this site is on\n` +
                        `${domain}, not the source's domain. Ghost Admin is served at https://${domain}/ghost/;\n` +
                        'give --admin-domain for a separate one.',
                },
            ]);
            return { mode: 'production', domain, adminDomain: '' };
        }
        return {
            mode: 'production',
            domain,
            adminDomain: servedHost(adminUrl, 'adminUrl', '--admin-domain'),
        };
    }

    /** From the first change until the site is verified, the marker records what was created. */
    begin(created: Created): void {
        created.journal = join(this.dir, MARKER);
        created.save();
    }

    /**
     * The source site's configuration for ghost.env, without what the
     * container owns. With Mailpit, without the source's mail transport, which
     * Mailpit replaces: a local copy of a site then never sends real mail.
     */
    async ghostEnv(
        mailpit: boolean,
    ): Promise<{ text: string; detail: string; skipped: CarriedConfig['skipped'] }> {
        const { settings, skipped } = replaceMailTransport(
            await sourceConfig(this.io, this.dir, this.manifest),
            mailpit,
        );
        return {
            text:
                settings.length === 0
                    ? ''
                    : env.serializeAll(
                          settings,
                          `# Carried over from ${this.manifest.url} by install --import.\n`,
                      ),
            detail: `${settings.length} Ghost settings carried over from the source site`,
            skipped,
        };
    }

    /** The content and the database, once `.env` and ghost.env are written and valid. */
    load(created: Created, profiles: string, version: string): Promise<void> {
        return importSite(this.io, this.dir, this.staged, profiles, version, () => {
            created.project = true;
            created.save();
        });
    }

    /**
     * With --no-start. The import needed the database, and Ghost once for a
     * rows-only bundle. Nothing is left running; the data stays.
     */
    async stop(): Promise<void> {
        const down = await this.io.busy('Stopping what the import started', () =>
            composeDown(this.io, this.dir),
        );
        if (down.exitCode !== 0) {
            throw new CliError(
                `the services the import started could not be stopped: ${composeError(down, 2)}`,
            );
        }
    }

    /** Verified, or deliberately not started: either way, now a site. */
    finish(created: Created): void {
        removeStaging(this.dir);
        rmSync(join(this.dir, MARKER), { force: true });
        created.journal = null;
    }

    /** Whatever happened, a partial site must not be startable. */
    markIncomplete(): void {
        markIncomplete(this.dir);
    }

    /**
     * With GD_IMPORT_KEEP_FAILED, what a failed import created is kept for
     * inspection rather than removed, but not left running. True when it was
     * kept, and so must not be removed.
     */
    async keptForInspection(created: Created): Promise<boolean> {
        if (this.io.env.GD_IMPORT_KEEP_FAILED !== '1') {
            return false;
        }
        if (created.project) {
            await this.io.busy('Stopping what the import started', () =>
                composeStop(this.io, this.dir, ALL_PROFILES),
            );
        }
        this.io.stderr(
            `\nThe import did not complete. GD_IMPORT_KEEP_FAILED is set, so what it created was\n` +
                `kept for inspection in ${this.dir}. It cannot be started; running the import\n` +
                'again removes it first.\n',
        );
        return true;
    }
}

// --- The steps ------------------------------------------------------------------

/**
 * Moves the staged content tree into the site's content directory, which was
 * verified empty. Staging is in the site directory, so this renames rather
 * than copies; dotfiles travel too. It runs before any container has mounted
 * the directory, and the Ghost image takes ownership of it when it starts.
 */
export function placeContent(root: string, target: string): void {
    const source = join(root, 'content');
    for (const name of readdirSync(source)) {
        renameSync(join(source, name), join(target, name));
    }
}

/**
 * Where a file a portable bundle names ends up, relative to the site: under
 * data/ghost, where the operator picks it up for Ghost Admin. One inside
 * content/ travels with the content; one outside it goes into data/ghost/data.
 */
const placedAt = (file: string): string =>
    file.startsWith(CONTENT_ROOT)
        ? join(DATA_DIRS[0], file.slice(CONTENT_ROOT.length))
        : join(DATA_DIRS[0], 'data', basename(file));

/** Places a portable bundle's content JSON and members CSV; returns where they are. */
export function placeAdminFiles(
    root: string,
    dir: string,
    manifest: Extract<BundleManifest, { kind: 'portable' }>,
): string[] {
    return [manifest.database.path, manifest.database.members].map((file) => {
        if (!file.startsWith(CONTENT_ROOT)) {
            mkdirSync(join(dir, DATA_DIRS[0], 'data'), { recursive: true });
            renameSync(join(root, file), join(dir, placedAt(file)));
        }
        return placedAt(file);
    });
}

/**
 * Stages and validates the bundle, then applies this release's policy to it.
 * A refusal leaves the site directory as it was.
 */
export async function readBundle(
    io: Io,
    dir: string,
    bundle: string,
    flags: { version?: string },
): Promise<StagedBundle> {
    io.stdout('Reading the bundle\n');
    let staged: StagedBundle;
    try {
        staged = await io.busy('Unpacking and checking the bundle', () => stageBundle(dir, bundle));
    } catch (error) {
        if (error instanceof BundleRefused) {
            throw new BundleRefused(
                `${error.message}\n  The bundle was refused. Nothing has been changed.`,
            );
        }
        throw error;
    }
    const { manifest } = staged;
    try {
        // Checked here as well as by the exporter: an earlier Ghost-CLI wrote
        // bundles of any 6.x site.
        if (lt(manifest.ghost.version, MINIMUM_IMPORT_VERSION)) {
            throw new CliError(
                `this bundle was exported from Ghost ${manifest.ghost.version}; importing needs Ghost ${MINIMUM_IMPORT_VERSION} or a later 6.x release.\n` +
                    '  Run `ghost update` in the source installation, check the site works, then run\n' +
                    '  `ghost migrate-export` again. Nothing has been changed.',
            );
        }
        // The exporter writes portable bundles of local SQLite sites only.
        if (manifest.kind === 'portable' && manifest.sourceInstallType !== 'local') {
            throw new CliError(
                `this is a portable bundle of a ${manifest.sourceInstallType} site (${manifest.url}); portable bundles are\n` +
                    '  imported for local sites only. Move this site through Ghost Admin instead: install\n' +
                    "  a new site with --domain, then import the source's content export in Settings,\n" +
                    '  Import/Export and its members CSV in Members, Import. Nothing has been changed.',
            );
        }
        if (
            flags.version !== undefined &&
            flags.version.replace(/^v/, '') !== manifest.ghost.version
        ) {
            throw new UsageError(
                `--version is ${flags.version} but the bundle was exported from Ghost ${manifest.ghost.version}.\n` +
                    '  A site is imported at its source version; upgrade it afterwards.',
            );
        }
    } catch (error) {
        removeStaging(dir);
        throw error;
    }
    ok(
        io,
        manifest.kind,
        `a ${manifest.sourceInstallType} site, Ghost ${manifest.ghost.version}, ${manifest.url}`,
    );
    return staged;
}

/** `.env` selects no service. */
export function markIncomplete(dir: string): void {
    const path = join(dir, ENV_FILE);
    const text = readIfExists(path);
    if (text !== undefined) {
        atomicWrite(path, env.set(text, 'COMPOSE_PROFILES', INCOMPLETE_PROFILE));
    }
}

/**
 * The site's content and database, from the staged bundle. Runs after `.env`
 * and ghost.env are written and validated, and before Ghost is started on the
 * result. `started` is called before the first container is created, so that
 * a failure takes the project down.
 */
export async function importSite(
    io: Io,
    dir: string,
    { root, manifest }: StagedBundle,
    profiles: string,
    version: string,
    started: () => void,
): Promise<void> {
    io.stdout('\nImporting the site\n');
    markIncomplete(dir);

    // Content first, while no container has mounted the directory.
    placeContent(root, join(dir, DATA_DIRS[0]));
    ok(io, 'content', `the bundle's content/ in ${DATA_DIRS[0]}`);

    if (manifest.kind === 'portable') {
        // Ghost creates its own, empty database when it first starts; the
        // content JSON and members CSV are Ghost Admin's to import.
        const files = placeAdminFiles(root, dir, manifest);
        ok(io, 'database', `none to load: Ghost Admin imports ${files.join(' and ')}`);
    } else {
        await importDatabase(io, dir, root, manifest, profiles, version, started);
    }

    // Complete: `.env` selects the site's services again.
    const path = join(dir, ENV_FILE);
    atomicWrite(path, env.set(readIfExists(path) ?? '', 'COMPOSE_PROFILES', profiles));
}

/** A database bundle's database: loaded, then checked against what the bundle records. */
async function importDatabase(
    io: Io,
    dir: string,
    root: string,
    manifest: Exclude<BundleManifest, { kind: 'portable' }>,
    profiles: string,
    version: string,
    started: () => void,
): Promise<void> {
    started();
    const db = await io.busy('Starting the database', () => composeUp(io, dir, ['db'], profiles));
    if (db.exitCode !== 0) {
        throw new CliError(`the database did not become ready: ${composeError(db)}`);
    }
    ok(io, 'database', 'ready');

    if (manifest.kind === 'mysql-data') {
        // Rows only: Ghost creates the schema they are loaded into.
        await io.busy(`Starting Ghost ${version} once to create its schema`, async () => {
            const up = await composeUp(io, dir, ['ghost'], profiles);
            if (up.exitCode !== 0) {
                throw new CliError(
                    `Ghost ${version} did not finish creating its database schema: ${composeError(up)}`,
                );
            }
            // Removed rather than only stopped, so the next start is a clean one.
            const stop = await compose(io, { dir, profiles })`rm --stop --force ghost`;
            if (stop.exitCode !== 0) {
                throw new CliError(`Ghost could not be stopped: ${composeError(stop)}`);
            }
        });
        ok(io, 'schema', `created by Ghost ${version}`);
    } else {
        const tables = await withSiteDatabase(
            io,
            dir,
            { profiles, failure: 'the database could not be queried' },
            (sql) => tableCount(sql),
        );
        if (tables !== 0) {
            throw new CliError(
                `the database already holds ${tables} tables; refusing to load a dump over them`,
            );
        }
    }

    const load = await loadFile(
        io,
        dir,
        { profiles },
        {
            root,
            file: manifest.database.path,
            filter: manifest.kind === 'mysql-dump',
            spinner: 'Loading the database',
        },
    );
    if (load.exitCode !== 0) {
        throw new CliError(
            `the bundle's database could not be loaded. MySQL said:\n  ${composeError(load, 4).replaceAll('\n', '\n  ')}` +
                (manifest.kind === 'mysql-data'
                    ? '\n  Text over 64KB in a column MySQL declares as text is one cause that only the load\n' +
                      '  can find. Such a site moves through Ghost Admin instead: export it with\n' +
                      '  --sqlite-format portable and import that bundle, then follow the steps it gives.'
                    : ''),
        );
    }
    ok(io, 'database', `loaded ${manifest.database.path}`);

    if (manifest.kind === 'mysql-data') {
        const { rows } = manifest.database;
        await checkRows(
            io,
            dir,
            { profiles, failure: 'the loaded tables could not be counted' },
            rows,
            'the bundle',
            "the loaded database does not match the bundle's recorded row counts",
        );
        ok(io, 'rows', `every count matches the bundle (${Object.keys(rows).length} tables)`);
    } else {
        // A dump has no counts to compare; it has to be a Ghost database at all.
        const history = await withSiteDatabase(
            io,
            dir,
            { profiles, failure: 'the loaded database could not be queried' },
            // A query MySQL refuses, such as one of a table that does not
            // exist, is an answer: there is no history.
            (sql) =>
                sql.query('SELECT COUNT(*) FROM `migrations`').then(countOf, (error) => {
                    if (error instanceof ServiceUnreachable && error.stage === 'query') {
                        return Number.NaN;
                    }
                    throw error;
                }),
        );
        if (!(history > 0)) {
            throw new CliError(
                'the loaded database has no Ghost migration history; it does not look like a Ghost database',
            );
        }
        ok(io, 'migrations', 'the database has a Ghost migration history');
    }
}
