// Image-only stack update. The target manager runs outside the files it replaces.
// Recovery must not load the checkpoint after service startup was attempted:
// even a failed start may have accepted writes. See docs/architecture.md#recovery.
import {
    cpSync,
    existsSync,
    readdirSync,
    readFileSync,
    rmdirSync,
    rmSync,
    statSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { refuseDrift } from '../backup.ts';
import { compose, composeError, composePs, upAndWait } from '../compose.ts';
import { z } from 'zod';
import { defineCommand, flag } from '../command.ts';
import { requireValid } from '../config.ts';
import type { Context } from '../context.ts';
import { CliError, describeError, EXIT, UsageError } from '../errors.ts';
import { refuseForeignProject } from '../project.ts';
import { RELOAD } from '../shared.ts';
import { atomicWrite } from '../fs.ts';
import type { Io } from '../io.ts';
import { isReleasedMainLayout, migrateReleasedMain } from '../legacy.ts';
import {
    isoSeconds,
    readMetadata,
    requireMetadata,
    siteFiles,
    writeMetadata,
    type AnyMetadata,
    type Metadata,
} from '../meta.ts';
import {
    copyStackFile,
    LAUNCHER,
    launcherContent,
    managerPin,
    payloadFiles,
    sha256,
    stackDir,
} from '../payload.ts';
import { describeServices, Snapshot } from '../recovery.ts';
import { compareReleases, isRelease } from '../release.ts';
import { resolveSite } from '../resolved.ts';
import { heading, note, ok } from '../report.ts';
import * as env from '../env.ts';
import {
    COMPOSE_FILE,
    ENV_FILE,
    INFRA_PROFILE,
    isInfra,
    META_FILE,
    UPDATE_DIR,
    type Layout,
    type SiteFacts,
} from '../site.ts';
import {
    reportNeedsOperator,
    reportRestored,
    runUpdate,
    type RecoveryChoice,
    type UpdateOutcome,
} from '../update.ts';
import { atLeast, MINIMUM } from '../versions.ts';
import {
    channelOption,
    installedSite,
    lockPlanned,
    refuseUnfinished,
    releaseOf,
    releaseOption,
    requestedRelease,
    type ManagerRelease,
    type Requested,
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
        noBackup: flag('Take no backup before the update.'),
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
 * What the update does to each managed file of a site of this layout. A file is
 * untouched when its checksum is the one recorded when the manager wrote it.
 */
function planPayload(
    dir: string,
    stack: string,
    layout: Layout,
    recorded: Record<string, string>,
): Payload {
    const changes: FileChange[] = [];
    const checksums: Record<string, string> = {};
    const files = payloadFiles(stack, layout);
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

/** Removes `directory` and its parents below `dir` while each is empty. */
function removeEmptyParents(dir: string, directory: string): void {
    while (directory !== dir && existsSync(directory) && readdirSync(directory).length === 0) {
        rmdirSync(directory);
        directory = dirname(directory);
    }
}

/**
 * Every path an update may write or remove, relative to the site: what the
 * snapshot holds. The site's own files, as a backup and a restore know them,
 * and what this release adds.
 */
function touched(metadata: AnyMetadata, payload: Payload): string[] {
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
                copyStackFile(stack, dir, file);
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
                removeEmptyParents(dir, dirname(target));
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
            note(
                io,
                'kept',
                `${file} has been edited, so it was kept. This release's version is ${newPath(file)}`,
            );
        } else if (action === 'leave') {
            note(
                io,
                'kept',
                `${file} is no longer part of the stack, but it has been edited, so it was kept`,
            );
        }
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
        const { context, site } = installedSite(io, { infra: true });
        const dir = site.dir;
        if (isInfra(site.settings)) {
            return updateInfra(io, context, site, requested, flags.check);
        }
        // An installation of the released main layout has no metadata: this is
        // how it moves onto this one (legacy.ts).
        if (readMetadata(dir).state === 'absent' && isReleasedMainLayout(site.settings)) {
            if (flags.noBackup) {
                throw new UsageError(
                    '--no-backup: moving from the released main layout always backs the site up first',
                );
            }
            return migrateReleasedMain(io, context, site, requested, flags.check);
        }
        const metadata = requireMetadata(dir, 'update cannot tell which files are its own');
        refuseCheckouts(metadata.source, context.source);

        const release = releaseOf(requested, io.env);
        const from: Stack = { version: metadata.stack.version, image: metadata.stack.image };
        const image = await io.busy('Resolving the manager image', () => managerPin(io, context));
        const to: Stack = { version: release.version, image };
        const decided = compare(from, to);
        if (typeof decided === 'object') {
            throw new CliError(`${decided.unordered}. Nothing has been changed.`);
        }

        const stack = stackDir(io.env);
        const payload = planPayload(dir, stack, site.layout, metadata.payload);
        const update: Update = { io, site, metadata, from, to, release, stack, payload };

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
        refuseUnfinished(dir, 'self-update');

        // A project another directory owns, or running images its configuration
        // does not name, which the backup an update takes would refuse.
        await refuseDrift(
            io,
            await io.busy('Resolving the Compose project', () => resolveSite(io, dir)),
        );

        const lock = lockPlanned(dir, `update to ${describeStack(to)}`, metadata, 'self-update');
        try {
            return await apply(update, !flags.noBackup);
        } finally {
            lock.release();
        }
    },
});

/** A checkout is updated with git; a site from the image only by its own launcher's manager. */
function refuseCheckouts(source: AnyMetadata['source'], running: Context['source']): void {
    if (source === 'checkout') {
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
    if (running === 'checkout') {
        throw new CliError(
            'this site was installed from the manager image, and this manager was built from a checkout.\n' +
                '  Run the site’s own ./ghost-docker self-update. Nothing has been changed.',
        );
    }
}

// --- The shared Caddy -------------------------------------------------------------

/**
 * The shared Caddy's directory (shared.ts): its stack files and launcher, then
 * Caddy recreated on the release's image. It holds no data, only Caddy's
 * certificates in a volume `up` keeps, so there is no backup, and a failure
 * puts the files back and starts the previous Caddy again: nothing it ran on
 * the new files can have changed anything the old ones depend on. Every site
 * behind it is unreachable while Caddy restarts, and updates on its own.
 */
async function updateInfra(
    io: Io,
    context: Context,
    site: SiteFacts,
    requested: Requested,
    check: boolean,
): Promise<number> {
    const dir = site.dir;
    const read = readMetadata(dir);
    if (read.state !== 'present' || read.metadata.mode !== INFRA_PROFILE) {
        throw new CliError(
            read.state === 'invalid'
                ? `${read.reason}. Nothing has been changed.`
                : `${dir} holds the shared Caddy, but has no ${META_FILE} recording its files, so self-update\n` +
                      '  cannot tell them from yours. Nothing has been changed.',
        );
    }
    const metadata = read.metadata;
    refuseCheckouts(metadata.source, context.source);

    const release = releaseOf(requested, io.env);
    const from: Stack = { version: metadata.stack.version, image: metadata.stack.image };
    const image = await io.busy('Resolving the manager image', () => managerPin(io, context));
    const to: Stack = { version: release.version, image };
    const decided = compare(from, to);
    if (typeof decided === 'object') {
        throw new CliError(`${decided.unordered}. Nothing has been changed.`);
    }
    const stack = stackDir(io.env);
    const payload = planPayload(dir, stack, INFRA_PROFILE, metadata.payload);
    if (check) {
        io.stdout(
            `The shared Caddy runs ${describeStack(from)}. This release is ${describeStack(to)}.\n`,
        );
        if (decided === 'newer') {
            io.stdout('An update is available. Caddy restarts with it.\n');
            describeChanges(io, payload, to);
        } else {
            io.stdout(
                decided === 'current'
                    ? 'It is up to date.\n'
                    : 'That is older, and update would refuse it.\n',
            );
        }
        return EXIT.ok;
    }
    if (decided === 'current') {
        io.stdout(`The shared Caddy already runs ${describeStack(to)}. Nothing to update.\n`);
        return EXIT.ok;
    }
    if (decided === 'downgrade') {
        throw new CliError(
            `the shared Caddy runs ${describeStack(from)}, which is newer than ${describeStack(to)}. An update\n` +
                '  never moves to an older release. Nothing has been changed.',
        );
    }
    refuseUnfinished(dir, 'self-update');
    // A project another directory owns would be recreated as this one's.
    await refuseForeignProject(io, site.settings.get('COMPOSE_PROJECT_NAME') || '', dir);

    const lock = lockPlanned(dir, `update to ${describeStack(to)}`, metadata, 'self-update');
    try {
        io.stdout(
            `Updating the shared Caddy from ${describeStack(from)} to ${describeStack(to)}\n`,
        );
        heading(io, 'Keeping the current files');
        // Not the sites' routes: the update never writes them, and a site
        // installed meanwhile adds its own, which putting files back would lose.
        const snapshot = new Snapshot(
            dir,
            touched(metadata, payload).filter((path) => path !== join('caddy', 'sites')),
        );
        snapshot.take();
        ok(io, UPDATE_DIR, 'the configuration, the metadata and the files this update writes');
        let started = false;
        try {
            heading(io, 'Writing the stack');
            writePayloadChanges(io, dir, stack, payload);
            await requireValid(io, dir, 'this release');
            const pull = await io.busy(
                'Pulling the images this release names',
                () => compose(io, { dir, timeout: PULL_MS })`pull --quiet --ignore-buildable`,
            );
            if (pull.exitCode !== 0) {
                throw new CliError(`the images could not be pulled: ${composeError(pull)}`);
            }
            heading(io, 'Restarting the shared Caddy');
            started = true;
            await caddyUp(
                io,
                dir,
                'Recreating Caddy on this release and waiting for it to be healthy',
            );
            recordStack(io, dir, metadata, from, to, release, payload);
        } catch (error) {
            io.stderr(
                `\n${describeError(error)}\n\nThe update to ${describeStack(to)} did not complete. Putting ${describeStack(from)}'s files back\n`,
            );
            try {
                snapshot.restore();
            } catch (restoreError) {
                throw new CliError(
                    `the update failed, and ${describeStack(from)}'s files could not be put back: ${describeError(restoreError)}\n` +
                        `  They are in ${UPDATE_DIR}/files, in ${dir}: copy them back, then docker compose up -d\n` +
                        `  there, and remove ${UPDATE_DIR} once Caddy runs on them.` +
                        (started ? ' Caddy may be stopped until then.' : ''),
                );
            }
            if (started) {
                try {
                    await caddyUp(io, dir, `Starting ${describeStack(from)}'s Caddy again`);
                } catch (again) {
                    throw new CliError(
                        `the files are ${describeStack(from)}'s again, but Caddy did not start on them: ${describeError(again)}\n` +
                            '  Every site behind it is unreachable until it does: docker compose up -d, and\n' +
                            `  docker compose logs caddy, in ${dir}. The files as they were are in ${UPDATE_DIR}/files;\n` +
                            `  remove ${UPDATE_DIR} once Caddy runs.`,
                    );
                }
            }
            snapshot.remove();
            throw new CliError(
                `the update failed; the shared Caddy is back on ${describeStack(from)}${started ? ', and running' : ', and was never stopped'}.`,
            );
        }
        snapshot.remove();
    } finally {
        lock.release();
    }
    io.stdout(
        `\nUpdated the shared Caddy from ${describeStack(from)} to ${describeStack(to)}.\n` +
            'Each site behind it keeps its own release; update each with its own ./ghost-docker self-update.\n',
    );
    return EXIT.ok;
}

/** `up --wait`, and Caddy healthy by its own check. */
async function caddyUp(io: Io, dir: string, spinner: string): Promise<void> {
    await upAndWait(io, dir, spinner);
    // `up` recreates Caddy only when its service changed; a Caddyfile or
    // snippet it mounts is loaded only by a reload.
    const reload = await io.busy(
        'Loading the configuration',
        // One at a time with the sites' route changes (shared.ts RELOAD).
        () => compose(io, { dir })`exec -T caddy ${[...RELOAD]}`,
    );
    if (reload.exitCode !== 0) {
        throw new CliError(
            `Caddy did not load its configuration, and keeps serving the one it had: ${composeError(reload)}`,
        );
    }
    const caddy = (await composePs(io, dir))?.find((state) => state.Service === 'caddy');
    if (caddy?.Health !== 'healthy') {
        throw new CliError('Caddy started, but it is not healthy');
    }
    ok(io, 'caddy', 'healthy: its admin API answers, with its configuration loaded');
}

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
    describeChanges(io, payload, to);
    return EXIT.ok;
}

/** What --check says an update does to each file. */
function describeChanges(io: Io, payload: Payload, to: Stack): void {
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
}

async function apply(update: Update, backup: boolean): Promise<number> {
    const { io, site, from, to, stack, payload } = update;
    const dir = site.dir;
    io.stdout(`Updating from ${describeStack(from)} to ${describeStack(to)}\n`);

    // While the site still runs: the slowest step, kept out of the time the
    // writers are stopped. Compose resolves the release's compose.yml with
    // the site's own overrides and settings.
    heading(io, 'Pulling the release’s images');
    const early = await io.busy(
        'Pulling the images this release names, while the site keeps running',
        () =>
            compose(io, {
                dir,
                composeFile: join(stack, COMPOSE_FILE),
                timeout: PULL_MS,
            })`pull --quiet --ignore-buildable`,
    );
    if (early.exitCode === 0) {
        ok(io, 'images', 'pulled, while the site kept running');
    } else {
        note(
            io,
            'images',
            `not pulled yet (${composeError(early, 2)}); they are pulled once the release is written`,
        );
    }

    const outcome = await runUpdate({
        io,
        site,
        metadata: update.metadata,
        to: describeStack(to),
        paths: touched(update.metadata, payload),
        kept: 'the configuration, the metadata and the files this update writes',
        failing: `The update to ${describeStack(to)} did not complete. Putting ${describeStack(from)}'s files back`,
        afterStartup: 'restore',
        backup,
        async write() {
            heading(io, 'Writing the stack');
            writePayloadChanges(io, dir, stack, payload);
            // The upgrade supervisor runs the manager the launcher is pinned to.
            const envPath = join(dir, ENV_FILE);
            const settings = readFileSync(envPath, 'utf8');
            if (env.get(settings, 'MANAGER_IMAGE_REF') !== undefined) {
                atomicWrite(envPath, env.set(settings, 'MANAGER_IMAGE_REF', to.image!));
                ok(io, ENV_FILE, `MANAGER_IMAGE_REF=${to.image!}, for the upgrade supervisor`);
            }

            await requireValid(io, dir, 'this release');
        },
        async pull() {
            // Quick when the early pull got them; whatever it could not, now.
            const pull = await io.busy(
                'Pulling the images this release names',
                () => compose(io, { dir, timeout: PULL_MS })`pull --quiet --ignore-buildable`,
            );
            if (pull.exitCode !== 0) {
                throw new CliError(`the images could not be pulled: ${composeError(pull)}`);
            }
        },
        record: () => record(update),
    });
    if (outcome.state !== 'done') {
        return failed(update, outcome);
    }
    summarize(update, outcome.backup);
    return EXIT.ok;
}

/** The launcher pinned to this image, then the metadata. */
function record({ io, site, metadata, from, to, release, payload }: Update): void {
    recordStack(io, site.dir, metadata, from, to, release, payload);
}

/** What `record` writes for any metadata: the launcher pinned, then the stack recorded. */
function recordStack(
    io: Io,
    dir: string,
    metadata: AnyMetadata,
    from: Stack,
    to: Stack,
    release: ManagerRelease,
    payload: Payload,
): void {
    const checksums = { ...payload.checksums };
    const launcher = join(dir, LAUNCHER);
    const present = checksumOf(launcher);
    if (present !== null && present !== metadata.payload[LAUNCHER]) {
        // It holds the pin, so it is always replaced; an edited one is kept beside it.
        cpSync(launcher, join(dir, EDITED_LAUNCHER));
        note(
            io,
            'kept',
            `${LAUNCHER} had been edited; it is replaced, because it holds the pin. Your copy is ${EDITED_LAUNCHER}`,
        );
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

/** A failed update, as the operator needs to hear it. */
function failed(
    { io, site, from, to }: Update,
    outcome: Exclude<UpdateOutcome, { state: 'done' }>,
): never {
    const dir = site.dir;
    const wording = { from: describeStack(from), operation: 'the update' };
    if (outcome.state === 'restored') {
        reportRestored(io, dir, outcome, wording);
    }
    const { servicesChanged, filesBack, problems, running, snapshot } = outcome;
    const backup = outcome.backup === null ? null : relative(dir, outcome.backup);
    const restore: RecoveryChoice = {
        does: 'Put the site back as it was when the update began, discarding anything written since',
        commands: [`./ghost-docker restore --yes ${backup}`],
    };
    reportNeedsOperator(
        io,
        dir,
        outcome,
        {
            facts: [
                ...problems,
                ...(servicesChanged
                    ? [
                          `${describeStack(to)}'s services started before the update failed, so they may have changed the databases and content, and Ghost may have accepted writes${backup === null ? '' : ', since the backup'}. Nothing was loaded over them: the data is as the update left it.`,
                      ]
                    : []),
                describeServices(running),
                ...(filesBack ? [`The files are ${describeStack(from)}'s again.`] : []),
                `The site ran the manager image ${from.image}; its launcher still runs it.`,
            ],
            choices:
                backup === null || !servicesChanged
                    ? []
                    : [
                          restore,
                          ...(filesBack
                              ? [
                                    {
                                        does: `Or, if ${describeStack(to)} did not change the data (docker compose logs says what it did), start ${describeStack(from)} on it as it is`,
                                        commands: ['docker compose up -d', './ghost-docker check'],
                                    },
                                ]
                              : []),
                      ],
            snapshot: relative(dir, snapshot),
        },
        wording,
    );
}

function summarize({ io, site, from, to, metadata, payload }: Update, backup: string | null): void {
    const kept = payload.changes.filter((change) => change.action === 'keep');
    io.stdout(
        [
            '',
            `Updated from ${describeStack(from)} to ${describeStack(to)}.`,
            '',
            `  Ghost        ${metadata.ghost.version}, ${metadata.ghost.image}@${metadata.ghost.digest}, unchanged`,
            `  Manager      ${to.image}`,
            backup === null
                ? '  Backup       none, as --no-backup asked'
                : `  Backup       ${relative(site.dir, backup)}, of the site before the update; kept until you remove it`,
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
