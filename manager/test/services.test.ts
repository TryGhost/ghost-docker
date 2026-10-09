// `check`'s judgement of a site's services: each by how compose.yml says it
// runs, and every service the configuration runs accounted for.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeServices } from '../src/commands/site.ts';
import type { ServiceState } from '../src/compose.ts';
import type { Lifecycle, ResolvedSite } from '../src/resolved.ts';

/** A site whose configuration runs these services, by lifecycle. */
const configured = (services: Record<string, Lifecycle>): ResolvedSite => ({
    dir: '/srv/site',
    project: 'site',
    files: ['/srv/site/compose.yml'],
    overrides: [],
    services: Object.fromEntries(
        Object.entries(services).map(([name, lifecycle]) => [
            name,
            { image: `${name}:1`, restart: null, mounts: [], networks: [], lifecycle },
        ]),
    ),
});

const container = (Service: string, State: string, ExitCode = 0, Health = ''): ServiceState => ({
    ID: Service,
    Service,
    State,
    Health,
    ExitCode,
    Publishers: [],
});

const ACTIVITYPUB = configured({
    ghost: 'long-running',
    db: 'long-running',
    activitypub: 'long-running',
    'activitypub-migrate': 'one-shot',
});

const judged = (services: ServiceState[] | null, site: ResolvedSite | null = ACTIVITYPUB) =>
    Object.fromEntries(judgeServices(services, site).map((check) => [check.label, check]));

const RUNNING = [
    container('ghost', 'running', 0, 'healthy'),
    container('db', 'running', 0, 'healthy'),
    container('activitypub', 'running'),
    container('activitypub-migrate', 'exited', 0),
];

describe('long-running services', () => {
    test('running, and healthy where they have a check, they pass', () => {
        const checks = judged(RUNNING);
        for (const service of ['ghost', 'db', 'activitypub', 'activitypub-migrate']) {
            assert.equal(checks[service]!.status, 'ok', checks[service]!.detail);
        }
        assert.equal(checks['activitypub-migrate']!.detail, 'completed');
    });

    test('one that exited 0 has stopped, and fails: ActivityPub is not a job', () => {
        const checks = judged([
            ...RUNNING.filter((each) => each.Service !== 'activitypub'),
            container('activitypub', 'exited', 0),
        ]);
        assert.equal(checks.activitypub!.status, 'error');
        assert.match(checks.activitypub!.detail, /^exited, exit 0: it should be running$/);
    });

    test('one the configuration runs that has no container fails', () => {
        const checks = judged(RUNNING.filter((each) => each.Service !== 'activitypub'));
        assert.equal(checks.activitypub!.status, 'error');
        assert.match(checks.activitypub!.detail, /no container, though the configuration runs it/);
    });

    test('an unhealthy one fails', () => {
        const checks = judged([
            ...RUNNING.filter((each) => each.Service !== 'ghost'),
            container('ghost', 'running', 0, 'unhealthy'),
        ]);
        assert.equal(checks.ghost!.status, 'error');
    });

    test('nothing at all: every long-running service fails, and a job not yet run is a note', () => {
        const checks = judged([]);
        assert.deepEqual(
            Object.values(checks).map((check) => [check.label, check.status]),
            [
                ['ghost', 'error'],
                ['db', 'error'],
                ['activitypub', 'error'],
                ['activitypub-migrate', 'note'],
            ],
        );
    });
});

describe('one-shot jobs', () => {
    test('one that failed fails, naming its logs', () => {
        const checks = judged([
            ...RUNNING.filter((each) => each.Service !== 'activitypub-migrate'),
            container('activitypub-migrate', 'exited', 1),
        ]);
        assert.equal(checks['activitypub-migrate']!.status, 'error');
        assert.match(
            checks['activitypub-migrate']!.detail,
            /exit 1: the job failed; docker compose logs activitypub-migrate/,
        );
    });

    test('one still running passes', () => {
        const checks = judged([
            ...RUNNING.filter((each) => each.Service !== 'activitypub-migrate'),
            container('activitypub-migrate', 'running'),
        ]);
        assert.equal(checks['activitypub-migrate']!.status, 'ok');
    });
});

test('a container of a service the configuration no longer runs is a warning', () => {
    const checks = judged([...RUNNING, container('mailpit', 'running')]);
    assert.equal(checks.mailpit!.status, 'warn');
    assert.match(checks.mailpit!.detail, /no longer runs it; .*--remove-orphans/);
});

test('without the resolved configuration, no exit 0 passes for a job', () => {
    const checks = judgeServices(RUNNING, null);
    assert.equal(checks[0]!.label, 'services');
    assert.equal(checks[0]!.status, 'error');
    assert.equal(checks.find((check) => check.label === 'activitypub-migrate')!.status, 'error');
});

test('docker compose ps failing is an error', () => {
    assert.deepEqual(
        judgeServices(null, ACTIVITYPUB).map((check) => [check.label, check.status]),
        [['services', 'error']],
    );
});
