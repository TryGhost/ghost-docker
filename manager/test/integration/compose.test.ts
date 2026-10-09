// What the manager leaves to the image's own Compose, against that Compose.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_PROFILES, compose, composeVersion } from '../../src/compose.ts';
import { operatorKeyTest } from '../../src/config.ts';
import { atLeast, MINIMUM } from '../../src/versions.ts';
import { makeSite, NO_HOST_PORTS, realIo } from './site.ts';

const io = realIo();

test("the image's Compose is at least the minimum the stack needs", async () => {
    const version = await composeVersion(io);
    assert.ok(version !== null, 'docker-compose did not run');
    assert.ok(atLeast(version, MINIMUM.compose), `${version} < ${MINIMUM.compose}`);
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
