// Real imports of real bundles.
//
// The source sites are installed with Ghost-CLI and exported with the released
// `ghost migrate-export`, so what is imported here is byte for byte what an
// operator would have: a local SQLite site (a `mysql-data` bundle) and a local
// MySQL site (a `mysql-dump` bundle). Nothing is hand-written except the
// deliberately broken copies.
//
// This installs Ghost twice on the host and starts several containers. Set
// GD_TEST_IMPORT=1 to run it. It needs Node (for Ghost-CLI) and, for the MySQL
// source, a `mysqldump` on the PATH; that half is skipped without one.
//
//   GD_TEST_GHOST_CLI   the exporter to use. Default: npx --yes ghost-cli@1.33.0
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, cpSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  tempDir, cleanup, copyWorktree, run, compose, dockerAvailable, shOk, sh, q,
} from './helpers.mjs';

const enabled = process.env.GD_TEST_IMPORT === '1' && dockerAvailable();
const skip = enabled ? false : 'set GD_TEST_IMPORT=1 with a working Docker daemon';

const CLI = (process.env.GD_TEST_GHOST_CLI ?? 'npx --yes ghost-cli@1.33.0').split(' ');
const DEFAULT_IMAGE = 'ghost:6-next-alpine';
const SOURCE_DB_CONTAINER = 'ghost-docker-test-import-source-db';
const SQLITE_PORT = 23711;
const MYSQL_SITE_PORT = 23712;
const SOURCE_DB_PORT = 33711;

const OWNER = { name: 'Import Tester', email: 'owner@example.com', password: 'Sup3r-secret-pass!' };
// Dollar signs and both kinds of quote: the value that dotenv encoding gets wrong.
const MAIL_FROM = `'Import $Test "quoted"' <noreply@example.com>`;

const hasMysqldump = spawnSync('mysqldump', ['--version'], { stdio: 'ignore' }).status === 0;

let dir;
let ghostVersion;
const sources = [];
const destinations = new Set();

const ghostCli = (cwd, args) => {
  const result = run(CLI[0], [...CLI.slice(1), ...args], { cwd, timeout: 1_200_000 });
  assert.equal(result.status, 0, `ghost ${args.join(' ')} failed:\n${result.output}`);
  return result;
};

const install = (site, args, env = {}) =>
  run(join(site, 'install.sh'), [...args, '--no-prompt'], { cwd: site, timeout: 1_200_000, env });

const destination = (name) => {
  const site = copyWorktree(join(dir, name));
  destinations.add(site);
  return site;
};

const envValue = (site, key) => shOk(`env_get ${q(join(site, '.env'))} ${q(key)}`).trim();

/** Containers, running or not, that belong to a destination checkout. */
const containersOf = (site) => execFileSync('docker', [
  'ps', '-a', '--filter', `label=com.docker.compose.project.working_dir=${site}`, '--format', '{{.Names}}',
], { encoding: 'utf8' }).trim();

const untouched = (site) => {
  for (const name of ['.env', 'ghost.env', '.ghost-docker.json', '.ghost-docker-import', '.import', 'data']) {
    assert.ok(!existsSync(join(site, name)), `the failed import left ${name} behind`);
  }
  assert.equal(containersOf(site), '', 'the failed import left containers behind');
};

/** A digest of every file under a directory, to show a bundle was not changed. */
const digest = (root) => {
  const hash = createHash('sha256');
  for (const entry of readdirSync(root, { recursive: true }).sort()) {
    hash.update(entry);
    try {
      hash.update(readFileSync(join(root, entry)));
    } catch { /* a directory */ }
  }
  return hash.digest('hex');
};

async function api(base, path, { method = 'GET', body, cookie, origin = base } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      Origin: origin,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response;
}

/** Signs in with a staff password. Resolves to the session cookie. */
async function signIn(base, { email, password }, origin = base) {
  const response = await api(base, '/ghost/api/admin/session/', {
    method: 'POST', body: { username: email, password }, origin,
  });
  assert.equal(response.status, 201, `sign-in answered ${response.status}: ${await response.clone().text()}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
}

/** Installs a local Ghost-CLI site and gives it an owner, a post and an image. */
async function makeSource(name, port, title, extraArgs = []) {
  const site = join(dir, name);
  mkdirSync(site);
  const url = `http://localhost:${port}`;
  ghostCli(site, ['install', ghostVersion, '--local', '--no-prompt', '--port', String(port), '--url', url, ...extraArgs]);
  sources.push(site);

  const base = `http://127.0.0.1:${port}`;
  const setup = await api(base, '/ghost/api/admin/authentication/setup/', {
    method: 'POST', origin: url, body: { setup: [{ ...OWNER, blogTitle: title }] },
  });
  assert.equal(setup.status, 201, `source setup answered ${setup.status}: ${await setup.clone().text()}`);
  const cookie = await signIn(base, OWNER, url);
  const post = await api(base, '/ghost/api/admin/posts/', {
    method: 'POST', origin: url, cookie, body: { posts: [{ title: `Post from ${title}`, status: 'published' }] },
  });
  assert.equal(post.status, 201, `creating a post answered ${post.status}: ${await post.clone().text()}`);
  const { posts: [{ slug }] } = await post.json();

  mkdirSync(join(site, 'content', 'images', '2026', '10'), { recursive: true });
  writeFileSync(join(site, 'content', 'images', '2026', '10', 'marker.png'), `image of ${title}`);
  writeFileSync(join(site, 'content', 'images', '.hidden-marker'), 'dotfile');

  const configPath = join(site, 'config.development.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.mail = { ...(config.mail ?? {}), from: MAIL_FROM };
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  return { site, url, base, slug, title };
}

/** Everything that must be true of a site imported from `source`. */
async function assertImported(site, source) {
  const port = envValue(site, 'GHOST_PORT');
  const base = `http://localhost:${port}`;

  assert.equal(envValue(site, 'COMPOSE_PROFILES'), 'local');
  assert.equal(envValue(site, 'GHOST_VERSION').startsWith(ghostVersion), true);
  assert.ok(!existsSync(join(site, '.ghost-docker-import')), 'the import marker was left behind');
  assert.ok(!existsSync(join(site, '.import')), 'the staging directory was left behind');
  assert.equal(JSON.parse(readFileSync(join(site, '.ghost-docker.json'), 'utf8')).ghost.version, ghostVersion);

  // Staff sign in with the password they had on the source site.
  const cookie = await signIn(base, OWNER);
  const posts = await api(base, `/ghost/api/admin/posts/?filter=slug:${source.slug}&fields=title,status`, { cookie });
  assert.equal(posts.status, 200);
  assert.deepEqual((await posts.json()).posts.map((post) => post.status), ['published']);

  const page = await fetch(`${base}/${source.slug}/`);
  assert.equal(page.status, 200);
  const image = await fetch(`${base}/content/images/2026/10/marker.png`);
  assert.equal(await image.text(), `image of ${source.title}`);
  assert.ok(existsSync(join(site, 'data', 'ghost', 'images', '.hidden-marker')), 'a dotfile did not travel');

  // The raw configuration value, as the Ghost process itself receives it.
  const inside = compose(site, ['exec', '-T', 'ghost', 'printenv', 'mail__from']);
  assert.equal(inside.stdout.trimEnd(), MAIL_FROM);

  const check = sh(`cd ${q(site)} && scripts/site.sh check`);
  assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
}

describe('importing a Ghost-CLI site', { skip }, () => {
  before(() => {
    dir = tempDir('import-e2e');
    // The source is installed at the version the default image ships, so the
    // import never depends on an image for a release published minutes ago.
    execFileSync('docker', ['pull', '--quiet', DEFAULT_IMAGE], { stdio: 'ignore' });
    ghostVersion = execFileSync('docker', [
      'image', 'inspect', DEFAULT_IMAGE, '--format', '{{range .Config.Env}}{{println .}}{{end}}',
    ], { encoding: 'utf8' }).split('\n').find((line) => line.startsWith('GHOST_VERSION=')).slice('GHOST_VERSION='.length);
  });

  after(() => {
    for (const site of destinations) sh(`import_discard ${q(site)}`);
    for (const site of sources) {
      run(CLI[0], [...CLI.slice(1), 'uninstall', '--no-prompt', '--force'], { cwd: site, timeout: 300_000 });
    }
    spawnSync('docker', ['rm', '-f', SOURCE_DB_CONTAINER], { stdio: 'ignore' });
    cleanup(dir);
  });

  describe('a local SQLite site', () => {
    let source;
    let archive;
    let unpacked;

    before(async () => {
      source = await makeSource('source-sqlite', SQLITE_PORT, 'SQLite source');
      const out = join(dir, 'bundle-sqlite');
      ghostCli(source.site, ['migrate-export', '--force', '--no-prompt', '--output', out, '--archive', 'tgz']);
      archive = `${out}.tgz`;
      unpacked = join(dir, 'bundle-sqlite-dir');
      mkdirSync(unpacked);
      execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
    });

    test('the exporter produced a mysql-data bundle', () => {
      const manifest = JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8'));
      assert.equal(manifest.kind, 'mysql-data');
      assert.equal(manifest.sourceInstallType, 'local');
      assert.equal(manifest.ghost.version, ghostVersion);
      assert.equal(manifest.config.mail__from, MAIL_FROM);
    });

    test('the archive imports, and the site is the source site', async () => {
      const before = createHash('sha256').update(readFileSync(archive)).digest('hex');
      const site = destination('from-archive');
      const result = install(site, ['--import', archive]);
      assert.equal(result.status, 0, result.output);
      assert.match(result.stdout, /row counts match the bundle/);
      assert.match(result.stdout, /Ghost is installed/);

      await assertImported(site, source);

      // The source keeps running on its own port, and the bundle is as it was.
      assert.equal((await fetch(`${source.base}/ghost/api/admin/site/`)).status, 200);
      assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), before);
    });

    test('a database that will not load leaves nothing behind, and a clean re-run succeeds', async () => {
      const broken = join(dir, 'bundle-broken-sql');
      cpSync(unpacked, broken, { recursive: true });
      appendFileSync(join(broken, 'database.sql'), '\nINSERT INTO `no_such_table` VALUES (1);\n');

      const site = destination('retried');
      const failed = install(site, ['--import', broken]);
      assert.equal(failed.status, 1, failed.output);
      assert.match(failed.stderr, /no_such_table/);
      assert.match(failed.stderr, /could not be loaded/);
      assert.match(failed.stderr, /as it was before the import/);
      untouched(site);

      // The same checkout, the good bundle as a directory, and --no-start.
      const before = digest(unpacked);
      const result = install(site, ['--import', unpacked, '--no-start']);
      assert.equal(result.status, 0, result.output);
      assert.match(result.stdout, /Nothing is running/);
      assert.equal(containersOf(site), '', '--no-start left containers behind');
      assert.equal(digest(unpacked), before, 'the bundle directory was modified');

      const up = compose(site, ['up', '--detach', '--wait', '--wait-timeout', '600']);
      assert.equal(up.status, 0, up.stderr);
      await assertImported(site, source);
    });

    test('row counts that disagree with the bundle fail the import', () => {
      const tampered = join(dir, 'bundle-tampered-rows');
      cpSync(unpacked, tampered, { recursive: true });
      const manifestPath = join(tampered, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.database.rows.posts += 1;
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const site = destination('tampered');
      const failed = install(site, ['--import', tampered]);
      assert.equal(failed.status, 1, failed.output);
      assert.match(failed.stderr, /posts: the bundle records \d+ rows, the database has \d+/);
      untouched(site);
    });

    test('a failed import that is kept cannot be started, and the next import clears it', async () => {
      const broken = join(dir, 'bundle-broken-kept');
      cpSync(unpacked, broken, { recursive: true });
      appendFileSync(join(broken, 'database.sql'), '\nINSERT INTO `no_such_table` VALUES (1);\n');

      const site = destination('kept');
      const failed = install(site, ['--import', broken], { GD_IMPORT_KEEP_FAILED: '1' });
      assert.equal(failed.status, 1, failed.output);
      assert.match(failed.stderr, /kept for inspection/);
      assert.ok(existsSync(join(site, '.ghost-docker-import')));
      assert.equal(envValue(site, 'COMPOSE_PROFILES'), 'import-incomplete');

      // Plain Compose selects no service in this state.
      compose(site, ['down']);
      compose(site, ['up', '--detach']);
      const running = execFileSync('docker', [
        'ps', '--filter', `label=com.docker.compose.project.working_dir=${site}`, '--format', '{{.Names}}',
      ], { encoding: 'utf8' }).trim();
      assert.equal(running, '', 'a partial site was started');

      const blocked = install(site, ['--local']);
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /did not finish/);

      const result = install(site, ['--import', archive]);
      assert.equal(result.status, 0, result.output);
      assert.match(result.stdout, /Removing what an earlier, unfinished import left behind/);
      await assertImported(site, source);
    });
  });

  describe('a local MySQL site', { skip: hasMysqldump ? false : 'no mysqldump on this host for the exporter to run' }, () => {
    let source;
    let bundle;

    before(async () => {
      // The same server version the destination runs.
      const image = readFileSync(new URL('../compose.yml', import.meta.url), 'utf8').match(/image: (mysql:[^\s]+)/)[1];
      execFileSync('docker', [
        'run', '--detach', '--name', SOURCE_DB_CONTAINER,
        '--env', 'MYSQL_ROOT_PASSWORD=source-root', '--env', 'MYSQL_DATABASE=ghost_source',
        '--publish', `127.0.0.1:${SOURCE_DB_PORT}:3306`, image,
      ], { stdio: 'ignore' });
      for (let attempt = 0; ; attempt += 1) {
        const ready = spawnSync('docker', [
          'exec', SOURCE_DB_CONTAINER, 'mysql', '-h', '127.0.0.1', '-uroot', '-psource-root', '-e', 'SELECT 1', 'ghost_source',
        ], { stdio: 'ignore' });
        if (ready.status === 0) break;
        assert.ok(attempt < 90, 'the source database did not become ready');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      source = await makeSource('source-mysql', MYSQL_SITE_PORT, 'MySQL source', [
        '--db', 'mysql', '--dbhost', '127.0.0.1', '--dbport', String(SOURCE_DB_PORT),
        '--dbuser', 'root', '--dbpass', 'source-root', '--dbname', 'ghost_source',
      ]);
      bundle = join(dir, 'bundle-mysql');
      ghostCli(source.site, ['migrate-export', '--force', '--no-prompt', '--output', bundle]);
    });

    test('the exporter produced a mysql-dump bundle that defines objects as another account', () => {
      const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
      assert.equal(manifest.kind, 'mysql-dump');
      // The reason the load rewrites DEFINER clauses: without that, this
      // dump cannot be loaded by the site's unprivileged database user.
      assert.match(readFileSync(join(bundle, 'database.sql'), 'utf8'), /DEFINER=`root`@/);
    });

    test('the directory bundle imports, and the site is the source site', async () => {
      const site = destination('from-mysql');
      const result = install(site, ['--import', bundle]);
      assert.equal(result.status, 0, result.output);
      assert.match(result.stdout, /the database has a Ghost migration history/);
      await assertImported(site, source);

      // Views belong to the site's own database user, not the source's root.
      const definers = compose(site, ['exec', '-T', 'db', 'sh', '-c',
        'MYSQL_PWD="$MYSQL_PASSWORD" mysql -N -u"$MYSQL_USER" "$MYSQL_DATABASE" -e '
        + '"SELECT DISTINCT definer FROM information_schema.views WHERE table_schema = DATABASE()"']);
      assert.equal(definers.status, 0, definers.stderr);
      for (const definer of definers.stdout.trim().split('\n').filter(Boolean)) {
        assert.match(definer, /^ghost@/);
      }
    });
  });
});
