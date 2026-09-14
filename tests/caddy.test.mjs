// Caddy route generation, validation and installation.
//
// Rendering needs no Docker; validation and the missing-argument guard use the
// Caddy image.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, cleanup, makeSite, writeEnv, sh, shOk, shSucceeds, dockerAvailable, q } from './helpers.mjs';

const CADDY_ROOT = '/etc/caddy';
const STAGED_SITES = `${CADDY_ROOT}/.staging/sites`;

describe('caddy.sh', () => {
  let dir;
  let site;

  before(() => {
    dir = tempDir('caddy');
    site = makeSite(dir);
  });
  after(() => cleanup(dir));

  const setup = (overrides = {}) =>
    writeEnv(join(site, '.env'), {
      COMPOSE_PROFILES: 'production',
      SITE_MODE: 'production',
      COMPOSE_PROJECT_NAME: 'ghost-example-com',
      PROJECT_DIR: site,
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
      ...overrides,
    });

  const render = () => {
    const result = sh(`caddy_render ${q(site)}`);
    assert.equal(result.status, 0, result.stderr.toString());
    return readFileSync(join(site, 'caddy', '.staging', 'sites', 'site.caddy'), 'utf8');
  };

  describe('rendering', () => {
    beforeEach(() => setup());

    test('a plain production site', () => {
      const routes = render();
      assert.match(routes, /^example\.com \{$/m);
      assert.match(routes, /reverse_proxy ghost-ghost-example-com:2368/);
      // The bare service name must never be used for addressing.
      assert.doesNotMatch(routes, /reverse_proxy ghost:2368/);
      assert.match(routes, /import \/etc\/caddy\/snippets\/SecurityHeaders ""/);
      assert.match(routes, /import \/etc\/caddy\/snippets\/ActivityPub https:\/\/ap\.ghost\.org/);
      assert.doesNotMatch(routes, /TrafficAnalytics/);
      assert.doesNotMatch(routes, /\{\{|\$\{/, 'an unsubstituted placeholder reached the output');
    });

    test('optional profiles point at this site\'s own services', () => {
      setup({ COMPOSE_PROFILES: 'production,analytics,activitypub' });
      const routes = render();
      assert.match(routes, /import \/etc\/caddy\/snippets\/TrafficAnalytics traffic-analytics-ghost-example-com:3000/);
      assert.match(routes, /import \/etc\/caddy\/snippets\/ActivityPub activitypub-ghost-example-com:8080/);
      assert.doesNotMatch(routes, /ap\.ghost\.org/);
    });

    test('an admin domain gets its own block and the frame-ancestors argument', () => {
      setup({ ADMIN_DOMAIN: 'admin.example.com', WWW_REDIRECT: 'www.example.com' });
      const routes = render();
      assert.match(routes, /^admin\.example\.com \{$/m);
      assert.match(routes, /import \/etc\/caddy\/snippets\/SecurityHeaders "admin\.example\.com"/);
      assert.match(routes, /redir https:\/\/example\.com\{uri\}/);
    });

    test('local mode renders no routes at all', () => {
      setup({ COMPOSE_PROFILES: 'local', SITE_MODE: 'local', URL: 'http://localhost:2368', DOMAIN: undefined });
      assert.ok(!shSucceeds(`caddy_render ${q(site)}`));
    });
  });

  describe('validation', { skip: dockerAvailable() ? false : 'docker is not available' }, () => {
    beforeEach(() => {
      setup({ COMPOSE_PROFILES: 'production,analytics,activitypub' });
      render();
      for (const f of readdirSync(join(site, 'caddy', 'custom'))) {
        if (f.endsWith('.caddy')) rmSync(join(site, 'caddy', 'custom', f));
      }
    });

    const validate = (sites = STAGED_SITES) => sh(`caddy_validate ${q(site)} ${q(sites)}`);

    test('the candidate configuration validates', () => {
      assert.equal(validate().status, 0, validate().stderr.toString());
    });

    test('operator routes are validated alongside the generated ones', () => {
      writeFileSync(
        join(site, 'caddy', 'custom', 'extra.caddy'),
        'status.example.com {\n\timport /etc/caddy/snippets/Logging\n\trespond "ok" 200\n}\n',
      );
      assert.equal(validate().status, 0);

      writeFileSync(join(site, 'caddy', 'custom', 'broken.caddy'), 'this is not a caddyfile {\n');
      assert.notEqual(validate().status, 0, 'a broken operator route must fail validation');
    });

    test('global options are validated alongside the generated routes', () => {
      writeFileSync(join(site, 'caddy', 'global', 'tls.caddy'), 'local_certs\n');
      assert.equal(validate().status, 0);
      writeFileSync(join(site, 'caddy', 'global', 'tls.caddy'), 'not_a_global_option\n');
      assert.notEqual(validate().status, 0);
      rmSync(join(site, 'caddy', 'global', 'tls.caddy'));
    });

    test('a missing import argument is an error, not a warning', () => {
      // Caddy only warns about this during adaptation, and the resulting
      // server misbehaves at runtime.
      const staged = join(site, 'caddy', '.staging', 'sites', 'site.caddy');
      writeFileSync(staged, readFileSync(staged, 'utf8').replace(' ""', ''));
      const result = validate();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr.toString(), /missing an argument/);
    });

    test('no generated routes at all is an error', () => {
      const stagedDir = join(site, 'caddy', '.staging', 'sites');
      for (const f of readdirSync(stagedDir)) rmSync(join(stagedDir, f));
      assert.notEqual(validate().status, 0);
    });
  });

  describe('install and restore', { skip: dockerAvailable() ? false : 'docker is not available' }, () => {
    test('installs, validates in place, and can be rolled back', () => {
      setup();
      render();
      shOk(`caddy_install ${q(site)}`);

      const live = join(site, 'caddy', 'sites', 'site.caddy');
      const installed = readFileSync(live, 'utf8');
      assert.match(installed, /reverse_proxy ghost-ghost-example-com:2368/);
      assert.equal(sh(`caddy_validate ${q(site)}`).status, 0);

      setup({ DOMAIN: 'changed.example.com', URL: 'https://changed.example.com' });
      render();
      const backup = shOk(`caddy_install ${q(site)}`).trim();
      assert.match(readFileSync(live, 'utf8'), /^changed\.example\.com \{$/m);

      shOk(`caddy_restore ${q(site)} ${q(backup)}`);
      assert.equal(readFileSync(live, 'utf8'), installed);
    });
  });
});
