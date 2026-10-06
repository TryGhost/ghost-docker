// `doctor`: what the manager can see from where it is.
//
// It answers the questions every other command depends on: can the daemon be
// reached, is it new enough, is the site directory the one the launcher said
// it was, and will the files written there belong to whoever ran the launcher.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Context } from '../context.ts';
import { composeVersion, daemonInfo } from '../docker.ts';
import { EXIT, UsageError } from '../errors.ts';
import type { Io } from '../io.ts';
import { atLeast, managerVersion, MINIMUM } from '../versions.ts';

export interface Check {
    status: 'ok' | 'warn' | 'error';
    label: string;
    detail: string;
}

/** Left in the site directory by `--keep-probe`, so its ownership can be read from the host. */
export const PROBE_FILE = '.ghost-docker-probe';

const SUPPORTED_ARCHITECTURES = ['x86_64', 'amd64', 'aarch64', 'arm64'];

export async function doctor(args: readonly string[], context: Context, io: Io): Promise<number> {
    let json = false;
    let keepProbe = false;
    for (const arg of args) {
        if (arg === '--json') {
            json = true;
        } else if (arg === '--keep-probe') {
            keepProbe = true;
        } else {
            throw new UsageError(`unknown option for doctor: ${arg}`);
        }
    }

    const checks = await collect(context, io, keepProbe);

    if (json) {
        io.stdout(`${JSON.stringify({ checks }, null, 2)}\n`);
    } else {
        for (const check of checks) {
            const line = `  ${STATUS_LABEL[check.status]} ${check.label.padEnd(18)} ${check.detail}\n`;
            // Problems go to stderr so they can be separated from the summary.
            (check.status === 'ok' ? io.stdout : io.stderr)(line);
        }
    }
    return checks.some((check) => check.status === 'error') ? EXIT.failure : EXIT.ok;
}

const STATUS_LABEL = { ok: 'ok      ', warn: 'warning ', error: 'ERROR   ' } as const;

export async function collect(context: Context, io: Io, keepProbe = false): Promise<Check[]> {
    const checks: Check[] = [];
    const add = (status: Check['status'], label: string, detail: string) =>
        checks.push({ status, label, detail });

    const version = managerVersion();
    add(
        'ok',
        'manager',
        `${version.version}${version.commit ? ` (${version.commit.slice(0, 7)})` : ''}, ` +
            (context.source === 'checkout' ? 'built from a checkout' : 'from a published image'),
    );

    // --- The daemon ----------------------------------------------------------

    const daemon = await daemonInfo(io.exec);
    if (!daemon.ok) {
        add(
            'error',
            'docker daemon',
            `${daemon.reason}. The launcher mounts the Docker socket; check that Docker is running.`,
        );
    } else {
        const { info } = daemon;
        add(
            atLeast(info.serverVersion, MINIMUM.dockerEngine) ? 'ok' : 'error',
            'docker engine',
            atLeast(info.serverVersion, MINIMUM.dockerEngine)
                ? info.serverVersion
                : `${info.serverVersion} is older than the required ${MINIMUM.dockerEngine}`,
        );

        const supported =
            info.osType === 'linux' && SUPPORTED_ARCHITECTURES.includes(info.architecture);
        add(
            supported ? 'ok' : 'error',
            'platform',
            supported
                ? `${info.operatingSystem || info.osType} (${info.osType}/${info.architecture}), host ${context.hostOs}` +
                      (info.rootless ? ', rootless' : '')
                : `${info.osType}/${info.architecture} has no published images for the services this stack runs`,
        );

        if (info.rootless !== context.rootless) {
            add(
                'error',
                'rootless',
                `the daemon says rootless is ${info.rootless}, the launcher said ${context.rootless}. ` +
                    'File ownership in the site directory would be wrong; please report this.',
            );
        }
    }

    const compose = await composeVersion(io.exec);
    if (compose === null) {
        add('error', 'docker compose', 'the Compose client in this image did not run');
    } else {
        add(
            atLeast(compose, MINIMUM.compose) ? 'ok' : 'error',
            'docker compose',
            atLeast(compose, MINIMUM.compose)
                ? `${compose} (the manager's own client)`
                : `${compose} is older than the required ${MINIMUM.compose}`,
        );
    }

    // --- The site directory --------------------------------------------------

    const cwd = io.cwd();
    if (cwd !== context.siteDir) {
        // Compose bind mounts are resolved by the daemon against host paths. If
        // the site is not mounted at its own host path, every bind mount would
        // silently refer to a different directory on the host.
        add(
            'error',
            'site directory',
            `working in ${cwd}, but the launcher gave the site directory as ${context.siteDir}. ` +
                'They must be the same path.',
        );
        return checks;
    }
    add('ok', 'site directory', cwd);

    checks.push(identityCheck(context, io));

    const probe = writeProbe(cwd, keepProbe);
    checks.push(probe.check);
    if (probe.token !== null) {
        checks.push(await bindMountCheck(context, io, probe.token));
        if (!keepProbe) {
            rmSync(join(cwd, PROBE_FILE), { force: true });
        }
    }

    const projectDir = declaredProjectDir(cwd);
    if (projectDir !== null) {
        add(
            projectDir === cwd ? 'ok' : 'error',
            'PROJECT_DIR',
            projectDir === cwd
                ? 'matches the site directory'
                : `.env says ${projectDir}, but the site is at ${cwd}. If the site was moved, update PROJECT_DIR.`,
        );
    }

    return checks;
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
    const result = await io.exec(
        'docker',
        [
            'run',
            '--rm',
            '--network',
            'none',
            '--volume',
            `${context.siteDir}:/ghost-docker-probe:ro`,
            '--entrypoint',
            'cat',
            context.image,
            `/ghost-docker-probe/${PROBE_FILE}`,
        ],
        { timeoutMs: 120_000 },
    );
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

/**
 * `PROJECT_DIR` from `.env`, when there is one. Only the simple quoted and
 * unquoted forms are read here; the real dotenv reader arrives with the
 * configuration commands, and an unusual encoding is reported as absent
 * rather than guessed at.
 */
function declaredProjectDir(dir: string): string | null {
    const path = join(dir, '.env');
    if (!existsSync(path)) {
        return null;
    }
    const match = readFileSync(path, 'utf8').match(
        /^PROJECT_DIR=(?:"([^"$\\]*)"|([^\s"'#$\\]+))\s*$/m,
    );
    return match ? (match[1] ?? match[2] ?? null) : null;
}
