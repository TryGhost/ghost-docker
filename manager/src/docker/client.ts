// What the manager asks the daemon for, typed. Each function is one question
// with one answer shape; the endpoints are the Engine API's.
//
// The manager cannot look at the host: it is in a container. Everything it
// knows about the platform it asks the daemon for, through the mounted socket.
import { z } from 'zod';
import {
    DaemonTimeout,
    DaemonUnreachable,
    type DockerRequest,
    type DockerTransport,
} from './transport.ts';

/** The daemon answered with an error status; `message` is its own wording. */
export class DaemonError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

const errorBody = z.object({ message: z.string() });

/** A request whose answer is JSON, or a DaemonError carrying the daemon's message. */
async function call<T>(
    docker: DockerTransport,
    request: DockerRequest,
    schema: z.ZodType<T>,
): Promise<T> {
    const response = await docker(request);
    const text = response.body.toString('utf8');
    if (response.status >= 400) {
        const parsed = errorBody.safeParse(safeJson(text));
        throw new DaemonError(
            response.status,
            parsed.success ? parsed.data.message : text.trim() || `HTTP ${response.status}`,
        );
    }
    if (response.status === 204 || text === '') {
        return schema.parse(undefined);
    }
    return schema.parse(JSON.parse(text));
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

// --- /info ------------------------------------------------------------------

const info = z.object({
    ServerVersion: z.string().default(''),
    OperatingSystem: z.string().default(''),
    OSType: z.string().default(''),
    Architecture: z.string().default(''),
    MemTotal: z.number().default(0),
    SecurityOptions: z.array(z.string()).nullable().default([]),
});

export interface DaemonInfo {
    serverVersion: string;
    operatingSystem: string;
    osType: string;
    architecture: string;
    memoryBytes: number;
    rootless: boolean;
}

export type DaemonResult = { ok: true; info: DaemonInfo } | { ok: false; reason: string };

export async function daemonInfo(docker: DockerTransport): Promise<DaemonResult> {
    let parsed;
    try {
        parsed = await call(docker, { method: 'GET', path: '/info', timeoutMs: 20_000 }, info);
    } catch (error) {
        if (
            error instanceof DaemonUnreachable ||
            error instanceof DaemonTimeout ||
            error instanceof DaemonError
        ) {
            return { ok: false, reason: error.message };
        }
        if (error instanceof z.ZodError || error instanceof SyntaxError) {
            return {
                ok: false,
                reason: 'the daemon answered /info with something that is not its usual JSON',
            };
        }
        throw error;
    }
    return {
        ok: true,
        info: {
            serverVersion: parsed.ServerVersion,
            operatingSystem: parsed.OperatingSystem,
            osType: parsed.OSType,
            architecture: parsed.Architecture,
            memoryBytes: parsed.MemTotal,
            rootless: (parsed.SecurityOptions ?? []).some((option) => option.includes('rootless')),
        },
    };
}

// --- One-shot containers ----------------------------------------------------

export interface Bind {
    /** The path as the daemon resolves it: a host path. */
    source: string;
    target: string;
    readOnly?: boolean;
}

export interface RunSpec {
    image: string;
    cmd: readonly string[];
    entrypoint?: readonly string[];
    binds?: readonly Bind[];
    /** `none`, `host`, or a network's name. */
    network?: string;
    /** How long the container may run before it is killed. */
    timeoutMs?: number;
}

export interface RunResult {
    /** The exit status, or null when the container could not be run or was killed. */
    status: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

const created = z.object({ Id: z.string() });
const waited = z.object({ StatusCode: z.number() });
const nothing = z.undefined();

/**
 * `docker run --rm`, as the API spells it: create, start, wait, read the
 * output, remove. A container that outlives the deadline is killed. Failure
 * to create or start the container is a result with the daemon's message,
 * not an exception, like a process that could not be spawned.
 */
export async function runOnce(docker: DockerTransport, spec: RunSpec): Promise<RunResult> {
    const timeoutMs = spec.timeoutMs ?? 120_000;
    let id: string;
    try {
        const container = await call(
            docker,
            {
                method: 'POST',
                path: '/containers/create',
                body: {
                    Image: spec.image,
                    Cmd: [...spec.cmd],
                    ...(spec.entrypoint ? { Entrypoint: [...spec.entrypoint] } : {}),
                    Tty: false,
                    OpenStdin: false,
                    HostConfig: {
                        Binds: (spec.binds ?? []).map(
                            (bind) => `${bind.source}:${bind.target}${bind.readOnly ? ':ro' : ''}`,
                        ),
                        NetworkMode: spec.network ?? 'none',
                    },
                },
            },
            created,
        );
        id = container.Id;
    } catch (error) {
        if (error instanceof DaemonError) {
            return { status: null, stdout: '', stderr: error.message, timedOut: false };
        }
        throw error;
    }

    try {
        try {
            await call(docker, { method: 'POST', path: `/containers/${id}/start` }, nothing);
        } catch (error) {
            if (error instanceof DaemonError) {
                return { status: null, stdout: '', stderr: error.message, timedOut: false };
            }
            throw error;
        }

        let status: number | null = null;
        let timedOut = false;
        try {
            status = (
                await call(
                    docker,
                    { method: 'POST', path: `/containers/${id}/wait`, timeoutMs },
                    waited,
                )
            ).StatusCode;
        } catch (error) {
            if (!(error instanceof DaemonTimeout)) {
                throw error;
            }
            timedOut = true;
            await docker({ method: 'POST', path: `/containers/${id}/kill` }).catch(() => undefined);
        }

        const logs = await docker({
            method: 'GET',
            path: `/containers/${id}/logs`,
            query: { stdout: '1', stderr: '1' },
        });
        const { stdout, stderr } = demultiplex(logs.body);
        return { status, stdout, stderr, timedOut };
    } finally {
        await docker({
            method: 'DELETE',
            path: `/containers/${id}`,
            query: { force: '1', v: '1' },
        }).catch(() => undefined);
    }
}

/**
 * The log stream of a container without a TTY: frames of an 8-byte header
 * (stream type, three zero bytes, big-endian payload length) and a payload.
 */
export function demultiplex(stream: Buffer): { stdout: string; stderr: string } {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let offset = 0;
    while (offset + 8 <= stream.length) {
        const type = stream[offset];
        const length = stream.readUInt32BE(offset + 4);
        const payload = stream.subarray(offset + 8, offset + 8 + length);
        (type === 2 ? err : out).push(payload);
        offset += 8 + length;
    }
    return {
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
    };
}

/** A frame of that stream; what a fake daemon produces. */
export function frame(type: 1 | 2, text: string): Buffer {
    const payload = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(8);
    header[0] = type;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
}
