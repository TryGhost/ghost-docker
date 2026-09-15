import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {copyWorktree, tempDir, cleanup, run, compose, dockerAvailable, shOk, q, REPO_DIR} from './helpers.mjs';

const enabled = process.env.GD_TEST_RECOVERY === '1' && dockerAvailable();
for (const mode of ['local', 'production', 'activitypub']) test(`checkpoint and isolated restore of a real Ghost site (${mode})`, {skip: enabled ? false : 'set GD_TEST_RECOVERY=1 with Docker', timeout: 1_800_000}, async () => {
    const dir = fs.realpathSync(tempDir('recovery-e2e'));
    const source = copyWorktree(path.join(dir, 'source'));
    const dest = copyWorktree(path.join(dir, 'destination'));
    const literal = "literal $ # and quotes '\"\\\nnext line";
    const result = (r) => { assert.equal(r.status, 0, r.output || `${r.stdout}\n${r.stderr}`); return r; };
    const envGet = (site, key) => shOk(`env_get ${q(`${site}/.env`)} ${q(key)}`).trim();
    const manager = execFileSync('docker', ['build', '-q', '-f', `${REPO_DIR}/manager/Dockerfile`, REPO_DIR], {encoding: 'utf8'}).trim();
    const recover = (site, args) => run(`${site}/scripts/recovery.sh`, args, {cwd: site, env: {GD_MANAGER_IMAGE: manager}, timeout: 900_000});
    const interrupt = async (target, argv, atPhase) => {
        const child = spawn(`${target}/scripts/recovery.sh`, argv, {cwd: target, env: {...process.env, GD_MANAGER_IMAGE: manager}});
        let output = '';
        child.stdout.on('data', b => { output += b; });
        child.stderr.on('data', b => { output += b; });
        const exit = new Promise(resolve => child.on('exit', resolve));
        const deadline = Date.now() + 600_000;
        let killed = false;
        while (child.exitCode === null && Date.now() < deadline) {
            try {
                const record = JSON.parse(fs.readFileSync(`${target}/.ghost-operation.json`));
                if (record.phase === atPhase) {
                    const name = fs.readFileSync(`${target}/.ghost-operation-lock/manager`, 'utf8').trim();
                    if (atPhase === 'snapshotting') {
                        child.kill('SIGKILL');
                        await exit;
                        const blocked = recover(target, ['recover']);
                        assert.notEqual(blocked.status, 0, blocked.output);
                        assert.match(blocked.output, /manager is still running/);
                    }
                    execFileSync('docker', ['kill', '--signal=KILL', name], {stdio: 'pipe'});
                    killed = true;
                    break;
                }
            } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (!killed) child.kill();
        assert.equal(killed, true, `Did not reach ${atPhase}: ${output}`);
        assert.notEqual(await exit, 0, output);
        assert.equal(fs.existsSync(`${target}/.ghost-operation.json`), true);
    };
    try {
        if (mode === 'production') fs.writeFileSync(`${source}/caddy/global/tls.caddy`, 'local_certs\n');
        const modeArgs = mode === 'production' ? ['--domain', 's4-recovery.test'] : ['--local', ...(mode === 'activitypub' ? ['--with', 'activitypub'] : [])];
        result(run(`${source}/install.sh`, [...modeArgs, '--no-prompt', '--version', '6.62.0-next-alpine'], {cwd: source, timeout: 900_000}));
        // A database value and hidden asset make this more than a readiness test.
        const sql = (site, query) => compose(site, ['exec', '-T', '-e', 'MYSQL_PWD', 'db', 'mysql', '-uroot', '-N', '-B', 'ghost', '-e', query], {env: {MYSQL_PWD: envGet(site, 'DATABASE_ROOT_PASSWORD')}});
        if (mode === 'activitypub') result(sql(source, "CREATE TABLE activitypub.s4_recovery_fixture (value VARCHAR(64)); INSERT INTO activitypub.s4_recovery_fixture VALUES ('federation state')"));
        result(sql(source, "UPDATE settings SET value='Recovery drill title' WHERE `key`='title'"));
        const asset = path.join(source, 'data/ghost/images/.recovery-drill');
        result(compose(source, ['exec', '-T', 'ghost', 'node', '-e', 'require("fs").writeFileSync(process.env.paths__contentPath + "/images/.recovery-drill", "hidden asset survives a checkpoint\\n")']));
        result(run(`${source}/scripts/config.sh`, ['set', `${source}/ghost.env`, 'mail__from', 'Recovery <hello@example.com>'], {cwd: source}));
        result(run(`${source}/scripts/config.sh`, ['set', `${source}/ghost.env`, 's4__literal', literal], {cwd: source}));
        await interrupt(source, ['backup'], 'snapshotting');
        result(recover(source, ['recover']));
        assert.match(compose(source, ['ps', '--status', 'running', '--services']).stdout, /ghost/);
        result(recover(source, ['backup', '--keep', '2']));
        const checkpoint = path.join(source, '.ghost-backups', fs.readdirSync(path.join(source, '.ghost-backups')).find(n => !n.startsWith('.')));
        assert.equal(fs.statSync(checkpoint).mode & 0o777, 0o700);
        assert.equal(fs.statSync(path.join(checkpoint, 'payload/config/.env')).isFile(), true);
        const expectedTheme = result(sql(source, "SELECT value FROM settings WHERE `key`='active_theme'")).stdout;
        if (mode !== 'local') result(compose(source, ['down']));
        const restoreArgs = mode === 'local' ? ['--local', '--port', '24879'] : [];
        await interrupt(dest, ['restore', checkpoint, '--project', `gd-restore-${process.pid}`, ...restoreArgs], 'verifying');
        assert.equal(compose(dest, ['ps', '--status', 'running', '--services']).stdout.trim(), 'db');
        result(recover(dest, ['recover']));
        const journal = JSON.parse(fs.readFileSync(`${dest}/.ghost-operation.json`));
        assert.equal(journal.phase, 'verified');
        assert.equal(fs.readFileSync(`${dest}/data/ghost/images/.recovery-drill`, 'utf8'), fs.readFileSync(asset, 'utf8'));
        assert.equal(result(sql(dest, "SELECT value FROM settings WHERE `key`='title'")).stdout.trim(), 'Recovery drill title');
        assert.equal(result(sql(dest, "SELECT value FROM settings WHERE `key`='active_theme'")).stdout, expectedTheme);
        if (mode === 'activitypub') assert.equal(result(sql(dest, 'SELECT value FROM activitypub.s4_recovery_fixture')).stdout.trim(), 'federation state');
        assert.equal(envGet(dest, 'PROJECT_DIR'), dest);
        assert.match(fs.readFileSync(`${dest}/ghost.env`, 'utf8'), /Recovery/);
        assert.equal(compose(dest, ['ps', '--status', 'running', '--services']).stdout.trim(), 'db');
        result(recover(dest, ['activate']));
        assert.equal(fs.existsSync(`${dest}/.ghost-operation.json`), false);
        const actualLiteral = result(compose(dest, ['exec', '-T', 'ghost', 'node', '-e', 'console.log(JSON.stringify(process.env.s4__literal))'])).stdout.trim();
        assert.equal(JSON.parse(actualLiteral), literal);
        assert.equal(envGet(dest, 'RESTART_POLICY'), mode === 'production' ? 'unless-stopped' : 'no');
        if (mode !== 'production') {
            const response = await fetch(`http://127.0.0.1:${envGet(dest, 'GHOST_PORT')}/ghost/api/admin/site/`);
            assert.equal(response.status, 200);
        } else {
            const response = run('curl', ['--noproxy', '*', '-ksS', '--resolve', 's4-recovery.test:443:127.0.0.1', '-o', '/dev/null', '-w', '%{http_code}', 'https://s4-recovery.test/ghost/api/admin/site/']);
            assert.equal(result(response).stdout, '200');
        }
    } finally {
        for (const site of [source, dest]) if (fs.existsSync(`${site}/.env`)) compose(site, ['down', '-v', '--remove-orphans']);
        if (process.env.GD_KEEP_RECOVERY_TEST !== '1') {
            execFileSync('docker', ['run', '--rm', '--entrypoint', 'sh', '--mount', `type=bind,source=${dir},target=/fixture`, manager, '-c', 'chown -R "$1" /fixture; chmod -R u+rwX /fixture', '--', `${process.getuid()}:${process.getgid()}`], {stdio: 'pipe'});
            cleanup(dir);
        }
        else console.log(`Retained fixture: ${dir}`);
    }
});
