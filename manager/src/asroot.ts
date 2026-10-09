// Files in the site directory that only root may change: MySQL's data
// directory belongs to MySQL's user once it has run. Each change is made in a
// short-lived container of the manager's own image that does only that, with
// the site mounted at /site and no network (docs/configuration.md0).
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runOnce, type RunResult } from './docker/client.ts';
import type { Io } from './io.ts';

/** `command` run as root with each of `paths`, relative to the site, as an argument. */
export const asRoot = (
    io: Io,
    image: string,
    dir: string,
    command: readonly string[],
    paths: readonly string[],
    timeoutMs = 600_000,
): Promise<RunResult> =>
    runOnce(io.docker, {
        image,
        entrypoint: command,
        cmd: paths.map((path) => `/site/${path}`),
        binds: [{ source: dir, target: '/site' }],
        user: '0:0',
        network: 'none',
        timeoutMs,
    });

/**
 * Removes `paths`, relative to the site: as root when the manager knows its
 * own image, then as itself for anything root did not need to remove. What
 * is left is returned, for the caller to report.
 */
export async function removeAsRoot(
    io: Io,
    image: string | null,
    dir: string,
    paths: readonly string[],
    timeoutMs?: number,
): Promise<string[]> {
    const targets = paths.filter((path) => existsSync(join(dir, path)));
    if (targets.length > 0 && image !== null) {
        await asRoot(io, image, dir, ['rm', '-rf', '--'], targets, timeoutMs);
    }
    for (const path of targets) {
        try {
            rmSync(join(dir, path), { recursive: true, force: true });
        } catch {
            // Returned as left.
        }
    }
    return targets.filter((path) => existsSync(join(dir, path)));
}
