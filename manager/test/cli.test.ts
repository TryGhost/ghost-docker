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

    test('a command prints its own help, with its flags', async () => {
        for (const flag of ['--help', '-h']) {
            const result = await h.run('doctor', flag);
            assert.equal(result.code, 0);
            assert.match(result.stdout, /ghost-docker doctor \(--json\) \(--keep-probe\)/);
            assert.match(result.stdout, /--keep-probe +Leave the probe file/);
        }
    });

    test('an unknown option, an option value or a stray argument is a usage error', async () => {
        for (const argv of [
            ['doctor', '--bogus'],
            ['doctor', '--json=yes'],
            ['doctor', 'extra'],
            // `--` ends the options: what follows is an argument, not --json.
            ['doctor', '--', '--json'],
        ]) {
            const result = await h.run(...argv);
            assert.equal(result.code, 2, argv.join(' '));
            assert.match(result.stderr, /^error: /);
            assert.match(result.stderr, /ghost-docker doctor --help/);
            assert.equal(result.stdout, '');
        }
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
