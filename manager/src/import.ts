// Importing a staged bundle into a new site: its configuration, its content
// and its database. The order and the policy are install's; these are the
// steps. The contract is docs/bundle-v1.md and the sequence §2.4 of
// docs/ghost-cli-replacement.md.
//
// The database is always loaded as the site's own MySQL user, never as root,
// so whatever a dump contains can affect nothing but that site's database.
import { createReadStream, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import type { BundleManifest } from './bundle/manifest.ts';
import { BundleRefused, removeStaging, stageBundle, type StagedBundle } from './bundle/stage.ts';
import { compose, composeConfig, composeError, type ComposeResult } from './compose.ts';
import { operatorKeyTest } from './config.ts';
import * as env from './env.ts';
import { CliError, UsageError } from './errors.ts';
import { atomicWrite, readIfExists } from './fs.ts';
import type { Io } from './io.ts';
import { printChecks } from './report.ts';
import { DATA_DIRS, ENV_FILE } from './site.ts';

/** Present from the first change an import makes until it has been verified. */
export const MARKER = '.ghost-docker-import';

/**
 * What `.env` selects while an import is in progress: no service, so plain
 * `docker compose up` in a directory whose import was interrupted starts
 * nothing. The import's own Compose runs pass the real profiles.
 */
export const INCOMPLETE_PROFILE = 'import-incomplete';

// --- Configuration ------------------------------------------------------------

/**
 * Ghost configuration the container owns ("Keys the importer omits" in
 * docs/bundle-v1.md). The keys compose.yml sets on the ghost service are
 * added to these at run time, from the resolved configuration, so the two
 * lists cannot drift apart.
 */
const OWNED_KEYS = ['url', 'admin__url', 'process', 'logging__transports', 'logging__path'];
const OWNED_PREFIXES = ['database__', 'server__', 'paths__'];

export function isContainerOwned(key: string, container: ReadonlySet<string>): boolean {
    return (
        container.has(key) ||
        OWNED_KEYS.some((owned) => key === owned || key.startsWith(`${owned}__`)) ||
        OWNED_PREFIXES.some((prefix) => key.startsWith(prefix))
    );
}

export interface CarriedConfig {
    /** What ghost.env receives, raw; the encoder writes it. */
    readonly settings: [string, string][];
    /** Keys left out, with why. Names only: values may be credentials. */
    readonly skipped: { key: string; reason: string }[];
}

/** The bundle's Ghost configuration, without what ghost.env must not hold. */
export function carriedConfig(
    manifest: BundleManifest,
    container: ReadonlySet<string>,
    isOperatorKey: (key: string) => boolean,
): CarriedConfig {
    const settings: [string, string][] = [];
    const skipped: { key: string; reason: string }[] = [];
    for (const [key, value] of Object.entries(manifest.config)) {
        if (!env.isValidKey(key)) {
            skipped.push({ key, reason: 'not a valid setting name' });
        } else if (isContainerOwned(key, container)) {
            skipped.push({ key, reason: 'set by the container' });
        } else if (isOperatorKey(key)) {
            skipped.push({ key, reason: 'an operator setting, not Ghost configuration' });
        } else {
            settings.push([key, value]);
        }
    }
    return { settings, skipped };
}

// --- Content ------------------------------------------------------------------

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

// --- The database -------------------------------------------------------------

/**
 * The mysql client inside the db container, as the site's database user and
 * against the site's database only. The password reaches the client through
 * the container's own environment, not an argument.
 */
const CLIENT =
    'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql --default-character-set=utf8mb4 -h 127.0.0.1 -u"$MYSQL_USER" "$@" "$MYSQL_DATABASE"';

export interface Mysql {
    /** Runs SQL from `input` as the site's user. */
    run: (
        input: string | Readable,
        args?: readonly string[],
        timeoutMs?: number,
    ) => Promise<ComposeResult>;
}

/** The site's database, through Compose with the profiles given. */
export const siteMysql = (io: Io, dir: string, profiles: string): Mysql => ({
    run: (input, args = [], timeoutMs = 60_000) =>
        compose(io, dir, ['exec', '-T', 'db', 'sh', '-c', CLIENT, 'mysql', ...args], {
            env: { COMPOSE_PROFILES: profiles },
            input,
            timeoutMs,
        }),
});

/** `--batch --skip-column-names`: tab-separated rows, nothing else. */
export const BATCH = ['--batch', '--skip-column-names'] as const;

/** One query counting the rows of every table, by name. Names are validated by the schema. */
export const rowCountQuery = (tables: readonly string[]): string =>
    `${tables.map((table) => `SELECT '${table}', COUNT(*) FROM \`${table}\``).join(' UNION ALL ')};\n`;

/**
 * Each table whose count in the database differs from the bundle's record,
 * as a sentence. `output` is the batch output of rowCountQuery.
 */
export function rowMismatches(
    expected: Readonly<Record<string, number>>,
    output: string,
): string[] {
    const actual = new Map<string, number>();
    for (const line of output.split('\n')) {
        const [table, count] = line.split('\t');
        if (table && count !== undefined && /^\d+$/.test(count.trim())) {
            actual.set(table, Number(count.trim()));
        }
    }
    return Object.entries(expected)
        .filter(([table, count]) => actual.get(table) !== count)
        .map(
            ([table, count]) =>
                `${table}: the bundle records ${count} rows, the database has ${actual.get(table) ?? 'none'}`,
        );
}

/**
 * mysqldump records who defined each view and trigger (`DEFINER=`), and only
 * an account with SET_USER_ID may create an object on another's behalf. The
 * load runs as the site's own user precisely so that it has no such
 * privilege, so these clauses are dropped and the objects belong to the
 * site's user, which is the account Ghost connects as. Only mysqldump's own
 * version-comment lines are rewritten:
 *
 *   /*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER *\/         (views)
 *   /*!50003 CREATE*\/ /*!50017 DEFINER=`root`@`%`*\/ /*!50003 TRIGGER ... (triggers)
 *
 * Row data never starts a line that way, and nothing else is changed.
 */
export function dropDefiner(line: string): string {
    if (/^\/\*!\d{5} DEFINER=/.test(line)) {
        return line.replace(/^(\/\*!\d{5}) DEFINER=`[^`]*`@`[^`]*`/, '$1');
    }
    if (/^\/\*!\d{5} CREATE\*\//.test(line)) {
        return line.replace(/\/\*!\d{5} DEFINER=`[^`]*`@`[^`]*`\*\/ ?/, '');
    }
    return line;
}

const SLASH = 0x2f;
const STAR = 0x2a;
const BANG = 0x21;
const NEWLINE = 0x0a;

/**
 * dropDefiner over a stream, byte for byte everywhere else. Only lines that
 * start `/*!` are held whole and rewritten; every other line, however long
 * (an extended INSERT can be megabytes), passes straight through.
 */
export class DefinerFilter extends Transform {
    /** The start of the current line while it is undecided or held. */
    private held: Buffer[] = [];
    private heldLength = 0;
    private state: 'start' | 'pass' | 'hold' = 'start';

    override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
        let at = 0;
        while (at < chunk.length) {
            if (this.state === 'pass') {
                const end = chunk.indexOf(NEWLINE, at);
                if (end < 0) {
                    this.push(chunk.subarray(at));
                    break;
                }
                this.push(chunk.subarray(at, end + 1));
                at = end + 1;
                this.state = 'start';
                continue;
            }
            if (this.state === 'start') {
                // Up to three bytes decide it: `/*!` is held, anything else passes.
                const take = Math.min(3 - this.heldLength, chunk.length - at);
                const piece = chunk.subarray(at, at + take);
                const newline = piece.indexOf(NEWLINE);
                if (newline >= 0) {
                    this.hold(piece.subarray(0, newline + 1));
                    this.flush();
                    at += newline + 1;
                    continue;
                }
                this.hold(piece);
                at += take;
                if (this.heldLength < 3) {
                    continue;
                }
                const start = Buffer.concat(this.held);
                if (start[0] === SLASH && start[1] === STAR && start[2] === BANG) {
                    this.state = 'hold';
                } else {
                    this.flush();
                    this.state = 'pass';
                }
                continue;
            }
            const end = chunk.indexOf(NEWLINE, at);
            if (end < 0) {
                this.hold(chunk.subarray(at));
                break;
            }
            this.hold(chunk.subarray(at, end + 1));
            at = end + 1;
            this.rewrite();
            this.state = 'start';
        }
        done();
    }

    override _flush(done: TransformCallback): void {
        if (this.state === 'hold') {
            this.rewrite();
        } else {
            this.flush();
        }
        done();
    }

    private hold(piece: Buffer): void {
        this.held.push(piece);
        this.heldLength += piece.length;
    }

    private flush(): void {
        if (this.heldLength > 0) {
            this.push(Buffer.concat(this.held));
        }
        this.held = [];
        this.heldLength = 0;
    }

    /** latin1 maps each byte to one character and back, so nothing else changes. */
    private rewrite(): void {
        this.held = [
            Buffer.from(dropDefiner(Buffer.concat(this.held).toString('latin1')), 'latin1'),
        ];
        this.flush();
    }
}

/** database.sql as the client reads it: as it is, or for a dump, without DEFINER clauses. */
export function databaseInput(root: string, manifest: BundleManifest): Readable {
    const file = createReadStream(join(root, manifest.database.path));
    if (manifest.kind !== 'mysql-dump') {
        return file;
    }
    const filter = new DefinerFilter();
    file.on('error', (error) => filter.destroy(error));
    return file.pipe(filter);
}

// --- The steps, as install takes them ------------------------------------------

const say = (io: Io, label: string, detail: string) =>
    printChecks(io, [{ status: 'ok', label, detail }]);

/** Options that cannot be combined with --import in this release. */
export function refuseImportOptions(flags: {
    import?: string;
    domain?: string;
    adminDomain?: string;
    email?: string;
    with?: string;
}): void {
    if (flags.import === '') {
        throw new UsageError('--import needs the path of a migration bundle');
    }
    for (const [option, value] of [
        ['--domain', flags.domain],
        ['--admin-domain', flags.adminDomain],
        ['--email', flags.email],
    ] as const) {
        if (value !== undefined) {
            throw new UsageError(
                `${option} cannot be combined with --import: this release imports local sites.\n` +
                    '  Production import and cutover come in a later release (plan step S5e).',
            );
        }
    }
    if (flags.with !== undefined) {
        throw new UsageError(
            '--with cannot be combined with --import. Import the site first, then enable\n' +
                '  optional services; see docs/configuration.md.',
        );
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

/**
 * The bundle's configuration for ghost.env. What the container owns is read
 * from the resolved Compose configuration, which needs `.env` in place.
 */
export async function sourceConfig(
    io: Io,
    dir: string,
    manifest: BundleManifest,
): Promise<CarriedConfig> {
    const resolved = await composeConfig(io, dir);
    if (!resolved.ok) {
        throw new CliError(
            `the Compose configuration could not be resolved to see what the container sets: ${resolved.reason}`,
        );
    }
    const container = new Set(Object.keys(resolved.project.services.ghost?.environment ?? {}));
    return carriedConfig(manifest, container, operatorKeyTest(dir));
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

    const mysql = siteMysql(io, dir, profiles);
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
        const tables = await mysql.run(
            'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE();\n',
            BATCH,
        );
        if (tables.exitCode !== 0) {
            throw new CliError(`the database could not be queried: ${composeError(tables)}`);
        }
        if (tables.stdout.trim() !== '0') {
            throw new CliError(
                `the database already holds ${tables.stdout.trim()} tables; refusing to load a dump over them`,
            );
        }
    }

    // A file that cannot be read must fail the load, never feed it half a dump.
    const input = databaseInput(root, manifest);
    let unreadable: Error | null = null;
    input.on('error', (error) => {
        unreadable ??= error;
    });
    const load = await io.busy('Loading the database', () => mysql.run(input, [], LOAD_MS));
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
        const tables = Object.keys(manifest.database.rows);
        const counted = await mysql.run(rowCountQuery(tables), BATCH);
        if (counted.exitCode !== 0) {
            throw new CliError(`the loaded tables could not be counted: ${composeError(counted)}`);
        }
        const mismatches = rowMismatches(manifest.database.rows, counted.stdout);
        if (mismatches.length > 0) {
            throw new CliError(
                `the loaded database does not match the bundle's recorded row counts:\n${mismatches.map((line) => `  ${line}`).join('\n')}`,
            );
        }
        say(io, 'rows', `every count matches the bundle (${tables.length} tables)`);
    } else {
        // A dump has no counts to compare; it has to be a Ghost database at all.
        const history = await mysql.run('SELECT COUNT(*) FROM `migrations`;\n', BATCH);
        if (history.exitCode !== 0 || !/^[1-9]\d*$/.test(history.stdout.trim())) {
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
