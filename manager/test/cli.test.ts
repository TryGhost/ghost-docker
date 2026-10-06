// The dispatcher: what each kind of command line exits with, and says.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { harness, type Harness } from './helpers.ts';

let h: Harness;
beforeEach(() => {
    h = harness();
});
afterEach(() => h.cleanup());

describe('exit statuses', () => {
    test('help prints the commands and exits 0, with or without the word', async () => {
        for (const argv of [[], ['help'], ['--help'], ['-h']]) {
            const result = await h.run(...argv);
            assert.equal(result.code, 0);
            assert.match(result.stdout, /USAGE/);
            assert.match(result.stdout, /doctor/);
            assert.equal(result.stderr, '');
        }
    });

    test('an unknown command is a usage error: exit 2, and the usage on stderr', async () => {
        const result = await h.run('frobnicate');
        assert.equal(result.code, 2);
        assert.match(result.stderr, /^error: unknown command: frobnicate/);
        assert.match(result.stderr, /--help/);
        assert.equal(result.stdout, '');
    });

    // A script written against the documented interface gets an answer it can
    // act on, and nothing advertises support that does not exist.
    const planned: [string, RegExp][] = [
        ['install', /N3/],
        ['config', /N3/],
        ['caddy', /N3/],
        ['check', /N3/],
        ['info', /N3/],
        ['list', /N3/],
        ['update', /S6a/],
        ['backup', /S4/],
        ['restore', /S4/],
        ['upgrade', /S7/],
    ];
    for (const [command, step] of planned) {
        test(`${command} exits 3 and names the step it lands in`, async () => {
            const result = await h.run(command, '--anything');
            assert.equal(result.code, 3);
            assert.match(
                result.stderr,
                new RegExp(`ghost-docker ${command} is not implemented yet`),
            );
            assert.match(result.stderr, step);
            assert.doesNotMatch(result.stderr, /USAGE/);
        });
    }

    test('a planned command is refused before the launcher contract is even checked', async () => {
        h.env = {};
        assert.equal((await h.run('install')).code, 3);
    });
});

describe('version', () => {
    test('reports dev when the image carries no version file', async () => {
        const result = await h.run('version');
        assert.equal(result.code, 0);
        assert.equal(result.stdout, 'ghost-docker dev\n');
    });

    test('reports the version and short commit baked into the image', async () => {
        const file = join(h.dir, 'VERSION.json');
        writeFileSync(
            file,
            JSON.stringify({ version: 'v1.2.3-beta.4', commit: '0123456789abcdef' }),
        );
        h.env.GD_VERSION_FILE = file;
        assert.equal((await h.run('version')).stdout, 'ghost-docker v1.2.3-beta.4 (0123456)\n');
        assert.equal((await h.run('--version')).code, 0);
    });

    test('takes no options', async () => {
        assert.equal((await h.run('version', '--json')).code, 2);
    });

    test('needs nothing from the launcher', async () => {
        h.env = { GD_VERSION_FILE: h.env.GD_VERSION_FILE };
        assert.equal((await h.run('version')).code, 0);
    });
});

describe('a manager started without the launcher', () => {
    test('says so, and how to start it properly', async () => {
        h.env = {};
        const result = await h.run('doctor');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /not started by the ghost-docker launcher/);
        assert.match(result.stderr, /GD_SITE_DIR/);
        assert.match(result.stderr, /\.\/ghost-docker/);
    });

    test('a relative site directory is refused', async () => {
        h.env.GD_SITE_DIR = 'relative/path';
        assert.match((await h.run('doctor')).stderr, /GD_SITE_DIR/);
    });

    test('an identity that is not a number is refused', async () => {
        h.env.GD_UID = 'root';
        assert.match((await h.run('doctor')).stderr, /GD_UID/);
    });
});
