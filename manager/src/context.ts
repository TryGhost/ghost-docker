// What the launcher tells the manager about where it is running.
//
// The launcher is the only thing that can know these: it runs on the host, the
// manager does not. They arrive as GD_* environment variables and are checked
// here, once, so that a manager started by hand without them fails with a
// sentence instead of misbehaving later. The contract is docs/configuration.md0.
import { z } from 'zod';
import { CliError } from './errors.ts';

const numeric = z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value));

const launcherEnvironment = z.object({
    // The site directory's absolute path on the host. The launcher mounts it at
    // this same path, because the daemon resolves Compose bind mounts on the
    // host: a site mounted anywhere else would bind a different directory.
    GD_SITE_DIR: z.string().startsWith('/'),
    // Who ran the launcher.
    GD_UID: numeric,
    GD_GID: numeric,
    // Rootless Docker: uid 0 in the container already is the caller.
    GD_ROOTLESS: z.enum(['0', '1']).default('0'),
    // `uname -s` on the host.
    GD_HOST_OS: z.string().min(1).default('unknown'),
    // The image this manager was started from, as the launcher referred to it.
    GD_IMAGE: z.string().min(1).optional(),
    // `image`: a published image. `checkout`: built from a clone of the repo.
    GD_SOURCE: z.enum(['image', 'checkout']).default('image'),
});

export interface Context {
    siteDir: string;
    caller: { uid: number; gid: number };
    rootless: boolean;
    hostOs: string;
    image: string | null;
    source: 'image' | 'checkout';
}

export function loadContext(env: NodeJS.ProcessEnv): Context {
    const parsed = launcherEnvironment.safeParse(env);
    if (!parsed.success) {
        const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
        throw new CliError(
            `the manager was not started by the ghost-docker launcher (${names.join(', ')} missing or malformed).\n` +
                '  Run it through ./ghost-docker, which mounts the site directory and the Docker socket\n' +
                '  and passes the caller’s identity.',
        );
    }
    const value = parsed.data;
    return {
        siteDir: value.GD_SITE_DIR,
        caller: { uid: value.GD_UID, gid: value.GD_GID },
        rootless: value.GD_ROOTLESS === '1',
        hostOs: value.GD_HOST_OS,
        image: value.GD_IMAGE ?? null,
        source: value.GD_SOURCE,
    };
}
