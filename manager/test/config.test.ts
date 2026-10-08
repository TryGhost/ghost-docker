// config validate, and config get|set.
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { composeEnvironment } from '../src/compose.ts';
import { operatorVariables } from '../src/config.ts';
import { harness, type Harness } from './helpers.ts';
import { LOCAL, makeSite, PRODUCTION, REPO } from './site.ts';

let h: Harness;
beforeEach(() => {
    h = harness();
});
afterEach(() => h.cleanup());

const validate = async () => {
    const result = await h.run('config', 'validate');
    return { ...result, errors: result.stderr };
};

describe('.env', () => {
    test('a complete production site validates', async () => {
        makeSite(h, PRODUCTION);
        const result = await validate();
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /valid for a production site/);
    });

    test('a local site may use http', async () => {
        makeSite(h, LOCAL);
        assert.equal((await validate()).code, 0);
    });

    test('exactly one site mode is required', async () => {
        for (const profiles of ['analytics', 'local,production', '']) {
            makeSite(h, { ...LOCAL, COMPOSE_PROFILES: profiles });
            const result = await validate();
            assert.equal(result.code, 1, profiles);
            assert.match(result.errors, /exactly one site mode/);
        }
    });

    test('unknown profiles are reported; the reserved one is not', async () => {
        makeSite(h, { ...LOCAL, COMPOSE_PROFILES: 'local,frobnicate,supervisor' });
        const result = await validate();
        assert.match(result.errors, /unknown profile\(s\) in COMPOSE_PROFILES: frobnicate \(/);
        assert.doesNotMatch(result.errors, /: supervisor/);
    });

    test('Mailpit is for local sites only', async () => {
        makeSite(h, { ...LOCAL, COMPOSE_PROFILES: 'local,mailpit' });
        assert.equal((await validate()).code, 0);
        makeSite(h, { ...PRODUCTION, COMPOSE_PROFILES: 'production,mailpit' });
        const result = await validate();
        assert.equal(result.code, 1);
        assert.match(result.errors, /selects mailpit, which is for local sites only/);
    });

    test('SITE_MODE must match COMPOSE_PROFILES', async () => {
        makeSite(h, { ...LOCAL, SITE_MODE: 'production' });
        assert.match((await validate()).errors, /SITE_MODE=production does not match .* \(local\)/);
    });

    test('required keys are by mode, and an empty one is reported as empty', async () => {
        makeSite(h, { ...PRODUCTION, URL: undefined });
        assert.match((await validate()).errors, /URL is required for mode production/);
        makeSite(h, { ...LOCAL, GHOST_VERSION: '' });
        assert.match((await validate()).errors, /GHOST_VERSION is empty/);
    });

    test('a production URL is https, and its host is the domain', async () => {
        makeSite(h, { ...PRODUCTION, URL: 'http://example.com' });
        assert.match((await validate()).errors, /URL must be https:\/\/, with a domain/);
        makeSite(h, { ...PRODUCTION, ADMIN_URL: 'admin.example.com' });
        assert.match((await validate()).errors, /ADMIN_URL must be https:\/\/, with a domain/);
        makeSite(h, { ...PRODUCTION, URL: 'https://example.com/blog' });
        assert.equal((await validate()).code, 0);
    });

    test('an ActivityPub database that is never created is rejected', async () => {
        makeSite(h, { ...LOCAL, ACTIVITYPUB_DATABASE_NAME: 'fediverse' });
        assert.match(
            (await validate()).errors,
            /fediverse is not listed in DATABASE_EXTRA_DATABASES/,
        );
        // mysql-init splits on spaces as well as commas.
        makeSite(h, {
            ...LOCAL,
            ACTIVITYPUB_DATABASE_NAME: 'fediverse',
            DATABASE_EXTRA_DATABASES: 'activitypub, fediverse',
        });
        assert.equal((await validate()).code, 0);
    });

    test('a value Compose would interpolate is an error naming the key', async () => {
        makeSite(h, LOCAL);
        writeFileSync(
            join(h.dir, '.env'),
            `${readFileSync(join(h.dir, '.env'), 'utf8')}TINYBIRD_ADMIN_TOKEN="s3cr$t"\n`,
        );
        assert.match(
            (await validate()).errors,
            /TINYBIRD_ADMIN_TOKEN: the value is interpolated by Compose/,
        );
    });

    test('a file anyone can read is a warning, not an error', async () => {
        makeSite(h, LOCAL);
        chmodSync(join(h.dir, '.env'), 0o644);
        const result = await validate();
        assert.equal(result.code, 0);
        assert.match(result.errors, /warning .*mode is 0644; it holds credentials/);
    });

    test('Compose guards URL itself, so validation does not list it twice', async () => {
        makeSite(h, { ...LOCAL, URL: undefined });
        const result = await validate();
        assert.doesNotMatch(result.errors, /\.env +URL is required/);
    });
});

describe('ghost.env', () => {
    test('application settings are accepted', async () => {
        makeSite(h, LOCAL, { mail__transport: 'SMTP', mail__options__auth__pass: 'Pa$$w0rd!' });
        assert.equal((await validate()).code, 0);
    });

    for (const key of [
        'url',
        'server__port',
        'database__connection__password',
        'paths__contentPath',
        'NODE_ENV',
    ]) {
        test(`the container-owned key ${key} is rejected, with the value the container uses`, async () => {
            makeSite(h, LOCAL, { [key]: 'mine' });
            const result = await validate();
            assert.equal(result.code, 1);
            assert.match(
                result.errors,
                new RegExp(`${key} is set by the container \\(.*\\) and is ignored in ghost.env`),
            );
        });
    }

    for (const key of [
        'COMPOSE_PROJECT_NAME',
        'DATABASE_ROOT_PASSWORD',
        'GHOST_PORT',
        'ADMIN_URL',
    ]) {
        test(`the operator setting ${key} is rejected`, async () => {
            makeSite(h, LOCAL, { [key]: 'x' });
            assert.match(
                (await validate()).errors,
                new RegExp(`${key} is an operator setting and belongs in .env`),
            );
        });
    }

    test('a key added to compose.yml is caught with no list to update', async () => {
        makeSite(h, LOCAL, { NEW_SETTING: 'x' });
        const compose = join(h.dir, 'compose.yml');
        writeFileSync(
            compose,
            readFileSync(compose, 'utf8').replace(
                '  ghost:\n',
                '  ghost:\n    x-new: ${NEW_SETTING:-}\n',
            ),
        );
        assert.match((await validate()).errors, /NEW_SETTING is an operator setting/);
    });

    test('when Compose cannot resolve the project, the check is skipped with a warning', async () => {
        makeSite(h, { ...LOCAL, DATABASE_PASSWORD: undefined }, { url: 'mine' });
        assert.match(
            (await validate()).errors,
            /could not be resolved, so container-owned keys were not checked/,
        );
    });

    test('ghost.env is optional', async () => {
        makeSite(h, LOCAL);
        assert.equal((await validate()).code, 0);
    });
});

test('the operator variables are read from compose.yml itself', () => {
    const variables = operatorVariables(readFileSync(join(REPO, 'compose.yml'), 'utf8'));
    for (const key of [
        'URL',
        'DATABASE_PASSWORD',
        'GHOST_PORT',
        'COMPOSE_PROJECT_NAME',
        'RESTART_POLICY',
    ]) {
        assert.ok(variables.has(key), key);
    }
    // `$$MYSQL_USER` is a literal for the container's shell, not interpolation.
    assert.ok(!variables.has('MYSQL_USER'));
});

describe('get, set and unset', () => {
    beforeEach(() => makeSite(h, LOCAL, { mail__from: 'old' }));

    test('set encodes the value, logs only the key, and get reads it back', async () => {
        const set = await h.run(
            'config',
            'set',
            'ghost.env',
            'mail__options__auth__pass',
            'Pa$$w0rd!',
        );
        assert.equal(set.code, 0, set.stderr);
        assert.match(set.stderr, /updated mail__options__auth__pass in ghost.env/);
        assert.doesNotMatch(set.stderr + set.stdout, /w0rd/);
        assert.match(
            readFileSync(join(h.dir, 'ghost.env'), 'utf8'),
            /mail__options__auth__pass="Pa\$\$\$\$w0rd!"/,
        );
        assert.equal(
            (await h.run('config', 'get', 'ghost.env', 'mail__options__auth__pass')).stdout,
            'Pa$$w0rd!\n',
        );
    });

    test('without a file, the key says which file it belongs in', async () => {
        await h.run('config', 'set', 'ADMIN_URL', 'https://admin.example.com');
        await h.run('config', 'set', 'mail__transport', 'SMTP');
        assert.match(
            readFileSync(join(h.dir, '.env'), 'utf8'),
            /ADMIN_URL="https:\/\/admin.example.com"/,
        );
        assert.match(readFileSync(join(h.dir, 'ghost.env'), 'utf8'), /mail__transport="SMTP"/);
        assert.equal((await h.run('config', 'get', 'GHOST_PORT')).stdout, '2368\n');
    });

    test('an existing file keeps its mode; a new one is private', async () => {
        chmodSync(join(h.dir, 'ghost.env'), 0o640);
        await h.run('config', 'set', 'ghost.env', 'a', 'b');
        assert.equal(statSync(join(h.dir, 'ghost.env')).mode & 0o777, 0o640);
    });

    test('a value starting with a dash goes after --', async () => {
        const result = await h.run(
            'config',
            'set',
            'ghost.env',
            'key',
            '--',
            '-----BEGIN KEY-----\nabc',
        );
        assert.equal(result.code, 0, result.stderr);
        assert.equal(
            (await h.run('config', 'get', 'ghost.env', 'key')).stdout,
            '-----BEGIN KEY-----\nabc\n',
        );
    });

    test('only .env and ghost.env, and only valid keys', async () => {
        assert.equal((await h.run('config', 'set', 'compose.yml', 'A', 'b')).code, 2);
        assert.equal((await h.run('config', 'set', 'ghost.env', 'not-a-key', 'b')).code, 2);
        assert.equal((await h.run('config', 'get')).code, 2);
    });

    test('outside a site, it says there is none', async () => {
        const result = await harness().run('config', 'get', 'A');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /does not hold a site/);
    });
});

test('GD_COMPOSE_OVERRIDES adds -f files after compose.yml, relative to the site', async () => {
    // ghost.env is what makes validation ask Compose.
    makeSite(h, LOCAL, { mail__transport: 'SMTP' });
    h.env.GD_COMPOSE_OVERRIDES = 'compose.ipv6.yml,/abs/extra.yml';
    await h.run('config', 'validate');
    const call = h.calls.find((args) => args.includes('config') && args.includes('json'))!;
    const files = call.flatMap((arg, index) => (call[index - 1] === '-f' ? [arg] : []));
    assert.deepEqual(files, [
        join(h.dir, 'compose.yml'),
        join(h.dir, 'compose.ipv6.yml'),
        '/abs/extra.yml',
    ]);
});

test('the site’s compose.override.yml is used when it exists, before GD_COMPOSE_OVERRIDES, and once', async () => {
    makeSite(h, LOCAL, { mail__transport: 'SMTP' });
    writeFileSync(join(h.dir, 'compose.override.yml'), 'services: {}\n');
    h.env.GD_COMPOSE_OVERRIDES = 'compose.override.yml,compose.ipv6.yml';
    await h.run('config', 'validate');
    const call = h.calls.find((args) => args.includes('config') && args.includes('json'))!;
    const files = call.flatMap((arg, index) => (call[index - 1] === '-f' ? [arg] : []));
    assert.deepEqual(files, [
        join(h.dir, 'compose.yml'),
        join(h.dir, 'compose.override.yml'),
        join(h.dir, 'compose.ipv6.yml'),
    ]);
});

test('Compose gets only what it needs of the manager’s environment, so .env is what it interpolates', () => {
    const environment = composeEnvironment(
        {
            env: {
                PATH: '/usr/bin',
                HOME: '/home/node',
                NODE_ENV: 'production',
                COMPOSE_FILE: 'other.yml',
                URL: 'http://elsewhere',
                GD_SITE_DIR: '/site',
            },
        },
        { COMPOSE_PROFILES: 'local' },
    );
    assert.deepEqual(environment, {
        PATH: '/usr/bin',
        HOME: '/home/node',
        COMPOSE_PROFILES: 'local',
    });
});
