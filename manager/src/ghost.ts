// Resolving the Ghost image a site runs to one exact artifact.
//
// The requested tag is pulled, and the pulled image is asked for its
// repository digest, its own version and its layout. The pin written is `ghost@sha256:...`: a tag can move between two
// requests and on the next `docker compose pull`; a digest cannot. Changing
// GHOST_VERSION alone never changes what a site runs.
import { DaemonError, inspectImage, pullImage } from './docker/client.ts';
import { DaemonTimeout, DaemonUnreachable } from './docker/transport.ts';
import { CliError } from './errors.ts';
import type { Io } from './io.ts';

export const DEFAULT_IMAGE = 'ghost';
/** The `next` variants install Ghost directly under /home/ghost. */
export const DEFAULT_TAG = '6-next-alpine';

/**
 * What the operator asked for, as a tag. A bare version selects the default
 * variant (`6.3.1` is `6.3.1-next-alpine`); anything else is a tag already.
 */
export function ghostTag(requested: string | undefined): string {
    if (!requested) {
        return DEFAULT_TAG;
    }
    const bare = requested.replace(/^v/, '');
    if (/^\d+(\.\d+)*$/.test(bare)) {
        return `${bare}-${DEFAULT_TAG.slice(DEFAULT_TAG.indexOf('-') + 1)}`;
    }
    return requested;
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
    const wanted = `${image}:${tag}`;

    try {
        await pullImage(io.docker, image, tag);
    } catch (error) {
        throw new CliError(
            `${wanted} could not be pulled: ${describeDaemonError(error)}.\n` +
                '  Check the version, and that this host can reach the registry.',
        );
    }
    const pulled = await inspectImage(io.docker, wanted);
    // The pin is the digest of what was just pulled, read from the image
    // itself rather than inferred from another tag.
    const reference = pulled?.repoDigests.find((entry) => entry.startsWith(`${image}@`));
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
    const contentPath = pulled.env.GHOST_CONTENT || '/home/ghost/content';
    const install = pulled.env.GHOST_INSTALL || '/home/ghost';
    return {
        image,
        tag,
        version,
        digest,
        reference,
        contentPath,
        tinybirdPath: tinybirdPath(install, pulled.env),
    };
}

/**
 * The image of exactly `version`, for an import, which happens at the source
 * site's version. The default variant is tried first; older releases were
 * only published in the previous layout (`-alpine`), so that is tried when
 * the default has none. An image reporting any other version is refused.
 */
export async function resolveExactGhost(
    io: Io,
    version: string,
    image = DEFAULT_IMAGE,
): Promise<ResolvedGhost> {
    const tags = [...new Set([ghostTag(version), `${version}-alpine`])];
    const problems: string[] = [];
    for (const tag of tags) {
        let resolved: ResolvedGhost;
        try {
            resolved = await resolveGhost(io, tag, image);
        } catch (error) {
            problems.push(`  ${(error as Error).message.split('\n')[0]}`);
            continue;
        }
        if (resolved.version !== version) {
            throw new CliError(
                `${image}:${tag} is Ghost ${resolved.version}, but the bundle was exported from Ghost ${version}`,
            );
        }
        return resolved;
    }
    throw new CliError(
        `no ${image} image for Ghost ${version} could be used:\n${problems.join('\n')}\n` +
            '  An import runs at the exact version of the source site. Check that this host can\n' +
            '  reach the registry; if that version has no image, run `ghost update` in the source\n' +
            '  installation and export it again.',
    );
}

/**
 * Where the image keeps the Tinybird datafiles. The older layout, installed
 * by Ghost-CLI (which the image declares in GHOST_CLI_INSTALL), keeps Ghost
 * under `current/`; the `next` variants install it directly.
 */
const tinybirdPath = (install: string, env: Readonly<Record<string, string>>): string =>
    env.GHOST_CLI_INSTALL
        ? `${install}/current/core/server/data/tinybird`
        : `${install}/core/server/data/tinybird`;
