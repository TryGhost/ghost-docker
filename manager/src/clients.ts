// Clients for a site's services, spoken to directly over the site's network
// once the manager has joined it (network.ts). Each has a deadline, and a
// failure is a ServiceUnreachable naming what went wrong, never a hang.
//
// The dumps themselves stay with the version-matched mysqldump and mysql in
// the db container: these clients ask questions, they do not move data.
import { request } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { checkServerIdentity, connect as connectTls } from 'node:tls';
import { createConnection, type Connection } from 'mysql2/promise';

/** The service could not be reached, or did not answer in time. */
export class ServiceUnreachable extends Error {
    /** `tls`: something answered, but no TLS session could be set up with it. */
    readonly stage: 'connect' | 'timeout' | 'tls' | 'query';
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

export interface HttpAnswer {
    readonly status: number;
    /** The Location header; empty when there is none. */
    readonly location: string;
}

export interface Certificate {
    /** Who issued it: the organisation, or failing that the common name. */
    readonly issuer: string;
    /** Whether it names the server name that was asked for. */
    readonly covers: boolean;
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
    /** One GET, without following redirects, with the headers given (Host among them). */
    http: (
        target: Target & { path: string; headers?: Record<string, string> },
    ) => Promise<HttpAnswer>;
    /** A TLS handshake with SNI `servername`, and the certificate the server presented. */
    certificate: (target: Target & { servername: string }) => Promise<Certificate>;
    /** The first line a server sends once connected, such as an SMTP greeting. */
    greeting: (target: Target) => Promise<string>;
    mysql: (target: SqlTarget) => Promise<SqlConnection>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const seconds = (ms: number) => `${Math.round(ms / 1000)} seconds`;

const unreachable = (target: Target, error: unknown): ServiceUnreachable =>
    error instanceof ServiceUnreachable
        ? error
        : new ServiceUnreachable(
              'connect',
              `${target.host}:${target.port}: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
          );

const http: Clients['http'] = (target) =>
    new Promise((resolve, reject) => {
        const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        // Plain node:http with no agent: no proxy settings apply, and the
        // socket is closed once the answer has been read.
        const asked = request(
            {
                host: target.host,
                port: target.port,
                path: target.path,
                method: 'GET',
                headers: target.headers,
                agent: false,
                timeout: timeoutMs,
            },
            (response) => {
                response.resume();
                resolve({
                    status: response.statusCode ?? 0,
                    location: String(response.headers.location ?? ''),
                });
            },
        );
        asked.on('timeout', () =>
            asked.destroy(
                new ServiceUnreachable('timeout', `no answer within ${seconds(timeoutMs)}`),
            ),
        );
        asked.on('error', (error) => reject(unreachable(target, error)));
        asked.end();
    });

const certificate: Clients['certificate'] = (target) =>
    new Promise((resolve, reject) => {
        const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        let connected = false;
        // Not verified against a trust store: the question is what the server
        // presents for the name, which `covers` and `issuer` answer.
        const socket = connectTls({
            host: target.host,
            port: target.port,
            servername: target.servername,
            rejectUnauthorized: false,
            timeout: timeoutMs,
        });
        socket.once('connect', () => {
            connected = true;
        });
        socket.once('secureConnect', () => {
            const peer = socket.getPeerCertificate();
            socket.destroy();
            if (!peer || Object.keys(peer).length === 0) {
                reject(new ServiceUnreachable('tls', 'the server presented no certificate'));
                return;
            }
            resolve({
                issuer:
                    [peer.issuer?.O, peer.issuer?.CN].flat().find(Boolean) ?? 'an unnamed issuer',
                covers: checkServerIdentity(target.servername, peer) === undefined,
            });
        });
        socket.once('timeout', () => {
            socket.destroy();
            reject(new ServiceUnreachable('timeout', `no answer within ${seconds(timeoutMs)}`));
        });
        socket.once('error', (error) => {
            socket.destroy();
            // Connected, then refused a session: TLS itself failed.
            reject(
                connected
                    ? new ServiceUnreachable('tls', error.message, { cause: error })
                    : unreachable(target, error),
            );
        });
    });

const greeting: Clients['greeting'] = (target) =>
    new Promise((resolve, reject) => {
        const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const socket = connectTcp({ host: target.host, port: target.port, timeout: timeoutMs });
        socket.once('data', (data) => {
            socket.destroy();
            resolve(String(data).split('\r\n')[0] ?? '');
        });
        socket.once('end', () => {
            socket.destroy();
            reject(new ServiceUnreachable('connect', 'the connection closed without a greeting'));
        });
        socket.once('timeout', () => {
            socket.destroy();
            reject(new ServiceUnreachable('timeout', `no answer within ${seconds(timeoutMs)}`));
        });
        socket.once('error', (error) => {
            socket.destroy();
            reject(unreachable(target, error));
        });
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
        await connection.end().catch(() => connection.destroy());
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

export const nodeClients: Clients = { http, certificate, greeting, mysql };
