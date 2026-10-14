// The file-drop protocol's messages and file rules (docs/upgrade-supervisor.md),
// against the fixtures Ghost's adapter tests share.
import assert from 'node:assert/strict';
import {
    linkSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
    BOUNDS,
    createExchangeFile,
    ExchangeFileError,
    jobFileSchema,
    jobIdOf,
    JOB_ID_NAMESPACE,
    parseExchangeFile,
    publishExchangeFile,
    randomIdempotencyKey,
    readExchangeFile,
    requestFileSchema,
    statusFileSchema,
    uuidv5,
} from '../src/supervisor/protocol.ts';
import { REPO } from './site.ts';

const FIXTURES = join(REPO, 'manager', 'test', 'fixtures', 'upgrade-supervisor');

const schemaFor = (name: string) =>
    name.startsWith('request')
        ? requestFileSchema
        : name.startsWith('job')
          ? jobFileSchema
          : statusFileSchema;

describe('protocol fixtures', () => {
    for (const name of readdirSync(join(FIXTURES, 'valid'))) {
        test(`valid/${name} parses`, () => {
            const value = JSON.parse(readFileSync(join(FIXTURES, 'valid', name), 'utf8'));
            assert.equal(schemaFor(name).safeParse(value).success, true);
        });
    }
    for (const name of readdirSync(join(FIXTURES, 'invalid'))) {
        test(`invalid/${name} is refused`, () => {
            const value = JSON.parse(readFileSync(join(FIXTURES, 'invalid', name), 'utf8'));
            assert.equal(schemaFor(name).safeParse(value).success, false);
        });
    }
});

describe('job IDs', () => {
    test('the namespace is the UUIDv5 of the protocol URL', () => {
        assert.equal(
            uuidv5(
                '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
                'https://github.com/TryGhost/ghost-docker/blob/next-docker/docs/upgrade-supervisor.md#job-ids',
            ),
            JOB_ID_NAMESPACE,
        );
    });

    test('match the documented test vector', () => {
        assert.equal(jobIdOf('0'.repeat(64)), '96525598-8933-5537-8f86-a9f36f13b60e');
    });

    test('are the same for the same key and differ for another', () => {
        const key = randomIdempotencyKey();
        assert.match(key, /^[0-9a-f]{64}$/);
        assert.equal(jobIdOf(key), jobIdOf(key));
        assert.notEqual(jobIdOf(key), jobIdOf(randomIdempotencyKey()));
    });
});

describe('exchange files', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'gd-exchange-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test('a missing file reads as undefined', () => {
        assert.equal(readExchangeFile(join(dir, 'absent.json'), BOUNDS.request), undefined);
    });

    test('a symbolic link is refused, not followed', () => {
        writeFileSync(join(dir, 'target.json'), '{}');
        symlinkSync(join(dir, 'target.json'), join(dir, 'link.json'));
        assert.throws(() => readExchangeFile(join(dir, 'link.json'), BOUNDS.request), {
            message: /symbolic link/,
        });
    });

    test('a hard link is refused', () => {
        writeFileSync(join(dir, 'target.json'), '{}');
        linkSync(join(dir, 'target.json'), join(dir, 'hard.json'));
        assert.throws(() => readExchangeFile(join(dir, 'hard.json'), BOUNDS.request), {
            message: /2 links/,
        });
    });

    test('a file over its bound is refused', () => {
        writeFileSync(join(dir, 'big.json'), 'x'.repeat(BOUNDS.request + 1));
        assert.throws(
            () => readExchangeFile(join(dir, 'big.json'), BOUNDS.request),
            ExchangeFileError,
        );
    });

    test('a directory is refused', () => {
        assert.throws(() => readExchangeFile(dir, BOUNDS.request), ExchangeFileError);
    });

    test('a malformed file says why', () => {
        writeFileSync(join(dir, 'bad.json'), '{"protocol":1}');
        const read = readExchangeFile(join(dir, 'bad.json'), BOUNDS.request)!;
        assert.throws(() => parseExchangeFile(requestFileSchema, read, 'bad.json'), {
            message: /does not match protocol 1: request/,
        });
    });

    test('publishing replaces a file, readable by Ghost, leaving no temporary', () => {
        publishExchangeFile(dir, 'status.json', { a: 1 }, BOUNDS.status);
        publishExchangeFile(dir, 'status.json', { a: 2 }, BOUNDS.status);
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')), { a: 2 });
        assert.equal(statSync(join(dir, 'status.json')).mode & 0o777, 0o644);
        assert.deepEqual(readdirSync(dir), ['status.json']);
    });

    test('publishing refuses what would exceed the bound', () => {
        assert.throws(
            () => publishExchangeFile(dir, 'job.json', 'x'.repeat(BOUNDS.job), BOUNDS.job),
            ExchangeFileError,
        );
        assert.deepEqual(readdirSync(dir), []);
    });

    test('creating never replaces an existing request', () => {
        assert.equal(createExchangeFile(dir, 'r.json', { first: true }, BOUNDS.request), true);
        assert.equal(createExchangeFile(dir, 'r.json', { first: false }, BOUNDS.request), false);
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')), { first: true });
        assert.deepEqual(readdirSync(dir), ['r.json']);
        const read = readExchangeFile(join(dir, 'r.json'), BOUNDS.request);
        assert.ok(read);
    });
});
