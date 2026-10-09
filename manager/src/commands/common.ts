// What every command about an installed site starts with.
import { z } from 'zod';
import { refused } from '../command.ts';
import { loadContext, type Context } from '../context.ts';
import { CliError } from '../errors.ts';
import type { Io } from '../io.ts';
import type { Metadata } from '../meta.ts';
import { channelOf, CHANNELS, isRelease, type Channel } from '../release.ts';
import { ENV_FILE, readSettings, siteFacts, type SiteFacts } from '../site.ts';
import { managerVersion } from '../versions.ts';

export interface InstalledSite {
    readonly context: Context;
    readonly site: SiteFacts;
}

/**
 * The launcher's context. The manager must be working in the directory the
 * launcher mounted, or every bind mount would resolve to somewhere else.
 */
export function siteContext(io: Io): Context {
    const context = loadContext(io.env);
    if (io.cwd() !== context.siteDir) {
        throw new CliError(
            `working in ${io.cwd()}, but the launcher gave the site directory as ${context.siteDir}`,
        );
    }
    return context;
}

/** The launcher's context, and the site in its directory. */
export function installedSite(io: Io): InstalledSite {
    const context = siteContext(io);
    const dir = context.siteDir;
    const settings = readSettings(dir);
    if (settings === null) {
        throw new CliError(
            `${dir}/${ENV_FILE} does not exist, so this directory does not hold a site.\n` +
                '  Run ./ghost-docker install, or ./ghost-docker --dir PATH ... for a site elsewhere.',
        );
    }
    const site = siteFacts(dir, settings);
    const declared = settings.get('PROJECT_DIR');
    if (declared && declared !== dir) {
        throw new CliError(
            `.env says PROJECT_DIR is ${declared}, but the site is at ${dir}.\n` +
                '  If the site was moved, update PROJECT_DIR (./ghost-docker config set .env PROJECT_DIR ' +
                `${dir}) and check its bind mounts.`,
        );
    }
    return { context, site };
}

// --- Which release ------------------------------------------------------------

/**
 * The release the command line asked for. The launcher has already chosen the
 * image from these options (plan §2.10); the manager checks them again, so a
 * manager started any other way reads them the same, and records them.
 */
export interface Requested {
    readonly channel: Channel | null;
    readonly ref: string | null;
    /** How the command spells its exact-release option: install's --release, update's --to. */
    readonly flag: string;
}

/** `--channel`: stable or beta. */
export const channelOption = (brief: string) =>
    z.enum(CHANNELS, refused('must be stable or beta')).optional().describe(brief);

/** An exact release: install's `--release`, update's `--to`. */
export const releaseOption = (brief: string) =>
    z
        .string()
        .refine(isRelease, refused('must be a release, vX.Y.Z or vX.Y.Z-beta.N'))
        .optional()
        .describe(brief);

export const requestedRelease = (
    channel: Channel | undefined,
    ref: string | undefined,
    flag: string,
): Requested => ({ channel: channel ?? null, ref: ref ?? null, flag });

/** This manager's own release, and the channel a site it writes follows. */
export interface ManagerRelease {
    /** `vX.Y.Z[-beta.N]`, `edge-<commit>`, or null for a build from a checkout. */
    readonly version: string | null;
    readonly channel: Metadata['channel'];
}

/**
 * Which release this manager is, refusing one that is not what was asked
 * for: the launcher runs the image the options name, unless GD_IMAGE named
 * another.
 */
export function releaseOf(requested: Requested, env: NodeJS.ProcessEnv): ManagerRelease {
    const { version } = managerVersion();
    if (requested.ref !== null && isRelease(version) && version !== requested.ref) {
        throw new CliError(
            `${requested.flag} ${requested.ref} was asked for, but this manager is ${version}.\n` +
                '  Unset GD_IMAGE, which chooses the image whatever the options say, and run it again.',
        );
    }
    const passed = env.GD_CHANNEL;
    const channel =
        requested.channel ??
        (requested.ref === null ? null : channelOf(requested.ref)) ??
        (passed === 'stable' || passed === 'beta' || passed === 'edge' ? passed : null) ??
        channelOf(version);
    return {
        version: version === 'dev' || version === 'checkout' ? null : version,
        channel,
    };
}
