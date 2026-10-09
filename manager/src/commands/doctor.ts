// `doctor`: what the manager can see from where it is.
//
// It answers the questions every other command depends on: can the daemon be
// reached, is it new enough, is the site directory the one the launcher said
// it was, and will the files written there belong to whoever ran the launcher.
import { rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { defineCommand, flag } from '../command.ts';
import { loadContext, type Context } from '../context.ts';
import { composeVersion } from '../compose.ts';
import { daemonInfo, runOnce, type DaemonResult } from '../docker/client.ts';
import { EXIT } from '../errors.ts';
import { failed, printChecks, type Check } from '../report.ts';
import { readSettings } from '../site.ts';
import type { Io } from '../io.ts';
import { atLeast, managerVersion, MINIMUM } from '../versions.ts';

export type { Check };

/** Left in the site directory by `--keep-probe`, so its ownership can be read from the host. */
export const PROBE_FILE = '.ghost-docker-probe';

const SUPPORTED_ARCHITECTURES = ['x86_64', 'amd64', 'aarch64', 'arm64'];

/**
 * Below these a site will probably install and then fail later, so they are
 * warnings rather than refusals: images, the database and content need the
 * disk, and Ghost and MySQL together need the memory.
 */
export const RECOMMENDED = { diskMb: 5120, memoryMb: 1024 } as const;

export const doctorCommand = defineCommand({
    brief: 'Report what the manager can see: Docker, the platform, the site directory and who owns what is written there.',
    options: z.object({
        json: flag('Machine-readable output.'),
        keepProbe: flag('Leave the probe file so its ownership can be inspected from the host.'),
    }),
    // A report with an error in it is not a failed command, so it returns
    // the status rather than throwing.
    async run({ json, keepProbe }, _positionals, io) {
        const gather = () => collect(loadContext(io.env), io, keepProbe);
        const checks = json ? await gather() : await io.busy('Checking this host', gather);

        if (json) {
            io.stdout(`${JSON.stringify({ checks }, null, 2)}\n`);
        } else {
            printChecks(io, checks);
        }
        return failed(checks) ? EXIT.failure : EXIT.ok;
    },
});

/** What the checks read. Gathered once, so each check is a function of these. */
interface Facts {
    readonly context: Context;
    readonly io: Io;
    readonly cwd: string;
    readonly daemon: DaemonResult;
    readonly compose: string | null;
    readonly keepProbe: boolean;
}

/** One check: its report, several, or nothing when it does not apply. */
type CheckFn = (facts: Facts) => Check | Check[] | null | Promise<Check | Check[] | null>;

/** About the manager and the daemon, in the order they print. */
const HOST_CHECKS: readonly CheckFn[] = [
    manager,
    dockerDaemon,
    dockerEngine,
    platform,
    rootless,
    dockerCompose,
    memory,
];

/** About the site directory; only meaningful once `siteDirectory` has passed. */
const SITE_CHECKS: readonly CheckFn[] = [identity, probeAndBindMounts, disk, projectDir];

export async function collect(context: Context, io: Io, keepProbe = false): Promise<Check[]> {
    const facts: Facts = {
        context,
        io,
        keepProbe,
        cwd: io.cwd(),
        daemon: await daemonInfo(io.docker),
        compose: await composeVersion(io),
    };
    const checks = await runChecks(HOST_CHECKS, facts);

    const site = siteDirectory(facts);
    checks.push(site);
    if (site.status === 'error') {
        // Everything below is about the directory; reported for the wrong one
        // it would be noise.
        return checks;
    }
    checks.push(...(await runChecks(SITE_CHECKS, facts)));
    return checks;
}

async function runChecks(list: readonly CheckFn[], facts: Facts): Promise<Check[]> {
    const checks: Check[] = [];
    for (const check of list) {
        const result = await check(facts);
        if (Array.isArray(result)) {
            checks.push(...result);
        } else if (result !== null) {
            checks.push(result);
        }
    }
    return checks;
}

// --- The manager and the daemon --------------------------------------------

function manager({ context }: Facts): Check {
    const version = managerVersion();
    return {
        status: 'ok',
        label: 'manager',
        detail:
            `${version.version}${version.commit ? ` (${version.commit.slice(0, 7)})` : ''}, ` +
            (context.source === 'checkout' ? 'built from a checkout' : 'from a published image'),
    };
}

function dockerDaemon({ daemon }: Facts): Check | null {
    if (daemon.ok) {
        return null;
    }
    return {
        status: 'error',
        label: 'docker daemon',
        detail: `${daemon.reason}. The launcher mounts the Docker socket; check that Docker is running.`,
    };
}

function dockerEngine({ daemon }: Facts): Check | null {
    if (!daemon.ok) {
        return null;
    }
    const version = daemon.info.serverVersion;
    const recent = atLeast(version, MINIMUM.dockerEngine);
    return {
        status: recent ? 'ok' : 'error',
        label: 'docker engine',
        detail: recent ? version : `${version} is older than the required ${MINIMUM.dockerEngine}`,
    };
}

function platform({ daemon, context }: Facts): Check | null {
    if (!daemon.ok) {
        return null;
    }
    const { info } = daemon;
    const supported =
        info.osType === 'linux' && SUPPORTED_ARCHITECTURES.includes(info.architecture);
    return {
        status: supported ? 'ok' : 'error',
        label: 'platform',
        detail: supported
            ? `${info.operatingSystem || info.osType} (${info.osType}/${info.architecture}), host ${context.hostOs}` +
              (info.rootless ? ', rootless' : '')
            : `${info.osType}/${info.architecture} has no published images for the services this stack runs`,
    };
}

/** The launcher and the daemon must agree, or the entrypoint dropped to the wrong identity. */
function rootless({ daemon, context }: Facts): Check | null {
    if (!daemon.ok || daemon.info.rootless === context.rootless) {
        return null;
    }
    return {
        status: 'error',
        label: 'rootless',
        detail:
            `the daemon says rootless is ${daemon.info.rootless}, the launcher said ${context.rootless}. ` +
            'File ownership in the site directory would be wrong; please report this.',
    };
}

/** Compose is the image's own, so its version is the image's to hold (tests/integration). */
function dockerCompose({ compose }: Facts): Check {
    const label = 'docker compose';
    return compose === null
        ? { status: 'error', label, detail: 'the Compose client in this image did not run' }
        : { status: 'ok', label, detail: `${compose} (the manager's own client)` };
}

/** The daemon's memory: what the containers will share. */
function memory({ daemon }: Facts): Check | null {
    if (!daemon.ok || daemon.info.memoryBytes <= 0) {
        return null;
    }
    const mb = Math.floor(daemon.info.memoryBytes / 1024 ** 2);
    return mb < RECOMMENDED.memoryMb
        ? {
              status: 'warn',
              label: 'memory',
              detail: `${mb} MB available to Docker; Ghost and MySQL together want at least ${RECOMMENDED.memoryMb} MB`,
          }
        : { status: 'ok', label: 'memory', detail: `${mb} MB available to Docker` };
}

// --- The site directory ------------------------------------------------------

/**
 * Compose bind mounts are resolved by the daemon against host paths. If the
 * site is not mounted at its own host path, every bind mount would silently
 * refer to a different directory on the host.
 */
function siteDirectory({ cwd, context }: Facts): Check {
    const label = 'site directory';
    if (cwd === context.siteDir) {
        return { status: 'ok', label, detail: cwd };
    }
    return {
        status: 'error',
        label,
        detail:
            `working in ${cwd}, but the launcher gave the site directory as ${context.siteDir}. ` +
            'They must be the same path.',
    };
}

function identity({ context, io }: Facts): Check {
    return identityCheck(context, io);
}

/** The probe file is written for the bind-mount check and removed after it, unless kept. */
async function probeAndBindMounts({ cwd, keepProbe, context, io }: Facts): Promise<Check[]> {
    const probe = writeProbe(cwd, keepProbe);
    if (probe.token === null) {
        return [probe.check];
    }
    try {
        return [probe.check, await bindMountCheck(context, io, probe.token)];
    } finally {
        if (!keepProbe) {
            rmSync(join(cwd, PROBE_FILE), { force: true });
        }
    }
}

/** Free space where the site keeps its data, which is under its own directory. */
function disk({ cwd, io }: Facts): Check {
    const free = io.freeBytes(cwd);
    if (free === null) {
        return {
            status: 'warn',
            label: 'disk space',
            detail: `could not be determined for ${cwd}`,
        };
    }
    const mb = Math.floor(free / 1024 ** 2);
    return mb < RECOMMENDED.diskMb
        ? {
              status: 'warn',
              label: 'disk space',
              detail: `${mb} MB free; ${RECOMMENDED.diskMb} MB is recommended for images, the database and content`,
          }
        : { status: 'ok', label: 'disk space', detail: `${mb} MB free` };
}

function projectDir({ cwd }: Facts): Check | null {
    const declared = readSettings(cwd)?.get('PROJECT_DIR');
    if (!declared) {
        return null;
    }
    const label = 'PROJECT_DIR';
    if (declared === cwd) {
        return { status: 'ok', label, detail: 'matches the site directory' };
    }
    return {
        status: 'error',
        label,
        detail: `.env says ${declared}, but the site is at ${cwd}. If the site was moved, update PROJECT_DIR.`,
    };
}

/** Is the manager running as the launcher's caller? */
function identityCheck(context: Context, io: Io): Check {
    const uid = io.uid();
    const gid = io.gid();
    const label = 'identity';
    if (context.rootless) {
        return uid === 0
            ? {
                  status: 'ok',
                  label,
                  detail: `uid 0, which under rootless Docker is the caller (uid ${context.caller.uid})`,
              }
            : {
                  status: 'error',
                  label,
                  detail: `uid ${uid} under rootless Docker; files would belong to a subordinate uid, not the caller`,
              };
    }
    if (uid === context.caller.uid && gid === context.caller.gid) {
        return { status: 'ok', label, detail: `running as the caller, uid ${uid} gid ${gid}` };
    }
    return {
        status: 'error',
        label,
        detail:
            `running as uid ${uid} gid ${gid}, but the launcher was run by uid ${context.caller.uid} ` +
            `gid ${context.caller.gid}. Files written to the site directory would not belong to them.`,
    };
}

/**
 * Can the site directory be written, and who owns what is written? Leaves the
 * probe file in place for the bind mount check; the caller removes it.
 */
function writeProbe(dir: string, keep: boolean): { check: Check; token: string | null } {
    const path = join(dir, PROBE_FILE);
    const token = `ghost-docker-probe-${randomUUID()}`;
    try {
        writeFileSync(path, `${token}\n`, { mode: 0o600 });
        const info = statSync(path);
        return {
            token,
            check: {
                status: 'ok',
                label: 'writable',
                detail:
                    `files written here are owned by uid ${info.uid} gid ${info.gid} as the manager sees them` +
                    (keep ? `; left ${PROBE_FILE} for inspection` : ''),
            },
        };
    } catch (error) {
        return {
            token: null,
            check: {
                status: 'error',
                label: 'writable',
                detail: `${dir} is not writable by the manager: ${(error as Error).message}`,
            },
        };
    }
}

/**
 * Does the daemon mean the same directory by this path as the manager does?
 *
 * Compose asks the daemon to bind-mount paths under the site directory, and
 * the daemon resolves them on the host. This asks it to do exactly that: start
 * a sibling container with the site directory mounted by the path the manager
 * was given, and read back the file the manager just wrote. It fails when the
 * daemon cannot start containers, when the path means another directory to the
 * daemon, and when the file is not where the daemon looks (plan §2.10).
 */
async function bindMountCheck(context: Context, io: Io, token: string): Promise<Check> {
    const label = 'bind mounts';
    if (context.image === null) {
        return {
            status: 'warn',
            label,
            detail: 'not checked: the launcher did not say which image this is, so no sibling container could be started',
        };
    }
    const result = await runOnce(io.docker, {
        image: context.image,
        entrypoint: ['cat'],
        cmd: [`/ghost-docker-probe/${PROBE_FILE}`],
        binds: [{ source: context.siteDir, target: '/ghost-docker-probe', readOnly: true }],
        network: 'none',
        timeoutMs: 120_000,
    });
    if (result.status === 0 && result.stdout.trim() === token) {
        return {
            status: 'ok',
            label,
            detail: 'a sibling container sees this directory at the same path the manager does',
        };
    }
    if (result.timedOut) {
        return {
            status: 'error',
            label,
            detail: 'a sibling container did not finish within 2 minutes',
        };
    }
    const said = result.stderr.trim().split('\n').pop() ?? '';
    return {
        status: 'error',
        label,
        detail:
            `a sibling container given ${context.siteDir} did not find the file the manager wrote there` +
            (said ? ` (${said})` : '') +
            '. The daemon resolves this path to a different directory than the launcher mounted, ' +
            'so every Compose bind mount would point at the wrong place.',
    };
}
