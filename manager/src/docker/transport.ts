// The Docker Engine API over the mounted socket.
//
// The manager talks to the daemon directly rather than through the docker
// CLI: the API answers in JSON that can be typed, reports failures as status
// codes with a message, and needs no process to be spawned and parsed. The
// CLI stays in the image for Compose, which has no API.
import { Agent, request } from 'undici';

/** Engine 25.0, the minimum this stack supports, speaks this version. */
export const API_VERSION = 'v1.44';

export interface DockerRequest {
    method: 'GET' | 'POST' | 'DELETE';
    /** Below the version prefix, starting with `/`. */
    path: string;
    query?: Record<string, string>;
    /** Sent as JSON. */
    body?: unknown;
    timeoutMs?: number;
}

export interface DockerResponse {
    status: number;
    body: Buffer;
}

/** One request to the daemon. Tests substitute this. */
export type DockerTransport = (request: DockerRequest) => Promise<DockerResponse>;

/** The daemon could not be reached at all: no socket, nothing listening, no permission. */
export class DaemonUnreachable extends Error {}

/** The daemon did not answer within the deadline. */
export class DaemonTimeout extends Error {
    readonly timeoutMs: number;
    constructor(timeoutMs: number) {
        super(`the Docker daemon did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
        this.timeoutMs = timeoutMs;
    }
}

export function socketTransport(socketPath: string): DockerTransport {
    const agent = new Agent({ connect: { socketPath } });
    return async ({ method, path, query, body, timeoutMs = 30_000 }) => {
        const url = new URL(`http://docker/${API_VERSION}${path}`);
        for (const [key, value] of Object.entries(query ?? {})) {
            url.searchParams.set(key, value);
        }
        try {
            const response = await request(url, {
                dispatcher: agent,
                method,
                body: body === undefined ? undefined : JSON.stringify(body),
                headers: body === undefined ? {} : { 'content-type': 'application/json' },
                signal: AbortSignal.timeout(timeoutMs),
            });
            return {
                status: response.statusCode,
                body: Buffer.from(await response.body.arrayBuffer()),
            };
        } catch (error) {
            if (error instanceof Error && error.name === 'TimeoutError') {
                throw new DaemonTimeout(timeoutMs);
            }
            throw new DaemonUnreachable(describe(error, socketPath), { cause: error });
        }
    };
}

function describe(error: unknown, socketPath: string): string {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    switch (code) {
        case 'ENOENT':
            return `the Docker socket was not found at ${socketPath}`;
        case 'ECONNREFUSED':
            return `nothing is listening on the Docker socket at ${socketPath}`;
        case 'EACCES':
            return `the Docker socket at ${socketPath} is not accessible to this user`;
        default:
            return error instanceof Error ? error.message : String(error);
    }
}
