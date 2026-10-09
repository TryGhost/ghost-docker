// Importing a staged bundle into a new site: its configuration, its content
// and its database. The order and the policy are install's; `Importing` is
// what install calls, at its points, when --import is given. The contract is
// docs/bundle-v1.md and the sequence §2.4 of docs/ghost-cli-replacement.md.
//
// The pieces that print nothing and decide no order are in import/:
// config.ts, what ghost.env receives; database.ts, the client, the dump
// filter and the row counts.
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BundleManifest } from './bundle/manifest.ts';
import { BundleRefused, removeStaging, stageBundle, type StagedBundle } from './bundle/stage.ts';
import { ServiceUnreachable } from './clients.ts';
import { compose, composeError } from './compose.ts';
import type { Context } from './context.ts';
import * as env from './env.ts';
import { CliError, UsageError } from './errors.ts';
import { atomicWrite, readIfExists } from './fs.ts';
import { resolveExactGhost, type ResolvedGhost } from './ghost.ts';
import { replaceMailTransport, sourceConfig, type CarriedConfig } from './import/config.ts';
import {
    countOf,
    databaseInput,
    loadDatabase,
    rowCounts,
    rowMismatches,
    tableCount,
    withSiteDatabase,
} from './import/database.ts';
import type { Io } from './io.ts';
import { printChecks } from './report.ts';
import { DATA_DIRS, ENV_FILE } from './site.ts';
import { ALL_PROFILES, Created } from './undo.ts';

/** Present from the first change an import makes until it has been verified. */
export const MARKER = '.ghost-docker-import';

/**
 * What `.env` selects while an import is in progress: no service, so plain
 * `docker compose up` in a directory whose import was interrupted starts
 * nothing. The import's own Compose runs pass the real profiles.
 */
export const INCOMPLETE_PROFILE = 'import-incomplete';

// --- What install calls --------------------------------------------------------

/** Why these options cannot be combined with --import in this release, if they cannot. */
export function importConflict(flags: {
    domain?: string;
    adminDomain?: string;
    email?: string;
    with: readonly string[];
}): string | null {
    for (const [option, value] of [
        ['--domain', flags.domain],
        ['--admin-domain', flags.adminDomain],
        ['--email', flags.email],
    ] as const) {
        if (value !== undefined) {
            return (
                `${option} cannot be combined with --import: this release imports local sites.\n` +
                '  Production import and cutover come in a later release (plan step S5e).'
            );
        }
    }
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

    /** Refused before anything was written: the directory is as it was. */
    abandon(): void {
        removeStaging(this.dir);
    }

    /** An import happens at the source site's version; upgrading is a separate step. */
    resolveGhost(): Promise<ResolvedGhost> {
        return resolveExactGhost(this.io, this.manifest.ghost.version);
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
            compose(this.io, this.dir, ['down', '--remove-orphans', '--timeout', '20'], {
                timeoutMs: 300_000,
            }),
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
                compose(this.io, this.dir, ['stop', '--timeout', '20'], {
                    timeoutMs: 300_000,
                    env: { COMPOSE_PROFILES: ALL_PROFILES },
                }),
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

const say = (io: Io, label: string, detail: string) =>
    printChecks(io, [{ status: 'ok', label, detail }]);

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
        if (manifest.sourceInstallType !== 'local') {
            throw new CliError(
                `this bundle is of a ${manifest.sourceInstallType} site (${manifest.url}); this release imports local sites.\n` +
                    '  Production import and cutover come in a later release (plan step S5e). Nothing has been changed.',
            );
        }
        if (manifest.kind === 'portable') {
            throw new CliError(
                `this is a portable bundle: Ghost's content export and a members CSV, which Ghost Admin\n` +
                    '  imports, not this command. To move the site that way:\n' +
                    '    1. ./ghost-docker install --local, and create the owner account;\n' +
                    `    2. in Ghost Admin, import ${manifest.database.path} (Settings, Import/Export)\n` +
                    `       and ${manifest.database.members} (Members, Import);\n` +
                    '    3. copy the bundle’s content/images, content/media, content/files and\n' +
                    '       content/themes into data/ghost.\n' +
                    '  Or export the source site again without --sqlite-format portable, which makes a\n' +
                    '  mysql-data bundle that this command imports completely. Nothing has been changed.',
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
    say(
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

/** How long the database and Ghost may take to become healthy. */
const READY_SECONDS = 600;
/** How long loading a database may take. */
const LOAD_MS = 3 * 60 * 60 * 1000;

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
    const withProfiles = { env: { COMPOSE_PROFILES: profiles } };

    // Content first, while no container has mounted the directory.
    placeContent(root, join(dir, DATA_DIRS[0]));
    say(io, 'content', `the bundle's content/ in ${DATA_DIRS[0]}`);

    started();
    const db = await io.busy('Starting the database', () =>
        compose(
            io,
            dir,
            ['up', '--detach', '--wait', '--wait-timeout', String(READY_SECONDS), 'db'],
            {
                ...withProfiles,
                timeoutMs: (READY_SECONDS + 900) * 1000,
            },
        ),
    );
    if (db.exitCode !== 0) {
        throw new CliError(`the database did not become ready: ${composeError(db)}`);
    }
    say(io, 'database', 'ready');

    if (manifest.kind === 'mysql-data') {
        // Rows only: Ghost creates the schema they are loaded into.
        await io.busy(`Starting Ghost ${version} once to create its schema`, async () => {
            const up = await compose(
                io,
                dir,
                ['up', '--detach', '--wait', '--wait-timeout', String(READY_SECONDS), 'ghost'],
                { ...withProfiles, timeoutMs: (READY_SECONDS + 900) * 1000 },
            );
            if (up.exitCode !== 0) {
                throw new CliError(
                    `Ghost ${version} did not finish creating its database schema: ${composeError(up)}`,
                );
            }
            // Removed rather than only stopped, so the next start is a clean one.
            const stop = await compose(io, dir, ['rm', '--stop', '--force', 'ghost'], {
                ...withProfiles,
                timeoutMs: 120_000,
            });
            if (stop.exitCode !== 0) {
                throw new CliError(`Ghost could not be stopped: ${composeError(stop)}`);
            }
        });
        say(io, 'schema', `created by Ghost ${version}`);
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

    // A file that cannot be read must fail the load, never feed it half a dump.
    const input = databaseInput(root, manifest);
    let unreadable: Error | null = null;
    input.on('error', (error) => {
        unreadable ??= error;
    });
    const load = await io.busy('Loading the database', () =>
        loadDatabase(io, dir, { profiles }, input, LOAD_MS),
    );
    input.destroy();
    if (unreadable !== null) {
        throw new CliError(
            `${manifest.database.path} could not be read: ${(unreadable as Error).message}`,
        );
    }
    if (load.exitCode !== 0) {
        throw new CliError(
            `the bundle's database could not be loaded. MySQL said:\n  ${composeError(load, 4).replaceAll('\n', '\n  ')}` +
                (manifest.kind === 'mysql-data'
                    ? '\n  Text over 64KB in a column MySQL declares as text is one cause that only the load\n' +
                      '  can find. Such a site moves through Ghost Admin instead: export it with\n' +
                      '  --sqlite-format portable and follow what this command says about that bundle.'
                    : ''),
        );
    }
    say(io, 'database', `loaded ${manifest.database.path}`);

    if (manifest.kind === 'mysql-data') {
        const { rows } = manifest.database;
        const counted = await withSiteDatabase(
            io,
            dir,
            { profiles, failure: 'the loaded tables could not be counted' },
            (sql) => rowCounts(sql, Object.keys(rows)),
        );
        const mismatches = rowMismatches(rows, counted);
        if (mismatches.length > 0) {
            throw new CliError(
                `the loaded database does not match the bundle's recorded row counts:\n${mismatches.map((line) => `  ${line}`).join('\n')}`,
            );
        }
        say(io, 'rows', `every count matches the bundle (${Object.keys(rows).length} tables)`);
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
        say(io, 'migrations', 'the database has a Ghost migration history');
    }

    // Complete: `.env` selects the site's services again.
    const path = join(dir, ENV_FILE);
    atomicWrite(path, env.set(readIfExists(path) ?? '', 'COMPOSE_PROFILES', profiles));
}
