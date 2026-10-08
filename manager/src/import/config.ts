// The source site's Ghost configuration, as ghost.env receives it: everything
// in the bundle except what the container, or the operator's `.env`, owns.
// "Keys the importer omits" in docs/bundle-v1.md.
import type { BundleManifest } from '../bundle/manifest.ts';
import { composeConfig } from '../compose.ts';
import { operatorKeyTest } from '../config.ts';
import * as env from '../env.ts';
import { CliError } from '../errors.ts';
import type { Io } from '../io.ts';

/**
 * Ghost configuration the container owns ("Keys the importer omits" in
 * docs/bundle-v1.md). The keys compose.yml sets on the ghost service are
 * added to these at run time, from the resolved configuration, so the two
 * lists cannot drift apart.
 */
const OWNED_KEYS = ['url', 'admin__url', 'process', 'logging__transports', 'logging__path'];
const OWNED_PREFIXES = ['database__', 'server__', 'paths__'];

export function isContainerOwned(key: string, container: ReadonlySet<string>): boolean {
    return (
        container.has(key) ||
        OWNED_KEYS.some((owned) => key === owned || key.startsWith(`${owned}__`)) ||
        OWNED_PREFIXES.some((prefix) => key.startsWith(prefix))
    );
}

export interface CarriedConfig {
    /** What ghost.env receives, raw; the encoder writes it. */
    readonly settings: [string, string][];
    /** Keys left out, with why. Names only: values may be credentials. */
    readonly skipped: { key: string; reason: string }[];
}

/** The bundle's Ghost configuration, without what ghost.env must not hold. */
export function carriedConfig(
    manifest: BundleManifest,
    container: ReadonlySet<string>,
    isOperatorKey: (key: string) => boolean,
): CarriedConfig {
    const settings: [string, string][] = [];
    const skipped: { key: string; reason: string }[] = [];
    for (const [key, value] of Object.entries(manifest.config)) {
        if (!env.isValidKey(key)) {
            skipped.push({ key, reason: 'not a valid setting name' });
        } else if (isContainerOwned(key, container)) {
            skipped.push({ key, reason: 'set by the container' });
        } else if (isOperatorKey(key)) {
            skipped.push({ key, reason: 'an operator setting, not Ghost configuration' });
        } else {
            settings.push([key, value]);
        }
    }
    return { settings, skipped };
}

/**
 * The bundle's configuration for ghost.env. What the container owns is read
 * from the resolved Compose configuration, which needs `.env` in place.
 */
export async function sourceConfig(
    io: Io,
    dir: string,
    manifest: BundleManifest,
): Promise<CarriedConfig> {
    const resolved = await composeConfig(io, dir);
    if (!resolved.ok) {
        throw new CliError(
            `the Compose configuration could not be resolved to see what the container sets: ${resolved.reason}`,
        );
    }
    const container = new Set(Object.keys(resolved.project.services.ghost?.environment ?? {}));
    return carriedConfig(manifest, container, operatorKeyTest(dir));
}
