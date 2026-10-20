// Host-driven Ghost upgrades: the site's Ghost moved to a newer release of the
// same major, through the update executor (update.ts) that self-update and the
// supervisor share. Ghost runs its own migrations when it starts, so once
// startup is attempted the site is never switched back to the older Ghost:
// that does not undo them. See docs/architecture.md#recovery.
import { relative } from 'node:path';
import { major, valid } from 'semver';
import { defineCommand, flag } from '../command.ts';
import { EXIT, UsageError } from '../errors.ts';
import { ghostChannelOf, NIGHTLY_LATEST, NIGHTLY_TAG, resolveGhost, variantOf } from '../ghost.ts';
import {
    directionTo,
    ghostUpdatePlan,
    recoveryAdvice,
    reference,
    refuseSiteDrift,
    siteGhost,
    type Direction,
    type GhostUpdate,
} from '../ghost-update.ts';
import { reportNeedsOperator, reportRestored, runUpdate, type UpdateOutcome } from '../update.ts';
import { installedSite, lockPlanned, refuseUnfinished } from './common.ts';
import { z } from 'zod';

const options = z.object({
    check: flag(
        'Say whether there is a newer Ghost and which; change nothing. The image is pulled to find out.',
    ),
    noBackup: flag(
        'Take no backup before the update. Going back to the earlier Ghost then needs a backup of your own.',
    ),
});

/** What `update` was asked for: the newest of the site's major, or one version. */
function requestedVersion(positionals: string[]): string | null {
    const [requested] = positionals;
    if (requested === undefined || requested === 'latest') {
        return null;
    }
    const bare = requested.replace(/^v/, '');
    if (valid(bare) === null) {
        throw new UsageError(`a Ghost version, such as 6.68.0, or latest: got '${requested}'`);
    }
    return bare;
}

/** What `update` was asked for on the nightly channel: latest, or a build's date. */
function requestedBuild(positionals: string[]): string {
    const [requested = NIGHTLY_LATEST] = positionals;
    if (!NIGHTLY_TAG.test(requested)) {
        throw new UsageError(
            `this site follows Ghost's nightly builds, which are chosen by date, such as 20261015, or latest: got '${requested}'`,
        );
    }
    return requested;
}

export const updateCommand = defineCommand({
    brief: 'Update Ghost to a newer release of the same major version: the newest, or the one named. See docs/install.md.',
    options,
    positionals: ['version'],
    async run(flags, positionals, io) {
        const { site } = installedSite(io);
        const dir = site.dir;
        const { metadata, from } = siteGhost(dir, site.settings, 'update');
        const nightly = ghostChannelOf(from.image) === 'nightly';
        const requested = nightly ? null : requestedVersion(positionals);
        // Before anything else: the site an unfinished update left may be down.
        if (!flags.check) {
            refuseUnfinished(dir, 'update');
        }
        // Pulled while the site keeps running: the slowest step, kept out of the outage.
        const variant = variantOf(from.tag);
        const tag = nightly
            ? requestedBuild(positionals)
            : requested === null
              ? `${major(from.version)}-${variant}`
              : `${requested}-${variant}`;
        const to = await io.busy(`Pulling ${from.image}:${tag}`, () =>
            resolveGhost(io, tag, from.image),
        );
        const decided = await directionTo(io, from, to, requested);
        const update: GhostUpdate = { io, site, metadata, from, to };

        if (flags.check) {
            return report(update, decided);
        }
        if (decided === 'current') {
            io.stdout(
                `This site already runs Ghost ${from.version} (${reference(from)}). Nothing to update.\n`,
            );
            return EXIT.ok;
        }
        await refuseSiteDrift(io, dir);

        const lock = lockPlanned(dir, `update Ghost to ${to.version}`, metadata, 'update');
        try {
            return await apply(update, !flags.noBackup);
        } finally {
            lock.release();
        }
    },
});

/** --check: whether there is a newer Ghost, changing nothing. */
function report({ io, from, to }: GhostUpdate, decided: Direction): number {
    io.stdout(
        `This site runs Ghost ${from.version}. ${to.image}:${to.tag} is Ghost ${to.version}.\n`,
    );
    io.stdout(
        decided === 'current'
            ? 'It is up to date.\n'
            : decided === 'rebuilt'
              ? `An update is available: a different image of Ghost ${to.version}, ${to.reference}.\n`
              : `An update is available: Ghost ${to.version}, ${to.reference}.\n`,
    );
    return EXIT.ok;
}

async function apply(update: GhostUpdate, backup: boolean): Promise<number> {
    const { io, site, from, to } = update;
    const dir = site.dir;
    io.stdout(`Updating Ghost from ${from.version} to ${to.version}\n`);

    const outcome = await runUpdate(ghostUpdatePlan(update, { backup }));
    if (outcome.state !== 'done') {
        return failed(update, outcome);
    }
    io.stdout(
        [
            '',
            `Updated Ghost from ${from.version} to ${to.version}.`,
            '',
            `  Ghost        ${to.version}, ${to.reference}`,
            `  Previously   ${from.version}, ${reference(from)}`,
            ...(outcome.backup === null
                ? [
                      '  Backup       none, as --no-backup asked',
                      '',
                      `Ghost ${from.version} does not undo ${to.version}'s migrations: going back to it needs a backup of your own.`,
                  ]
                : [
                      `  Backup       ${relative(dir, outcome.backup)}, of the site before the update; kept until you remove it`,
                      '',
                      `Going back to Ghost ${from.version} means restoring that backup, which discards anything written since.`,
                  ]),
            '',
        ].join('\n'),
    );
    return EXIT.ok;
}

/** A failed update, as the operator needs to hear it. */
function failed(
    { io, site, from, to }: GhostUpdate,
    outcome: Exclude<UpdateOutcome, { state: 'done' }>,
): never {
    const wording = { from: `Ghost ${from.version}`, operation: 'the update' };
    if (outcome.state === 'restored') {
        reportRestored(io, site.dir, outcome, wording);
    }
    reportNeedsOperator(
        io,
        site.dir,
        outcome,
        recoveryAdvice({ site, from, to }, outcome),
        wording,
    );
}
