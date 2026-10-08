// The bundle v1 manifest schema against docs/bundle-v1.md: the exporter's
// fixtures pass, and every way a manifest can fall short is named.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { namedFiles, readManifest } from '../src/bundle/manifest.ts';
import { fixture, type Manifest } from './site.ts';

const problems = (manifest: unknown): string[] => {
    const result = readManifest(manifest);
    return result.ok ? [] : result.problems;
};

describe('the exporter’s fixtures', () => {
    for (const kind of ['mysql-dump', 'mysql-data', 'portable']) {
        test(`a ${kind} manifest meets the contract`, () => {
            const result = readManifest(fixture(kind));
            assert.ok(result.ok, problems(fixture(kind)).join('\n'));
            assert.equal(result.manifest.kind, kind);
        });
    }

    test('config values are raw strings, byte for byte', () => {
        const result = readManifest(fixture('mysql-data'));
        assert.ok(result.ok);
        assert.equal(result.manifest.config.mail__options__auth__pass, 'pa$$word \\" #\n');
    });

    test('the files a manifest names', () => {
        const dump = readManifest(fixture('mysql-dump'));
        const portable = readManifest(fixture('portable'));
        assert.ok(dump.ok && portable.ok);
        assert.deepEqual(namedFiles(dump.manifest), ['database.sql']);
        assert.deepEqual(namedFiles(portable.manifest), [
            'content/data/content.json',
            'content/data/members.csv',
        ]);
    });

    test('fields a later exporter adds are kept, not refused', () => {
        const result = readManifest({ ...fixture('mysql-dump'), exporter: 'ghost-cli 1.34.0' });
        assert.ok(result.ok);
    });

    test('adminUrl is optional', () => {
        const manifest = fixture('mysql-data');
        delete manifest.adminUrl;
        assert.deepEqual(problems(manifest), []);
        assert.deepEqual(problems({ ...manifest, adminUrl: null }), []);
    });

    test('a prerelease Ghost version is exact', () => {
        const manifest = fixture('mysql-data');
        manifest.ghost.version = '6.3.0-rc.1';
        assert.deepEqual(problems(manifest), []);
    });
});

describe('manifests that do not meet the contract', () => {
    const cases: [string, (manifest: Manifest) => void, RegExp][] = [
        [
            'a later bundle version',
            (m) => void (m.bundleVersion = 2),
            /^bundleVersion: is 2, not 1/,
        ],
        ['no bundleCreatedAt', (m) => void delete m.bundleCreatedAt, /^bundleCreatedAt: /],
        [
            'a bundleCreatedAt that is not UTC',
            (m) => void (m.bundleCreatedAt = '2026-09-14T12:00:00+02:00'),
            /^bundleCreatedAt: must be an RFC 3339 timestamp in UTC/,
        ],
        [
            'no sourceInstallType',
            (m) => void delete m.sourceInstallType,
            /^sourceInstallType: must be local or production/,
        ],
        [
            'an unknown sourceInstallType',
            (m) => void (m.sourceInstallType = 'staging'),
            /^sourceInstallType: must be local or production, not "staging"/,
        ],
        [
            'an unknown kind',
            (m) => void (m.kind = 'sqlite'),
            /^kind: must be one of mysql-dump, mysql-data, portable, not "sqlite"/,
        ],
        [
            'a Ghost 5 source',
            (m) => void (m.ghost.version = '5.130.2'),
            /^ghost\.version: is 5\.130\.2; only Ghost 6\.x .*`ghost update`/,
        ],
        [
            'a version range instead of a version',
            (m) => void (m.ghost.version = '6'),
            /^ghost\.version: must be the exact Ghost version/,
        ],
        ['no ghost object', (m) => void (m.ghost = '6.2.0'), /^ghost: must be an object/],
        [
            'the draft ghostVersion alias',
            (m) => void (m.ghostVersion = '6.2.0'),
            /^ghostVersion: is a draft field/,
        ],
        [
            'the draft sourceEnvironment alias',
            (m) => void (m.sourceEnvironment = 'development'),
            /^sourceEnvironment: is a draft field/,
        ],
        [
            'the draft configValues alias',
            (m) => void (m.configValues = {}),
            /^configValues: is a draft field/,
        ],
        [
            'the draft database.kind alias',
            (m) => void (m.database.kind = 'mysql'),
            /^database\.kind: is a draft field/,
        ],
        [
            'a url that is not http',
            (m) => void (m.url = 'file:///etc/passwd'),
            /^url: must be an http\(s\) URL/,
        ],
        [
            'an adminUrl that is not http',
            (m) => void (m.adminUrl = 'ftp://example.com'),
            /^adminUrl: must be an http\(s\) URL/,
        ],
        [
            'no content root',
            (m) => void (m.content = 'somewhere/'),
            /^content: must be "content\/"/,
        ],
        [
            'a database path outside the bundle',
            (m) => void (m.database.path = '../database.sql'),
            /^database\.path: must be "database\.sql"/,
        ],
        [
            'no database object',
            (m) => void (m.database = 'database.sql'),
            /^database: must be an object/,
        ],
        [
            'mysql-data without row counts',
            (m) => void delete m.database.rows,
            /^database\.rows: is required for a mysql-data bundle/,
        ],
        [
            'mysql-data with empty row counts',
            (m) => void (m.database.rows = {}),
            /^database\.rows: is required for a mysql-data bundle and names no table/,
        ],
        [
            'a row count that is not a number',
            (m) => void (m.database.rows.posts = '3'),
            /^database\.rows\.posts: is not a row count/,
        ],
        [
            'a negative row count',
            (m) => void (m.database.rows.posts = -1),
            /^database\.rows\.posts: is not a row count/,
        ],
        [
            'a fractional row count',
            (m) => void (m.database.rows.posts = 1.5),
            /^database\.rows\.posts: is not a row count/,
        ],
        [
            'a table name that is SQL',
            (m) => void (m.database.rows['posts`; DROP TABLE users; --'] = 1),
            /^database\.rows: "posts`; DROP TABLE users; --" is not a table name/,
        ],
        [
            'a config value that is not a string',
            (m) => void (m.config.server__port = 2368),
            /^config\.server__port: is not a string; bundle v1 config values are raw strings/,
        ],
        ['config that is not an object', (m) => void (m.config = []), /^config: must be an object/],
    ];

    for (const [name, mutate, pattern] of cases) {
        test(name, () => {
            const manifest = fixture('mysql-data');
            mutate(manifest);
            const found = problems(manifest);
            assert.ok(
                found.some((problem) => pattern.test(problem)),
                `expected ${pattern}, got:\n${found.join('\n')}`,
            );
        });
    }

    test('a portable members path that escapes the bundle', () => {
        const manifest = fixture('portable');
        manifest.database.members = '../../etc/passwd';
        assert.deepEqual(problems(manifest), [
            'database.members: must be a path inside the bundle',
        ]);
    });

    test('a portable database path that is absolute', () => {
        const manifest = fixture('portable');
        manifest.database.path = '/etc/passwd';
        assert.deepEqual(problems(manifest), ['database.path: must be a path inside the bundle']);
    });

    test('something that is not an object at all', () => {
        assert.deepEqual(problems([]), ['manifest.json is not a JSON object']);
        assert.deepEqual(problems('manifest'), ['manifest.json is not a JSON object']);
    });

    test('every problem is reported, not only the first', () => {
        const manifest = fixture('mysql-data');
        manifest.url = 'nope';
        manifest.config.a = 1;
        manifest.database.rows.posts = -1;
        assert.equal(problems(manifest).length, 3);
    });
});
