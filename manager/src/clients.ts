// Clients for a site's services, spoken to directly over the site's network
// once the manager has joined it (network.ts). Each has a deadline, and a
// failure is a ServiceUnreachable naming what went wrong, never a hang.
//
// The dumps themselves stay with the version-matched mysqldump and mysql in
// the db container: these clients ask questions, they do not move data.
import { once } from 'node:events';
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
    /** A TLS handshake with SNI `servername`, and the certificate the server presented. */
    certificate: (target: Target & { servername: string }) => Promise<Certificate>;
    mysql: (target: SqlTarget) => Promise<SqlConnection>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const seconds = (ms: number) => `${Math.round(ms / 1000)} seconds`;

const certificate: Clients['certificate'] = async ({
    host,
    port,
    servername,
    timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
    // Not verified against a trust store: the question is what the server
    // presents for the name, which `covers` and `issuer` answer.
    const socket = connectTls({ host, port, servername, rejectUnauthorized: false });
    try {
        await once(socket, 'secureConnect', { signal: AbortSignal.timeout(timeoutMs) });
        const peer = socket.getPeerCertificate();
        return {
            issuer: [peer.issuer?.O, peer.issuer?.CN].flat().find(Boolean) ?? 'an unnamed issuer',
            covers: checkServerIdentity(servername, peer) === undefined,
        };
    } catch (error) {
        const timedOut = (error as Error).name === 'AbortError';
        // Connected, then refused a session: TLS itself failed.
        const stage = timedOut ? 'timeout' : socket.connecting ? 'connect' : 'tls';
        const said = timedOut ? `no answer within ${seconds(timeoutMs)}` : (error as Error).message;
        throw new ServiceUnreachable(stage, `${host}:${port}: ${said}`, { cause: error });
    } finally {
        socket.destroy();
    }
};

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

export const nodeClients: Clients = { certificate, mysql };
