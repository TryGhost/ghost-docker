import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, cleanup, REPO_DIR, q } from './helpers.mjs';

const exec = promisify(execFile);

test('HTTP probes preserve Host and status, ignoring curl config and proxies', async () => {
  const dir = tempDir('gd-probe');
  const server = createServer((req, res) => {
    if (req.headers.host !== 'ghost.test') {
      res.writeHead(400).end();
    } else if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/ok' }).end();
    } else {
      res.writeHead(req.url === '/failure' ? 503 : 200).end('response body');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // These settings would change the probe's result if curl loaded them.
  writeFileSync(join(dir, '.curlrc'), 'location\nfail\n');
  const probe = async (fn, path) =>
    (
      await exec(
        process.env.GD_TEST_BASH || 'bash',
        [
          '-c',
          `. ${q(join(REPO_DIR, 'scripts/lib/common.sh'))}\n${fn} 127.0.0.1 ${port} ${q(path)} ghost.test`,
        ],
        {
          env: {
            ...process.env,
            CURL_HOME: dir,
            http_proxy: 'http://127.0.0.1:1',
            ALL_PROXY: 'http://127.0.0.1:1',
          },
          timeout: 25_000,
        },
      )
    ).stdout;
  try {
    assert.equal((await probe('install_http_status', '/ok')).trim(), '200');
    assert.equal((await probe('install_http_status', '/redirect')).trim(), '302');
    assert.equal((await probe('install_http_status', '/failure')).trim(), '503');
    const headers = await probe('install_http_head', '/redirect');
    assert.match(headers, /^HTTP\/1\.1 302/);
    assert.match(headers, /location: \/ok/i);
    assert.doesNotMatch(headers, /response body/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanup(dir);
  }
});
