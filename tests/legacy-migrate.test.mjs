// Guards the legacy Ghost-CLI migration path, which still ships until
// `install.sh --import` replaces it (S2/S5).
//
// This exists because adding a root package.json with `"type": "module"` for
// the test suite silently broke scripts/config-to-env.js, which is CommonJS.
// Nothing caught it: the script has no consumer other than scripts/migrate.sh.
// The package.json is gone now, but the guard stays — it would catch the same
// breakage returning, and it does not depend on the file's extension.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { tempDir, cleanup, sh, shValue, q, REPO_DIR } from './helpers.mjs';

// Resolved from migrate.sh rather than hardcoded, so this tests the real
// invariant — the helper migrate.sh calls exists and runs — instead of one
// spelling of its filename.
const MIGRATE = readFileSync(join(REPO_DIR, 'scripts', 'migrate.sh'), 'utf8');
const REFERENCED = [...new Set([...MIGRATE.matchAll(/scripts\/(config-to-env\.[a-z]+)/g)].map((m) => m[1]))];
const SCRIPT = join(REPO_DIR, 'scripts', REFERENCED[0] ?? 'config-to-env.js');

describe('legacy migration helper', () => {
  test('converts a Ghost config.json into ghost.env assignments', () => {
    const dir = tempDir('legacy');
    try {
      const config = join(dir, 'config.production.json');
      writeFileSync(
        config,
        JSON.stringify({
          url: 'https://example.com',
          database: { client: 'mysql', connection: { password: 'secret' } },
          server: { port: 2368 },
          mail: {
            transport: 'SMTP',
            options: { secure: true, auth: { pass: 'p$ss"word' } },
          },
          labs: { publicAPI: true },
        }),
      );

      const out = execFileSync('node', [SCRIPT, config], { encoding: 'utf8' });
      const lines = out.trim().split('\n');

      // Container-owned keys are dropped; application settings are kept.
      assert.ok(!lines.some((l) => /^(url|database__|server__)/.test(l)), out);
      assert.ok(lines.includes('mail__transport="SMTP"'));
      assert.ok(lines.includes('labs__publicAPI="true"'));

      // A literal `$` must be written `$$`, or Compose eats it.
      assert.ok(lines.includes('mail__options__auth__pass="p$$ss\\"word"'), out);

      // And the round trip through the env parser must give the value back.
      const ghostEnv = join(dir, 'ghost.env');
      writeFileSync(ghostEnv, out);
      assert.equal(shValue(`env_get ${q(ghostEnv)} mail__options__auth__pass`).trim(), 'p$ss"word');
      assert.ok(sh(`env_lint ${q(ghostEnv)}`).status === 0, 'generated ghost.env fails its own lint');
    } finally {
      cleanup(dir);
    }
  });

  test('migrate.sh calls exactly one helper, and it exists', () => {
    assert.equal(REFERENCED.length, 1, `migrate.sh references ${REFERENCED.length} helpers: ${REFERENCED}`);
    assert.ok(existsSync(SCRIPT), `migrate.sh calls ${REFERENCED[0]}, which does not exist`);
  });
});
