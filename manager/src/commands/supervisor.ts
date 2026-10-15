// `supervisor run`: the upgrade supervisor, the long-running service Compose
// starts with the `supervisor` profile, serving its API on a socket in a
// volume Ghost mounts (docs/upgrade-supervisor.md). Ghost is its only client.
import { statSync } from 'node:fs';
import { defineCommand } from '../command.ts';
import { daemonInfo, runOnce } from '../docker/client.ts';
import { CliError, EXIT } from '../errors.ts';
import type { Io } from '../io.ts';
import { requireMetadata, type Metadata } from '../meta.ts';
import { readSettings, type SiteFacts } from '../site.ts';
import { discover, parsePolicy } from '../supervisor/discovery.ts';
import { ghostJob } from '../supervisor/job.ts';
import { SOCKET_DIR, SOCKET_PATH } from '../supervisor/protocol.ts';
import { listen, supervisorServer } from '../supervisor/server.ts';
import { Records } from '../supervisor/store.ts';
import { Supervisor } from '../supervisor/supervisor.ts';
import { installedSite } from './common.ts';
import type { Context } from '../context.ts';

/** How often the supervisor asks whether discovery is due. */
const DISCOVERY_CHECK_MS = 60_000;

/** The site's `upgrade` volume, as Compose names it. */
const volumeOf = (site: SiteFacts) =>
    `${site.settings.get('COMPOSE_PROJECT_NAME') || 'ghost'}_upgrade`;

/** The uid and gid of the `ghost` user of the Ghost image the site pins. */
async function ghostIdentity(io: Io, metadata: Metadata): Promise<{ uid: number; gid: number }> {
    const image = `${metadata.ghost.image}@${metadata.ghost.digest}`;
    const read = async (flag: string) => {
        const result = await runOnce(io.docker, {
            image,
            entrypoint: ['id'],
            cmd: [flag, 'ghost'],
            network: 'none',
            timeoutMs: 60_000,
        });
        const value = result.stdout.trim();
        if (result.status !== 0 || !/^\d+$/.test(value)) {
            throw new CliError(
                `${image} has no ghost user the supervisor can find (id ${flag} ghost: ${result.stderr.trim() || value || 'no answer'}).\n` +
                    '  The supervisor needs a next-variant Ghost image.',
            );
        }
        return Number(value);
    };
    return { uid: await read('-u'), gid: await read('-g') };
}

/** Refused where container uids are not the host's, or the daemon is not this machine's. */
export async function refuseUnsupportedDaemon(io: Io, context: Context): Promise<void> {
    const info = await daemonInfo(io.docker);
    if (!info.ok) {
        throw new CliError(`the Docker daemon could not be reached: ${info.reason}`);
    }
    if (context.rootless || info.info.rootless || info.info.usernsRemap) {
        throw new CliError(
            'the upgrade supervisor is not supported under rootless Docker or user-namespace remapping:\n' +
                '  container uids there are not the host’s, so who may reach the supervisor’s socket cannot be enforced.',
        );
    }
}

// --- supervisor run -------------------------------------------------------------

/**
 * The volume root owned as the protocol says: the operator's uid and Ghost's
 * gid, 0750, so only they reach the socket. Set by a root helper whenever it is
 * not, as after a first start or `down -v`.
 */
async function prepareVolume(
    io: Io,
    context: Context,
    site: SiteFacts,
    ghost: { uid: number; gid: number },
): Promise<void> {
    const { uid } = context.caller;
    const stats = statSync(SOCKET_DIR);
    if (stats.uid === uid && stats.gid === ghost.gid && (stats.mode & 0o7777) === 0o750) {
        return;
    }
    if (context.image === null) {
        throw new CliError(
            'the supervisor does not know its own image, so it cannot set its volume’s ownership',
        );
    }
    // Numbers only, read from the images: nothing here is text from a request.
    const result = await runOnce(io.docker, {
        image: context.image,
        entrypoint: ['sh', '-c'],
        cmd: [`chown ${uid}:${ghost.gid} /volume && chmod 0750 /volume`],
        binds: [{ source: volumeOf(site), target: '/volume' }],
        user: '0:0',
        network: 'none',
        timeoutMs: 60_000,
    });
    if (result.status !== 0) {
        throw new CliError(
            `the volume’s ownership could not be set: ${result.stderr.trim() || 'the helper did not run'}`,
        );
    }
}

const timestamped = (io: Io): Io => {
    const stamp = (write: (text: string) => void) => (text: string) =>
        write(
            text
                .split('\n')
                .map((line, index, lines) =>
                    line === '' && index === lines.length - 1
                        ? line
                        : `${new Date().toISOString()} ${line}`,
                )
                .join('\n'),
        );
    return {
        ...io,
        stdout: stamp(io.stdout),
        stderr: stamp(io.stderr),
        busy: (_text, work) => work(),
        prompt: null,
    };
};

export const supervisorRunCommand = defineCommand({
    brief: 'Run the upgrade supervisor. Compose starts it with the supervisor profile; see docs/upgrade-supervisor.md.',
    async run(_flags, _positionals, outer) {
        const io = timestamped(outer);
        const { context, site } = installedSite(io);
        const dir = site.dir;
        await refuseUnsupportedDaemon(io, context);
        const metadata = () =>
            requireMetadata(dir, 'the supervisor cannot tell which Ghost the site runs');
        const ghost = await ghostIdentity(io, metadata());
        await prepareVolume(io, context, site, ghost);

        const supervisor = new Supervisor({
            io,
            dir,
            records: new Records(dir),
            execute: ghostJob(io, dir),
            discover,
            metadata,
            policy: () => parsePolicy(readSettings(dir)?.get('SUPERVISOR_UPDATES')),
        });
        supervisor.start();
        const server = supervisorServer(supervisor, io.stderr);
        await listen(server, SOCKET_PATH);
        io.stdout(`The upgrade supervisor is listening on ${SOCKET_PATH} for ${dir}.\n`);

        // A job still running when the container stops is found unfinished on
        // the next start, and marked interrupted: never left looking as if it ran.
        const stop = () => {
            io.stdout('Stopping.\n');
            server.close();
            process.exit(EXIT.ok);
        };
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);

        await supervisor.rediscover();
        for (;;) {
            await new Promise((resolve) => setTimeout(resolve, DISCOVERY_CHECK_MS));
            await supervisor.discoverIfDue();
        }
    },
});
