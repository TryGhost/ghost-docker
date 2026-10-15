// The upgrade supervisor's commands (docs/upgrade-supervisor.md).
//
// `supervisor run` is the long-running service Compose starts with the
// `supervisor` profile: the API on its socket. `status`, `request` and `job`
// are for the operator: they call the API as Ghost does, through a short-lived
// container that runs as Ghost's uid and mounts the volume as Ghost mounts it,
// where `supervisor client` does the work. Requests made by hand therefore pass
// through Ghost's access, not the operator's.
import { statSync } from 'node:fs';
import { z } from 'zod';
import { defineCommand, flag } from '../command.ts';
import { daemonInfo, runOnce } from '../docker/client.ts';
import { CliError, EXIT, UsageError } from '../errors.ts';
import type { Io } from '../io.ts';
import { requireMetadata, type Metadata } from '../meta.ts';
import { readSettings, type SiteFacts } from '../site.ts';
import {
    SupervisorClient,
    type Lookup,
    type RequestResult,
    type StatusRead,
} from '../supervisor/client.ts';
import { discover, parsePolicy } from '../supervisor/discovery.ts';
import { ghostJob } from '../supervisor/job.ts';
import {
    randomIdempotencyKey,
    SOCKET_DIR,
    SOCKET_PATH,
    upgradeComponentSchema,
    upgradeJobIdSchema,
    upgradeVersionSchema,
    type UpgradeJob,
} from '../supervisor/protocol.ts';
import { listen, supervisorServer } from '../supervisor/server.ts';
import { Records } from '../supervisor/store.ts';
import { Supervisor } from '../supervisor/supervisor.ts';
import { installedSite } from './common.ts';
import type { Context } from '../context.ts';

const MANAGER_MAIN = '/opt/ghost-docker/manager/src/main.ts';

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

// --- The operator's tools ---------------------------------------------------------

/** `supervisor client <operation>` in a container as Ghost: its JSON answer. */
async function asGhost(io: Io, args: readonly string[]): Promise<unknown> {
    const { context, site } = installedSite(io);
    const metadata = requireMetadata(
        site.dir,
        'the supervisor cannot tell which Ghost the site runs',
    );
    if (context.image === null) {
        throw new CliError('the launcher did not say which image this is');
    }
    const volume = volumeOf(site);
    const found = await io.docker({ method: 'GET', path: `/volumes/${volume}` });
    if (found.status === 404) {
        throw new CliError(
            `the volume ${volume} does not exist yet: start the site with the supervisor profile first (docker compose up -d).`,
        );
    }
    const ghost = await ghostIdentity(io, metadata);
    const result = await runOnce(io.docker, {
        image: context.image,
        // Past the entrypoint, which would drop to the operator: this runs as Ghost.
        entrypoint: ['node', MANAGER_MAIN],
        cmd: ['supervisor', 'client', ...args],
        binds: [{ source: volume, target: SOCKET_DIR, readOnly: true }],
        user: `${ghost.uid}:${ghost.gid}`,
        network: 'none',
        timeoutMs: 60_000,
    });
    if (result.status !== 0) {
        throw new CliError(
            `calling the supervisor as Ghost (uid ${ghost.uid}) failed: ${result.stderr.trim() || 'it did not run'}`,
        );
    }
    return JSON.parse(result.stdout);
}

const json = flag('Print the answer as JSON, as Ghost reads it.');

const describeJob = (job: Lookup): string => {
    if ('failed' in job) {
        return `The job could not be looked up: ${job.failed}.\n`;
    }
    if (job.state === 'unknown' || job.state === 'expired') {
        return `Job ${job.id} is ${job.state === 'unknown' ? 'not known to the supervisor' : 'no longer kept'}.\n`;
    }
    const full = job as UpgradeJob;
    return [
        `Job ${full.id}: ${full.component} ${full.fromVersion ? `${full.fromVersion} to ` : ''}${full.toVersion}, ${full.state}`,
        `  created ${full.createdAt}, updated ${full.updatedAt}`,
        ...(full.diagnostics ?? []).flatMap((entry) => [
            `  ${entry.severity}: ${entry.message}`,
            ...(entry.details ? entry.details.split('\n').map((line) => `      ${line}`) : []),
        ]),
        '',
    ].join('\n');
};

export const supervisorStatusCommand = defineCommand({
    brief: 'Show what the upgrade supervisor tells Ghost: whether it is ready, and the updates it offers.',
    options: z.object({ json }),
    async run(flags, _positionals, io) {
        const read = (await asGhost(io, ['status'])) as StatusRead;
        if (flags.json) {
            io.stdout(`${JSON.stringify(read, null, 2)}\n`);
            return EXIT.ok;
        }
        if (!('status' in read) || !read.status.supported) {
            io.stdout(
                `The supervisor is ${read.availability}: ${'reason' in read ? read.reason : ''}.\n`,
            );
            return EXIT.failure;
        }
        const body = read.status;
        io.stdout(
            [
                `The supervisor is ${read.availability}. Ghost ${body.currentVersion ?? 'version unknown'}.`,
                ...(body.activeJobId ? [`Running job ${body.activeJobId}.`] : []),
                ...body.oneClick.map(
                    (entry) =>
                        `  one-click  ${entry.component} ${entry.fromVersion} to ${entry.toVersion}`,
                ),
                ...body.manual.map(
                    (entry) =>
                        `  manual     ${entry.component} ${entry.fromVersion} to ${entry.toVersion}: ${entry.reason}`,
                ),
                ...(body.diagnostics ?? []).map((entry) => `  ${entry.severity}: ${entry.message}`),
                '',
            ].join('\n'),
        );
        return EXIT.ok;
    },
});

export const supervisorRequestCommand = defineCommand({
    brief: 'Ask the upgrade supervisor for an update, as Ghost Admin would: supervisor request ghost 6.72.0.',
    options: z.object({ json }),
    positionals: ['component', 'version'],
    async run(flags, positionals, io) {
        const [component, version] = positionals;
        if (
            !upgradeComponentSchema.safeParse(component).success ||
            !upgradeVersionSchema.safeParse(version).success
        ) {
            throw new UsageError(
                'give a component and the version to update it to, such as: supervisor request ghost 6.72.0',
            );
        }
        const result = (await asGhost(io, ['request', component!, version!])) as RequestResult;
        if (flags.json) {
            io.stdout(`${JSON.stringify(result, null, 2)}\n`);
        } else if ('accepted' in result) {
            io.stdout(
                `Accepted as job ${result.accepted.id}. Follow it with ./ghost-docker supervisor job ${result.accepted.id}\n`,
            );
        } else {
            io.stdout(`Refused (${result.rejected}): ${result.reason}.\n`);
        }
        return 'accepted' in result ? EXIT.ok : EXIT.failure;
    },
});

export const supervisorJobCommand = defineCommand({
    brief: 'Show a job of the upgrade supervisor, as Ghost Admin sees it.',
    options: z.object({ json }),
    positionals: ['id'],
    async run(flags, positionals, io) {
        const [id] = positionals;
        if (!upgradeJobIdSchema.safeParse(id).success) {
            throw new UsageError('give the job’s ID, as supervisor request printed it');
        }
        const job = (await asGhost(io, ['job', id!])) as Lookup;
        io.stdout(flags.json ? `${JSON.stringify(job, null, 2)}\n` : describeJob(job));
        return EXIT.ok;
    },
});

/** Ghost's end of the API, which status, request and job run as Ghost's uid. */
export const supervisorClientCommand = defineCommand({
    brief: 'Internal: Ghost’s end of the API, which status, request and job run as Ghost’s uid.',
    positionals: ['operation', 'first', 'second'],
    async run(_flags, [operation, first, second], io) {
        const client = new SupervisorClient(SOCKET_PATH);
        let answer: unknown;
        if (operation === 'status') {
            answer = await client.readStatus();
        } else if (operation === 'request' && first !== undefined && second !== undefined) {
            answer = await client.createRequest({
                component: upgradeComponentSchema.parse(first),
                toVersion: upgradeVersionSchema.parse(second),
                idempotencyKey: randomIdempotencyKey(),
            });
        } else if (operation === 'job' && first !== undefined) {
            answer = await client.lookup(upgradeJobIdSchema.parse(first));
        } else {
            throw new UsageError(
                'supervisor client status | request <component> <version> | job <id>',
            );
        }
        io.stdout(`${JSON.stringify(answer)}\n`);
        return EXIT.ok;
    },
});
