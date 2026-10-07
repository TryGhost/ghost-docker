// A fake Io: captured output, a scripted daemon and `docker-compose`, a
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
    /** Free bytes on the site's filesystem; 50 GB when unset. */
    freeBytes?: number | null;
    /** What GET /containers/json answers, as the Engine API spells it. */
    containers?: unknown[];
    /**
     * `docker-compose ...` after the --project-directory and -f options, with
     * the environment it was given. Undefined falls through to "unexpected".
     */
    composeRun?: (args: string[], env: Record<string, string>) => ProgramResult | undefined;
    /**
     * Any other request, answered before the defaults: return undefined to
     * fall through. A one-shot container is a `POST /containers/create`
     * whose answer here decides what it prints and exits with (see `ran`).
     */
    api?: (request: DockerRequest) => DockerResponse | undefined;
    /** What a one-shot container other than the doctor's probe does. */
    run?: (
        spec: CreatedContainer,
    ) => { status: number; stdout?: string; stderr?: string } | undefined;
}

/** A container the manager asked the fake daemon to create. */
export interface CreatedContainer {
    image: string;
    cmd: string[];
    entrypoint: string[];
    binds: string[];
    network: string;
    user: string;
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
    /** What each spinner said, in order; the fake terminal draws none. */
    spun: string[];
    /** Questions asked; answers to give, in order. Null: no terminal. */
    asked: string[];
    answers: string[] | null;
    /** The Io `run` uses, for calling a function directly; output goes into `out`. */
    io: (out?: { stdout: string; stderr: string }) => Io;
    cleanup: () => void;
}

export { ok, failed, json };

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
        spun: [],
        asked: [],
        answers: null,
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
        io: (out = { stdout: '', stderr: '' }) => ({
            stdout: (text) => void (out.stdout += text),
            stderr: (text) => void (out.stderr += text),
            busy: (text, work) => {
                state.spun.push(text);
                return work();
            },
            env: state.env,
            cwd: () => state.cwd,
            uid: () => state.uid,
            gid: () => state.gid,
            docker: async (request) => {
                state.requests.push(request);
                return daemon(state, request);
            },
            prompt:
                state.answers === null
                    ? null
                    : {
                          choose: async (message) => {
                              state.asked.push(message);
                              return state.answers!.shift() as never;
                          },
                          text: async (message, check) => {
                              state.asked.push(message);
                              const answer = state.answers!.shift() ?? '';
                              const refused = check?.(answer);
                              if (refused) {
                                  throw new Error(`the fake terminal was refused: ${refused}`);
                              }
                              return answer;
                          },
                      },
            freeBytes: () => state.daemon.freeBytes ?? 50 * 1024 ** 3,
            exec: fakeExec((command, args, options) => {
                state.calls.push([command, ...args]);
                if (command !== 'docker-compose') {
                    return failed(undefined, `spawn ${command} ENOENT`);
                }
                if (args[0] === 'version') {
                    return state.daemon.compose
                        ? ok(`${state.daemon.compose}\n`)
                        : failed(1, 'unknown command');
                }
                if (args[0] === '--project-directory') {
                    // Past --project-directory DIR and each -f FILE.
                    let rest = args.slice(2);
                    while (rest[0] === '-f') {
                        rest = rest.slice(2);
                    }
                    const answer = state.daemon.composeRun?.(rest, options.env ?? {});
                    if (answer) {
                        return answer;
                    }
                }
                return failed(1, `unexpected: docker-compose ${args.join(' ')}`);
            }),
        }),
        run: async (...argv) => {
            const out = { stdout: '', stderr: '' };
            // managerVersion() reads the real environment.
            const previous = process.env.GD_VERSION_FILE;
            process.env.GD_VERSION_FILE = state.env.GD_VERSION_FILE;
            const io = state.io(out);
            try {
                return { code: await run(argv, io), stdout: out.stdout, stderr: out.stderr };
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

/** The doctor's sibling, reading the probe file back. */
let sibling: { binds: string[]; cmd: string[] } | null = null;
/** Other one-shot containers, by the index in their ID. */
const ran: { status: number; stdout?: string; stderr?: string }[] = [];

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
    const answered = state.daemon.api?.(request);
    if (answered) {
        return Promise.resolve(answered);
    }
    if (method === 'GET' && path === '/containers/json') {
        return Promise.resolve(json(200, state.daemon.containers ?? []));
    }
    if (method === 'POST' && path === '/containers/create' && state.daemon.run) {
        const body = request.body as {
            Image: string;
            Cmd: string[];
            Entrypoint?: string[];
            User?: string;
            HostConfig: { Binds: string[]; NetworkMode: string };
        };
        const outcome = state.daemon.run({
            image: body.Image,
            cmd: body.Cmd,
            entrypoint: body.Entrypoint ?? [],
            binds: body.HostConfig.Binds,
            network: body.HostConfig.NetworkMode,
            user: body.User ?? '',
        });
        if (outcome) {
            const id = `ran-${ran.length}`;
            ran.push(outcome);
            return Promise.resolve(json(201, { Id: id }));
        }
    }
    const one = /^\/containers\/ran-(\d+)(\/\w+)?$/.exec(path);
    if (one) {
        const outcome = ran[Number(one[1])]!;
        switch (one[2]) {
            case '/wait':
                return Promise.resolve(json(200, { StatusCode: outcome.status }));
            case '/logs':
                return Promise.resolve({
                    status: 200,
                    body: Buffer.concat([
                        frame(1, outcome.stdout ?? ''),
                        frame(2, outcome.stderr ?? ''),
                    ]),
                });
            default:
                return Promise.resolve(empty);
        }
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
 * exec({ timeout })`...` does, returns an instance carrying them; the program
 * sees the environment. Typed as the real thing; only the fields callers
 * read exist.
 */
interface ExecOptions {
    env?: Record<string, string>;
}

function fakeExec(
    program: (command: string, args: string[], options: ExecOptions) => ProgramResult,
): Exec {
    const make = (options: ExecOptions) => {
        const run = (first: unknown, ...values: unknown[]): unknown => {
            if (!isTemplate(first)) {
                return make({ ...options, ...(first as ExecOptions) });
            }
            const [command = '', ...args] = parseTemplate(first, values);
            const result = program(command, args, options);
            return Promise.resolve({
                ...result,
                failed: result.exitCode !== 0,
                shortMessage: result.exitCode === undefined ? result.stderr : '',
            });
        };
        return run;
    };
    return make({}) as unknown as Exec;
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
