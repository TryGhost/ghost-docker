// What the manager leaves to the image's own Compose, against that Compose.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ALL_PROFILES, compose, composeConfig, composeVersion } from '../../src/compose.ts';
import { siteOverrides } from '../../src/backup.ts';
import { resolveConfig } from '../../src/resolved.ts';
import { operatorKeyTest } from '../../src/config.ts';
import * as env from '../../src/env.ts';
import { atLeast, MINIMUM } from '../../src/versions.ts';
import { DOTENV, keyOf } from '../dotenv.ts';
import { makeSite, NO_HOST_PORTS, realIo } from './site.ts';

const io = realIo();

test("the image's Compose is at least the minimum the stack needs", async () => {
    const version = await composeVersion(io);
    assert.ok(version !== null, 'docker-compose did not run');
    assert.ok(atLeast(version, MINIMUM.compose), `${version} < ${MINIMUM.compose}`);
});

test("hand-written .env values read as Compose's own parser reads them", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-dotenv-'));
    try {
        const text = `${DOTENV.map(([line]) => line).join('\n')}\n`;
        writeFileSync(join(dir, '.env'), text);
        // Each key handed to a service, so `config` prints the value Compose read.
        const environment = Object.fromEntries(
            DOTENV.map(([line]) => [keyOf(line), `\${${keyOf(line)}}`]),
        );
        writeFileSync(
            join(dir, 'compose.yml'),
            JSON.stringify({ services: { reader: { image: 'alpine', environment } } }),
        );
        const resolved = await composeConfig(io, dir);
        assert.ok(resolved.ok, resolved.ok ? '' : resolved.reason);
        const read = resolved.project.services.reader!.environment!;
        for (const [line, value] of DOTENV) {
            const key = keyOf(line);
            assert.equal(read[key], value, `Compose reads ${line} differently from test/dotenv.ts`);
            assert.equal(
                env.get(text, key),
                value,
                `env.ts reads ${line} differently from Compose`,
            );
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('values the encoder writes reach a service as written, from ghost.env and interpolated from .env', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-encoded-'));
    try {
        // Each value dotenv encoding gets wrong when it is naive.
        const values = [
            'plain',
            'with spaces  ',
            'dollar $VAR',
            'braced ${VAR}',
            'double dollar $$',
            'lone dollar $',
            'double"quote',
            "single'quote",
            'back\\slash',
            "backslash quote \\'",
            '',
            '["a", "b", 1]',
            '{"k": "v", "n": [1, 2]}',
            'hash # not a comment',
            'line1\nline2',
            'tab\there',
            'trailing backslash \\',
        ];
        // ghost.env is the service's env_file; .env is interpolated into its environment.
        const ghostEnv = values.map((value, i): [string, string] => [`G_${i}`, value]);
        const dotEnv = values.map((value, i): [string, string] => [`E_${i}`, value]);
        writeFileSync(join(dir, 'ghost.env'), env.serializeAll(ghostEnv));
        writeFileSync(join(dir, '.env'), env.serializeAll(dotEnv));
        writeFileSync(
            join(dir, 'compose.yml'),
            JSON.stringify({
                services: {
                    reader: {
                        image: 'alpine',
                        env_file: ['ghost.env'],
                        environment: Object.fromEntries(dotEnv.map(([key]) => [key, `\${${key}}`])),
                    },
                },
            }),
        );
        const resolved = await composeConfig(io, dir);
        assert.ok(resolved.ok, resolved.ok ? '' : resolved.reason);
        const read = resolved.project.services.reader!.environment!;
        for (const [key, value] of [...ghostEnv, ...dotEnv]) {
            assert.equal(
                read[key],
                value,
                `${key} reached the service as ${JSON.stringify(read[key])}`,
            );
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the keys that belong in .env are what Compose interpolates, overrides included', async () => {
    const site = makeSite(io, 'variables', {
        profiles: 'local',
        override: `${NO_HOST_PORTS}  db:\n    labels:\n      operator.only.in.override: \${OVERRIDE_ONLY_SETTING:-x}\n`,
    });
    const isOperatorKey = await operatorKeyTest(io, site.dir);
    for (const key of ['URL', 'DATABASE_PASSWORD', 'RESTART_POLICY', 'OVERRIDE_ONLY_SETTING']) {
        assert.ok(isOperatorKey(key), key);
    }
    // Compose reports the merged project: the override resets Ghost's ports,
    // so GHOST_PORT is not among them. .env.example and .env, which this site
    // lacks and a real one has, still place it.
    assert.ok(!isOperatorKey('GHOST_PORT'));
    // `$$MYSQL_USER` is a literal for the container's shell, not interpolation.
    assert.ok(!isOperatorKey('MYSQL_USER'));
    assert.ok(!isOperatorKey('mail__transport'));
});

test('every profile is `*` to Compose, so undo finds whatever a failed install started', async () => {
    const site = makeSite(io, 'profiles', { profiles: 'local' });
    const listed = await compose(io, { dir: site.dir, profiles: ALL_PROFILES })`config --services`;
    assert.equal(listed.exitCode, 0, listed.stderr);
    const services = listed.stdout.trim().split('\n').sort();
    for (const service of ['activitypub', 'caddy', 'db', 'ghost', 'mailpit', 'traffic-analytics']) {
        assert.ok(services.includes(service), `${service} not in ${services.join(', ')}`);
    }
});

for (const rootOverride of [false, true]) {
    for (const absolute of [false, true]) {
        test(`a nested compose.override.yml COMPOSE_FILE names is effective and inventoried (root ${rootOverride}, absolute ${absolute})`, async () => {
            const dir = mkdtempSync(join(tmpdir(), 'gd-overrides-'));
            try {
                mkdirSync(join(dir, 'overrides'));
                const file = 'overrides/compose.override.yml';
                const named = [
                    'compose.yml',
                    ...(rootOverride ? ['compose.override.yml'] : []),
                    absolute ? join(dir, file) : file,
                ];
                writeFileSync(
                    join(dir, '.env'),
                    `COMPOSE_PROJECT_NAME=gd-overrides\nCOMPOSE_FILE=${named.join(':')}\n`,
                );
                writeFileSync(
                    join(dir, 'compose.yml'),
                    'services:\n  reader:\n    image: alpine:base\n',
                );
                if (rootOverride) {
                    writeFileSync(
                        join(dir, 'compose.override.yml'),
                        'services:\n  reader:\n    image: alpine:root\n',
                    );
                }
                writeFileSync(join(dir, file), 'services:\n  reader:\n    image: alpine:nested\n');
                const site = await resolveConfig(io, dir);
                assert.equal(site.services.reader?.image, 'alpine:nested');
                assert.deepEqual(siteOverrides(site), [file]);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    }
}
