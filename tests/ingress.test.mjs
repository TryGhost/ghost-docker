// End-to-end smoke tests: a local site published on the loopback interface, a
// production site served over HTTPS by Caddy, Ghost readiness, and one-shot
// jobs that stay stopped after they complete.
//
// These start real containers and pull images. Set GD_TEST_INGRESS=1 to run
// them; they are skipped otherwise.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  tempDir, cleanup, makeSite, writeEnv, sh, shOk, compose, composeAsync,
  dockerAvailable, dockerInspect, waitFor, sleep, q,
} from './helpers.mjs';

const enabled = process.env.GD_TEST_INGRESS === '1' && dockerAvailable();
const skip = enabled ? false : 'set GD_TEST_INGRESS=1 with a working Docker daemon';

const GHOST_PORT = process.env.GD_TEST_GHOST_PORT ?? '23680';
const HTTP_PORT = process.env.GD_TEST_HTTP_PORT ?? '8080';
const HTTPS_PORT = process.env.GD_TEST_HTTPS_PORT ?? '8443';
const PROJECT = `ghost-docker-test-${process.pid}`;

// Edge-case characters, to prove the whole path from .env into the container.
const APP_PASSWORD = 'app p$ss"word';
const ROOT_PASSWORD = 'root-password';

let dir;
let site;

const commonEnv = () => ({
  COMPOSE_PROJECT_NAME: PROJECT,
  PROJECT_DIR: site,
  GHOST_IMAGE: 'ghost',
  GHOST_VERSION: process.env.GD_TEST_GHOST_VERSION ?? '6-next-alpine',
  GHOST_PORT,
  DATABASE_HOST: 'db',
  DATABASE_PORT: '3306',
  DATABASE_NAME: 'ghost',
  DATABASE_USER: 'ghost',
  DATABASE_PASSWORD: APP_PASSWORD,
  DATABASE_ROOT_PASSWORD: ROOT_PASSWORD,
  UPLOAD_LOCATION: join(site, 'data', 'ghost'),
  MYSQL_DATA_LOCATION: join(site, 'data', 'mysql'),
});

const serviceId = (name) => compose(site, ['ps', '-q', name]).stdout.trim();

/** Wait for a service's health check to report healthy. Fails fast if it exits. */
const waitHealthy = (name, timeoutMs) =>
  waitFor(() => {
    const id = serviceId(name);
    if (!id) return false;
    if (dockerInspect(id, '{{.State.Running}}') !== 'true') {
      throw new Error(`${name} stopped while waiting for it to become healthy`);
    }
    return dockerInspect(id, '{{.State.Health.Status}}') === 'healthy';
  }, { timeoutMs });

/** Run a snippet of Node inside the Ghost container and return its stdout. */
const inGhost = async (script) => {
  const { stdout } = await composeAsync(site, ['exec', '-T', 'ghost', 'node', '-e', script]);
  return stdout.trim();
};

describe('ingress smoke tests', { skip, concurrency: 1 }, () => {
  before(() => {
    dir = tempDir('ingress');
    site = makeSite(dir);
  });
  after(() => {
    if (site) compose(site, ['down', '-v', '--remove-orphans']);
    if (dir) cleanup(dir);
  });

  describe('local mode', () => {
    before(async () => {
      writeEnv(join(site, '.env'), {
        ...commonEnv(),
        COMPOSE_PROFILES: 'local',
        SITE_MODE: 'local',
        NODE_ENV: 'development',
        URL: `http://localhost:${GHOST_PORT}`,
        RESTART_POLICY: 'no',
      });
      const result = compose(site, ['up', '-d']);
      assert.equal(result.status, 0, result.stderr);
    });
    after(() => compose(site, ['down', '-v', '--remove-orphans']));

    test('the configuration validates', () => {
      const result = sh(`config_validate ${q(site)}`);
      assert.equal(result.status, 0, result.stdout.toString());
    });

    test('the database becomes healthy', async () => {
      assert.ok(await waitHealthy('db', 300_000), 'db never became healthy');
    });

    test('Ghost reports ready through its readiness probe', async () => {
      assert.ok(await waitHealthy('ghost', 420_000), 'ghost never became healthy');
    });

    test('Ghost answers on the published loopback port', async () => {
      const response = await fetch(`http://127.0.0.1:${GHOST_PORT}/ghost/api/admin/site/`);
      assert.equal(response.status, 200);
      assert.ok((await response.json()).site, 'no site payload');
    });

    test('Ghost is published on the loopback interface only', () => {
      const bindings = JSON.parse(dockerInspect(serviceId('ghost'), '{{json .HostConfig.PortBindings}}'));
      const hosts = Object.values(bindings).flat().map((b) => b.HostIp);
      assert.deepEqual(hosts, ['127.0.0.1']);
    });

    test('the container received the exact database password', async () => {
      const encoded = await inGhost(
        'process.stdout.write(Buffer.from(process.env.database__connection__password).toString("base64"))',
      );
      assert.equal(Buffer.from(encoded, 'base64').toString(), APP_PASSWORD);
    });

    test('the container received no infrastructure root credentials', async () => {
      const env = await inGhost('process.stdout.write(JSON.stringify(process.env))');
      const parsed = JSON.parse(env);
      assert.equal(parsed.DATABASE_ROOT_PASSWORD, undefined);
      assert.equal(parsed.MYSQL_ROOT_PASSWORD, undefined);
      assert.ok(
        !Object.values(parsed).includes(ROOT_PASSWORD),
        'the MySQL root password reached the Ghost container',
      );
    });
  });

  describe('production mode', () => {
    before(async () => {
      writeEnv(join(site, '.env'), {
        ...commonEnv(),
        COMPOSE_PROFILES: 'production,activitypub',
        SITE_MODE: 'production',
        NODE_ENV: 'production',
        URL: 'https://ghost.test',
        DOMAIN: 'ghost.test',
        RESTART_POLICY: 'unless-stopped',
        HTTP_PORT,
        HTTPS_PORT,
      });
      // `ghost.test` is not a public name, so issue from Caddy's internal CA
      // rather than attempting a real ACME order.
      writeFileSync(join(site, 'caddy', 'global', 'tls.caddy'), 'local_certs\n');

      const applied = sh(`caddy_apply ${q(site)}`);
      assert.equal(applied.status, 0, applied.stderr.toString());

      const result = compose(site, ['up', '-d']);
      assert.equal(result.status, 0, result.stderr);
    });

    test('the configuration validates', () => {
      const result = sh(`config_validate ${q(site)}`);
      assert.equal(result.status, 0, result.stdout.toString());
    });

    test('the database becomes healthy', async () => {
      assert.ok(await waitHealthy('db', 300_000), 'db never became healthy');
    });

    test('Ghost reports ready through its readiness probe', async () => {
      assert.ok(await waitHealthy('ghost', 420_000), 'ghost never became healthy');
    });

    test('Caddy routes the site domain and reloads explicitly', () => {
      assert.ok(sh(`caddy_running ${q(site)}`).status === 0, 'caddy is not running');
      assert.equal(sh(`caddy_verify ${q(site)} ghost.test`).status, 0);
      assert.equal(sh(`caddy_reload ${q(site)}`).status, 0);
    });

    test('HTTPS through Caddy reaches Ghost', async () => {
      // From inside the network, with the correct SNI and Host. Trusting
      // Caddy's internal CA is unnecessary for a routing check.
      const out = await inGhost(`
        const https = require("https");
        const req = https.request({
          host: "caddy", port: 443, servername: "ghost.test",
          path: "/ghost/api/admin/site/", headers: { Host: "ghost.test" },
          rejectUnauthorized: false, timeout: 20000,
        }, (res) => {
          let body = "";
          res.on("data", (c) => { body += c; });
          res.on("end", () => process.stdout.write(JSON.stringify({ status: res.statusCode, body })));
        });
        req.on("error", (e) => process.stdout.write(JSON.stringify({ error: e.message })));
        req.end();
      `);
      const result = JSON.parse(out);
      assert.equal(result.status, 200, out);
      assert.ok(JSON.parse(result.body).site, 'no site payload through Caddy');
    });

    test('plain HTTP is redirected to HTTPS', async () => {
      const out = await inGhost(`
        require("http").get(
          { host: "caddy", port: 80, path: "/", headers: { Host: "ghost.test" } },
          (res) => process.stdout.write(JSON.stringify({ status: res.statusCode, location: res.headers.location })),
        ).on("error", (e) => process.stdout.write(JSON.stringify({ error: e.message })));
      `);
      const result = JSON.parse(out);
      assert.ok(result.status >= 300 && result.status < 400, out);
      assert.match(result.location ?? '', /^https:\/\/ghost\.test/);
    });

    test('the ActivityPub migration job completed and stays stopped', async () => {
      const id = compose(site, ['ps', '-a', '-q', 'activitypub-migrate']).stdout.trim();
      assert.ok(id, 'the one-shot migration container was not created');
      assert.equal(
        dockerInspect(id, '{{.State.Status}} {{.State.ExitCode}} {{.HostConfig.RestartPolicy.Name}}'),
        'exited 0 no',
      );
      await sleep(10_000);
      assert.equal(dockerInspect(id, '{{.State.Status}}'), 'exited');
    });

    test('long-running services keep the site restart policy', () => {
      assert.equal(dockerInspect(serviceId('ghost'), '{{.HostConfig.RestartPolicy.Name}}'), 'unless-stopped');
      assert.equal(dockerInspect(serviceId('db'), '{{.HostConfig.RestartPolicy.Name}}'), 'unless-stopped');
    });

    test('container logs are capped', () => {
      const config = JSON.parse(dockerInspect(serviceId('ghost'), '{{json .HostConfig.LogConfig}}'));
      assert.ok(config.Config['max-size']);
      assert.ok(config.Config['max-file']);
    });
  });
});
