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

// --- Images -------------------------------------------------------------------

/** `ghost:6-alpine` → `{ repository: 'ghost', tag: '6-alpine' }`; a digest is kept as one. */
export function splitReference(reference: string): { repository: string; tag: string } {
    const at = reference.indexOf('@');
    if (at >= 0) {
        return { repository: reference.slice(0, at), tag: reference.slice(at + 1) };
    }
    // A colon after the last slash separates the tag; one before it is a registry port.
    const colon = reference.lastIndexOf(':');
    if (colon > reference.lastIndexOf('/')) {
        return { repository: reference.slice(0, colon), tag: reference.slice(colon + 1) };
    }
    return { repository: reference, tag: 'latest' };
}

const progress = z.looseObject({
    error: z.string().optional(),
    errorDetail: z.looseObject({ message: z.string().optional() }).optional(),
});

/**
 * `docker pull`. The daemon answers 200 and then streams progress; a failure
 * part-way is an `error` line in that stream, not a status code.
 */
export async function pullImage(
    docker: DockerTransport,
    repository: string,
    tag: string,
    timeoutMs = 900_000,
): Promise<void> {
    const response = await docker({
        method: 'POST',
        path: '/images/create',
        query: { fromImage: repository, tag },
        timeoutMs,
    });
    const text = response.body.toString('utf8');
    if (response.status >= 400) {
        const parsed = errorBody.safeParse(safeJson(text));
        throw new DaemonError(response.status, parsed.success ? parsed.data.message : text.trim());
    }
    for (const line of text.split('\n')) {
        const parsed = progress.safeParse(safeJson(line));
        if (parsed.success && (parsed.data.error || parsed.data.errorDetail?.message)) {
            throw new DaemonError(500, parsed.data.errorDetail?.message ?? parsed.data.error!);
        }
    }
}

const imageInspect = z.object({
    Id: z.string(),
    RepoDigests: z.array(z.string()).nullable().default([]),
    Config: z
        .looseObject({ Env: z.array(z.string()).nullable().default([]) })
        .nullable()
        .default({ Env: [] }),
});

export interface ImageFacts {
    readonly id: string;
    readonly repoDigests: readonly string[];
    readonly env: Readonly<Record<string, string>>;
}

/** An image the daemon holds, or null when it has none by that reference. */
export async function inspectImage(
    docker: DockerTransport,
    reference: string,
): Promise<ImageFacts | null> {
    try {
        const image = await call(
            docker,
            { method: 'GET', path: `/images/${reference}/json` },
            imageInspect,
        );
        const env: Record<string, string> = {};
        for (const entry of image.Config?.Env ?? []) {
            const equals = entry.indexOf('=');
            if (equals > 0) {
                env[entry.slice(0, equals)] = entry.slice(equals + 1);
            }
        }
        return { id: image.Id, repoDigests: image.RepoDigests ?? [], env };
    } catch (error) {
        if (error instanceof DaemonError && error.status === 404) {
            return null;
        }
        throw error;
    }
}

// --- Containers -------------------------------------------------------------

const containerSummary = z.object({
    Id: z.string(),
    Names: z.array(z.string()).default([]),
    Status: z.string().default(''),
    State: z.string().default(''),
    Labels: z.record(z.string(), z.string()).nullable().default({}),
    Ports: z
        .array(
            z.object({
                IP: z.string().optional(),
                PrivatePort: z.number(),
                PublicPort: z.number().optional(),
                Type: z.string().default('tcp'),
            }),
        )
        .nullable()
        .default([]),
});

export interface ContainerFacts {
    /** Without Docker's leading slash. */
    readonly name: string;
    readonly status: string;
    /** `running`, `exited`, `created` and so on. */
    readonly state: string;
    readonly labels: Readonly<Record<string, string>>;
    /** Host ports the container publishes. */
    readonly publishedPorts: readonly number[];
}

/** `docker ps`, or with `all` `docker ps -a`, optionally filtered by label. */
export async function listContainers(
    docker: DockerTransport,
    { all = false, labels = [] }: { all?: boolean; labels?: readonly string[] } = {},
): Promise<ContainerFacts[]> {
    const query: Record<string, string> = { all: all ? '1' : '0' };
    if (labels.length > 0) {
        query.filters = JSON.stringify({ label: labels });
    }
    const containers = await call(
        docker,
        { method: 'GET', path: '/containers/json', query },
        z.array(containerSummary),
    );
    return containers.map((container) => ({
        name: (container.Names[0] ?? container.Id.slice(0, 12)).replace(/^\//, ''),
        status: container.Status,
        state: container.State,
        labels: container.Labels ?? {},
        publishedPorts: [
            ...new Set(
                (container.Ports ?? []).flatMap((port) =>
                    port.PublicPort === undefined ? [] : [port.PublicPort],
                ),
            ),
        ],
    }));
}

const portBindings = z.object({
    HostConfig: z
        .object({
            PortBindings: z
                .record(
                    z.string(),
                    z
                        .array(z.object({ HostPort: z.string().default('') }))
                        .nullable()
                        .default([]),
                )
                .nullable()
                .default({}),
        })
        .default({ PortBindings: {} }),
});

/**
 * The containers of ghost-docker sites that exist but are not running, with
 * the host ports they publish once started. A stopped container publishes
 * nothing, so `Ports` is empty for it; the ports it will take are only in its
 * configuration. A site taken down with `docker compose down` has no
 * containers and is not found here.
 */
export async function stoppedSiteContainers(docker: DockerTransport): Promise<ContainerFacts[]> {
    const stopped = (
        await listContainers(docker, { all: true, labels: ['org.ghost.docker.managed=true'] })
    ).filter((container) => container.state !== 'running');
    return Promise.all(
        stopped.map(async (container) => {
            const inspected = await call(
                docker,
                { method: 'GET', path: `/containers/${encodeURIComponent(container.name)}/json` },
                portBindings,
            );
            const ports = Object.values(inspected.HostConfig.PortBindings ?? {})
                .flatMap((bindings) => bindings ?? [])
                .map((binding) => Number(binding.HostPort))
                .filter((port) => Number.isInteger(port) && port > 0);
            return { ...container, publishedPorts: [...new Set(ports)] };
        }),
    );
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
    /** Run as this user rather than the image's. */
    user?: string;
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
                    ...(spec.user ? { User: spec.user } : {}),
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
