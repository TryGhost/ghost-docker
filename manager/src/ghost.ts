// Resolving the Ghost image a site runs to one exact artifact.
//
// The requested tag is pulled, and the pulled image is asked for its
// repository digest, its own version and its layout. Only the layout of the
// `next` variants is supported: an image installed by Ghost-CLI, as the older
// `-alpine` variants are, is refused. The pin written is `ghost@sha256:...`: a tag can move between two
// requests and on the next `docker compose pull`; a digest cannot. Changing
// GHOST_VERSION alone never changes what a site runs.
import { gte, valid } from 'semver';
import { DaemonError, inspectImage, pullImage } from './docker/client.ts';
import { DaemonTimeout, DaemonUnreachable } from './docker/transport.ts';
import { CliError } from './errors.ts';
import type { Io } from './io.ts';

export const DEFAULT_IMAGE = 'ghost';
/** The `next` variants install Ghost directly under /home/ghost. */
export const DEFAULT_TAG = '6-next-alpine';
const DEFAULT_VARIANT = DEFAULT_TAG.slice(DEFAULT_TAG.indexOf('-') + 1);
/**
 * The oldest Ghost an import accepts: 6.61.0 is the first release published
 * as a `next` image (amd64 and arm64), and an import runs at exactly the
 * source's version. `ghost migrate-export` refuses older sources too.
 */
export const MINIMUM_IMPORT_VERSION = '6.61.0';

/**
 * What the operator asked for, as a tag. A bare version selects the default
 * variant (`6.3.1` is `6.3.1-next-alpine`); anything else is a tag already.
 */
/**
 * The first Ghost release with HttpUpgradeAdapter, the upgrade
 * supervisor's Ghost end (docs/upgrade-supervisor.md#installation); null
 * until Ghost releases it. Below it, install leaves the adapter off: an older
 * Ghost has no `upgrade` adapter type to load.
 */
export const MINIMUM_UPGRADE_ADAPTER: string | null = null;

export const hasUpgradeAdapter = (version: string): boolean =>
    MINIMUM_UPGRADE_ADAPTER !== null &&
    valid(version) !== null &&
    gte(version, MINIMUM_UPGRADE_ADAPTER);

/** Ghost's settings for the adapter, in ghost.env. */
export const UPGRADE_ADAPTER: readonly (readonly [string, string])[] = [
    ['adapters__upgrade__active', 'HttpUpgradeAdapter'],
    ['adapters__upgrade__HttpUpgradeAdapter__socketPath', '/run/ghost-upgrade/supervisor.sock'],
];

export function ghostTag(requested: string | undefined, variant = DEFAULT_VARIANT): string {
    if (!requested) {
        return DEFAULT_TAG;
    }
    const bare = requested.replace(/^v/, '');
    if (/^\d+(\.\d+)*$/.test(bare)) {
        return `${bare}-${variant}`;
    }
    return requested;
}

/** The variant a tag names, `next-alpine` in `6.61.0-next-alpine`; the default for a bare version. */
export function variantOf(tag: string): string {
    const match = /^v?\d+(?:\.\d+)*-(.+)$/.exec(tag);
    return match?.[1] ?? DEFAULT_VARIANT;
}

export interface ResolvedGhost {
    readonly image: string;
    readonly tag: string;
    /** As the image reports it, in its GHOST_VERSION. */
    readonly version: string;
    readonly digest: string;
    /** `ghost@sha256:...`, what GHOST_IMAGE_REF pins. */
    readonly reference: string;
    readonly contentPath: string;
    readonly tinybirdPath: string;
}

const describeDaemonError = (error: unknown): string =>
    error instanceof DaemonError ||
    error instanceof DaemonUnreachable ||
    error instanceof DaemonTimeout
        ? error.message
        : String(error);

export async function resolveGhost(
    io: Io,
    requested: string | undefined,
    image = DEFAULT_IMAGE,
): Promise<ResolvedGhost> {
    const tag = ghostTag(requested);
    return pullAndDescribe(io, image, tag, tag);
}

/**
 * Exactly `image@digest`, recorded under `tag`, the tag it was found by: what
 * the supervisor discovered, so a job runs that image and not whatever the
 * tag points to by then.
 */
export const resolvePinned = (
    io: Io,
    image: string,
    tag: string,
    digest: string,
): Promise<ResolvedGhost> => pullAndDescribe(io, image, digest, tag);

/** `image` pulled at `ref` (a tag or a digest), and what it is. */
async function pullAndDescribe(
    io: Io,
    image: string,
    ref: string,
    tag: string,
): Promise<ResolvedGhost> {
    const wanted = ref.startsWith('sha256:') ? `${image}@${ref}` : `${image}:${ref}`;

    try {
        await pullImage(io.docker, image, ref);
    } catch (error) {
        throw new CliError(
            `${wanted} could not be pulled: ${describeDaemonError(error)}.\n` +
                '  Check the version, and that this host can reach the registry.',
        );
    }
    const pulled = await inspectImage(io.docker, wanted);
    // The pin is the digest of what was just pulled, read from the image
    // itself rather than inferred from another tag.
    const reference = pulled?.repoDigests.find((entry) =>
        ref.startsWith('sha256:') ? entry === wanted : entry.startsWith(`${image}@`),
    );
    if (pulled === null || reference === undefined) {
        throw new CliError(`${wanted} has no repository digest; refusing an unpinned install`);
    }
    const digest = reference.slice(image.length + 1);
    const version = pulled.env.GHOST_VERSION;
    if (!version) {
        throw new CliError(
            `${wanted} does not declare GHOST_VERSION; it does not look like a Ghost image`,
        );
    }
    if (pulled.env.GHOST_CLI_INSTALL) {
        throw new CliError(
            `${wanted} is installed by Ghost-CLI, a layout this release does not run.\n` +
                `  Use a \`next\` variant instead, such as ${image}:${DEFAULT_TAG}.`,
        );
    }
    const contentPath = pulled.env.GHOST_CONTENT || '/home/ghost/content';
    const install = pulled.env.GHOST_INSTALL || '/home/ghost';
    return {
        image,
        tag,
        version,
        digest,
        reference,
        contentPath,
        tinybirdPath: `${install}/core/server/data/tinybird`,
    };
}

/**
 * The image of exactly `version`, for an import, which happens at the source
 * site's version: the default variant of that release, a prerelease too. An
 * image reporting any other version is refused.
 */
export async function resolveExactGhost(
    io: Io,
    version: string,
    image = DEFAULT_IMAGE,
): Promise<ResolvedGhost> {
    const tag = `${version}-${DEFAULT_VARIANT}`;
    let resolved: ResolvedGhost;
    try {
        resolved = await resolveGhost(io, tag, image);
    } catch (error) {
        throw new CliError(
            `no ${image} image for Ghost ${version} could be used:\n` +
                `  ${(error as Error).message.split('\n')[0]}\n` +
                '  An import runs at the exact version of the source site. Check that this host can\n' +
                '  reach the registry.',
        );
    }
    if (resolved.version !== version) {
        throw new CliError(
            `${image}:${tag} is Ghost ${resolved.version}, but the bundle was exported from Ghost ${version}`,
        );
    }
    return resolved;
}
