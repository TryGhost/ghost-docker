// Releases of the stack: which tags are releases, how they are ordered, and
// which channel a version belongs to (plan §2.7).
//
// Only `vX.Y.Z` and `vX.Y.Z-beta.N` are releases. They are ordered by their
// numbers, never lexically: v1.10.0 follows v1.9.0, beta.10 follows beta.2,
// and a release follows every beta of its own version.
//
// Cutting a release follows Ghost and Ghost-CLI: the next version is worked
// out from the commits since the last release (a ✨ feature makes it a minor,
// anything else a patch, dependency updates included), and the release notes
// are the commits that carry a release-note emoji. manager/scripts/release.ts runs
// these for the release workflow, so this module imports nothing outside Node.

export const CHANNELS = ['stable', 'beta'] as const;
export type Channel = (typeof CHANNELS)[number];

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;

export interface Release {
    readonly tag: string;
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    /** The beta number, or null for a release. */
    readonly beta: number | null;
}

/** A release tag, or null for anything that is not one. */
export function parseRelease(tag: string): Release | null {
    const match = TAG.exec(tag);
    if (!match) {
        return null;
    }
    const [, major, minor, patch, beta] = match;
    return {
        tag,
        major: Number(major),
        minor: Number(minor),
        patch: Number(patch),
        beta: beta === undefined ? null : Number(beta),
    };
}

export const isRelease = (tag: string): boolean => parseRelease(tag) !== null;

/** Negative when `a` is older than `b`, zero when they are the same release. */
export function compareReleases(a: Release, b: Release): number {
    return (
        a.major - b.major ||
        a.minor - b.minor ||
        a.patch - b.patch ||
        // A release follows its own betas.
        (a.beta === null ? 1 : 0) - (b.beta === null ? 1 : 0) ||
        (a.beta ?? 0) - (b.beta ?? 0)
    );
}

/** Is this release on the channel? Beta includes releases; stable has no betas. */
export const onChannel = (release: Release, channel: Channel): boolean =>
    channel === 'beta' || release.beta === null;

/** The newest release on a channel among `tags`, ignoring anything that is not one. */
export function newest(tags: Iterable<string>, channel: Channel): string | null {
    let best: Release | null = null;
    for (const tag of tags) {
        const release = parseRelease(tag.trim());
        if (
            release &&
            onChannel(release, channel) &&
            (!best || compareReleases(release, best) > 0)
        ) {
            best = release;
        }
    }
    return best?.tag ?? null;
}

/**
 * The channels whose moving tag `tag` should take, given every release tag
 * there is (`tag` included or not): those it is the newest release on.
 */
export function movingTags(tag: string, tags: Iterable<string>): Channel[] {
    const release = parseRelease(tag);
    if (!release) {
        return [];
    }
    const all = [...tags, tag];
    return CHANNELS.filter(
        (channel) => onChannel(release, channel) && newest(all, channel) === tag,
    );
}

/** `vX.Y.Z` is stable, a `-beta.N` is beta, `edge-...` is edge; anything else is no channel. */
export function channelOf(version: string): Channel | 'edge' | null {
    const release = parseRelease(version);
    if (release) {
        return release.beta === null ? 'stable' : 'beta';
    }
    return version.startsWith('edge') ? 'edge' : null;
}

// --- Cutting a release --------------------------------------------------------

export const BUMPS = ['auto', 'patch', 'minor', 'major'] as const;
export type Bump = (typeof BUMPS)[number];

/** Commits carrying one of these are a user-facing feature: a minor release. */
const FEATURE_MARKERS = ['✨', '🎉', ':sparkles:'];

/** `auto` is minor when a commit is a feature, otherwise patch. */
export function resolveBump(commits: readonly string[], bump: Bump): Exclude<Bump, 'auto'> {
    if (bump !== 'auto') {
        return bump;
    }
    return commits.some((commit) => FEATURE_MARKERS.some((marker) => commit.includes(marker)))
        ? 'minor'
        : 'patch';
}

/** The first release of all. */
const FIRST = { major: 0, minor: 1, patch: 0 };

type Core = Pick<Release, 'major' | 'minor' | 'patch'>;

const compareCores = (a: Core, b: Core): number =>
    a.major - b.major || a.minor - b.minor || a.patch - b.patch;

const format = (core: Core, beta: number | null): string =>
    `v${core.major}.${core.minor}.${core.patch}${beta === null ? '' : `-beta.${beta}`}`;

/**
 * The next release after `tags`. The bump is applied to the newest release
 * that is not a beta (none counts as 0.0.0): that is the version the next
 * release would have. A beta is a beta of that version, unless betas of a
 * newer one are already out, in which case it is the next of those. A
 * release that is not a beta is that version, or the version the newest
 * betas lead to when that is newer.
 */
export function nextRelease(
    tags: Iterable<string>,
    bump: Exclude<Bump, 'auto'>,
    beta: boolean,
): string {
    const all = [...tags]
        .map((tag) => parseRelease(tag.trim()))
        .filter((release) => release !== null);
    if (all.length === 0) {
        return format(FIRST, beta ? 1 : null);
    }
    const stable = all
        .filter((release) => release.beta === null)
        .sort(compareReleases)
        .at(-1);
    const base: Core = stable ?? { major: 0, minor: 0, patch: 0 };
    const bumped: Core =
        bump === 'major'
            ? { major: base.major + 1, minor: 0, patch: 0 }
            : bump === 'minor'
              ? { major: base.major, minor: base.minor + 1, patch: 0 }
              : { major: base.major, minor: base.minor, patch: base.patch + 1 };
    // Betas newer than the newest release lead to the version they are betas of.
    const leading = all
        .filter(
            (release) => release.beta !== null && (!stable || compareReleases(release, stable) > 0),
        )
        .sort(compareReleases)
        .at(-1);
    let target = bumped;
    if (leading && compareCores(leading, target) >= 0) {
        target = leading;
    } else if (!stable && compareCores(FIRST, target) > 0) {
        target = FIRST;
    }
    if (!beta) {
        return format(target, null);
    }
    const betas = all.filter(
        (release) => release.beta !== null && compareCores(release, target) === 0,
    );
    return format(target, Math.max(0, ...betas.map((release) => release.beta!)) + 1);
}

/** Highest first: these are the only commits release notes include. */
export const NOTE_EMOJIS = ['🔒', '✨', '💄', '🎨', '🐛', '💡'];

export const NO_NOTES =
    'This release contains fixes for minor bugs and issues reported by Ghost users.';

/**
 * Release notes, in the shape Ghost's and Ghost-CLI's are: the commits that
 * start with a release-note emoji, most significant first, then a link to
 * the full comparison. `lines` are `* <summary> - <author>`.
 */
export function releaseNotes(
    lines: readonly string[],
    from: string | null,
    to: string,
    repository = 'https://github.com/TryGhost/ghost-docker',
): string {
    const emoji = (line: string) => /^\* (.)/u.exec(line)?.[1] ?? '';
    const selected = [...new Set(lines.filter((line) => NOTE_EMOJIS.includes(emoji(line))))].sort(
        (a, b) => NOTE_EMOJIS.indexOf(emoji(a)) - NOTE_EMOJIS.indexOf(emoji(b)),
    );
    const body = selected.length > 0 ? selected.join('\n') : NO_NOTES;
    const link =
        from === null ? `${repository}/commits/${to}` : `${repository}/compare/${from}...${to}`;
    return `${body}\n\n---\n\nView the changelog for full details: ${link}\n`;
}
