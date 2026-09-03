// `.ghost-docker.json`: the installation metadata reader and writer.
//
// The schema is specified in section 2.2 of docs/ghost-cli-replacement.md.
// install.sh is its first writer, which is why it lands here rather than with
// the S1 helpers.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, cleanup, sh, shOk, shSucceeds, q } from './helpers.mjs';

let dir;
const file = () => join(dir, '.ghost-docker.json');
const read = () => JSON.parse(readFileSync(file(), 'utf8'));

const init = (extra = '') =>
  shOk(`meta_init ${q(dir)} mode=production channel=stable \\
    stack.version=v1.2.3 stack.commit=abc123 stack.ref=v1.2.3 \\
    site.project=ghost-example-com site.dir=${q(dir)} site.url=https://example.com \\
    site.domain=example.com \\
    ghost.image=ghost ghost.tag=6.62.0-next-alpine ghost.version=6.62.0 \\
    ghost.digest=sha256:deadbeef profiles=production,analytics ${extra}`);

describe('installation metadata', () => {
  beforeEach(() => {
    dir = tempDir('meta');
  });
  afterEach(() => cleanup(dir));

  test('a site with no metadata is unknown, not broken', () => {
    assert.ok(!shSucceeds(`meta_present ${q(dir)}`), 'reported present');
    // The pre-metadata case has to describe itself rather than fail: an
    // installation that predates the file is a supported state.
    const described = shOk(`meta_describe ${q(dir)}`);
    assert.match(described, /installed before metadata was recorded/);
    assert.ok(!shSucceeds(`meta_get ${q(dir)} .mode`), 'read a value from nothing');
    // And an absent file is not a schema error.
    assert.ok(shSucceeds(`meta_check_schema ${q(dir)}`), 'absent file failed the schema check');
  });

  test('records the schema, identity, provenance and resolved image', () => {
    init();
    const meta = read();
    assert.equal(meta.schemaVersion, 1);
    assert.equal(meta.mode, 'production');
    assert.equal(meta.channel, 'stable');
    assert.deepEqual(meta.stack, { version: 'v1.2.3', commit: 'abc123', ref: 'v1.2.3' });
    assert.equal(meta.site.project, 'ghost-example-com');
    assert.equal(meta.site.url, 'https://example.com');
    assert.equal(meta.ghost.tag, '6.62.0-next-alpine');
    assert.equal(meta.ghost.version, '6.62.0');
    assert.equal(meta.ghost.digest, 'sha256:deadbeef');
    assert.deepEqual(meta.profiles, ['production', 'analytics']);
    assert.deepEqual(meta.migrations, []);
    assert.match(meta.installedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Unsupplied fields are recorded as null rather than as an empty string, so
    // "not known" and "deliberately empty" stay distinguishable.
    assert.equal(meta.site.adminDomain, null);
  });

  test('the file is private: it names a site and its provenance', () => {
    init();
    assert.equal(statSync(file()).mode & 0o777, 0o600);
  });

  test('an unknown key is an error, not a field nothing reads', () => {
    const result = sh(`meta_init ${q(dir)} mode=local nonsense=1`);
    assert.equal(result.status, 2);
    assert.match(result.stderr.toString(), /unknown metadata key nonsense/);
  });

  test('migrations are recorded once and are queryable', () => {
    init();
    shOk(`meta_record_migration ${q(dir)} 0001-compose-profiles`);
    shOk(`meta_record_migration ${q(dir)} 0001-compose-profiles`);
    assert.deepEqual(read().migrations, ['0001-compose-profiles']);
    assert.ok(shSucceeds(`meta_has_migration ${q(dir)} 0001-compose-profiles`));
    assert.ok(!shSucceeds(`meta_has_migration ${q(dir)} 0002-nothing`));
  });

  test('invalid JSON is never installed over a good file', () => {
    init();
    const before = readFileSync(file(), 'utf8');
    const result = sh(`printf 'not json' | meta_write ${q(dir)}`);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(file(), 'utf8'), before);
  });

  test('a document without the schema version is refused', () => {
    const result = sh(`printf '{"mode":"local"}' | meta_write ${q(dir)}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /schemaVersion/);
  });

  test('a newer schema is refused rather than misread', () => {
    writeFileSync(file(), JSON.stringify({ schemaVersion: 99, mode: 'local' }));
    const result = sh(`meta_check_schema ${q(dir)}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /schema version 99.*understands version 1/s);
    // And an update refuses too, rather than rewriting it at the old schema.
    assert.notEqual(sh(`meta_record_migration ${q(dir)} x`).status, 0);
  });

  test('describes a recorded installation', () => {
    init();
    const described = shOk(`meta_describe ${q(dir)}`);
    assert.match(described, /mode: *production/);
    assert.match(described, /ghost: *6\.62\.0-next-alpine sha256:deadbeef/);
    assert.match(described, /profiles: *production,analytics/);
  });
});
