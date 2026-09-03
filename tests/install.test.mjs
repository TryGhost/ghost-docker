// The installer's decisions, and the release selection in front of it.
//
// Everything here runs without starting a container; tests/install-e2e.test.mjs
// installs real sites. The split matters: these are the checks that must fail
// *before* anything on the host is touched, so they must not need a daemon to
// be exercised.
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  tempDir, cleanup, copyWorktree, makeCandidateRelease, git, run, occupyPort,
  sh, shOk, shSucceeds, q, REPO_DIR,
} from './helpers.mjs';

// A checkout to run install.sh from. Copied rather than used in place so a
// failing test cannot write a .env into the developer's working tree.
const checkout = (dir, name = 'site') => copyWorktree(join(dir, name));

/** install.sh from a scratch checkout. Never starts anything. */
const install = (site, args, options = {}) =>
  run(join(site, 'install.sh'), args, { cwd: site, timeout: 120_000, ...options });

describe('install.sh options', () => {
  let dir;
  let site;
  beforeEach(() => {
    dir = tempDir('install-flags');
    site = checkout(dir);
  });
  afterEach(() => cleanup(dir));

  test('--help prints the interface and exits zero', () => {
    const result = install(site, ['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--local/);
    assert.match(result.stdout, /--no-prompt/);
  });

  test('an unknown option fails as a usage error', () => {
    const result = install(site, ['--local', '--nonsense']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown option: --nonsense/);
  });

  // Steps that have not landed must say so. A script written against the
  // documented interface gets an answer it can act on, and nothing advertises
  // support that does not exist.
  test('--import fails as unimplemented, naming the step and the path that works today', () => {
    const result = install(site, ['--local', '--import', '/tmp/bundle.tar.gz']);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /--import is not implemented yet/);
    assert.match(result.stderr, /S5/);
    assert.match(result.stderr, /migrate\.sh/);
  });

  test('--with supervisor fails as unimplemented rather than enabling an empty profile', () => {
    const result = install(site, ['--local', '--with', 'supervisor']);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /supervisor is not implemented yet/);
    assert.match(result.stderr, /S8/);
    assert.ok(!existsSync(join(site, '.env')), 'wrote configuration anyway');
  });

  test('the final-phase flags are refused as unimplemented, not as unknown', () => {
    for (const flag of [['--image-registry', 'ghcr'], ['--ghost-channel', 'nightly'], ['--without', 'redis']]) {
      const result = install(site, ['--local', ...flag]);
      assert.equal(result.status, 3, flag[0]);
      assert.match(result.stderr, /not implemented yet/);
    }
  });

  test('--no-prompt with no mode names the flags that supply one', () => {
    const result = install(site, ['--no-prompt']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--local or --domain/);
  });

  test('an unknown optional service is rejected', () => {
    const result = install(site, ['--local', '--with', 'redis']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown optional service: redis/);
  });

  test('--admin-domain is production only', () => {
    const result = install(site, ['--local', '--admin-domain', 'admin.example.com']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /production sites only/);
  });

  test('--domain takes a hostname, not a URL', () => {
    const result = install(site, ['--domain', 'https://example.com', '--no-prompt']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must be a hostname/);
  });

  test('--port must be a port number', () => {
    const result = install(site, ['--local', '--no-prompt', '--port', '99999']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--port must be a port number/);
  });

  test('--dir elsewhere points at the bootstrap rather than installing the wrong tree', () => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    const result = install(site, ['--local', '--no-prompt', '--dir', elsewhere]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /bootstrap\.sh/);
    assert.ok(!existsSync(join(elsewhere, '.env')), 'wrote into the other directory');
  });

  test('an existing site is never installed over', () => {
    writeFileSync(join(site, '.env'), 'COMPOSE_PROFILES="local"\n', { mode: 0o600 });
    const result = install(site, ['--local', '--no-prompt']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already holds a site/);
    assert.equal(readFileSync(join(site, '.env'), 'utf8'), 'COMPOSE_PROFILES="local"\n');
  });

  test('--ref that disagrees with the checkout is refused', () => {
    git(site, ['init', '-q', '-b', 'main']);
    git(site, ['add', '-A']);
    git(site, ['commit', '-q', '-m', 'candidate']);
    git(site, ['tag', 'v1.0.0']);
    const result = install(site, ['--local', '--no-prompt', '--ref', 'v2.0.0']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /this checkout is at v1\.0\.0/);
  });

  // A prompt has to reach a terminal, and a required answer must never have a
  // silent default. Without a tty, --no-prompt is the only behaviour available
  // and the installer must fail rather than block.
  test('with no terminal a required input fails instead of hanging', () => {
    const result = install(site, [], { input: '', timeout: 30_000 });
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, /--local or --domain/);
  });
});

describe('port selection', () => {
  test('an occupied port is detected, and a free one is chosen above it', async () => {
    const release = await occupyPort(24681);
    try {
      assert.ok(shSucceeds('port_in_use 24681'), 'an occupied port was reported free');
      assert.ok(!shSucceeds('port_in_use 24682'), 'a free port was reported busy');
      assert.equal(shOk('free_port 24681').trim(), '24682');
    } finally {
      await release();
    }
  });

  test('an occupied port is an error naming what holds it, never something to stop', async () => {
    const release = await occupyPort(24683);
    try {
      const record = shOk('preflight_port 24683 "Ghost"');
      assert.match(record, /^error\t/);
      assert.match(record, /already in use/);
      assert.match(record, /Nothing was stopped/);
    } finally {
      await release();
    }
  });
});

describe('preflight', () => {
  test('records are STATUS, LABEL, DETAIL, and only errors fail a run', () => {
    const records = shOk('preflight_os; preflight_commands docker jq');
    for (const line of records.trim().split('\n')) {
      assert.equal(line.split('\t').length, 3, line);
    }
    assert.ok(!shSucceeds(`preflight_failed ${q(records)}`), 'ok records failed the run');
    assert.ok(shSucceeds(`preflight_failed ${q('error\tx\ty')}`), 'an error record passed');
    assert.ok(!shSucceeds(`preflight_failed ${q('warn\tx\ty')}`), 'a warning failed the run');
  });

  test('a missing tool is reported by name', () => {
    const record = shOk('preflight_commands definitely-not-a-real-command');
    assert.match(record, /^error\trequired tools\tmissing: definitely-not-a-real-command/);
  });

  // Daemon access is established by asking the daemon. Group membership is
  // neither necessary (rootless, a remote DOCKER_HOST) nor sufficient (a
  // stopped daemon), so nothing here may look at it.
  test('an unreachable daemon is an error with what to do about it', () => {
    const record = shOk('preflight_docker', { env: { DOCKER_HOST: 'tcp://127.0.0.1:1' } });
    assert.match(record, /^error\tdocker daemon\tnot reachable/);
    assert.match(record, /start Docker|systemctl start docker|Docker Desktop/);
  });

  test('nothing decides access from docker-group membership', () => {
    const sources = ['preflight.sh', 'install.sh', 'common.sh']
      .map((f) => readFileSync(join(REPO_DIR, 'scripts', 'lib', f), 'utf8'))
      .concat(readFileSync(join(REPO_DIR, 'install.sh'), 'utf8'))
      .concat(readFileSync(join(REPO_DIR, 'bootstrap.sh'), 'utf8'))
      .join('\n')
      // The rule is stated in a comment in each file; only code is at issue.
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    assert.ok(!/\bgroups\b|\bid -nG\b|getent group/.test(sources), 'a group check crept in');
  });

  test('version comparison is numeric, not lexical', () => {
    assert.equal(shOk('version_compare 2.24.0 2.9.0').trim(), '1');
    assert.equal(shOk('version_compare 2.9.0 2.24.0').trim(), '-1');
    assert.equal(shOk('version_compare 25.0.0 25.0.0').trim(), '0');
    // A build suffix does not make an engine older than its own version.
    assert.ok(shSucceeds('version_at_least 25.0.0+ce 25.0.0'));
    assert.ok(shSucceeds('version_at_least 2.24.0 2.24.0'));
    assert.ok(!shSucceeds('version_at_least 2.23.9 2.24.0'));
  });

  test('the declared minimums are the ones the checks enforce', () => {
    assert.equal(shOk('printf %s "$GD_MIN_COMPOSE_VERSION"'), '2.24.0');
    assert.equal(shOk('printf %s "$GD_MIN_DOCKER_VERSION"'), '25.0.0');
  });
});

describe('site identity and secrets', () => {
  test('a production project name is derived from the domain', () => {
    assert.equal(shOk('install_project_name production Example.COM /tmp/x').trim(), 'ghost-example-com');
    assert.equal(shOk('install_project_name production blog.example.com /tmp/x').trim(), 'ghost-blog-example-com');
  });

  // Two local sites on one host share no state, so their identities must
  // differ; the alias every generated route uses is suffixed with this name.
  test('two local sites in different directories get different identities', () => {
    const a = shOk('install_project_name local "" /srv/site-a').trim();
    const b = shOk('install_project_name local "" /srv/site-b').trim();
    assert.equal(a, 'ghost-local-site-a');
    assert.equal(b, 'ghost-local-site-b');
    assert.notEqual(a, b);
  });

  test('generated secrets are long, random, and free of dotenv metacharacters', () => {
    const first = shOk('install_secret 24').trim();
    const second = shOk('install_secret 24').trim();
    assert.equal(first.length, 48);
    assert.notEqual(first, second);
    assert.match(first, /^[0-9a-f]+$/);
  });
});

describe('Ghost version resolution', () => {
  test('a bare version selects the default variant; a tag is taken as given', () => {
    assert.equal(shOk('install_ghost_tag 6.3.1').trim(), '6.3.1-next-alpine');
    assert.equal(shOk('install_ghost_tag v6.3.1').trim(), '6.3.1-next-alpine');
    assert.equal(shOk('install_ghost_tag ""').trim(), '6-next-alpine');
    assert.equal(shOk('install_ghost_tag 6-alpine').trim(), '6-alpine');
    assert.equal(shOk('install_ghost_tag 6.3.1-alpine').trim(), '6.3.1-alpine');
  });

  test('the variant is separated from the version so an exact pin can be built', () => {
    assert.equal(shOk('_gd_tag_variant 6-next-alpine').trim(), 'next-alpine');
    assert.equal(shOk('_gd_tag_variant 6.3.1-alpine').trim(), 'alpine');
    assert.equal(shOk('_gd_tag_variant next-alpine').trim(), 'next-alpine');
    assert.equal(shOk('_gd_tag_variant 6').trim(), '');
  });
});

describe('release selection', () => {
  let dir;
  let repo;
  let repoUrl;

  // bootstrap.sh is sourced in library mode so that ordering can be tested
  // without cloning anything.
  const bootstrap = (script, env = {}) =>
    run('bash', ['-c', `GD_BOOTSTRAP_SOURCED=1 . ${JSON.stringify(join(REPO_DIR, 'bootstrap.sh'))}\n${script}`], { env });

  before(() => {
    dir = tempDir('release');
    ({ repo, url: repoUrl } = makeCandidateRelease(dir, [
      'v1.9.0', 'v1.10.0', 'v1.11.0-beta.2', 'v1.11.0-beta.10', 'v0.1.0', 'not-a-release',
    ]));
  });
  after(() => cleanup(dir));

  test('semver ordering, including prereleases', () => {
    const cmp = (a, b) => bootstrap(`_semver_cmp ${a} ${b}`).stdout.trim();
    assert.equal(cmp('v1.10.0', 'v1.9.0'), '1', '1.10.0 must be newer than 1.9.0');
    assert.equal(cmp('v1.2.0-beta.1', 'v1.2.0'), '-1', 'a prerelease precedes its release');
    assert.equal(cmp('v1.2.0-beta.10', 'v1.2.0-beta.2'), '1', 'beta.10 must be newer than beta.2');
    assert.equal(cmp('v1.2.3', 'v1.2.3'), '0');
  });

  test('stable selects the newest release and ignores prereleases', () => {
    const result = bootstrap('_latest_release stable', { GD_BOOTSTRAP_REPO: repo });
    assert.equal(result.stdout.trim(), 'v1.10.0');
  });

  test('beta also considers prereleases, in semver order', () => {
    const result = bootstrap('_latest_release beta', { GD_BOOTSTRAP_REPO: repo });
    assert.equal(result.stdout.trim(), 'v1.11.0-beta.10');
  });

  test('a repository with no releases fails rather than guessing', () => {
    const empty = join(dir, 'empty');
    copyWorktree(empty);
    git(empty, ['init', '-q', '-b', 'main']);
    git(empty, ['add', '-A']);
    git(empty, ['commit', '-q', '-m', 'no tags']);
    const result = bootstrap('_latest_release stable', { GD_BOOTSTRAP_REPO: empty });
    assert.notEqual(result.status, 0);
  });

  test('bootstrap.sh refuses a non-empty target directory', () => {
    const occupied = join(dir, 'occupied');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'something'), 'x');
    const result = run(join(REPO_DIR, 'bootstrap.sh'), ['--dir', occupied, '--ref', 'v1.10.0', '--local'], {
      env: { GD_BOOTSTRAP_REPO: repoUrl },
      timeout: 60_000,
    });
    assert.notEqual(result.status, 0);
    // Checked before the daemon probe: a wrong directory should be reported
    // straight away, not after waiting on Docker.
    assert.match(result.stderr, /is not empty/);
  });
});
