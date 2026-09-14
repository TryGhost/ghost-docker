// The application/operator configuration split and its validation rules.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, cleanup, makeSite, sh, shOk, shSucceeds, writeEnv, q, REPO_DIR } from './helpers.mjs';

const productionEnv = (site) => ({
  PROJECT_DIR: site,
  COMPOSE_PROFILES: 'production',
  SITE_MODE: 'production',
  COMPOSE_PROJECT_NAME: 'ghost-example-com',
  NODE_ENV: 'production',
  URL: 'https://example.com',
  DOMAIN: 'example.com',
  RESTART_POLICY: 'unless-stopped',
  GHOST_VERSION: '6-next-alpine',
  DATABASE_HOST: 'db',
  DATABASE_NAME: 'ghost',
  DATABASE_USER: 'ghost',
  DATABASE_PASSWORD: 'app-password',
  DATABASE_ROOT_PASSWORD: 'root-password',
});

describe('site mode selection', () => {
  test('exactly one site mode is required', () => {
    assert.equal(shOk(`compose_site_mode production`).trim(), 'production');
    assert.equal(shOk(`compose_site_mode local,analytics,activitypub`).trim(), 'local');
    assert.ok(!shSucceeds(`compose_site_mode analytics`), 'no site mode');
    assert.ok(!shSucceeds(`compose_site_mode local,production`), 'two site modes');
  });

  test('unknown profiles are reported, reserved ones are not', () => {
    assert.equal(shOk(`compose_unknown_profiles production,analytics,bogus`).trim(), 'bogus');
    assert.equal(shOk(`compose_unknown_profiles production,supervisor`).trim(), '');
  });

  test('one-shot services are the ones that must keep restart: "no"', () => {
    assert.equal(
      shOk('printf %s "${GD_ONE_SHOT_SERVICES[*]}"'),
      'activitypub-migrate tinybird-login tinybird-sync tinybird-deploy',
    );
  });
});

describe('config_validate_env', () => {
  let dir;
  let site;
  let envFile;

  before(() => {
    dir = tempDir('config');
    site = join(dir, 'site');
    mkdirSync(site);
    envFile = join(site, '.env');
  });
  after(() => cleanup(dir));
  beforeEach(() => writeEnv(envFile, productionEnv(site)));

  const validate = () => sh(`config_validate_env ${q(site)}`);
  const expectRejected = (why) => {
    const result = validate();
    assert.notEqual(result.status, 0, `expected rejection: ${why}`);
    return result.stdout.toString();
  };

  test('a complete production .env validates', () => {
    const result = validate();
    assert.equal(result.status, 0, result.stdout.toString());
  });

  test('Compose guards URL itself, so validation does not duplicate it', () => {
    // In production, URL is still cross-checked against DOMAIN. In local mode
    // there is nothing to cross-check, so a missing URL is left to Compose's
    // own `:?` guard rather than reported twice.
    writeEnv(envFile, {
      ...productionEnv(site),
      DOMAIN: undefined,
      URL: undefined,
      COMPOSE_PROFILES: 'local',
      SITE_MODE: 'local',
      RESTART_POLICY: 'no',
    });
    assert.equal(validate().status, 0, validate().stdout.toString());
  });

  test('production requires DOMAIN', () => {
    shOk(`env_unset ${q(envFile)} DOMAIN`);
    assert.match(expectRejected('missing DOMAIN'), /DOMAIN is required/);
  });




  // URL scheme, port format and restart policy are left to Compose and Docker,
  // which reject them with clear errors of their own. What follows is only
  // what nothing else catches.
  test('URL and DOMAIN must agree', () => {
    shOk(`env_set ${q(envFile)} DOMAIN other.example.com`);
    assert.match(expectRejected('mismatched domain'), /disagree/);
  });




  test('an ActivityPub database that is never provisioned is rejected', () => {
    shOk(`env_set ${q(envFile)} ACTIVITYPUB_DATABASE_NAME ap_custom`);
    assert.match(expectRejected('unprovisioned database'), /DATABASE_EXTRA_DATABASES/);
    shOk(`env_set ${q(envFile)} DATABASE_EXTRA_DATABASES ap_custom`);
    assert.equal(validate().status, 0);
  });

  test('the image layout and the configured content path must agree', () => {
    // Derived from the image's own GHOST_CONTENT, not from the tag name, so a
    // future layout change is caught without updating a mapping. Skipped when
    // the images are not present locally.
    const probe = sh(`config_image_content_path ghost:6-next-alpine`);
    if (probe.status !== 0) return; // image not pulled

    shOk(`env_set ${q(envFile)} GHOST_VERSION 6-next-alpine`);
    shOk(`env_set ${q(envFile)} GHOST_CONTENT_PATH /var/lib/ghost/content`);
    assert.match(expectRejected('old path with next image'), /GHOST_CONTENT_PATH is/);

    shOk(`env_set ${q(envFile)} GHOST_CONTENT_PATH ${probe.stdout.toString().trim()}`);
    assert.equal(validate().status, 0, validate().stdout.toString());
  });

  test('a value Compose would interpolate by accident is rejected', () => {
    appendFileSync(envFile, 'INTERPOLATED=costs $5\n');
    assert.match(expectRejected('unescaped dollar'), /interpolated by Compose/);
  });

  test('SITE_MODE must match COMPOSE_PROFILES', () => {
    shOk(`env_set ${q(envFile)} SITE_MODE local`);
    assert.match(expectRejected('mode mismatch'), /does not match/);
  });

  test('a local site is valid with no DOMAIN', () => {
    writeEnv(envFile, {
      ...productionEnv(site),
      DOMAIN: undefined,
      COMPOSE_PROFILES: 'local',
      SITE_MODE: 'local',
      NODE_ENV: 'development',
      URL: 'http://localhost:2368',
      GHOST_PORT: '2368',
      RESTART_POLICY: 'no',
    });
    const result = validate();
    assert.equal(result.status, 0, result.stdout.toString());
  });
});

describe('config_validate_ghost_env', () => {
  let dir;
  let site;
  let ghostEnv;

  before(() => {
    dir = tempDir('ghost-env');
    // A real site: the container-owned check resolves the actual Compose
    // configuration rather than consulting a hardcoded list.
    site = makeSite(dir);
    writeEnv(join(site, '.env'), productionEnv(site));
    ghostEnv = join(site, 'ghost.env');
  });
  after(() => cleanup(dir));
  beforeEach(() => {
    writeFileSync(ghostEnv, '', { mode: 0o600 });
    chmodSync(ghostEnv, 0o600);
    shOk(`env_set ${q(ghostEnv)} mail__transport SMTP`);
    shOk(`env_set ${q(ghostEnv)} labs__publicAPI true`);
  });

  const validate = () => sh(`config_validate_ghost_env ${q(site)}`);

  test('application settings are accepted', () => {
    assert.equal(validate().status, 0, validate().stdout.toString());
  });

  for (const key of ['url', 'admin__url', 'database__connection__host', 'server__port', 'NODE_ENV']) {
    test(`the container-owned key ${key} is rejected`, () => {
      shOk(`env_set ${q(ghostEnv)} ${q(key)} anything`);
      const result = validate();
      assert.notEqual(result.status, 0);
      assert.match(result.stdout.toString(), /set by the container/);
    });
  }

  for (const key of ['DATABASE_ROOT_PASSWORD', 'COMPOSE_PROFILES', 'PROJECT_DIR']) {
    test(`the operator-only key ${key} is rejected`, () => {
      shOk(`env_set ${q(ghostEnv)} ${q(key)} anything`);
      const result = validate();
      assert.notEqual(result.status, 0);
      assert.match(result.stdout.toString(), /operator setting/);
    });
  }

  test('a key added to compose.yml is caught with no list to update', () => {
    // The whole reason this is derived rather than listed: add an environment
    // entry to the ghost service and validation must notice immediately.
    const composeFile = join(site, 'compose.yml');
    const original = readFileSync(composeFile, 'utf8');
    try {
      writeFileSync(
        composeFile,
        original.replace('      database__client: mysql', '      database__client: mysql\n      brand__new__key: owned-by-container'),
      );
      shOk(`env_set ${q(ghostEnv)} brand__new__key mine`);
      const result = validate();
      assert.notEqual(result.status, 0);
      assert.match(result.stdout.toString(), /brand__new__key is set by the container \(owned-by-container\)/);
    } finally {
      writeFileSync(composeFile, original);
    }
  });

  test('ghost.env is optional', () => {
    rmSync(ghostEnv);
    assert.equal(validate().status, 0);
  });
});

describe('scripts/config.sh set', () => {
  test('logs the key name and never the value', () => {
    const dir = tempDir('secret-log');
    try {
      const file = join(dir, 'ghost.env');
      writeFileSync(file, '', { mode: 0o600 });
      // The helpers use bash features (arrays, process substitution), so the
      // CLI must be run with its own shebang, not forced through sh.
      const result = sh(
        `${q(join(REPO_DIR, 'scripts/config.sh'))} set ${q(file)} mail__options__auth__pass hunter2`,
      );
      assert.equal(result.status, 0, result.stderr.toString());
      const logged = result.stdout.toString() + result.stderr.toString();
      assert.match(logged, /mail__options__auth__pass/);
      assert.doesNotMatch(logged, /hunter2/, 'a value was logged');
      // The value still reached the file.
      assert.equal(readFileSync(file, 'utf8').trim(), 'mail__options__auth__pass="hunter2"');
    } finally {
      cleanup(dir);
    }
  });
});
