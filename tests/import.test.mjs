// Staging a migration bundle: what is accepted, and everything that is refused.
//
// import_stage unpacks a bundle into a site's private staging directory with
// the host's own tar and validates it. Nothing in this file needs Docker. The
// archives a well-behaved tar would never produce — absolute paths, `..` —
// are built byte by byte.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync, statSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tempDir, cleanup, sh, q, TESTS_DIR } from './helpers.mjs';

const FIXTURES = join(TESTS_DIR, 'fixtures', 'migration-bundle-v1');
const fixture = (kind) => JSON.parse(readFileSync(join(FIXTURES, `${kind}.json`), 'utf8'));

let dir;
let counter;
beforeEach(() => { dir = tempDir('import-stage'); counter = 0; });
afterEach(() => cleanup(dir));

/** Stage a bundle into a fresh site directory. */
function stage(bundle) {
  counter += 1;
  const site = join(dir, `site-${counter}`);
  mkdirSync(site);
  const result = sh(`import_stage ${q(site)} ${q(bundle)}`);
  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    staging: join(site, '.import'),
  };
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
  assert.ok(!existsSync(result.staging), 'left a staging directory behind');
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

  const hasZip = spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0
    && spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;
  test('a zip archive is read where unzip is installed', { skip: hasZip ? false : 'needs zip and unzip' }, () => {
    const source = bundleDir(fixture('mysql-data'));
    const archive = join(dir, 'bundle.zip');
    execFileSync('zip', ['-qr', archive, '.'], { cwd: source });
    const result = stage(archive);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(result.staging, 'bundle', 'database.sql'), 'utf8'), 'data\n');
  });

  test('staged content is readable like a fresh install, the dump stays private', () => {
    const source = bundleDir(fixture('mysql-data'));
    execFileSync('chmod', ['-R', 'go-rwx', source]);
    const archive = join(dir, 'private.tgz');
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    const result = stage(archive);
    assert.equal(result.status, 0, result.stderr);
    const mode = (path) => statSync(join(result.staging, path)).mode & 0o777;
    assert.equal(mode('bundle/content/themes/source/package.json') & 0o044, 0o044);
    assert.equal(mode('.') & 0o077, 0, 'the staging directory is not private');
  });

  test('config values come through byte for byte', () => {
    const manifest = fixture('mysql-data');
    const result = stage(bundleDir(manifest));
    const staged = JSON.parse(readFileSync(join(result.staging, 'manifest.json'), 'utf8'));
    assert.equal(staged.config.mail__options__auth__pass, 'pa$$word \\" #\n');
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

  test('an absolute path', () => {
    const archive = tarball('absolute.tgz', [manifestEntry(), tarEntry('/tmp/ghost-docker-escape', { data: Buffer.from('x') })]);
    refused(stage(archive), /leaves the bundle/);
    assert.ok(!existsSync('/tmp/ghost-docker-escape'));
  });

  test('a path with a .. component', () => {
    const archive = tarball('dotdot.tgz', [manifestEntry(), tarEntry('content/../../escape', { data: Buffer.from('x') })]);
    refused(stage(archive), /leaves the bundle/);
    assert.ok(!existsSync(join(dir, 'escape')));
  });

  test('a device node', () => {
    // An unprivileged tar cannot create one and fails; a privileged one
    // creates it and the check for special files refuses it.
    const archive = tarball('device.tgz', [manifestEntry(), tarEntry('content/null', { type: '3' })]);
    refused(stage(archive), /special file|could not be extracted/);
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
    refused(stage(cut), /corrupt/);
  });

  test('a file that is no archive at all', () => {
    const file = join(dir, 'notes.txt');
    writeFileSync(file, 'not a bundle\n'.repeat(100));
    refused(stage(file), /not an archive made by `ghost migrate-export`/);
  });

  test('gzip of something that is not tar', () => {
    const file = join(dir, 'notes.tgz');
    writeFileSync(file, gzipSync(Buffer.from('not a tar archive\n'.repeat(100))));
    refused(stage(file), /not an archive made by|could not be extracted/);
  });

  test('a path that does not exist', () => {
    refused(stage(join(dir, 'missing.tgz')), /there is no bundle at/);
  });

  test('a directory with no manifest', () => {
    const source = join(dir, 'empty');
    mkdirSync(join(source, 'content'), { recursive: true });
    refused(stage(source), /no manifest\.json/);
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
    ['a url that is not http', (m) => { m.url = 'file:///etc/passwd'; }, /url is not an http\(s\) URL/],
    ['no content root', (m) => { m.content = 'somewhere/'; }, /content must be "content\/"/],
    ['a database path outside the bundle', (m) => { m.database.path = '../database.sql'; }, /database\.path must be "database\.sql"/],
    ['a database file that is not there', (m) => { m.database.path = 'database.sql'; m.missing = true; }, /not a file in the bundle/],
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
    refused(stage(bundleDir(manifest)), /database\.members is not a path inside the bundle/);
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
