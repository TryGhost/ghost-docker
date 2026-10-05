// The bundle helper: what it stages, and everything it refuses.
//
// scripts/lib/import-helper.mjs normally runs inside a container, but it is
// plain Node with no dependencies, so it is exercised here directly. Nothing
// in this file needs Docker. The archives that a well-behaved tar would never
// produce — absolute paths, `..`, duplicate entries — are built byte by byte.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, linkSync, readdirSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tempDir, cleanup, REPO_DIR, TESTS_DIR } from './helpers.mjs';

const HELPER = join(REPO_DIR, 'scripts', 'lib', 'import-helper.mjs');
const FIXTURES = join(TESTS_DIR, 'fixtures', 'migration-bundle-v1');
const fixture = (kind) => JSON.parse(readFileSync(join(FIXTURES, `${kind}.json`), 'utf8'));

let dir;
let counter;
beforeEach(() => { dir = tempDir('import-helper'); counter = 0; });
afterEach(() => cleanup(dir));

/** Run the helper against a bundle with a fresh staging directory. */
function stage(bundle, env = {}) {
  counter += 1;
  const staging = join(dir, `staging-${counter}`);
  mkdirSync(staging, { mode: 0o700 });
  const result = spawnSync(process.execPath, [HELPER, 'stage', bundle, staging], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { ...result, staging };
}

/** A bundle directory for a manifest, with the files that manifest names. */
function bundleDir(manifest, name = 'bundle') {
  const root = join(dir, name);
  mkdirSync(join(root, 'content', 'themes', 'source'), { recursive: true });
  mkdirSync(join(root, 'content', 'images'), { recursive: true });
  writeFileSync(join(root, 'content', 'themes', 'source', 'package.json'), '{"name":"source"}\n');
  writeFileSync(join(root, 'content', 'images', '.hidden'), 'dotfile\n');
  for (const path of [manifest?.database?.path, manifest?.database?.members]) {
    if (typeof path !== 'string' || path.includes('..') || path.startsWith('/')) continue;
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'data\n');
  }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return root;
}

const refused = (result, pattern) => {
  assert.equal(result.status, 1, `expected a refusal, got ${result.status}: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, pattern);
  assert.ok(!existsSync(join(result.staging, 'bundle')), 'left a partial bundle in staging');
  assert.ok(!existsSync(join(result.staging, 'manifest.json')), 'left a manifest in staging');
};

// --- A tar writer for the entries no real tar emits --------------------------

function tarEntry(name, { type = '0', data = Buffer.alloc(0), linkname = '' } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header.write(type, 156, 'ascii');
  header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function tarball(name, entries) {
  const path = join(dir, name);
  writeFileSync(path, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
  return path;
}

const manifestEntry = (manifest = fixture('mysql-data')) =>
  tarEntry('manifest.json', { data: Buffer.from(JSON.stringify(manifest)) });

describe('staging a valid bundle', () => {
  for (const kind of ['mysql-dump', 'mysql-data', 'portable']) {
    test(`a ${kind} bundle directory is copied and its manifest returned`, () => {
      const result = stage(bundleDir(fixture(kind)));
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), fixture(kind));
      assert.deepEqual(JSON.parse(readFileSync(join(result.staging, 'manifest.json'), 'utf8')), fixture(kind));
      assert.ok(existsSync(join(result.staging, 'bundle', 'content', 'themes', 'source', 'package.json')));
      assert.ok(existsSync(join(result.staging, 'bundle', 'content', 'images', '.hidden')), 'dropped a dotfile');
    });
  }

  test('a .tgz made by the system tar extracts to the same tree', () => {
    const source = bundleDir(fixture('mysql-data'));
    const archive = join(dir, 'bundle.tgz');
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    const result = stage(archive);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(result.staging, 'bundle', 'database.sql'), 'utf8'), 'data\n');
    assert.ok(existsSync(join(result.staging, 'bundle', 'content', 'images', '.hidden')));
  });

  test('an archive that wraps the bundle in one directory is the same bundle', () => {
    bundleDir(fixture('mysql-dump'), 'ghost-migration-site');
    const archive = join(dir, 'wrapped.tgz');
    execFileSync('tar', ['-czf', archive, '-C', dir, 'ghost-migration-site']);
    const result = stage(archive);
    assert.equal(result.status, 0, result.stderr);
    // macOS tar adds `._name` metadata files; they are not part of the bundle.
    const staged = readdirSync(join(result.staging, 'bundle')).filter((name) => !name.startsWith('._'));
    assert.deepEqual(staged.sort(), ['content', 'database.sql', 'manifest.json']);
  });

  test('an uncompressed tar is read too', () => {
    const source = bundleDir(fixture('mysql-dump'));
    const archive = join(dir, 'bundle.tar');
    execFileSync('tar', ['-cf', archive, '-C', source, '.']);
    assert.equal(stage(archive).status, 0);
  });

  test('a path longer than a tar header field survives', () => {
    const source = bundleDir(fixture('mysql-dump'));
    const deep = join(source, 'content', 'images', ...Array(12).fill('a-directory-name-of-some-length'));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'photo.jpg'), 'pixels');
    const archive = join(dir, 'long.tgz');
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    const result = stage(archive);
    assert.equal(result.status, 0, result.stderr);
    const staged = join(result.staging, 'bundle', 'content', 'images',
      ...Array(12).fill('a-directory-name-of-some-length'), 'photo.jpg');
    assert.equal(readFileSync(staged, 'utf8'), 'pixels');
  });

  test('config values come through byte for byte', () => {
    const manifest = fixture('mysql-data');
    const result = stage(bundleDir(manifest));
    assert.equal(JSON.parse(result.stdout).config.mail__options__auth__pass, 'pa$$word \\" #\n');
  });
});

describe('entries that could leave the bundle, or are not files', () => {
  test('a symbolic link in a bundle directory', () => {
    const source = bundleDir(fixture('mysql-dump'));
    symlinkSync('/etc/passwd', join(source, 'content', 'images', 'link'));
    refused(stage(source), /symbolic link: content\/images\/link/);
  });

  test('a symbolic link in an archive', () => {
    const source = bundleDir(fixture('mysql-dump'));
    symlinkSync('../../../outside', join(source, 'content', 'themes', 'escape'));
    const archive = join(dir, 'symlink.tgz');
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    refused(stage(archive), /symbolic link/);
  });

  test('a hard link in an archive', () => {
    const source = bundleDir(fixture('mysql-dump'));
    linkSync(join(source, 'database.sql'), join(source, 'content', 'images', 'hardlink'));
    const archive = join(dir, 'hardlink.tgz');
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    refused(stage(archive), /hard link/);
  });

  test('an absolute path', () => {
    const archive = tarball('absolute.tgz', [manifestEntry(), tarEntry('/tmp/ghost-docker-escape', { data: Buffer.from('x') })]);
    refused(stage(archive), /absolute/);
    assert.ok(!existsSync('/tmp/ghost-docker-escape'));
  });

  test('a path with a .. component', () => {
    const archive = tarball('dotdot.tgz', [manifestEntry(), tarEntry('content/../../escape', { data: Buffer.from('x') })]);
    refused(stage(archive), /leaves the bundle/);
    assert.ok(!existsSync(join(dir, 'escape')));
  });

  test('a device node', () => {
    const archive = tarball('device.tgz', [manifestEntry(), tarEntry('content/null', { type: '3' })]);
    refused(stage(archive), /character device/);
  });

  test('the same file twice, which would overwrite the first', () => {
    const archive = tarball('duplicate.tgz', [
      manifestEntry(),
      tarEntry('database.sql', { data: Buffer.from('first') }),
      tarEntry('database.sql', { data: Buffer.from('second') }),
    ]);
    refused(stage(archive), /more than once/);
  });

  test('a file where an earlier entry needs a directory', () => {
    const archive = tarball('through-file.tgz', [
      manifestEntry(),
      tarEntry('content', { data: Buffer.from('a file') }),
      tarEntry('content/images/x', { data: Buffer.from('x') }),
    ]);
    refused(stage(archive), /passes through a file/);
  });
});

describe('archives that are not bundles', () => {
  test('a truncated archive', () => {
    const source = bundleDir(fixture('mysql-dump'));
    const archive = join(dir, 'whole.tgz');
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    const bytes = readFileSync(archive);
    const cut = join(dir, 'cut.tgz');
    writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
    refused(stage(cut), /corrupt or truncated|truncated/);
  });

  test('a zip names the two ways forward', () => {
    const zip = join(dir, 'bundle.zip');
    writeFileSync(zip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
    refused(stage(zip), /zip bundles are not read directly.*--archive tgz/s);
  });

  test('a file that is no archive at all', () => {
    const file = join(dir, 'notes.txt');
    writeFileSync(file, 'not a bundle\n'.repeat(100));
    refused(stage(file), /neither a directory nor a tar archive/);
  });

  test('gzip of something that is not tar', () => {
    const file = join(dir, 'notes.tgz');
    writeFileSync(file, gzipSync(Buffer.from('not a tar archive\n'.repeat(100))));
    refused(stage(file), /corrupt, or is not a tar archive/);
  });

  test('a path that does not exist', () => {
    refused(stage(join(dir, 'missing.tgz')), /there is no bundle at/);
  });

  test('a directory with no manifest', () => {
    const source = join(dir, 'empty');
    mkdirSync(join(source, 'content'), { recursive: true });
    refused(stage(source), /no manifest\.json/);
  });

  test('a bundle larger than the space it may use', () => {
    const source = bundleDir(fixture('mysql-dump'));
    writeFileSync(join(source, 'content', 'images', 'big.bin'), Buffer.alloc(64 * 1024));
    const archive = join(dir, 'big.tgz');
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    // Highly compressible: the archive is tiny, the expansion is not.
    refused(stage(archive, { GD_IMPORT_MAX_BYTES: '4096' }), /does not fit in the free space/);
    refused(stage(source, { GD_IMPORT_MAX_BYTES: '4096' }), /does not fit in the free space/);
  });

  test('more entries than the limit', () => {
    refused(stage(bundleDir(fixture('mysql-dump')), { GD_IMPORT_MAX_ENTRIES: '3' }), /more than 3 entries/);
  });
});

describe('manifests that do not meet the contract', () => {
  const cases = [
    ['a later bundle version', (m) => { m.bundleVersion = 2; }, /not a version 1 bundle/],
    ['no bundleCreatedAt', (m) => { delete m.bundleCreatedAt; }, /bundleCreatedAt/],
    ['a bundleCreatedAt that is not UTC', (m) => { m.bundleCreatedAt = '2026-09-14T12:00:00+02:00'; }, /bundleCreatedAt/],
    ['no sourceInstallType', (m) => { delete m.sourceInstallType; }, /sourceInstallType must be/],
    ['an unknown sourceInstallType', (m) => { m.sourceInstallType = 'staging'; }, /sourceInstallType must be/],
    ['an unknown kind', (m) => { m.kind = 'sqlite'; }, /kind must be one of/],
    ['a Ghost 5 source', (m) => { m.ghost.version = '5.130.2'; }, /only Ghost 6\.x can be imported.*ghost update/s],
    ['a version range instead of a version', (m) => { m.ghost.version = '6'; }, /no exact ghost\.version/],
    ['the draft ghostVersion alias', (m) => { m.ghostVersion = '6.2.0'; }, /draft field ghostVersion/],
    ['the draft sourceEnvironment alias', (m) => { m.sourceEnvironment = 'development'; }, /draft field sourceEnvironment/],
    ['the draft database.kind alias', (m) => { m.database.kind = 'mysql'; }, /draft field database\.kind/],
    ['a url that is not http', (m) => { m.url = 'file:///etc/passwd'; }, /not an http\(s\) URL/],
    ['no content root', (m) => { m.content = 'somewhere/'; }, /content must be "content\/"/],
    ['a database path outside the bundle', (m) => { m.database.path = '../database.sql'; }, /database\.path must be "database\.sql"/],
    ['a database file that is not there', (m) => { m.database.path = 'database.sql'; m.missing = true; }, /not in the bundle/],
    ['mysql-data without row counts', (m) => { delete m.database.rows; }, /database\.rows is required/],
    ['mysql-data with empty row counts', (m) => { m.database.rows = {}; }, /database\.rows is required/],
    ['a row count that is not a number', (m) => { m.database.rows.posts = '3'; }, /rows\.posts is not a row count/],
    ['a negative row count', (m) => { m.database.rows.posts = -1; }, /rows\.posts is not a row count/],
    ['a table name that is SQL', (m) => { m.database.rows['posts`; DROP TABLE users; --'] = 1; }, /invalid table/],
    ['a config value that is not a string', (m) => { m.config.server__port = 2368; }, /config\.server__port is not a string/],
    ['config that is not an object', (m) => { m.config = []; }, /no config object/],
  ];

  for (const [name, mutate, pattern] of cases) {
    test(name, () => {
      const manifest = fixture('mysql-data');
      mutate(manifest);
      const missing = manifest.missing;
      delete manifest.missing;
      const source = bundleDir(missing ? { ...manifest, database: {} } : manifest);
      if (missing) writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest));
      refused(stage(source), pattern);
    });
  }

  test('a portable members path that escapes the bundle', () => {
    const manifest = fixture('portable');
    manifest.database.members = '../../etc/passwd';
    refused(stage(bundleDir(manifest)), /leaves the bundle/);
  });

  test('a manifest that is not JSON', () => {
    const source = bundleDir(fixture('mysql-dump'));
    writeFileSync(join(source, 'manifest.json'), '{ not json');
    refused(stage(source), /not valid JSON/);
  });

  test('a manifest that is a symbolic link', () => {
    const source = bundleDir(fixture('mysql-dump'));
    execFileSync('rm', [join(source, 'manifest.json')]);
    symlinkSync('/etc/hostname', join(source, 'manifest.json'));
    refused(stage(source), /symbolic link/);
  });
});
