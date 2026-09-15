import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {run} from './process.mjs';
import {durableJSON, privateDirectory, inventory, copyTree, verifyCheckpoint, checkSpace, retainCompleted, syncDirectory, treeMetadata, restoreMetadata} from './storage.mjs';

process.umask(0o077);
const site = process.env.GD_SITE;
const owner = [Number(process.env.GD_OWNER_UID), Number(process.env.GD_OWNER_GID)];
if (!site || !path.isAbsolute(site) || owner.some(n => !Number.isInteger(n) || n < 0)) throw new Error('Missing host path/ownership contract');
const journalFile = path.join(site, '.ghost-operation.json');
const backupRoot = path.join(site, '.ghost-backups');
let journal = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile)) : null;
if (journal && journal.daemon !== process.env.GD_DAEMON_ID) throw new Error('Use the Docker daemon recorded by the unfinished operation');
if (journal && journal.version !== 1) throw new Error('Unsupported recovery journal version');
const command = process.argv[2];
const args = process.argv.slice(3);

const docker = (...argv) => run('docker', argv);
const composeArgs = (...argv) => ['compose', '--project-directory', site, ...(journal?.kind === 'restore' ? ['--project-name', journal.options.project] : []), '-f', `${site}/compose.yml`, ...argv];
const compose = (...argv) => run('docker', composeArgs(...argv));
async function envGet(key, fallback = '') {
    try { return JSON.parse(await run('bash', ['-c', `set -o pipefail; . /opt/scripts/lib/common.sh; env_get "$1" "$2" | jq -Rs '.[0:-1]'`, '--', `${site}/.env`, key])); }
    catch { return fallback; }
}
async function envSet(file, key, value) {
    await run('bash', ['-c', '. /opt/scripts/lib/common.sh; env_set "$1" "$2" "$3"', '--', file, key, value]);
    fs.chownSync(file, ...owner);
}
function phase(next, fields = {}) {
    journal = {version: 1, daemon: process.env.GD_DAEMON_ID, ...journal, ...fields, phase: next, updatedAt: new Date().toISOString()};
    durableJSON(journalFile, journal, owner);
    process.stdout.write(`${journal.kind}: ${next}\n`);
}
function checkpointHash(source) { return crypto.createHash('sha256').update(fs.readFileSync(`${source}/manifest.json`)).digest('hex'); }
function finish() {
    fs.unlinkSync(journalFile);
    syncDirectory(site);
    journal = null;
}
async function containers() {
    const ids = (await compose('ps', '-aq')).split(/\s+/).filter(Boolean);
    return ids.length ? JSON.parse(await docker('inspect', ...ids)) : [];
}
async function freeze() {
    // A stopped Caddy also blocks custom routes. Stop every writer, not just HTTP.
    const list = await containers();
    const targets = list.filter(c => c.Config.Labels['com.docker.compose.service'] !== 'db');
    for (const c of targets) await docker('update', '--restart=no', c.Id);
    if (targets.length) await docker('stop', '--time', '30', ...targets.map(c => c.Id));
    const remaining = (await containers()).filter(c => c.Config.Labels['com.docker.compose.service'] !== 'db' && c.State.Running);
    if (remaining.length) throw new Error('Application writers are still running');
}
async function resumeBackup() {
    for (const saved of journal.running) {
        const existing = JSON.parse(await docker('inspect', saved.id))[0];
        if (existing.Config.Labels['com.docker.compose.project'] !== journal.project) throw new Error('Container identity changed during operation');
        await docker('update', `--restart=${saved.restart}`, saved.id);
        if (saved.running) await docker('start', saved.id);
    }
    // Restore the state that actually existed, including deliberately stopped services.
    await verifyRunning(journal.running.filter(c => c.running).map(c => c.id));
}
async function verifyRunning(ids) {
    const deadline = Date.now() + 600_000;
    while (true) {
        const list = ids.length ? JSON.parse(await docker('inspect', ...ids)) : [];
        if (list.every(c => c.State.Running && (!c.State.Health || c.State.Health.Status === 'healthy'))) return;
        if (Date.now() >= deadline || list.some(c => c.State.Status === 'exited' || c.State.Health?.Status === 'unhealthy')) throw new Error('Service readiness verification failed');
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}
async function connection() {
    const project = await envGet('COMPOSE_PROJECT_NAME');
    const host = await envGet('DATABASE_HOST', 'db');
    const port = await envGet('DATABASE_PORT', '3306');
    if (![ 'db', `db-${project}` ].includes(host) || port !== '3306') throw new Error('S4 supports only the stack-managed MySQL connection');
    const names = [await envGet('DATABASE_NAME', 'ghost')];
    if ((await envGet('COMPOSE_PROFILES')).split(',').includes('activitypub')) names.push(await envGet('ACTIVITYPUB_DATABASE_NAME', 'activitypub'));
    if (names.some(n => !/^[a-zA-Z0-9_]+$/.test(n) || ['mysql', 'sys', 'information_schema', 'performance_schema'].includes(n.toLowerCase()))) throw new Error('Unsupported database identifier');
    const password = await envGet('DATABASE_ROOT_PASSWORD');
    if (!password) throw new Error('Missing database operator credential');
    return {names: [...new Set(names)], env: {MYSQL_PWD: password}};
}
async function sql(db, sqlText) {
    return run('docker', composeArgs('exec', '-T', '-e', 'MYSQL_PWD', 'db', 'mysql', '--host=127.0.0.1', '--port=3306', '--user=root', '--batch', '--skip-column-names', '-e', sqlText), {env: db.env});
}
async function preflight() {
    await run('bash', ['-c', '. /opt/scripts/lib/common.sh; config_validate "$1"', '--', site], {label: 'Configuration validation (run scripts/config.sh validate)'});
    if (await envGet('PROJECT_DIR') !== site) throw new Error('PROJECT_DIR must equal the absolute mounted host path');
    const profiles = (await envGet('COMPOSE_PROFILES')).split(',');
    if (profiles.some(p => !['local', 'production', 'activitypub'].includes(p))) throw new Error('Recovery currently supports Ghost and ActivityPub; analytics/supervisor require a separate state contract');
    if (fs.existsSync(`${site}/compose.override.yml`) || fs.existsSync(`${site}/compose.override.yaml`)) throw new Error('Compose overrides are unsupported');
    const config = JSON.parse(await compose('config', '--format', 'json'));
    const supported = ['ghost', 'db', 'caddy', 'activitypub', 'activitypub-migrate'];
    if (Object.keys(config.services).some(name => !supported.includes(name))) throw new Error('Unrecognized service state cannot be checkpointed');
    const content = config.services.ghost.volumes.find(v => v.target === config.services.ghost.environment.paths__contentPath)?.source;
    const database = config.services.db.volumes.find(v => v.target === '/var/lib/mysql')?.source;
    for (const location of [content, database]) {
        if (!location || !location.startsWith(`${site}/data/`)) throw new Error('Recovery requires data bind mounts beneath PROJECT_DIR/data');
        // Reject symlinked ancestors, including an external data tree.
        let ancestor = location;
        while (ancestor !== site) {
            if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Symlink data paths are unsupported');
            ancestor = path.dirname(ancestor);
        }
    }
    for (const [name, service] of Object.entries(config.services)) {
        const allowed = name === 'ghost' || name === 'activitypub' ? [content] : name === 'db' ? [database, `${site}/mysql-init`] : name === 'caddy' ? [`${site}/caddy`] : [];
        if ((service.volumes || []).some(v => v.type === 'bind' ? !allowed.includes(v.source) : name !== 'caddy' || !['/data', '/config'].includes(v.target))) throw new Error('Unrecognized service storage cannot be checkpointed');
    }
    return {config, content, database, db: await connection()};
}
async function backup(keep) {
    if (journal) throw new Error('An operation already needs recovery');
    const state = await preflight();
    const list = await containers();
    if (!list.some(c => c.Config.Labels['com.docker.compose.service'] === 'ghost' && c.State.Health?.Status === 'healthy')) throw new Error('Back up a healthy initialized site');
    const images = {};
    for (const [service, config] of Object.entries(state.config.services)) {
        const image = JSON.parse(await docker('image', 'inspect', config.image))[0];
        const running = list.find(c => c.Config.Labels['com.docker.compose.service'] === service);
        if (running && running.Image !== image.Id) throw new Error(`Configured and installed ${service} images differ`);
        const digest = image.RepoDigests?.[0];
        if (!digest) throw new Error(`No immutable registry digest for ${service}`);
        images[service] = digest;
    }
    privateDirectory(backupRoot, owner);
    if (await sql(state.db, 'SELECT @@event_scheduler') === 'ON' && Number(await sql(state.db, "SELECT COUNT(*) FROM information_schema.events WHERE status='ENABLED'")) > 0) throw new Error('Disable the MySQL event scheduler before taking a consistent checkpoint');
    const contentFiles = inventory(state.content);
    const dbBytes = Number(await sql(state.db, `SELECT COALESCE(SUM(data_length+index_length),0) FROM information_schema.tables WHERE table_schema IN (${state.db.names.map(n => `'${n}'`).join(',')})`));
    checkSpace(backupRoot, contentFiles.reduce((n, f) => n + f.bytes, 0) * 2 + dbBytes * 4);
    const id = `${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID()}`;
    const staging = `${backupRoot}/.partial-${id}`;
    journal = {id, kind: 'backup', project: state.config.name, manager: process.env.GD_MANAGER_IMAGE, checkpoint: `${backupRoot}/${id}`, staging,
        running: list.map(c => ({id: c.Id, running: c.State.Running, restart: c.HostConfig.RestartPolicy.Name}))};
    phase('freezing');
    await freeze();
    privateDirectory(staging, owner);
    const payload = `${staging}/payload`;
    privateDirectory(payload, owner);
    phase('snapshotting');
    const counts = {};
    for (const database of state.db.names) {
        counts[database] = {};
        const tables = (await sql(state.db, `SHOW FULL TABLES FROM \`${database}\` WHERE Table_type='BASE TABLE'`)).split('\n').filter(Boolean).map(line => line.split('\t')[0]);
        for (const table of tables) {
            if (!/^[a-zA-Z0-9_]+$/.test(table)) throw new Error('Unsupported table identifier');
            counts[database][table] = await sql(state.db, `SELECT COUNT(*) FROM \`${database}\`.\`${table}\``);
        }
    }
    await run('docker', composeArgs('exec', '-T', '-e', 'MYSQL_PWD', 'db', 'mysqldump', '--host=127.0.0.1', '--port=3306', '--user=root', '--single-transaction', '--routines', '--events', '--triggers', '--hex-blob', '--no-tablespaces', '--set-gtid-purged=OFF', '--databases', ...state.db.names), {env: state.db.env, output: `${payload}/database.sql`});
    if (!fs.statSync(`${payload}/database.sql`).size) throw new Error('Empty database dump');
    fs.chownSync(`${payload}/database.sql`, ...owner);
    copyTree(state.content, `${payload}/content`, owner);
    privateDirectory(`${payload}/config`, owner);
    if (fs.existsSync(`${site}/.ghost-docker.json`)) {
        const metadata = JSON.parse(fs.readFileSync(`${site}/.ghost-docker.json`));
        metadata.manager = {image: journal.manager};
        durableJSON(`${site}/.ghost-docker.json`, metadata, owner);
    }
    for (const file of ['.env', 'ghost.env', '.ghost-docker.json', 'compose.yml', 'caddy', 'mysql-init']) {
        if (fs.existsSync(`${site}/${file}`)) copyTree(`${site}/${file}`, `${payload}/config/${file}`, owner);
    }
    await envSet(`${payload}/config/.env`, 'GHOST_IMAGE_REF', images.ghost);
    const manifest = {format: 'ghost-docker-recovery', version: 1, createdAt: new Date().toISOString(), manager: journal.manager, project: state.config.name,
        images, counts, restartPolicy: state.config.services.ghost.restart || 'no', contentMetadata: treeMetadata(state.content), databases: state.db.names, databaseBytes: dbBytes, profiles: await envGet('COMPOSE_PROFILES'),
        limitations: ['Caddy certificates/cache are re-created', 'Remote email, payment, federation and analytics state cannot be rolled back'], files: inventory(payload)};
    durableJSON(`${staging}/manifest.json`, manifest, owner);
    verifyCheckpoint(staging);
    fs.renameSync(staging, journal.checkpoint);
    syncDirectory(backupRoot);
    phase('resuming');
    await resumeBackup();
    retainCompleted(backupRoot, keep, id);
    process.stdout.write(`Checkpoint: ${journal.checkpoint}\n`);
    finish();
}
async function restore(source, options) {
    if (journal) throw new Error('An operation already needs recovery');
    const manifest = verifyCheckpoint(source);
    if (!/^[a-z0-9][a-z0-9_-]+$/.test(options.project || '')) throw new Error('Restore requires --project NAME');
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid port');
    if (fs.existsSync(`${site}/.env`) || fs.existsSync(`${site}/.ghost-docker.json`) || (fs.existsSync(`${site}/data`) && fs.readdirSync(`${site}/data`).length)) throw new Error('Restore destination must be a fresh checkout with empty data');
    if (await docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${options.project}`)) throw new Error('Destination project already exists on this daemon');
    checkSpace(site, manifest.files.reduce((n, f) => n + f.bytes, 0) * 2 + manifest.databaseBytes * 4);
    for (const image of Object.values(manifest.images)) await docker('pull', image);
    journal = {id: crypto.randomUUID(), kind: 'restore', sourcePath: process.env.GD_CHECKPOINT_SOURCE, checkpointHash: checkpointHash(source), restartPolicy: manifest.restartPolicy, options, manager: process.env.GD_MANAGER_IMAGE};
    phase('preparing');
    await restorePayload(source);
}
async function restorePayload(source) {
    if (checkpointHash(source) !== journal.checkpointHash) throw new Error('The recovery checkpoint changed since this restore began');
    const manifest = verifyCheckpoint(source);
    const payload = `${source}/payload`;
    // Retry is permitted only while ingress has NEVER been enabled. The journal
    // is persisted before creating any database or application container.
    try { await docker('rm', '-f', `ghost-recovery-${journal.id}-verify`); } catch { /* absent */ }
    if (fs.existsSync(`${site}/.env`)) await freeze();
    phase('restoring');
    for (const name of fs.readdirSync(`${payload}/config`)) {
        if (!['.env', 'ghost.env', '.ghost-docker.json', 'compose.yml', 'caddy', 'mysql-init'].includes(name)) throw new Error('Unexpected checkpoint configuration');
        fs.rmSync(`${site}/${name}`, {recursive: true, force: true});
        copyTree(`${payload}/config/${name}`, `${site}/${name}`, owner);
    }
    for (const file of ['.env', 'ghost.env', '.ghost-docker.json']) if (fs.existsSync(`${site}/${file}`)) fs.chmodSync(`${site}/${file}`, 0o600);
    const opts = journal.options;
    for (const [key, value] of Object.entries({PROJECT_DIR: site, COMPOSE_PROJECT_NAME: opts.project, DATABASE_HOST: 'db', DATABASE_PORT: '3306', UPLOAD_LOCATION: './data/ghost', MYSQL_DATA_LOCATION: './data/mysql', RESTART_POLICY: 'no', GHOST_IMAGE_REF: manifest.images.ghost})) await envSet(`${site}/.env`, key, value);
    if (opts.local) {
        for (const [key, value] of Object.entries({COMPOSE_PROFILES: 'local', SITE_MODE: 'local', URL: `http://localhost:${opts.port}`, GHOST_PORT: String(opts.port), DOMAIN: '', ADMIN_DOMAIN: '', ADMIN_URL: '', WWW_REDIRECT: ''})) await envSet(`${site}/.env`, key, value);
    }
    const state = await preflight();
    // Checkpoint images must match the restored stack definition. Ghost's pin
    // is rewritten above; all other stack images are already digest-pinned.
    for (const [name, svc] of Object.entries(state.config.services)) {
        const expected = JSON.parse(await docker('image', 'inspect', manifest.images[name]))[0].Id;
        const actual = JSON.parse(await docker('image', 'inspect', svc.image))[0].Id;
        if (expected !== actual) throw new Error(`Restore image mismatch: ${name}`);
    }
    await compose('up', '-d', '--wait', '--wait-timeout', '600', 'db');
    // Names come from the verified checkpoint, not arbitrary SQL or all databases.
    if (manifest.databases.some(n => !/^[a-zA-Z0-9_]+$/.test(n))) throw new Error('Invalid checkpoint database names');
    for (const name of manifest.databases) await sql(state.db, `DROP DATABASE IF EXISTS \`${name}\``);
    await run('docker', composeArgs('exec', '-T', '-e', 'MYSQL_PWD', 'db', 'mysql', '--host=127.0.0.1', '--port=3306', '--user=root'), {env: state.db.env, input: `${payload}/database.sql`});
    for (const [database, tables] of Object.entries(manifest.counts)) {
        for (const [table, count] of Object.entries(tables)) {
            if (!/^[a-zA-Z0-9_]+$/.test(database) || !/^[a-zA-Z0-9_]+$/.test(table)) throw new Error('Invalid checkpoint table identifier');
            if (await sql(state.db, `SELECT COUNT(*) FROM \`${database}\`.\`${table}\``) !== count) throw new Error('Restored database row counts differ from the checkpoint');
        }
    }
    fs.rmSync(state.content, {recursive: true, force: true});
    copyTree(`${payload}/content`, state.content);
    restoreMetadata(state.content, manifest.contentMetadata);
    if (JSON.stringify(inventory(state.content)) !== JSON.stringify(inventory(`${payload}/content`))) throw new Error('Restored content verification failed');
    // Start an isolated Ghost with no published ports, no dependencies/jobs,
    // no restart, and no external network access (network made internal below).
    phase('verifying');
    await verifyIsolated(state, manifest);
    if (fs.existsSync(`${site}/.ghost-docker.json`)) {
        const meta = JSON.parse(fs.readFileSync(`${site}/.ghost-docker.json`));
        meta.site = {...meta.site, project: opts.project, dir: site, url: await envGet('URL'), domain: await envGet('DOMAIN'), adminDomain: await envGet('ADMIN_DOMAIN')};
        meta.mode = opts.local ? 'local' : meta.mode;
        meta.profiles = (await envGet('COMPOSE_PROFILES')).split(',');
        meta.manager = {image: process.env.GD_MANAGER_IMAGE};
        durableJSON(`${site}/.ghost-docker.json`, meta, owner);
    }
    phase('verified');
    process.stdout.write('Restore verified with ingress blocked. Review the destination, then run scripts/recovery.sh activate.\n');
}
async function verifyIsolated(state, manifest) {
    const network = `ghost-recovery-${journal.id}`;
    const name = `${network}-verify`;
    // A separate internal network prevents copied sites sending mail/webhooks.
    // Connect only MySQL and the verification container to it.
    try { await docker('network', 'inspect', network); } catch { await docker('network', 'create', '--internal', network); }
    const dbId = await compose('ps', '-q', 'db');
    try { await docker('network', 'connect', '--alias', 'db', network, dbId); } catch { /* verify connection below */ }
    const dbContainer = JSON.parse(await docker('inspect', dbId))[0];
    if (!dbContainer.NetworkSettings.Networks[network]) throw new Error('Could not isolate database access');
    try { await docker('rm', '-f', name); } catch { /* first attempt */ }
    const config = state.config.services.ghost;
    const environment = Object.fromEntries(Object.entries(config.environment).map(([key, value]) => [key, String(value ?? '').replaceAll('$$', '$')]));
    try {
        // Forward values through the process environment, including literal dollars
        // and newlines; neither command arguments nor an env-file reparse them.
        await run('docker', ['run', '-d', '--name', name, '--network', network,
            ...Object.keys(environment).flatMap(key => ['--env', key]),
            '--mount', `type=bind,source=${state.content},target=${config.environment.paths__contentPath}`,
            manifest.images.ghost], {env: environment});
        const deadline = Date.now() + 600_000;
        while (true) {
            try {
                await docker('exec', name, 'node', '-e', 'const u=new URL(process.argv[1]); require("http").get({host:"127.0.0.1",port:2368,path:process.argv[2],headers:{Host:u.host,"X-Forwarded-Proto":u.protocol.slice(0,-1)}},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))', config.environment.url, await envGet('GHOST_HEALTHCHECK_PATH', '/ghost/api/admin/site/'));
                break;
            } catch {
                const c = JSON.parse(await docker('inspect', name))[0];
                if (!c.State.Running || Date.now() > deadline) throw new Error('Isolated Ghost readiness failed');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        await sql(state.db, `SELECT COUNT(*) FROM \`${state.db.names[0]}\`.settings`);
    } finally {
        await docker('rm', '-f', name);
        await docker('network', 'disconnect', network, dbId);
        await docker('network', 'rm', network);
    }
}
async function activate() {
    if (journal?.kind !== 'restore' || !['verified', 'activating'].includes(journal.phase)) throw new Error('No verified restore is ready to activate');
    await preflight();
    if (await envGet('SITE_MODE') === 'production') await run('bash', ['-c', '. /opt/scripts/lib/common.sh; caddy_apply "$1"', '--', site]);
    // After this point recovery must NEVER replay the checkpoint: users may
    // have written new data even if the process crashes before marking done.
    phase('activating');
    await envSet(`${site}/.env`, 'RESTART_POLICY', journal.options.local ? 'no' : journal.restartPolicy);
    await compose('up', '-d', '--wait', '--wait-timeout', '600');
    if (await envGet('SITE_MODE') === 'production') {
        const domain = await envGet('DOMAIN');
        await compose('exec', '-T', 'ghost', 'node', '-e', 'const https=require("https"); https.get({host:"caddy",port:443,path:"/ghost/api/admin/site/",servername:process.argv[1],headers:{Host:process.argv[1]},rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))', domain);
    }
    finish();
    process.stdout.write('Restored site activated and verified.\n');
}
try {
    if (['recover', 'activate'].includes(command) && args.length) throw new Error('This command accepts no additional arguments');
    if (command === 'backup') {
        const keep = args.length === 0 ? 5 : args[0] === '--keep' && args.length === 2 ? Number(args[1]) : NaN;
        if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('Usage: backup [--keep N]');
        await backup(keep);
    } else if (command === 'restore') {
        const source = args.shift();
        const options = {port: 2368, local: false};
        while (args.length) {
            const flag = args.shift();
            if (flag === '--project') options.project = args.shift();
            else if (flag === '--port') options.port = Number(args.shift());
            else if (flag === '--local') options.local = true;
            else throw new Error(`Unknown restore option: ${flag}`);
        }
        await restore(source, options);
    } else if (command === 'activate') await activate();
    else if (command === 'recover') {
        if (!journal) process.stdout.write('Stale lock recovered; no unfinished operation.\n');
        else if (journal.kind === 'backup') { await resumeBackup(); finish(); }
        else if (journal.kind === 'restore' && journal.phase === 'activating') await activate();
        else if (journal.kind === 'restore') await restorePayload('/checkpoint');
        else throw new Error('Unknown journal kind; manual inspection required');
    } else throw new Error('Unknown manager command');
} catch (error) {
    if (journal?.kind === 'restore' && journal.phase === 'activating') {
        try { await freeze(); } catch { error.message += '; could not confirm ingress stopped'; }
    }
    if (journal) phase(journal.phase, {error: error.message});
    process.stderr.write(`${JSON.stringify({error: error.message, recoveryRequired: Boolean(journal)})}\n`);
    process.exitCode = 1;
}
