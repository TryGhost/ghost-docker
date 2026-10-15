// Which updates the status offers, and which it only describes
// (docs/upgrade-supervisor.md#available-updates).
//
// Ghost is found as `update --check` finds it: by pulling the site's major tag
// and reading the version the image declares, never by trusting a tag name.
// A component whose check fails keeps its last result for a day, then offers
// nothing one-click: an update is only offered while it is known to exist.
import { gt, major, minor, valid } from 'semver';
import { pullImage, runOnce, splitReference } from '../docker/client.ts';
import { resolveGhost, variantOf } from '../ghost.ts';
import type { Io } from '../io.ts';
import type { Metadata } from '../meta.ts';
import { compareReleases, isRelease } from '../release.ts';
import { diagnostic } from './diagnostics.ts';
import type { ManualUpdate, OneClickUpdate, UpgradeDiagnostic } from './protocol.ts';
import type { Discovery, Pin } from './store.ts';

/** How often discovery runs while nothing asks for it. */
export const DISCOVERY_EVERY_MS = 6 * 60 * 60_000;
/** How long a component's last result stands in for a failed check. */
export const DISCOVERY_KEPT_MS = 24 * 60 * 60_000;

export const POLICIES = ['minor', 'patch'] as const;
export type Policy = (typeof POLICIES)[number];

export const parsePolicy = (value: string | undefined): Policy | null =>
    value === undefined || value === ''
        ? 'minor'
        : (POLICIES as readonly string[]).includes(value)
          ? (value as Policy)
          : null;

interface Found {
    readonly oneClick: OneClickUpdate[];
    readonly manual: ManualUpdate[];
    readonly pins: Pin[];
}

const NOTHING: Found = { oneClick: [], manual: [], pins: [] };

const OPERATOR_GUIDE = 'https://github.com/TryGhost/ghost-docker/blob/next-docker/docs/install.md';

/** The Ghost updates of the site's major and the next one. */
async function ghostUpdates(io: Io, metadata: Metadata, policy: Policy): Promise<Found> {
    const from = metadata.ghost;
    if (valid(from.version) === null) {
        return NOTHING;
    }
    const variant = variantOf(from.tag);
    const current = major(from.version);
    const found: Found = { oneClick: [], manual: [], pins: [] };

    const latest = await resolveGhost(io, `${current}-${variant}`, from.image);
    if (
        valid(latest.version) !== null &&
        major(latest.version) === current &&
        gt(latest.version, from.version)
    ) {
        const entry = { component: 'ghost', fromVersion: from.version, toVersion: latest.version };
        if (policy === 'patch' && minor(latest.version) !== minor(from.version)) {
            found.manual.push({
                ...entry,
                reason: 'This host allows patch updates of Ghost from Admin, and this is a minor update.',
                steps: [`In the site directory, run \`./ghost-docker update ${latest.version}\``],
            });
        } else {
            found.oneClick.push(entry);
            found.pins.push({
                component: 'ghost',
                toVersion: latest.version,
                target: { image: latest.image, tag: latest.tag, digest: latest.digest },
            });
        }
    }

    let next;
    try {
        next = await resolveGhost(io, `${current + 1}-${variant}`, from.image);
    } catch {
        // No such major yet: the usual case.
        return found;
    }
    if (valid(next.version) !== null && major(next.version) === current + 1) {
        found.manual.push({
            component: 'ghost',
            fromVersion: from.version,
            toVersion: next.version,
            reason: `Ghost ${current + 1} is a major upgrade, which is never run from Admin.`,
            steps: [
                `ghost-docker does not yet upgrade a site across Ghost major versions. Follow the operator guide: ${OPERATOR_GUIDE}`,
            ],
        });
    }
    return found;
}

/** A newer release of the stack on the site's channel; image installations only. */
async function stackUpdates(io: Io, metadata: Metadata): Promise<Found> {
    const { version, image } = metadata.stack;
    if (
        metadata.source !== 'image' ||
        version === null ||
        image === null ||
        metadata.channel === null
    ) {
        return NOTHING;
    }
    const { repository } = splitReference(image);
    const channelImage = `${repository}:${metadata.channel}`;
    await pullImage(io.docker, repository, metadata.channel);
    const read = await runOnce(io.docker, {
        image: channelImage,
        entrypoint: ['cat'],
        cmd: ['/opt/ghost-docker/VERSION.json'],
        network: 'none',
        timeoutMs: 60_000,
    });
    if (read.status !== 0) {
        throw new Error(
            `${channelImage} could not be read: ${read.stderr.trim() || 'it did not run'}`,
        );
    }
    const newest = (JSON.parse(read.stdout) as { version?: unknown }).version;
    if (
        typeof newest !== 'string' ||
        !isRelease(newest) ||
        !isRelease(version) ||
        compareReleases(newest, version) <= 0
    ) {
        return NOTHING;
    }
    return {
        oneClick: [],
        pins: [],
        manual: [
            {
                component: 'stack',
                fromVersion: version,
                toVersion: newest,
                reason: 'A stack update replaces the upgrade supervisor itself, so it runs on the host.',
                steps: ['In the site directory, run `./ghost-docker self-update`'],
            },
        ],
    };
}

export interface DiscoverInput {
    readonly io: Io;
    readonly metadata: Metadata;
    readonly policy: Policy;
    readonly previous: Discovery | undefined;
    readonly now: Date;
}

export type Discoverer = (input: DiscoverInput) => Promise<Discovery>;

const CHECKS: Record<string, (input: DiscoverInput) => Promise<Found>> = {
    ghost: ({ io, metadata, policy }) => ghostUpdates(io, metadata, policy),
    stack: ({ io, metadata }) => stackUpdates(io, metadata),
};

/** Every component checked; a failed one keeps its last result for DISCOVERY_KEPT_MS, without one-click entries after. */
export const discover: Discoverer = async (input) => {
    const { previous, now } = input;
    const checkedAt = now.toISOString();
    const oneClick: OneClickUpdate[] = [];
    const manual: ManualUpdate[] = [];
    const pins: Pin[] = [];
    const diagnostics: UpgradeDiagnostic[] = [];
    const succeededAt: Record<string, string> = {};
    for (const [component, check] of Object.entries(CHECKS)) {
        try {
            const found = await check(input);
            oneClick.push(...found.oneClick);
            manual.push(...found.manual);
            pins.push(...found.pins);
            succeededAt[component] = checkedAt;
        } catch (error) {
            const last = previous?.succeededAt[component];
            diagnostics.push(
                diagnostic(
                    'discovery-failed',
                    'warning',
                    `Could not check for ${component} updates; showing what was found ${last ? `at ${last}` : 'before, if anything'}.`,
                    (error as Error).message,
                ),
            );
            if (last === undefined || previous === undefined) {
                continue;
            }
            succeededAt[component] = last;
            const fresh = now.getTime() - Date.parse(last) < DISCOVERY_KEPT_MS;
            if (fresh) {
                oneClick.push(
                    ...previous.oneClick.filter((entry) => entry.component === component),
                );
                pins.push(...previous.pins.filter((pin) => pin.component === component));
            }
            manual.push(...previous.manual.filter((entry) => entry.component === component));
        }
    }
    return {
        checkedAt,
        currentVersion: input.metadata.ghost.version,
        oneClick,
        manual,
        pins,
        succeededAt,
        diagnostics,
    };
};
