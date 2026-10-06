// doctor: each thing it can find wrong, and that a healthy host passes.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { PROBE_FILE } from '../src/commands/doctor.ts';
import { harness, HEALTHY, type Harness } from './helpers.ts';

let h: Harness;
beforeEach(() => {
    h = harness();
});
afterEach(() => h.cleanup());

const checks = async () =>
    JSON.parse((await h.run('doctor', '--json')).stdout).checks as {
        status: string;
        label: string;
        detail: string;
    }[];
const check = async (label: string) => (await checks()).find((item) => item.label === label);

describe('a healthy host', () => {
    test('passes, on stdout only, and leaves nothing behind', async () => {
        const result = await h.run('doctor');
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stderr, '');
        for (const label of [
            'manager',
            'docker engine',
            'platform',
            'docker compose',
            'site directory',
            'identity',
            'writable',
        ]) {
            assert.match(result.stdout, new RegExp(`ok +${label}`));
        }
        assert.ok(!existsSync(join(h.dir, PROBE_FILE)), 'left the probe file behind');
    });

    test('--keep-probe leaves a private file owned by the caller', async () => {
        assert.equal((await h.run('doctor', '--keep-probe')).code, 0);
        const info = statSync(join(h.dir, PROBE_FILE));
        assert.equal(info.uid, h.uid);
        assert.equal(info.mode & 0o777, 0o600);
    });

    test('an unknown option is a usage error', async () => {
        assert.equal((await h.run('doctor', '--fix')).code, 2);
    });
});

describe('the daemon', () => {
    test('one that cannot be reached is an error carrying its own message', async () => {
        h.daemon.info = {
            fail: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\nmore',
        };
        const result = await h.run('doctor');
        assert.equal(result.code, 1);
        assert.match(result.stderr, /ERROR +docker daemon +Cannot connect to the Docker daemon/);
        assert.doesNotMatch(result.stderr, /more/);
    });

    test('one that does not answer is reported as that, not as absent', async () => {
        h.daemon.info = { hang: true };
        assert.match((await check('docker daemon'))!.detail, /did not answer within 20 seconds/);
    });

    test('an engine older than the minimum is an error naming both versions', async () => {
        h.daemon.info = { ...HEALTHY, ServerVersion: '24.0.7' };
        const engine = await check('docker engine');
        assert.equal(engine!.status, 'error');
        assert.match(engine!.detail, /24\.0\.7 is older than the required 25\.0\.0/);
    });

    test('versions are compared numerically, and suffixes ignored', async () => {
        for (const version of ['25.0.0', '100.0.0', '28.5.2-ce', '27.10.1+desktop.1']) {
            h.daemon.info = { ...HEALTHY, ServerVersion: version };
            assert.equal((await check('docker engine'))!.status, 'ok', version);
        }
        for (const compose of ['2.24.0', '2.100.0', 'v2.40.3-desktop.1', '5.1.2']) {
            h.daemon.compose = compose;
            assert.equal((await check('docker compose'))!.status, 'ok', compose);
        }
        h.daemon.compose = '2.9.0';
        assert.equal((await check('docker compose'))!.status, 'error');
    });

    test('a Compose client that does not run is an error', async () => {
        h.daemon.compose = null;
        assert.equal((await check('docker compose'))!.status, 'error');
    });

    test('an architecture with no images is an error', async () => {
        h.daemon.info = { ...HEALTHY, Architecture: 'riscv64' };
        assert.match((await check('platform'))!.detail, /linux\/riscv64 has no published images/);
    });

    test('a Windows-container daemon is an error', async () => {
        h.daemon.info = { ...HEALTHY, OSType: 'windows' };
        assert.equal((await check('platform'))!.status, 'error');
    });

    test('arm64 under either of its names is supported', async () => {
        for (const Architecture of ['aarch64', 'arm64']) {
            h.daemon.info = { ...HEALTHY, Architecture };
            assert.equal((await check('platform'))!.status, 'ok');
        }
    });
});

describe('the site directory', () => {
    test('working anywhere but the path the launcher named is an error, and nothing is written', async () => {
        const elsewhere = join(h.dir, 'elsewhere');
        mkdirSync(elsewhere);
        h.cwd = elsewhere;
        const site = await check('site directory');
        assert.equal(site!.status, 'error');
        assert.match(site!.detail, /must be the same path/);
        assert.equal(await check('writable'), undefined);
        assert.ok(!existsSync(join(elsewhere, PROBE_FILE)));
    });

    test('a directory that cannot be written is an error', async () => {
        h.env.GD_SITE_DIR = '/proc/ghost-docker-no-such-directory';
        h.cwd = '/proc/ghost-docker-no-such-directory';
        assert.equal((await check('writable'))!.status, 'error');
    });

    test('PROJECT_DIR in .env is compared when there is one', async () => {
        assert.equal(await check('PROJECT_DIR'), undefined);

        writeFileSync(join(h.dir, '.env'), `COMPOSE_PROFILES="local"\nPROJECT_DIR="${h.dir}"\n`);
        assert.equal((await check('PROJECT_DIR'))!.status, 'ok');

        writeFileSync(join(h.dir, '.env'), 'PROJECT_DIR=/srv/somewhere-else\n');
        const moved = await check('PROJECT_DIR');
        assert.equal(moved!.status, 'error');
        assert.match(moved!.detail, /\/srv\/somewhere-else/);
    });

    test('a PROJECT_DIR this reader cannot decode is left alone rather than guessed', async () => {
        writeFileSync(join(h.dir, '.env'), 'PROJECT_DIR="/srv/with$$dollar"\n');
        assert.equal(await check('PROJECT_DIR'), undefined);
    });
});

describe('bind mounts', () => {
    test('a sibling container is started with the site directory at the manager\u2019s own path, read-only', async () => {
        assert.equal((await check('bind mounts'))!.status, 'ok');
        const call = h.calls.find((argv) => argv[1] === 'run')!;
        assert.ok(call.includes(`${h.dir}:/ghost-docker-probe:ro`), call.join(' '));
        assert.equal(call.at(-1), `/ghost-docker-probe/${PROBE_FILE}`);
        assert.equal(call.at(-2), 'ghost-docker:checkout');
        assert.ok(call.includes('none'), 'the sibling was given a network');
    });

    test('a daemon that resolves the path to another directory is an error that says what it means', async () => {
        h.daemon.sibling = 'other-directory';
        const result = await check('bind mounts');
        assert.equal(result!.status, 'error');
        assert.match(result!.detail, /did not find the file the manager wrote/);
        assert.match(result!.detail, /every Compose bind mount would point at the wrong place/);
        assert.equal((await h.run('doctor')).code, 1);
    });

    test('a daemon that cannot start the sibling is an error carrying its message', async () => {
        h.daemon.sibling = 'cannot-run';
        assert.match((await check('bind mounts'))!.detail, /mounts denied/);
    });

    test('a sibling that never finishes is an error, not a hang', async () => {
        h.daemon.sibling = 'hangs';
        assert.match((await check('bind mounts'))!.detail, /did not finish/);
    });

    test('the probe file is removed afterwards whatever the outcome', async () => {
        for (const sibling of ['sees', 'other-directory', 'cannot-run'] as const) {
            h.daemon.sibling = sibling;
            await h.run('doctor');
            assert.ok(!existsSync(join(h.dir, PROBE_FILE)), sibling);
        }
    });

    test('without an image name from the launcher it is a warning, not a pass', async () => {
        delete h.env.GD_IMAGE;
        const result = await check('bind mounts');
        assert.equal(result!.status, 'warn');
        assert.equal((await h.run('doctor')).code, 0);
    });

    test('it is not attempted when the directory could not be written', async () => {
        h.env.GD_SITE_DIR = '/proc/ghost-docker-no-such-directory';
        h.cwd = '/proc/ghost-docker-no-such-directory';
        assert.equal(await check('bind mounts'), undefined);
    });
});

describe('identity', () => {
    test('running as someone other than the caller is an error', async () => {
        h.uid = 0;
        h.gid = 0;
        h.env.GD_UID = '1000';
        h.env.GD_GID = '1000';
        const identity = await check('identity');
        assert.equal(identity!.status, 'error');
        assert.match(identity!.detail, /would not belong to them/);
    });

    test('under rootless Docker, root is the caller', async () => {
        h.daemon.info = { ...HEALTHY, SecurityOptions: ['name=seccomp', 'name=rootless'] };
        h.env.GD_ROOTLESS = '1';
        h.env.GD_UID = '1000';
        h.env.GD_GID = '1000';
        h.uid = 0;
        h.gid = 0;
        assert.equal((await check('identity'))!.status, 'ok');
        assert.match((await check('platform'))!.detail, /rootless/);

        h.uid = 1000;
        assert.equal((await check('identity'))!.status, 'error');
    });

    test('a launcher and a daemon that disagree about rootless is an error', async () => {
        h.daemon.info = { ...HEALTHY, SecurityOptions: ['name=rootless'] };
        assert.equal((await check('rootless'))!.status, 'error');
    });

    test('a launcher that passed no identity is refused', async () => {
        delete h.env.GD_UID;
        delete h.env.GD_GID;
        assert.match((await h.run('doctor')).stderr, /GD_UID/);
    });
});
