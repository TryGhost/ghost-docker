// `self-update`: move a site to this manager's release of the stack (plan §2.7).
//
// The updater is the target release. The site's launcher starts the image
// that --to or --channel names, or by default the newest release on the
// channel the site follows, and this is that image: it runs outside the files
// it replaces. It updates only a site installed from the image: a checkout of
// the repository is the operator's to update with git and Compose, and is
// refused with the steps.
//
// It updates the stack, never Ghost: `.env`, and the exact Ghost image it
// pins, are not touched. `run` takes these parts in order:
//
//   1. Refusals that change nothing: a site without metadata, a checkout, a
//      downgrade, a Ghost older than this release runs. Then the lock.
//   2. A snapshot of the operator's files, the metadata and every managed
//      file this update writes, in UPDATE_DIR. Then a checked
//      backup (backup.ts), because a release's services may migrate their
//      databases, ActivityPub's among them, whether or not Ghost changes.
//   3. The managed files: an untouched one is replaced, an
//      edited one is kept and the release's is written beside it as
//      `<file>.new`. It never asks.
//   4. Validate, pull, `up --wait`, verify as `check` does.
//   5. On a failure, the snapshot is put back. Once the services had been changed, they are
//      stopped first, the data they ran on is set aside, and the backup's
//      databases and content are loaded (recovery.ts) before the previous
//      release is started again. The outcome is reported as restored or as
//      needing the operator. Never success because `up` returned zero.
//   6. On success, the site's launcher is pinned to this image, the metadata
//      records the release, and the snapshot is removed.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { readBackup, refuseDrift, takeBackup } from '../backup.ts';
import { compose, composeConfig, composeError, upAndWait } from '../compose.ts';
import { z } from 'zod';
import { defineCommand, flag } from '../command.ts';
import { findingErrors, validate } from '../config.ts';
import type { Context } from '../context.ts';
import { CliError, describeError, EXIT } from '../errors.ts';
import { atomicWrite, copyPresent } from '../fs.ts';
import type { Io } from '../io.ts';
import { acquireLock } from '../lock.ts';
import { isoSeconds, requireMetadata, siteFiles, writeMetadata, type Metadata } from '../meta.ts';
import {
    LAUNCHER,
    launcherContent,
    managerPin,
    payloadFiles,
    sha256,
    stackDir,
} from '../payload.ts';
import {
    describeServices,
    loadBackupData,
    runningServices,
    SetAside,
    stopServices,
} from '../recovery.ts';
import { compareReleases, isRelease } from '../release.ts';
import { resolveSite } from '../resolved.ts';
import { heading, ok, printChecks } from '../report.ts';
import { META_FILE, UPDATE_DIR, type SiteFacts } from '../site.ts';
import { verifySite } from '../verify.ts';
import { atLeast, MINIMUM } from '../versions.ts';
import {
    channelOption,
    installedSite,
    releaseOf,
    releaseOption,
    requestedRelease,
    type ManagerRelease,
} from './common.ts';

/** How long pulling a release's images may take. */
const PULL_MS = 30 * 60 * 1000;

const options = z
    .object({
        check: flag('Say whether there is an update and what it would change; change nothing.'),
        channel: channelOption(
            'Update to the newest release on this channel, stable or beta, and follow it from now on. Default: the channel the site follows.',
        ),
        to: releaseOption('Update to this release, vX.Y.Z or vX.Y.Z-beta.N.'),
    })
    .refine((flags) => flags.channel === undefined || flags.to === undefined, {
        error: 'choose --channel or --to, not both',
    });

/** Where the edited copy of a site's launcher is kept when the launcher is replaced. */
export const EDITED_LAUNCHER = `${LAUNCHER}.edited`;

/** A release of the stack, as a site runs it. */
interface Stack {
    readonly version: string | null;
    /** The manager image. */
    readonly image: string | null;
}

const describeStack = (stack: Stack): string =>
    stack.version ?? (stack.image ? `the manager image ${stack.image}` : 'an unknown release');

// --- What an update writes ------------------------------------------------------

/** What happens to one managed file. */
type Action =
    /** Not in the site: written. */
    | 'add'
    /** Untouched since it was written: replaced. */
    | 'replace'
    /** Already the release's: nothing to do. */
    | 'same'
    /** Edited, and changed by the release: kept, with the release's beside it as `<file>.new`. */
    | 'keep'
    /** Edited, and not changed by the release: kept, nothing to write. */
    | 'edited'
    /** No longer in the release, and untouched: removed. */
    | 'remove'
    /** No longer in the release, but edited: left alone. */
    | 'leave';

interface FileChange {
    readonly file: string;
    readonly action: Action;
}

interface Payload {
    readonly changes: FileChange[];
    /** The checksums to record: of each file as this release writes it. */
    readonly checksums: Record<string, string>;
}

const checksumOf = (path: string): string | null =>
    existsSync(path) ? sha256(readFileSync(path)) : null;

/**
 * What the update does to each managed file. A file is untouched when its
 * checksum is the one recorded when the manager wrote it.
 */
function planPayload(dir: string, stack: string, recorded: Record<string, string>): Payload {
    const changes: FileChange[] = [];
    const checksums: Record<string, string> = {};
    const files = payloadFiles(stack);
    for (const file of files) {
        const wanted = sha256(readFileSync(join(stack, file)));
        const present = checksumOf(join(dir, file));
        checksums[file] = wanted;
        changes.push({
            file,
            action:
                present === null
                    ? 'add'
                    : present === wanted
                      ? 'same'
                      : present === recorded[file]
                        ? 'replace'
                        : wanted === recorded[file]
                          ? 'edited'
                          : 'keep',
        });
    }
    for (const [file, checksum] of Object.entries(recorded)) {
        if (file === LAUNCHER || files.includes(file)) {
            continue;
        }
        const present = checksumOf(join(dir, file));
        if (present !== null) {
            changes.push({ file, action: present === checksum ? 'remove' : 'leave' });
        }
    }
    return { changes, checksums };
}

const newPath = (file: string) => `${file}.new`;

/**
 * Every path an update may write or remove, relative to the site: what the
 * snapshot holds. The site's own files, as a backup and a restore know them,
 * and what this release adds.
 */
function touched(metadata: Metadata, payload: Payload): string[] {
    const paths: string[] = siteFiles(metadata);
    for (const { file, action } of payload.changes) {
        paths.push(file);
        if (action === 'keep') {
            paths.push(newPath(file));
        }
    }
    paths.push(LAUNCHER, EDITED_LAUNCHER);
    return [...new Set(paths)];
}

function writePayloadChanges(io: Io, dir: string, stack: string, payload: Payload): void {
    for (const { file, action } of payload.changes) {
        const source = join(stack, file);
        const target = join(dir, file);
        switch (action) {
            case 'add':
            case 'replace':
                mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
                atomicWrite(target, readFileSync(source), statSync(source).mode & 0o777);
                break;
            case 'keep':
                atomicWrite(
                    join(dir, newPath(file)),
                    readFileSync(source),
                    statSync(source).mode & 0o777,
                );
                break;
            case 'remove':
                rmSync(target, { force: true });
                break;
            case 'same':
            case 'edited':
            case 'leave':
                break;
        }
    }
    const count = (action: Action) =>
        payload.changes.filter((change) => change.action === action).length;
    ok(
        io,
        'stack files',
        `${count('replace') + count('add')} written, ${count('same')} unchanged, ${count('remove')} removed`,
    );
    for (const { file, action } of payload.changes) {
        if (action === 'keep') {
            printChecks(io, [
                {
                    status: 'note',
                    label: 'kept',
                    detail: `${file} has been edited, so it was kept. This release's version is ${newPath(file)}`,
                },
            ]);
        } else if (action === 'leave') {
            printChecks(io, [
                {
                    status: 'note',
                    label: 'kept',
                    detail: `${file} is no longer part of the stack, but it has been edited, so it was kept`,
                },
            ]);
        }
    }
}

// --- The snapshot ---------------------------------------------------------------

/** Copies of what an update may change, to put back if it fails. */
class Snapshot {
    readonly dir: string;
    readonly root: string;
    readonly paths: string[];

    constructor(dir: string, paths: string[]) {
        this.dir = dir;
        this.root = join(dir, UPDATE_DIR);
        this.paths = paths;
    }

    take(): void {
        mkdirSync(join(this.root, 'files'), { recursive: true, mode: 0o700 });
        copyPresent(this.dir, this.paths, join(this.root, 'files'));
    }

    /** Every path as it was: copied back, or removed when it did not exist. */
    restore(): void {
        for (const path of this.paths) {
            const target = join(this.dir, path);
            const kept = join(this.root, 'files', path);
            rmSync(target, { recursive: true, force: true });
            if (existsSync(kept)) {
                mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
                cpSync(kept, target, { recursive: true, preserveTimestamps: true });
            }
        }
    }

    remove(): void {
        rmSync(this.root, { recursive: true, force: true });
    }
}

// --- Deciding -------------------------------------------------------------------

type Direction = 'newer' | 'current' | 'downgrade';

/** By release number; a site on edge or a dev build may go anywhere. */
function compare(from: Stack, to: Stack): Direction | { unordered: string } {
    if (from.image !== null && from.image === to.image) {
        return 'current';
    }
    if (from.version === null || !isRelease(from.version)) {
        return 'newer';
    }
    if (to.version === null || !isRelease(to.version)) {
        return {
            unordered: `this manager is ${describeStack(to)}, which is not a release, so it cannot be told apart from a downgrade of ${from.version}`,
        };
    }
    const order = compareReleases(to.version, from.version);
    return order > 0 ? 'newer' : order === 0 ? 'current' : 'downgrade';
}

function refuseOldGhost(metadata: Metadata, from: Stack): void {
    if (!atLeast(metadata.ghost.version, MINIMUM.ghost)) {
        throw new CliError(
            `this release of the stack runs Ghost ${MINIMUM.ghost} or later, and this site runs Ghost ${metadata.ghost.version}.\n` +
                '  An update never changes Ghost. Nothing has been changed. Instead:\n' +
                `    1. Upgrade Ghost to ${MINIMUM.ghost} or later on the release this site runs now (${describeStack(from)}).\n` +
                '    2. Run ./ghost-docker self-update again.',
        );
    }
}

// --- The command ------------------------------------------------------------------

interface Update {
    readonly io: Io;
    readonly context: Context;
    readonly site: SiteFacts;
    readonly metadata: Metadata;
    readonly from: Stack;
    readonly to: Stack;
    readonly release: ManagerRelease;
    /** The stack directory, and what happens to each managed file. */
    readonly stack: string;
    readonly payload: Payload;
}

export const selfUpdateCommand = defineCommand({
    brief: 'Update the stack to a newer release: its files and manager, never Ghost. See docs/install.md.',
    options,
    async run(flags, _positionals, io) {
        const requested = requestedRelease(flags.channel, flags.to, '--to');
        const { context, site } = installedSite(io);
        const dir = site.dir;
        const metadata = requireMetadata(dir, 'update cannot tell which files are its own');
        if (metadata.source === 'checkout') {
            throw new CliError(
                'this site is a checkout of the repository, and self-update updates only a site installed\n' +
                    '  from the manager image. Update a checkout with git and Compose, in the site directory:\n' +
                    '    ./ghost-docker backup\n' +
                    '    git fetch --tags && git checkout <release>\n' +
                    '    ./ghost-docker config validate\n' +
                    '    docker compose pull --ignore-buildable\n' +
                    '    docker compose up -d --wait\n' +
                    '    ./ghost-docker check\n' +
                    '  If the site does not come back, check out the commit it ran and restore the backup.\n' +
                    '  Nothing has been changed.',
            );
        }
        if (context.source === 'checkout') {
            throw new CliError(
                'this site was installed from the manager image, and this manager was built from a checkout.\n' +
                    '  Run the site’s own ./ghost-docker self-update. Nothing has been changed.',
            );
        }

        const release = releaseOf(requested, io.env);
        const from: Stack = { version: metadata.stack.version, image: metadata.stack.image };
        const image = await io.busy('Resolving the manager image', () => managerPin(io, context));
        const to: Stack = { version: release.version, image };
        const decided = compare(from, to);
        if (typeof decided === 'object') {
            throw new CliError(`${decided.unordered}. Nothing has been changed.`);
        }

        const stack = stackDir(io.env);
        const payload = planPayload(dir, stack, metadata.payload);
        const update: Update = { io, context, site, metadata, from, to, release, stack, payload };

        if (flags.check) {
            return report(update, decided);
        }
        if (decided === 'current') {
            io.stdout(`This site already runs ${describeStack(to)}. Nothing to update.\n`);
            return EXIT.ok;
        }
        if (decided === 'downgrade') {
            throw new CliError(
                `this site runs ${describeStack(from)}, which is newer than ${describeStack(to)}. An update never\n` +
                    '  moves a site to an older release. Nothing has been changed.',
            );
        }
        refuseOldGhost(metadata, from);
        if (existsSync(join(dir, UPDATE_DIR))) {
            throw new CliError(
                `${join(dir, UPDATE_DIR)} is left from an update that did not finish, and holds the files it\n` +
                    '  would have put back. Once the site is as it should be (./ghost-docker check), remove it\n' +
                    '  and run ./ghost-docker self-update again. Nothing has been changed.',
            );
        }

        // A project another directory owns, or running images its configuration
        // does not name, which the backup an update takes would refuse.
        await refuseDrift(
            io,
            await io.busy('Resolving the Compose project', () => resolveSite(io, dir)),
        );

        const lock = acquireLock(dir, `update to ${describeStack(to)}`);
        try {
            return await apply(update);
        } finally {
            lock.release();
        }
    },
});

/** --check: what an update would do, changing nothing. */
function report({ io, from, to, payload, metadata }: Update, direction: Direction): number {
    io.stdout(`This site runs ${describeStack(from)}. This release is ${describeStack(to)}.\n`);
    if (direction === 'current') {
        io.stdout('It is up to date.\n');
        return EXIT.ok;
    }
    if (direction === 'downgrade') {
        io.stdout('That is older than the site, and update would refuse it.\n');
        return EXIT.ok;
    }
    if (!atLeast(metadata.ghost.version, MINIMUM.ghost)) {
        io.stdout(
            `It runs Ghost ${MINIMUM.ghost} or later, and the site runs Ghost ${metadata.ghost.version}: upgrade Ghost first.\n`,
        );
        return EXIT.ok;
    }
    io.stdout(`An update is available. Ghost stays at ${metadata.ghost.version}.\n`);
    const lines: Record<Action, string> = {
        add: 'added',
        replace: 'replaced',
        same: '',
        edited: '',
        keep: 'edited, kept; the release’s written beside it as .new',
        remove: 'removed from the stack',
        leave: 'removed from the stack, but edited, so kept',
    };
    for (const { file, action } of payload.changes) {
        if (lines[action]) {
            io.stdout(`  ${file}: ${lines[action]}\n`);
        }
    }
    io.stdout(`  ${LAUNCHER}: pinned to ${to.image}\n`);
    return EXIT.ok;
}

/** The stage a failure happened in decides how much has to be put back. */
type Stage = 'backup' | 'write' | 'validate' | 'pull' | 'start' | 'verify' | 'record';

async function apply(update: Update): Promise<number> {
    const { io, site, from, to, stack, payload } = update;
    const dir = site.dir;
    io.stdout(`Updating from ${describeStack(from)} to ${describeStack(to)}\n`);

    heading(io, 'Keeping the current files');
    const snapshot = new Snapshot(dir, touched(update.metadata, payload));
    snapshot.take();
    ok(io, UPDATE_DIR, 'the configuration, the metadata and the files this update writes');

    let stage: Stage = 'backup';
    let backup: string | null = null;
    try {
        heading(io, 'Backing up the site');
        // Consistent: the update restarts the services anyway, and a recovery
        // loads this backup over everything the site wrote.
        backup = await takeBackup({ io, site, metadata: update.metadata, consistent: true });
        ok(io, 'backup', `${relative(dir, backup)}, checked`);

        stage = 'write';
        heading(io, 'Writing the stack');
        writePayloadChanges(io, dir, stack, payload);

        stage = 'validate';
        // validate() only warns when Compose cannot resolve the project; here
        // that is the release failing.
        const resolved = await io.busy('Resolving the Compose project', () =>
            composeConfig(io, dir),
        );
        if (!resolved.ok) {
            throw new CliError(
                `Compose cannot resolve the project with this release: ${resolved.reason}`,
            );
        }
        const findings = await io.busy('Validating the configuration', () => validate(io, dir));
        const errors = findingErrors(findings);
        if (errors) {
            throw new CliError(`the configuration does not validate with this release:\n${errors}`);
        }
        ok(io, 'configuration', 'valid with this release');

        stage = 'pull';
        heading(io, 'Starting the services');
        const pull = await io.busy(
            'Pulling the images this release names',
            () => compose(io, { dir, timeout: PULL_MS })`pull --quiet --ignore-buildable`,
        );
        if (pull.exitCode !== 0) {
            throw new CliError(`the images could not be pulled: ${composeError(pull)}`);
        }

        stage = 'start';
        await upAndWait(io, dir, 'Starting the services and waiting for them to be healthy');
        ok(io, 'services', 'healthy, by their own health checks');

        stage = 'verify';
        await verifySite(io, dir);

        stage = 'record';
        record(update);
    } catch (error) {
        return recover(update, snapshot, backup, stage, error);
    }
    snapshot.remove();
    summarize(update, backup);
    return EXIT.ok;
}

/** The launcher pinned to this image, then the metadata. */
function record({ io, site, metadata, from, to, release, payload }: Update): void {
    const dir = site.dir;
    const checksums = { ...payload.checksums };
    const launcher = join(dir, LAUNCHER);
    const present = checksumOf(launcher);
    if (present !== null && present !== metadata.payload[LAUNCHER]) {
        // It holds the pin, so it is always replaced; an edited one is kept beside it.
        cpSync(launcher, join(dir, EDITED_LAUNCHER));
        printChecks(io, [
            {
                status: 'note',
                label: 'kept',
                detail: `${LAUNCHER} had been edited; it is replaced, because it holds the pin. Your copy is ${EDITED_LAUNCHER}`,
            },
        ]);
    }
    const content = launcherContent(io.env, { image: to.image!, channel: release.channel });
    atomicWrite(launcher, content, 0o755);
    checksums[LAUNCHER] = sha256(content);
    ok(io, LAUNCHER, `the launcher, pinned to ${to.image}`);
    writeMetadata(dir, {
        ...metadata,
        updatedAt: isoSeconds(),
        channel: release.channel,
        stack: {
            version: to.version,
            ref: to.version,
            image: to.image,
            previous: from,
        },
        payload: checksums,
    });
    ok(io, META_FILE, `records ${describeStack(to)}`);
}

/**
 * Puts the site back as it was before the update, as far as it can, and
 * says which: restored, or needing the operator.
 */
async function recover(
    { io, context, site, from, to }: Update,
    snapshot: Snapshot,
    backup: string | null,
    stage: Stage,
    error: unknown,
): Promise<number> {
    const dir = site.dir;
    io.stderr(`\n${describeError(error)}\n`);
    // Once the release's services have started, they may have migrated the
    // databases: those are put back from the backup, with nothing running.
    const servicesChanged = stage === 'start' || stage === 'verify' || stage === 'record';
    io.stderr(
        `\nThe update to ${describeStack(to)} did not complete. Putting ${describeStack(from)} back\n`,
    );
    const problems: string[] = [];
    const aside = new SetAside(io, context, dir, UPDATE_DIR);
    if (servicesChanged) {
        const stopped = await stopServices(io, dir, `Stopping ${describeStack(to)}`);
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
    if (problems.length === 0 && servicesChanged) {
        try {
            const manifest = await readBackup(io, backup!);
            await aside.moveData();
            await loadBackupData(io, backup!, dir, manifest);
            await upAndWait(io, dir, `Starting ${describeStack(from)} again`);
            await verifySite(io, dir);
        } catch (upError) {
            problems.push((upError as Error).message);
        }
    }

    const kept =
        backup === null
            ? []
            : [`The backup taken before the update is kept in ${relative(dir, backup)}.`];
    if (problems.length > 0) {
        const running = await runningServices(io, dir);
        io.stderr(
            [
                '',
                'The site needs you. It could not be put back as it was:',
                ...problems.map((problem) => `  ${problem}`),
                describeServices(running),
                '',
                ...(backup !== null && servicesChanged
                    ? [
                          `Before the update, the site was backed up to ${backup}: its databases,`,
                          'content and files. To put the site back from it, in the site directory:',
                          `  ./ghost-docker restore --yes ${relative(dir, backup)}`,
                          '',
                      ]
                    : kept),
                `The files as they were before the update are in ${snapshot.root}/files.`,
                ...(aside.data.length > 0
                    ? [
                          `The data the update's services ran on is in ${snapshot.root}/data, set aside.`,
                      ]
                    : []),
                `The site ran the manager image ${from.image}; its launcher still runs it.`,
                `Once the site is as it should be (./ghost-docker check), remove ${snapshot.root}` +
                    (aside.data.length > 0 ? ' (it needs sudo: MySQL owns part of it).' : '.'),
                '',
            ].join('\n'),
        );
        throw new CliError('the update failed, and the site needs the operator.');
    }
    const left = await aside.remove();
    io.stderr(
        [
            '',
            `Restored: the site is back on ${describeStack(from)}, with its files as they were` +
                (servicesChanged
                    ? ', its databases and content from the backup, and its services running and healthy.'
                    : '. Its services were not changed.'),
            ...kept,
            ...(left === null ? [] : [left]),
            '',
        ].join('\n'),
    );
    throw new CliError(`the update failed; ${describeStack(from)} was restored.`);
}

function summarize({ io, site, from, to, metadata, payload }: Update, backup: string): void {
    const kept = payload.changes.filter((change) => change.action === 'keep');
    io.stdout(
        [
            '',
            `Updated from ${describeStack(from)} to ${describeStack(to)}.`,
            '',
            `  Ghost        ${metadata.ghost.version}, ${metadata.ghost.image}@${metadata.ghost.digest}, unchanged`,
            `  Manager      ${to.image}`,
            `  Backup       ${relative(site.dir, backup)}, of the site before the update; kept until you remove it`,
            ...(kept.length > 0
                ? [
                      '',
                      'Edited files were kept. Compare each with the release’s version beside it, and',
                      'merge what you need:',
                      ...kept.map(({ file }) => `  ${file}  ${newPath(file)}`),
                  ]
                : []),
            '',
        ].join('\n'),
    );
}
