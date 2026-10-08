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
import { failed, harness, json, ok, type Harness, type ProgramResult } from './helpers.ts';
import { LOCAL, makeSite, REPO } from './site.ts';

const INDEX = `sha256:${'1'.repeat(64)}`;
const REFERENCE = `ghost@${INDEX}`;
const FIRST = `sha256:${'2'.repeat(64)}`;
const SECOND = `sha256:${'3'.repeat(64)}`;
const HEALTHY_GHOST = JSON.stringify({ Service: 'ghost', State: 'running', Health: 'healthy' });

let h: Harness;
let stack: string;
let compose: string[][];
/** The manager image's ID, which the launcher is pinned to (it has no repository digest). */
let managerId: string;
/** What each `up` answers, in order; then success. */
let ups: ProgramResult[];
let config: () => ProgramResult;

const release = (version: string) =>
    writeFileSync(h.env.GD_VERSION_FILE!, JSON.stringify({ version, commit: 'c'.repeat(40) }));
const readSite = (file: string) => readFileSync(join(h.dir, file), 'utf8');
const metadata = () => JSON.parse(readSite('.ghost-docker.json'));
const pinnedImage = () => /^readonly GD_PINNED_IMAGE="(.*)"$/m.exec(readSite('ghost-docker'))?.[1];
const update = (...args: string[]) => h.run('update', ...args);
const composed = (command: string) => compose.filter((args) => args[0] === command).length;

/** Every file in the site, with its content, to compare before and after. */
function snapshot(dir = h.dir, prefix = ''): Record<string, string> {
    const files: Record<string, string> = {};
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
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
    stack = join(h.dir, '..', `${h.dir.split('/').pop()}-stack`);
    rmSync(stack, { recursive: true, force: true });
    mkdirSync(stack, { recursive: true });
    for (const file of ['compose.yml', 'compose.ipv6.yml', '.env.example', 'ghost.env.example']) {
        cpSync(join(REPO, file), join(stack, file));
    }
    for (const directory of ['caddy', 'mysql-init']) {
        cpSync(join(REPO, directory), join(stack, directory), { recursive: true });
    }
    h.env.GD_STACK_DIR = stack;
    h.env.GD_LAUNCHER_SOURCE = join(REPO, 'ghost-docker');
    h.env.GD_SOURCE = 'image';
    h.env.GD_VERSION_FILE = `${stack}-version.json`;

    compose = [];
    managerId = FIRST;
    ups = [];
    config = () => ok(JSON.stringify({ services: { ghost: { environment: {} } } }));
    h.daemon.api = ({ method, path }) => {
        if (method === 'POST' && path === '/images/create') {
            return { status: 200, body: Buffer.from('{"status":"Pulled"}\n') };
        }
        if (method === 'GET' && path === '/images/ghost:6-next-alpine/json') {
            return json(200, {
                Id: INDEX,
                RepoDigests: [REFERENCE],
                Config: {
                    Env: [
                        'GHOST_VERSION=6.67.0',
                        'GHOST_CONTENT=/home/ghost/content',
                        'GHOST_INSTALL=/home/ghost',
                    ],
                },
            });
        }
        if (method === 'GET' && path === '/images/ghost-docker:checkout/json') {
            return json(200, { Id: managerId, RepoDigests: [], Config: { Env: [] } });
        }
        return undefined;
    };
    h.daemon.composeRun = (args) => {
        compose.push(args);
        switch (args[0]) {
            case 'config':
                return config();
            case 'up':
                return ups.shift() ?? ok('');
            case 'ps':
                return ok(`${HEALTHY_GHOST}\n`);
            default:
                return ok('');
        }
    };

    release('v0.1.0-beta.1');
    h.env.GD_CHANNEL = 'beta';
    const installed = await h.run('install', '--local', '--no-start');
    assert.equal(installed.code, 0, installed.stderr);
    compose = [];

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
            commit: 'c'.repeat(40),
            ref: 'v0.1.0-beta.2',
            image: SECOND,
            previous: { version: 'v0.1.0-beta.1', commit: 'c'.repeat(40), image: FIRST },
        });
        assert.equal(after.installedAt, before.installedAt);
        assert.match(after.updatedAt, /^\d{4}-\d\d-\d\dT/);

        // Validated, pulled, started and verified, in that order.
        assert.deepEqual(
            compose.map((args) => args[0]),
            ['config', 'config', 'pull', 'up', 'ps'],
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
        compose = [];
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
        assert.match(result.stderr, /2\. Run \.\/ghost-docker update again/);
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

describe('a failed update', () => {
    test('validation failing puts the files back; the services were never changed', async () => {
        const before = snapshot();
        config = () => failed(1, 'service "ghost" refers to undefined volume nope');
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /Compose cannot resolve the project with this release: service "ghost" refers to undefined volume nope/,
        );
        assert.match(
            result.stderr,
            /Restored: the site is back on v0\.1\.0-beta\.1, with its files as they were\. Its services were not changed\./,
        );
        assert.deepEqual(snapshot(), before);
        assert.equal(composed('up'), 0);
        assert.equal(composed('pull'), 0);
    });

    test('a pull that fails changes no service', async () => {
        const before = snapshot();
        h.daemon.composeRun = (
            (previous) => (args, env) =>
                args[0] === 'pull' ? failed(1, 'manifest unknown') : previous!(args, env)
        )(h.daemon.composeRun);
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /could not be pulled: manifest unknown/);
        assert.deepEqual(snapshot(), before);
        assert.equal(composed('up'), 0);
    });

    test('services that do not start: the previous release is started again', async () => {
        const before = snapshot();
        ups = [failed(1, 'container ghost is unhealthy')];
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /container ghost is unhealthy/);
        assert.match(result.stderr, /Restored: .*, and its services running and healthy\./);
        assert.match(result.stderr, /the update failed; v0\.1\.0-beta\.1 was restored/);
        assert.deepEqual(snapshot(), before);
        assert.equal(pinnedImage(), FIRST);
        assert.equal(composed('up'), 2);
    });

    test('when the previous release does not start either, it says the operator is needed', async () => {
        ups = [failed(1, 'container ghost is unhealthy'), failed(1, 'still unhealthy')];
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /The site needs you/);
        assert.match(result.stderr, /still unhealthy/);
        assert.match(result.stderr, new RegExp(`its launcher still runs it`));
        assert.match(result.stderr, /the site needs the operator/);
        // What it would have restored is kept for the operator.
        assert.ok(existsSync(join(h.dir, '.ghost-docker-update', 'files', '.env')));
        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));
    });
});

describe('a checkout', () => {
    const PREVIOUS = 'a'.repeat(40);
    const HEAD = 'b'.repeat(40);
    let gitCalls: string[][];
    let dirty: string;
    let behind: boolean;

    beforeEach(() => {
        // A different directory: a checkout, not an installed image-mode site.
        h.cleanup();
        h = harness();
        compose = [];
        ups = [];
        h.daemon.composeRun = (args) => {
            compose.push(args);
            if (args[0] === 'up') {
                return ups.shift() ?? ok('');
            }
            if (args[0] === 'pull') {
                return ok('');
            }
            return args[0] === 'ps' ? ok(`${HEALTHY_GHOST}\n`) : undefined;
        };
        makeSite(h, LOCAL, {});
        mkdirSync(join(h.dir, 'manager'));
        writeFileSync(join(h.dir, 'manager', 'Dockerfile'), 'FROM scratch\n');
        writeMetadata(h.dir, {
            schemaVersion: SCHEMA_VERSION,
            installedAt: '2026-10-06T09:12:44Z',
            mode: 'local',
            channel: null,
            source: 'checkout',
            stack: { version: null, commit: PREVIOUS, ref: null, image: null },
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
            migrations: [],
        });
        gitCalls = [];
        dirty = '';
        behind = false;
        h.daemon.gitRun = (args) => {
            const command = args.slice(4);
            gitCalls.push(command);
            switch (command[0]) {
                case 'rev-parse':
                    return ok(`${HEAD}\n`);
                case 'status':
                    return ok(dirty);
                case 'cat-file':
                    return ok('');
                case 'merge-base':
                    return behind ? ok('') : failed(1, '');
                case 'checkout':
                    return ok('');
                default:
                    return undefined;
            }
        };
    });

    test('records the new commit, and writes no stack files', async () => {
        const result = await update();
        assert.equal(result.code, 0, result.stderr);
        assert.equal(metadata().stack.commit, HEAD);
        assert.equal(metadata().stack.previous.commit, PREVIOUS);
        assert.equal(metadata().channel, null);
        assert.ok(!existsSync(join(h.dir, 'ghost-docker')));
        assert.ok(gitCalls.every((args) => args[0] !== 'checkout'));
    });

    test('local changes to tracked files are refused before anything changes', async () => {
        dirty = ' M compose.yml\n';
        const before = snapshot();
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /local changes to tracked files/);
        assert.match(result.stderr, /compose\.yml/);
        assert.deepEqual(snapshot(), before);
        assert.deepEqual(compose, []);
    });

    test('an older commit is a downgrade', async () => {
        behind = true;
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /newer than commit bbbbbbbbbbbb/);
    });

    test('--to and --channel do not apply', async () => {
        const result = await update('--to', 'v1.0.0');
        assert.equal(result.code, 2);
        assert.match(result.stderr, /check the release out with git/);
    });

    test('a failure checks the previous commit out and starts it again', async () => {
        ups = [failed(1, 'container ghost is unhealthy')];
        const before = snapshot();
        const result = await update();
        assert.equal(result.code, 1);
        assert.deepEqual(gitCalls.at(-1), ['checkout', '--quiet', '--detach', PREVIOUS]);
        assert.match(result.stderr, /The checkout is at aaaaaaaaaaaa again, with a detached HEAD/);
        assert.deepEqual(snapshot(), before);
        assert.equal(composed('up'), 2);
    });

    test('git that cannot read the checkout is refused', async () => {
        h.daemon.gitRun = () => failed(128, 'fatal: not a git repository');
        const result = await update();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /git cannot read the checkout/);
    });
});
