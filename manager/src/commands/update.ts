// Host-driven Ghost upgrades: the site's Ghost moved to a newer release of the
// same major, through the update executor (update.ts) that self-update and the
// supervisor share. Ghost runs its own migrations when it starts, so once
// startup is attempted the site is never switched back to the older Ghost:
// that does not undo them. See docs/architecture.md#recovery.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compare, major, valid } from 'semver';
import { refuseDrift } from '../backup.ts';
import { composeConfig } from '../compose.ts';
import { defineCommand, flag } from '../command.ts';
import { findingErrors, validate } from '../config.ts';
import * as env from '../env.ts';
import { CliError, EXIT, UsageError } from '../errors.ts';
import { atomicWrite } from '../fs.ts';
import {
    ghostChannelOf,
    NIGHTLY_LATEST,
    NIGHTLY_TAG,
    resolveGhost,
    pinnedCreated,
    variantOf,
    type ResolvedGhost,
} from '../ghost.ts';
import type { Io } from '../io.ts';
import { acquireLock } from '../lock.ts';
import { requireMetadata, siteFiles, writeMetadata, type Metadata } from '../meta.ts';
import { describeServices } from '../recovery.ts';
import { resolveSite } from '../resolved.ts';
import { heading, ok } from '../report.ts';
import { ENV_FILE, META_FILE, UPDATE_DIR, type SiteFacts } from '../site.ts';
import { runUpdate, type UpdateOutcome, type UpdatePlan } from '../update.ts';
import { installedSite } from './common.ts';
import { z } from 'zod';

const options = z.object({
    check: flag(
        'Say whether there is a newer Ghost and which; change nothing. The image is pulled to find out.',
    ),
    noBackup: flag(
        'Take no backup before the update. Going back to the earlier Ghost then needs a backup of your own.',
    ),
});

/** The Ghost a site runs, as its metadata records it. */
export interface Pin {
    readonly image: string;
    readonly tag: string;
    readonly version: string;
    readonly digest: string;
}

export const reference = (pin: Pin): string => `${pin.image}@${pin.digest}`;

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

/**
 * The target's direction from the site's Ghost. Stable releases order by
 * version. Nightly builds order by when they were built: two can report the
 * same version, which differs only in the commit it names.
 */
export async function order(io: Io, from: Pin, to: ResolvedGhost): Promise<Direction> {
    const channel = ghostChannelOf(from.image);
    if (ghostChannelOf(to.image) !== channel) {
        throw new CliError(
            `this site follows Ghost's ${channel} channel, and ${to.reference} is on another one. Moving a site\n` +
                '  between channels is not supported yet. Nothing has been changed.',
        );
    }
    if (channel === 'stable') {
        return direction(from, to);
    }
    if (to.digest === from.digest) {
        return 'current';
    }
    if (valid(to.version) === null || major(to.version) !== major(from.version)) {
        throw new CliError(
            `this site runs Ghost ${from.version}, and ${to.reference} is Ghost ${to.version}: another major\n` +
                '  version, or one update cannot order. A major upgrade is not supported yet. Nothing has been changed.',
        );
    }
    let builds: NightlyOrder;
    try {
        builds = await nightlyOrder(io, from, to);
    } catch (error) {
        throw new CliError(
            `the nightly build this site runs, ${reference(from)}, cannot be read to tell when it was built:\n` +
                `  ${(error as Error).message.split('\n')[0]}\n  Nothing has been changed.`,
        );
    }
    const { built } = builds;
    if (builds.order === 'unknown') {
        throw new CliError(
            `${built === null ? reference(from) : to.reference} does not say when it was built, so update cannot\n` +
                '  order the two nightly builds. Nothing has been changed.',
        );
    }
    if (builds.order === 'older') {
        throw new CliError(
            `${to.reference} was built ${to.created}, before the nightly build this site runs (${built}).\n` +
                '  update never moves a site to an older build: its migrations are not undone. Nothing has been changed.',
        );
    }
    return 'newer';
}

export type Direction = 'newer' | 'rebuilt' | 'current';

export interface NightlyOrder {
    /** `to` against the site's build, by when each was built; `unknown` when either does not say. */
    readonly order: 'newer' | 'older' | 'unknown';
    /** When the site's build was built. */
    readonly built: string | null;
}

/**
 * Two nightly builds, ordered by when they were built. It throws only when
 * the site's own build cannot be read: a failure to check, which discovery
 * must report rather than take for "nothing newer".
 */
export async function nightlyOrder(io: Io, from: Pin, to: ResolvedGhost): Promise<NightlyOrder> {
    const built = await pinnedCreated(io, from.image, from.tag, from.digest);
    if (built === null || to.created === null) {
        return { order: 'unknown', built };
    }
    return { order: Date.parse(to.created) > Date.parse(built) ? 'newer' : 'older', built };
}

/** Where the target is from the site's Ghost; a CliError for what update never does. */
export function direction(from: Pin, to: ResolvedGhost): Direction {
    if (to.digest === from.digest) {
        return 'current';
    }
    if (valid(to.version) === null) {
        throw new CliError(
            `${to.image}:${to.tag} declares GHOST_VERSION ${to.version}, which is not a version update can order.\n` +
                '  Nothing has been changed.',
        );
    }
    if (major(to.version) !== major(from.version)) {
        throw new CliError(
            `this site runs Ghost ${from.version}, and ${to.image}:${to.tag} is Ghost ${to.version}: another major\n` +
                `  version. update moves a site within Ghost ${major(from.version)}; a major upgrade is not supported yet.\n` +
                '  Nothing has been changed.',
        );
    }
    const order = compare(to.version, from.version);
    if (order < 0) {
        throw new CliError(
            `this site runs Ghost ${from.version}, which is newer than ${to.version}. update never moves a site to an\n` +
                '  older Ghost: its migrations are not undone. To go back to the Ghost a backup ran, restore that backup.\n' +
                '  Nothing has been changed.',
        );
    }
    return order === 0 ? 'rebuilt' : 'newer';
}

export interface GhostUpdate {
    readonly io: Io;
    readonly site: SiteFacts;
    readonly metadata: Metadata;
    readonly from: Pin;
    readonly to: ResolvedGhost;
}

export const updateCommand = defineCommand({
    brief: 'Update Ghost to a newer release of the same major version: the newest, or the one named. See docs/install.md.',
    options,
    positionals: ['version'],
    async run(flags, positionals, io) {
        const { site } = installedSite(io);
        const dir = site.dir;
        const metadata = requireMetadata(dir, 'update cannot tell which Ghost it runs');
        const from: Pin = metadata.ghost;
        const nightly = ghostChannelOf(from.image) === 'nightly';
        const requested = nightly ? null : requestedVersion(positionals);
        const pinned = site.settings.get('GHOST_IMAGE_REF');
        if (pinned !== reference(from)) {
            throw new CliError(
                `${META_FILE} records Ghost ${from.version} as ${reference(from)}, but ${ENV_FILE} pins ` +
                    `GHOST_IMAGE_REF=${pinned || '(nothing)'}.\n` +
                    '  update moves the pin it recorded, and cannot tell which of the two the site runs. Put\n' +
                    `  GHOST_IMAGE_REF back to ${reference(from)}. Nothing has been changed.`,
            );
        }

        if (valid(from.version) === null) {
            throw new CliError(
                `${META_FILE} records Ghost ${from.version}, which is not a version update can order.\n` +
                    '  Nothing has been changed.',
            );
        }
        // Before anything else: the site an unfinished update left may be down.
        if (!flags.check && existsSync(join(dir, UPDATE_DIR))) {
            throw new CliError(
                `${join(dir, UPDATE_DIR)} is left from an update that did not finish, and holds the files it\n` +
                    '  would have put back. Once the site is as it should be (./ghost-docker check), remove it\n' +
                    '  and run ./ghost-docker update again. Nothing has been changed.',
            );
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
        if (requested !== null && to.version !== requested) {
            throw new CliError(
                `${to.image}:${to.tag} is Ghost ${to.version}, not ${requested}. Nothing has been changed.`,
            );
        }
        const decided = await order(io, from, to);
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
        await refuseDrift(
            io,
            await io.busy('Resolving the Compose project', () => resolveSite(io, dir)),
        );

        const lock = acquireLock(dir, `update Ghost to ${to.version}`);
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

/**
 * The update of a site's Ghost, as the executor runs it: for `update` and the
 * supervisor alike. `extra` is what each caller adds: whether to back up
 * first, and for the supervisor, the services to leave alone and where to
 * record each stage.
 */
export function ghostUpdatePlan(
    update: GhostUpdate,
    extra: Pick<UpdatePlan, 'backup' | 'except' | 'onStage' | 'onBackup'> = {},
): UpdatePlan {
    const { io, site, metadata, to } = update;
    const dir = site.dir;
    return {
        io,
        site,
        metadata,
        to: `Ghost ${to.version}`,
        // The pin and the metadata are all it writes; the rest of the
        // inventory is kept with them, as every update keeps it.
        paths: [...new Set([...siteFiles(metadata), ENV_FILE, META_FILE])],
        kept: 'the configuration and the metadata, which name the Ghost the site runs',
        failing: `The update to Ghost ${to.version} did not complete.`,
        afterStartup: 'keep',
        ...extra,
        async write() {
            heading(io, 'Pinning the new Ghost');
            // Together, and before startup: they describe the same image.
            let text = readFileSync(join(dir, ENV_FILE), 'utf8');
            for (const [key, value] of [
                ['GHOST_IMAGE', to.image],
                ['GHOST_VERSION', to.tag],
                ['GHOST_IMAGE_REF', to.reference],
                ['GHOST_CONTENT_PATH', to.contentPath],
                ['GHOST_TINYBIRD_PATH', to.tinybirdPath],
            ] as const) {
                text = env.set(text, key, value);
            }
            atomicWrite(join(dir, ENV_FILE), text);
            writeMetadata(dir, {
                ...metadata,
                ghost: { image: to.image, tag: to.tag, version: to.version, digest: to.digest },
            });
            ok(io, ENV_FILE, `GHOST_IMAGE_REF=${to.reference}`);
            ok(io, META_FILE, `records Ghost ${to.version}`);

            // validate() only warns when Compose cannot resolve the project; here
            // that is the new pin failing.
            const resolved = await io.busy('Resolving the Compose project', () =>
                composeConfig(io, dir),
            );
            if (!resolved.ok) {
                throw new CliError(
                    `Compose cannot resolve the project with Ghost ${to.version}: ${resolved.reason}`,
                );
            }
            const findings = await io.busy('Validating the configuration', () => validate(io, dir));
            const errors = findingErrors(findings);
            if (errors) {
                throw new CliError(
                    `the configuration does not validate with Ghost ${to.version}:\n${errors}`,
                );
            }
            ok(io, 'configuration', `valid with Ghost ${to.version}`);
        },
        // Pulled before the site stopped.
        async pull() {},
    };
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

export type NeedsOperator = Extract<UpdateOutcome, { state: 'needs-operator' }>;

/** One way out for the operator: what it does, and the commands, run in the site directory. */
export interface RecoveryChoice {
    readonly does: string;
    readonly commands: readonly string[];
}

/**
 * What the operator needs after a Ghost update that needs them, whoever ran
 * it: the CLI prints it, the supervisor records it as the job's diagnostic.
 * Paths are relative to the site.
 */
export interface RecoveryAdvice {
    /** What recovery could not do, then what state the site is in. */
    readonly facts: readonly string[];
    /** Empty when there is nothing safe to suggest beyond the facts. */
    readonly choices: readonly RecoveryChoice[];
    /** Where the files as they were are kept, to remove once the site is right. */
    readonly snapshot: string;
}

export function recoveryAdvice(
    { site, from, to }: Pick<GhostUpdate, 'site' | 'from' | 'to'>,
    outcome: NeedsOperator,
): RecoveryAdvice {
    const { servicesChanged, filesBack, problems, running } = outcome;
    const backup = outcome.backup === null ? null : relative(site.dir, outcome.backup);
    const snapshot = relative(site.dir, outcome.snapshot);
    const restore: RecoveryChoice[] =
        backup === null
            ? []
            : [
                  {
                      does: `Put the site back on Ghost ${from.version} as it was when the update began, discarding anything written since`,
                      commands: [`./ghost-docker restore --yes ${backup}`],
                  },
              ];
    const facts = [...problems];
    let choices: RecoveryChoice[];
    if (servicesChanged) {
        facts.push(
            `Ghost ${to.version} started before the update failed, so it may have migrated the database and accepted writes${backup === null ? '' : ' since the backup'}. Nothing was loaded over them: the data is as the update left it.`,
            `The configuration still names Ghost ${to.version}: switching back to ${from.version} would not undo its migrations.`,
        );
        // Once recovery itself failed, starting Ghost again is not safe to suggest.
        choices =
            problems.length > 0
                ? restore
                : [
                      ...restore,
                      {
                          does: `Find why Ghost ${to.version} did not start, fix it, and start it`,
                          commands: [
                              'docker compose logs ghost',
                              'docker compose up -d',
                              './ghost-docker check',
                          ],
                      },
                  ];
    } else if (filesBack) {
        facts.push(
            `Ghost ${to.version} never started, and the files are as they were before the update, naming Ghost ${from.version}.`,
        );
        choices = [
            {
                does: `Start the site on Ghost ${from.version} again, as it was`,
                commands: ['docker compose up -d', './ghost-docker check'],
            },
        ];
    } else {
        facts.push(
            `Ghost ${to.version} never started, but the files may already name it: starting the site now would start Ghost ${to.version}.`,
        );
        choices = [
            {
                does: `Put the files back first, then start the site on Ghost ${from.version}`,
                commands: [
                    `cp -a ${snapshot}/files/. .`,
                    'docker compose up -d',
                    './ghost-docker check',
                ],
            },
        ];
    }
    facts.push(describeServices(running));
    return { facts, choices, snapshot };
}

/** A failed update, as the operator needs to hear it. */
function failed(
    { io, site, from, to }: GhostUpdate,
    outcome: Exclude<UpdateOutcome, { state: 'done' }>,
): never {
    const dir = site.dir;
    const backup = outcome.backup === null ? null : relative(dir, outcome.backup);
    const kept =
        backup === null ? [] : [`The backup taken before the update is kept in ${backup}.`];
    if (outcome.state === 'restored') {
        const { resumed } = outcome;
        io.stderr(
            [
                '',
                `Restored: the site is back on Ghost ${from.version}, with its files as they were` +
                    (resumed.length > 0
                        ? `. Its services were not changed; ${resumed.join(' and ')}, stopped for the update, ${resumed.length > 1 ? 'are' : 'is'} running again.`
                        : '. Its services were not changed.'),
                ...kept,
                '',
            ].join('\n'),
        );
        throw new CliError(`the update failed; Ghost ${from.version} was restored.`);
    }

    const advice = recoveryAdvice({ site, from, to }, outcome);
    const lines = ['', 'The site needs you.', ...advice.facts.map((fact) => `  ${fact}`), ''];
    if (advice.choices.length === 0) {
        lines.push(...kept, '');
    }
    if (advice.choices.length > 0) {
        lines.push(
            advice.choices.length === 1
                ? 'In the site directory:'
                : 'Choose one, in the site directory:',
        );
        for (const choice of advice.choices) {
            lines.push(
                `  - ${choice.does}:`,
                ...choice.commands.map((command) => `      ${command}`),
            );
        }
        lines.push('');
    }
    lines.push(
        `The files as they were before the update are in ${advice.snapshot}/files.`,
        `Once the site is as it should be (./ghost-docker check), remove ${advice.snapshot}.`,
        '',
    );
    io.stderr(lines.join('\n'));
    throw new CliError('the update failed, and the site needs the operator.');
}
