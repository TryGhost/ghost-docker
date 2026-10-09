// The dispatcher: what each kind of command line exits with, and says.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { z } from 'zod';
import { flagsOf } from '../src/command.ts';
import { failed, harness, ok, type Harness } from './helpers.ts';

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

    test('help spells each option of the schema in kebab-case, with a value when it takes one', async () => {
        const result = await h.run('install', '--help');
        assert.equal(result.code, 0);
        assert.match(result.stdout, /\(--admin-domain <value>\)/);
        assert.match(result.stdout, /\(--no-prompt\)/);
        assert.match(result.stdout, /--port <value> +The loopback port/);
    });

    test('asking for help anywhere on the line wins over what else is wrong with it', async () => {
        for (const argv of [
            ['help', 'doctor'],
            ['--help', 'doctor'],
            ['doctor', '--bogus', '--help'],
            ['doctor', 'extra', '-h'],
        ]) {
            const result = await h.run(...argv);
            assert.equal(result.code, 0, argv.join(' '));
            assert.match(result.stdout, /ghost-docker doctor \(--json\)/);
            assert.equal(result.stderr, '');
        }
    });

    test('help for a command that does not exist, or --help after --, is a usage error', async () => {
        assert.match((await h.run('help', 'frobnicate')).stderr, /unknown command: frobnicate/);
        assert.equal((await h.run('help', 'frobnicate')).code, 2);
        assert.equal((await h.run('doctor', '--', '--help')).code, 2);
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

    test('a two-word command: config alone names its subcommands, and has help', async () => {
        const bare = await h.run('config');
        assert.equal(bare.code, 2);
        assert.match(bare.stderr, /config takes a subcommand: get, set, validate/);
        for (const argv of [
            ['config', '--help'],
            ['help', 'config'],
        ]) {
            const result = await h.run(...argv);
            assert.equal(result.code, 0, argv.join(' '));
            assert.match(result.stdout, /ghost-docker config set \[<file>\] \[<key>\] \[<value>\]/);
        }
        const one = await h.run('config', 'get', '--help');
        assert.equal(one.code, 0);
        assert.match(one.stdout, /Print one decoded value/);
        assert.equal((await h.run('config', 'frobnicate')).code, 2);
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
        for (const flag of ['--version', '-v']) {
            assert.equal((await h.run(flag)).stdout, 'ghost-docker v1.2.3-beta.4 (0123456)\n');
        }
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

describe('options from a schema', () => {
    test('unwrap to what parseArgs reads', () => {
        const flags = flagsOf(
            z.object({
                keepProbe: z.boolean().default(false).describe('Keep it.'),
                port: z.string().transform(Number).optional().describe('A port.'),
                tag: z.array(z.string()).optional().describe('Tags.'),
            }),
        );
        assert.deepEqual(flags, [
            {
                name: 'keep-probe',
                key: 'keepProbe',
                type: 'boolean',
                multiple: false,
                brief: 'Keep it.',
            },
            { name: 'port', key: 'port', type: 'string', multiple: false, brief: 'A port.' },
            { name: 'tag', key: 'tag', type: 'string', multiple: true, brief: 'Tags.' },
        ]);
    });

    test('an option without a brief is a bug in its definition', () => {
        assert.throws(() => flagsOf(z.object({ quiet: z.boolean() })), /--quiet has no brief/);
    });
});

describe('list', () => {
    const labelled = (project: string, mode: string) => ({
        Id: project,
        Names: [`/${project}-ghost-1`],
        State: 'exited',
        Labels: {
            'org.ghost.docker.managed': 'true',
            'org.ghost.docker.mode': mode,
            'com.docker.compose.project': project,
        },
    });

    test('Compose names each project and its directory; the labels say which are sites', async () => {
        h.daemon.containers = [labelled('ghost-b', 'production'), labelled('ghost-a', 'local')];
        h.daemon.composeRun = (args) =>
            args[0] === 'ls'
                ? ok(
                      JSON.stringify([
                          {
                              Name: 'ghost-b',
                              Status: 'running(3)',
                              ConfigFiles: '/srv/b/compose.yml',
                          },
                          {
                              Name: 'unrelated',
                              Status: 'running(1)',
                              ConfigFiles: '/srv/x/compose.yml',
                          },
                          {
                              Name: 'ghost-a',
                              Status: 'exited(2)',
                              ConfigFiles: '/srv/a/compose.yml,/srv/a/compose.override.yml',
                          },
                      ]),
                  )
                : undefined;
        const result = await h.run('list');
        assert.equal(result.code, 0, result.stderr);
        const rows = result.stdout.split('\n').filter((line) => line.startsWith('ghost-'));
        assert.deepEqual(
            rows.map((line) => line.split(/\s+/).filter(Boolean)),
            [
                ['ghost-a', 'local', 'exited(2)', '/srv/a'],
                ['ghost-b', 'production', 'running(3)', '/srv/b'],
            ],
        );
        assert.doesNotMatch(result.stdout, /unrelated/);
    });

    test('Compose failing is an error, not an empty list', async () => {
        h.daemon.composeRun = (args) => (args[0] === 'ls' ? failed(1, 'boom') : undefined);
        const result = await h.run('list');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /docker compose ls failed/);
    });
});
