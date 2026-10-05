// A fake Io: captured output, a scripted `docker`, a temporary site directory.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.ts';
import type { Io } from '../src/io.ts';
import type { ExecResult } from '../src/process.ts';

export interface Daemon {
    /** `docker info` as the daemon would answer, or a failure. */
    info?: Record<string, unknown> | { fail: string } | { hang: true };
    compose?: string | null;
}

export interface Harness {
    dir: string;
    env: NodeJS.ProcessEnv;
    uid: number;
    gid: number;
    cwd: string;
    daemon: Daemon;
    calls: string[][];
    run: (...argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
    cleanup: () => void;
}

export const HEALTHY = {
    ServerVersion: '28.5.2',
    OperatingSystem: 'Ubuntu 24.04.1 LTS',
    OSType: 'linux',
    Architecture: 'x86_64',
    MemTotal: 8 * 1024 ** 3,
    SecurityOptions: ['name=seccomp,profile=builtin'],
};

const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: '', timedOut: false });

export function harness(): Harness {
    // Resolved, as the launcher resolves it: /tmp is a symlink on macOS.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gd-manager-test-')));
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const state: Harness = {
        dir,
        uid,
        gid,
        cwd: dir,
        daemon: { info: HEALTHY, compose: '2.40.3' },
        calls: [],
        env: {
            GD_SITE_DIR: dir,
            GD_UID: String(uid),
            GD_GID: String(gid),
            GD_ROOTLESS: '0',
            GD_HOST_OS: 'Linux',
            GD_SOURCE: 'checkout',
            GD_VERSION_FILE: join(dir, 'no-such-version-file'),
        },
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
        run: async (...argv) => {
            let stdout = '';
            let stderr = '';
            // managerVersion() reads the real environment.
            const previous = process.env.GD_VERSION_FILE;
            process.env.GD_VERSION_FILE = state.env.GD_VERSION_FILE;
            const io: Io = {
                stdout: (text) => void (stdout += text),
                stderr: (text) => void (stderr += text),
                env: state.env,
                cwd: () => state.cwd,
                uid: () => state.uid,
                gid: () => state.gid,
                exec: async (command, args) => {
                    state.calls.push([command, ...args]);
                    if (command !== 'docker') {
                        return {
                            status: null,
                            stdout: '',
                            stderr: `spawn ${command} ENOENT`,
                            timedOut: false,
                        };
                    }
                    if (args[0] === 'info') {
                        const info = state.daemon.info ?? HEALTHY;
                        if ('hang' in info) {
                            return { status: null, stdout: '', stderr: '', timedOut: true };
                        }
                        if ('fail' in info) {
                            return {
                                status: 1,
                                stdout: '',
                                stderr: String(info.fail),
                                timedOut: false,
                            };
                        }
                        return ok(JSON.stringify(info));
                    }
                    if (args[0] === 'compose' && args[1] === 'version') {
                        return state.daemon.compose
                            ? ok(`${state.daemon.compose}\n`)
                            : { status: 1, stdout: '', stderr: 'unknown command', timedOut: false };
                    }
                    return {
                        status: 1,
                        stdout: '',
                        stderr: `unexpected: docker ${args.join(' ')}`,
                        timedOut: false,
                    };
                },
            };
            try {
                return { code: await run(argv, io), stdout, stderr };
            } finally {
                if (previous === undefined) {
                    delete process.env.GD_VERSION_FILE;
                } else {
                    process.env.GD_VERSION_FILE = previous;
                }
            }
        },
    };
    return state;
}
