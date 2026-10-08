// Version comparison, and the manager's own version.
import { readFileSync } from 'node:fs';
import { coerce, gte } from 'semver';
import { z } from 'zod';

/** Declared minimums. Verified in CI against this exact minimum and a current release. */
export const MINIMUM = {
    // `healthcheck.start_interval` needs Docker Engine 25.0.
    dockerEngine: '25.0.0',
    // `env_file: [{path, required}]` needs Compose 2.24; `depends_on.required` 2.20.
    compose: '2.24.0',
    // The oldest Ghost this release of the stack runs. `update` never changes
    // a site's Ghost, so a release that raises this stops an update of a site
    // below it and says to upgrade Ghost first (plan §2.7).
    ghost: '6.0.0',
} as const;

/**
 * Is `version` at least `minimum`? Versions are coerced first: a leading `v`
 * and anything after the numbers (`-beta.1`, `+ce`, `-desktop.1`) are
 * dropped, which is what a minimum-version check needs. Release ordering for
 * the stack itself has its own rules (plan §2.10) and is not this.
 */
export const atLeast = (version: string, minimum: string): boolean =>
    gte(coerce(version) ?? '0.0.0', minimum);

const versionFile = z.object({ version: z.string().min(1), commit: z.string().default('') });

export interface ManagerVersion {
    version: string;
    commit: string;
}

/**
 * The version baked into the image at build time. A manager run straight from
 * a source tree has no such file and reports `dev`.
 */
export function managerVersion(
    path = process.env.GD_VERSION_FILE ?? '/opt/ghost-docker/VERSION.json',
): ManagerVersion {
    try {
        return versionFile.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
        return { version: 'dev', commit: '' };
    }
}
