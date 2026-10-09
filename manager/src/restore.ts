// Restoring a backup into its own site directory or a new, empty one (plan
// §2.5). `restoreSite` takes these parts in order:
//
//   1. Refusals that change nothing: the backup is read whole and every file
//      checked against its checksum; the directory is this backup's own
//      site, or empty; in a new directory, nothing on the daemon already
//      uses the site's project name or ports, and over the site, no other
//      directory's; the overrides in effect are the ones the backup was
//      taken with. Then the lock, and the
//      recorded images are pulled before anything stops.
//   2. Over the site itself: the site is stopped, and its data and files are
//      moved aside into RESTORE_DIR, one at a time (recovery.ts), which is
//      kept until the restore has been verified. A failure here, before
//      anything is written, moves back what had been moved.
//   3. The backup's files are written, with the site's own path, and Compose
//      must resolve exactly the recorded images. The content is unpacked,
//      a fresh MySQL is started, and each dump loaded as the site's user and
//      its rows counted against the manifest.
//   4. `up --wait`, then verify as `check` does.
//
// The outcome is done, or needs the operator with what to do: a restore that
// fails once it has written stops the services and does not put the old site
// back by itself. What it says to do names only copies that exist.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { backupSiteFiles, readBackup } from './backup.ts';
import { SITE_FILES_DIR, type BackupManifest } from './backup/manifest.ts';
import { composeFileList, upAndWait } from './compose.ts';
import type { Context } from './context.ts';
import {
    DaemonError,
    inspectImage,
    listContainers,
    pullImage,
    splitReference,
} from './docker/client.ts';
import * as env from './env.ts';
import { CliError, describeError, UsageError } from './errors.ts';
import { atomicWrite, readIfExists } from './fs.ts';
import type { Io } from './io.ts';
import { acquireLock } from './lock.ts';
import { readMetadata, siteFiles, writeMetadata } from './meta.ts';
import { isCheckout, LAUNCHER } from './payload.ts';
import { git } from './process.ts';
import { PROJECT_LABEL, refuseForeignProject } from './project.ts';
import { takenPorts } from './ports.ts';
import {
    describeServices,
    loadBackupData,
    runningServices,
    SetAside,
    stopServices,
} from './recovery.ts';
import { heading, ok, printChecks } from './report.ts';
import { insideSite, resolveSite } from './resolved.ts';
import {
    COMPOSE_FILE,
    COMPOSE_OVERRIDE_FILE,
    DATA_DIRS,
    ENV_FILE,
    MAILPIT_DATA_DIR,
    META_FILE,
    readSettings,
    RESTORE_DIR,
} from './site.ts';
import { verifySite } from './verify.ts';

/** `over`: the backup's own site, replaced. `fresh`: a new, empty directory. */
type Target = 'over' | 'fresh';

export interface RestoreInput {
    readonly io: Io;
    readonly context: Context;
    /** The backup's directory, absolute. */
    readonly root: string;
    /** Restore over the site without asking. */
    readonly yes: boolean;
}

export async function restoreSite({ io, context, root, yes }: RestoreInput): Promise<void> {
    const dir = context.siteDir;
    io.stdout(`Reading the backup ${root}\n`);
    const manifest = await readBackup(io, root);
    ok(
        io,
        'backup',
        `${manifest.site.url}, taken ${manifest.createdAt}; every file matches its checksum`,
    );

    const target = classify(context, dir, manifest);
    refuseOtherOverrides(io, dir, manifest);
    if (target === 'fresh') {
        await refuseTaken(io, root, manifest);
    } else {
        await refuseForeignProject(io, manifest.site.project, dir);
        await confirm(io, dir, manifest, yes);
    }
    if (manifest.site.source === 'checkout') {
        await refuseOtherCommit(io, dir, manifest);
    }
    if (existsSync(join(dir, RESTORE_DIR))) {
        throw new CliError(
            `${join(dir, RESTORE_DIR)} is left from a restore that did not finish, and holds the site as\n` +
                '  it was before it. Once the site is as it should be, remove it (it needs sudo: MySQL owns\n' +
                '  part of it) and run the restore again. Nothing has been changed.',
        );
    }

    const lock = acquireLock(dir, `restore from ${basename(root)}`);
    const aside = target === 'over' ? new SetAside(io, context, dir, RESTORE_DIR) : null;
    // Set once the backup's files or data are being written into the site.
    let writing = false;
    try {
        heading(io, 'Pulling the recorded images');
        for (const image of new Set(Object.values(manifest.images))) {
            await io.busy(`Pulling ${image}`, () => ensureImage(io, image));
        }
        ok(io, 'images', `${Object.keys(manifest.images).length} services, as the backup records`);

        if (aside !== null) {
            await setAside(io, dir, aside);
        }
        writing = true;
        heading(io, 'Restoring the site');
        writeSiteFiles(io, root, dir, manifest);
        await checkImages(io, dir, manifest);
        await loadBackupData(io, root, dir, manifest);

        heading(io, 'Starting the services');
        await upAndWait(io, dir, 'Starting the services and waiting for them to be healthy');
        ok(io, 'services', 'healthy, by their own health checks');
        await verifySite(io, dir);
    } catch (error) {
        if (writing) {
            await needsOperator(io, dir, aside, error);
        }
        if (aside !== null && existsSync(aside.root)) {
            await putBack(io, dir, aside, error);
        }
        throw error;
    } finally {
        lock.release();
    }

    if (aside !== null) {
        const left = await aside.remove();
        if (left !== null) {
            printChecks(io, [{ status: 'warn', label: RESTORE_DIR, detail: left }]);
        }
    }
    summarize(io, dir, root, manifest, target);
}

// --- Before anything changes ----------------------------------------------------

/** The backup's own site, or an empty directory; anything else is refused. */
function classify(context: Context, dir: string, manifest: BackupManifest): Target {
    const settings = readSettings(dir);
    if (settings !== null) {
        const project = settings.get('COMPOSE_PROJECT_NAME');
        if (project !== manifest.site.project) {
            throw new CliError(
                `${dir} holds another site (${project ?? 'no project name'}); this backup is of ${manifest.site.project}.\n` +
                    '  Restore it over its own site, or into a new, empty directory. Nothing has been changed.',
            );
        }
        const metadata = readMetadata(dir);
        if (metadata.state === 'present' && metadata.metadata.source !== manifest.site.source) {
            throw new CliError(
                `this site was installed ${metadata.metadata.source === 'checkout' ? 'as a checkout of the repository' : 'from the manager image'}, and the backup is of one\n` +
                    `  installed ${manifest.site.source === 'checkout' ? 'as a checkout' : 'from the image'}. Restore it into a new, empty directory. Nothing has been changed.`,
            );
        }
        return 'over';
    }
    if (existsSync(join(dir, META_FILE))) {
        throw new CliError(
            `${join(dir, META_FILE)} exists without ${ENV_FILE}, so this directory holds part of a site.\n` +
                '  Restore into a new, empty directory instead. Nothing has been changed.',
        );
    }
    for (const data of [...DATA_DIRS, MAILPIT_DATA_DIR]) {
        const path = join(dir, data);
        if (existsSync(path) && readdirSync(path).length > 0) {
            throw new CliError(
                `${path} is not empty. A backup is never restored over data that is not its site's. Nothing has been changed.`,
            );
        }
    }
    const clone = isCheckout(context, dir);
    if (manifest.site.source === 'checkout' && !clone) {
        throw new CliError(
            'this backup is of a site that was a checkout of the repository. Restore it into a checkout:\n' +
                `    git clone https://github.com/TryGhost/ghost-docker.git ${dir}\n` +
                `    git -C ${dir} checkout ${manifest.site.commit ?? '<the commit the site ran>'}\n` +
                `  then run that checkout's ./ghost-docker restore. Nothing has been changed.`,
        );
    }
    if (manifest.site.source === 'image') {
        if (clone) {
            throw new CliError(
                'this backup is of a site installed from the manager image, and this directory is a checkout\n' +
                    '  of the repository. Restore it into a new, empty directory. Nothing has been changed.',
            );
        }
        const conflicts = backupSiteFiles(manifest)
            .map((file) => file.split('/')[0]!)
            .filter((top, index, all) => all.indexOf(top) === index)
            .filter((top) => existsSync(join(dir, top)));
        if (conflicts.length > 0) {
            throw new CliError(
                `${dir} already has ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ', …' : ''}, which the restore would write.\n` +
                    '  Restore into a new, empty directory, or move these aside. Nothing has been changed.',
            );
        }
    }
    return 'fresh';
}

/**
 * The site runs with the overrides it was backed up with, which the backup
 * holds; GD_COMPOSE_OVERRIDES must name the same ones, or Compose would run
 * the restored site as another.
 */
function refuseOtherOverrides(io: Io, dir: string, manifest: BackupManifest): void {
    const now = composeFileList(dir, io.env.GD_COMPOSE_OVERRIDES)
        .filter(
            (file) => file !== join(dir, COMPOSE_FILE) && file !== join(dir, COMPOSE_OVERRIDE_FILE),
        )
        .map((file) => insideSite(dir, file) ?? file);
    const recorded = manifest.site.overrides;
    if (now.join(',') !== recorded.join(',')) {
        throw new CliError(
            `the backup was taken with ${recorded.length > 0 ? `GD_COMPOSE_OVERRIDES=${recorded.join(',')}` : 'no GD_COMPOSE_OVERRIDES'}, and this restore runs with ${now.length > 0 ? `GD_COMPOSE_OVERRIDES=${now.join(',')}` : 'none'}.\n` +
                '  Run it with the same overrides the site ran with. Nothing has been changed.',
        );
    }
}

/**
 * A site restored into a new directory keeps its project name and its ports,
 * so nothing on this daemon may already use them. The site the backup was
 * taken from is the usual one, and it is named, never stopped.
 */
async function refuseTaken(io: Io, root: string, manifest: BackupManifest): Promise<void> {
    const project = await listContainers(io.docker, {
        all: true,
        labels: [`${PROJECT_LABEL}=${manifest.site.project}`],
    });
    if (project.length > 0) {
        throw new CliError(
            `the Compose project ${manifest.site.project} already has containers on this host (${project
                .map((container) => container.name)
                .slice(0, 4)
                .join(', ')}).\n` +
                '  A restored site keeps its project name. If the site this backup was taken from is still\n' +
                '  here, take it down first, in its directory: docker compose down. Nothing was stopped.\n' +
                '  Nothing has been changed.',
        );
    }
    const settings = env.toRecord(readIfExists(join(root, SITE_FILES_DIR, ENV_FILE)) ?? '');
    const keys = ['GHOST_PORT', 'MAILPIT_PORT'];
    if (manifest.site.mode === 'production') {
        keys.push('HTTP_PORT', 'HTTPS_PORT');
    }
    const wanted = keys
        .map((key) => Number(settings[key]))
        .filter((port) => Number.isInteger(port) && port > 0);
    const lines = [...(await takenPorts(io)).holders(wanted).values()];
    const ghostPort = Number(settings.GHOST_PORT);
    if (lines.length === 0 && Number.isInteger(ghostPort) && (await io.hostListens(ghostPort))) {
        lines.push(`port ${ghostPort} is already in use on this host by something outside Docker`);
    }
    if (lines.length > 0) {
        throw new CliError(
            `${lines.join('\n  ')}\n` +
                '  The restored site publishes the ports its backup records. Free them first. Nothing was\n' +
                '  stopped. Nothing has been changed.',
        );
    }
}

/** Replacing a site is never a surprise: it is asked, or --yes says so. */
async function confirm(io: Io, dir: string, manifest: BackupManifest, yes: boolean) {
    if (yes) {
        return;
    }
    const question =
        `Replace the site in ${dir} with the backup taken ${manifest.createdAt}? ` +
        'Its current content and database are kept aside until the restore is verified, then removed.';
    if (io.prompt === null) {
        throw new UsageError(
            `restoring replaces the site in ${dir}: its database and content become the backup's.\n` +
                '  Run it again with --yes to go ahead. Nothing has been changed.',
        );
    }
    const answer = await io.prompt.choose(question, [
        { name: 'No, change nothing', value: 'no' },
        { name: 'Yes, restore the backup over this site', value: 'yes' },
    ]);
    if (answer !== 'yes') {
        throw new CliError('the restore was cancelled. Nothing has been changed.');
    }
}

/** A checkout runs its own files, so it must be at the commit the backup's site ran. */
async function refuseOtherCommit(io: Io, dir: string, manifest: BackupManifest): Promise<void> {
    const head = await git(io, dir, ['rev-parse', '--verify', 'HEAD']);
    if (!head.ok) {
        throw new CliError(
            `git cannot read the checkout in ${dir}: ${head.stderr || 'no answer'}. Nothing has been changed.`,
        );
    }
    if (manifest.site.commit !== null && head.stdout.trim() !== manifest.site.commit) {
        throw new CliError(
            `the backup's site ran commit ${manifest.site.commit.slice(0, 12)}, and this checkout is at ${head.stdout.trim().slice(0, 12)}.\n` +
                `  Check that commit out first: git checkout ${manifest.site.commit}\n` +
                '  then run the restore again. Nothing has been changed.',
        );
    }
}

/** The image by its exact reference, pulled when the daemon does not hold it. */
async function ensureImage(io: Io, reference: string): Promise<void> {
    // `name:tag@sha256:...` is found, and pulled, by its digest alone.
    const at = reference.indexOf('@');
    const { repository, tag } =
        at === -1
            ? splitReference(reference)
            : {
                  repository: splitReference(reference.slice(0, at)).repository,
                  tag: reference.slice(at + 1),
              };
    const exact = at === -1 ? reference : `${repository}@${tag}`;
    if ((await inspectImage(io.docker, exact)) !== null) {
        return;
    }
    try {
        await pullImage(io.docker, repository, tag);
    } catch (error) {
        if (error instanceof DaemonError) {
            throw new CliError(
                `${reference}, which the backup records, could not be pulled: ${error.message}. Nothing has been changed.`,
            );
        }
        throw error;
    }
}

// --- Replacing the site -----------------------------------------------------------

/**
 * Stops the site, then moves its data and files aside, each recorded as it
 * is done. Stopping that fails moves nothing.
 */
async function setAside(io: Io, dir: string, aside: SetAside): Promise<void> {
    heading(io, 'Setting the current site aside');
    const stopped = await stopServices(io, dir);
    if (stopped.error !== null) {
        throw new CliError(
            `the site could not be stopped: ${stopped.error}\n` +
                `  Nothing was moved or written. ${describeServices(stopped.running)}`,
        );
    }
    ok(io, 'stopped', 'its containers removed; its volumes, such as Caddy’s certificates, kept');

    await aside.moveData();
    const metadata = readMetadata(dir);
    // The stack files of the release the site ran are replaced by the
    // backup's; the operator's directories are emptied, then refilled.
    aside.keepFiles(siteFiles(metadata.state === 'present' ? metadata.metadata : null));
    ok(
        io,
        RESTORE_DIR,
        `${aside.data.length > 0 ? `${aside.data.join(' and ')} and ` : ''}the site's files, kept until the restore is verified`,
    );
}

/** The backup's files at their places, with this directory as the site's own. */
function writeSiteFiles(io: Io, root: string, dir: string, manifest: BackupManifest): void {
    const files = backupSiteFiles(manifest);
    for (const file of files) {
        const target = join(dir, file);
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        cpSync(join(root, SITE_FILES_DIR, file), target, { preserveTimestamps: true });
    }
    const envPath = join(dir, ENV_FILE);
    const text = readIfExists(envPath);
    if (text === undefined) {
        throw new CliError(`the backup holds no ${ENV_FILE}`);
    }
    if (env.get(text, 'PROJECT_DIR') !== dir) {
        atomicWrite(envPath, env.set(text, 'PROJECT_DIR', dir));
    }
    const metadata = readMetadata(dir);
    if (metadata.state === 'present' && metadata.metadata.site.dir !== dir) {
        writeMetadata(dir, {
            ...metadata.metadata,
            site: { ...metadata.metadata.site, dir },
        });
    }
    ok(
        io,
        'files',
        `${files.length} files: configuration, metadata, Caddy${files.includes(LAUNCHER) ? ', the stack and its launcher' : ''}`,
    );
}

/** The images the backup records are the ones Compose now resolves: the site is pinned to them. */
async function checkImages(io: Io, dir: string, manifest: BackupManifest): Promise<void> {
    const resolved = await io.busy('Resolving the Compose project', () => resolveSite(io, dir));
    const differ: string[] = [];
    for (const [service, image] of Object.entries(manifest.images)) {
        const now = resolved.services[service]?.image;
        if (now !== image) {
            differ.push(
                `${service}: the backup records ${image}, Compose resolves ${now ?? 'nothing'}`,
            );
        }
    }
    if (differ.length > 0) {
        throw new CliError(
            `the restored site does not run the images its backup records:\n${differ.map((line) => `  ${line}`).join('\n')}`,
        );
    }
    ok(io, 'pinned', 'Compose resolves every image the backup records');
}

// --- The outcome ----------------------------------------------------------------

/**
 * A failure before anything was written: what had been set aside is moved
 * back. The services stay stopped, and are reported as observed.
 */
async function putBack(io: Io, dir: string, aside: SetAside, error: unknown): Promise<never> {
    io.stderr(`\n${describeError(error)}\n`);
    const problems = await aside.putBack();
    const running = await runningServices(io, dir);
    if (problems.length === 0) {
        io.stderr(
            [
                '',
                'The restore did not write anything. What it had set aside is back in place.',
                describeServices(running),
                ...(running !== null && running.length === 0
                    ? ['Start the site again with: docker compose up -d']
                    : []),
                '',
            ].join('\n'),
        );
        throw new CliError('the restore failed; the site’s files and data are as they were.');
    }
    io.stderr(
        [
            '',
            'The restore did not write anything, and the site needs you: what it had set aside',
            'could not all be moved back.',
            ...problems.map((problem) => `  ${problem}`),
            describeServices(running),
            `What is still set aside is in ${aside.root}:`,
            ...aside.instructions(false),
            '',
        ].join('\n'),
    );
    throw new CliError('the restore failed, and the site needs the operator.');
}

/**
 * A failure once the backup was being written: the services are stopped, so
 * nothing writes to a site that is not verified, and the operator is told
 * what is where.
 */
async function needsOperator(
    io: Io,
    dir: string,
    aside: SetAside | null,
    error: unknown,
): Promise<never> {
    io.stderr(`\n${describeError(error)}\n`);
    const stopped = await stopServices(io, dir, 'Stopping the restored services');
    const state = [
        ...(stopped.error === null ? [] : [`docker compose down failed: ${stopped.error}`]),
        describeServices(stopped.running),
    ];
    io.stderr(
        (aside !== null
            ? [
                  '',
                  'The restore did not complete, and the site needs you.',
                  ...state,
                  `The site as it was before the restore is in ${aside.root}:`,
                  ...aside.instructions(true),
                  `Or fix what failed, then remove ${RESTORE_DIR} only once you no longer need it, and restore again.`,
                  '',
              ]
            : [
                  '',
                  `The restore into ${dir} did not complete, and needs you. Nothing else was changed.`,
                  ...state,
                  'To try again, restore into a new, empty directory, or empty this one first:',
                  '  docker compose down, then remove what the restore wrote (data/ needs sudo: MySQL owns part of it).',
                  '',
              ]
        ).join('\n'),
    );
    throw new CliError('the restore failed, and the site needs the operator.');
}

function summarize(
    io: Io,
    dir: string,
    root: string,
    manifest: BackupManifest,
    target: Target,
): void {
    io.stdout(
        [
            '',
            `Restored ${manifest.site.url} from ${root}${target === 'fresh' ? `, into ${dir}` : ''}.`,
            '',
            ...manifest.databases.map(
                (database) =>
                    `  ${database.name.padEnd(12)} ${Object.keys(database.tables).length} tables, rows as backed up`,
            ),
            `  ${'content'.padEnd(12)} ${manifest.content.entries} entries`,
            `  ${'ghost'.padEnd(12)} ${manifest.images.ghost ?? 'as recorded'}`,
            ...unapplied(manifest).map((line) => `  ${line}`),
            ...(manifest.notIncluded.length > 0
                ? [
                      '',
                      'Not in the backup, as it records:',
                      ...manifest.notIncluded.map((line) => `  ${line}`),
                  ]
                : []),
            '',
        ].join('\n'),
    );
}

/**
 * Services that ran another image than their configuration named when the
 * backup was taken: the restore runs the configured one.
 */
const unapplied = (manifest: BackupManifest): string[] =>
    Object.entries(manifest.running)
        .filter(([service, ran]) => {
            const configured = manifest.images[service];
            return configured !== undefined && ran.image !== configured;
        })
        .map(
            ([service, ran]) =>
                `${service.padEnd(12)} ran ${ran.image} when backed up; restored as configured`,
        );
