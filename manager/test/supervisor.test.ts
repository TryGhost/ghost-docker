// The supervisor's claiming, refusals, jobs, interruption and retention
// (docs/upgrade-supervisor.md), with Ghost's end played by ExchangeClient,
// the reference of what FileDropUpgradeAdapter does. Jobs run a scripted
// executor: what the real one does is update.test.ts.
import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Io } from '../src/io.ts';
import { acquireLock, readLock } from '../src/lock.ts';
import type { Metadata } from '../src/meta.ts';
import { ExchangeClient } from '../src/supervisor/client.ts';
import type { Discoverer, Policy } from '../src/supervisor/discovery.ts';
import {
    jobIdOf,
    PROTOCOL,
    randomIdempotencyKey,
    type UpgradeJob,
} from '../src/supervisor/protocol.ts';
import { Exchange, HISTORY, Records } from '../src/supervisor/store.ts';
import { Supervisor, type Executor, type JobOutcome } from '../src/supervisor/supervisor.ts';

const FROM = '6.68.0';
const TO = '6.72.0';

let root: string;
let dir: string;
let exchangeRoot: string;
let logged: string[];
let clock: Date;
let policy: Policy | null;
let execute: Executor;
let discoveries: number;

const io = {
    stdout: (text: string) => void logged.push(text),
    stderr: (text: string) => void logged.push(text),
} as unknown as Io;

const metadata = () => ({ ghost: { version: FROM } }) as unknown as Metadata;

const discover: Discoverer = async ({ now }) => {
    discoveries += 1;
    return {
        checkedAt: now.toISOString(),
        currentVersion: FROM,
        oneClick: [{ component: 'ghost', fromVersion: FROM, toVersion: TO }],
        manual: [],
        succeededAt: { ghost: now.toISOString() },
        diagnostics: [],
    };
};

const done: Executor = async ({ stage, backup }) => {
    stage('pulling');
    stage('backing-up');
    backup('backups/20261014-200103');
    stage('restarting');
    stage('verifying');
    return { state: 'done', diagnostics: [] };
};

const supervisor = () =>
    new Supervisor({
        io,
        dir,
        exchange: new Exchange(exchangeRoot),
        records: new Records(dir),
        execute: (context) => execute(context),
        discover,
        metadata,
        policy: () => policy,
        now: () => clock,
    });

const client = () => new ExchangeClient(exchangeRoot, () => clock);

const ask = (toVersion = TO, key = randomIdempotencyKey()) => {
    const result = client().createRequest({ component: 'ghost', toVersion, idempotencyKey: key });
    assert.ok('accepted' in result, JSON.stringify(result));
    return result.accepted;
};

const lookup = (id: string) => client().lookup(id) as UpgradeJob;

/** Settles the job a tick started. */
async function settle(running: Supervisor): Promise<void> {
    await running.job;
}

/** A request file written by hand, bypassing the client's checks. */
function drop(name: string, content: string): void {
    writeFileSync(join(exchangeRoot, 'requests', name), content);
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gd-supervisor-'));
    dir = join(root, 'site');
    exchangeRoot = join(root, 'exchange');
    mkdirSync(dir);
    mkdirSync(join(exchangeRoot, 'requests'), { recursive: true });
    mkdirSync(join(exchangeRoot, 'status'), { recursive: true });
    logged = [];
    clock = new Date();
    policy = 'minor';
    execute = done;
    discoveries = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('a request made by hand', () => {
    test('runs to done, through every stage, and releases the lock', async () => {
        const running = supervisor();
        await running.start();
        assert.equal(client().readStatus().availability, 'ready');

        const pending = ask();
        assert.equal(pending.state, 'pending');
        assert.equal(lookup(pending.id).state, 'pending');

        const seen: string[] = [];
        execute = async (context) => {
            for (const stage of ['pulling', 'backing-up', 'restarting', 'verifying'] as const) {
                context.stage(stage);
                seen.push(lookup(pending.id).state);
                assert.equal(readLock(dir).state, 'held');
                assert.equal(client().readStatus().availability, 'busy');
            }
            return { state: 'done', diagnostics: [] };
        };
        await running.tick();
        await settle(running);

        assert.deepEqual(seen, ['pulling', 'backing-up', 'restarting', 'verifying']);
        const job = lookup(pending.id);
        assert.equal(job.state, 'done');
        assert.equal(job.fromVersion, FROM);
        assert.equal(readLock(dir).state, 'free');
        assert.deepEqual(readdirSync(join(exchangeRoot, 'requests')), []);
        const status = client().readStatus();
        assert.equal(status.availability, 'ready');
        assert.ok('file' in status && status.file.status.activeJobId === null);
    });

    test('the same key returns the original job; another target with it conflicts', async () => {
        const running = supervisor();
        await running.start();
        const key = randomIdempotencyKey();
        const first = ask(TO, key);
        assert.equal(ask(TO, key).id, first.id);
        await running.tick();
        await settle(running);
        assert.equal(ask(TO, key).state, 'done');

        const other = client().createRequest({
            component: 'ghost',
            toVersion: '6.71.0',
            idempotencyKey: key,
        });
        // Not offered, so refused before the key is looked at.
        assert.ok('rejected' in other && other.rejected === 'target-unapproved');
    });

    test('a key reused for another offered update is an idempotency conflict', async () => {
        const running = supervisor();
        await running.start();
        const key = randomIdempotencyKey();
        const id = jobIdOf(key);
        drop(
            `${id}.json`,
            JSON.stringify({
                protocol: PROTOCOL,
                request: { component: 'ghost', toVersion: '6.70.0', idempotencyKey: key },
            }),
        );
        const result = client().createRequest({
            component: 'ghost',
            toVersion: TO,
            idempotencyKey: key,
        });
        assert.ok('rejected' in result && result.rejected === 'idempotency-conflict');
    });

    test('a duplicate of a claimed request is removed without a second job', async () => {
        const running = supervisor();
        await running.start();
        const key = randomIdempotencyKey();
        const job = ask(TO, key);
        await running.tick();
        await settle(running);
        let runs = 0;
        execute = async () => {
            runs += 1;
            return { state: 'done', diagnostics: [] };
        };
        drop(
            `${job.id}.json`,
            JSON.stringify({
                protocol: PROTOCOL,
                request: { component: 'ghost', toVersion: TO, idempotencyKey: key },
            }),
        );
        await running.tick();
        await settle(running);
        assert.equal(runs, 0);
        assert.deepEqual(readdirSync(join(exchangeRoot, 'requests')), []);
        assert.equal(lookup(job.id).state, 'done');
    });
});

describe('refusals', () => {
    const refusalOf = (id: string) => {
        const job = lookup(id);
        assert.equal(job.state, 'refused');
        return job.diagnostics?.[0]?.code;
    };

    test('malformed requests: not JSON, extra fields, oversize, symlinked, misnamed', async () => {
        const running = supervisor();
        await running.start();
        const key = randomIdempotencyKey();
        const ids = [
            jobIdOf(randomIdempotencyKey()),
            jobIdOf(randomIdempotencyKey()),
            jobIdOf(randomIdempotencyKey()),
            jobIdOf(randomIdempotencyKey()),
            jobIdOf(randomIdempotencyKey()),
        ];
        drop(`${ids[0]}.json`, 'not json');
        drop(
            `${ids[1]}.json`,
            JSON.stringify({
                protocol: PROTOCOL,
                request: { component: 'ghost', toVersion: TO, idempotencyKey: key, image: 'x' },
            }),
        );
        drop(`${ids[2]}.json`, 'x'.repeat(5000));
        writeFileSync(join(root, 'outside.json'), '{}');
        symlinkSync(join(root, 'outside.json'), join(exchangeRoot, 'requests', `${ids[3]}.json`));
        // A real request, under a name that is not its key's job.
        drop(
            `${ids[4]}.json`,
            JSON.stringify({
                protocol: PROTOCOL,
                request: { component: 'ghost', toVersion: TO, idempotencyKey: key },
            }),
        );
        let runs = 0;
        execute = async () => {
            runs += 1;
            return { state: 'done', diagnostics: [] };
        };
        await running.tick();
        assert.equal(runs, 0);
        for (const id of ids) {
            assert.equal(refusalOf(id), 'malformed');
        }
        assert.deepEqual(readdirSync(join(exchangeRoot, 'requests')), []);
        assert.equal(lookup(ids[1]!).component, 'ghost');
    });

    test('a request of another protocol is malformed', async () => {
        const running = supervisor();
        await running.start();
        const key = randomIdempotencyKey();
        drop(
            `${jobIdOf(key)}.json`,
            JSON.stringify({
                protocol: 2,
                request: { component: 'ghost', toVersion: TO, idempotencyKey: key },
            }),
        );
        await running.tick();
        assert.equal(refusalOf(jobIdOf(key)), 'malformed');
    });

    test('a target not offered is refused, even written by hand', async () => {
        const running = supervisor();
        await running.start();
        const key = randomIdempotencyKey();
        drop(
            `${jobIdOf(key)}.json`,
            JSON.stringify({
                protocol: PROTOCOL,
                request: { component: 'ghost', toVersion: '7.0.0; rm -rf /', idempotencyKey: key },
            }),
        );
        await running.tick();
        assert.equal(refusalOf(jobIdOf(key)), 'target-unapproved');
    });

    test('an old request is refused as expired', async () => {
        const running = supervisor();
        await running.start();
        const key = randomIdempotencyKey();
        const name = `${jobIdOf(key)}.json`;
        drop(
            name,
            JSON.stringify({
                protocol: PROTOCOL,
                request: { component: 'ghost', toVersion: TO, idempotencyKey: key },
            }),
        );
        const old = new Date(clock.getTime() - 11 * 60_000);
        utimesSync(join(exchangeRoot, 'requests', name), old, old);
        await running.tick();
        assert.equal(refusalOf(jobIdOf(key)), 'request-expired');
    });

    test('a request while a job is active is claimed and refused at once', async () => {
        const running = supervisor();
        await running.start();
        let release!: (outcome: JobOutcome) => void;
        execute = () => new Promise((resolve) => (release = resolve));
        const first = ask();
        await running.tick();
        assert.equal(client().readStatus().availability, 'busy');

        // The adapter refuses while busy; a request written anyway is refused by the supervisor.
        const busy = client().createRequest({
            component: 'ghost',
            toVersion: TO,
            idempotencyKey: randomIdempotencyKey(),
        });
        assert.ok('rejected' in busy && busy.rejected === 'busy');
        const key = randomIdempotencyKey();
        drop(
            `${jobIdOf(key)}.json`,
            JSON.stringify({
                protocol: PROTOCOL,
                request: { component: 'ghost', toVersion: TO, idempotencyKey: key },
            }),
        );
        await running.tick();
        assert.equal(refusalOf(jobIdOf(key)), 'busy');

        release({ state: 'done', diagnostics: [] });
        await settle(running);
        assert.equal(lookup(first.id).state, 'done');
    });

    test('a request while the CLI holds the lock is refused, naming the holder', async () => {
        const running = supervisor();
        await running.start();
        const lock = acquireLock(dir, 'backup');
        running.publish();
        assert.equal(client().readStatus().availability, 'busy');
        const key = randomIdempotencyKey();
        drop(
            `${jobIdOf(key)}.json`,
            JSON.stringify({
                protocol: PROTOCOL,
                request: { component: 'ghost', toVersion: TO, idempotencyKey: key },
            }),
        );
        await running.tick();
        const job = lookup(jobIdOf(key));
        assert.equal(job.state, 'refused');
        assert.match(job.diagnostics?.[0]?.message ?? '', /held by backup/);
        lock.release();
    });

    test('an invalid policy makes the supervisor unavailable', async () => {
        policy = null;
        const running = supervisor();
        await running.start();
        const status = client().readStatus();
        assert.equal(status.availability, 'unavailable');
    });
});

describe('a supervisor stopped mid-job', () => {
    test('reports the job interrupted on its next start, with its backup, and leaves the lock', async () => {
        const first = supervisor();
        await first.start();
        execute = async ({ stage, backup }) => {
            stage('pulling');
            stage('backing-up');
            backup('backups/20261014-200103');
            stage('restarting');
            // Killed here: never returns.
            return new Promise<JobOutcome>(() => {});
        };
        const job = ask();
        await first.tick();
        assert.equal(lookup(job.id).state, 'restarting');

        // A new process, as after the container or the host was restarted.
        const second = supervisor();
        await second.start();
        const interrupted = lookup(job.id);
        assert.equal(interrupted.state, 'interrupted');
        assert.match(
            interrupted.diagnostics?.[0]?.message ?? '',
            /restarting.*backups\/20261014-200103.*lock is still held/s,
        );
        assert.match(
            interrupted.diagnostics?.[0]?.details ?? '',
            /restore --yes backups\/20261014-200103/,
        );
        assert.equal(readLock(dir).state, 'held');

        const status = client().readStatus();
        assert.equal(status.availability, 'unavailable');
        let runs = 0;
        execute = async () => {
            runs += 1;
            return { state: 'done', diagnostics: [] };
        };
        const key = randomIdempotencyKey();
        drop(
            `${jobIdOf(key)}.json`,
            JSON.stringify({
                protocol: PROTOCOL,
                request: { component: 'ghost', toVersion: TO, idempotencyKey: key },
            }),
        );
        await second.tick();
        assert.equal(runs, 0);
        assert.equal(lookup(jobIdOf(key)).state, 'refused');
    });
});

describe('retention', () => {
    test('keeps the 20 newest finished jobs; older ones look up as expired', async () => {
        const running = supervisor();
        await running.start();
        const ids: string[] = [];
        for (let index = 0; index < HISTORY + 5; index += 1) {
            clock = new Date(clock.getTime() + 1000);
            const key = randomIdempotencyKey();
            ids.push(jobIdOf(key));
            drop(
                `${jobIdOf(key)}.json`,
                JSON.stringify({
                    protocol: PROTOCOL,
                    request: { component: 'ghost', toVersion: '1.0.0', idempotencyKey: key },
                }),
            );
            await running.tick();
        }
        // The last claim prunes down to HISTORY, then adds itself.
        assert.ok(readdirSync(join(exchangeRoot, 'status', 'jobs')).length <= HISTORY + 1);
        assert.equal(client().lookup(ids[0]!).state, 'expired');
        assert.equal(client().lookup(ids.at(-1)!).state, 'refused');
        assert.equal(client().lookup(jobIdOf(randomIdempotencyKey())).state, 'unknown');
    });
});

describe('status', () => {
    test('is stale once the heartbeat is older than a minute', async () => {
        const running = supervisor();
        await running.start();
        const later = new ExchangeClient(exchangeRoot, () => new Date(clock.getTime() + 61_000));
        assert.equal(later.readStatus().availability, 'stale');
        const rejected = later.createRequest({
            component: 'ghost',
            toVersion: TO,
            idempotencyKey: randomIdempotencyKey(),
        });
        assert.ok('rejected' in rejected && rejected.rejected === 'unavailable');
    });

    test('is unavailable before the supervisor has published, and incompatible at another protocol', () => {
        assert.equal(client().readStatus().availability, 'unavailable');
        writeFileSync(join(exchangeRoot, 'status', 'status.json'), JSON.stringify({ protocol: 2 }));
        assert.equal(client().readStatus().availability, 'incompatible');
    });

    test('offers what discovery found, and always promises a backup', async () => {
        const running = supervisor();
        await running.start();
        const status = client().readStatus();
        assert.ok('file' in status);
        assert.equal(status.file.status.backupRequired, true);
        assert.deepEqual(status.file.status.oneClick, [
            { component: 'ghost', fromVersion: FROM, toVersion: TO },
        ]);
        assert.equal(discoveries, 1);
        assert.ok(existsSync(join(dir, '.ghost-docker-supervisor', 'discovery.json')));
    });
});
