// An update of a site's Ghost, whoever runs it: `update` (commands/update.ts)
// and the supervisor's job (supervisor/job.ts). Each picks the target its own
// way, `update` by tag and the supervisor by the digest discovery approved,
// and keeps its own lock and backup policy; everything decided between
// reading the site and changing it is decided here, once.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compare, major, valid } from 'semver';
import { refuseDrift } from './backup.ts';
import { requireValid } from './config.ts';
import * as env from './env.ts';
import { CliError } from './errors.ts';
import { atomicWrite } from './fs.ts';
import { ghostChannelOf, pinnedCreated, type ResolvedGhost } from './ghost.ts';
import type { Io } from './io.ts';
import { requireMetadata, siteFiles, writeMetadata, type Metadata } from './meta.ts';
import { describeServices } from './recovery.ts';
import { resolveSite } from './resolved.ts';
import { heading, ok } from './report.ts';
import { ENV_FILE, META_FILE, type SiteFacts, type SiteSettings } from './site.ts';
import type { RecoveryAdvice, RecoveryChoice, UpdateOutcome, UpdatePlan } from './update.ts';

/**
 * A refusal before anything has changed. `code` names it in a supervisor
 * job's diagnostic; `update` prints the message like any other error.
 */
export class Refused extends CliError {
    readonly code: string;

    constructor(code: string, message: string) {
        super(`${message}\n  Nothing has been changed.`);
        this.code = code;
    }
}

/** The Ghost a site runs, as its metadata records it. */
export interface Pin {
    readonly image: string;
    readonly tag: string;
    readonly version: string;
    readonly digest: string;
}

export const reference = (pin: Pin): string => `${pin.image}@${pin.digest}`;

/**
 * The Ghost the site runs, as its metadata records it, once `.env` pins the
 * same image: what every update moves from. `who` is the one asking.
 */
export function siteGhost(
    dir: string,
    settings: SiteSettings,
    who: string,
): { readonly metadata: Metadata; readonly from: Pin } {
    const metadata = requireMetadata(dir, `${who} cannot tell which Ghost the site runs`);
    const from: Pin = metadata.ghost;
    const pinned = settings.get('GHOST_IMAGE_REF');
    if (pinned !== reference(from)) {
        throw new Refused(
            'pin-mismatch',
            `${META_FILE} records Ghost ${from.version} as ${reference(from)}, but ${ENV_FILE} pins ` +
                `GHOST_IMAGE_REF=${pinned || '(nothing)'}.\n` +
                '  An update moves the pin it recorded, and cannot tell which of the two the site runs. Put\n' +
                `  GHOST_IMAGE_REF back to ${reference(from)}.`,
        );
    }
    if (valid(from.version) === null) {
        throw new Refused(
            'version-invalid',
            `${META_FILE} records Ghost ${from.version}, which is not a version update can order.`,
        );
    }
    return { metadata, from };
}

/**
 * Where `to` is from the site's Ghost, once it is `version`, when one was
 * asked for: by the operator, or by the job discovery approved.
 */
export async function directionTo(
    io: Io,
    from: Pin,
    to: ResolvedGhost,
    version: string | null,
): Promise<Direction> {
    if (version !== null && to.version !== version) {
        throw new Refused(
            'target-mismatch',
            `${to.image}:${to.tag} is Ghost ${to.version}, not ${version}.`,
        );
    }
    return order(io, from, to);
}

/** Refuses what the backup would refuse, before the update changes anything. */
export async function refuseSiteDrift(io: Io, dir: string): Promise<void> {
    await refuseDrift(
        io,
        await io.busy('Resolving the Compose project', () => resolveSite(io, dir)),
    );
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

            await requireValid(io, dir, `Ghost ${to.version}`);
        },
        // Pulled before the site stopped.
        async pull() {},
    };
}

export type NeedsOperator = Extract<UpdateOutcome, { state: 'needs-operator' }>;

/** The advice after a Ghost update that needs the operator (update.ts's RecoveryAdvice). */
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
