import { execFileSync, execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = join(TESTS_DIR, '..');

const LIBS = ['fs', 'env', 'compose', 'config', 'caddy'];

/**
 * Run a bash snippet with every ghost-docker library sourced.
 *
 * The libraries under test are shell, so they are exercised through a real
 * shell. Everything around them — building fixtures, parsing structured
 * output, asserting — is JavaScript.
 *
 * Returns { stdout, stderr, status }. Throws only if the shell itself cannot
 * be started.
 */
export function sh(script, { cwd = REPO_DIR, env = {}, input } = {}) {
  const preamble = LIBS.map((l) => `. "${REPO_DIR}/scripts/lib/${l}.sh"`).join('\n');
  const result = spawnSync('bash', ['-c', `${preamble}\n${script}`], {
    cwd,
    input,
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return {
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    status: result.status,
  };
}

/** Run a shell snippet and return its trimmed stdout, failing the call on a non-zero exit. */
export function shOk(script, options) {
  const result = sh(script, options);
  if (result.status !== 0) {
    throw new Error(`shell exited ${result.status}: ${result.stderr.toString()}${result.stdout.toString()}`);
  }
  return result.stdout.toString();
}

/** True when the snippet exits zero. */
export function shSucceeds(script, options) {
  return sh(script, options).status === 0;
}

/** Shell-quote a value for single-quoted embedding. */
export function q(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Read a value back byte-exactly, including trailing newlines, by having the
 * shell base64 it. `$(...)` would strip trailing newlines.
 */
export function shValue(script, options) {
  const out = shOk(`{ ${script} ; } | base64 | tr -d '\\n'`, options);
  return Buffer.from(out.trim(), 'base64').toString();
}

export function tempDir(prefix = 'ghost-docker-test') {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return dir;
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Copy the pieces of the repo a site needs into a scratch directory. */
export function makeSite(dir, { withGhostEnv = false } = {}) {
  const site = join(dir, 'site');
  cpSync(join(REPO_DIR, 'compose.yml'), join(site, 'compose.yml'), { recursive: true });
  cpSync(join(REPO_DIR, 'compose.ipv6.yml'), join(site, 'compose.ipv6.yml'));
  for (const sub of ['caddy', 'mysql-init', 'tinybird']) {
    cpSync(join(REPO_DIR, sub), join(site, sub), { recursive: true });
  }
  // Start with no generated routes, whatever the developer's tree contains.
  rmSync(join(site, 'caddy', 'sites'), { recursive: true, force: true });
  mkdirSync(join(site, 'caddy', 'sites'), { recursive: true });
  if (withGhostEnv) {
    writeFileSync(join(site, 'ghost.env'), '', { mode: 0o600 });
  }
  return site;
}

/** Write a `.env` from a plain object, using the library's own serializer. */
export function writeEnv(file, values) {
  writeFileSync(file, '', { mode: 0o600 });
  chmodSync(file, 0o600);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    shOk(`env_set ${q(file)} ${q(key)} ${q(value)}`);
  }
}

/** Run `docker compose` for a site directory. `bin` may be a path to another Compose. */
export function compose(site, args, { bin, env = {} } = {}) {
  const base = ['--project-directory', site, '-f', join(site, 'compose.yml')];
  const command = bin ?? 'docker';
  const argv = bin ? [...base, ...args] : ['compose', ...base, ...args];
  try {
    const stdout = execFileSync(command, argv, {
      encoding: 'utf8',
      env: { ...process.env, ...env, COMPOSE_FILE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    if (error.status === undefined) throw error;
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', status: error.status };
  }
}

/** The fully resolved Compose project, as Compose itself sees it. */
export function composeConfig(site, options) {
  const result = compose(site, ['config', '--format', 'json'], options);
  if (result.status !== 0) {
    throw new Error(`docker compose config failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

export async function composeAsync(site, args, options = {}) {
  const base = ['compose', '--project-directory', site, '-f', join(site, 'compose.yml')];
  return execFileAsync('docker', [...base, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...options.env, COMPOSE_FILE: '' },
    maxBuffer: 32 * 1024 * 1024,
  });
}

export function dockerAvailable() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function dockerInspect(id, format) {
  return execFileSync('docker', ['inspect', '-f', format, id], { encoding: 'utf8' }).trim();
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check()` resolves truthy, or the deadline passes. */
export async function waitFor(check, { timeoutMs, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

/** The Compose binaries to run the mode matrix against. */
export function composeBinaries() {
  const bins = [{ label: `compose ${composeVersion()}`, bin: undefined }];
  const min = process.env.GD_TEST_MIN_COMPOSE;
  if (min) bins.push({ label: `compose ${composeVersion(min)} (declared minimum)`, bin: min });
  return bins;
}

function composeVersion(bin) {
  const argv = bin ? ['version', '--short'] : ['compose', 'version', '--short'];
  return execFileSync(bin ?? 'docker', argv, { encoding: 'utf8' }).trim().replace(/^v/, '');
}
