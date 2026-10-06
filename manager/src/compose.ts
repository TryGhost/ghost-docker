// Compose has no API: it is a program that talks to the daemon itself. The
// manager runs the client that is in this image.
import type { Exec } from './process.ts';

/** The version of the Compose client in this image. */
export async function composeVersion(exec: Exec): Promise<string | null> {
    const result = await exec('docker', ['compose', 'version', '--short'], { timeoutMs: 20_000 });
    const version = result.stdout.trim();
    return result.status === 0 && version ? version : null;
}
