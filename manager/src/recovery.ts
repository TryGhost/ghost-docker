// What an operation that replaces a site's data needs when it fails, shared by
// restore, self-update and (when they land) Ghost upgrades and the supervisor
// (plan §2.5):
//
//   - the services stopped, so nothing writes to data about to be put back,
//     and their state as Compose observes it, never as assumed;
//   - the site's data and files set aside one boundary at a time, so what the
//     operator is told refers only to copies that exist, and nothing is ever
//     removed on the strength of a step that did not complete;
//   - a backup's content and databases loaded into the site.
//
// Each caller decides what its outcome is; none of this resumes an operation
// that was killed.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as tar from 'tar';
import { asRoot, removeAsRoot } from './asroot.ts';
import type { BackupManifest } from './backup/manifest.ts';
import { ALL_PROFILES, composeDown, composeError, composePs, composeUp } from './compose.ts';
import type { Context } from './context.ts';
import { CliError } from './errors.ts';
import { copyPresent } from './fs.ts';
import { checkRows, loadFile } from './import/database.ts';
import type { Io } from './io.ts';
import { ok } from './report.ts';
import { DATA_DIRS, readSettings } from './site.ts';

// --- The services -----------------------------------------------------------------

/** The site's services that are running, as Compose sees them; null when it cannot say. */
export async function runningServices(io: Io, dir: string): Promise<string[] | null> {
    const services = await composePs(io, dir, ALL_PROFILES);
    if (services === null) {
        return null;
    }
    const running = services
        .filter((service) => service.State === 'running' || service.State === 'restarting')
        .map((service) => service.Service);
    return [...new Set(running)].sort();
}

export interface Stopped {
    /** Compose's own words when `down` failed; null when it succeeded. */
    readonly error: string | null;
    /** What is still running afterwards, observed. */
    readonly running: string[] | null;
}

/** Every service of every profile stopped, then what is still running, observed. */
export async function stopServices(
    io: Io,
    dir: string,
    spinner = 'Stopping the site',
): Promise<Stopped> {
    const down = await io.busy(spinner, () => composeDown(io, dir, { profiles: ALL_PROFILES }));
    return {
        error: down.exitCode === 0 ? null : composeError(down, 2) || 'docker compose down failed',
        running: await runningServices(io, dir),
    };
}

/** A sentence for the operator about the services, from what was observed. */
export function describeServices(running: string[] | null): string {
    if (running === null) {
        return 'Whether its services are running could not be read; see docker compose ps.';
    }
    if (running.length === 0) {
        return 'Its services are stopped.';
    }
    return `These of its services are still running: ${running.join(', ')}.`;
}

// --- Setting a site aside -------------------------------------------------------

/**
 * A site's data and files moved into `name`, a directory in the site, and
 * what of it has been done: each data directory as it is moved, each file
 * as it is copied and then as its original is removed. Data belongs to the
 * containers' users, so it is moved as root (asroot.ts).
 */
export class SetAside {
    /** Relative to the site. */
    readonly name: string;
    readonly root: string;
    /** Data directories moved into `name/data/`, relative to the site. */
    readonly data: string[] = [];
    /** Files and directories copied into `name/files/`, relative to the site. */
    readonly copied: string[] = [];
    /** Of those, the ones removed from the site. */
    readonly removed: string[] = [];

    private readonly io: Io;
    private readonly context: Context;
    private readonly dir: string;

    constructor(io: Io, context: Context, dir: string, name: string) {
        this.io = io;
        this.context = context;
        this.dir = dir;
        this.name = name;
        this.root = join(dir, name);
    }

    /** Where a data directory is kept once moved. */
    keptData(path: string): string {
        return join(this.root, 'data', basename(path));
    }

    /** Each data directory that exists, moved aside one at a time. */
    async moveData(paths: readonly string[] = DATA_DIRS): Promise<void> {
        const present = paths.filter((path) => existsSync(join(this.dir, path)));
        mkdirSync(join(this.root, 'data'), { recursive: true, mode: 0o700 });
        if (present.length > 0 && this.context.image === null) {
            throw new CliError(
                'the launcher did not say which image this is, so the data cannot be moved aside',
            );
        }
        for (const path of present) {
            const moved = await this.io.busy(`Moving ${path} aside`, () =>
                asRoot(
                    this.io,
                    this.context.image!,
                    this.dir,
                    ['mv', '--'],
                    [path, `${this.name}/data/`],
                ),
            );
            // Recorded by where it is now, whatever mv answered.
            if (existsSync(this.keptData(path)) && !existsSync(join(this.dir, path))) {
                this.data.push(path);
            }
            if (moved.status !== 0 || !this.data.includes(path)) {
                throw new CliError(
                    `${path} could not be moved aside: ${(moved.stderr || moved.stdout).trim() || `mv exited ${moved.status}`}`,
                );
            }
        }
    }

    /** The files copied aside, then removed from the site. */
    keepFiles(paths: readonly string[]): void {
        mkdirSync(join(this.root, 'files'), { recursive: true, mode: 0o700 });
        this.copied.push(...copyPresent(this.dir, paths, join(this.root, 'files')));
        for (const path of this.copied) {
            rmSync(join(this.dir, path), { recursive: true, force: true });
            this.removed.push(path);
        }
    }

    /**
     * Before anything was written in their place: what was moved, moved
     * back, and the directory removed. Returns what could not be.
     */
    async putBack(): Promise<string[]> {
        const problems: string[] = [];
        for (const path of [...this.data].reverse()) {
            const back = await asRoot(
                this.io,
                this.context.image!,
                this.dir,
                ['mv', '--'],
                [`${this.name}/data/${basename(path)}`, `${dirname(path)}/`],
            );
            if (existsSync(join(this.dir, path)) && !existsSync(this.keptData(path))) {
                this.data.splice(this.data.indexOf(path), 1);
            } else {
                problems.push(
                    `${path} could not be moved back: ${(back.stderr || back.stdout).trim() || `mv exited ${back.status}`}`,
                );
            }
        }
        // Taken out, and put back each one that is not copied back.
        for (const path of this.removed.splice(0)) {
            try {
                cpSync(join(this.root, 'files', path), join(this.dir, path), {
                    recursive: true,
                    preserveTimestamps: true,
                });
            } catch (error) {
                this.removed.push(path);
                problems.push(`${path} could not be copied back: ${(error as Error).message}`);
            }
        }
        if (problems.length === 0) {
            await this.remove();
        }
        return problems;
    }

    /** The directory removed, as root; a warning when it could not be. */
    async remove(): Promise<string | null> {
        await removeAsRoot(this.io, this.context.image, this.dir, [this.name]);
        return existsSync(this.root)
            ? `${this.root} could not be removed; remove it with sudo (MySQL owns part of it)`
            : null;
    }

    /**
     * The steps that put the site back, in the site directory, naming only
     * copies that are there now. `replaced` says the operation wrote in
     * their place, so what it wrote is removed first; otherwise nothing is.
     */
    instructions(replaced: boolean): string[] {
        const data = this.data.filter((path) => existsSync(this.keptData(path)));
        const files = this.removed.filter((path) => existsSync(join(this.root, 'files', path)));
        const steps: string[] = ['docker compose down'];
        for (const path of data) {
            const back = `sudo mv ${this.name}/data/${basename(path)} ${path}`;
            steps.push(replaced ? `sudo rm -rf ${path} && ${back}` : back);
        }
        if (files.length > 0) {
            steps.push(`cp -a ${this.name}/files/. .`);
        }
        steps.push('docker compose up -d, then ./ghost-docker check', `sudo rm -rf ${this.name}`);
        return [
            ...(data.length > 0 ? [`  data/    ${data.join(' and ')}, as they were`] : []),
            ...(files.length > 0
                ? [`  files/   ${files.length} of its files: configuration, metadata, stack files`]
                : []),
            'To put it back, in the site directory:',
            ...steps.map((step, index) => `  ${index + 1}. ${step}`),
        ];
    }
}

// --- A backup's data ------------------------------------------------------------

/**
 * A backup's content and databases, into a site whose data directories have
 * been set aside: the content unpacked, a fresh MySQL started (its first
 * start creates the site's databases and user), and each dump loaded as that
 * user and its rows counted against the manifest.
 */
export async function loadBackupData(
    io: Io,
    root: string,
    dir: string,
    manifest: BackupManifest,
): Promise<void> {
    for (const data of DATA_DIRS) {
        mkdirSync(join(dir, data), { recursive: true, mode: 0o755 });
    }
    const content = join(dir, DATA_DIRS[0]);
    await io.busy(`Unpacking the content into ${DATA_DIRS[0]}`, () =>
        tar.x({
            file: join(root, manifest.content.file),
            cwd: content,
            strict: true,
            preserveOwner: false,
        }),
    );
    ok(io, 'content', `${manifest.content.entries} entries in ${DATA_DIRS[0]}`);

    const db = await io.busy('Starting a new database', () => composeUp(io, dir, ['db']));
    if (db.exitCode !== 0) {
        throw new CliError(`the database did not become ready: ${composeError(db)}`);
    }
    const profiles = readSettings(dir)?.get('COMPOSE_PROFILES') ?? '';
    for (const database of manifest.databases) {
        const load = await loadFile(
            io,
            dir,
            { profiles, database: database.name },
            {
                root,
                file: database.file,
                filter: true,
                spinner: `Loading the ${database.name} database`,
            },
        );
        if (load.exitCode !== 0) {
            throw new CliError(
                `the ${database.name} database could not be loaded. MySQL said:\n  ${composeError(load, 4).replaceAll('\n', '\n  ')}`,
            );
        }
        const tables = Object.keys(database.tables);
        if (tables.length > 0) {
            await checkRows(
                io,
                dir,
                {
                    profiles,
                    database: database.name,
                    failure: `the ${database.name} database's tables could not be counted`,
                },
                database.tables,
                'the backup',
                `the loaded ${database.name} database does not match the backup`,
            );
        }
        ok(
            io,
            database.name,
            `loaded; every table's rows match the backup (${tables.length} tables)`,
        );
    }
}
