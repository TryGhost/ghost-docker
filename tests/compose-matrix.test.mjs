// Every supported mode / optional-service combination, resolved by Compose
// itself, on the declared minimum Compose and on the installed one.
//
// Set GD_TEST_MIN_COMPOSE to a Compose binary at the declared minimum version
// to include it in the matrix.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
  tempDir, cleanup, makeSite, writeEnv, compose, composeConfig,
  composeBinaries, dockerAvailable, sh, shOk, q,
} from './helpers.mjs';

const LONG_RUNNING = ['ghost', 'db', 'caddy', 'traffic-analytics', 'activitypub'];
const ONE_SHOT = ['activitypub-migrate', 'tinybird-login', 'tinybird-sync', 'tinybird-deploy'];

const MATRIX = [
  { profiles: 'local', mode: 'local', services: ['db', 'ghost'] },
  { profiles: 'local,analytics', mode: 'local', services: ['db', 'ghost', 'tinybird-deploy', 'tinybird-login', 'tinybird-sync', 'traffic-analytics'] },
  { profiles: 'local,activitypub', mode: 'local', services: ['activitypub', 'activitypub-migrate', 'db', 'ghost'] },
  { profiles: 'local,analytics,activitypub', mode: 'local', services: ['activitypub', 'activitypub-migrate', 'db', 'ghost', 'tinybird-deploy', 'tinybird-login', 'tinybird-sync', 'traffic-analytics'] },
  { profiles: 'production', mode: 'production', services: ['caddy', 'db', 'ghost'] },
  { profiles: 'production,analytics', mode: 'production', services: ['caddy', 'db', 'ghost', 'tinybird-deploy', 'tinybird-login', 'tinybird-sync', 'traffic-analytics'] },
  { profiles: 'production,activitypub', mode: 'production', services: ['activitypub', 'activitypub-migrate', 'caddy', 'db', 'ghost'] },
  { profiles: 'production,analytics,activitypub', mode: 'production', services: ['activitypub', 'activitypub-migrate', 'caddy', 'db', 'ghost', 'tinybird-deploy', 'tinybird-login', 'tinybird-sync', 'traffic-analytics'] },
];

// Edge-case literals, to prove the whole path from .env into the resolved
// service configuration.
const APP_PASSWORD = 'app-p$ss"word';
const ROOT_PASSWORD = 'root-p@ss word';
const SMTP_PASSWORD = 'smtp-p$ss';

// `docker compose config` output is itself a compose file, so it re-escapes a
// literal `$` as `$$`. Container fidelity is proven in env-compose.test.mjs and
// ingress.test.mjs, which read the value back out of a running container.
const asComposeConfigEscapes = (value) => value.replaceAll('$', () => '$$');

describe('compose mode matrix', { skip: dockerAvailable() ? false : 'docker is not available' }, () => {
  let dir;
  let site;

  before(() => {
    dir = tempDir('matrix');
    site = makeSite(dir);
    // Application configuration, the only env_file of the ghost service.
    const ghostEnv = join(site, 'ghost.env');
    writeFileSync(ghostEnv, '', { mode: 0o600 });
    chmodSync(ghostEnv, 0o600);
    shOk(`env_set ${q(ghostEnv)} mail__transport SMTP`);
    shOk(`env_set ${q(ghostEnv)} mail__options__auth__pass ${q(SMTP_PASSWORD)}`);
  });
  after(() => cleanup(dir));

  const setup = ({ profiles, mode }) =>
    writeEnv(join(site, '.env'), {
      COMPOSE_PROFILES: profiles,
      SITE_MODE: mode,
      COMPOSE_PROJECT_NAME: 'ghost-example-com',
      PROJECT_DIR: site,
      GHOST_IMAGE: 'ghost',
      GHOST_VERSION: '6-next-alpine',
      GHOST_PORT: '2368',
      DATABASE_HOST: 'db',
      DATABASE_PORT: '3306',
      DATABASE_NAME: 'ghost',
      DATABASE_USER: 'ghost',
      DATABASE_PASSWORD: APP_PASSWORD,
      DATABASE_ROOT_PASSWORD: ROOT_PASSWORD,
      UPLOAD_LOCATION: './data/ghost',
      MYSQL_DATA_LOCATION: './data/mysql',
      ...(mode === 'production'
        ? { NODE_ENV: 'production', URL: 'https://example.com', DOMAIN: 'example.com', RESTART_POLICY: 'unless-stopped' }
        : { NODE_ENV: 'development', URL: 'http://localhost:2368', RESTART_POLICY: 'no' }),
    });

  for (const { label, bin } of composeBinaries()) {
    describe(label, () => {
      for (const entry of MATRIX) {
        describe(entry.profiles, () => {
          let config;
          let ghost;

          before(() => {
            setup(entry);
            config = composeConfig(site, { bin });
            ghost = config.services.ghost;
          });

          test('enables exactly the expected services', () => {
            assert.deepEqual(Object.keys(config.services).sort(), entry.services);
          });

          test('Ghost receives no infrastructure root credentials', () => {
            const serialized = JSON.stringify(ghost);
            assert.doesNotMatch(serialized, /root-p@ss word/);
            assert.doesNotMatch(serialized, /DATABASE_ROOT_PASSWORD/);
            assert.doesNotMatch(serialized, /MYSQL_ROOT_PASSWORD/);
          });

          test('Ghost receives no operator-only settings', () => {
            for (const key of ['COMPOSE_PROFILES', 'COMPOSE_PROJECT_NAME', 'PROJECT_DIR',
              'RESTART_POLICY', 'UPLOAD_LOCATION', 'MYSQL_DATA_LOCATION', 'LOG_MAX_SIZE', 'SITE_MODE']) {
              assert.equal(ghost.environment[key], undefined, `${key} reached Ghost`);
            }
          });

          test('ghost.env reaches Ghost and nothing else', () => {
            assert.equal(ghost.environment.mail__transport, 'SMTP');
            assert.equal(
              ghost.environment.mail__options__auth__pass,
              asComposeConfigEscapes(SMTP_PASSWORD),
            );
            assert.equal(config.services.db.environment.mail__transport, undefined);
          });

          test('the application database password reaches Ghost', () => {
            assert.equal(
              ghost.environment.database__connection__password,
              asComposeConfigEscapes(APP_PASSWORD),
            );
          });

          test('the database connection is fully parameterized', () => {
            assert.equal(ghost.environment.database__client, 'mysql');
            assert.equal(ghost.environment.database__connection__host, 'db');
            assert.equal(ghost.environment.database__connection__port, '3306');
            assert.equal(ghost.environment.database__connection__user, 'ghost');
            assert.equal(ghost.environment.database__connection__database, 'ghost');
          });

          test('services have unique network aliases', () => {
            const aliases = (name) => config.services[name]?.networks?.ghost_network?.aliases ?? [];
            assert.ok(aliases('ghost').includes('ghost-ghost-example-com'));
            assert.ok(aliases('db').includes('db-ghost-example-com'));
            if (entry.services.includes('activitypub')) {
              assert.ok(aliases('activitypub').includes('activitypub-ghost-example-com'));
            }
            if (entry.services.includes('traffic-analytics')) {
              assert.ok(aliases('traffic-analytics').includes('traffic-analytics-ghost-example-com'));
            }
          });

          test('Ghost publishes on the loopback interface only', () => {
            assert.deepEqual(ghost.ports.map((p) => p.host_ip), ['127.0.0.1']);
            assert.equal(ghost.ports[0].target, 2368);
          });

          test('Ghost has a real readiness probe', () => {
            assert.ok(ghost.healthcheck?.test?.length, 'no healthcheck');
            assert.ok(ghost.healthcheck.start_interval, 'no start_interval');
          });

          test('long-running services use the site restart policy', () => {
            const expected = entry.mode === 'local' ? 'no' : 'unless-stopped';
            for (const name of LONG_RUNNING.filter((n) => entry.services.includes(n))) {
              assert.equal(config.services[name].restart, expected, name);
            }
          });

          test('one-shot jobs stay one-shot', () => {
            for (const name of ONE_SHOT.filter((n) => entry.services.includes(n))) {
              assert.equal(config.services[name].restart, 'no', name);
            }
          });

          test('every service caps its logs and carries site labels', () => {
            for (const [name, service] of Object.entries(config.services)) {
              assert.ok(service.logging?.options?.['max-size'], `${name} has no log cap`);
              assert.ok(service.logging?.options?.['max-file'], `${name} has no log file limit`);
              assert.equal(service.labels['org.ghost.docker.site'], 'ghost-example-com', name);
              assert.equal(service.labels['org.ghost.docker.mode'], entry.mode, name);
              assert.equal(
                service.labels['org.ghost.docker.lifecycle'],
                ONE_SHOT.includes(name) ? 'one-shot' : 'long-running',
                name,
              );
            }
          });
        });
      }
    });
  }

  test('the IPv6 override loads through the helper file contract', () => {
    setup(MATRIX.find((m) => m.profiles === 'production'));
    const result = sh(`compose_run ${q(site)} config --format json`, {
      env: { GD_COMPOSE_OVERRIDES: 'compose.ipv6.yml' },
    });
    assert.equal(result.status, 0, result.stderr.toString());
    const config = JSON.parse(result.stdout.toString());
    assert.equal(config.networks.ghost_network.enable_ipv6, true);
  });

  test('an unset COMPOSE_FILE cannot change the helper file list', () => {
    setup(MATRIX.find((m) => m.profiles === 'production'));
    const result = sh(`compose_run ${q(site)} config --services`, {
      env: { COMPOSE_FILE: '/nonexistent/compose.yml' },
    });
    assert.equal(result.status, 0, result.stderr.toString());
  });

  test('URL is required in every supported mode', () => {
    setup(MATRIX.find((m) => m.profiles === 'production'));
    shOk(`env_unset ${q(join(site, '.env'))} URL`);
    const result = compose(site, ['config']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /URL is required/);
  });

  test('DOMAIN is not guarded, so local mode is unaffected by it', () => {
    setup(MATRIX.find((m) => m.profiles === 'local'));
    const result = compose(site, ['config']);
    assert.equal(result.status, 0, result.stderr);
  });
});
