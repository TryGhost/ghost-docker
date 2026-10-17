// Ghost's nightly channel (docs/configuration.md#ghost-channel), against a
// scripted daemon and Compose: a site installed on one nightly build, then
// moved to a newer one. Nightly builds are tagged by date and `latest`, and
// two can report the same version, so they are ordered by when they were built.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import * as env from '../src/env.ts';
import { discover } from '../src/supervisor/discovery.ts';
import { harness, ok, type Harness, type ProgramResult } from './helpers.ts';
import {
    imageApi,
    imageStack,
    INDEX,
    scriptSite,
    writeSiteData,
    type ScriptedSite,
} from './site.ts';

const TODAY = `sha256:${'5'.repeat(64)}`;
const YESTERDAY_BUILT = '2026-10-14T03:16:44Z';
const TODAY_BUILT = '2026-10-15T03:16:10Z';

let h: Harness;
let site: ScriptedSite;
let ghost: Record<string, string>;
let digests: Record<string, string>;
let created: Record<string, string>;
let config: () => ProgramResult;

const readSite = (file: string) => readFileSync(join(h.dir, file), 'utf8');
const metadata = () => JSON.parse(readSite('.ghost-docker.json'));
const setting = (key: string) => env.get(readSite('.env'), key);
const update = (...args: string[]) => h.run('update', ...args);

beforeEach(async () => {
    h = harness();
    imageStack(h);
    h.env.GD_VERSION_FILE = join(h.dir, '..', 'gd-version.json');
    writeFileSync(h.env.GD_VERSION_FILE, JSON.stringify({ version: 'v0.1.0-beta.1', commit: '' }));
    h.env.GD_CHANNEL = 'beta';

    // Yesterday's build is `latest` when the site is installed.
    ghost = { latest: '6.70.1-rc.0+d507bc2', '20261014': '6.70.1-rc.0+d507bc2' };
    digests = {};
    created = { latest: YESTERDAY_BUILT, '20261014': YESTERDAY_BUILT };
    h.daemon.api = imageApi({ ghost, digests, created, repository: 'ghost/nightly' });
    config = () => ok(JSON.stringify({ services: { ghost: { environment: {} } } }));
    site = scriptSite(h, () => config());

    const installed = await h.run('install', '--local', '--ghost-channel', 'nightly', '--no-start');
    assert.equal(installed.code, 0, installed.stderr);
    writeSiteData(h.dir);
    site.running.add('ghost').add('db');
    site.compose.length = 0;
});
afterEach(() => h.cleanup());

/** Today's build is published: the same version as yesterday's, another commit and digest. */
function publishToday(version = '6.70.1-rc.0+53d6a80', built = TODAY_BUILT) {
    ghost.latest = version;
    ghost['20261015'] = version;
    digests.latest = TODAY;
    digests['20261015'] = TODAY;
    created.latest = built;
    created['20261015'] = built;
}

describe('installing on the nightly channel', () => {
    test("pins ghost/nightly's latest build by digest, and says it is for testing", async () => {
        assert.equal(setting('GHOST_IMAGE'), 'ghost/nightly');
        assert.equal(setting('GHOST_VERSION'), 'latest');
        assert.equal(setting('GHOST_IMAGE_REF'), `ghost/nightly@${INDEX}`);
        assert.deepEqual(metadata().ghost, {
            image: 'ghost/nightly',
            tag: 'latest',
            version: '6.70.1-rc.0+d507bc2',
            digest: INDEX,
        });
    });

    test('takes a build by its date, and refuses a version', async () => {
        const dated = harness();
        try {
            imageStack(dated);
            dated.daemon.api = imageApi({ ghost, digests, created, repository: 'ghost/nightly' });
            scriptSite(dated, () => config());
            const result = await dated.run(
                'install',
                '--local',
                '--ghost-channel',
                'nightly',
                '--version',
                '20261014',
                '--no-start',
            );
            assert.equal(result.code, 0, result.stderr);
            assert.equal(
                env.get(readFileSync(join(dated.dir, '.env'), 'utf8'), 'GHOST_VERSION'),
                '20261014',
            );
            const refused = await dated.run(
                'install',
                '--local',
                '--ghost-channel',
                'nightly',
                '--version',
                '6.70.1',
                '--no-start',
            );
            assert.notEqual(refused.code, 0);
        } finally {
            dated.cleanup();
        }
    });

    test('cannot be combined with an import', async () => {
        const other = harness();
        try {
            const result = await other.run(
                'install',
                '--local',
                '--ghost-channel',
                'nightly',
                '--import',
                '/nonexistent.tgz',
            );
            assert.equal(result.code, 2);
            assert.match(result.stderr, /--ghost-channel nightly cannot be combined with --import/);
        } finally {
            other.cleanup();
        }
    });
});

describe('updating a nightly site', () => {
    test('moves to a newer build of the same version, ordered by when it was built', async () => {
        publishToday();
        const result = await update();
        assert.equal(result.code, 0, result.stderr);
        assert.equal(setting('GHOST_IMAGE_REF'), `ghost/nightly@${TODAY}`);
        assert.equal(metadata().ghost.version, '6.70.1-rc.0+53d6a80');
        assert.equal(metadata().ghost.digest, TODAY);
    });

    test("orders against the site's build as the host holds it, once the registry has dropped it", async () => {
        publishToday();
        const pulls: string[] = [];
        const api = h.daemon.api;
        h.daemon.api = (request) => {
            if (request.method === 'POST' && request.path === '/images/create') {
                pulls.push(request.query?.tag ?? '');
                if (request.query?.tag === INDEX) {
                    return {
                        status: 404,
                        body: Buffer.from(JSON.stringify({ message: 'manifest unknown' })),
                    };
                }
            }
            return api?.(request);
        };
        const result = await update();
        assert.equal(result.code, 0, result.stderr);
        assert.equal(metadata().ghost.digest, TODAY);
        assert.ok(!pulls.includes(INDEX), `pulled ${pulls.join(', ')}`);
    });

    test('--check names the newer build and changes nothing', async () => {
        publishToday();
        const before = readSite('.env');
        const result = await update('--check');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /An update is available: Ghost 6\.70\.1-rc\.0\+53d6a80/);
        assert.equal(readSite('.env'), before);
    });

    test('refuses a build older than the one the site runs', async () => {
        publishToday('6.70.1-rc.0+0000000', '2026-10-13T03:00:00Z');
        const before = readSite('.env');
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /before the nightly build this site runs/);
        assert.equal(readSite('.env'), before);
    });

    test('refuses another major', async () => {
        publishToday('7.0.0-rc.0+abcdef0');
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /another major/);
    });

    test('takes a build date or latest, never a version', async () => {
        publishToday();
        const refused = await update('6.70.1');
        assert.equal(refused.code, 2);
        assert.match(refused.stderr, /chosen by date, such as 20261015, or latest/);
        const dated = await update('20261015');
        assert.equal(dated.code, 0, dated.stderr);
        assert.equal(metadata().ghost.digest, TODAY);
    });

    test('with nothing newer, there is nothing to update', async () => {
        const result = await update();
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /already runs Ghost 6\.70\.1-rc\.0\+d507bc2/);
    });
});

describe("the supervisor's discovery on a nightly site", () => {
    const found = () =>
        discover({
            io: h.io(),
            metadata: metadata(),
            previous: undefined,
            now: new Date(TODAY_BUILT),
        });

    test('offers the newer build one-click, pinned to its digest', async () => {
        publishToday();
        const discovery = await found();
        assert.deepEqual(discovery.oneClick, [
            {
                component: 'ghost',
                fromVersion: '6.70.1-rc.0+d507bc2',
                toVersion: '6.70.1-rc.0+53d6a80',
            },
        ]);
        assert.deepEqual(discovery.pins[0]?.target, {
            image: 'ghost/nightly',
            tag: 'latest',
            digest: TODAY,
        });
    });

    test('offers nothing when latest is the build the site runs, or older', async () => {
        assert.deepEqual((await found()).oneClick, []);
        publishToday('6.70.1-rc.0+0000000', '2026-10-13T03:00:00Z');
        assert.deepEqual((await found()).oneClick, []);
    });

    test('a build of the next major is manual, never one-click', async () => {
        publishToday('7.0.0-rc.0+abcdef0');
        const discovery = await found();
        assert.deepEqual(discovery.oneClick, []);
        assert.equal(discovery.manual[0]?.toVersion, '7.0.0-rc.0+abcdef0');
        assert.match(discovery.manual[0]?.reason ?? '', /major upgrade/);
    });
});
