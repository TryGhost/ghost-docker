// The supervisor's HTTP transport: protocol v1 on a Unix socket
// (docs/upgrade-supervisor.md#the-api). Routing, body limits and timeouts
// only; what each request decides is supervisor.ts.
//
// The socket's directory is the authentication: only the operator and Ghost's
// group can reach it. The server still bounds what a caller can make it hold:
// small bodies, short timeouts, few connections.
import { chmodSync, lstatSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BODY_MAX, PROTOCOL } from './protocol.ts';
import { failure, type Answer, type Supervisor } from './supervisor.ts';

const MAX_CONNECTIONS = 16;

const send = (response: ServerResponse, answer: Answer): void => {
    const body = `${JSON.stringify(answer.body)}\n`;
    response.writeHead(answer.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
    });
    response.end(body);
};

/** The body, refused past BODY_MAX without reading the rest; null when too large. */
function readBody(request: IncomingMessage): Promise<string | null> {
    return new Promise((resolve, reject) => {
        const declared = Number(request.headers['content-length'] ?? 0);
        if (declared > BODY_MAX) {
            resolve(null);
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        request.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > BODY_MAX) {
                request.destroy();
                resolve(null);
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}

async function route(supervisor: Supervisor, request: IncomingMessage): Promise<Answer> {
    const path = new URL(request.url ?? '/', 'http://supervisor').pathname.replace(/\/+$/, '');
    const method = request.method ?? 'GET';
    const only = (allowed: string, answer: () => Answer | Promise<Answer>) =>
        method === allowed
            ? answer()
            : failure('method-not-allowed', `${path} takes ${allowed}, not ${method}.`);

    if (path === '/v1') {
        return only('GET', () => ({ status: 200, body: { protocol: PROTOCOL } }));
    }
    if (path === '/v1/status') {
        return only('GET', () => ({ status: 200, body: supervisor.status() }));
    }
    if (path === '/v1/requests') {
        return only('POST', async () => {
            const text = await readBody(request);
            if (text === null) {
                return failure('too-large', `A request body is at most ${BODY_MAX} bytes.`);
            }
            let body: unknown;
            try {
                body = JSON.parse(text);
            } catch {
                return failure('malformed', 'The request body is not JSON.');
            }
            return supervisor.request(body);
        });
    }
    const job = /^\/v1\/jobs\/([^/]+)$/.exec(path);
    if (job) {
        return only('GET', () => supervisor.lookup(decodeURIComponent(job[1]!)));
    }
    return failure('not-found', `There is no ${path} in protocol ${PROTOCOL}.`);
}

export function supervisorServer(supervisor: Supervisor, log: (text: string) => void): Server {
    const server = createServer(async (request, response) => {
        try {
            send(response, await route(supervisor, request));
        } catch (error) {
            log(`A request failed: ${(error as Error).stack ?? String(error)}\n`);
            if (!response.headersSent) {
                send(response, failure('unavailable', 'The supervisor failed to answer.'));
            }
        }
    });
    server.headersTimeout = 5_000;
    server.requestTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxConnections = MAX_CONNECTIONS;
    return server;
}

/**
 * Listens on `path`, replacing a socket an earlier run left behind (never any
 * other file), and opens it to the directory's group: the directory is the gate.
 */
export async function listen(server: Server, path: string): Promise<void> {
    try {
        if (lstatSync(path).isSocket()) {
            rmSync(path);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => {
            server.off('error', reject);
            resolve();
        });
    });
    chmodSync(path, 0o666);
}
