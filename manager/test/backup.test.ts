// backup and restore, against a scripted daemon and Compose. A site is
// installed from the image with ActivityPub, backed up, and restored over
// itself or into a new directory. What they do on a real host is
// tests/e2e/backup.sh; this is what they decide.
import assert from 'node:assert/strict';
import {
    appendFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
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
import { REPO } from './site.ts';

const INDEX = `sha256:${'1'.repeat(64)}`;
const REFERENCE = `ghost@${INDEX}`;
const MANAGER = `sha256:${'2'.repeat(64)}`;
const IMAGES = {
    ghost: REFERENCE,
    db: `mysql:8.0.44@sha256:${'4'.repeat(64)}`,
    activitypub: `ghcr.io/tryghost/activitypub:1.2.14@sha256:${'5'.repeat(64)}`,
};
const HEALTHY = [
    { Service: 'ghost', State: 'running', Health: 'healthy' },
    { Service: 'db', State: 'running', Health: 'healthy' },
]
    .map((entry) => JSON.stringify(entry))
    .join('\n');
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
let liveTables: (database: string) => number;
let loaded: Record<string, Record<string, number>>;

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

/** A one-shot root container does to the site what it would on a real host. */
function runContainer(spec: CreatedContainer) {
    containers.push(spec);
    const site = spec.binds.find((bind) => bind.endsWith(':/site'))?.split(':')[0];
    const onHost = (path: string) => join(site!, path.replace(/^\/site\/?/, ''));
    if (spec.entrypoint[0] === 'mv') {
        const target = onHost(spec.cmd.at(-1)!);
        for (const source of spec.cmd.slice(0, -1)) {
            renameSync(onHost(source), join(target, source.split('/').pop()!));
        }
        return { status: 0 };
    }
    if (spec.entrypoint[0] === 'rm') {
        for (const path of spec.cmd) {
            rmSync(onHost(path), { recursive: true, force: true });
        }
        return { status: 0 };
    }
    if (spec.entrypoint[0] === 'sh') {
        return scratch();
    }
    return undefined;
}

beforeEach(async () => {
    h = harness();
    stack = realpathSync(mkdtempSync(join(tmpdir(), 'gd-backup-stack-')));
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
    h.env.GD_CHANNEL = 'beta';
    writeFileSync(
        h.env.GD_VERSION_FILE,
        JSON.stringify({ version: 'v0.1.0-beta.1', commit: 'c'.repeat(40) }),
    );

    compose = [];
    containers = [];
    ups = [];
    loaded = {};
    dump = () => ok(DUMP);
    scratch = () => ({ status: 0, stdout: scratchOutput() });
    liveTables = (database) => Object.keys(ROWS[database] ?? {}).length;
    h.daemon.run = runContainer;
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
            return json(200, { Id: MANAGER, RepoDigests: [], Config: { Env: [] } });
        }
        if (method === 'GET' && path.startsWith('/images/')) {
            return json(200, { Id: INDEX, RepoDigests: [], Config: { Env: [] } });
        }
        return undefined;
    };
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
    h.daemon.composeRun = (args, _env, input) => {
        compose.push(args);
        switch (args[0]) {
            case 'config':
                return ok(
                    JSON.stringify({
                        services: Object.fromEntries(
                            Object.entries(IMAGES).map(([service, image]) => [
                                service,
                                { image, environment: {} },
                            ]),
                        ),
                    }),
                );
            case 'up':
                return ups.shift() ?? ok('');
            case 'ps':
                return ok(`${HEALTHY}\n`);
            case 'exec': {
                const database = args.find((arg) => arg.startsWith('DB='))?.slice(3) ?? 'ghost';
                const script = args[args.indexOf('-c') + 1] ?? '';
                if (script.includes('mysqldump')) {
                    return dump(database);
                }
                // Loading a dump: its input is a stream.
                return input === undefined ? ok('') : failed(1, `unexpected input: ${input}`);
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
    compose = [];
    containers = [];
});
afterEach(() => {
    rmSync(stack, { recursive: true, force: true });
    rmSync(`${stack}-version.json`, { force: true });
    h.cleanup();
});

/** Takes a backup, which must succeed, and returns its directory. */
async function backUp(): Promise<string> {
    const result = await h.run('backup');
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
        const answer = h.daemon.composeRun!;
        let started = false;
        h.daemon.composeRun = (args, env, input) => {
            started ||= args[0] === 'up';
            return args[0] === 'ps' && !started
                ? (compose.push(args), ok(''))
                : answer(args, env, input);
        };
        await backUp();
        assert.deepEqual(composed('up')[0]?.at(-1), 'db');
        assert.deepEqual(composed('stop'), [['stop', 'db']]);
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
        assert.match(result.stderr, /\.env sets UPLOAD_LOCATION to \/srv\/content/);
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
            ['down', 'config', 'up', 'exec', 'ps', 'exec', 'ps', 'up', 'ps'],
        );
        assert.equal(composed('up')[0]?.at(-1), 'db');
        // Loaded by the db container's client and counted over the site
        // network, as the site's user, each in its own database.
        assert.deepEqual(
            composed('exec').map((args) => args.find((arg) => arg.startsWith('DB='))),
            ['DB=ghost', 'DB=activitypub'],
        );
        assert.deepEqual(
            h.network.queries.map(({ database }) => database),
            ['ghost', 'activitypub'],
        );
        const project = JSON.parse(readSite('.ghost-docker.json')).site.project;
        assert.ok(h.network.queries.every(({ host }) => host === `db-${project}`));
        assert.deepEqual(
            containers.map((spec) => spec.entrypoint[0]),
            ['mv', 'rm'],
        );
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

    test('a site that fails to start needs the operator', async () => {
        const root = await backUp();
        ups = [ok(''), failed(1, 'container ghost is unhealthy')];
        const result = await h.run('restore', '--yes', root);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /container ghost is unhealthy/);
        assert.match(result.stderr, /sudo mv \.ghost-docker-restore\/data\/\* data\//);
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
