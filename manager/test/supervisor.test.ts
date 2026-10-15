// The supervisor's API over a real Unix socket (docs/upgrade-supervisor.md):
// requests, refusals, jobs, interruption and retention, with Ghost's end
// played by SupervisorClient, the reference of what HttpUpgradeAdapter does.
// Jobs run a scripted executor: what the real one does is update.test.ts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Io } from '../src/io.ts';
import { acquireLock, readLock } from '../src/lock.ts';
import type { Metadata } from '../src/meta.ts';
import { SupervisorClient, type RequestResult } from '../src/supervisor/client.ts';
import type { Discoverer, Policy } from '../src/supervisor/discovery.ts';
import { randomIdempotencyKey, type UpgradeJob } from '../src/supervisor/protocol.ts';
import { listen, supervisorServer } from '../src/supervisor/server.ts';
import { HISTORY, Records } from '../src/supervisor/store.ts';
import { Supervisor, type Executor, type JobOutcome } from '../src/supervisor/supervisor.ts';

const FROM = '6.68.0';
const TO = '6.72.0';

let root: string;
let dir: string;
let socket: string;
let logged: string[];
let policy: Policy | null;
let execute: Executor;
let servers: Server[];

const io = {
    stdout: (text: string) => void logged.push(text),
    stderr: (text: string) => void logged.push(text),
} as unknown as Io;

const metadata = () => ({ ghost: { version: FROM } }) as unknown as Metadata;

const discover: Discoverer = async ({ now }) => ({
    checkedAt: now.toISOString(),
    currentVersion: FROM,
    oneClick: [{ component: 'ghost', fromVersion: FROM, toVersion: TO }],
    manual: [],
    succeededAt: { ghost: now.toISOString() },
    diagnostics: [],
});

const done: Executor = async ({ stage, backup }) => {
    stage('pulling');
    stage('backing-up');
    backup('backups/20261014-200103');
    stage('restarting');
    stage('verifying');
    return { state: 'done', diagnostics: [] };
};

/** A supervisor serving on the socket, as `supervisor run` starts one. */
async function serve(): Promise<Supervisor> {
    const supervisor = new Supervisor({
        io,
        dir,
        records: new Records(dir),
        execute: (context) => execute(context),
        discover,
        metadata,
        policy: () => policy,
    });
    supervisor.start();
    const server = supervisorServer(supervisor, io.stderr);
    servers.push(server);
    await listen(server, socket);
    await supervisor.rediscover();
    return supervisor;
}

async function stop(server: Server | undefined): Promise<void> {
    if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

const client = () => new SupervisorClient(socket);

const ask = async (toVersion = TO, key = randomIdempotencyKey()): Promise<RequestResult> =>
    client().createRequest({ component: 'ghost', toVersion, idempotencyKey: key });

const accepted = async (toVersion = TO, key = randomIdempotencyKey()): Promise<UpgradeJob> => {
    const result = await ask(toVersion, key);
    assert.ok('accepted' in result, JSON.stringify(result));
    return result.accepted;
};

const rejected = async (toVersion = TO, key = randomIdempotencyKey()): Promise<string> => {
    const result = await ask(toVersion, key);
    assert.ok('rejected' in result, JSON.stringify(result));
    return result.rejected;
};

const lookup = async (id: string) => client().lookup(id) as Promise<UpgradeJob>;
const availability = async () => (await client().readStatus()).availability;

/** A raw call, for what Ghost's client would never send. */
function raw(method: string, path: string, body?: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        const request = httpRequest({ socketPath: socket, method, path }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () =>
                resolve({
                    status: response.statusCode ?? 0,
                    body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                }),
            );
        });
        request.on('error', reject);
        request.end(body);
    });
}

beforeEach(() => {
    // Short: a Unix socket's path is limited to about 100 bytes.
    root = mkdtempSync(join(tmpdir(), 'gds-'));
    dir = join(root, 'site');
    mkdirSync(dir);
    socket = join(root, 's.sock');
    logged = [];
    policy = 'minor';
    execute = done;
    servers = [];
});
afterEach(async () => {
    for (const server of servers) {
        await stop(server);
    }
    rmSync(root, { recursive: true, force: true });
});

describe('the API', () => {
    test('answers the handshake, and refuses what it does not serve', async () => {
        await serve();
        assert.deepEqual(await raw('GET', '/v1'), { status: 200, body: { protocol: 1 } });
        assert.equal((await raw('GET', '/v2/status')).status, 404);
        assert.equal((await raw('GET', '/v1/requests')).status, 405);
        assert.equal((await raw('POST', '/v1/status')).status, 405);
        assert.equal(statSync(socket).mode & 0o777, 0o666);
    });

    test('refuses malformed and oversize requests', async () => {
        await serve();
        const key = randomIdempotencyKey();
        const malformed = [
            'not json',
            JSON.stringify({ component: 'ghost', toVersion: TO, idempotencyKey: key, image: 'x' }),
            JSON.stringify({ component: 'ghost', toVersion: TO, idempotencyKey: 'not-a-hash' }),
            JSON.stringify({ component: '../ghost', toVersion: TO, idempotencyKey: key }),
        ];
        for (const body of malformed) {
            const answer = await raw('POST', '/v1/requests', body);
            assert.equal(answer.status, 400, body);
            assert.equal(answer.body.error.code, 'malformed');
        }
        const big = await raw('POST', '/v1/requests', 'x'.repeat(5000)).catch(() => ({
            status: 413,
            body: {},
        }));
        assert.equal(big.status, 413);
        assert.equal((await raw('GET', '/v1/jobs/..%2Fstatus')).status, 400);
        assert.equal(readLock(dir).state, 'free');
    });
});

describe('a request made by hand', () => {
    test('runs to done, through every stage, holding the lock, and releases it', async () => {
        const running = await serve();
        assert.equal(await availability(), 'ready');

        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const seen: string[] = [];
        let id = '';
        execute = async (context) => {
            await gate;
            for (const stage of ['pulling', 'backing-up', 'restarting', 'verifying'] as const) {
                context.stage(stage);
                seen.push((await lookup(id)).state);
                assert.equal(readLock(dir).state, 'held');
                assert.equal(await availability(), 'busy');
            }
            return { state: 'done', diagnostics: [] };
        };
        const job = await accepted();
        id = job.id;
        assert.equal(job.state, 'pending');
        assert.equal(job.fromVersion, FROM);
        release();
        await running.job;

        assert.deepEqual(seen, ['pulling', 'backing-up', 'restarting', 'verifying']);
        assert.equal((await lookup(id)).state, 'done');
        assert.equal(readLock(dir).state, 'free');
        const status = await client().readStatus();
        assert.ok('status' in status && status.status.supported);
        assert.equal(status.availability, 'ready');
        assert.equal(status.status.activeJobId, null);
        assert.equal(status.status.backupRequired, true);
    });

    test('a replay returns the original job, while it runs and once it is no longer offered', async () => {
        const running = await serve();
        let release!: (outcome: JobOutcome) => void;
        execute = ({ stage }) => {
            stage('pulling');
            return new Promise((resolve) => (release = resolve));
        };
        const key = randomIdempotencyKey();
        const job = await accepted(TO, key);
        const during = await ask(TO, key);
        assert.ok('accepted' in during && during.replay && during.accepted.id === job.id);
        assert.equal(during.accepted.state, 'pulling');
        release({ state: 'done', diagnostics: [] });
        await running.job;
        // The update is gone from oneClick once done; the replay still finds its job.
        const after = await ask(TO, key);
        assert.ok('accepted' in after && after.accepted.state === 'done');
    });

    test('a key reused for another update is an idempotency conflict', async () => {
        const running = await serve();
        const key = randomIdempotencyKey();
        await accepted(TO, key);
        await running.job;
        assert.equal(await rejected('6.71.0', key), 'idempotency-conflict');
    });
});

describe('refusals', () => {
    test('a target not offered is refused, whatever it says', async () => {
        await serve();
        assert.equal(await rejected('6.71.0'), 'target-unapproved');
        assert.equal(await rejected('7.0.0; rm -rf /'), 'target-unapproved');
        assert.equal(readLock(dir).state, 'free');
    });

    test('a request while a job is active is refused as busy', async () => {
        const running = await serve();
        let release!: (outcome: JobOutcome) => void;
        execute = () => new Promise((resolve) => (release = resolve));
        await accepted();
        assert.equal(await availability(), 'busy');
        assert.equal(await rejected(), 'busy');
        release({ state: 'done', diagnostics: [] });
        await running.job;
    });

    test('a request while the CLI holds the lock is refused, naming the holder', async () => {
        await serve();
        const lock = acquireLock(dir, 'backup');
        assert.equal(await availability(), 'busy');
        const result = await ask();
        assert.ok('rejected' in result && result.rejected === 'busy');
        assert.match(result.reason, /held by backup/);
        lock.release();
        assert.equal(await availability(), 'ready');
    });

    test('an invalid policy makes the supervisor unavailable', async () => {
        policy = null;
        await serve();
        assert.equal(await availability(), 'unavailable');
        assert.equal(await rejected(), 'unavailable');
    });
});

describe('a supervisor stopped mid-job', () => {
    test('reports the job interrupted on its next start, with its backup, and leaves the lock', async () => {
        await serve();
        execute = async ({ stage, backup }) => {
            stage('pulling');
            stage('backing-up');
            backup('backups/20261014-200103');
            stage('restarting');
            // Killed here: never returns.
            return new Promise<JobOutcome>(() => {});
        };
        const job = await accepted();
        assert.equal((await lookup(job.id)).state, 'restarting');

        // A new process, as after the container or the host was restarted.
        await stop(servers.pop());
        await serve();
        const interrupted = await lookup(job.id);
        assert.equal(interrupted.state, 'interrupted');
        assert.match(
            interrupted.diagnostics?.[0]?.message ?? '',
            /restarting.*backups\/20261014-200103.*lock is still held/s,
        );
        assert.match(interrupted.diagnostics?.[0]?.details ?? '', /rm \.ghost-docker\.lock/);
        assert.match(
            interrupted.diagnostics?.[0]?.details ?? '',
            /restore --yes backups\/20261014-200103/,
        );
        assert.equal(readLock(dir).state, 'held');
        assert.equal(await availability(), 'unavailable');
        assert.equal(await rejected(), 'unavailable');
    });
});

describe('retention', () => {
    test('keeps the 20 newest finished jobs; older ones are expired, and their keys refused', async () => {
        const running = await serve();
        const keys: string[] = [];
        for (let index = 0; index < HISTORY + 5; index += 1) {
            const key = randomIdempotencyKey();
            keys.push(key);
            await accepted(TO, key);
            await running.job;
        }
        const kept = new Records(dir).list().records;
        assert.ok(kept.length <= HISTORY + 1, `${kept.length} kept`);
        assert.equal((await lookup(keys[0]!)).state, 'expired');
        assert.equal(await rejected(TO, keys[0]!), 'request-expired');
        assert.equal((await lookup(keys.at(-1)!)).state, 'done');
        assert.equal((await lookup(randomIdempotencyKey())).state, 'unknown');
    });
});

describe("Ghost's end, when the supervisor is not there or speaks another protocol", () => {
    test('a missing socket is unavailable, and so is every request', async () => {
        assert.deepEqual(await availability(), 'unavailable');
        assert.equal(await rejected(), 'unavailable');
    });

    test('a server without /v1 is incompatible', async () => {
        const other = createServer((_request, response) => {
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end('{}');
        });
        servers.push(other);
        await listen(other, socket);
        assert.equal(await availability(), 'incompatible');
        assert.equal(await rejected(), 'incompatible');
    });
});
