// A fake Io: captured output, a scripted daemon and `docker compose`, a
// temporary site directory.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.ts';
import { frame } from '../src/docker/client.ts';
import {
    DaemonTimeout,
    DaemonUnreachable,
    type DockerRequest,
    type DockerResponse,
} from '../src/docker/transport.ts';
import type { Io } from '../src/io.ts';
import type { Exec } from '../src/process.ts';

/** How the daemon treats a sibling container asked to read the probe file. */
export type Sibling = 'sees' | 'other-directory' | 'cannot-run' | 'hangs';

export interface Daemon {
    sibling?: Sibling;
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
    /** Every request made to the daemon. */
    requests: DockerRequest[];
    /** Every program run, with its arguments. */
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

/** What the scripted program reports; the fields of an execa result that callers read. */
export interface ProgramResult {
    exitCode: number | undefined;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

const ok = (stdout: string): ProgramResult => ({
    exitCode: 0,
    stdout,
    stderr: '',
    timedOut: false,
});
const failed = (exitCode: number | undefined, stderr: string, timedOut = false): ProgramResult => ({
    exitCode,
    stdout: '',
    stderr,
    timedOut,
});

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
        requests: [],
        calls: [],
        env: {
            GD_SITE_DIR: dir,
            GD_UID: String(uid),
            GD_GID: String(gid),
            GD_ROOTLESS: '0',
            GD_HOST_OS: 'Linux',
            GD_SOURCE: 'checkout',
            GD_IMAGE: 'ghost-docker:checkout',
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
                docker: async (request) => {
                    state.requests.push(request);
                    return daemon(state, request);
                },
                exec: fakeExec((command, args) => {
                    state.calls.push([command, ...args]);
                    if (command !== 'docker') {
                        return failed(undefined, `spawn ${command} ENOENT`);
                    }
                    if (args[0] === 'compose' && args[1] === 'version') {
                        return state.daemon.compose
                            ? ok(`${state.daemon.compose}\n`)
                            : failed(1, 'unknown command');
                    }
                    return failed(1, `unexpected: docker ${args.join(' ')}`);
                }),
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

const json = (status: number, body: unknown): DockerResponse => ({
    status,
    body: Buffer.from(JSON.stringify(body)),
});
const empty: DockerResponse = { status: 204, body: Buffer.alloc(0) };

/** The one container the fake daemon ever runs: the sibling reading the probe file. */
let sibling: { binds: string[]; cmd: string[] } | null = null;

function daemon(state: Harness, request: DockerRequest): Promise<DockerResponse> {
    const { method, path } = request;
    if (method === 'GET' && path === '/info') {
        const info = state.daemon.info ?? HEALTHY;
        if ('hang' in info) {
            throw new DaemonTimeout(request.timeoutMs ?? 30_000);
        }
        if ('fail' in info) {
            throw new DaemonUnreachable(String(info.fail));
        }
        return Promise.resolve(json(200, info));
    }
    const mode = state.daemon.sibling ?? 'sees';
    if (method === 'POST' && path === '/containers/create') {
        if (mode === 'cannot-run') {
            return Promise.resolve(json(400, { message: 'mounts denied' }));
        }
        const body = request.body as { Cmd: string[]; HostConfig: { Binds: string[] } };
        sibling = { binds: body.HostConfig.Binds, cmd: body.Cmd };
        return Promise.resolve(json(201, { Id: 'sibling' }));
    }
    if (method === 'POST' && path === '/containers/sibling/start') {
        return Promise.resolve(empty);
    }
    if (method === 'POST' && path === '/containers/sibling/wait') {
        if (mode === 'hangs') {
            throw new DaemonTimeout(request.timeoutMs ?? 30_000);
        }
        return Promise.resolve(json(200, { StatusCode: mode === 'other-directory' ? 1 : 0 }));
    }
    if (method === 'POST' && path === '/containers/sibling/kill') {
        return Promise.resolve(empty);
    }
    if (method === 'GET' && path === '/containers/sibling/logs') {
        // The daemon really does read the directory, unless the test says it
        // resolves the path elsewhere.
        const file = sibling?.cmd.at(-1) ?? '';
        if (mode === 'other-directory') {
            return Promise.resolve({
                status: 200,
                body: frame(2, `cat: can't open '${file}': No such file or directory\n`),
            });
        }
        const hostDir = sibling?.binds[0]?.split(':')[0] ?? '';
        return Promise.resolve({
            status: 200,
            body: frame(1, readFileSync(join(hostDir, file.split('/').pop() ?? ''), 'utf8')),
        });
    }
    if (method === 'DELETE' && path === '/containers/sibling') {
        return Promise.resolve(empty);
    }
    return Promise.resolve(json(404, { message: `unexpected: ${method} ${path}` }));
}

/**
 * An Exec whose template is parsed the way execa parses it (literal text
 * split on whitespace, each interpolated value one argument, an array
 * several) and handed to a scripted program. Calling it with options, as
 * exec({ timeout })`...` does, returns itself: options are accepted and
 * ignored. Typed as the real thing; only the fields callers read exist.
 */
function fakeExec(program: (command: string, args: string[]) => ProgramResult): Exec {
    const run = (first: unknown, ...values: unknown[]): unknown => {
        if (!isTemplate(first)) {
            return run;
        }
        const [command = '', ...args] = parseTemplate(first, values);
        const result = program(command, args);
        return Promise.resolve({
            ...result,
            failed: result.exitCode !== 0,
            shortMessage: result.exitCode === undefined ? result.stderr : '',
        });
    };
    return run as unknown as Exec;
}

const isTemplate = (value: unknown): value is TemplateStringsArray =>
    Array.isArray(value) && 'raw' in value;

function parseTemplate(strings: TemplateStringsArray, values: unknown[]): string[] {
    const args: string[] = [];
    let current: string | null = null;
    const flush = () => {
        if (current !== null) {
            args.push(current);
            current = null;
        }
    };
    strings.forEach((text, i) => {
        for (const part of text.split(/(\s+)/)) {
            if (/^\s+$/.test(part)) {
                flush();
            } else if (part) {
                current = (current ?? '') + part;
            }
        }
        if (i < values.length) {
            const value = values[i];
            if (Array.isArray(value)) {
                flush();
                args.push(...value.map(String));
            } else {
                current = (current ?? '') + String(value);
            }
        }
    });
    flush();
    return args;
}
