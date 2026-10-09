// Taking a backup of a site, and reading one back (plan §2.5).
//
// A backup is a directory under backups/ in the site:
//
//   manifest.json          what it holds, the exact images, a checksum of each file
//   database/<name>.sql    a mysqldump of each of the site's databases, as its own user
//   content.tar.gz         the content directory
//   site/...               .env, ghost.env, the metadata, the Caddy files, the
//                          Compose overrides and, in image mode, the stack files
//                          and the launcher the site ran
//
// What it records of the site is what Compose resolves from every file the
// site runs with, and what the daemon runs (resolved.ts): the data mounts an
// override may have moved, the overrides GD_COMPOSE_OVERRIDES adds, and the
// exact image each running service runs, beside the one configured.
//
// It is written as backups/.<id>.partial and renamed into place only once it
// has been checked: every dump loaded into a scratch MySQL, and the archive
// listed. A backup directory without `.partial` is a checked one; a failure
// removes the partial, so a dump that fails is an error, not a backup.
//
// Consistency (docs/install.md, "What a backup captures"). By default a
// backup is live, as Ghost-CLI's was: the site keeps running, each dump is
// one consistent snapshot of its database, but the databases and the content
// are captured at different moments, and the manifest says so. A consistent
// backup stops the services that write them (writers.ts) while they are
// captured, so the dumps and the archive are one moment of the site, and
// starts them again before the slower check: the site is down for the
// capture alone. Writers that were not running are not started, and those
// that were run again whether the backup succeeds or fails, unless the
// caller owns the pause: an update keeps them stopped until the site it
// leaves running is verified.
import { createHash } from 'node:crypto';
import {
    chmodSync,
    closeSync,
    createReadStream,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readSync,
    renameSync,
    rmSync,
    statSync,
} from 'node:fs';
import { join, normalize, relative } from 'node:path';
import * as tar from 'tar';
import {
    BACKUP_FORMAT,
    BACKUP_VERSION,
    CONTENT_ARCHIVE,
    DATABASE_DIR,
    DATABASE_NAME,
    MANIFEST_FILE,
    readBackupManifest,
    SITE_FILES_DIR,
    type BackupManifest,
} from './backup/manifest.ts';
import { compose, composeError, composePs, composeUp } from './compose.ts';
import { runOnce } from './docker/client.ts';
import { CliError } from './errors.ts';
import { WriterPause } from './writers.ts';
import { atomicWrite, copyPresent, PRIVATE } from './fs.ts';
import { DATABASE_MS, tableCount, withSiteDatabase } from './import/database.ts';
import type { Io } from './io.ts';
import { isoSeconds, siteFiles, type Metadata } from './meta.ts';
import { git } from './process.ts';
import { ok, printChecks } from './report.ts';
import {
    imageDrift,
    insideSite,
    observeSite,
    resolveSite,
    runningImages,
    type ResolvedSite,
} from './resolved.ts';
import { BACKUPS_DIR, DATA_DIRS, hasProfile, splitProfiles, type SiteFacts } from './site.ts';
import { managerVersion } from './versions.ts';

/** mysqldump's last line, which a dump cut short never has. */
const COMPLETED = '-- Dump completed';

/**
 * mysqldump in the db container, as the site's user, of the database named
 * by DB. One consistent InnoDB snapshot; no tablespaces, GTIDs or routines,
 * which would need privileges the site's user does not have and which Ghost
 * does not use.
 */
const DUMP =
    'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump --default-character-set=utf8mb4 -h 127.0.0.1 -u"$MYSQL_USER" ' +
    '--single-transaction --no-tablespaces --set-gtid-purged=OFF --hex-blob --triggers --skip-routines --skip-events "$DB"';

/**
 * Run in a throwaway container of the site's own MySQL image, with the
 * backup mounted read-only: a scratch server, each dump loaded into it, and
 * then every table's rows counted, as `== <database>` then `<table>\t<rows>`.
 * Nothing touches the site's own server. `mysqld --daemonize` returns once
 * the server accepts connections, as MySQL's own entrypoint starts its
 * temporary one, so nothing polls it.
 */
const CHECK = `set -eu
mysqld --initialize-insecure --user=mysql --datadir=/tmp/check >/tmp/init.log 2>&1 || { tail -n 20 /tmp/init.log >&2; exit 3; }
mysqld --daemonize --user=mysql --datadir=/tmp/check --socket=/tmp/check.sock --pid-file=/tmp/check.pid --log-error=/tmp/mysqld.log --skip-networking --skip-log-bin >/dev/null 2>&1 || { echo 'the scratch MySQL did not start' >&2; tail -n 20 /tmp/mysqld.log >&2; exit 3; }
client() { mysql --socket=/tmp/check.sock -uroot --default-character-set=utf8mb4 "$@"; }
for db in "$@"; do
  client -e "CREATE DATABASE \\\`$db\\\`"
  if ! client "$db" < "/backup/${DATABASE_DIR}/$db.sql"; then echo "the dump of $db does not load" >&2; exit 4; fi
  echo "== $db"
  client -N -B -e "SELECT CONCAT('SELECT ''', table_name, ''', COUNT(*) FROM \\\`', table_name, '\\\`;') FROM information_schema.tables WHERE table_schema = '$db' AND table_type = 'BASE TABLE'" | client -N -B "$db"
done
`;

/**
 * The services that write the site's databases and content: stopped while a
 * consistent backup captures them. Caddy and MySQL itself keep running.
 */
/** `2026-10-09T14-03-22Z`: sortable, and a valid file name everywhere. */
export const backupId = (now: Date): string =>
    now
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
        .replaceAll(':', '-');

/** The databases a site has: Ghost's, and ActivityPub's when that profile is on. */
export function siteDatabases(site: SiteFacts): string[] {
    const profiles = site.settings.get('COMPOSE_PROFILES') ?? '';
    const names = [site.settings.get('DATABASE_NAME') || 'ghost'];
    if (hasProfile(profiles, 'activitypub')) {
        names.push(site.settings.get('ACTIVITYPUB_DATABASE_NAME') || 'activitypub');
    }
    for (const name of names) {
        if (!DATABASE_NAME.test(name)) {
            throw new CliError(
                `the database name ${JSON.stringify(name)} has characters a backup does not handle. Nothing has been changed.`,
            );
        }
    }
    return names;
}

/**
 * The data directories as Compose mounts them, which `.env` and any override
 * decide: install never moves them, and a site whose operator has, or that
 * mounts anything else inside them, is refused rather than half backed up.
 */
export function refuseMovedData(site: SiteFacts, resolved: ResolvedSite): void {
    const content = site.settings.get('GHOST_CONTENT_PATH') || '/home/ghost/content';
    for (const [service, data, target] of [
        ['ghost', DATA_DIRS[0], content],
        ['db', DATA_DIRS[1], '/var/lib/mysql'],
    ] as const) {
        const mounts = resolved.services[service]?.mounts ?? [];
        const mount = mounts.find((each) => each.target === target);
        const expected = join(site.dir, data);
        if (mount === undefined || mount.type !== 'bind' || normalize(mount.source) !== expected) {
            throw new CliError(
                `Compose mounts ${mount === undefined ? 'nothing' : `${mount.source} (${mount.type})`} at ${target} in the ${service} service;\n` +
                    `  backup and restore handle its data only at ./${data}. Nothing has been changed.`,
            );
        }
        const nested = mounts.find((each) => each.target.startsWith(`${target}/`));
        if (nested !== undefined) {
            throw new CliError(
                `Compose mounts ${nested.source} at ${nested.target}, inside ${target} in the ${service} service;\n` +
                    `  a backup of ./${data} would not hold it. Nothing has been changed.`,
            );
        }
    }
}

/**
 * The overrides GD_COMPOSE_OVERRIDES adds, relative to the site, so a backup
 * holds them; one outside the site is refused, since a restore could not
 * bring it back.
 */
export function siteOverrides(resolved: ResolvedSite): string[] {
    return resolved.overrides.map((file) => {
        const inside = insideSite(resolved.dir, file);
        if (inside === null) {
            throw new CliError(
                `GD_COMPOSE_OVERRIDES names ${file}, which is outside the site; a backup could not hold it.\n` +
                    '  Move it into the site directory and name it relative to it. Nothing has been changed.',
            );
        }
        return inside;
    });
}

/** What the site has that a backup cannot hold, for the manifest and the summary. */
function notIncluded(site: SiteFacts): string[] {
    const profiles = site.settings.get('COMPOSE_PROFILES') ?? '';
    const lines: string[] = [];
    if (site.mode === 'production') {
        lines.push(
            "Caddy's certificates and state, which Caddy obtains again when the site starts",
        );
    }
    if (hasProfile(profiles, 'analytics')) {
        lines.push(
            'the Tinybird workspace and the analytics data held outside the site, which are not part of it',
        );
    }
    if (hasProfile(profiles, 'mailpit')) {
        lines.push("Mailpit's inbox (data/mailpit)");
    }
    return lines;
}

/** Every file under `root`, relative to it, in a stable order. */
function filesUnder(root: string, prefix = ''): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
    )) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
            files.push(...filesUnder(root, path));
        } else if (entry.isFile()) {
            files.push(path);
        }
    }
    return files;
}

/** SHA-256 of a file, read as a stream: dumps and archives can be large. */
export async function fileChecksum(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
}

/** Whether a dump ends the way mysqldump ends one it finished. */
function dumpCompleted(path: string): boolean {
    const size = statSync(path).size;
    const length = Math.min(size, 512);
    if (length === 0) {
        return false;
    }
    const tail = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
        readSync(fd, tail, 0, length, size - length);
    } finally {
        closeSync(fd);
    }
    return tail.toString('utf8').includes(COMPLETED);
}

/** The entries of a tar archive, by listing it; it throws on one that does not list. */
export async function archiveEntries(file: string): Promise<number> {
    let entries = 0;
    await tar.t({
        file,
        strict: true,
        onReadEntry: () => {
            entries += 1;
        },
    });
    return entries;
}

/** The scratch load's output: rows per table, per database. */
export function parseCounts(output: string): Map<string, Record<string, number>> {
    const counts = new Map<string, Record<string, number>>();
    let current: Record<string, number> | null = null;
    for (const line of output.split('\n')) {
        const heading = /^== (\S+)$/.exec(line.trim());
        if (heading) {
            current = {};
            counts.set(heading[1]!, current);
            continue;
        }
        const [table, count] = line.split('\t');
        if (current !== null && table && count !== undefined && /^\d+$/.test(count.trim())) {
            current[table] = Number(count.trim());
        }
    }
    return counts;
}

export interface BackupInput {
    readonly io: Io;
    readonly site: SiteFacts;
    readonly metadata: Metadata;
    readonly now?: Date;
    /** Stop the writers for the capture: one moment of the site, at the cost of a brief outage. */
    readonly consistent?: boolean;
    /**
     * For a consistent backup, a pause the caller owns (writers.ts): the
     * writers are stopped through it and left stopped, whether the backup
     * succeeds or fails, for the caller to resume. Without one, the backup
     * resumes them as soon as the capture is done.
     */
    readonly pause?: WriterPause;
}

/** The manager taking the backup, as it was built. */
function thisManager(io: Io): BackupManifest['manager'] {
    const { version, commit } = managerVersion();
    return {
        version: version === 'dev' || version === 'checkout' ? null : version,
        commit: commit || null,
        image: io.env.GD_IMAGE || null,
    };
}

/**
 * The commit a checkout has checked out now, which is what its files are: a
 * restore needs a checkout at the same one. Null, said, when git cannot read it.
 */
async function checkedOut(io: Io, dir: string): Promise<string | null> {
    const head = await git(io, dir, ['rev-parse', '--verify', 'HEAD']);
    if (!head.ok) {
        printChecks(io, [
            {
                status: 'warn',
                label: 'commit',
                detail: `git cannot read the checkout (${head.stderr || 'no answer'}), so the backup does not record its commit`,
            },
        ]);
        return null;
    }
    const commit = head.stdout.trim();
    ok(io, 'commit', `the checkout is at ${commit.slice(0, 12)}`);
    return commit;
}

/**
 * Takes a checked backup, and returns its directory. The caller holds the
 * lock. On a failure, nothing of it is left behind.
 */
export async function takeBackup({
    io,
    site,
    metadata,
    now = new Date(),
    consistent = false,
    pause,
}: BackupInput): Promise<string> {
    const dir = site.dir;
    const databases = siteDatabases(site);
    const profiles = site.settings.get('COMPOSE_PROFILES') ?? '';

    const resolved = await io.busy('Resolving the Compose project', () => resolveSite(io, dir));
    refuseMovedData(site, resolved);
    const overrides = siteOverrides(resolved);
    const images: Record<string, string> = {};
    for (const [service, definition] of Object.entries(resolved.services)) {
        if (definition.image !== null) {
            images[service] = definition.image;
        }
    }
    const dbImage = images.db;
    if (dbImage === undefined) {
        throw new CliError(
            'Compose resolves no db service for this site, so there is no database to back up',
        );
    }

    const root = join(dir, BACKUPS_DIR);
    if (!existsSync(root)) {
        mkdirSync(root, { mode: 0o700 });
    }
    let id = backupId(now);
    for (let n = 2; existsSync(join(root, id)); n += 1) {
        id = `${backupId(now)}-${n}`;
    }
    const partial = join(root, `.${id}.partial`);
    const final = join(root, id);
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { mode: 0o700 });

    let startedDb = false;
    const quiesced = pause ?? new WriterPause(io, dir);
    // Resumed here only when the pause is the backup's own.
    const resume = () => (pause === undefined ? quiesced.resume() : Promise.resolve());
    try {
        io.stdout(`Backing up ${site.dir} to ${final}\n`);

        // The database has to be running to be dumped; one that was not is
        // started for the dump and stopped again afterwards.
        const ps = await composePs(io, dir);
        if (ps === null) {
            throw new CliError('Compose could not say which of the site’s services are running');
        }
        const db = ps.find((service) => service.Service === 'db');
        if (db?.State !== 'running') {
            const up = await io.busy('Starting the database', () => composeUp(io, dir, ['db']));
            startedDb = true;
            if (up.exitCode !== 0) {
                throw new CliError(`the database did not start: ${composeError(up)}`);
            }
        }

        // What runs, exactly: the backup records it beside what is configured,
        // and checks the dumps with the MySQL that wrote them.
        const running = await observeSite(io, resolved);
        const ran = await runningImages(io, running);
        const drift = await imageDrift(io, resolved, running);
        if (drift.length > 0) {
            printChecks(io, [
                {
                    status: 'warn',
                    label: 'images',
                    detail: `${drift.join('; ')}. The backup records both; docker compose up -d applies the configuration`,
                },
            ]);
        }

        const commit = metadata.source === 'checkout' ? await checkedOut(io, dir) : null;

        io.stdout('\nThe capture\n');
        if (!consistent) {
            ok(
                io,
                'live',
                'Ghost and ActivityPub keep running: each database is one snapshot, but the databases and the content are captured at different moments (--consistent stops them for the capture)',
            );
        } else {
            await quiesced.stop(
                ps
                    .filter((service) => service.State === 'running')
                    .map((service) => service.Service),
            );
        }

        io.stdout('\nThe databases\n');
        mkdirSync(join(partial, DATABASE_DIR), { mode: 0o700 });
        const liveTables = new Map<string, number>();
        for (const name of databases) {
            const file = join(partial, DATABASE_DIR, `${name}.sql`);
            const dump = await io.busy(
                `Dumping the ${name} database`,
                () =>
                    compose(io, {
                        dir,
                        output: file,
                        timeout: DATABASE_MS,
                    })`exec -T -e DB=${name} db sh -c ${DUMP}`,
            );
            if (dump.exitCode !== 0) {
                throw new CliError(
                    `the ${name} database could not be dumped. mysqldump said:\n  ${(composeError(dump, 4) || 'nothing').replaceAll('\n', '\n  ')}`,
                );
            }
            if (!existsSync(file) || !dumpCompleted(file)) {
                throw new CliError(
                    `the dump of the ${name} database is incomplete: it does not end the way mysqldump ends a finished dump`,
                );
            }
            chmodSync(file, PRIVATE);
            const tables = await withSiteDatabase(
                io,
                dir,
                {
                    profiles,
                    database: name,
                    failure: `the ${name} database's tables could not be counted`,
                },
                (sql) => tableCount(sql, true),
            );
            if (!Number.isInteger(tables)) {
                throw new CliError(`the ${name} database's tables could not be counted`);
            }
            liveTables.set(name, tables);
            ok(io, name, `dumped, ${(statSync(file).size / 1024 ** 2).toFixed(1)} MB`);
        }

        io.stdout('\nThe content\n');
        const archive = join(partial, CONTENT_ARCHIVE);
        const content = join(dir, DATA_DIRS[0]);
        try {
            await io.busy(`Archiving ${DATA_DIRS[0]}`, () =>
                tar.c({ gzip: true, file: archive, cwd: content, portable: true }, ['.']),
            );
        } catch (error) {
            throw new CliError(
                `${DATA_DIRS[0]} could not be archived: ${(error as Error).message}`,
            );
        }
        chmodSync(archive, PRIVATE);

        io.stdout('\nThe site’s files\n');
        const copied = copyPresent(
            dir,
            [...siteFiles(metadata), ...overrides],
            join(partial, SITE_FILES_DIR),
        ).length;
        ok(
            io,
            SITE_FILES_DIR,
            `${copied} files and directories: configuration, metadata, Caddy${overrides.length > 0 ? `, ${overrides.join(', ')}` : ''}`,
        );

        // Captured: the site runs again before the slower checks, unless the
        // caller keeps it paused.
        await resume();

        io.stdout('\nThe checks\n');
        // Checked means the dump loads: into a scratch server, never the site's.
        const check = await io.busy('Loading the dumps into a scratch MySQL to check them', () =>
            runOnce(io.docker, {
                image: ran.db?.id ?? dbImage,
                entrypoint: ['sh', '-c', CHECK, 'check'],
                cmd: databases,
                binds: [{ source: partial, target: '/backup', readOnly: true }],
                user: '0:0',
                network: 'none',
                timeoutMs: DATABASE_MS,
            }),
        );
        if (check.status !== 0) {
            const said = (check.stderr || check.stdout).trim().split('\n').slice(-6).join('\n  ');
            throw new CliError(
                check.timedOut
                    ? 'checking the dumps did not finish before the deadline'
                    : `the dumps do not load into MySQL, so they are not a backup:\n  ${said || `the check exited ${check.status}`}`,
            );
        }
        const counts = parseCounts(check.stdout);
        const ghostDatabase = databases[0]!;
        const manifestDatabases: BackupManifest['databases'] = [];
        for (const name of databases) {
            const tables = counts.get(name);
            if (tables === undefined) {
                throw new CliError(`checking the dumps reported nothing for the ${name} database`);
            }
            if (Object.keys(tables).length !== liveTables.get(name)) {
                throw new CliError(
                    `the dump of the ${name} database loads ${Object.keys(tables).length} tables, but the database has ${liveTables.get(name)}`,
                );
            }
            if (name === ghostDatabase && (tables.migrations ?? 0) === 0) {
                throw new CliError(
                    `the dump of the ${name} database has no Ghost migration history; it is not a Ghost database`,
                );
            }
            manifestDatabases.push({ name, file: `${DATABASE_DIR}/${name}.sql`, tables });
        }
        ok(
            io,
            'checked',
            databases
                .map((name) => `${name}: ${Object.keys(counts.get(name)!).length} tables`)
                .join(', ') + ', loaded into a scratch MySQL',
        );

        let entries: number;
        try {
            entries = await io.busy('Listing the archive', () => archiveEntries(archive));
        } catch (error) {
            throw new CliError(`the content archive does not list: ${(error as Error).message}`);
        }
        ok(io, CONTENT_ARCHIVE, `${entries} entries, listed`);

        const files: Record<string, string> = {};
        for (const path of filesUnder(partial)) {
            files[path] = await fileChecksum(join(partial, path));
        }
        const manifest: BackupManifest = {
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            createdAt: isoSeconds(now),
            consistency: consistent ? 'quiesced' : 'live',
            manager: thisManager(io),
            site: {
                project: metadata.site.project,
                dir,
                url: metadata.site.url,
                mode: metadata.mode,
                source: metadata.source,
                commit,
                profiles: splitProfiles(profiles),
                overrides,
            },
            images,
            running: ran,
            databases: manifestDatabases,
            content: { file: CONTENT_ARCHIVE, entries },
            files,
            notIncluded: notIncluded(site),
        };
        atomicWrite(
            join(partial, MANIFEST_FILE),
            `${JSON.stringify(manifest, null, 2)}\n`,
            PRIVATE,
        );
        renameSync(partial, final);
        return final;
    } catch (error) {
        rmSync(partial, { recursive: true, force: true });
        throw error;
    } finally {
        // A failure during the capture still leaves the writers as they were.
        try {
            await resume();
        } catch (resumeError) {
            printChecks(io, [
                { status: 'error', label: 'writers', detail: (resumeError as Error).message },
            ]);
        }
        if (startedDb) {
            await compose(io, { dir })`stop db`;
        }
    }
}

// --- Reading a backup -----------------------------------------------------------

/**
 * A backup, read and checked whole: its manifest, every file against its
 * checksum, the archive listed. A backup that fails any of it is refused
 * before a restore changes anything.
 */
export async function readBackup(io: Io, root: string): Promise<BackupManifest> {
    const read = readBackupManifest(root);
    if (read.state === 'refused') {
        throw new CliError(`${read.reason}. Nothing has been changed.`);
    }
    const { manifest } = read;
    const wanted = [manifest.content.file, ...manifest.databases.map((database) => database.file)];
    for (const file of wanted) {
        if (!(file in manifest.files)) {
            throw new CliError(
                `the backup's manifest lists no checksum for ${file}. Nothing has been changed.`,
            );
        }
    }
    await io.busy('Checking every file of the backup against its checksum', async () => {
        for (const [file, checksum] of Object.entries(manifest.files)) {
            const path = join(root, file);
            if (!existsSync(path)) {
                throw new CliError(`the backup is missing ${file}. Nothing has been changed.`);
            }
            if ((await fileChecksum(path)) !== checksum) {
                throw new CliError(
                    `${file} in the backup does not match its checksum: it was changed or damaged. Nothing has been changed.`,
                );
            }
        }
    });
    let entries: number;
    try {
        entries = await io.busy('Listing the content archive', () =>
            archiveEntries(join(root, manifest.content.file)),
        );
    } catch (error) {
        throw new CliError(
            `the backup's content archive does not list: ${(error as Error).message}. Nothing has been changed.`,
        );
    }
    if (entries !== manifest.content.entries) {
        throw new CliError(
            `the backup's content archive lists ${entries} entries, and its manifest records ${manifest.content.entries}. Nothing has been changed.`,
        );
    }
    return manifest;
}

/** The site's files a backup holds, relative to the site. */
export const backupSiteFiles = (manifest: BackupManifest): string[] =>
    Object.keys(manifest.files)
        .filter((file) => file.startsWith(`${SITE_FILES_DIR}/`))
        .map((file) => relative(SITE_FILES_DIR, file));
