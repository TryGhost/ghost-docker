// install --import, against a scripted daemon and Compose, and the pieces it
// is made of. What a real import of a real Ghost-CLI site does is
// tests/e2e/import.sh; this is what it decides.
import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { readManifest, type BundleManifest } from '../src/bundle/manifest.ts';
import * as env from '../src/env.ts';
import { INCOMPLETE_PROFILE, MARKER } from '../src/import.ts';
import { carriedConfig, isContainerOwned } from '../src/import/config.ts';
import {
    DefinerFilter,
    dropDefiner,
    rowCountQuery,
    rowMismatches,
} from '../src/import/database.ts';
import { failed, harness, ok, ps, type Harness, type ProgramResult } from './helpers.ts';
import { fixture, imageApi, imageStack, REFERENCE, rootContainer, type Manifest } from './site.ts';

const VERSION = '6.2.0';
/**
 * A bundle's database file: a view's DEFINER, which a dump's load drops, and
 * enough rows that it is read in many pieces.
 */
const BUNDLE_SQL =
    "INSERT INTO `posts` VALUES ('1');\n" +
    '/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */\n' +
    Array.from({ length: 4000 }, (_, i) => `INSERT INTO \`posts_meta\` VALUES ('${i}');\n`).join(
        '',
    ) +
    '-- the last line\n';
/** The same, as a dump's load reads it. */
const FILTERED_SQL = BUNDLE_SQL.replace(
    '/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */',
    '/*!50013 SQL SECURITY DEFINER */',
);

// --- The pieces ---------------------------------------------------------------

describe('DEFINER clauses in a dump', () => {
    test('a view’s DEFINER is dropped from its version comment', () => {
        assert.equal(
            dropDefiner('/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */'),
            '/*!50013 SQL SECURITY DEFINER */',
        );
    });

    test('a trigger’s DEFINER is dropped from its CREATE line', () => {
        assert.equal(
            dropDefiner(
                '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET @a = 1 */;;',
            ),
            '/*!50003 CREATE*/ /*!50003 TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET @a = 1 */;;',
        );
    });

    test('nothing else is touched, not even DEFINER in data', () => {
        for (const line of [
            "INSERT INTO `posts` VALUES ('/*!50013 DEFINER=`root`@`%` */');",
            '  /*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */',
            '/*!40101 SET NAMES utf8mb4 */;',
            'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW v AS SELECT 1;',
        ]) {
            assert.equal(dropDefiner(line), line);
        }
    });

    /** The filter's output for `input` fed in pieces of `size` bytes. */
    const filtered = async (input: Buffer, size: number): Promise<Buffer> => {
        const pieces: Buffer[] = [];
        for (let at = 0; at < input.length; at += size) {
            pieces.push(input.subarray(at, at + size));
        }
        const chunks: Buffer[] = [];
        for await (const chunk of Readable.from(pieces).pipe(new DefinerFilter())) {
            chunks.push(chunk as Buffer);
        }
        return Buffer.concat(chunks);
    };

    test('streamed, it rewrites only those lines, however the input is split', async () => {
        const dump = Buffer.concat([
            Buffer.from('-- MySQL dump\n/*!40101 SET NAMES utf8mb4 */;\n'),
            Buffer.from("INSERT INTO `t` VALUES ('"),
            Buffer.from([0xff, 0xfe, 0x00, 0x80]),
            Buffer.from("', '/*!50013 DEFINER=`root`@`%`');\n"),
            Buffer.from('/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */\n'),
            Buffer.from('/*'),
            Buffer.from('\n\n/*!'),
            Buffer.from('\n/*!50013 DEFINER=`a`@`b` */'),
        ]);
        const expected = Buffer.from(
            dump
                .toString('latin1')
                .replace('/*!50013 DEFINER=`root`@`%` SQL', '/*!50013 SQL')
                .replace('/*!50013 DEFINER=`a`@`b` */', '/*!50013 */'),
            'latin1',
        );
        for (const size of [1, 2, 3, 5, 7, 64, dump.length]) {
            assert.deepEqual(await filtered(dump, size), expected, `in pieces of ${size}`);
        }
    });

    test('a long line arrives intact', async () => {
        const line = Buffer.from(`INSERT INTO t VALUES ('${'x'.repeat(5 * 1024 * 1024)}');\n`);
        assert.deepEqual(await filtered(line, 65_536), line);
    });
});

describe('row counts', () => {
    test('one query counts every table by name', () => {
        assert.equal(
            rowCountQuery(['posts', 'users']),
            "SELECT 'posts', COUNT(*) FROM `posts` UNION ALL SELECT 'users', COUNT(*) FROM `users`",
        );
    });

    test('a table whose count differs, or that is missing, is named', () => {
        const counted = new Map([
            ['posts', 3],
            ['users', 2],
        ]);
        assert.deepEqual(rowMismatches({ posts: 3, users: 1, tags: 2 }, counted), [
            'users: the bundle records 1 rows, the database has 2',
            'tags: the bundle records 2 rows, the database has none',
        ]);
        assert.deepEqual(rowMismatches({ posts: 3 }, counted), []);
    });
});

describe('the configuration carried over', () => {
    const manifest = (config: Record<string, string>): BundleManifest => {
        const result = readManifest({ ...fixture('mysql-data'), config });
        assert.ok(result.ok);
        return result.manifest;
    };

    test('keys the container owns are left out, by the contract and by what Compose sets', () => {
        const container = new Set(['tinybird__adminToken']);
        for (const key of [
            'url',
            'admin__url',
            'process',
            'database__connection__host',
            'server__port',
            'paths__contentPath',
            'logging__path',
            'logging__transports__0',
            'tinybird__adminToken',
        ]) {
            assert.ok(isContainerOwned(key, container), key);
        }
        for (const key of ['logging__level', 'mail__from', 'urlCache', 'processes']) {
            assert.ok(!isContainerOwned(key, container), key);
        }
    });

    test('raw values are kept; what ghost.env must not hold is skipped, by name', () => {
        const carried = carriedConfig(
            manifest({
                mail__from: "'Acme' <a@example.com>",
                mail__options__auth__pass: 'p$ss"word',
                url: 'http://localhost:2368',
                database__connection__password: 'secret',
                DATABASE_PASSWORD: 'secret',
                'not-a-name': 'x',
            }),
            new Set(),
            (key) => key === 'DATABASE_PASSWORD',
        );
        assert.deepEqual(carried.settings, [
            ['mail__from', "'Acme' <a@example.com>"],
            ['mail__options__auth__pass', 'p$ss"word'],
        ]);
        assert.deepEqual(
            carried.skipped.map(({ key }) => key),
            ['url', 'database__connection__password', 'DATABASE_PASSWORD', 'not-a-name'],
        );
    });
});

// --- install --import -----------------------------------------------------------

let h: Harness;
let work: string;
let calls: { args: string[]; profiles: string | undefined; input: string | undefined }[];
/** What the database answers; the load and the final `up` can be made to fail. */
let database: { rows: Record<string, number>; tables: string; migrations: string };
let load: () => ProgramResult;
/** What the site's MySQL client read on its standard input, each load. */
let loaded: string[];
let pulls: string[];
let images: Record<string, string>;

beforeEach(() => {
    h = harness();
    work = realpathSync(mkdtempSync(join(tmpdir(), 'gd-import-bundle-')));
    imageStack(h);

    calls = [];
    pulls = [];
    database = { rows: fixture('mysql-data').database.rows, tables: '0', migrations: '354' };
    load = () => ok('');
    loaded = [];
    // Asked directly, as the site's user, over the site network.
    h.daemon.sql = (sql) => {
        if (sql.startsWith("SELECT '")) {
            return Object.entries(database.rows).map(([table, count]) => [table, String(count)]);
        }
        if (sql.includes('information_schema')) {
            return [[database.tables]];
        }
        if (sql.includes('`migrations`')) {
            return [[database.migrations]];
        }
        return undefined;
    };
    images = { [`${VERSION}-next-alpine`]: VERSION };
    h.daemon.api = (request) => imageApi({ ghost: images, pulls })(request);
    h.daemon.run = rootContainer;
    h.daemon.composeRun = (args, environment, input) => {
        calls.push({ args, profiles: environment.COMPOSE_PROFILES, input });
        switch (args[0]) {
            case 'config':
                return ok(
                    JSON.stringify({
                        services: {
                            ghost: {
                                environment: {
                                    NODE_ENV: 'development',
                                    url: 'http://localhost:2368',
                                    tinybird__adminToken: '',
                                },
                            },
                        },
                    }),
                );
            case 'exec':
                loaded.push(input ?? '');
                return load();
            case 'ps':
                return ok(
                    ps(
                        { Service: 'db', Health: 'healthy' },
                        { Service: 'ghost', Health: 'healthy' },
                    ),
                );
            default:
                return ok('');
        }
    };
});
afterEach(() => {
    h.cleanup();
    rmSync(work, { recursive: true, force: true });
});

/** A bundle directory: the manifest, its database file, and content with a dotfile. */
function bundle(manifest: Manifest, name = 'bundle'): string {
    const root = join(work, name);
    mkdirSync(join(root, 'content', 'images', '2026'), { recursive: true });
    mkdirSync(join(root, 'content', 'themes', 'source'), { recursive: true });
    writeFileSync(join(root, 'content', 'images', '2026', 'photo.jpg'), 'pixels');
    writeFileSync(join(root, 'content', 'images', '.hidden'), 'dotfile');
    writeFileSync(join(root, 'content', 'themes', 'source', 'package.json'), '{}');
    for (const path of [manifest.database?.path, manifest.database?.members]) {
        if (typeof path === 'string') {
            mkdirSync(join(root, path, '..'), { recursive: true });
            writeFileSync(join(root, path), BUNDLE_SQL);
        }
    }
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    return root;
}

const local = (kind: string): Manifest => ({ ...fixture(kind), sourceInstallType: 'local' });

const install = (...args: string[]) => h.run('install', ...args);
const siteFiles = () =>
    readdirSync(h.dir)
        .filter((name) => name !== '.ghost-docker-probe')
        .sort();
const setting = (key: string) => env.get(readFileSync(join(h.dir, '.env'), 'utf8'), key);
const ghostSetting = (key: string) => env.get(readFileSync(join(h.dir, 'ghost.env'), 'utf8'), key);
/** The Compose commands run, by their first two words. */
const ran = () => calls.map(({ args }) => args.slice(0, 2).join(' '));

describe('importing a local site', () => {
    test('a mysql-data bundle: content first, Ghost makes the schema, rows load and are counted', async () => {
        const result = await install('--import', bundle(local('mysql-data')), '--no-start');
        assert.equal(result.code, 0, result.stderr);
        assert.match(
            result.stdout,
            /ok +mysql-data +a local site, Ghost 6\.2\.0, https:\/\/example\.com/,
        );
        assert.match(result.stdout, /every count matches the bundle \(3 tables\)/);
        assert.match(result.stdout, /Imported +mysql-data bundle of https:\/\/example\.com/);
        assert.match(result.stdout, /Nothing is running/);

        assert.deepEqual(
            ran().filter((call) => call !== 'config --format'),
            [
                'up --detach',
                'up --detach',
                'rm --stop',
                'exec -T',
                'ps --all',
                'down --remove-orphans',
            ],
        );
        const ups = calls.filter(({ args }) => args[0] === 'up');
        assert.deepEqual(
            ups.map(({ args, profiles }) => [args.at(-1), profiles]),
            [
                ['db', 'local'],
                ['ghost', 'local'],
            ],
        );
        // The whole file reached the client, as it is: a data export is not filtered.
        assert.equal(loaded.length, 1);
        assert.equal(loaded[0]!.length, BUNDLE_SQL.length);
        assert.equal(loaded[0], BUNDLE_SQL);
        // The load is as the site's user, never root.
        const exec = calls.find(({ args }) => args[0] === 'exec')!;
        assert.match(exec.args.join(' '), /-u"\$MYSQL_USER"/);
        assert.doesNotMatch(exec.args.join(' '), /root/i);

        assert.equal(
            readFileSync(join(h.dir, 'data/ghost/images/2026/photo.jpg'), 'utf8'),
            'pixels',
        );
        assert.ok(existsSync(join(h.dir, 'data/ghost/images/.hidden')), 'a dotfile did not travel');
        assert.equal(setting('COMPOSE_PROFILES'), 'local');
        assert.equal(setting('GHOST_IMAGE_REF'), REFERENCE);
        assert.equal(setting('GHOST_VERSION'), `${VERSION}-next-alpine`);
        assert.ok(!existsSync(join(h.dir, MARKER)), 'the marker was left');
        assert.ok(!existsSync(join(h.dir, '.import')), 'staging was left');
        const meta = JSON.parse(readFileSync(join(h.dir, '.ghost-docker.json'), 'utf8'));
        assert.equal(meta.ghost.version, VERSION);
    });

    test('raw configuration reaches ghost.env through the encoder, without container keys', async () => {
        const manifest = local('mysql-data');
        manifest.config = {
            ...manifest.config,
            url: 'http://localhost:2368',
            server__port: '2369',
            NODE_ENV: 'production',
            DATABASE_PASSWORD: 'x',
        };
        const result = await install('--import', bundle(manifest), '--no-start');
        assert.equal(result.code, 0, result.stderr);
        assert.equal(ghostSetting('mail__options__auth__pass'), 'pa$$word \\" #\n');
        assert.equal(ghostSetting('mail__from'), 'Ghost Blog <noreply@example.com>');
        assert.match(
            readFileSync(join(h.dir, 'ghost.env'), 'utf8'),
            /^mail__options__auth__pass="pa\$\$\$\$word \\\\\\" #\\n"$/m,
        );
        for (const key of ['url', 'server__port', 'NODE_ENV', 'DATABASE_PASSWORD']) {
            assert.equal(ghostSetting(key), undefined, key);
            assert.match(result.stdout, new RegExp(`note +not carried +${key}: `));
        }
        // Names only: a value never reaches the output.
        assert.doesNotMatch(result.stdout + result.stderr, /pa\$\$word/);
    });

    test('with Mailpit, the source mail transport is replaced and its sender kept', async () => {
        const result = await install(
            '--import',
            bundle(local('mysql-data')),
            '--with',
            'mailpit',
            '--no-start',
        );
        assert.equal(result.code, 0, result.stderr);
        assert.equal(setting('COMPOSE_PROFILES'), 'local,mailpit');
        assert.equal(setting('MAILPIT_PORT'), '8025');
        assert.equal(ghostSetting('mail__options__auth__pass'), undefined);
        assert.equal(
            ghostSetting('mail__options__host'),
            `mailpit-${setting('COMPOSE_PROJECT_NAME')}`,
        );
        assert.equal(ghostSetting('mail__options__port'), '1025');
        assert.equal(ghostSetting('mail__transport'), 'SMTP');
        assert.equal(ghostSetting('mail__from'), 'Ghost Blog <noreply@example.com>');
        assert.match(
            result.stdout,
            /note +not carried +mail__options__auth__pass: replaced by Mailpit/,
        );
        // Each key once: the source's never follows Mailpit's.
        const keys = env.keys(readFileSync(join(h.dir, 'ghost.env'), 'utf8'));
        assert.equal(keys.length, new Set(keys).size);
        assert.ok(existsSync(join(h.dir, 'data', 'mailpit')));
        assert.match(result.stdout, /Mailpit +http:\/\/127\.0\.0\.1:8025/);
    });

    test('a mysql-dump bundle: an empty database, the dump, a migration history', async () => {
        const result = await install('--import', bundle(local('mysql-dump')), '--no-start');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /the database has a Ghost migration history/);
        // The whole dump reached the client, its DEFINER dropped and nothing else changed.
        assert.deepEqual(loaded, [FILTERED_SQL]);
        // Ghost is never started on a dump before it is loaded.
        assert.ok(!calls.some(({ args }) => args[0] === 'up' && args.at(-1) === 'ghost'));
        assert.deepEqual(
            h.network.queries.map(({ sql }) => sql.split(' FROM ')[1]?.split(' ')[0]),
            ['information_schema.tables', '`migrations`'],
        );
    });

    test('an archive is imported like a directory', async () => {
        const archive = join(work, 'bundle.tgz');
        const { execFileSync } = await import('node:child_process');
        execFileSync('tar', ['-czf', archive, '-C', bundle(local('mysql-data')), '.']);
        const result = await install('--import', archive, '--no-start');
        assert.equal(result.code, 0, result.stderr);
    });

    test('started, it is up with the real profiles, and .env selects them', async () => {
        let profilesAtUp: string | undefined = 'unset';
        const original = h.daemon.composeRun!;
        h.daemon.composeRun = (args, environment, input) => {
            if (args[0] === 'up' && !args.includes('db') && !args.includes('ghost')) {
                profilesAtUp = environment.COMPOSE_PROFILES;
                // The final start reads .env, which selects the site again.
                assert.equal(setting('COMPOSE_PROFILES'), 'local');
                return failed(1, 'stop here');
            }
            return original(args, environment, input);
        };
        await install('--import', bundle(local('mysql-data')));
        assert.equal(profilesAtUp, undefined);
    });

    test('a portable bundle: content placed, no database loaded, the Ghost Admin steps named', async () => {
        const result = await install('--import', bundle(local('portable')), '--no-start');
        assert.equal(result.code, 0, result.stderr);
        assert.equal(
            readFileSync(join(h.dir, 'data/ghost/images/2026/photo.jpg'), 'utf8'),
            'pixels',
        );
        assert.match(
            result.stdout,
            /none to load: Ghost Admin imports data\/ghost\/data\/content\.json and data\/ghost\/data\/members\.csv/,
        );
        // Ghost creates its own database; nothing is started or asked for one.
        assert.deepEqual(
            ran().filter((call) => !call.startsWith('config ')),
            ['down --remove-orphans'],
        );
        assert.deepEqual(h.network.queries, []);
        assert.equal(setting('COMPOSE_PROFILES'), 'local');
        assert.match(result.stdout, /Imported +portable bundle of https:\/\/example\.com/);
        assert.match(
            result.stdout,
            /create the owner account, then import:\n +data\/ghost\/data\/content\.json in Settings, Import\/Export\n +data\/ghost\/data\/members\.csv in Members, Import\n/,
        );
    });

    test("a portable bundle's files outside content/ go to data/ghost/data; no members, no step", async () => {
        const manifest = local('portable');
        manifest.database = { path: 'export.json', members: 'members.csv' };
        const root = bundle(manifest);
        writeFileSync(join(root, 'members.csv'), '');
        const result = await install('--import', root, '--no-start');
        assert.equal(result.code, 0, result.stderr);
        assert.ok(existsSync(join(h.dir, 'data/ghost/data/export.json')));
        assert.match(result.stdout, /data\/ghost\/data\/export\.json in Settings, Import\/Export/);
        assert.doesNotMatch(result.stdout, /Members, Import/);
    });

    test('an older release is found in the previous image layout', async () => {
        images = { [`${VERSION}-alpine`]: VERSION };
        const result = await install('--import', bundle(local('mysql-data')), '--no-start');
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(pulls, [`${VERSION}-next-alpine`, `${VERSION}-alpine`]);
        assert.equal(setting('GHOST_VERSION'), `${VERSION}-alpine`);
    });
});

describe('refusals that change nothing', () => {
    const refusedWith = async (args: string[], code: number, pattern: RegExp) => {
        const result = await install(...args);
        assert.equal(result.code, code, result.stderr);
        assert.match(result.stderr, pattern);
        assert.deepEqual(siteFiles(), []);
        assert.ok(!calls.some(({ args: called }) => called[0] !== 'config'), 'Compose ran');
    };

    test('options that cannot be combined with an import are usage errors', async () => {
        const path = bundle(local('mysql-data'));
        await refusedWith(
            ['--import', path, '--domain', 'example.com'],
            2,
            /--domain cannot be combined with --import.*\n.*S5e/,
        );
        await refusedWith(
            ['--import', path, '--with', 'mailpit,activitypub'],
            2,
            /--with activitypub cannot be combined with --import; only mailpit can/,
        );
        await refusedWith(['--import', ''], 2, /--import needs the path/);
        await refusedWith(
            ['--import', path, '--version', '6.3.0'],
            2,
            /--version is 6\.3\.0 but the bundle was exported from Ghost 6\.2\.0/,
        );
    });

    test('a production bundle is refused until production import exists', async () => {
        await refusedWith(
            ['--import', bundle(fixture('mysql-dump'))],
            1,
            /a production site .* this release imports local sites/,
        );
    });

    test('a bundle that is refused names why', async () => {
        const path = bundle(local('mysql-data'));
        symlinkSync('/etc/passwd', join(path, 'content', 'link'));
        await refusedWith(
            ['--import', path],
            1,
            /symbolic link: content\/link[\s\S]*The bundle was refused/,
        );
    });

    test('a bundle that is not there', async () => {
        await refusedWith(['--import', join(work, 'missing.tgz')], 1, /there is no bundle at/);
    });

    test('a Ghost version with no image', async () => {
        images = {};
        await refusedWith(
            ['--import', bundle(local('mysql-data'))],
            1,
            /no ghost image for Ghost 6\.2\.0 could be used[\s\S]*ghost update/,
        );
        assert.deepEqual(pulls, [`${VERSION}-next-alpine`, `${VERSION}-alpine`]);
    });

    test('an image that is another version', async () => {
        images = { [`${VERSION}-next-alpine`]: '6.2.1' };
        await refusedWith(
            ['--import', bundle(local('mysql-data'))],
            1,
            /is Ghost 6\.2\.1, but the bundle was exported from Ghost 6\.2\.0/,
        );
    });

    test('existing data is never merged into', async () => {
        mkdirSync(join(h.dir, 'data', 'mysql'), { recursive: true });
        writeFileSync(join(h.dir, 'data', 'mysql', 'ibdata1'), '');
        const result = await install('--import', bundle(local('mysql-data')));
        assert.equal(result.code, 1);
        assert.match(result.stderr, /data\/mysql is not empty/);
    });
});

describe('a failed import removes what it created', () => {
    const asBefore = () => {
        assert.deepEqual(siteFiles(), []);
        assert.ok(
            calls.some(({ args }) => args[0] === 'down' && args.includes('--volumes')),
            'the project was not taken down',
        );
    };

    test('a database that will not load', async () => {
        load = () =>
            failed(1, "ERROR 1146 (42S02) at line 2: Table 'ghost.no_such_table' doesn't exist");
        const result = await install('--import', bundle(local('mysql-data')));
        assert.equal(result.code, 1);
        assert.match(
            result.stderr,
            /could not be loaded. MySQL said:\n +ERROR 1146 .*no_such_table/,
        );
        assert.match(result.stderr, /export it with\n? *--sqlite-format portable/);
        assert.match(result.stderr, /is as it was before the import/);
        asBefore();
    });

    test('a database file that cannot be read fails the load, never half a dump', async () => {
        const path = bundle(local('mysql-data'));
        const original = h.daemon.composeRun!;
        // Unreadable once the import has staged and checked the bundle, before the load.
        h.daemon.composeRun = (args, environment, input) => {
            const staged = join(h.dir, '.import', 'bundle', 'database.sql');
            if (args[0] === 'up' && args.at(-1) === 'ghost') {
                assert.ok(existsSync(staged), 'the bundle is not staged where the test expects');
                rmSync(staged);
                mkdirSync(staged);
            }
            return original(args, environment, input);
        };
        const result = await install('--import', path);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /database\.sql could not be read: EISDIR/);
        asBefore();
    });

    test('row counts that disagree with the bundle', async () => {
        database.rows = { ...database.rows, posts: 4 };
        const result = await install('--import', bundle(local('mysql-data')));
        assert.equal(result.code, 1);
        assert.match(result.stderr, /posts: the bundle records 3 rows, the database has 4/);
        asBefore();
    });

    test('a dump loaded over existing tables', async () => {
        database.tables = '12';
        const result = await install('--import', bundle(local('mysql-dump')));
        assert.equal(result.code, 1);
        assert.match(result.stderr, /already holds 12 tables/);
        asBefore();
    });

    test('a dump that is not a Ghost database', async () => {
        database.migrations = '0';
        const result = await install('--import', bundle(local('mysql-dump')));
        assert.equal(result.code, 1);
        assert.match(result.stderr, /no Ghost migration history/);
        asBefore();
    });

    test('Ghost that cannot create its schema', async () => {
        const original = h.daemon.composeRun!;
        h.daemon.composeRun = (args, environment, input) =>
            args[0] === 'up' && args.at(-1) === 'ghost'
                ? (calls.push({ args, profiles: environment.COMPOSE_PROFILES, input }),
                  failed(1, 'container ghost is unhealthy'))
                : original(args, environment, input);
        const result = await install('--import', bundle(local('mysql-data')));
        assert.equal(result.code, 1);
        assert.match(result.stderr, /did not finish creating its database schema/);
        asBefore();
    });

    test('the same command then succeeds in the same directory', async () => {
        load = () => failed(1, 'ERROR 1064');
        const path = bundle(local('mysql-data'));
        assert.equal((await install('--import', path)).code, 1);
        load = () => ok('');
        // Asked directly, as the site's user, over the site network.
        h.daemon.sql = (sql) => {
            if (sql.startsWith("SELECT '")) {
                return Object.entries(database.rows).map(([table, count]) => [
                    table,
                    String(count),
                ]);
            }
            if (sql.includes('information_schema')) {
                return [[database.tables]];
            }
            if (sql.includes('`migrations`')) {
                return [[database.migrations]];
            }
            return undefined;
        };
        const result = await install('--import', path, '--no-start');
        assert.equal(result.code, 0, result.stderr);
    });
});

describe('an import that is kept, or killed, cannot be started and is cleared by the next', () => {
    test('GD_IMPORT_KEEP_FAILED keeps it, stopped and marked', async () => {
        h.env.GD_IMPORT_KEEP_FAILED = '1';
        load = () => failed(1, 'ERROR 1064');
        const result = await install('--import', bundle(local('mysql-data')));
        assert.equal(result.code, 1);
        assert.match(result.stderr, /kept for inspection/);
        assert.ok(existsSync(join(h.dir, MARKER)));
        assert.equal(setting('COMPOSE_PROFILES'), INCOMPLETE_PROFILE);
        assert.ok(
            calls.some(({ args }) => args[0] === 'stop'),
            'it was left running',
        );
        assert.ok(!calls.some(({ args }) => args[0] === 'down'));
        const journal = JSON.parse(readFileSync(join(h.dir, MARKER), 'utf8'));
        assert.ok(journal.files.includes(join(h.dir, 'compose.yml')));
        assert.ok(journal.data.includes(join(h.dir, 'data', 'ghost')));
        assert.equal(journal.project, true);

        delete h.env.GD_IMPORT_KEEP_FAILED;
        const plain = await install('--local');
        assert.equal(plain.code, 1);
        assert.match(
            plain.stderr,
            /an earlier import into .* did not finish[\s\S]*install --import BUNDLE/,
        );

        load = () => ok('');
        // Asked directly, as the site's user, over the site network.
        h.daemon.sql = (sql) => {
            if (sql.startsWith("SELECT '")) {
                return Object.entries(database.rows).map(([table, count]) => [
                    table,
                    String(count),
                ]);
            }
            if (sql.includes('information_schema')) {
                return [[database.tables]];
            }
            if (sql.includes('`migrations`')) {
                return [[database.migrations]];
            }
            return undefined;
        };
        calls = [];
        const again = await install('--import', bundle(local('mysql-data'), 'again'), '--no-start');
        assert.equal(again.code, 0, again.stderr);
        assert.match(again.stdout, /Removing what an earlier, unfinished import left behind/);
        assert.equal(calls[0]!.args[0], 'down');
        assert.ok(!existsSync(join(h.dir, MARKER)));
    });

    test('a marker that cannot be read stands for what an import writes', async () => {
        writeFileSync(join(h.dir, MARKER), 'killed mid-write');
        writeFileSync(join(h.dir, '.env'), 'COMPOSE_PROFILES="import-incomplete"\n');
        writeFileSync(join(h.dir, 'ghost.env'), '');
        mkdirSync(join(h.dir, 'data', 'ghost'), { recursive: true });
        writeFileSync(join(h.dir, 'data', 'ghost', 'left'), '');
        const result = await install('--import', bundle(local('mysql-data')), '--no-start');
        assert.equal(result.code, 0, result.stderr);
        assert.ok(!existsSync(join(h.dir, 'data', 'ghost', 'left')));
    });

    test('while it runs, .env selects no service', async () => {
        let during: string | undefined;
        load = () => {
            during = setting('COMPOSE_PROFILES');
            assert.ok(existsSync(join(h.dir, MARKER)));
            return ok('');
        };
        assert.equal(
            (await install('--import', bundle(local('mysql-data')), '--no-start')).code,
            0,
        );
        assert.equal(during, INCOMPLETE_PROFILE);
    });
});

test('the load reads database.sql through the DEFINER filter for a dump only', async () => {
    const { sqlFile } = await import('../src/import/database.ts');
    const dir = bundle(local('mysql-dump'));
    writeFileSync(
        join(dir, 'database.sql'),
        '/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */\n',
    );
    const read = (kind: string) => {
        const result = readManifest(local(kind));
        assert.ok(result.ok);
        // As the import decides it: only a dump is filtered.
        return text(sqlFile(join(dir, 'database.sql'), result.manifest.kind === 'mysql-dump'));
    };
    assert.equal(await read('mysql-dump'), '/*!50013 SQL SECURITY DEFINER */\n');
    assert.equal(await read('mysql-data'), '/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */\n');
});
