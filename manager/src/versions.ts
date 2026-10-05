// Version comparison, and the manager's own version.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Declared minimums. Verified in CI against this exact minimum and a current release. */
export const MINIMUM = {
    // `healthcheck.start_interval` needs Docker Engine 25.0.
    dockerEngine: '25.0.0',
    // `env_file: [{path, required}]` needs Compose 2.24; `depends_on.required` 2.20.
    compose: '2.24.0',
} as const;

/**
 * -1, 0 or 1 for `a` against `b`, comparing dot separated numeric components.
 * A leading `v` and anything after the numbers (`-beta.1`, `+ce`, `-desktop.1`)
 * are ignored, which is what a minimum-version check needs. Not a semver
 * comparator: release ordering has its own rules (plan §2.10).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
    const parts = (version: string) =>
        (version.replace(/^v/, '').match(/^\d+(\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
    const left = parts(a);
    const right = parts(b);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) {
            return difference < 0 ? -1 : 1;
        }
    }
    return 0;
}

export const atLeast = (version: string, minimum: string) => compareVersions(version, minimum) >= 0;

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
