// Real installations, from a candidate release, against real containers.
//
// A candidate release is built from the working tree: a git repository with
// real tags, so bootstrap.sh resolves, clones and delegates exactly as it
// would against the published repository. Nothing here reads the developer's
// own checkout state.
//
// These pull images and start containers. Set GD_TEST_INSTALL=1 to run them;
// they are skipped otherwise. The port-conflict and existing-proxy cases bind
// real host ports, including 80 and 443.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { delimiter } from 'node:path';
import {
  tempDir, cleanup, makeCandidateRelease, git, run, occupyPort, compose,
  dockerAvailable, shOk, q, REPO_DIR,
} from './helpers.mjs';

const enabled = process.env.GD_TEST_INSTALL === '1' && dockerAvailable();
const skip = enabled ? false : 'set GD_TEST_INSTALL=1 with a working Docker daemon';

// The candidate release is a prerelease, so the beta channel has to select it:
// that exercises the channel path rather than only an explicit --ref.
const CANDIDATE_TAG = 'v9.9.9-beta.1';
const PROXY_CONTAINER = 'ghost-docker-test-proxy';

let dir;
let repo;
let repoUrl;
const installed = new Set();

/** Clone the candidate release into a directory, as bootstrap.sh would. */
const clone = (name) => {
  const target = join(dir, name);
  execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', CANDIDATE_TAG, repoUrl, target]);
  return target;
};

const install = (site, args, options = {}) =>
  run(join(site, 'install.sh'), args, { cwd: site, timeout: 900_000, ...options });

const env = (site, key) => shOk(`env_get ${q(join(site, '.env'))} ${q(key)}`).trim();
const meta = (site) => JSON.parse(readFileSync(join(site, '.ghost-docker.json'), 'utf8'));

/** Ghost's Admin API through a host port, with an explicit Host header. */
const adminSite = async (port, host = 'localhost') => {
  const response = await fetch(`http://127.0.0.1:${port}/ghost/api/admin/site/`, {
    headers: { Host: host },
    redirect: 'manual',
  });
  return response;
};

const down = (site) => {
  if (existsSync(join(site, '.env'))) compose(site, ['down', '-v', '--remove-orphans']);
};

// Sites are torn down together at the very end, not in each suite's own after:
// two of the checks need an earlier suite's site still running alongside a
// later one, so no site may be downed while a sibling suite is still asserting.
const track = (site) => { installed.add(site); return site; };

/**
 * Caddy issues from its own internal CA rather than attempting a real ACME
 * order for a name that does not resolve. caddy/global/ is operator owned and
 * the installer never overwrites it, so this survives installation.
 */
const useInternalCerts = (site) => {
  mkdirSync(join(site, 'caddy', 'global'), { recursive: true });
  writeFileSync(join(site, 'caddy', 'global', 'tls.caddy'), 'local_certs\n');
};

describe('installing from a candidate release', { skip, concurrency: 1 }, () => {
  before(() => {
    dir = tempDir('install-e2e');
    ({ repo, url: repoUrl } = makeCandidateRelease(dir, ['v1.0.0', CANDIDATE_TAG]));
  });
  after(() => {
    for (const site of installed) down(site);
    cleanup(dir);
  });

  describe('a local site, through the bootstrap', () => {
    let site;
    before(() => {
      site = track(join(dir, 'local-a'));
    });

    test('bootstrap resolves the release, clones it and runs its installer', () => {
      const result = run(join(REPO_DIR, 'bootstrap.sh'),
        ['--channel', 'beta', '--dir', site, '--local', '--no-prompt'],
        { env: { GD_BOOTSTRAP_REPO: repoUrl }, timeout: 900_000 });
      assert.equal(result.status, 0, result.output);
      assert.match(result.stdout, new RegExp(CANDIDATE_TAG.replace(/\./g, '\\.')));
      assert.match(result.stdout, /Ghost is installed/);
    });

    test('configuration and metadata are written privately', () => {
      for (const file of ['.env', 'ghost.env', '.ghost-docker.json']) {
        const path = join(site, file);
        assert.ok(existsSync(path), `${file} was not written`);
        assert.equal(statSync(path).mode & 0o777, 0o600, `${file} is not private`);
      }
    });

    test('the metadata records the release, channel and resolved image', () => {
      const recorded = meta(site);
      assert.equal(recorded.schemaVersion, 1);
      assert.equal(recorded.mode, 'local');
      // A prerelease tag implies the beta channel whether or not it was named.
      assert.equal(recorded.channel, 'beta');
      assert.equal(recorded.stack.ref, CANDIDATE_TAG);
      assert.match(recorded.stack.commit, /^[0-9a-f]{40}$/);
      // §2.10: the recorded dir is the resolved real host path (pwd -P), so
      // compare against the realpath, not the possibly-symlinked test path.
      assert.equal(recorded.site.dir, realpathSync(site));
      assert.match(recorded.ghost.version, /^\d+\.\d+\.\d+$/);
      assert.match(recorded.ghost.digest, /^sha256:[0-9a-f]{64}$/, 'no digest recorded for recovery');
      assert.deepEqual(recorded.profiles, ['local']);
    });

    // A moving tag would let the site change Ghost version under the operator
    // on the next `docker compose pull`. The pin has to be exact.
    test('the Ghost version is pinned exactly, and the paths come from the image', () => {
      assert.match(env(site, 'GHOST_VERSION'), /^\d+\.\d+\.\d+(-.+)?$/);
      assert.equal(env(site, 'GHOST_VERSION').startsWith(meta(site).ghost.version), true);
      const content = env(site, 'GHOST_CONTENT_PATH');
      assert.ok(content.endsWith('/content'), content);
      assert.match(env(site, 'GHOST_TINYBIRD_PATH'), /\/core\/server\/data\/tinybird$/);
    });

    test('generated credentials are unique to the site and are not the example ones', () => {
      const password = env(site, 'DATABASE_PASSWORD');
      const root = env(site, 'DATABASE_ROOT_PASSWORD');
      assert.ok(password.length >= 32, 'the application password is short');
      assert.notEqual(password, root);
      assert.ok(!password.includes('change-me'), 'the example password survived');
      assert.ok(!root.includes('change-me'), 'the example root password survived');
    });

    test('Ghost answers through the ingress the site actually uses', async () => {
      const response = await adminSite(env(site, 'GHOST_PORT'));
      assert.equal(response.status, 200);
      assert.ok((await response.json()).site, 'no site payload');
    });

    test('the site is published on the loopback interface only', () => {
      const config = JSON.parse(compose(site, ['ps', '--format', 'json']).stdout.trim().split('\n')[0] ?? '{}');
      assert.ok(config, 'no containers');
      const bindings = execFileSync('docker', ['inspect', '-f', '{{json .HostConfig.PortBindings}}',
        compose(site, ['ps', '-q', 'ghost']).stdout.trim()], { encoding: 'utf8' });
      const hosts = Object.values(JSON.parse(bindings)).flat().map((b) => b.HostIp);
      assert.deepEqual(hosts, ['127.0.0.1']);
    });

    test('site.sh check passes, and site.sh list finds the site', () => {
      const check = run(join(site, 'scripts', 'site.sh'), ['check', site], { timeout: 300_000 });
      assert.equal(check.status, 0, check.output);
      const list = run(join(site, 'scripts', 'site.sh'), ['list'], { timeout: 120_000 });
      assert.equal(list.status, 0, list.output);
      assert.match(list.stdout, new RegExp(env(site, 'COMPOSE_PROJECT_NAME')));
    });
  });

  describe('a second local site alongside the first', () => {
    let first;
    let second;
    before(() => {
      first = join(dir, 'local-a');
      second = track(clone('local-b'));
    });

    test('installs without disturbing the first', () => {
      const result = install(second, ['--local', '--no-prompt']);
      assert.equal(result.status, 0, result.output);
    });

    // Two sites on one host share a Docker daemon and the loopback interface,
    // so their identities and ports must differ. The project name is also the
    // suffix of every service network alias.
    test('the two sites have distinct identities and ports', () => {
      assert.notEqual(env(first, 'COMPOSE_PROJECT_NAME'), env(second, 'COMPOSE_PROJECT_NAME'));
      assert.equal(env(first, 'COMPOSE_PROJECT_NAME'), 'ghost-local-local-a');
      assert.equal(env(second, 'COMPOSE_PROJECT_NAME'), 'ghost-local-local-b');
      assert.notEqual(env(first, 'GHOST_PORT'), env(second, 'GHOST_PORT'));
      assert.notEqual(env(first, 'DATABASE_PASSWORD'), env(second, 'DATABASE_PASSWORD'));
    });

    test('both sites answer at the same time', async () => {
      for (const site of [first, second]) {
        const response = await adminSite(env(site, 'GHOST_PORT'));
        assert.equal(response.status, 200, `${site} did not answer`);
      }
    });
  });

  describe('an explicitly requested port that is in use', () => {
    let site;
    let release;
    before(async () => {
      site = clone('port-conflict');
      release = await occupyPort(24771);
    });
    after(async () => {
      if (release) await release();
    });

    // A port chosen by the installer moves out of the way; a port the operator
    // asked for does not. Silently using a different one would produce a site
    // on an address nothing else is configured for.
    test('fails, names what holds the port, and writes nothing', () => {
      const result = install(site, ['--local', '--no-prompt', '--port', '24771']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /port 24771/);
      assert.match(result.stderr, /already in use/);
      assert.match(result.stderr, /Nothing has been changed/);
      assert.ok(!existsSync(join(site, '.env')), 'configuration was written anyway');
      assert.ok(!existsSync(join(site, '.ghost-docker.json')), 'metadata was written anyway');
    });
  });

  describe('a server that already runs a proxy on 80 and 443', () => {
    let site;
    before(() => {
      site = clone('existing-proxy');
      const image = readFileSync(join(REPO_DIR, 'compose.yml'), 'utf8')
        .match(/image: (caddy:[^\s@]+@sha256:[0-9a-f]+)/)[1];
      execFileSync('docker', ['rm', '-f', PROXY_CONTAINER], { stdio: 'ignore' });
      execFileSync('docker', [
        'run', '-d', '--name', PROXY_CONTAINER, '-p', '80:80', '-p', '443:443',
        image, 'caddy', 'respond', '--listen', ':80', 'the operator\'s own proxy',
      ], { stdio: 'ignore' });
    });
    after(() => {
      execFileSync('docker', ['rm', '-f', PROXY_CONTAINER], { stdio: 'ignore' });
    });

    // A server may proxy other applications. Taking its ports, or stopping it,
    // is not the installer's call to make.
    test('installation fails on the port conflict and leaves the proxy running', () => {
      const result = install(site, ['--domain', 'ghost.test', '--no-prompt']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /port 80/);
      assert.match(result.stderr, new RegExp(PROXY_CONTAINER));
      assert.match(result.stderr, /Nothing was stopped/);

      const running = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', PROXY_CONTAINER],
        { encoding: 'utf8' }).trim();
      assert.equal(running, 'true', 'the operator\'s proxy was stopped');
      assert.ok(!existsSync(join(site, '.env')), 'configuration was written anyway');
    });
  });

  describe('a production site', () => {
    let site;
    before(() => {
      site = track(clone('production'));
      useInternalCerts(site);
    });

    test('installs, renders routes, and verifies its own ingress', () => {
      const result = install(site, ['--domain', 'ghost.test', '--no-prompt']);
      assert.equal(result.status, 0, result.output);
      assert.match(result.stdout, /Caddy routes ghost\.test/);
      assert.match(result.stdout, /redirects http:\/\/ghost\.test to HTTPS/);
    });

    test('the mode, URL and restart policy match production', () => {
      assert.equal(env(site, 'COMPOSE_PROFILES'), 'production');
      assert.equal(env(site, 'SITE_MODE'), 'production');
      assert.equal(env(site, 'NODE_ENV'), 'production');
      assert.equal(env(site, 'URL'), 'https://ghost.test');
      assert.equal(env(site, 'DOMAIN'), 'ghost.test');
      assert.equal(env(site, 'RESTART_POLICY'), 'unless-stopped');
      assert.equal(meta(site).mode, 'production');
    });

    test('the generated routes are installed, and the operator files are untouched', () => {
      const generated = readFileSync(join(site, 'caddy', 'sites', 'site.caddy'), 'utf8');
      assert.match(generated, /^ghost\.test \{/m);
      assert.match(generated, new RegExp(`reverse_proxy ghost-${env(site, 'COMPOSE_PROJECT_NAME')}:2368`));
      assert.equal(readFileSync(join(site, 'caddy', 'global', 'tls.caddy'), 'utf8'), 'local_certs\n');
    });

    // Node's fetch forbids overriding the Host header, so Caddy would see
    // 127.0.0.1 and redirect there; the request has to carry Host: ghost.test.
    // The installer's own /dev/tcp helper sets it, which is what it verifies
    // with too, so drive the check through that rather than fetch.
    test('HTTP on the ingress port redirects to HTTPS for the site domain', () => {
      const head = run('bash', ['-c',
        `. ${JSON.stringify(join(site, 'scripts', 'lib', 'common.sh'))}\n` +
        `install_http_head 127.0.0.1 ${env(site, 'HTTP_PORT')} / ghost.test`], { timeout: 60_000 });
      assert.match(head.stdout, /^HTTP\/[0-9.]+ 3\d\d/m, head.output);
      assert.match(head.stdout, /^location: https:\/\/ghost\.test/im, head.output);
    });

    // The whole intended ingress, end to end: TLS terminated by Caddy for this
    // name, proxied to Ghost, Admin API answering. The installer reports this
    // as a warning rather than a failure, because a real production install may
    // legitimately run before DNS is pointed and no certificate can exist yet;
    // here the internal CA removes that variable, so it must actually work.
    test('Ghost Admin answers over HTTPS through Caddy', () => {
      const status = run('bash', ['-c',
        `. ${JSON.stringify(join(site, 'scripts', 'lib', 'common.sh'))}\n` +
        `install_https_status ${JSON.stringify(site)} ghost.test`], { timeout: 180_000 });
      assert.equal(status.stdout.trim(), '200', status.output);
    });
  });

  describe('--no-start', () => {
    let site;
    before(() => {
      site = track(clone('no-start'));
    });

    test('configures the site and starts no application services', () => {
      const result = install(site, ['--local', '--no-prompt', '--no-start']);
      assert.equal(result.status, 0, result.output);
      assert.ok(existsSync(join(site, '.env')));
      assert.ok(existsSync(join(site, '.ghost-docker.json')));
      assert.match(result.stdout, /Nothing is running/);
      assert.equal(compose(site, ['ps', '-a', '-q']).stdout.trim(), '', 'containers were created');
    });

    test('the configuration it wrote is valid and startable', () => {
      const result = compose(site, ['config', '--quiet']);
      assert.equal(result.status, 0, result.stderr);
    });
  });

  // The installer must not acquire a dependency an operator does not have.
  // The allowlist is the tool contract recorded in scripts/lib/preflight.sh,
  // so adding a utility to a code path without recording it fails here.
  describe('the declared minimum host tools', () => {
    let site;
    before(() => {
      site = track(clone('minimum-tools'));
    });

    test('an install completes with only the recorded utilities on PATH', () => {
      const utilities = shOk('printf "%s\\n" "${GD_HOST_UTILITIES[@]}"').trim().split('\n');
      const commands = shOk('printf "%s\\n" "${GD_REQUIRED_COMMANDS[@]}"').trim().split('\n');
      const realPath = process.env.PATH;

      const bin = join(dir, 'minimum-bin');
      mkdirSync(bin, { recursive: true });

      // `docker` (and `jq`) are declared *commands*, not POSIX utilities: their
      // own subprocess needs are their business, not the installer's. What this
      // test isolates is whether our shell reaches for a coreutil that is not
      // in the contract — so the utilities are the only things symlinked bare,
      // and the commands are wrapped to run with the full PATH restored. A
      // command that shelled out to an unlisted tool would still pass; a script
      // of ours that did would not, which is the line this test draws.
      const missing = [];
      for (const tool of utilities) {
        const found = run('sh', ['-c', `command -v ${tool}`]).stdout.trim();
        if (!found) missing.push(tool);
        else symlinkSync(found, join(bin, tool));
      }
      assert.deepEqual(missing, [], 'a declared utility is not installed on this host');

      for (const command of commands) {
        const found = run('sh', ['-c', `command -v ${command}`]).stdout.trim();
        assert.ok(found, `${command} is not installed on this host`);
        const wrapper = join(bin, command);
        writeFileSync(wrapper,
          `#!/bin/sh\nexec env PATH=${JSON.stringify(realPath)} ${JSON.stringify(found)} "$@"\n`,
          { mode: 0o755 });
      }

      const result = install(site, ['--local', '--no-prompt', '--no-start'], {
        env: { PATH: [bin, '/nonexistent'].join(delimiter) },
      });
      assert.equal(result.status, 0, result.output);
      assert.ok(existsSync(join(site, '.ghost-docker.json')));
    });
  });
});
