// `.ghost-docker.json`: written valid or not at all, read only when understood.
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
    describeMetadata,
    metaPath,
    readMetadata,
    SCHEMA_VERSION,
    writeMetadata,
    type Metadata,
} from '../src/meta.ts';
import { harness, type Harness } from './helpers.ts';

let h: Harness;
beforeEach(() => {
    h = harness();
});
afterEach(() => h.cleanup());

const DIGEST = `sha256:${'a'.repeat(64)}`;

const sample = (dir: string): Metadata => ({
    schemaVersion: SCHEMA_VERSION,
    installedAt: '2026-10-06T09:12:44Z',
    mode: 'production',
    channel: 'beta',
    source: 'image',
    stack: {
        version: 'v1.0.0-beta.1',
        commit: 'f'.repeat(40),
        ref: 'v1.0.0-beta.1',
        image: `ghcr.io/tryghost/ghost-docker@${DIGEST}`,
    },
    site: {
        project: 'ghost-example-com',
        dir,
        url: 'https://example.com',
        domain: 'example.com',
        adminDomain: null,
    },
    ghost: { image: 'ghost', tag: '6-next-alpine', version: '6.67.0', digest: DIGEST },
    profiles: ['production'],
    payload: { 'compose.yml': 'b'.repeat(64) },
    migrations: [],
});

describe('installation metadata', () => {
    test('a site with no metadata is unknown, not broken', async () => {
        assert.deepEqual(readMetadata(h.dir), { state: 'absent' });
        assert.match(
            describeMetadata(readMetadata(h.dir))[0]!,
            /none \(installed before metadata was recorded\)/,
        );
        const info = await h.run('info');
        assert.equal(info.code, 0);
        assert.match(info.stdout, /installed before metadata was recorded/);
    });

    test('records the schema, identity, provenance and resolved image, privately', async () => {
        writeMetadata(h.dir, sample(h.dir));
        assert.equal(statSync(metaPath(h.dir)).mode & 0o777, 0o600);
        const read = readMetadata(h.dir);
        assert.equal(read.state, 'present');
        assert.deepEqual(read.state === 'present' && read.metadata, sample(h.dir));
        const info = await h.run('info');
        assert.match(info.stdout, /mode +production/);
        assert.match(info.stdout, new RegExp(`ghost image +ghost@${DIGEST}`));
    });

    test('the same document is written as the same bytes', () => {
        writeMetadata(h.dir, sample(h.dir));
        const first = readFileSync(metaPath(h.dir), 'utf8');
        writeMetadata(h.dir, { ...sample(h.dir) });
        assert.equal(readFileSync(metaPath(h.dir), 'utf8'), first);
    });

    test('a document that does not match the schema is never written over a good one', () => {
        writeMetadata(h.dir, sample(h.dir));
        const good = readFileSync(metaPath(h.dir), 'utf8');
        assert.throws(() =>
            writeMetadata(h.dir, {
                ...sample(h.dir),
                ghost: { ...sample(h.dir).ghost, digest: 'latest' },
            }),
        );
        assert.throws(() => writeMetadata(h.dir, { ...sample(h.dir), extra: true } as Metadata));
        assert.equal(readFileSync(metaPath(h.dir), 'utf8'), good);
    });

    test('a field nobody supplied is null, not an empty string', () => {
        assert.throws(() =>
            writeMetadata(h.dir, { ...sample(h.dir), site: { ...sample(h.dir).site, domain: '' } }),
        );
    });

    test('invalid JSON, a missing schemaVersion and a newer schema are refused, saying which', async () => {
        writeFileSync(metaPath(h.dir), '{ not json');
        assert.match(
            readMetadata(h.dir).state === 'invalid'
                ? (readMetadata(h.dir) as { reason: string }).reason
                : '',
            /not valid JSON/,
        );

        writeFileSync(metaPath(h.dir), JSON.stringify({ mode: 'local' }));
        assert.match((readMetadata(h.dir) as { reason: string }).reason, /has no schemaVersion/);

        writeFileSync(metaPath(h.dir), JSON.stringify({ ...sample(h.dir), schemaVersion: 2 }));
        assert.match(
            (readMetadata(h.dir) as { reason: string }).reason,
            /schema version 2; this manager understands version 1\. It was written by a newer ghost-docker/,
        );
        assert.equal((await h.run('info')).code, 1);
    });
});
