// The MySQL client against a server that speaks the protocol over a real
// socket, and stops answering when told to: what a timeout leaves behind is
// the socket's, so it cannot be faked at the Io.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { after, afterEach, before, test } from 'node:test';
import { CLOSE_MS, nodeClients, ServiceUnreachable } from '../src/clients.ts';

/** One packet: a three-byte length, the sequence id, the payload. */
const packet = (sequence: number, payload: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUIntLE(payload.length, 0, 3);
    head[3] = sequence;
    return Buffer.concat([head, payload]);
};

const PROTOCOL_41 = 0x200;
const SECURE_CONNECTION = 0x8000;
const PLUGIN_AUTH = 0x80000;
const CAPABILITIES = 0x1 | 0x8 | PROTOCOL_41 | 0x2000 | SECURE_CONNECTION | PLUGIN_AUTH;

/** Protocol version 10's greeting, offering mysql_native_password. */
const greeting = () => {
    const capabilities = Buffer.alloc(9);
    capabilities.writeUInt16LE(CAPABILITIES & 0xffff, 0);
    capabilities[2] = 45; // utf8mb4
    capabilities.writeUInt16LE(2, 3); // autocommit
    capabilities.writeUInt16LE(CAPABILITIES >>> 16, 5);
    capabilities[7] = 21;
    return Buffer.concat([
        Buffer.from([10]),
        Buffer.from('8.4.0-test\0'),
        Buffer.from([1, 0, 0, 0]),
        Buffer.from('abcdefgh\0'),
        capabilities.subarray(0, 8),
        Buffer.alloc(10),
        Buffer.from('ijklmnopqrst\0'),
        Buffer.from('mysql_native_password\0'),
    ]);
};

const OK = Buffer.from([0, 0, 0, 2, 0, 0, 0]);

/** MySQL's refusal of a sign-in: error 1045, SQL state 28000. */
const ACCESS_DENIED = Buffer.concat([
    Buffer.from([0xff, 0x15, 0x04]),
    Buffer.from("#28000Access denied for user 'intruder'"),
]);

/** What the server saw of one client. */
interface Seen {
    queries: string[];
    quit: boolean;
    /** Whether the client's side of the socket is gone. */
    gone: boolean;
    socket: Socket;
}

/**
 * Refuses the user `intruder`, answers `DO` statements with OK and leaves
 * anything else unanswered. It never closes its side by itself, as a server that has stopped answering
 * need not, so a client that only half-closes keeps the socket open.
 */
let server: Server;
let port: number;
const clients: Seen[] = [];

before(async () => {
    server = createServer({ allowHalfOpen: true }, (socket) => {
        const seen: Seen = { queries: [], quit: false, gone: false, socket };
        clients.push(seen);
        socket.on('end', () => (seen.gone = true));
        socket.on('error', () => undefined);
        let buffered = Buffer.alloc(0);
        let signedIn = false;
        socket.on('data', (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUIntLE(0, 3)) {
                const length = buffered.readUIntLE(0, 3);
                const payload = buffered.subarray(4, 4 + length);
                buffered = buffered.subarray(4 + length);
                if (!signedIn) {
                    // The handshake response: the user follows 32 bytes of
                    // capabilities, packet size, charset and filler.
                    const user = payload.subarray(32, payload.indexOf(0, 32)).toString('utf8');
                    signedIn = user !== 'intruder';
                    socket.write(packet(2, signedIn ? OK : ACCESS_DENIED));
                } else if (payload[0] === 0x01) {
                    seen.quit = true;
                } else if (payload[0] === 0x03) {
                    const sql = payload.subarray(1).toString('utf8');
                    seen.queries.push(sql);
                    if (sql.startsWith('DO ')) {
                        socket.write(packet(1, OK));
                    }
                }
            }
        });
        socket.write(packet(0, greeting()));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as { port: number }).port;
});

afterEach(() => {
    for (const { socket } of clients) {
        socket.destroy();
    }
});

after(() => server.close());

/**
 * The client sockets this process still has open: every TCP socket but the
 * server's own ends. The server cannot tell a socket the client only
 * half-closed from one it closed, and a half-closed socket keeps the process
 * alive.
 */
async function clientSockets(): Promise<number> {
    await new Promise((resolve) => setImmediate(resolve));
    const sockets = process.getActiveResourcesInfo().filter((name) => name === 'TCPSocketWrap');
    return sockets.length - clients.filter(({ socket }) => !socket.destroyed).length;
}

const connect = (user = 'ghost') =>
    nodeClients.mysql({ host: '127.0.0.1', port, user, password: 'x', database: 'ghost' });

/** The last client the server saw, once its side is gone or `ms` has passed. */
async function goneWithin(ms: number): Promise<Seen> {
    const seen = clients.at(-1)!;
    const deadline = Date.now() + ms;
    while (!seen.gone && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return seen;
}

/** How long `work` took, in milliseconds. */
async function timed(work: () => Promise<unknown>): Promise<number> {
    const start = performance.now();
    await work();
    return performance.now() - start;
}

test('a closed connection says goodbye, and is gone though the server never closes its side', async () => {
    const sql = await connect();
    assert.deepEqual(await sql.query('DO 1'), []);
    // This server never closes its side, so close() waits CLOSE_MS for it.
    const took = await timed(() => sql.close());
    assert.ok(took < CLOSE_MS + 500, `close took ${Math.round(took)} ms`);
    const seen = await goneWithin(500);
    assert.ok(seen.quit, 'the server was not told');
    assert.ok(seen.gone, 'the server did not see the client go');
    assert.equal(await clientSockets(), 0);
    await sql.close();
});

test('a query timeout reports itself, and close does not wait on the query', async () => {
    const sql = await connect();
    await assert.rejects(
        sql.query('SELECT SLEEP(60)', 50),
        (error) =>
            error instanceof ServiceUnreachable &&
            error.stage === 'timeout' &&
            /^127\.0\.0\.1:\d+: no answer to a query within/.test(error.message),
    );
    const took = await timed(() => sql.close());
    assert.ok(took < 100, `close took ${Math.round(took)} ms`);
    const seen = await goneWithin(500);
    assert.ok(seen.gone, 'the socket stayed open');
    assert.deepEqual(seen.queries, ['SELECT SLEEP(60)']);
    assert.equal(await clientSockets(), 0);
});

test('close while a query is still outstanding does not wait on it', async () => {
    const sql = await connect();
    const pending = sql.query('SELECT SLEEP(60)', 60_000);
    const abandoned = assert.rejects(
        pending,
        (error) =>
            error instanceof ServiceUnreachable && /the connection was closed/.test(error.message),
    );
    while (clients.at(-1)!.queries.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const took = await timed(() => sql.close());
    assert.ok(took < 100, `close took ${Math.round(took)} ms`);
    assert.ok((await goneWithin(500)).gone, 'the socket stayed open');
    assert.equal(await clientSockets(), 0);
    await abandoned;
});

test('connections that time out one after another leave none open', async () => {
    const before = clients.length;
    for (let round = 0; round < 5; round += 1) {
        const sql = await connect();
        await assert.rejects(sql.query('SELECT SLEEP(60)', 20), ServiceUnreachable);
        await sql.close();
    }
    await goneWithin(500);
    assert.deepEqual(
        clients.slice(before).map((seen) => seen.gone),
        [true, true, true, true, true],
    );
    assert.equal(await clientSockets(), 0);
    // And a fresh connection still works.
    const sql = await connect();
    assert.deepEqual(await sql.query('DO 1'), []);
    await sql.close();
});

test('a refused sign-in is an error naming the refusal, and leaves no socket', async () => {
    await assert.rejects(
        connect('intruder'),
        (error) =>
            error instanceof ServiceUnreachable &&
            error.stage === 'connect' &&
            /^127\.0\.0\.1:\d+: Access denied for user 'intruder' \(ER_ACCESS_DENIED_ERROR\)$/.test(
                error.message,
            ),
    );
    // Destroying the socket raises nothing uncaught once the refusal is in;
    // the test runner fails the test if it does.
    assert.ok((await goneWithin(500)).gone, 'the socket stayed open');
    assert.equal(await clientSockets(), 0);
    // And the next sign-in works.
    const sql = await connect();
    assert.deepEqual(await sql.query('DO 1'), []);
    await sql.close();
});
