import { execFileSync, execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = join(TESTS_DIR, '..');

const LIBS = ['fs', 'env', 'compose', 'config', 'caddy', 'meta', 'preflight', 'install'];

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
// The helpers target bash 3.2 (macOS's system bash). GD_TEST_BASH points the
// suite at a specific interpreter — the macOS CI job sets it to /bin/bash so a
// bash-4+-ism that a newer Homebrew bash would tolerate is caught.
const BASH = process.env.GD_TEST_BASH || 'bash';

export function sh(script, { cwd = REPO_DIR, env = {}, input } = {}) {
  const preamble = LIBS.map((l) => `. "${REPO_DIR}/scripts/lib/${l}.sh"`).join('\n');
  const result = spawnSync(BASH, ['-c', `${preamble}\n${script}`], {
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

// --- Installation ----------------------------------------------------------
//
// The installer is exercised the way an operator reaches it: a candidate
// release is built from the working tree, tagged, and installed through
// bootstrap.sh or the checkout's own install.sh.

/** Never travels with a release: local state, secrets, and generated routes. */
const RELEASE_EXCLUDE = new Set([
  '.git', 'data', 'node_modules', '.env', 'ghost.env', '.ghost-docker.json',
]);

/** Copy the working tree into `dest` as a release would ship it. */
export function copyWorktree(dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(REPO_DIR)) {
    if (RELEASE_EXCLUDE.has(entry)) continue;
    cpSync(join(REPO_DIR, entry), join(dest, entry), { recursive: true });
  }
  // Generated and operator-owned routes are per-site, not part of a release.
  for (const sub of ['sites', 'custom', 'global']) {
    const routes = join(dest, 'caddy', sub);
    for (const file of readdirSync(routes)) {
      if (file.endsWith('.caddy')) rmSync(join(routes, file), { force: true });
    }
  }
  rmSync(join(dest, 'caddy', '.staging'), { recursive: true, force: true });
  return dest;
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'ghost-docker tests',
  GIT_AUTHOR_EMAIL: 'tests@example.com',
  GIT_COMMITTER_NAME: 'ghost-docker tests',
  GIT_COMMITTER_EMAIL: 'tests@example.com',
};

export function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_IDENTITY },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * A candidate release of the working tree: a real git repository with real
 * tags, so bootstrap.sh resolves and clones it exactly as it would the
 * published one. Each tag lands on its own commit — a release and a prerelease
 * do not share one — so `git describe` on a checkout is unambiguous, matching a
 * real published history rather than a pile of tags on one commit.
 *
 * `url` is a file:// form of the repository. `--depth` is honoured over that,
 * unlike a bare local path, so the shallow-clone path the bootstrap really uses
 * is exercised without the "depth ignored in local clones" warning.
 */
export function makeCandidateRelease(dir, tags = ['v9.9.9']) {
  const repo = join(dir, 'release');
  copyWorktree(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'candidate release']);
  tags.forEach((tag, index) => {
    if (index > 0) git(repo, ['commit', '-q', '--allow-empty', '-m', `release ${tag}`]);
    git(repo, ['tag', tag]);
  });
  return { repo, tags, url: `file://${repo}` };
}

/** Run a script with a captured status, without throwing. */
export function run(command, args, { cwd, env = {}, input, timeout } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    timeout,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error;
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/** Occupy a TCP port for the duration of a test, so a conflict is real. */
export async function occupyPort(port, host = '127.0.0.1') {
  const { createServer } = await import('node:net');
  const server = createServer(() => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return () => new Promise((resolve) => server.close(resolve));
}
