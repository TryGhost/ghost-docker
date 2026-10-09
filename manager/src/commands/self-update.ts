// `self-update`: move a site to this manager's release of the stack (plan §2.7).
//
// The updater is the target release. The site's launcher starts the image
// that --to or --channel names, or by default the newest release on the
// channel the site follows, and this is that image: it runs outside the files
// it replaces. In a checkout the operator has already checked the new ref
// out, and the launcher built this image from it.
//
// It updates the stack, never Ghost: `.env`, and the exact Ghost image it
// pins, are not touched. `run` takes these parts in order:
//
//   1. Refusals that change nothing: a site without metadata, a checkout with
//      local changes, a downgrade, a Ghost older than this release runs.
//      Then the lock.
//   2. A snapshot of the operator's files, the metadata and, in image mode,
//      every managed file this update writes, in UPDATE_DIR.
//   3. In image mode, the managed files: an untouched one is replaced, an
//      edited one is kept and the release's is written beside it as
//      `<file>.new`. It never asks.
//   4. Validate, pull, `up --wait`, verify as `check` does.
//   5. On a failure, the snapshot is put back (in a checkout, the previous
//      commit is checked out), the services are brought up again if they had
//      been changed, and the outcome is reported as restored or as needing
//      the operator. Never success because `up` returned zero.
//   6. On success, the site's launcher is pinned to this image, the metadata
//      records the release, and the snapshot is removed.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compose, composeConfig, composeError, upAndWait } from '../compose.ts';
import { git } from '../process.ts';
import { z } from 'zod';
import { defineCommand, flag } from '../command.ts';
import { findingErrors, validate } from '../config.ts';
import type { Context } from '../context.ts';
import { CliError, describeError, EXIT, UsageError } from '../errors.ts';
import { atomicWrite, copyPresent } from '../fs.ts';
import type { Io } from '../io.ts';
import { acquireLock } from '../lock.ts';
import { isoSeconds, requireMetadata, writeMetadata, type Metadata } from '../meta.ts';
import {
    LAUNCHER,
    launcherContent,
    managerPin,
    payloadFiles,
    sha256,
    stackDir,
} from '../payload.ts';
import { compareReleases, isRelease } from '../release.ts';
import { refuseForeignProject } from '../project.ts';
import { heading, ok, printChecks } from '../report.ts';
import { META_FILE, OPERATOR_FILES, UPDATE_DIR, type SiteFacts } from '../site.ts';
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
    readonly commit: string | null;
    /** The manager image; none in a checkout. */
    readonly image: string | null;
}

const describeStack = (stack: Stack): string =>
    stack.version ?? (stack.commit ? `commit ${stack.commit.slice(0, 12)}` : 'an unknown release');

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

/** Every path an update may write or remove, relative to the site: what the snapshot holds. */
function touched(payload: Payload | null): string[] {
    const paths: string[] = [...OPERATOR_FILES];
    if (payload !== null) {
        for (const { file, action } of payload.changes) {
            paths.push(file);
            if (action === 'keep') {
                paths.push(newPath(file));
            }
        }
        paths.push(LAUNCHER, EDITED_LAUNCHER);
    }
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

// --- Git, in a checkout -----------------------------------------------------------

/**
 * git in the site directory. The checkout belongs to the caller, whose uid the
 * manager runs as, but git's ownership check does not know that from inside
 * a container.
 */

/** The commit checked out, refusing a tree with local changes to tracked files. */
async function cleanHead(io: Io, dir: string): Promise<string> {
    const head = await git(io, dir, ['rev-parse', '--verify', 'HEAD']);
    if (!head.ok) {
        throw new CliError(
            `git cannot read the checkout in ${dir} from the manager: ${head.stderr || 'no answer'}.\n` +
                '  A git worktree keeps its repository outside the site directory, where the manager cannot see it.\n' +
                '  Nothing has been changed.',
        );
    }
    const status = await git(io, dir, ['status', '--porcelain', '--untracked-files=no']);
    if (!status.ok) {
        throw new CliError(
            `git status failed in ${dir}: ${status.stderr}. Nothing has been changed.`,
        );
    }
    if (status.stdout.trim() !== '') {
        const files = status.stdout
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => `    ${line.slice(3)}`);
        throw new CliError(
            `the checkout has local changes to tracked files, which an update would not be able to put back:\n${files.slice(0, 10).join('\n')}${files.length > 10 ? '\n    …' : ''}\n` +
                '  Commit or stash them, then run ./ghost-docker self-update again. Nothing has been changed.',
        );
    }
    return head.stdout.trim();
}

// --- Deciding -------------------------------------------------------------------

type Direction = 'newer' | 'current' | 'downgrade';

/** Image mode: by release number; a site on edge or a dev build may go anywhere. */
function imageDirection(from: Stack, to: Stack): Direction | { unordered: string } {
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

/** A checkout: by ancestry. A commit that is neither ahead nor behind is a newer ref too. */
async function checkoutDirection(
    io: Io,
    dir: string,
    from: Stack,
    head: string,
): Promise<Direction> {
    if (from.commit === null) {
        throw new CliError(
            `${META_FILE} does not record the commit this site was installed at, so a failed update could not\n` +
                '  check it out again. Nothing has been changed.',
        );
    }
    if (from.commit === head) {
        return 'current';
    }
    const known = await git(io, dir, ['cat-file', '-e', `${from.commit}^{commit}`]);
    if (!known.ok) {
        throw new CliError(
            `the commit this site was installed at, ${from.commit.slice(0, 12)}, is not in this checkout, so a\n` +
                '  failed update could not go back to it. Fetch it, then run ./ghost-docker self-update again.\n' +
                '  Nothing has been changed.',
        );
    }
    const behind = await git(io, dir, ['merge-base', '--is-ancestor', head, from.commit]);
    return behind.ok ? 'downgrade' : 'newer';
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
    readonly clone: boolean;
    readonly from: Stack;
    readonly to: Stack;
    readonly release: ManagerRelease;
    /** Image mode: the stack directory and what happens to each managed file. */
    readonly stack: string;
    readonly payload: Payload | null;
}

export const selfUpdateCommand = defineCommand({
    brief: 'Update the stack to a newer release: its files and manager, never Ghost. See docs/install.md.',
    options,
    async run(flags, _positionals, io) {
        const requested = requestedRelease(flags.channel, flags.to, '--to');
        const { context, site } = installedSite(io);
        const dir = site.dir;
        const metadata = requireMetadata(dir, 'update cannot tell which files are its own');
        const clone = metadata.source === 'checkout';
        if (clone && (requested.channel !== null || requested.ref !== null)) {
            throw new UsageError(
                'this site is a checkout of the repository: check the release out with git, then run\n' +
                    '  ./ghost-docker self-update from the checkout. --to and --channel do not apply.',
            );
        }
        if (clone !== (context.source === 'checkout')) {
            throw new CliError(
                clone
                    ? 'this site is a checkout of the repository, and this manager was not built from it.\n' +
                          '  Run the checkout’s own ./ghost-docker self-update. Nothing has been changed.'
                    : 'this site was installed from the manager image, and this manager was built from a checkout.\n' +
                          '  Run the site’s own ./ghost-docker self-update. Nothing has been changed.',
            );
        }

        const release = releaseOf(requested, io.env);
        const from: Stack = {
            version: metadata.stack.version,
            commit: metadata.stack.commit,
            image: metadata.stack.image,
        };
        let direction: Direction;
        let to: Stack;
        if (clone) {
            const head = await cleanHead(io, dir);
            to = { version: release.version, commit: head, image: null };
            direction = await checkoutDirection(io, dir, from, head);
        } else {
            const image = await io.busy('Resolving the manager image', () =>
                managerPin(io, context),
            );
            to = { version: release.version, commit: release.commit, image };
            const decided = imageDirection(from, to);
            if (typeof decided === 'object') {
                throw new CliError(`${decided.unordered}. Nothing has been changed.`);
            }
            direction = decided;
        }

        const stack = stackDir(io.env);
        const payload = clone ? null : planPayload(dir, stack, metadata.payload);
        const update: Update = {
            io,
            context,
            site,
            metadata,
            clone,
            from,
            to,
            release,
            stack,
            payload,
        };

        if (flags.check) {
            return report(update, direction);
        }
        if (direction === 'current') {
            io.stdout(`This site already runs ${describeStack(to)}. Nothing to update.\n`);
            return EXIT.ok;
        }
        if (direction === 'downgrade') {
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

        await refuseForeignProject(io, site.settings.get('COMPOSE_PROJECT_NAME') || '', dir);

        const lock = acquireLock(dir, `update to ${describeStack(to)}`);
        try {
            return await apply(update);
        } finally {
            lock.release();
        }
    },
});

/** --check: what an update would do, changing nothing. */
function report({ io, clone, from, to, payload, metadata }: Update, direction: Direction): number {
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
    if (clone || payload === null) {
        io.stdout('Run ./ghost-docker self-update to apply the checked-out files.\n');
        return EXIT.ok;
    }
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
type Stage = 'write' | 'validate' | 'pull' | 'start' | 'verify' | 'record';

async function apply(update: Update): Promise<number> {
    const { io, site, from, to, stack, payload } = update;
    const dir = site.dir;
    io.stdout(`Updating from ${describeStack(from)} to ${describeStack(to)}\n`);

    heading(io, 'Keeping the current files');
    const snapshot = new Snapshot(dir, touched(payload));
    snapshot.take();
    ok(io, UPDATE_DIR, 'the configuration, the metadata and the files this update writes');

    let stage: Stage = 'write';
    try {
        heading(io, 'Writing the stack');
        if (payload === null) {
            ok(io, 'stack files', `the checkout's, at ${to.commit!.slice(0, 12)}`);
        } else {
            writePayloadChanges(io, dir, stack, payload);
        }

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
        return recover(update, snapshot, stage, error);
    }
    snapshot.remove();
    summarize(update);
    return EXIT.ok;
}

/** The launcher pinned to this image, then the metadata. */
function record({ io, site, metadata, clone, from, to, release, payload }: Update): void {
    const dir = site.dir;
    const checksums = { ...payload?.checksums };
    if (!clone) {
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
    }
    writeMetadata(dir, {
        ...metadata,
        updatedAt: isoSeconds(),
        channel: clone ? null : release.channel,
        stack: {
            version: to.version,
            commit: to.commit,
            ref: clone ? null : to.version,
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
    { io, site, clone, from, to }: Update,
    snapshot: Snapshot,
    stage: Stage,
    error: unknown,
): Promise<number> {
    const dir = site.dir;
    io.stderr(`\n${describeError(error)}\n`);
    const servicesChanged = stage === 'start' || stage === 'verify' || stage === 'record';
    io.stderr(
        `\nThe update to ${describeStack(to)} did not complete. Putting ${describeStack(from)} back\n`,
    );
    const problems: string[] = [];
    if (clone) {
        const checkout = await git(io, dir, ['checkout', '--quiet', '--detach', from.commit!]);
        if (!checkout.ok) {
            problems.push(
                `git could not check out ${from.commit!.slice(0, 12)}: ${checkout.stderr}`,
            );
        }
    }
    try {
        snapshot.restore();
    } catch (restoreError) {
        problems.push(`the files could not be put back: ${(restoreError as Error).message}`);
    }
    if (problems.length === 0 && servicesChanged) {
        try {
            await upAndWait(io, dir, `Starting ${describeStack(from)} again`);
        } catch (upError) {
            problems.push((upError as Error).message);
        }
    }

    if (problems.length > 0) {
        io.stderr(
            [
                '',
                'The site needs you. It could not be put back as it was:',
                ...problems.map((problem) => `  ${problem}`),
                '',
                `The files as they were before the update are in ${snapshot.root}/files.`,
                clone
                    ? `The checkout was at ${from.commit}; its manager image is ghost-docker:checkout-${from.commit!.slice(0, 12)}.`
                    : `The site ran the manager image ${from.image}; its launcher still runs it.`,
                'Put them back, start the site with: docker compose up -d, and check it with ./ghost-docker check.',
                `Then remove ${snapshot.root}.`,
                '',
            ].join('\n'),
        );
        throw new CliError('the update failed, and the site needs the operator.');
    }
    snapshot.remove();
    io.stderr(
        [
            '',
            `Restored: the site is back on ${describeStack(from)}, with its files as they were` +
                (servicesChanged
                    ? ', and its services running and healthy.'
                    : '. Its services were not changed.'),
            ...(clone
                ? [
                      `The checkout is at ${from.commit!.slice(0, 12)} again, with a detached HEAD; the ref you checked out is unchanged.`,
                  ]
                : []),
            '',
        ].join('\n'),
    );
    throw new CliError(`the update failed; ${describeStack(from)} was restored.`);
}

function summarize({ io, from, to, metadata, payload }: Update): void {
    const kept = (payload?.changes ?? []).filter((change) => change.action === 'keep');
    io.stdout(
        [
            '',
            `Updated from ${describeStack(from)} to ${describeStack(to)}.`,
            '',
            `  Ghost        ${metadata.ghost.version}, ${metadata.ghost.image}@${metadata.ghost.digest}, unchanged`,
            ...(to.image ? [`  Manager      ${to.image}`] : []),
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
