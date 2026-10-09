// update, against a scripted daemon and Compose. A site is installed from one
// release, then updated by another. What a real update does on a real host
// is tests/e2e/update.sh; this is what it decides.
import assert from 'node:assert/strict';
import {
    appendFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
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

const FIRST = `sha256:${'2'.repeat(64)}`;
const SECOND = `sha256:${'3'.repeat(64)}`;

let h: Harness;
let stack: string;
/** The running site: its Compose, its services and its database. */
let site: ScriptedSite;
let compose: string[][];
/** The manager image's ID, which the launcher is pinned to (it has no repository digest). */
let managerId: string;
let config: () => ProgramResult;

const release = (version: string) =>
    writeFileSync(h.env.GD_VERSION_FILE!, JSON.stringify({ version, commit: 'c'.repeat(40) }));
const readSite = (file: string) => readFileSync(join(h.dir, file), 'utf8');
const metadata = () => JSON.parse(readSite('.ghost-docker.json'));
const pinnedImage = () => /^readonly GD_PINNED_IMAGE="(.*)"$/m.exec(readSite('ghost-docker'))?.[1];
const update = (...args: string[]) => h.run('self-update', ...args);
const composed = (command: string) => compose.filter((args) => args[0] === command).length;
/** The compose.yml the `n`th pull ran with: the first -f. */
const pulledWith = (n: number) => {
    const pull = h.calls.filter((call) => call[0] === 'docker-compose' && call.includes('pull'))[n];
    return pull?.[pull.indexOf('-f') + 1];
};
/** `up`s that start the release's services, not the backup starting its writers again. */
const started = () =>
    compose.filter((args) => args[0] === 'up' && !args.includes('--no-recreate')).length;

/**
 * Every file in the site, with its content, to compare before and after:
 * the data and the backups aside, which tests compare by what they hold.
 */
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

beforeEach(async () => {
    h = harness();
    stack = imageStack(h);
    h.env.GD_VERSION_FILE = `${stack}-version.json`;

    managerId = FIRST;
    config = () => ok(JSON.stringify({ services: { ghost: { environment: {} } } }));
    h.daemon.api = imageApi({ manager: () => managerId });
    site = scriptSite(h, () => config());
    compose = site.compose;

    release('v0.1.0-beta.1');
    h.env.GD_CHANNEL = 'beta';
    const installed = await h.run('install', '--local', '--no-start');
    assert.equal(installed.code, 0, installed.stderr);
    writeSiteData(h.dir);
    site.running.add('ghost').add('db');
    compose.length = 0;

    // The next release: a new image, with a changed and a new file.
    release('v0.1.0-beta.2');
    managerId = SECOND;
    appendFileSync(join(stack, 'compose.ipv6.yml'), '# changed in beta.2\n');
    writeFileSync(join(stack, 'caddy', 'snippets', 'Added'), '# new in beta.2\n');
});
afterEach(() => {
    rmSync(stack, { recursive: true, force: true });
    rmSync(`${stack}-version.json`, { force: true });
    h.cleanup();
});

describe('an update between releases', () => {
    test('moves the stack and re-pins the launcher, leaving Ghost and .env alone', async () => {
        const env = readSite('.env');
        const ghostEnv = readSite('ghost.env');
        const before = metadata();
        const result = await update();
        assert.equal(result.code, 0, result.stderr);

        assert.equal(readSite('.env'), env);
        assert.equal(readSite('ghost.env'), ghostEnv);
        assert.deepEqual(metadata().ghost, before.ghost);
        assert.match(result.stdout, /Updated from v0\.1\.0-beta\.1 to v0\.1\.0-beta\.2/);
        assert.match(result.stdout, new RegExp(`Ghost +6\\.67\\.0, ${REFERENCE}, unchanged`));

        assert.equal(pinnedImage(), SECOND);
        assert.match(readSite('ghost-docker'), /^readonly GD_PINNED_CHANNEL="beta"$/m);
        const after = metadata();
        assert.deepEqual(after.stack, {
            version: 'v0.1.0-beta.2',
            ref: 'v0.1.0-beta.2',
            image: SECOND,
            previous: { version: 'v0.1.0-beta.1', image: FIRST },
        });
        assert.equal(after.installedAt, before.installedAt);
        assert.match(after.updatedAt, /^\d{4}-\d\d-\d\dT/);

        // The site resolved, to refuse what its backup would; the release's
        // images pulled while Ghost ran, then Ghost stopped for the backup and
        // kept stopped until the release started: validated, pulled, started
        // and verified, in that order.
        assert.deepEqual(
            compose.map((args) => args[0]),
            [
                'config',
                'pull',
                'config',
                'ps',
                'stop',
                'exec',
                'ps',
                'config',
                'config',
                'pull',
                'up',
                'ps',
            ],
        );
        assert.equal(pulledWith(0), join(stack, 'compose.yml'));
        assert.equal(pulledWith(1), join(h.dir, 'compose.yml'));
        assert.deepEqual(compose[4]!.slice(-1), ['ghost']);
        assert.ok(!compose.some((args) => args.includes('--no-recreate')));
        const [backup] = readdirSync(join(h.dir, 'backups'));
        assert.match(
            result.stdout,
            new RegExp(`Backup +backups/${backup}, of the site before the update`),
        );
        assert.ok(!existsSync(join(h.dir, '.ghost-docker-update')));
        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));
    });

    test('replaces untouched files, keeps edited ones with the release’s beside them', async () => {
        // The operator edits one file the release changes, and one it does not.
        appendFileSync(join(h.dir, 'compose.yml'), '# mine\n');
        appendFileSync(join(stack, 'compose.yml'), '# changed in beta.2\n');
        appendFileSync(join(h.dir, 'caddy', 'snippets', 'Logging'), '# mine\n');
        // The release drops two files: one untouched, one edited.
        rmSync(join(stack, 'caddy', 'snippets', 'TrafficAnalytics'));
        rmSync(join(stack, 'caddy', 'snippets', 'ActivityPub'));
        appendFileSync(join(h.dir, 'caddy', 'snippets', 'ActivityPub'), '# mine\n');

        const result = await update();
        assert.equal(result.code, 0, result.stderr);
        assert.equal(
            readSite('compose.ipv6.yml'),
            readFileSync(join(stack, 'compose.ipv6.yml'), 'utf8'),
        );
        assert.equal(readSite('caddy/snippets/Added'), '# new in beta.2\n');

        assert.match(readSite('compose.yml'), /# mine\n$/);
        assert.equal(readSite('compose.yml.new'), readFileSync(join(stack, 'compose.yml'), 'utf8'));
        assert.match(
            result.stdout,
            /compose\.yml has been edited, so it was kept\. This release's version is compose\.yml\.new/,
        );
        assert.match(result.stdout, /compose\.yml +compose\.yml\.new/);

        // Edited, but the release has not changed it: nothing to write beside it.
        assert.match(readSite('caddy/snippets/Logging'), /# mine\n$/);
        assert.ok(!existsSync(join(h.dir, 'caddy', 'snippets', 'Logging.new')));

        assert.ok(!existsSync(join(h.dir, 'caddy', 'snippets', 'TrafficAnalytics')));
        assert.match(readSite('caddy/snippets/ActivityPub'), /# mine\n$/);
        assert.match(
            result.stdout,
            /caddy\/snippets\/ActivityPub is no longer part of the stack, but it has been edited/,
        );

        // What is recorded is the release's: an edited file stays edited, and
        // one replaced by the release's .new is untouched from then on.
        const payload = metadata().payload;
        assert.ok(!('caddy/snippets/TrafficAnalytics' in payload));
        assert.ok(!('caddy/snippets/ActivityPub' in payload));
        assert.ok('caddy/snippets/Added' in payload);
        cpSync(join(h.dir, 'compose.yml.new'), join(h.dir, 'compose.yml'));
        release('v0.1.0-beta.3');
        managerId = `sha256:${'4'.repeat(64)}`;
        const again = await update('--check');
        assert.doesNotMatch(again.stdout, /compose\.yml: edited/);
    });

    test('an edited launcher is replaced, because it holds the pin, and kept beside it', async () => {
        appendFileSync(join(h.dir, 'ghost-docker'), '# mine\n');
        const result = await update();
        assert.equal(result.code, 0, result.stderr);
        assert.equal(pinnedImage(), SECOND);
        assert.match(readSite('ghost-docker.edited'), /# mine\n$/);
        assert.match(result.stdout, /Your copy is ghost-docker\.edited/);
    });

    test('--check says what would change, and changes nothing', async () => {
        appendFileSync(join(h.dir, 'compose.yml'), '# mine\n');
        appendFileSync(join(stack, 'compose.yml'), '# changed\n');
        const before = snapshot();
        const result = await update('--check');
        assert.equal(result.code, 0, result.stderr);
        assert.match(
            result.stdout,
            /This site runs v0\.1\.0-beta\.1\. This release is v0\.1\.0-beta\.2\./,
        );
        assert.match(result.stdout, /An update is available\. Ghost stays at 6\.67\.0\./);
        assert.match(result.stdout, /compose\.ipv6\.yml: replaced/);
        assert.match(result.stdout, /caddy\/snippets\/Added: added/);
        assert.match(result.stdout, /compose\.yml: edited, kept/);
        assert.match(result.stdout, new RegExp(`ghost-docker: pinned to ${SECOND}`));
        assert.deepEqual(snapshot(), before);
        assert.deepEqual(compose, []);
    });

    test('the same release is nothing to do', async () => {
        managerId = FIRST;
        release('v0.1.0-beta.1');
        const before = snapshot();
        const result = await update();
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /already runs v0\.1\.0-beta\.1/);
        assert.deepEqual(snapshot(), before);
    });
});

describe('refusals that change nothing', () => {
    test('a downgrade, by release number', async () => {
        release('v0.1.0-beta.10');
        managerId = `sha256:${'5'.repeat(64)}`;
        assert.equal((await update()).code, 0);
        compose.length = 0;
        release('v0.1.0-beta.9');
        managerId = SECOND;
        const before = snapshot();
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /runs v0\.1\.0-beta\.10, which is newer than v0\.1\.0-beta\.9/);
        assert.deepEqual(snapshot(), before);
        assert.deepEqual(compose, []);
    });

    test('a build that is not a release, over a site that runs one', async () => {
        release('edge-abc1234');
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /edge-abc1234, which is not a release/);
    });

    test('usage errors exit 2', async () => {
        for (const [args, message] of [
            [['--channel', 'nightly'], /--channel must be stable or beta/],
            [['--to', 'latest'], /--to must be a release/],
            [['--to', 'v1.0.0', '--channel', 'beta'], /not both/],
        ] as const) {
            const result = await update(...args);
            assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
            assert.match(result.stderr, message);
        }
    });

    test('--to a release this manager is not', async () => {
        const result = await update('--to', 'v0.1.0-beta.3');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /--to v0\.1\.0-beta\.3 was asked for, but this manager is v0\.1\.0-beta\.2/,
        );
    });

    test('a Ghost older than the release runs, with the upgrade sequence', async () => {
        const document = metadata();
        document.ghost.version = '5.130.0';
        writeFileSync(join(h.dir, '.ghost-docker.json'), JSON.stringify(document));
        const before = snapshot();
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /runs Ghost 6\.0\.0 or later, and this site runs Ghost 5\.130\.0/,
        );
        assert.match(
            result.stderr,
            /1\. Upgrade Ghost to 6\.0\.0 or later on the release this site runs now \(v0\.1\.0-beta\.1\)/,
        );
        assert.match(result.stderr, /2\. Run \.\/ghost-docker self-update again/);
        assert.deepEqual(snapshot(), before);
    });

    test('a site with no metadata', async () => {
        rmSync(join(h.dir, '.ghost-docker.json'));
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /has no \.ghost-docker\.json/);
    });

    test('another operation holding the lock, which check reports', async () => {
        const lock = acquireLock(h.dir, 'backup', new Date('2026-10-08T10:00:00Z'));
        const before = snapshot();
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /held by backup, started 2026-10-08T10:00:00Z/);
        assert.match(result.stderr, /rm .*\.ghost-docker\.lock/);
        assert.deepEqual(snapshot(), before);

        const checked = await h.run('check');
        assert.match(checked.stderr, /lock +\.ghost-docker\.lock is held by backup/);
        lock.release();
    });

    test('an unfinished update’s snapshot is never written over', async () => {
        mkdirSync(join(h.dir, '.ghost-docker-update'));
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /left from an update that did not finish/);
    });
});

describe('a site running other images than its configuration names', () => {
    test('is refused before the snapshot, the lock or the backup', async () => {
        const before = snapshot();
        h.daemon.containers = [
            {
                Id: 'ghost-id',
                Names: ['/ghost-local-site-ghost-1'],
                State: 'running',
                Image: 'ghost:6.0.0',
                ImageID: INDEX,
                Labels: {
                    'com.docker.compose.project': metadata().site.project,
                    'com.docker.compose.project.working_dir': h.dir,
                    'com.docker.compose.service': 'ghost',
                },
            },
        ];
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /the site runs other images than its configuration names/);
        assert.match(result.stderr, /ghost runs ghost:6\.0\.0/);
        assert.deepEqual(snapshot(), before);
        assert.deepEqual(
            compose.map((args) => args[0]),
            ['config'],
        );
        assert.ok(!existsSync(join(h.dir, '.ghost-docker-update')));
        assert.ok(!existsSync(join(h.dir, 'backups')));
    });
});

describe('a failed update', () => {
    test('validation failing puts the files back; the services were never changed', async () => {
        const before = snapshot();
        // The refusals and the backup resolve the site as it is; the release does not.
        const resolves = config;
        let resolved = 0;
        config = () =>
            (resolved += 1) <= 2
                ? resolves()
                : failed(1, 'service "ghost" refers to undefined volume nope');
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /Compose cannot resolve the project with this release: service "ghost" refers to undefined volume nope/,
        );
        assert.match(
            result.stderr,
            /Restored: the site is back on v0\.1\.0-beta\.1, with its files as they were\. Its services were not changed; ghost, stopped for the update, is running again\./,
        );
        assert.deepEqual(snapshot(), before);
        assert.equal(started(), 0);
        // Only the early pull, before anything was written.
        assert.equal(composed('pull'), 1);
        assert.deepEqual([...site.running].sort(), ['db', 'ghost']);
    });

    test('a pull that fails changes no service', async () => {
        const before = snapshot();
        h.daemon.composeRun = (
            (previous) => (args, env) =>
                args[0] === 'pull' ? failed(1, 'manifest unknown') : previous!(args, env)
        )(h.daemon.composeRun);
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stdout, /images +not pulled yet \(manifest unknown\)/);
        assert.match(result.stderr, /could not be pulled: manifest unknown/);
        assert.match(result.stderr, /ghost, stopped for the update, is running again/);
        assert.deepEqual(snapshot(), before);
        assert.equal(started(), 0);
        assert.deepEqual([...site.running].sort(), ['db', 'ghost']);
    });

    test('services that do not start: the previous release is started again', async () => {
        const before = snapshot();
        site.ups = [failed(1, 'container ghost is unhealthy')];
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /container ghost is unhealthy/);
        assert.match(
            result.stderr,
            /Restored: .*, its databases and content from the backup, and its services running and healthy\./,
        );
        assert.match(result.stderr, /the update failed; v0\.1\.0-beta\.1 was restored/);
        assert.deepEqual(snapshot(), before);
        assert.equal(pinnedImage(), FIRST);
        // The release's, a new database for the backup, then the previous release's.
        assert.equal(started(), 3);
        assert.deepEqual([...site.running].sort(), ['db', 'ghost']);
    });

    test('a release that migrated the database, then failed, is put back from the backup', async () => {
        const before = snapshot();
        const rows = { ...site.rows };
        // The release's services migrate the database as they start, and Ghost never becomes healthy.
        site.onUp = () => {
            site.rows = { ...site.rows, migrations: 121, activitypub_inbox: 0 };
            site.onUp = () => {};
        };
        site.ups = [failed(1, 'container ghost is unhealthy')];
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /Restored: the site is back on v0\.1\.0-beta\.1/);
        assert.match(
            result.stderr,
            /The backup taken before the update is kept in backups\/\d{4}-\d\d-\d\dT/,
        );

        // The database as it was, its content, its files and the previous images.
        assert.deepEqual(site.rows, rows);
        assert.equal(readSite('data/ghost/images/photo.jpg'), 'jpeg');
        // MySQL started on a new, empty data directory, and the dump was loaded into it.
        assert.deepEqual(readdirSync(join(h.dir, 'data', 'mysql')), []);
        assert.deepEqual(snapshot(), before);
        assert.equal(pinnedImage(), FIRST);
        assert.ok(!existsSync(join(h.dir, '.ghost-docker-update')));
        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));

        // Stopped before anything was put back, then started on the backup's data.
        const after = compose.slice(compose.findLastIndex((args) => args[0] === 'pull') + 1);
        assert.deepEqual(
            after.map((args) => args[0]),
            ['up', 'down', 'ps', 'up', 'exec', 'ps', 'up', 'ps'],
        );
        assert.equal(after[3]!.at(-1), 'db');
        assert.deepEqual([...site.running].sort(), ['db', 'ghost']);
    });

    test('services that cannot be stopped are reported running, and nothing is put back over them', async () => {
        const migrated = { ...site.rows, migrations: 121 };
        site.onUp = () => {
            site.rows = migrated;
            site.onUp = () => {};
        };
        site.ups = [failed(1, 'container ghost is unhealthy')];
        site.downs = [failed(1, 'cannot stop container')];
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /the services could not be stopped: cannot stop container/);
        assert.match(result.stderr, /These of its services are still running: db, ghost\./);
        assert.match(result.stderr, /\.\/ghost-docker restore --yes backups\/\d{4}-/);
        assert.match(result.stderr, /the site needs the operator/);
        assert.deepEqual(site.rows, migrated);
        assert.equal(readSite('data/mysql/ibdata1'), 'the database');
        assert.ok(!existsSync(join(h.dir, '.ghost-docker-update', 'data')));
        assert.deepEqual([...site.running].sort(), ['db', 'ghost']);
    });

    test('when the previous release does not start either, it says the operator is needed', async () => {
        site.ups = [
            failed(1, 'container ghost is unhealthy'),
            ok(''),
            failed(1, 'still unhealthy'),
        ];
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /The site needs you/);
        assert.match(result.stderr, /still unhealthy/);
        assert.match(result.stderr, /These of its services are still running: db, ghost\./);
        assert.match(result.stderr, /\.\/ghost-docker restore --yes backups\/\d{4}-/);
        assert.match(result.stderr, /its launcher still runs it/);
        assert.match(result.stderr, /the site needs the operator/);
        // What it would have restored is kept for the operator, with the
        // data the failed release ran on.
        assert.ok(existsSync(join(h.dir, '.ghost-docker-update', 'files', '.env')));
        assert.equal(readSite('.ghost-docker-update/data/mysql/ibdata1'), 'the database');
        assert.match(
            result.stderr,
            /The data the update's services ran on is in .*\.ghost-docker-update\/data/,
        );
        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));
    });

    test('a backup that fails changes nothing', async () => {
        const before = snapshot();
        h.daemon.sql = () => [['0']];
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /Its services were not changed; ghost, stopped for the update, is running again/,
        );
        assert.deepEqual(snapshot(), before);
        assert.ok(
            !existsSync(join(h.dir, 'backups')) || readdirSync(join(h.dir, 'backups')).length === 0,
        );
        assert.equal(started(), 0);
        assert.equal(composed('pull'), 1);
        assert.deepEqual([...site.running].sort(), ['db', 'ghost']);
    });
});

describe('the writers through an update', () => {
    /**
     * Ghost accepting a post and an upload at every step of the update it
     * runs through: each upload's name, in the order accepted. The release's
     * Ghost, from its `up` until it is stopped, never became healthy, so it
     * accepts nothing.
     */
    function writing(): string[] {
        const accepted: string[] = [];
        const previous = h.daemon.composeRun!;
        let failing = false;
        h.daemon.composeRun = (args, env, input, dir) => {
            // The first `up` that is not writers started again as they were.
            if (args[0] === 'up' && !args.includes('--no-recreate') && started() === 0) {
                failing = true;
            }
            if (site.running.has('ghost') && !failing) {
                const upload = `upload-${accepted.length}.jpg`;
                site.rows = { ...site.rows, posts: site.rows.posts! + 1 };
                writeFileSync(join(h.dir, 'data', 'ghost', 'images', upload), upload);
                accepted.push(upload);
            }
            if (args[0] === 'down') {
                failing = false;
            }
            return previous(args, env, input, dir);
        };
        return accepted;
    }

    test('nothing Ghost accepts is lost when the release migrates, fails to start, and is put back', async () => {
        const accepted = writing();
        site.onUp = () => {
            site.rows = { ...site.rows, migrations: 121 };
            site.onUp = () => {};
        };
        site.ups = [failed(1, 'container ghost is unhealthy')];
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /Restored: the site is back on v0\.1\.0-beta\.1/);

        // Ghost wrote while the images were pulled, before the backup, and
        // again once the previous release was running: never in between.
        assert.ok(accepted.length >= 2, `Ghost accepted ${accepted.length} writes`);
        assert.equal(site.rows.posts, 3 + accepted.length);
        assert.equal(site.rows.migrations, 120);
        for (const upload of accepted) {
            assert.equal(readSite(`data/ghost/images/${upload}`), upload);
        }
        assert.deepEqual([...site.running].sort(), ['db', 'ghost']);
    });

    test('a release that fails verification is put back, saying what it ran was not kept', async () => {
        const previous = h.daemon.composeRun!;
        let release = false;
        h.daemon.composeRun = (args, env, input, dir) => {
            if (args[0] === 'up' && !args.includes('--no-recreate') && !args.includes('db')) {
                release = !release && site.compose.every((call) => call[0] !== 'down');
            } else if (release && args[0] === 'ps') {
                release = false;
                site.compose.push(args);
                return ok(
                    `${JSON.stringify({ Service: 'ghost', State: 'running', Health: 'unhealthy' })}\n`,
                );
            }
            return previous(args, env, input, dir);
        };
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /not reachable through its own ingress/);
        assert.match(
            result.stderr,
            /Restored: .*, its databases and content from the backup, and its services running and healthy\./,
        );
        assert.match(
            result.stderr,
            /v0\.1\.0-beta\.2 ran before the update failed: anything the site accepted while it ran was not kept\./,
        );
        assert.equal(pinnedImage(), FIRST);
        assert.deepEqual([...site.running].sort(), ['db', 'ghost']);
    });

    test('writers that do not start again after an early failure need the operator', async () => {
        // The refusals and the backup resolve the site as it is; the release does not.
        const resolves = config;
        let resolved = 0;
        config = () =>
            (resolved += 1) <= 2
                ? resolves()
                : failed(1, 'service "ghost" refers to undefined volume nope');
        site.resumes = [failed(1, 'container ghost is unhealthy')];
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /The site needs you/);
        assert.match(
            result.stderr,
            /ghost did not start again after the update: container ghost is unhealthy/,
        );
        assert.match(result.stderr, /These of its services are still running: db, ghost\./);
        assert.match(result.stderr, /the update failed, and the site needs the operator/);
        // Its files are back, and the launcher still runs the previous image.
        assert.equal(pinnedImage(), FIRST);
        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));
    });
});

describe('a checkout', () => {
    let gitCalls: string[][];

    beforeEach(() => {
        // A different directory: a checkout, not an installed image-mode site.
        h.cleanup();
        h = harness();
        makeSite(h, LOCAL, {});
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
        gitCalls = [];
        h.daemon.gitRun = (args) => {
            gitCalls.push(args.slice(4));
            return ok(`${'b'.repeat(40)}\n`);
        };
    });

    for (const args of [[], ['--check'], ['--to', 'v1.0.0'], ['--channel', 'stable']]) {
        test(`self-update ${args.join(' ')} is refused before anything, with git and Compose's steps`, async () => {
            const before = snapshot();
            const metadataBefore = readSite('.ghost-docker.json');
            const result = await update(...args);
            assert.equal(result.code, 1);
            assert.match(
                result.stderr,
                /self-update updates only a site installed\s+from the manager image/,
            );
            assert.match(result.stderr, /git fetch --tags && git checkout <release>/);
            assert.match(result.stderr, /docker compose up -d --wait/);
            assert.match(result.stderr, /Nothing has been changed/);
            assert.deepEqual(snapshot(), before);
            assert.equal(readSite('.ghost-docker.json'), metadataBefore);
            assert.deepEqual(compose, []);
            assert.deepEqual(gitCalls, []);
        });
    }
});
