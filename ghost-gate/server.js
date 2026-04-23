'use strict';

const express = require('express');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const util = require('util');
const { createProxyMiddleware } = require('http-proxy-middleware');
const mysql = require('mysql2/promise');

const execFileAsync = util.promisify(execFile);

const port = Number.parseInt(process.env.PORT || '3989', 10);
const baseUrl = (
  process.env.SERVICE_URL_GHOST_GATE ||
  process.env.SERVICE_URL_GHOST ||
  `http://127.0.0.1:${port}`
).replace(/\/$/, '');

/** Upstreams for proxy mode. Override via env. */
const GHOST_UPSTREAM = (process.env.PROXY_GHOST_UPSTREAM || 'http://ghost:2368').replace(/\/$/, '');
const ANALYTICS_UPSTREAM = (process.env.PROXY_ANALYTICS_UPSTREAM || 'http://traffic-analytics:3000').replace(/\/$/, '');
const ACTIVITYPUB_UPSTREAM = (process.env.PROXY_ACTIVITYPUB_UPSTREAM || 'http://activitypub:8080').replace(/\/$/, '');
const ANALYTICS_PREFIX = '/.ghost/analytics';
/** Paths routed to the ActivityPub service (forwarded as-is, no prefix strip — matches caddy/snippets/ActivityPub). */
const ACTIVITYPUB_PREFIXES = [
  '/.ghost/activitypub',
  '/.well-known/webfinger',
  '/.well-known/nodeinfo',
];

// The browser posts analytics to `${SERVICE_URL_GHOST_GATE}/.ghost/analytics/api/v1/page_hit`
// (set on Ghost via tinybird__tracker__endpoint). ghost-gate strips the prefix and forwards
// to traffic-analytics:3000; Tinybird's own /v0/events endpoint is never contacted from
// the client, so TINYBIRD_TRACKER_ENDPOINT is intentionally absent from this list.
const TINYB_ENV_KEYS = [
  'TINYBIRD_API_URL',
  'TINYBIRD_WORKSPACE_ID',
  'TINYBIRD_ADMIN_TOKEN',
  'TINYBIRD_TRACKER_TOKEN',
];

function nonEmpty(v) {
  return typeof v === 'string' && v.replace(/\s+/g, '') !== '';
}

/** Setup is complete once the four TINYBIRD_* env vars are set. */
function isTinybirdReady() {
  return TINYB_ENV_KEYS.every((k) => nonEmpty(process.env[k]));
}

// ------------------------------ MySQL bootstrap ------------------------------
// Absorbed from mysql-init/mysql-app-bootstrap.sh: idempotent sync of app user
// password + CREATE DATABASE/GRANT for each comma-separated name in
// MYSQL_MULTIPLE_DATABASES. Runs once at startup against mysql:3306.
const MYSQL_CFG = {
  host: process.env.MYSQL_HOST || 'mysql',
  port: Number.parseInt(process.env.MYSQL_PORT || '3306', 10),
  rootPassword: process.env.MYSQL_ROOT_PASSWORD || '',
  user: process.env.MYSQL_USER || '',
  password: process.env.MYSQL_PASSWORD || '',
  multipleDatabases: process.env.MYSQL_MULTIPLE_DATABASES || '',
};

/** Set to true once the app user + databases + grants exist. Gates Docker healthcheck. */
let bootstrapDone = false;
/** Last bootstrap error, reported on the /__ghost_gate/health endpoint for debugging. */
let bootstrapError = null;

async function connectAsRoot() {
  const deadline = Date.now() + 60_000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      return await mysql.createConnection({
        host: MYSQL_CFG.host,
        port: MYSQL_CFG.port,
        user: 'root',
        password: MYSQL_CFG.rootPassword,
        connectTimeout: 5000,
      });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(
    `mysql not reachable at ${MYSQL_CFG.host}:${MYSQL_CFG.port} after 60s: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

async function bootstrapMysql() {
  if (!MYSQL_CFG.rootPassword) {
    throw new Error('MYSQL_ROOT_PASSWORD is required');
  }
  if (!MYSQL_CFG.user || !MYSQL_CFG.password) {
    throw new Error('MYSQL_USER and MYSQL_PASSWORD are required');
  }

  const conn = await connectAsRoot();
  try {
    // Create-or-update app user (password sync mirrors ALTER USER in the old script).
    await conn.query("CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?", [
      MYSQL_CFG.user,
      MYSQL_CFG.password,
    ]);
    await conn.query("ALTER USER ?@'%' IDENTIFIED BY ?", [
      MYSQL_CFG.user,
      MYSQL_CFG.password,
    ]);

    const dbs = MYSQL_CFG.multipleDatabases
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const db of dbs) {
      const ident = mysql.escapeId(db); // wraps in backticks, escapes inner backticks
      await conn.query(`CREATE DATABASE IF NOT EXISTS ${ident}`);
      await conn.query(`GRANT ALL ON ${ident}.* TO ?@'%'`, [MYSQL_CFG.user]);
    }
    await conn.query('FLUSH PRIVILEGES');
  } finally {
    try {
      await conn.end();
    } catch {
      /* ignore */
    }
  }
}

async function runBootstrapWithRetry() {
  try {
    await bootstrapMysql();
    bootstrapDone = true;
    bootstrapError = null;
    console.log(
      `mysql bootstrap complete (${MYSQL_CFG.user}@${MYSQL_CFG.host}:${MYSQL_CFG.port}${
        MYSQL_CFG.multipleDatabases ? `, dbs=[${MYSQL_CFG.multipleDatabases}]` : ''
      })`
    );
  } catch (e) {
    bootstrapError = e instanceof Error ? e.message : String(e);
    console.error('mysql bootstrap failed:', bootstrapError);
    // Leave bootstrapDone=false so Docker healthcheck keeps the service unhealthy.
    // Retry every 30s so transient mysql flaps can self-heal without a restart.
    setTimeout(runBootstrapWithRetry, 30_000);
  }
}

const TINYB_HOME = '/home/tinybird/.tinyb';
const TB_DATA = '/data/tinybird';
/** Tinybird CLI (installed in Docker image) */
const TB = '/root/.local/bin/tb';
const PATH_WITH_TB = `/root/.local/bin:${process.env.PATH || '/usr/bin:/bin'}`;

/**
 * Known legacy aliases for the default region (api.tinybird.co maps to gcp-europe-west3).
 * Used only as a fallback when a slug does not match the cloud-prefixed shape.
 * @see https://www.tinybird.co/docs/api-reference/overview#regions-and-endpoints
 */
const TINYBIRD_HOST_TO_API = {
  'gcp-europe-west3': 'https://api.tinybird.co',
};

function hostSlugToApiBaseUrl(host) {
  if (!host || typeof host !== 'string') return null;
  const h = host.trim();
  // Primary: derive from the documented slug shape `<cloud>-<region>`.
  if (h.startsWith('gcp-')) return `https://api.${h.slice(4)}.gcp.tinybird.co`;
  if (h.startsWith('aws-')) return `https://api.${h.slice(4)}.aws.tinybird.co`;
  // Fallback for any known exceptions (see TINYBIRD_HOST_TO_API above).
  return TINYBIRD_HOST_TO_API[h] || null;
}

/**
 * Decode Tinybird static token payload (p. plus base64 JSON payload, or JWT).
 * Payload includes `host` (region slug) for matching API URL.
 */
function parseTinybirdTokenPayload(token) {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw) return null;

  let b64Payload = null;
  if (raw.startsWith('p.')) {
    const rest = raw.slice(2);
    const parts = rest.split('.');
    if (parts.length >= 1) b64Payload = parts[0];
  } else {
    const parts = raw.split('.');
    if (parts.length === 3) b64Payload = parts[1];
    else if (parts.length === 1) b64Payload = parts[0];
  }
  if (!b64Payload) return null;

  try {
    const json = Buffer.from(b64Payload, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    try {
      const json = Buffer.from(b64Payload, 'base64').toString('utf8');
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
}

function isDefaultTinybirdApiUrl(url) {
  const n = (url || '').trim().replace(/\/$/, '').toLowerCase();
  return n === 'https://api.tinybird.co' || n === 'http://api.tinybird.co';
}

/**
 * If the user leaves the default global URL but the token is regional, use the URL that matches the token.
 */
function resolveApiHostForDeploy(userApiUrl, adminToken) {
  const user = (userApiUrl || '').trim().replace(/\/$/, '');
  const payload = parseTinybirdTokenPayload(adminToken);
  const tokenHost =
    payload && typeof payload.host === 'string' ? payload.host.trim() : null;
  const fromToken = tokenHost ? hostSlugToApiBaseUrl(tokenHost) : null;

  if (!user) {
    if (fromToken) {
      return {
        resolved: fromToken,
        tokenHost,
        note: 'API URL taken from your admin token region.',
      };
    }
    return {
      resolved: 'https://api.tinybird.co',
      tokenHost: null,
      note: null,
    };
  }

  if (isDefaultTinybirdApiUrl(user) && fromToken) {
    return {
      resolved: fromToken,
      tokenHost,
      note:
        'Using regional API URL from your admin token (default api.tinybird.co does not match this workspace region).',
    };
  }

  return { resolved: user, tokenHost, note: null };
}

function normTokenName(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

/** Tinybird may return the secret on alternate keys; list responses sometimes omit secrets. */
function getTokenSecret(t) {
  if (!t || typeof t !== 'object') return '';
  const s = t.token ?? t.value ?? t.secret;
  return typeof s === 'string' && s.length > 0 ? s : '';
}

function normalizeTokensArray(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.tokens)) return data.tokens;
  if (Array.isArray(data.data)) return data.data;
  if (data.tokens && typeof data.tokens === 'object' && Array.isArray(data.tokens.items)) {
    return data.tokens.items;
  }
  if (Array.isArray(data)) return data;
  return [];
}

/** True if token scopes allow appending to analytics_events (Ghost’s datasource). */
function hasAnalyticsEventsAppendScope(t) {
  const scopes = t && t.scopes;
  if (!Array.isArray(scopes)) return false;
  const ds = 'analytics_events';
  for (const s of scopes) {
    if (typeof s === 'string') {
      const u = s.toUpperCase();
      if (u.includes('DATASOURCES:APPEND') && s.includes(ds)) return true;
      continue;
    }
    if (s && typeof s === 'object') {
      const ty = String(s.type || s.scope || '').toUpperCase();
      const res = String(s.resource || '');
      if (res === ds && (ty.includes('APPEND') || ty.includes('DATASOURCES:APPEND'))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Prefer name "tracker" (Ghost deploy); else scope DATASOURCES:APPEND:analytics_events.
 */
function pickTrackerSecret(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  let byScope = null;

  for (const t of list) {
    const secret = getTokenSecret(t);
    if (!secret) continue;
    const n = normTokenName(t.name);
    if (n === 'tracker') return secret;
  }
  for (const t of list) {
    const secret = getTokenSecret(t);
    if (!secret) continue;
    const n = normTokenName(t.name);
    if (n.includes('tracker')) return secret;
  }
  for (const t of list) {
    const secret = getTokenSecret(t);
    if (!secret) continue;
    if (hasAnalyticsEventsAppendScope(t)) {
      byScope = secret;
      break;
    }
  }
  return byScope;
}

/**
 * Same data as `docker compose … get-tokens` / GET /v0/tokens, using a workspace admin token.
 * The `tracker` token is created when Ghost’s Tinybird project is deployed (TOKEN "tracker" in
 * analytics_events.datasource)—so the first lookup may fill API URL / workspace / admin only.
 * @see https://www.tinybird.co/docs/api-reference/token-api
 */
async function lookupEnvFromAdminToken(adminToken) {
  const raw = typeof adminToken === 'string' ? adminToken.trim() : '';
  if (!raw) {
    throw new Error('Paste your workspace admin token first.');
  }
  const payload = parseTinybirdTokenPayload(raw);
  if (!payload || !payload.host) {
    throw new Error(
      'Could not read region from this token. Use a Tinybird workspace admin token (usually starts with p.).'
    );
  }
  const tokenHost = String(payload.host).trim();
  const apiBase = hostSlugToApiBaseUrl(tokenHost);
  if (!apiBase) {
    throw new Error(`Unknown region in token: ${tokenHost}`);
  }
  const workspaceId =
    payload.id != null && String(payload.id).trim() !== ''
      ? String(payload.id).trim()
      : null;
  if (!workspaceId) {
    throw new Error('Could not read workspace id from token payload.');
  }

  const url = `${apiBase.replace(/\/$/, '')}/v0/tokens`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${raw}`,
      Accept: 'application/json',
    },
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(
      `Tinybird Token API returned ${r.status}. Fill API URL, workspace ID, and tokens manually from Tinybird Cloud, or use Advanced CLI auth. ${text.slice(0, 200)}`
    );
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON from Tinybird Token API.');
  }
  const tokens = normalizeTokensArray(data);
  let admin = raw;
  for (const t of tokens) {
    const secret = getTokenSecret(t);
    if (!secret) continue;
    if (normTokenName(t.name) === 'workspace admin token') {
      admin = secret;
      break;
    }
  }

  const tracker = pickTrackerSecret(tokens);
  const incomplete = !tracker;
  const lookupHint = incomplete
    ? 'No tracker token yet—that is normal before the first analytics publish. Run step 3 (Publish), then click Look up again, or paste the tracker from Tinybird Cloud → Tokens (name: tracker).'
    : '';

  return {
    TINYBIRD_API_URL: apiBase,
    TINYBIRD_WORKSPACE_ID: workspaceId,
    TINYBIRD_ADMIN_TOKEN: admin,
    TINYBIRD_TRACKER_TOKEN: tracker || '',
    TINYBIRD_LOOKUP_INCOMPLETE: incomplete,
    lookupHint,
  };
}

function parseEnvLines(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

function validateTinybShape(obj) {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.token === 'string' &&
    obj.token.length > 0 &&
    typeof obj.host === 'string' &&
    obj.host.length > 0 &&
    typeof obj.id === 'string' &&
    obj.id.length > 0
  );
}

async function fetchEnvFromTinybird() {
  await fs.copyFile(TINYB_HOME, `${TB_DATA}/.tinyb`);
  const { stdout, stderr } = await execFileAsync('/usr/local/bin/get-tokens', [], {
    cwd: TB_DATA,
    env: { ...process.env, PATH: PATH_WITH_TB },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (stderr && stderr.trim()) {
    console.error('get-tokens stderr:', stderr);
  }
  return parseEnvLines(stdout);
}

async function deployWithUiToken(apiUrl, adminToken) {
  const { stdout, stderr } = await execFileAsync(
    TB,
    ['--cloud', '--host', apiUrl, '--token', adminToken, 'deploy'],
    {
      cwd: TB_DATA,
      env: { ...process.env, PATH: PATH_WITH_TB },
      maxBuffer: 10 * 1024 * 1024,
    }
  );
  return { stdout: stdout || '', stderr: stderr || '' };
}

async function deployWithTinybFile() {
  const { stdout, stderr } = await execFileAsync(
    '/usr/local/bin/tb-wrapper',
    ['--cloud', 'deploy'],
    {
      cwd: TB_DATA,
      env: { ...process.env, PATH: PATH_WITH_TB },
      maxBuffer: 10 * 1024 * 1024,
    }
  );
  return { stdout: stdout || '', stderr: stderr || '' };
}

function formatTinybirdEnvBlock(env) {
  const a = env.TINYBIRD_API_URL || '';
  const w = env.TINYBIRD_WORKSPACE_ID || '';
  const adm = env.TINYBIRD_ADMIN_TOKEN || '';
  const tr = env.TINYBIRD_TRACKER_TOKEN || '';
  return [
    `TINYBIRD_API_URL=${a}`,
    `TINYBIRD_WORKSPACE_ID=${w}`,
    `TINYBIRD_ADMIN_TOKEN=${adm}`,
    `TINYBIRD_TRACKER_TOKEN=${tr}`,
  ].join('\n');
}

/**
 * One-shot: resolve tokens from workspace admin token; deploy Ghost Tinybird schema if tracker missing; refetch.
 * @returns {{ ok: true, env: object, envText: string, log: string } | { ok: false, error: string, log: string }}
 */
async function generateTinybirdEnvFromAdminToken(pastedAdminToken) {
  const raw = typeof pastedAdminToken === 'string' ? pastedAdminToken.trim() : '';
  const lines = [];
  const push = (s) => {
    if (s != null && String(s).trim() !== '') lines.push(String(s));
  };
  const fail = (error) => ({ ok: false, error, log: lines.join('\n') });

  if (!raw) {
    return fail('Paste your workspace admin token.');
  }

  let env;
  try {
    push('Looking up workspace and tokens from Tinybird…');
    env = await lookupEnvFromAdminToken(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    push(msg);
    return fail(msg);
  }

  if (!env.TINYBIRD_TRACKER_TOKEN) {
    push('Tracker token not found — publishing Ghost analytics schema (first run can take 1–2 minutes)…');
    const { resolved, note } = resolveApiHostForDeploy(
      env.TINYBIRD_API_URL,
      env.TINYBIRD_ADMIN_TOKEN
    );
    if (note) push(note);
    try {
      const { stdout, stderr } = await deployWithUiToken(resolved, env.TINYBIRD_ADMIN_TOKEN);
      push(stdout);
      push(stderr);
    } catch (e) {
      const err = /** @type {Error & { stdout?: string; stderr?: string }} */ (e);
      push(err.stdout || '');
      push(err.stderr || '');
      return fail(err.message || String(e));
    }
    push('Refreshing token list…');
    try {
      env = await lookupEnvFromAdminToken(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      push(msg);
      return fail(msg);
    }
  }

  if (!env.TINYBIRD_TRACKER_TOKEN) {
    return fail(
      'Tracker token still missing after publish. Open Tinybird Cloud → Tokens, confirm a "tracker" token exists, wait a few seconds, and try again.'
    );
  }

  push('Done.');
  const envText = formatTinybirdEnvBlock(env);
  return {
    ok: true,
    env,
    envText,
    log: lines.join('\n'),
  };
}

const app = express();
// Traefik/Coolify sits in front; forward client IP to upstreams.
app.set('trust proxy', true);

// Docker healthcheck: healthy as soon as the DB bootstrap finished. We deliberately do
// NOT gate on proxy mode — if we did, the ingress (Traefik/Coolify) would refuse to
// route to this container on first launch, so the operator could never reach the setup
// page to complete Tinybird configuration. Downstream services that depend_on this one
// only need the DB app user to exist, which bootstrapDone guarantees.
app.get('/__ghost_gate/health', (_req, res) => {
  const body = {
    ok: bootstrapDone,
    bootstrapDone,
    bootstrapError,
    proxyMode: isTinybirdReady(),
  };
  return res.status(bootstrapDone ? 200 : 503).json(body);
});

// --- Setup UI / API (only mounted when TINYBIRD_* is incomplete) -----------------
const gateRouter = express.Router();
gateRouter.use(express.json({ limit: '256kb' }));

gateRouter.get('/api/tinybird/status', async (_req, res) => {
  try {
    await fs.access(TINYB_HOME);
    return res.json({ hasTinyb: true });
  } catch {
    return res.json({ hasTinyb: false });
  }
});

gateRouter.post('/api/tinybird/lookup', async (req, res) => {
  const adminToken =
    typeof req.body?.adminToken === 'string' ? req.body.adminToken.trim() : '';
  try {
    const env = await lookupEnvFromAdminToken(adminToken);
    return res.json({ ok: true, ...env });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(400).json({ ok: false, error: msg });
  }
});

gateRouter.post('/api/tinybird/generate', async (req, res) => {
  const adminToken =
    typeof req.body?.adminToken === 'string' ? req.body.adminToken.trim() : '';
  const out = await generateTinybirdEnvFromAdminToken(adminToken);
  if (!out.ok) {
    const status =
      /paste your workspace admin token|could not read region|workspace id|invalid json|tinybird token api returned 4/i.test(
        out.error
      )
        ? 400
        : 500;
    return res.status(status).json({ ok: false, error: out.error, log: out.log });
  }
  return res.json({
    ok: true,
    log: out.log,
    envText: out.envText,
    TINYBIRD_API_URL: out.env.TINYBIRD_API_URL,
    TINYBIRD_WORKSPACE_ID: out.env.TINYBIRD_WORKSPACE_ID,
    TINYBIRD_ADMIN_TOKEN: out.env.TINYBIRD_ADMIN_TOKEN,
    TINYBIRD_TRACKER_TOKEN: out.env.TINYBIRD_TRACKER_TOKEN,
  });
});

gateRouter.post('/api/tinybird/auth', async (req, res) => {
  try {
    let body = req.body;
    if (typeof body.tinyb === 'string') {
      body = JSON.parse(body.tinyb);
    } else if (typeof body.tinyb === 'object' && body.tinyb !== null) {
      body = body.tinyb;
    }
    if (!validateTinybShape(body)) {
      return res.status(400).json({
        error:
          'Invalid auth JSON. Paste the full contents of a .tinyb file (token, host, and id).',
      });
    }
    await fs.mkdir('/home/tinybird', { recursive: true, mode: 0o700 });
    await fs.writeFile(TINYB_HOME, JSON.stringify(body), { mode: 0o600 });
    return res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(400).json({ error: msg });
  }
});

gateRouter.post('/api/tinybird/deploy', async (req, res) => {
  const userApiUrl =
    typeof req.body?.apiUrl === 'string' ? req.body.apiUrl.trim() : '';
  const adminToken =
    typeof req.body?.adminToken === 'string' ? req.body.adminToken.trim() : '';

  if (adminToken) {
    try {
      const { resolved, tokenHost, note } = resolveApiHostForDeploy(
        userApiUrl,
        adminToken
      );
      const { stdout, stderr } = await deployWithUiToken(resolved, adminToken);
      return res.json({
        ok: true,
        stdout,
        stderr,
        mode: 'ui',
        resolvedApiUrl: resolved,
        tokenHost: tokenHost || undefined,
        note: note || undefined,
      });
    } catch (e) {
      const err = /** @type {Error & { stdout?: string; stderr?: string }} */ (e);
      return res.status(500).json({
        ok: false,
        mode: 'ui',
        error: err.message || String(e),
        stdout: err.stdout || '',
        stderr: err.stderr || '',
      });
    }
  }

  try {
    await fs.access(TINYB_HOME);
  } catch {
    return res.status(400).json({
      error:
        'Either fill API URL and workspace admin token above, or use Advanced: save a .tinyb file from the Tinybird CLI.',
    });
  }
  try {
    const { stdout, stderr } = await deployWithTinybFile();
    return res.json({ ok: true, stdout, stderr, mode: 'tinyb' });
  } catch (e) {
    const err = /** @type {Error & { stdout?: string; stderr?: string }} */ (e);
    return res.status(500).json({
      ok: false,
      mode: 'tinyb',
      error: err.message || String(e),
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    });
  }
});

gateRouter.get('/api/tinybird/env', async (_req, res) => {
  try {
    await fs.access(TINYB_HOME);
  } catch {
    return res.status(400).json({
      error:
        'No saved CLI auth. Use the form in step 2 and “Load variables”, or save a .tinyb under Advanced.',
    });
  }
  try {
    const vars = await fetchEnvFromTinybird();
    return res.json(vars);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

function setupPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Setup Tinybird</title>
  <style>
    body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { font-size: 1.35rem; margin-bottom: 0.75rem; }
    code { background: #f0f0f0; padding: 0.12em 0.35em; border-radius: 3px; font-size: 0.9em; }
    label { display: block; margin-top: 1rem; font-weight: 600; font-size: 0.9rem; }
    input[type="password"] { width: 100%; max-width: 100%; box-sizing: border-box; padding: 0.5rem 0.55rem; font-size: 0.95rem; margin-top: 0.35rem; }
    button { margin-top: 1rem; padding: 0.5rem 1rem; cursor: pointer; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .lede { color: #333; margin: 0 0 1rem; }
    pre { margin: 0; padding: 0.75rem; background: #f6f6f6; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-size: 0.8rem; max-height: 40vh; }
    textarea.env { width: 100%; max-width: 100%; box-sizing: border-box; min-height: 10rem; font-family: ui-monospace, monospace; font-size: 0.8rem; padding: 0.75rem; margin-top: 0.35rem; }
    .err { color: #b71c1c; margin-top: 0.75rem; }
    .ok { color: #1b5e20; }
    .warn { color: #bf360c; }
    details { margin-top: 1rem; }
    summary { cursor: pointer; font-weight: 600; color: #444; }
    a { color: #1565c0; }
    #result { margin-top: 1.25rem; }
    .hint { font-size: 0.88rem; color: #555; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <h1>Setup Tinybird</h1>
  <p class="lede">Your stack needs <code>TINYBIRD_API_URL</code>, <code>TINYBIRD_WORKSPACE_ID</code>, <code>TINYBIRD_ADMIN_TOKEN</code>, and <code>TINYBIRD_TRACKER_TOKEN</code>. Those values are not set yet, so this page will gather them. Open <a href="https://cloud.tinybird.co" target="_blank" rel="noopener">Tinybird Cloud</a>, create an account or sign in, then open the <strong>Tokens</strong> page and paste your <strong>Workspace admin token</strong> below. Click <strong>Generate</strong>—we will resolve your API URL and tokens, publish Ghost’s analytics schema if needed, then show variables you can copy into your deployment environment.</p>

  <label for="adminToken">Workspace admin token</label>
  <input type="password" id="adminToken" name="adminToken" autocomplete="off" placeholder="p.eyJ…">
  <p><button type="button" id="generateBtn">Generate</button></p>
  <p id="errLine" class="err" role="alert"></p>

  <div id="logWrap" hidden>
    <details id="logPanel" open>
      <summary>Setup log</summary>
      <pre id="console"></pre>
    </details>
  </div>

  <section id="result" hidden>
    <label for="envOut">Environment variables</label>
    <textarea id="envOut" class="env" readonly spellcheck="false"></textarea>
    <p><button type="button" id="copyEnv">Copy to clipboard</button> <span id="copyMsg"></span></p>
    <p class="hint">Save these in your host environment (same place as database and site URL), then redeploy. ghost-gate will switch to proxy mode and Ghost will start.</p>
  </section>

  <script>
  (function () {
    var $ = function (id) { return document.getElementById(id); };
    $('generateBtn').onclick = async function () {
      $('errLine').textContent = '';
      $('copyMsg').textContent = '';
      var tok = $('adminToken').value.trim();
      if (!tok) {
        $('errLine').textContent = 'Paste your workspace admin token.';
        return;
      }
      $('generateBtn').disabled = true;
      $('logWrap').hidden = false;
      $('logPanel').open = true;
      $('result').hidden = true;
      $('console').textContent = 'Working…';
      try {
        var r = await fetch('/api/tinybird/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adminToken: tok }),
        });
        var j = await r.json().catch(function () { return {}; });
        $('console').textContent = j.log || '';
        if (!r.ok || !j.ok) {
          $('errLine').textContent = j.error || r.statusText || 'Request failed';
          $('logPanel').open = true;
          return;
        }
        $('envOut').value = j.envText || '';
        $('result').hidden = false;
        $('logPanel').open = false;
      } catch (e) {
        $('console').textContent = ($('console').textContent || '') + '\\n' + (e.message || String(e));
        $('errLine').textContent = e.message || String(e);
        $('logPanel').open = true;
      } finally {
        $('generateBtn').disabled = false;
      }
    };
    $('copyEnv').onclick = function () {
      var t = $('envOut').value;
      if (!t) return;
      navigator.clipboard.writeText(t).then(function () {
        $('copyMsg').textContent = 'Copied.';
        $('copyMsg').className = 'ok';
      }).catch(function () {
        $('copyMsg').textContent = 'Copy blocked—select the text and copy manually.';
        $('copyMsg').className = 'warn';
      });
    };
  })();
  </script>
</body>
</html>`;
}

gateRouter.get('/tinybird_setup', (_req, res) => {
  res.type('html').send(setupPage());
});

// --- Mount mode ------------------------------------------------------------
const PROXY_MODE = isTinybirdReady();

if (PROXY_MODE) {
  // Same-origin analytics: strip `/.ghost/analytics` before forwarding to traffic-analytics:3000.
  // NOTE: http-proxy-middleware v2 forwards `req.originalUrl` even when mounted under a
  // prefix via `app.use(prefix, proxy)`, so Express' built-in prefix strip is ignored and
  // traffic-analytics sees `/.ghost/analytics/api/...` → 404. `pathRewrite` does the strip.
  app.use(
    ANALYTICS_PREFIX,
    createProxyMiddleware({
      target: ANALYTICS_UPSTREAM,
      changeOrigin: true,
      xfwd: true,
      pathRewrite: { [`^${ANALYTICS_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`]: '' },
      logLevel: 'warn',
    })
  );

  // ActivityPub (federation): forward the path untouched — matches caddy/snippets/ActivityPub.
  // http-proxy-middleware v2 uses req.originalUrl, so `/.ghost/activitypub/v1/site/` arrives
  // at activitypub:8080 intact (no pathRewrite needed).
  const activitypubProxy = createProxyMiddleware({
    target: ACTIVITYPUB_UPSTREAM,
    changeOrigin: true,
    xfwd: true,
    logLevel: 'warn',
  });
  for (const prefix of ACTIVITYPUB_PREFIXES) {
    app.use(prefix, activitypubProxy);
  }

  // Everything else proxies to Ghost. Preserve Host so Ghost sees the public URL.
  app.use(
    createProxyMiddleware({
      target: GHOST_UPSTREAM,
      changeOrigin: false,
      xfwd: true,
      ws: true,
      logLevel: 'warn',
    })
  );
} else {
  app.use(gateRouter);
  app.get('/', (_req, res) => res.redirect(302, '/tinybird_setup'));
  // Catch-all: until setup is done, every request lands on the setup page.
  app.use((_req, res) => res.redirect(302, '/tinybird_setup'));
}

const server = app.listen(port, '0.0.0.0', () => {
  if (PROXY_MODE) {
    console.log(
      `ghost-gate: proxy mode — ${ANALYTICS_PREFIX}/* -> ${ANALYTICS_UPSTREAM} (strip prefix); ` +
        `${ACTIVITYPUB_PREFIXES.join(', ')} -> ${ACTIVITYPUB_UPSTREAM}; /* -> ${GHOST_UPSTREAM}`
    );
  } else {
    console.log(`Analytics setup required: ${baseUrl}/tinybird_setup`);
  }
});

// Kick off MySQL bootstrap in the background so the setup UI is reachable even if the
// DB is slow to come up. Healthcheck stays unhealthy until this resolves.
runBootstrapWithRetry();

/** Docker sends SIGTERM on stop; close HTTP server so the process exits before stop_grace_period (avoids SIGKILL / exit 137). */
function shutdown() {
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
