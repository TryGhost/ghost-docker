// The protocol's bodies (docs/upgrade-supervisor.md), against the fixtures
// Ghost's adapter tests share.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { z } from 'zod';
import {
    createUpgradeRequestSchema,
    errorBodySchema,
    handshakeSchema,
    jobIdOf,
    randomIdempotencyKey,
    supervisorStatusSchema,
    upgradeJobIdSchema,
    upgradeJobResultSchema,
    upgradeJobSchema,
    upgradeStatusSchema,
} from '../src/supervisor/protocol.ts';
import { REPO } from './site.ts';

const FIXTURES = join(REPO, 'manager', 'test', 'fixtures', 'upgrade-supervisor');

const SCHEMAS: Record<string, z.ZodType> = {
    request: createUpgradeRequestSchema,
    status: upgradeStatusSchema,
    job: upgradeJobSchema,
    lookup: upgradeJobResultSchema,
    handshake: handshakeSchema,
    error: errorBodySchema,
};

const schemaFor = (name: string): z.ZodType => {
    const schema = SCHEMAS[name.split(/[-.]/)[0]!];
    assert.ok(schema, `${name} names no body`);
    return schema;
};

const fixture = (kind: string, name: string): unknown =>
    JSON.parse(readFileSync(join(FIXTURES, kind, name), 'utf8'));

describe('protocol fixtures', () => {
    for (const name of readdirSync(join(FIXTURES, 'valid'))) {
        test(`valid/${name} parses`, () => {
            const result = schemaFor(name).safeParse(fixture('valid', name));
            assert.equal(result.success, true, JSON.stringify(result.error?.issues));
        });
    }
    for (const name of readdirSync(join(FIXTURES, 'invalid'))) {
        test(`invalid/${name} is refused`, () => {
            assert.equal(schemaFor(name).safeParse(fixture('invalid', name)).success, false);
        });
    }

    test('the ready status is one the supervisor reports, not only one Ghost reads', () => {
        assert.equal(
            supervisorStatusSchema.safeParse(fixture('valid', 'status-ready.json')).success,
            true,
        );
    });

    test('the job fixtures are the jobs of the request fixture', () => {
        const { idempotencyKey } = fixture('valid', 'request.json') as { idempotencyKey: string };
        for (const name of ['job-done.json', 'job-interrupted.json', 'lookup-expired.json']) {
            assert.equal((fixture('valid', name) as { id: string }).id, jobIdOf(idempotencyKey));
        }
    });
});

describe('job IDs', () => {
    test('are the idempotency key itself, a valid job ID', () => {
        const key = randomIdempotencyKey();
        assert.match(key, /^[0-9a-f]{64}$/);
        assert.equal(jobIdOf(key), key);
        assert.equal(upgradeJobIdSchema.safeParse(key).success, true);
    });

    test('refuse anything that could leave a path', () => {
        for (const id of ['../status', 'a/b', 'A', '', 'x'.repeat(65)]) {
            assert.equal(upgradeJobIdSchema.safeParse(id).success, false, id);
        }
    });
});
