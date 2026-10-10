// update, against a scripted daemon and Compose: a site installed on one Ghost,
// then moved to a newer one. What a real update does, migrations included,
// is tests/e2e/ghost-update.sh; this is what it decides.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import * as env from '../src/env.ts';
import { acquireLock } from '../src/lock.ts';
import { SCHEMA_VERSION, writeMetadata } from '../src/meta.ts';
import { failed, harness, ok, type Harness, type ProgramResult } from './helpers.ts';
import {
    imageApi,
    imageStack,
    INDEX,
    LOCAL,
    makeSite,
    REFERENCE,
    scriptSite,
    writeSiteData,
    type ScriptedSite,
} from './site.ts';

const NEWER = `sha256:${'5'.repeat(64)}`;

let h: Harness;
let site: ScriptedSite;
let compose: string[][];
/** The registry: each of Ghost's tags, the version it is, and its digest. */
let ghost: Record<string, string>;
let digests: Record<string, string>;
let config: () => ProgramResult;

const readSite = (file: string) => readFileSync(join(h.dir, file), 'utf8');
const metadata = () => JSON.parse(readSite('.ghost-docker.json'));
const setting = (key: string) => env.get(readSite('.env'), key);
const update = (...args: string[]) => h.run('update', ...args);
/** `up`s that start the site, not the writers started again as they were. */
const started = () =>
    compose.filter((args) => args[0] === 'up' && !args.includes('--no-recreate')).length;

/** Every file in the site but its data and backups, with its content. */
function snapshot(dir = h.dir, prefix = ''): Record<string, string> {
    const files: Record<string, string> = {};
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (prefix === '' && (entry.name === 'data' || entry.name === 'backups')) {
            continue;
        }
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            Object.assign(files, snapshot(path, `${prefix}${entry.name}/`));
        } else {
            files[`${prefix}${entry.name}`] = readFileSync(path, 'utf8');
        }
    }
    return files;
}

const backups = () =>
    existsSync(join(h.dir, 'backups')) ? readdirSync(join(h.dir, 'backups')) : [];

beforeEach(async () => {
    h = harness();
    imageStack(h);
    h.env.GD_VERSION_FILE = join(h.dir, '..', 'gd-version.json');
    writeFileSync(h.env.GD_VERSION_FILE, JSON.stringify({ version: 'v0.1.0-beta.1', commit: '' }));
    h.env.GD_CHANNEL = 'beta';

    ghost = { '6-next-alpine': '6.67.0' };
    digests = {};
    h.daemon.api = imageApi({ ghost, digests });
    config = () => ok(JSON.stringify({ services: { ghost: { environment: {} } } }));
    site = scriptSite(h, () => config());
    compose = site.compose;

    const installed = await h.run('install', '--local', '--no-start');
    assert.equal(installed.code, 0, installed.stderr);
    writeSiteData(h.dir);
    site.running.add('ghost').add('db');
    compose.length = 0;

    // A newer Ghost 6 is published.
    ghost['6-next-alpine'] = '6.68.0';
    digests['6-next-alpine'] = NEWER;
});
afterEach(() => h.cleanup());

describe('an update to a newer Ghost', () => {
    test('with no version, the newest of the major: pinned, recorded, backed up and started', async () => {
        const before = metadata();
        const ghostEnv = readSite('ghost.env');
        const result = await update();
        assert.equal(result.code, 0, result.stderr);

        assert.equal(setting('GHOST_IMAGE_REF'), `ghost@${NEWER}`);
        assert.equal(setting('GHOST_VERSION'), '6-next-alpine');
        assert.deepEqual(metadata().ghost, {
            image: 'ghost',
            tag: '6-next-alpine',
            version: '6.68.0',
            digest: NEWER,
        });
        assert.deepEqual(metadata().stack, before.stack);
        assert.equal(readSite('ghost.env'), ghostEnv);

        assert.equal(backups().length, 1);
        assert.equal(started(), 1);
        assert.ok(!existsSync(join(h.dir, '.ghost-docker-update')));
        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));
        assert.match(result.stdout, /Updated Ghost from 6\.67\.0 to 6\.68\.0/);
        assert.match(result.stdout, new RegExp(`Previously +6\\.67\\.0, ${REFERENCE}`));
        assert.match(result.stdout, /Backup +backups\//);
    });

    test('a named version, of the variant the site runs', async () => {
        ghost['6.68.0-next-alpine'] = '6.68.0';
        digests['6.68.0-next-alpine'] = NEWER;
        const result = await update('v6.68.0');
        assert.equal(result.code, 0, result.stderr);
        assert.equal(setting('GHOST_VERSION'), '6.68.0-next-alpine');
        assert.equal(metadata().ghost.tag, '6.68.0-next-alpine');
        assert.equal(metadata().ghost.version, '6.68.0');
    });

    test('--check says what there is, and changes nothing', async () => {
        const before = snapshot();
        const result = await update('--check');
        assert.equal(result.code, 0, result.stderr);
        assert.match(
            result.stdout,
            /This site runs Ghost 6\.67\.0\. ghost:6-next-alpine is Ghost 6\.68\.0/,
        );
        assert.match(
            result.stdout,
            new RegExp(`An update is available: Ghost 6\\.68\\.0, ghost@${NEWER}`),
        );
        assert.deepEqual(snapshot(), before);
        assert.deepEqual(backups(), []);
        assert.equal(compose.length, 0);
    });

    test('the Ghost the site runs is nothing to do', async () => {
        digests['6-next-alpine'] = INDEX;
        ghost['6-next-alpine'] = '6.67.0';
        const before = snapshot();
        const result = await update();
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /already runs Ghost 6\.67\.0/);
        assert.deepEqual(snapshot(), before);
        assert.equal(compose.length, 0);

        const checked = await update('--check');
        assert.match(checked.stdout, /It is up to date/);
    });
});

describe('refusals that change nothing', () => {
    test('another major, a downgrade, and a tag that is not the version named', async () => {
        ghost['7.0.0-next-alpine'] = '7.0.0';
        digests['7.0.0-next-alpine'] = NEWER;
        ghost['6.66.0-next-alpine'] = '6.66.0';
        digests['6.66.0-next-alpine'] = `sha256:${'6'.repeat(64)}`;
        ghost['6.69.0-next-alpine'] = '6.69.1';
        digests['6.69.0-next-alpine'] = NEWER;
        const before = snapshot();
        for (const [version, message] of [
            ['7.0.0', /Ghost 7\.0\.0: another major\s+version/],
            ['6.66.0', /newer than 6\.66\.0\. update never moves a site to an\s+older Ghost/],
            ['6.69.0', /is Ghost 6\.69\.1, not 6\.69\.0/],
        ] as const) {
            const result = await update(version);
            assert.equal(result.code, 1, version);
            assert.match(result.stderr, message);
            assert.match(result.stderr, /Nothing has been changed/);
        }
        assert.deepEqual(snapshot(), before);
        assert.equal(compose.length, 0);
    });

    test('usage errors exit 2', async () => {
        for (const args of [['banana'], ['6.68'], ['6.68.0', '6.69.0'], ['--frobnicate']]) {
            const result = await update(...args);
            assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
        }
    });

    test('a version that cannot be pulled', async () => {
        const result = await update('6.99.0');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /ghost:6\.99\.0-next-alpine could not be pulled/);
    });

    test('a pin in .env that is not the one recorded', async () => {
        writeFileSync(
            join(h.dir, '.env'),
            env.set(readSite('.env'), 'GHOST_IMAGE_REF', `ghost@${NEWER}`),
        );
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /records Ghost 6\.67\.0 as ghost@sha256:1+, but \.env pins/);
    });

    test('another operation holding the lock', async () => {
        const lock = acquireLock(h.dir, 'backup', new Date('2026-10-08T10:00:00Z'));
        const before = snapshot();
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /held by backup, started 2026-10-08T10:00:00Z/);
        assert.deepEqual(snapshot(), before);
        lock.release();
    });

    test('an unfinished update’s snapshot is never written over', async () => {
        mkdirSync(join(h.dir, '.ghost-docker-update'));
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /left from an update that did not finish/);
        assert.match(result.stderr, /run \.\/ghost-docker update again/);
    });

    test('a site with no metadata', async () => {
        writeFileSync(join(h.dir, '.ghost-docker.json'), '');
        const result = await update();
        assert.equal(result.code, 1);
    });
});

describe('a failed update', () => {
    test('a backup that fails puts the files back, and the writers run again', async () => {
        const before = snapshot();
        h.daemon.sql = () => [['0']];
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /Restored: the site is back on Ghost 6\.67\.0, with its files as they were\. Its services were not changed; ghost, stopped for the update, is running again\./,
        );
        assert.deepEqual(snapshot(), before);
        assert.equal(started(), 0);
        assert.deepEqual([...site.running].sort(), ['db', 'ghost']);
    });

    test('validation failing after the pin is written puts the old pin back', async () => {
        const before = snapshot();
        // The refusal and the backup resolve the site as it is; validation does not.
        let resolved = 0;
        const resolves = config;
        config = () =>
            (resolved += 1) <= 2
                ? resolves()
                : failed(1, 'service "ghost" refers to undefined volume nope');
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /Compose cannot resolve the project with Ghost 6\.68\.0: service "ghost" refers to undefined volume nope/,
        );
        assert.match(result.stderr, /Restored: the site is back on Ghost 6\.67\.0/);
        assert.deepEqual([...site.running].sort(), ['db', 'ghost']);
        assert.deepEqual(snapshot(), before);
        assert.equal(started(), 0);
    });

    test('a Ghost that migrates and fails to start keeps its data and its pin, and the operator chooses', async () => {
        site.onUp = () => {
            site.rows = { ...site.rows, migrations: 121 };
        };
        site.ups = [failed(1, 'container ghost is unhealthy')];
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /the site needs the operator/);
        assert.match(
            result.stderr,
            /Ghost 6\.68\.0 started before the update failed, so it may have migrated/,
        );
        assert.match(result.stderr, /switching back to 6\.67\.0 would not undo/);
        assert.match(result.stderr, /\.\/ghost-docker restore --yes backups\//);
        assert.match(result.stderr, /docker compose logs ghost/);

        // Nothing loaded over the migrated data; the configuration names the Ghost that migrated it.
        assert.equal(site.rows.migrations, 121);
        assert.equal(readSite('data/mysql/ibdata1'), 'the database');
        assert.equal(setting('GHOST_IMAGE_REF'), `ghost@${NEWER}`);
        assert.equal(metadata().ghost.version, '6.68.0');
        assert.deepEqual([...site.running], []);
        // Kept for the operator, and the next update waits for it.
        assert.ok(existsSync(join(h.dir, '.ghost-docker-update', 'files', '.env')));
        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));
        const again = await update();
        assert.match(again.stderr, /left from an update that did not finish/);
    });

    test('services that cannot be stopped are reported, and nothing is put back over them', async () => {
        site.ups = [failed(1, 'container ghost is unhealthy')];
        site.downs = [failed(1, 'cannot stop container')];
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /the services could not be stopped: cannot stop container/);
        assert.match(result.stderr, /These of its services are still running: db, ghost/);
        assert.equal(setting('GHOST_IMAGE_REF'), `ghost@${NEWER}`);
    });
});

describe('a checkout', () => {
    beforeEach(() => {
        // A clone of the repository: its files are used in place; only .env pins Ghost.
        h.cleanup();
        h = harness();
        makeSite(h, { ...LOCAL, GHOST_IMAGE_REF: REFERENCE }, {});
        h.daemon.api = imageApi({ ghost, digests });
        const made = h.daemon.composeRun!;
        site = scriptSite(h, (args) => made(args, {}));
        compose = site.compose;
        writeSiteData(h.dir);
        site.running.add('ghost').add('db');
        mkdirSync(join(h.dir, 'manager'));
        writeFileSync(join(h.dir, 'manager', 'Dockerfile'), 'FROM scratch\n');
        writeMetadata(h.dir, {
            schemaVersion: SCHEMA_VERSION,
            installedAt: '2026-10-06T09:12:44Z',
            updatedAt: null,
            mode: 'local',
            channel: null,
            source: 'checkout',
            stack: { version: null, ref: null, image: null, previous: null },
            site: {
                project: 'ghost-local-site',
                dir: h.dir,
                url: 'http://localhost:2368',
                domain: null,
                adminDomain: null,
            },
            ghost: { image: 'ghost', tag: '6-next-alpine', version: '6.67.0', digest: INDEX },
            profiles: ['local'],
            payload: {},
        });
        h.daemon.gitRun = () => ok(`${'b'.repeat(40)}\n`);
    });

    test('is updated like an image installation: the pin in .env, and the metadata', async () => {
        const compose = readSite('compose.yml');
        const result = await update();
        assert.equal(result.code, 0, result.stderr);
        assert.equal(setting('GHOST_IMAGE_REF'), `ghost@${NEWER}`);
        assert.equal(metadata().ghost.version, '6.68.0');
        assert.equal(metadata().source, 'checkout');
        assert.equal(readSite('compose.yml'), compose);
        assert.equal(started(), 1);
    });
});
