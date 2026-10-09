// Clients for a site's services, spoken to directly over the site's network
// once the manager has joined it (network.ts). Each has a deadline, and a
// failure is a ServiceUnreachable naming what went wrong, never a hang.
//
// The dumps themselves stay with the version-matched mysqldump and mysql in
// the db container: these clients ask questions, they do not move data.
import { request } from 'node:https';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import { createConnection, type Connection } from 'mysql2/promise';

/** The service could not be reached, or did not answer in time. */
export class ServiceUnreachable extends Error {
    /**
     * `tls`: something answered, but no TLS session could be set up with it.
     * `http`: a session was set up, and no HTTP answer came back over it.
     */
    readonly stage: 'connect' | 'timeout' | 'tls' | 'http' | 'query';
    constructor(stage: ServiceUnreachable['stage'], message: string, options?: ErrorOptions) {
        super(message, options);
        this.stage = stage;
    }
}

export interface Target {
    readonly host: string;
    readonly port: number;
    readonly timeoutMs?: number;
}

export interface Certificate {
    /** Who issued it: the organisation, or failing that the common name. */
    readonly issuer: string;
    /** Whether it names the server name that was asked for. */
    readonly covers: boolean;
    /** When it expires, as an ISO date and time. */
    readonly validTo: string;
    /** Whether it is out of its validity period now. */
    readonly expired: boolean;
    /**
     * Why it does not chain to a CA in Node's trust store, which is close to
     * what browsers trust; null when it does. A staging or internal CA's never
     * does.
     */
    readonly untrusted: string | null;
}

/** An HTTPS request's answer, and the certificate the server presented for it. */
export interface HttpsAnswer {
    readonly certificate: Certificate;
    readonly status: number;
    /** Where a redirect points, as the server wrote it; null for any other answer. */
    readonly location: string | null;
    /** The start of the body: enough to tell what answered. */
    readonly body: string;
}

/** A connection to one database as one user. Rows come back as arrays. */
export interface SqlConnection {
    query: (sql: string, timeoutMs?: number) => Promise<unknown[][]>;
    /** Always called, also after a failure; closing twice is harmless. */
    close: () => Promise<void>;
}

export interface SqlTarget extends Target {
    readonly user: string;
    readonly password: string;
    readonly database: string;
}

export interface Clients {
    /**
     * `GET path` over TLS with SNI and Host both `servername`, as a browser
     * asking for that name would, at `host:port`, whatever `host` is.
     */
    https: (target: Target & { servername: string; path: string }) => Promise<HttpsAnswer>;
    mysql: (target: SqlTarget) => Promise<SqlConnection>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const seconds = (ms: number) => `${Math.round(ms / 1000)} seconds`;

/** The longest body kept: an answer is identified by its start. */
const BODY_BYTES = 64 * 1024;

/** What the server presented, judged for `servername` now. */
function assess(socket: TLSSocket, servername: string): Certificate {
    const peer = socket.getPeerCertificate();
    const validTo = new Date(peer.valid_to);
    return {
        issuer: [peer.issuer?.O, peer.issuer?.CN].flat().find(Boolean) ?? 'an unnamed issuer',
        covers: checkServerIdentity(servername, peer) === undefined,
        validTo: Number.isNaN(validTo.getTime()) ? peer.valid_to : validTo.toISOString(),
        expired: Date.now() > validTo.getTime() || Date.now() < new Date(peer.valid_from).getTime(),
        untrusted: socket.authorized ? null : String(socket.authorizationError ?? 'not trusted'),
    };
}

const https: Clients['https'] = ({
    host,
    port,
    servername,
    path,
    timeoutMs = DEFAULT_TIMEOUT_MS,
}) =>
    new Promise((resolve, reject) => {
        let stage: ServiceUnreachable['stage'] = 'connect';
        // Not refused for an untrusted certificate: what it presents is part of
        // the answer, judged by assess().
        const req = request({
            host,
            port,
            servername,
            path,
            method: 'GET',
            headers: { Host: servername, Accept: 'application/json' },
            rejectUnauthorized: false,
            agent: false,
            timeout: timeoutMs,
        });
        const fail = (which: ServiceUnreachable['stage'], said: string, cause?: unknown) => {
            req.destroy();
            reject(new ServiceUnreachable(which, `${host}:${port}: ${said}`, { cause }));
        };
        req.on('socket', (socket) => {
            socket.on('connect', () => (stage = 'tls'));
            socket.on('secureConnect', () => (stage = 'http'));
        });
        req.on('timeout', () => fail('timeout', `no answer within ${seconds(timeoutMs)}`));
        req.on('error', (error) => fail(stage, error.message, error));
        req.on('response', (response) => {
            const certificate = assess(response.socket as TLSSocket, servername);
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
                if (size < BODY_BYTES) {
                    chunks.push(chunk);
                    size += chunk.length;
                }
            });
            response.on('end', () => {
                resolve({
                    certificate,
                    status: response.statusCode ?? 0,
                    location: response.headers.location ?? null,
                    body: Buffer.concat(chunks).subarray(0, BODY_BYTES).toString('utf8'),
                });
                req.destroy();
            });
            response.on('error', (error) => fail('http', error.message, error));
        });
        req.end();
    });

/** What a mysql2 error says, with MySQL's own code when there is one. */
const sqlMessage = (error: unknown): string => {
    const { code, message } = error as { code?: string; message?: string };
    return message
        ? code && !message.includes(code)
            ? `${message} (${code})`
            : message
        : String(error);
};

const mysql: Clients['mysql'] = async (target) => {
    const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let connection: Connection;
    try {
        connection = await createConnection({
            host: target.host,
            port: target.port,
            user: target.user,
            password: target.password,
            database: target.database,
            charset: 'utf8mb4',
            connectTimeout: timeoutMs,
            rowsAsArray: true,
            supportBigNumbers: true,
            bigNumberStrings: true,
        });
    } catch (error) {
        const code = (error as { code?: string }).code;
        throw new ServiceUnreachable(
            code === 'ETIMEDOUT' ? 'timeout' : 'connect',
            `${target.host}:${target.port}: ${sqlMessage(error)}`,
            { cause: error },
        );
    }
    let closed = false;
    const close = async () => {
        if (closed) {
            return;
        }
        closed = true;
        // end() asks the server to close; the socket is destroyed whatever
        // it does, so a server that goes away first cannot leave it open
        // and keep the process alive.
        await connection.end().catch(() => undefined);
        connection.destroy();
    };
    return {
        query: async (sql, queryTimeoutMs = 60_000) => {
            try {
                const [rows] = await connection.query({ sql, timeout: queryTimeoutMs });
                return Array.isArray(rows) ? (rows as unknown[][]) : [];
            } catch (error) {
                throw new ServiceUnreachable('query', sqlMessage(error), { cause: error });
            }
        },
        close,
    };
};

export const nodeClients: Clients = { https, mysql };
