// backup and restore, against a scripted daemon and Compose. A site is
// installed from the image with ActivityPub, backed up, and restored over
// itself or into a new directory. What they do on a real host is
// tests/e2e/backup.sh; this is what they decide.
import assert from 'node:assert/strict';
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import * as tar from 'tar';
import { backupId, parseCounts } from '../src/backup.ts';
import { readBackupManifest } from '../src/backup/manifest.ts';
import { acquireLock } from '../src/lock.ts';
import {
    failed,
    harness,
    json,
    ok,
    type CreatedContainer,
    type Harness,
    type ProgramResult,
} from './helpers.ts';
import { imageApi, imageStack, INDEX, REFERENCE, resolvedProject, rootContainer } from './site.ts';

const MANAGER = `sha256:${'2'.repeat(64)}`;
const IMAGES = {
    ghost: REFERENCE,
    db: `mysql:8.0.44@sha256:${'4'.repeat(64)}`,
    activitypub: `ghcr.io/tryghost/activitypub:1.2.14@sha256:${'5'.repeat(64)}`,
};
/** What `up` with no services named starts. */
const SERVICES = ['ghost', 'db'];
const DUMP = '-- MySQL dump\nCREATE TABLE `posts` (id int);\n-- Dump completed on 2026-10-09\n';
/** The rows the scratch load reports, and the live database has. */
const ROWS: Record<string, Record<string, number>> = {
    ghost: { posts: 3, users: 1, migrations: 120 },
    activitypub: { accounts: 2, posts: 0 },
};

let h: Harness;
let stack: string;
let compose: string[][];
let containers: CreatedContainer[];
/** What each `exec` answers, by what it runs: the dump, or the site's client. */
let dump: (database: string) => ProgramResult;
let scratch: () => { status: number; stdout?: string; stderr?: string };
let ups: ProgramResult[];
/** What each `down` answers, in order; then success. */
let downs: ProgramResult[];
/** The services running, as the scripted Compose keeps them, and Ghost's health. */
let running: Set<string>;
let ghostHealth: string;
let liveTables: (database: string) => number;
let loaded: Record<string, Record<string, number>>;
/** Each dump the site's MySQL client was given, by database, as it read it. */
let loads: { database: string; sql: string }[];
/** Mounts an override adds, by service. */
let mounts: Record<string, { type: string; source: string; target: string }[]>;

const readSite = (file: string, dir = h.dir) => readFileSync(join(dir, file), 'utf8');
const backups = () =>
    existsSync(join(h.dir, 'backups')) ? readdirSync(join(h.dir, 'backups')).sort() : [];
const composed = (command: string) => compose.filter((args) => args[0] === command);

const scratchOutput = () =>
    Object.entries(ROWS)
        .map(
            ([database, tables]) =>
                `== ${database}\n${Object.entries(tables)
                    .map(([table, rows]) => `${table}\t${rows}`)
                    .join('\n')}`,
        )
        .join('\n') + '\n';

beforeEach(async () => {
    h = harness();
    stack = imageStack(h);
    h.env.GD_VERSION_FILE = `${stack}-version.json`;
    h.env.GD_CHANNEL = 'beta';
    writeFileSync(
        h.env.GD_VERSION_FILE,
        JSON.stringify({ version: 'v0.1.0-beta.1', commit: 'c'.repeat(40) }),
    );

    compose = [];
    containers = [];
    ups = [];
    downs = [];
    running = new Set();
    ghostHealth = 'healthy';
    loaded = {};
    loads = [];
    mounts = {};
    dump = () => ok(DUMP);
    scratch = () => ({ status: 0, stdout: scratchOutput() });
    liveTables = (database) => Object.keys(ROWS[database] ?? {}).length;
    h.daemon.run = (spec) => {
        containers.push(spec);
        return spec.entrypoint[0] === 'sh' ? scratch() : rootContainer(spec);
    };
    const images = imageApi({ manager: () => MANAGER });
    // Every other image the backup records is held already.
    h.daemon.api = (request) =>
        images(request) ??
        (request.method === 'GET' && request.path.startsWith('/images/')
            ? json(200, { Id: INDEX, RepoDigests: [], Config: { Env: [] } })
            : undefined);
    // The site's own user, asked over the site network.
    h.daemon.sql = (sql, { database }) => {
        if (sql.includes('information_schema')) {
            return [[String(liveTables(database))]];
        }
        if (sql.includes('COUNT(*)')) {
            return Object.entries(loaded[database] ?? ROWS[database] ?? {}).map(
                ([table, count]) => [table, String(count)],
            );
        }
        return undefined;
    };
    h.daemon.composeRun = (args, _env, input, dir = h.dir) => {
        compose.push(args);
        switch (args[0]) {
            case 'config':
                return ok(resolvedProject(dir, IMAGES, mounts));
            case 'up': {
                // What `up --wait` starts stays running, healthy or not.
                const named = args
                    .slice(args.indexOf('--wait-timeout') + 2)
                    .filter((arg) => !arg.startsWith('--'));
                for (const service of named.length > 0 ? named : SERVICES) {
                    running.add(service);
                }
                return ups.shift() ?? ok('');
            }
            case 'down': {
                const answer = downs.shift() ?? ok('');
                if (answer.exitCode === 0) {
                    running.clear();
                }
                return answer;
            }
            case 'stop': {
                const named = args
                    .slice(1)
                    .filter((arg) => !arg.startsWith('--') && !/^\d+$/.test(arg));
                for (const service of named.length > 0 ? named : [...running]) {
                    running.delete(service);
                }
                return ok('');
            }
            case 'ps':
                return ok(
                    [...running]
                        .map((service) =>
                            JSON.stringify({
                                Service: service,
                                State: 'running',
                                Health: service === 'ghost' ? ghostHealth : 'healthy',
                            }),
                        )
                        .join('\n') + '\n',
                );
            case 'exec': {
                const database = args.find((arg) => arg.startsWith('DB='))?.slice(3) ?? 'ghost';
                const script = args[args.indexOf('-c') + 1] ?? '';
                if (script.includes('mysqldump')) {
                    return dump(database);
                }
                // Loading a dump, streamed to the client.
                loads.push({ database, sql: input ?? '' });
                return ok('');
            }
            default:
                return ok('');
        }
    };

    const installed = await h.run('install', '--local', '--with', 'activitypub', '--no-start');
    assert.equal(installed.code, 0, installed.stderr);
    mkdirSync(join(h.dir, 'data', 'ghost', 'images', '2026'), { recursive: true });
    writeFileSync(join(h.dir, 'data', 'ghost', 'images', '2026', 'photo.jpg'), 'jpeg');
    mkdirSync(join(h.dir, 'data', 'ghost', 'themes', 'casper'), { recursive: true });
    writeFileSync(join(h.dir, 'data', 'ghost', 'themes', 'casper', 'package.json'), '{}');
    writeFileSync(join(h.dir, 'data', 'mysql', 'ibdata1'), 'the old database');
    // The site is running.
    running = new Set(SERVICES);
    compose = [];
    containers = [];
});
afterEach(() => {
    rmSync(`${stack}-version.json`, { force: true });
    h.cleanup();
});

/** Takes a backup, which must succeed, and returns its directory. */
async function backUp(...options: string[]): Promise<string> {
    const result = await h.run('backup', ...options);
    assert.equal(result.code, 0, result.stderr);
    const [id] = backups();
    return join(h.dir, 'backups', id!);
}

describe('backup', () => {
    test('writes a checked backup: dumps, content, files and a manifest', async () => {
        const result = await h.run('backup');
        assert.equal(result.code, 0, result.stderr);
        const [id] = backups();
        assert.match(id!, /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ$/);
        const root = join(h.dir, 'backups', id!);
        assert.match(result.stdout, new RegExp(`Backed up to ${root}`));
        assert.equal(statSync(root).mode & 0o777, 0o700);
        assert.equal(statSync(join(h.dir, 'backups')).mode & 0o777, 0o700);

        const read = readBackupManifest(root);
        assert.equal(read.state, 'present', read.state === 'refused' ? read.reason : '');
        const manifest = read.state === 'present' ? read.manifest : null!;
        assert.deepEqual(
            manifest.databases.map((database) => [database.name, database.tables]),
            [
                ['ghost', ROWS.ghost],
                ['activitypub', ROWS.activitypub],
            ],
        );
        assert.deepEqual(manifest.images, IMAGES);
        assert.equal(manifest.site.dir, h.dir);
        assert.deepEqual(manifest.site.profiles, ['local', 'activitypub']);
        assert.equal(manifest.content.entries > 3, true);
        for (const file of [
            'database/ghost.sql',
            'database/activitypub.sql',
            'content.tar.gz',
            'site/.env',
            'site/ghost.env',
            'site/.ghost-docker.json',
            'site/compose.yml',
            'site/ghost-docker',
        ]) {
            assert.ok(file in manifest.files, `${file} is in the manifest`);
            assert.ok(existsSync(join(root, file)), `${file} is in the backup`);
        }
        assert.equal(readFileSync(join(root, 'database', 'ghost.sql'), 'utf8'), DUMP);
        assert.equal(statSync(join(root, 'database', 'ghost.sql')).mode & 0o777, 0o600);
        assert.equal(statSync(join(root, 'manifest.json')).mode & 0o777, 0o600);

        // Dumped as the site's user, then checked in a scratch MySQL from the
        // site's own image, with nothing but the backup, read-only.
        const dumps = composed('exec').filter((args) =>
            args.some((arg) => arg.includes('mysqldump')),
        );
        assert.deepEqual(
            dumps.map((args) => args.find((arg) => arg.startsWith('DB='))),
            ['DB=ghost', 'DB=activitypub'],
        );
        assert.match(dumps[0]!.at(-1)!, /-u"\$MYSQL_USER"/);
        assert.match(dumps[0]!.at(-1)!, /--single-transaction/);
        const [check] = containers;
        assert.equal(check!.image, IMAGES.db);
        assert.deepEqual(check!.cmd, ['ghost', 'activitypub']);
        assert.deepEqual(check!.binds, [
            `${root.replace(/\/[^/]+$/, `/.${id}.partial`)}:/backup:ro`,
        ]);
        assert.equal(check!.network, 'none');

        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));
    });

    test('a database that is not running is started for the dump, and stopped again', async () => {
        running.clear();
        await backUp();
        assert.deepEqual(composed('up')[0]?.at(-1), 'db');
        assert.deepEqual(composed('stop'), [['stop', 'db']]);
        assert.deepEqual([...running], []);
    });

    test('a dump that fails is an error, not a backup', async () => {
        dump = (database) =>
            database === 'activitypub'
                ? failed(2, "mysqldump: Got error: 1044: Access denied for user 'ghost'@'%'")
                : ok(DUMP);
        const result = await h.run('backup');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /the activitypub database could not be dumped/);
        assert.match(result.stderr, /Access denied/);
        assert.deepEqual(backups(), []);
        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));
    });

    test('a dump cut short is an error', async () => {
        dump = () => ok('-- MySQL dump\nINSERT INTO `posts` VALUES (1');
        const result = await h.run('backup');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /the dump of the ghost database is incomplete/);
        assert.deepEqual(backups(), []);
    });

    test('a dump that does not load into the scratch MySQL is an error', async () => {
        scratch = () => ({
            status: 4,
            stderr: 'ERROR 1064 (42000) at line 2: You have an error in your SQL syntax\nthe dump of ghost does not load\n',
        });
        const result = await h.run('backup');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /the dumps do not load into MySQL, so they are not a backup/);
        assert.match(result.stderr, /ERROR 1064/);
        assert.deepEqual(backups(), []);
    });

    test('a dump that loads fewer tables than the database has is an error', async () => {
        liveTables = (database) => (database === 'ghost' ? 4 : 2);
        const result = await h.run('backup');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /the dump of the ghost database loads 3 tables, but the database has 4/,
        );
        assert.deepEqual(backups(), []);
    });

    test('a database that stops answering fails the backup, and leaves the site for the next', async () => {
        const answer = h.daemon.sql!;
        h.daemon.sql = (sql, target) =>
            target.database === 'activitypub'
                ? new Error('db-x:3306: no answer to a query within 60 seconds')
                : answer(sql, target);
        const result = await h.run('backup');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /the activitypub database's tables could not be counted: db-x:3306: no answer to a query within 60 seconds/,
        );
        assert.deepEqual(backups(), []);
        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));
        assert.equal(h.network.held, 0, 'the manager is still on the site network');
        assert.equal(h.network.opened, h.network.closed, 'a database connection was left open');

        h.daemon.sql = answer;
        await backUp();
    });

    test('is refused while another operation holds the lock', async () => {
        const lock = acquireLock(
            h.dir,
            'update to v0.1.0-beta.2',
            new Date('2026-10-09T10:00:00Z'),
        );
        const result = await h.run('backup');
        lock.release();
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /held by update to v0\.1\.0-beta\.2, started 2026-10-09T10:00:00Z/,
        );
        assert.deepEqual(backups(), []);
        assert.deepEqual(compose, []);
    });

    test('a site whose data an operator moved is refused, not half backed up', async () => {
        appendFileSync(join(h.dir, '.env'), 'UPLOAD_LOCATION=/srv/content\n');
        const result = await h.run('backup');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /Compose mounts \/srv\/content \(bind\) at \/home\/ghost\/content in the ghost service/,
        );
        assert.deepEqual(backups(), []);
    });
});

/** The site's project, as install named it. */
const projectOf = (dir = h.dir) => JSON.parse(readSite('.ghost-docker.json', dir)).site.project;
const RUNNING_DB = `sha256:${'6'.repeat(64)}`;
/** A container of the site's project, as Compose labels it. */
const containerOf = (service: string, extra: Record<string, unknown> = {}, dir = h.dir) => ({
    Id: `${service}-id`,
    Names: [`/${projectOf()}-${service}-1`],
    State: 'running',
    Image: IMAGES[service as keyof typeof IMAGES],
    ImageID: INDEX,
    Labels: {
        'com.docker.compose.project': projectOf(),
        'com.docker.compose.project.working_dir': dir,
        'com.docker.compose.service': service,
    },
    ...extra,
});

describe('backup records what the site runs', () => {
    test('each running service by its exact image, and the dumps checked with the MySQL that wrote them', async () => {
        h.daemon.containers = [containerOf('ghost'), containerOf('db', { ImageID: RUNNING_DB })];
        const images = h.daemon.api!;
        h.daemon.api = (request) =>
            request.method === 'GET' && request.path === `/images/${RUNNING_DB}/json`
                ? json(200, {
                      Id: RUNNING_DB,
                      RepoDigests: [IMAGES.db.replace(/:[^:@]+@/, '@')],
                      Config: { Env: [] },
                  })
                : images(request);
        const result = await h.run('backup');
        assert.equal(result.code, 0, result.stderr);
        const read = readBackupManifest(join(h.dir, 'backups', backups()[0]!));
        const manifest = read.state === 'present' ? read.manifest : null!;
        assert.deepEqual(manifest.running, {
            db: { image: IMAGES.db, id: RUNNING_DB, digests: [`mysql@sha256:${'4'.repeat(64)}`] },
            ghost: { image: IMAGES.ghost, id: INDEX, digests: [] },
        });
        assert.equal(containers[0]!.image, RUNNING_DB);
        // The db's tag-and-digest now names another image than the one running.
        assert.match(
            result.stderr,
            /warning +images +db runs sha256:6{12}, and mysql:8\.0\.44@sha256:4{64} now names sha256:1{12}\./,
        );
    });

    test('a service whose configuration names another image is reported, and both are recorded', async () => {
        h.daemon.containers = [containerOf('ghost', { Image: 'ghost:6.0.0' })];
        const result = await h.run('backup');
        assert.equal(result.code, 0, result.stderr);
        assert.match(
            result.stderr,
            /ghost runs ghost:6\.0\.0, and the configuration names ghost@sha256:1{64}/,
        );
        assert.match(result.stderr, /docker compose up -d applies the configuration/);
        const read = readBackupManifest(join(h.dir, 'backups', backups()[0]!));
        const manifest = read.state === 'present' ? read.manifest : null!;
        assert.equal(manifest.images.ghost, IMAGES.ghost);
        assert.equal(manifest.running.ghost!.image, 'ghost:6.0.0');
    });

    test('a mount an override puts inside the content is refused, not half backed up', async () => {
        mounts = {
            ghost: [{ type: 'bind', source: '/srv/images', target: '/home/ghost/content/images' }],
        };
        const result = await h.run('backup');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /Compose mounts \/srv\/images at \/home\/ghost\/content\/images, inside \/home\/ghost\/content/,
        );
        assert.deepEqual(backups(), []);
    });

    test('the overrides GD_COMPOSE_OVERRIDES adds are in the backup, and recorded', async () => {
        writeFileSync(join(h.dir, 'compose.ipv6.yml'), 'services: {}\n');
        h.env.GD_COMPOSE_OVERRIDES = 'compose.ipv6.yml';
        const root = await backUp();
        const read = readBackupManifest(root);
        const manifest = read.state === 'present' ? read.manifest : null!;
        assert.deepEqual(manifest.site.overrides, ['compose.ipv6.yml']);
        assert.ok('site/compose.ipv6.yml' in manifest.files);
    });

    test('an override outside the site is refused', async () => {
        h.env.GD_COMPOSE_OVERRIDES = '/etc/ghost/compose.extra.yml';
        const result = await h.run('backup');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /GD_COMPOSE_OVERRIDES names \/etc\/ghost\/compose\.extra\.yml, which is outside the site/,
        );
        assert.deepEqual(backups(), []);
    });

    test('a project whose containers another directory made is refused before anything runs', async () => {
        h.daemon.containers = [containerOf('ghost', {}, '/srv/other')];
        const result = await h.run('backup');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            new RegExp(`the Compose project ${projectOf()} belongs to /srv/other`),
        );
        assert.deepEqual(composed('exec'), []);
        assert.deepEqual(composed('up'), []);
        assert.deepEqual(backups(), []);
    });
});

describe('restore over the site', () => {
    test('puts the backup back, pinned, and removes the site it replaced once verified', async () => {
        const root = await backUp();
        const env = readSite('.env');
        const ghostEnv = readSite('ghost.env');
        writeFileSync(join(h.dir, 'ghost.env'), 'mail__transport=SMTP\n');
        writeFileSync(join(h.dir, 'data', 'ghost', 'images', '2026', 'later.jpg'), 'new');
        compose = [];
        containers = [];
        h.network.queries.length = 0;

        const result = await h.run('restore', '--yes', root);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(readSite('.env'), env);
        assert.equal(readSite('ghost.env'), ghostEnv);
        assert.equal(readSite('data/ghost/images/2026/photo.jpg'), 'jpeg');
        assert.ok(!existsSync(join(h.dir, 'data', 'ghost', 'images', '2026', 'later.jpg')));
        // MySQL starts on a new, empty data directory and the dumps are loaded into it.
        assert.deepEqual(readdirSync(join(h.dir, 'data', 'mysql')), []);
        assert.ok(!existsSync(join(h.dir, '.ghost-docker-restore')));
        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));

        assert.deepEqual(
            compose.map((args) => args[0]),
            ['down', 'ps', 'config', 'up', 'exec', 'ps', 'exec', 'ps', 'up', 'ps'],
        );
        assert.equal(composed('up')[0]?.at(-1), 'db');
        // Loaded by the db container's client and counted over the site
        // network, as the site's user, each in its own database.
        assert.deepEqual(
            composed('exec').map((args) => args.find((arg) => arg.startsWith('DB='))),
            ['DB=ghost', 'DB=activitypub'],
        );
        // Each dump reached the client whole.
        assert.deepEqual(loads, [
            { database: 'ghost', sql: DUMP },
            { database: 'activitypub', sql: DUMP },
        ]);
        assert.deepEqual(
            h.network.queries.map(({ database }) => database),
            ['ghost', 'activitypub'],
        );
        const project = JSON.parse(readSite('.ghost-docker.json')).site.project;
        assert.ok(h.network.queries.every(({ host }) => host === `db-${project}`));
        // Each data directory moved aside on its own, then the copy removed.
        assert.deepEqual(
            containers.map((spec) => [spec.entrypoint[0], spec.cmd[0]]),
            [
                ['mv', '/site/data/ghost'],
                ['mv', '/site/data/mysql'],
                ['rm', '/site/.ghost-docker-restore'],
            ],
        );
        assert.deepEqual([...running].sort(), ['db', 'ghost']);
        assert.match(result.stdout, /Restored http:\/\/localhost:\d+ from /);
    });

    test('asks first, and without a terminal needs --yes', async () => {
        const root = await backUp();
        compose = [];
        const refused = await h.run('restore', root);
        assert.equal(refused.code, 2);
        assert.match(refused.stderr, /Run it again with --yes/);
        assert.deepEqual(compose, []);

        h.answers = ['no'];
        const declined = await h.run('restore', root);
        assert.equal(declined.code, 1);
        assert.match(declined.stderr, /the restore was cancelled\. Nothing has been changed/);
        assert.deepEqual(compose, []);
    });

    test('a backup that does not match its checksums is refused before anything changes', async () => {
        const root = await backUp();
        appendFileSync(join(root, 'database', 'ghost.sql'), 'DROP TABLE posts;\n');
        compose = [];
        const result = await h.run('restore', '--yes', root);
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /database\/ghost\.sql in the backup does not match its checksum.*Nothing has been changed/,
        );
        assert.deepEqual(compose, []);
    });

    test('rows that do not match the backup need the operator, with the old site kept', async () => {
        const root = await backUp();
        loaded = { ghost: { ...ROWS.ghost, posts: 2 } };
        const result = await h.run('restore', '--yes', root);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /posts: the backup records 3 rows, the database has 2/);
        assert.match(result.stderr, /the site needs you/);
        assert.match(result.stderr, /the restore failed, and the site needs the operator/);
        assert.equal(
            readFileSync(join(h.dir, '.ghost-docker-restore', 'data', 'mysql', 'ibdata1'), 'utf8'),
            'the old database',
        );
        assert.ok(existsSync(join(h.dir, '.ghost-docker-restore', 'files', '.env')));
        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));

        const checked = await h.run('check');
        assert.match(
            checked.stderr,
            /\.ghost-docker-restore +.* holds the site as it was before a restore/,
        );

        // And a restore is refused until the operator has dealt with it.
        const again = await h.run('restore', '--yes', root);
        assert.equal(again.code, 1);
        assert.match(again.stderr, /left from a restore that did not finish/);
    });

    test('a site that cannot be stopped is left as it was, with nothing moved', async () => {
        const root = await backUp();
        containers = [];
        downs = [failed(1, 'Error response from daemon: cannot stop container')];
        const result = await h.run('restore', '--yes', root);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /the site could not be stopped: .*cannot stop container/);
        assert.match(result.stderr, /Nothing was moved or written/);
        assert.match(result.stderr, /These of its services are still running: db, ghost\./);
        assert.doesNotMatch(result.stderr, /rm -rf|sudo mv/);
        assert.deepEqual([...running].sort(), ['db', 'ghost']);
        assert.equal(readSite('data/mysql/ibdata1'), 'the old database');
        assert.ok(!existsSync(join(h.dir, '.ghost-docker-restore')));
        assert.deepEqual(containers, []);
        assert.ok(!existsSync(join(h.dir, '.ghost-docker.lock')));
    });

    test('data that cannot all be moved aside is moved back, and nothing is written', async () => {
        const root = await backUp();
        compose = [];
        const env = readSite('.env');
        h.daemon.run = (spec) =>
            spec.entrypoint[0] === 'mv' && spec.cmd[0] === '/site/data/mysql'
                ? { status: 1, stderr: 'mv: cannot move: Device or resource busy' }
                : rootContainer(spec);
        const result = await h.run('restore', '--yes', root);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /data\/mysql could not be moved aside: .*resource busy/);
        assert.match(result.stderr, /What it had set aside is back in place/);
        assert.match(result.stderr, /Its services are stopped\./);
        assert.match(result.stderr, /the site’s files and data are as they were/);
        assert.doesNotMatch(result.stderr, /rm -rf/);
        assert.equal(readSite('data/ghost/images/2026/photo.jpg'), 'jpeg');
        assert.equal(readSite('data/mysql/ibdata1'), 'the old database');
        assert.equal(readSite('.env'), env);
        assert.ok(!existsSync(join(h.dir, '.ghost-docker-restore')));
        assert.deepEqual([...running], []);
        assert.deepEqual(composed('up'), []);
    });

    test('data moved aside that cannot be moved back is named, and nothing is removed', async () => {
        const root = await backUp();
        h.daemon.run = (spec) =>
            spec.entrypoint[0] === 'mv' && spec.cmd[0] !== '/site/data/ghost'
                ? { status: 1, stderr: 'mv: Permission denied' }
                : rootContainer(spec);
        const result = await h.run('restore', '--yes', root);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /could not all be moved back/);
        assert.match(result.stderr, /data\/ghost could not be moved back: mv: Permission denied/);
        assert.match(
            result.stderr,
            /\d\. sudo mv \.ghost-docker-restore\/data\/ghost data\/ghost\n/,
        );
        // data/mysql never moved, so nothing says to move or remove it.
        assert.doesNotMatch(result.stderr, /rm -rf data|data\/mysql data/);
        assert.equal(readSite('.ghost-docker-restore/data/ghost/images/2026/photo.jpg'), 'jpeg');
        assert.equal(readSite('data/mysql/ibdata1'), 'the old database');
        assert.match(result.stderr, /the restore failed, and the site needs the operator/);
    });

    test('a site that fails to start is stopped, and needs the operator', async () => {
        const root = await backUp();
        ups = [ok(''), failed(1, 'container ghost is unhealthy')];
        const result = await h.run('restore', '--yes', root);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /container ghost is unhealthy/);
        assert.match(
            result.stderr,
            /The restore did not complete, and the site needs you\.\nIts services are stopped\./,
        );
        assert.match(
            result.stderr,
            /sudo rm -rf data\/ghost && sudo mv \.ghost-docker-restore\/data\/ghost data\/ghost/,
        );
        assert.match(
            result.stderr,
            /sudo rm -rf data\/mysql && sudo mv \.ghost-docker-restore\/data\/mysql data\/mysql/,
        );
        assert.deepEqual([...running], []);
        assert.equal(readSite('.ghost-docker-restore/data/mysql/ibdata1'), 'the old database');
    });

    test('a site that starts but does not verify is stopped, and needs the operator', async () => {
        const root = await backUp();
        ghostHealth = 'unhealthy';
        const result = await h.run('restore', '--yes', root);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /not reachable through its own ingress/);
        assert.match(result.stderr, /Its services are stopped\./);
        assert.deepEqual([...running], []);
        assert.ok(existsSync(join(h.dir, '.ghost-docker-restore', 'files', '.env')));
    });

    test('restored services that cannot be stopped are named as running', async () => {
        const root = await backUp();
        ups = [ok(''), failed(1, 'container ghost is unhealthy')];
        downs = [ok(''), failed(1, 'cannot stop container')];
        const result = await h.run('restore', '--yes', root);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /docker compose down failed: cannot stop container/);
        assert.match(result.stderr, /These of its services are still running: db, ghost\./);
        assert.deepEqual([...running].sort(), ['db', 'ghost']);
    });

    test('is refused while another operation holds the lock', async () => {
        const root = await backUp();
        compose = [];
        const lock = acquireLock(h.dir, 'backup');
        const result = await h.run('restore', '--yes', root);
        lock.release();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /held by backup/);
        assert.deepEqual(compose, []);
    });

    test('a directory holding another site is refused', async () => {
        const root = await backUp();
        const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
        manifest.site.project = 'ghost-another-site';
        writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
        compose = [];
        const result = await h.run('restore', '--yes', root);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /holds another site .*this backup is of ghost-another-site/);
        assert.deepEqual(compose, []);
    });
});

describe('check and the project', () => {
    test("reports a project another directory's containers belong to, and reads none of them", async () => {
        h.daemon.containers = [containerOf('ghost', {}, '/srv/other')];
        const result = await h.run('check');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            new RegExp(`ERROR +project +the Compose project ${projectOf()} belongs to /srv/other`),
        );
        assert.deepEqual(composed('ps'), []);
    });

    test('warns of a running image the configuration no longer names', async () => {
        h.daemon.containers = [containerOf('ghost', { Image: 'ghost:6.0.0' })];
        const result = await h.run('check');
        assert.match(
            result.stderr,
            /warning +images +ghost runs ghost:6\.0\.0, and the configuration names ghost@sha256:1{64}; docker compose up -d applies the configuration/,
        );
    });
});

describe('restore and the overrides', () => {
    test('is refused when GD_COMPOSE_OVERRIDES is not what the backup was taken with', async () => {
        writeFileSync(join(h.dir, 'compose.ipv6.yml'), 'services: {}\n');
        h.env.GD_COMPOSE_OVERRIDES = 'compose.ipv6.yml';
        const root = await backUp();
        delete h.env.GD_COMPOSE_OVERRIDES;
        compose = [];
        const result = await h.run('restore', '--yes', root);
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /the backup was taken with GD_COMPOSE_OVERRIDES=compose\.ipv6\.yml, and this restore runs with none/,
        );
        assert.deepEqual(composed('down'), []);
    });

    test('over a site whose project another directory has containers for is refused', async () => {
        const root = await backUp();
        h.daemon.containers = [containerOf('ghost', {}, '/srv/other')];
        compose = [];
        const result = await h.run('restore', '--yes', root);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /belongs to \/srv\/other/);
        assert.deepEqual(composed('down'), []);
    });
});

describe('restore into a new directory', () => {
    let fresh: string;

    beforeEach(() => {
        fresh = realpathSync(mkdtempSync(join(tmpdir(), 'gd-restore-fresh-')));
    });
    afterEach(() => rmSync(fresh, { recursive: true, force: true }));

    const into = (dir: string) => {
        h.env.GD_SITE_DIR = dir;
        h.cwd = dir;
    };

    test('writes the site with its new path, from the backup alone', async () => {
        const root = await backUp();
        into(fresh);
        compose = [];
        containers = [];
        const result = await h.run('restore', root);
        assert.equal(result.code, 0, result.stderr);
        assert.match(readSite('.env', fresh), new RegExp(`^PROJECT_DIR=.*${fresh}`, 'm'));
        assert.equal(JSON.parse(readSite('.ghost-docker.json', fresh)).site.dir, fresh);
        assert.equal(readSite('compose.yml', fresh), readSite('compose.yml'));
        assert.equal(readSite('ghost-docker', fresh), readSite('ghost-docker'));
        assert.equal(readSite('data/ghost/themes/casper/package.json', fresh), '{}');
        // Nothing to stop and nothing set aside.
        assert.deepEqual(composed('down'), []);
        assert.deepEqual(containers, []);
        assert.deepEqual([...running].sort(), ['db', 'ghost']);
        assert.match(result.stdout, new RegExp(`into ${fresh}`));
    });

    test('is refused while the site the backup came from still has containers', async () => {
        const root = await backUp();
        into(fresh);
        h.daemon.containers = [
            {
                Id: 'abc',
                Names: ['/ghost-local-site-ghost-1'],
                State: 'exited',
                Labels: {
                    'com.docker.compose.project': JSON.parse(readSite('.ghost-docker.json')).site
                        .project,
                },
            },
        ];
        const result = await h.run('restore', root);
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /already has containers on this host \(ghost-local-site-ghost-1\)/,
        );
        assert.match(result.stderr, /Nothing was stopped/);
        assert.deepEqual(readdirSync(fresh), []);
    });

    test('a directory with data in it is refused', async () => {
        const root = await backUp();
        into(fresh);
        mkdirSync(join(fresh, 'data', 'mysql'), { recursive: true });
        writeFileSync(join(fresh, 'data', 'mysql', 'ibdata1'), 'someone else');
        const result = await h.run('restore', root);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /data\/mysql is not empty/);
    });

    test('a checkout backup needs a checkout at its commit', async () => {
        const root = await backUp();
        const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
        manifest.site.source = 'checkout';
        manifest.site.commit = 'd'.repeat(40);
        writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
        into(fresh);
        const result = await h.run('restore', root);
        assert.equal(result.code, 1);
        assert.match(result.stderr, new RegExp(`git -C ${fresh} checkout d{40}`));
    });
});

describe('consistency', () => {
    const PHOTO = join('data', 'ghost', 'images', '2026', 'photo.jpg');
    /** What the backup's content archive holds. */
    const archived = async (root: string): Promise<string[]> => {
        const entries: string[] = [];
        await tar.t({
            file: join(root, 'content.tar.gz'),
            onReadEntry: (entry) => entries.push(entry.path),
        });
        return entries;
    };
    /** Compose's commands and the scratch check, in the order they ran. */
    let events: string[];

    beforeEach(() => {
        running.add('activitypub');
        events = [];
        const answer = h.daemon.composeRun!;
        h.daemon.composeRun = (args, env, input) => {
            const result = answer(args, env, input);
            const services = args
                .slice(1)
                .filter((arg) => /^[a-z]+$/.test(arg))
                .join(' ');
            events.push(
                args[0] === 'exec'
                    ? 'dump'
                    : args[0] === 'up' && args.includes('--no-recreate')
                      ? `resume ${services}`
                      : args[0] === 'stop'
                        ? `stop ${services}`
                        : args[0]!,
            );
            return result;
        };
        const run = h.daemon.run!;
        h.daemon.run = (spec) => {
            events.push(spec.entrypoint[0] === 'sh' ? 'scratch' : spec.entrypoint[0]!);
            return run(spec);
        };
        // Something writing while Ghost runs: a post's image removed after
        // the database that refers to it was dumped.
        dump = () => {
            if (running.has('ghost')) {
                rmSync(join(h.dir, PHOTO), { force: true });
            }
            return ok(DUMP);
        };
    });

    test('a consistent backup stops Ghost and ActivityPub for the capture, running again before the check', async () => {
        const root = await backUp('--consistent');
        assert.deepEqual(events, [
            'config',
            'ps',
            'stop ghost activitypub',
            // Each dump, then its tables counted over the site network.
            'dump',
            'ps',
            'dump',
            'ps',
            'resume ghost activitypub',
            'scratch',
        ]);
        assert.deepEqual([...running].sort(), ['activitypub', 'db', 'ghost']);
        assert.equal(
            JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).consistency,
            'quiesced',
        );
        // Nothing wrote between the dumps and the archive: the image the
        // database refers to is in it.
        assert.ok((await archived(root)).includes('./images/2026/photo.jpg'));
    });

    test('a backup is live by default: they keep running, and it records its weaker guarantee', async () => {
        const result = await h.run('backup');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /captured at different moments/);
        assert.ok(!events.some((event) => event.startsWith('stop') || event.startsWith('resume')));
        const [id] = backups();
        const root = join(h.dir, 'backups', id!);
        assert.equal(
            JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).consistency,
            'live',
        );
        // The writer ran during the capture: the database refers to an image
        // the archive does not hold, which is what live means.
        assert.ok(!(await archived(root)).includes('./images/2026/photo.jpg'));

        const restored = await h.run('restore', '--yes', root);
        assert.equal(restored.code, 0, restored.stderr);
        assert.match(restored.stdout, /This backup was taken live/);
    });

    test('writers that were not running are not started', async () => {
        running.delete('ghost');
        running.delete('activitypub');
        await backUp('--consistent');
        assert.ok(!events.some((event) => event.startsWith('stop') || event.startsWith('resume')));
        assert.deepEqual([...running], ['db']);
    });

    test('only the writers that were running are stopped and started again', async () => {
        running.delete('activitypub');
        await backUp('--consistent');
        assert.ok(events.includes('stop ghost'));
        assert.deepEqual(
            events.filter((event) => event.startsWith('resume')),
            ['resume ghost'],
        );
        assert.deepEqual([...running].sort(), ['db', 'ghost']);
    });

    test('a capture that fails starts the writers again', async () => {
        dump = (database) =>
            database === 'activitypub' ? failed(2, 'mysqldump: Got error: 2013') : ok(DUMP);
        const result = await h.run('backup', '--consistent');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /the activitypub database could not be dumped/);
        assert.deepEqual(
            events.filter((event) => event.startsWith('resume')),
            ['resume ghost activitypub'],
        );
        assert.deepEqual([...running].sort(), ['activitypub', 'db', 'ghost']);
        assert.deepEqual(backups(), []);
    });

    test('a check that fails after the capture leaves the writers running', async () => {
        scratch = () => ({ status: 4, stderr: 'the dump of ghost does not load\n' });
        const result = await h.run('backup', '--consistent');
        assert.equal(result.code, 1);
        assert.deepEqual(
            events.filter((event) => event.startsWith('resume')),
            ['resume ghost activitypub'],
        );
        assert.deepEqual([...running].sort(), ['activitypub', 'db', 'ghost']);
        assert.deepEqual(backups(), []);
    });

    test('writers that do not start again fail the backup, saying how to start them', async () => {
        ups = [failed(1, 'container ghost is unhealthy')];
        const result = await h.run('backup', '--consistent');
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /ghost and activitypub did not start again after the capture: container ghost is unhealthy/,
        );
        assert.match(result.stderr, /docker compose up -d/);
        assert.deepEqual(backups(), []);
    });
});

describe('the pieces', () => {
    test('a backup is named by when it was taken', () => {
        assert.equal(backupId(new Date('2026-10-09T14:03:22.512Z')), '2026-10-09T14-03-22Z');
    });

    test("the scratch load's counts are read per database", () => {
        assert.deepEqual(
            [...parseCounts('== ghost\nposts\t3\nusers\t1\n== activitypub\n== other\nx\t0\n')],
            [
                ['ghost', { posts: 3, users: 1 }],
                ['activitypub', {}],
                ['other', { x: 0 }],
            ],
        );
    });

    test('a manifest from a newer ghost-docker is refused, naming it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'gd-manifest-'));
        writeFileSync(
            join(dir, 'manifest.json'),
            JSON.stringify({ format: 'ghost-docker-backup', version: 2 }),
        );
        const read = readBackupManifest(dir);
        rmSync(dir, { recursive: true });
        assert.equal(read.state, 'refused');
        assert.match(read.state === 'refused' ? read.reason : '', /made by a newer ghost-docker/);
    });
});
