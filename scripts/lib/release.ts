// Cutting releases of the stack, for the release workflows (plan §2.7).
//
// Only `vX.Y.Z` and `vX.Y.Z-beta.N` are releases, ordered by semver: v1.10.0
// follows v1.9.0, beta.10 follows beta.2, and a release follows every beta of
// its own version. The manager has its own copy of the first two rules
// (manager/src/release.ts), which is all it needs.
//
// The rest follows Ghost and Ghost-CLI: the next version is worked out from
// the commits since the last release (a ✨ feature makes it a minor, anything
// else a patch, dependency updates included), and the release notes are the
// commits that carry a release-note emoji.
import semver from 'semver';

export const CHANNELS = ['stable', 'beta'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Stricter than semver: only the formats that are published. */
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-beta\.(0|[1-9]\d*))?$/;

export const isRelease = (tag: string): boolean => TAG.test(tag);

const isBeta = (tag: string): boolean => tag.includes('-beta.');

/** Is this release on the channel? Beta includes releases; stable has no betas. */
const onChannel = (tag: string, channel: Channel): boolean => channel === 'beta' || !isBeta(tag);

/** Every release among `tags`, oldest first; anything else is ignored. */
export const releases = (tags: Iterable<string>): string[] =>
    semver.sort([...new Set([...tags].map((tag) => tag.trim()).filter(isRelease))]);

/** The newest release on a channel among `tags`, or null when there is none. */
export function newest(tags: Iterable<string>, channel: Channel): string | null {
    return (
        releases(tags)
            .filter((tag) => onChannel(tag, channel))
            .at(-1) ?? null
    );
}

/**
 * The channels whose moving tag `tag` should take, given every release tag
 * there is (`tag` included or not): those it is the newest release on.
 */
export function movingTags(tag: string, tags: Iterable<string>): Channel[] {
    if (!isRelease(tag)) {
        return [];
    }
    const all = [...tags, tag];
    return CHANNELS.filter((channel) => onChannel(tag, channel) && newest(all, channel) === tag);
}

/** The release before `tag`: the newest older one, and for a release, the newest older release. */
export function previousRelease(tag: string, tags: Iterable<string>): string | null {
    const channel = isBeta(tag) ? 'beta' : 'stable';
    return newest(
        releases(tags).filter((other) => semver.lt(other, tag)),
        channel,
    );
}

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
const FIRST = '0.1.0';

/** `vX.Y.Z-beta.N` → `X.Y.Z`. */
const core = (tag: string): string => {
    const parsed = semver.parse(tag)!;
    return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
};

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
    const all = releases(tags);
    const stable = newest(all, 'stable');
    let target = all.length === 0 ? FIRST : semver.inc(stable ?? '0.0.0', bump)!;
    // Betas newer than the newest release lead to the version they are betas of.
    const leading = all.filter((tag) => isBeta(tag) && (!stable || semver.gt(tag, stable))).at(-1);
    if (leading && semver.gte(core(leading), target)) {
        target = core(leading);
    } else if (!stable && semver.gt(FIRST, target)) {
        target = FIRST;
    }
    if (!beta) {
        return `v${target}`;
    }
    const betas = all
        .filter((tag) => isBeta(tag) && core(tag) === target)
        .map((tag) => Number(semver.prerelease(tag)![1]));
    return `v${target}-beta.${Math.max(0, ...betas) + 1}`;
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
