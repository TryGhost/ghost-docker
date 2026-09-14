// Exercise the real optional-service dependency graph with disposable commands,
// without provisioning Tinybird credentials or running remote schema changes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  tempDir, cleanup, makeSite, writeEnv, compose, composeConfig,
  composeBinaries, dockerAvailable,
} from './helpers.mjs';

const jobs = ['activitypub-migrate', 'tinybird-login', 'tinybird-sync', 'tinybird-deploy'];

describe('Compose readiness contract', { skip: !dockerAvailable() }, () => {
  for (const { label, bin } of composeBinaries()) {
    for (const failure of [null, 'activitypub-migrate', 'ghost']) {
      test(`${label}: ${failure ? `rejects failed ${failure}` : 'waits for health and completed jobs'}`, () => {
        const dir = tempDir('gd-readiness');
        const site = makeSite(dir);
        try {
          writeEnv(join(site, '.env'), {
            COMPOSE_PROFILES: 'local,analytics,activitypub',
            COMPOSE_PROJECT_NAME: `gd-ready-${process.pid}-${failure || 'success'}`,
            URL: 'http://localhost:2368', DATABASE_PASSWORD: 'test', DATABASE_ROOT_PASSWORD: 'test',
          });
          const original = composeConfig(site, { bin });
          const services = Object.fromEntries(Object.entries(original.services).map(([name, service]) => {
            const job = jobs.includes(name);
            return [name, {
              image: 'alpine:3.20',
              restart: 'no',
              stop_grace_period: '1s',
              depends_on: service.depends_on,
              command: ['sh', '-c', job
                ? `exit ${name === failure ? 1 : 0}`
                : 'sleep 1; touch /tmp/ready; exec sleep 300'],
              ...(!job && {
                healthcheck: {
                  test: ['CMD-SHELL', name === failure ? 'exit 1' : 'test -f /tmp/ready'],
                  interval: '1s', timeout: '1s', retries: 3,
                },
              }),
            }];
          }));
          writeFileSync(join(site, 'compose.yml'), JSON.stringify({ services }));
          const result = compose(site, ['up', '--wait', '--wait-timeout', '15'], { bin });
          if (failure) {
            assert.notEqual(result.status, 0, result.stdout + result.stderr);
            assert.match(result.stderr, new RegExp(`${failure}|unhealthy|failed`));
          } else {
            assert.equal(result.status, 0, result.stderr);
            const ps = compose(site, ['ps', '-a', '--format', 'json'], { bin });
            assert.equal(ps.status, 0, ps.stderr);
            const rows = ps.stdout.trim().startsWith('[')
              ? JSON.parse(ps.stdout) : ps.stdout.trim().split('\n').map(JSON.parse);
            for (const name of jobs) {
              const row = rows.find((r) => r.Service === name);
              assert.equal(row?.State, 'exited', name);
              assert.equal(row?.ExitCode, 0, name);
            }
            for (const name of ['ghost', 'db']) {
              assert.equal(rows.find((r) => r.Service === name)?.Health, 'healthy', name);
            }
          }
        } finally {
          compose(site, ['down', '-v', '--remove-orphans', '--timeout', '1'], { bin });
          cleanup(dir);
        }
      });
    }
  }
});
