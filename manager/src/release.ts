// Releases of the stack, as the manager sees them: which tags are releases,
// how they are ordered, and which channel a version belongs to (plan §2.7).
//
// Only `vX.Y.Z` and `vX.Y.Z-beta.N` are releases, and they are ordered by
// semver: v1.10.0 follows v1.9.0, beta.10 follows beta.2, and a release
// follows every beta of its own version. Cutting releases is the release
// workflow's, in scripts/.
import { compare } from 'semver';

export const CHANNELS = ['stable', 'beta'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Stricter than semver: only the formats that are published. */
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-beta\.(0|[1-9]\d*))?$/;

export const isRelease = (tag: string): boolean => TAG.test(tag);

/** Negative when `a` is the older release, zero when they are the same. Both must be releases. */
export const compareReleases = (a: string, b: string): number => compare(a, b);

/** `vX.Y.Z` is stable, a `-beta.N` is beta, `edge-...` is edge; anything else is no channel. */
export function channelOf(version: string): Channel | 'edge' | null {
    if (isRelease(version)) {
        return version.includes('-beta.') ? 'beta' : 'stable';
    }
    return version.startsWith('edge') ? 'edge' : null;
}
