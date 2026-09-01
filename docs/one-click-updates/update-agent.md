# update-agent — Node/TypeScript implementation

A single-purpose container that owns the Docker socket and performs exactly one
fixed action, per site: pull the pinned Ghost image and recreate that site's
`ghost` service. **One agent manages all sites** (see `multi-site.md`);
single-site is simply the N=1 case. It lives in the Ghost monorepo, is tested in
CI, shares the Zod contract with core, and is published as `ghost/update-agent`.

## Repo placement (Ghost monorepo)

```
packages/update-contract/              # shared Zod contract — see contract.md
apps/update-agent/                     # this package (mirrors apps/* like traffic-analytics)
├── package.json
├── tsconfig.json
├── Dockerfile
├── src/
│   ├── index.ts                       # per-site watch loop + state machine
│   ├── docker.ts                      # dockerode: discover / pull / version / recreate / rollback
│   └── snapshot.ts                    # mysqldump helper
└── test/
    └── recreate.test.ts               # asserts network alias is preserved
```

## `apps/update-agent/package.json`

```json
{
  "name": "@tryghost/update-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.0.0" },
  "bin": { "update-agent": "./dist/index.js" },
  "scripts": { "build": "tsc", "start": "node dist/index.js", "test": "node --test" },
  "dependencies": {
    "@tryghost/update-contract": "workspace:*",
    "dockerode": "^4.0.2",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "@types/dockerode": "^3.3.29",
    "@types/node": "^20.0.0"
  }
}
```

Only one runtime dependency beyond the contract (`dockerode`); everything else is
Node built-ins. `mysqldump` comes from the image (mariadb-client), not npm.
Recursive `fs.watch` requires Node ≥20.

## `apps/update-agent/Dockerfile`

```dockerfile
# Multi-stage, socket-only, single purpose.
FROM node:20-alpine AS build
WORKDIR /app
COPY packages/update-contract ./packages/update-contract
COPY apps/update-agent ./apps/update-agent
RUN cd packages/update-contract && npm ci && npm run build \
 && cd ../../apps/update-agent && npm ci && npm run build

FROM node:20-alpine AS runtime
# mariadb-client provides a MySQL-compatible mysqldump for the pre-update snapshot
RUN apk add --no-cache mariadb-client
WORKDIR /app
COPY --from=build /app/packages/update-contract/dist ./node_modules/@tryghost/update-contract/dist
COPY --from=build /app/apps/update-agent/dist ./dist
COPY --from=build /app/apps/update-agent/node_modules ./node_modules
# No shell passthrough / generic command path — entrypoint is the fixed routine.
ENTRYPOINT ["node", "dist/index.js"]
```

## `apps/update-agent/src/docker.ts`

```ts
import Docker from 'dockerode';

export const docker = new Docker(); // uses /var/run/docker.sock

export interface Site { key: string; id: string; }

/** Enumerate managed Ghost sites by the opt-in label (NOT by image — tinybird-sync
 *  also runs the ghost image). Site key = compose service name. */
export async function findSites(siteLabel: string): Promise<Site[]> {
  const list = await docker.listContainers({ all: true, filters: { label: [`${siteLabel}=true`] } });
  return list.map(c => ({
    key: c.Labels['com.docker.compose.service'] ?? c.Names[0].replace(/^\//, ''),
    id: c.Id
  }));
}

/** Resolve one site (by key) to its container, requiring both the site label and
 *  the matching compose-service label so a stray subdir can't target something else. */
export async function resolveSite(siteLabel: string, key: string): Promise<Docker.Container | null> {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`${siteLabel}=true`, `com.docker.compose.service=${key}`] }
  });
  return list.length ? docker.getContainer(list[0].Id) : null;
}

export function parseEnv(env: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of env ?? []) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** Ghost version baked into an image ref (official image sets ENV GHOST_VERSION). */
export async function imageGhostVersion(ref: string): Promise<string | null> {
  const info = await docker.getImage(ref).inspect();
  const line = (info.Config?.Env ?? []).find(e => e.startsWith('GHOST_VERSION='));
  if (line) return line.slice('GHOST_VERSION='.length);
  return info.Config?.Labels?.['org.opencontainers.image.version'] ?? null; // fallback — VERIFY
}

export const majorOf = (v: string | null): string | null => (v ? String(v).split('.')[0] : null);

export async function repoDigestOfImage(ref: string, repo: string): Promise<string | null> {
  const info = await docker.getImage(ref).inspect();
  return (info.RepoDigests ?? []).find(d => d.startsWith(`${repo}@`)) ?? null;
}

export async function pull(ref: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    docker.pull(ref, (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: unknown) => (e ? reject(e) : resolve()));
    });
  });
}

/** Remote digest for a tag WITHOUT pulling layers (idle availability check). */
export async function remoteDigest(ref: string): Promise<string | null> {
  const dist = await docker.getImage(ref).distribution().catch(() => null);
  return (dist as any)?.Descriptor?.digest ?? null; // Ghost image is public
}

/** Re-tag an existing local image id back onto the pinned ref (for rollback). */
export async function retag(imageId: string, repo: string, tag: string): Promise<void> {
  await docker.getImage(imageId).tag({ repo, tag });
}

/**
 * Recreate the target container with a new image, preserving its full config.
 * CRITICAL: network aliases (e.g. the site key "ghost") must survive, or Caddy/DB
 * DNS break. Returns the previous image Id so the caller can roll back.
 */
export async function recreateWithImage(
  container: Docker.Container, imageRef: string
): Promise<{ created: Docker.Container; previousImageId: string }> {
  const info = await container.inspect();
  const name = info.Name.replace(/^\//, '');
  const previousImageId = info.Image;

  // Preserve only the settable endpoint fields (Aliases/Links/IPAMConfig),
  // dropping runtime fields (IPAddress, EndpointID, Gateway, …).
  const nets = info.NetworkSettings?.Networks ?? {};
  const endpoints: Record<string, any> = {};
  for (const [netName, ep] of Object.entries(nets) as [string, any][]) {
    const aliases = (ep.Aliases ?? []).filter((a: string) => !info.Id.startsWith(a));
    endpoints[netName] = {
      Aliases: aliases.length ? aliases : undefined,
      Links: ep.Links ?? undefined,
      IPAMConfig: ep.IPAMConfig ?? undefined
    };
  }
  const netNames = Object.keys(endpoints);

  const createOpts: any = {
    ...info.Config,               // Image, Env, Labels (incl. compose + com.ghost.site), Cmd, Entrypoint…
    Image: imageRef,
    HostConfig: info.HostConfig,  // Binds, RestartPolicy, NetworkMode, PortBindings, Healthcheck…
    name,
    NetworkingConfig: netNames.length
      ? { EndpointsConfig: { [netNames[0]]: endpoints[netNames[0]] } }
      : undefined
  };

  await container.stop({ t: 30 }).catch(() => {});
  await container.remove();

  const created = await docker.createContainer(createOpts);
  for (const extra of netNames.slice(1)) {
    await docker.getNetwork(extra).connect({ Container: created.id, EndpointConfig: endpoints[extra] });
  }
  await created.start();
  return { created, previousImageId };
}
```

## `apps/update-agent/src/snapshot.ts`

```ts
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export interface DbConfig { host: string; user: string; password: string; database: string; }

export async function dumpDatabase(cfg: DbConfig & { outFile: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const dump = spawn('mysqldump',
      ['--no-tablespaces', '-h', cfg.host, '-u', cfg.user, `-p${cfg.password}`, cfg.database]);
    const gzip = createGzip();
    const out = createWriteStream(cfg.outFile);
    let stderr = '';
    dump.stderr.on('data', d => { stderr += d.toString(); });
    dump.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    dump.on('close', code => { if (code !== 0) reject(new Error(`mysqldump exited ${code}: ${stderr}`)); });
    dump.stdout.pipe(gzip).pipe(out);
  });
}

export async function pruneSnapshots(dir: string, keep: number): Promise<void> {
  const files = (await readdir(dir).catch(() => [])).filter(f => f.endsWith('.sql.gz'));
  const withTime = await Promise.all(files.map(async f => ({ f, t: (await stat(path.join(dir, f))).mtimeMs })));
  withTime.sort((a, b) => b.t - a.t);
  for (const { f } of withTime.slice(keep)) await unlink(path.join(dir, f)).catch(() => {});
}
```

## `apps/update-agent/src/index.ts` (multi-site)

One agent, one recursive watch over `/channel`, per-site everything. Each site is
self-describing: DB creds and health URL are read from the site's own container,
so adding a site needs no agent config.

```ts
#!/usr/bin/env node
import { watch } from 'node:fs';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import path from 'node:path';
import {
  CHANNEL_FILES, UpdateRequestSchema, UpdateStatusSchema, AvailabilitySchema,
  type UpdateState, type UpdateStatus, type UpdateRequest
} from '@tryghost/update-contract';
import * as d from './docker.js';
import { dumpDatabase, pruneSnapshots, type DbConfig } from './snapshot.js';

const CFG = {
  siteLabel: process.env.SITE_LABEL || 'com.ghost.site',
  repo: process.env.IMAGE_REPO || 'ghost',
  tag: process.env.PINNED_TAG || '6-alpine',     // shared version model; per-site would read the site image
  channel: process.env.CHANNEL_PATH || '/channel',
  snapshots: process.env.SNAPSHOT_PATH || '/snapshots',
  snapshot: (process.env.SNAPSHOT_BEFORE_UPDATE ?? 'true') === 'true',
  retention: Number(process.env.SNAPSHOT_RETENTION || 5),
  healthTimeout: Number(process.env.HEALTHCHECK_TIMEOUT || 180),
  pollInterval: Number(process.env.DIGEST_POLL_INTERVAL || 3600)
};
const imageRef = `${CFG.repo}:${CFG.tag}`;

const busy = new Set<string>();                  // per-site single-flight
const lastRequestId = new Map<string, string>(); // per-site de-dup

interface RunCtx {
  key: string; dir: string; requestId: string | null;
  fromVersion: string | null; fromDigest: string | null;
  toVersion: string | null; toDigest: string | null;
}
const siteDir = (key: string) => path.join(CFG.channel, key);

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

async function writeStatus(run: RunCtx, state: UpdateState, detail = '', extra: Partial<UpdateStatus> = {}): Promise<void> {
  const status = UpdateStatusSchema.parse({
    request_id: extra.request_id ?? run.requestId,
    state, phase_detail: detail,
    from_version: run.fromVersion, from_digest: run.fromDigest,
    to_version: run.toVersion, to_digest: run.toDigest,
    error: extra.error ?? null, rollback: extra.rollback ?? null,
    updated_at: new Date().toISOString()
  });
  await atomicWrite(path.join(run.dir, CHANNEL_FILES.status), JSON.stringify(status));
  console.log(`[update-agent:${run.key}] ${status.state} ${detail}`);
}

function dbFromEnv(env: Record<string, string>): DbConfig {
  return {
    host: env['database__connection__host'] || 'db',
    user: env['database__connection__user'] || 'ghost',
    password: env['database__connection__password'] || '',
    database: env['database__connection__database'] || 'ghost'
  };
}

function waitHealthy(url: string, timeoutS: number): Promise<boolean> {
  const deadline = Date.now() + timeoutS * 1000;
  return new Promise(resolve => {
    const tick = () => {
      const req = httpGet(url, res => { res.resume(); (res.statusCode && res.statusCode < 500) ? resolve(true) : retry(); });
      req.on('error', retry);
    };
    const retry = () => (Date.now() < deadline ? setTimeout(tick, 3000) : resolve(false));
    tick();
  });
}

async function runUpdate(key: string, req: UpdateRequest): Promise<void> {
  const run: RunCtx = { key, dir: siteDir(key), requestId: req.request_id,
    fromVersion: null, fromDigest: null, toVersion: null, toDigest: null };
  await writeStatus(run, 'validating', 'checking preconditions');

  const container = await d.resolveSite(CFG.siteLabel, key);
  if (!container) return writeStatus(run, 'rejected', `no managed site "${key}"`);
  const info = await container.inspect();
  const env = d.parseEnv(info.Config?.Env);
  const db = dbFromEnv(env);
  const healthUrl = `http://${key}:2368/ghost/api/admin/site/`;   // site key == network alias

  run.fromDigest = await d.repoDigestOfImage(info.Image, CFG.repo);
  run.fromVersion = await d.imageGhostVersion(info.Image);
  const previousImageId = info.Image;

  await writeStatus(run, 'pulling', `pulling ${imageRef}`);
  await d.pull(imageRef);
  run.toDigest = await d.repoDigestOfImage(imageRef, CFG.repo);
  run.toVersion = await d.imageGhostVersion(imageRef);

  if (run.fromDigest && run.fromDigest === run.toDigest) return writeStatus(run, 'success', 'already up to date');
  if (run.fromVersion && run.toVersion && d.majorOf(run.fromVersion) !== d.majorOf(run.toVersion)) {
    return writeStatus(run, 'rejected', `major update ${run.fromVersion} → ${run.toVersion} not supported; upgrade manually`);
  }

  if (CFG.snapshot && !req.skip_snapshot) {
    await writeStatus(run, 'snapshotting', 'backing up database');
    const dir = path.join(CFG.snapshots, key);
    await mkdir(dir, { recursive: true });
    await dumpDatabase({ ...db, outFile: path.join(dir, `${req.request_id}.sql.gz`) });
    await pruneSnapshots(dir, CFG.retention);
  }

  await writeStatus(run, 'recreating', 'restarting ghost (brief downtime)');
  await d.recreateWithImage(container, imageRef);

  await writeStatus(run, 'health_check', 'verifying new version');
  if (await waitHealthy(healthUrl, CFG.healthTimeout)) {
    return writeStatus(run, 'success', `updated to ${run.toVersion ?? run.toDigest}`);
  }

  await writeStatus(run, 'rolling_back', 'new version unhealthy; restoring previous');
  await d.retag(previousImageId, CFG.repo, CFG.tag);
  const again = await d.resolveSite(CFG.siteLabel, key);
  if (again) await d.recreateWithImage(again, imageRef);
  if (again && await waitHealthy(healthUrl, CFG.healthTimeout)) {
    return writeStatus(run, 'rolled_back', `restored ${run.fromVersion ?? 'previous'}`, { rollback: { to_digest: run.fromDigest } });
  }
  await writeStatus(run, 'failed', 'update failed and rollback did not recover; operator action required', { error: 'unhealthy_after_rollback' });
}

async function onRequest(key: string): Promise<void> {
  const reqPath = path.join(siteDir(key), CHANNEL_FILES.request);
  let raw: string;
  try { raw = await readFile(reqPath, 'utf8'); } catch { return; }
  const parsed = UpdateRequestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) { console.warn(`[update-agent:${key}] invalid request`, parsed.error.issues); return; }
  if (parsed.data.request_id === lastRequestId.get(key)) return;               // de-dup
  if (busy.has(key)) {
    const run: RunCtx = { key, dir: siteDir(key), requestId: parsed.data.request_id,
      fromVersion: null, fromDigest: null, toVersion: null, toDigest: null };
    return writeStatus(run, 'rejected', 'an update is already running for this site');
  }
  busy.add(key); lastRequestId.set(key, parsed.data.request_id);
  try { await runUpdate(key, parsed.data); }
  catch (err) {
    const run: RunCtx = { key, dir: siteDir(key), requestId: parsed.data.request_id,
      fromVersion: null, fromDigest: null, toVersion: null, toDigest: null };
    await writeStatus(run, 'failed', 'unexpected error', { error: String((err as Error).message) });
  } finally { busy.delete(key); }
}

async function publishAvailability(): Promise<void> {
  for (const site of await d.findSites(CFG.siteLabel).catch(() => [])) {
    try {
      const info = await d.docker.getContainer(site.id).inspect();
      const running = await d.repoDigestOfImage(info.Image, CFG.repo);
      const latest = await d.remoteDigest(imageRef);
      const avail = AvailabilitySchema.parse({
        update_available: !!(running && latest && !running.endsWith(latest)),
        running_digest: running, latest_digest: latest,
        running_version: await d.imageGhostVersion(info.Image), latest_version: null,
        major_blocked: false, checked_at: new Date().toISOString()
      });
      await mkdir(siteDir(site.key), { recursive: true });
      await atomicWrite(path.join(siteDir(site.key), CHANNEL_FILES.available), JSON.stringify(avail));
    } catch (err) { console.warn(`[update-agent:${site.key}] availability check failed`, err); }
  }
}

await mkdir(CFG.channel, { recursive: true });
console.log(`[update-agent] starting (label=${CFG.siteLabel} tag=${CFG.tag})`);
await publishAvailability();
setInterval(publishAvailability, CFG.pollInterval * 1000);

// Handle any requests already present at boot, then watch the whole tree.
for (const site of await d.findSites(CFG.siteLabel).catch(() => [])) void onRequest(site.key);
watch(CFG.channel, { recursive: true }, (_e, file) => {
  if (!file) return;
  const parts = String(file).split(path.sep);
  if (parts.length === 2 && parts[1] === CHANNEL_FILES.request) void onRequest(parts[0]);
});
```

## `apps/update-agent/test/recreate.test.ts` (the critical test)

The one behavior worth an integration test: recreate preserves the site's network
alias (Caddy's `reverse_proxy <site>:2368` and DB DNS depend on it).

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('recreateWithImage preserves network aliases and labels', async () => {
  const inspectData = {
    Id: 'abc123def456',
    Name: '/ghost-docker-ghost-1',
    Image: 'sha256:OLD',
    Config: { Image: 'ghost:6-alpine',
      Labels: { 'com.docker.compose.service': 'ghost', 'com.ghost.site': 'true' }, Env: [] },
    HostConfig: { RestartPolicy: { Name: 'always' } },
    NetworkSettings: { Networks: { ghost_network: {
      Aliases: ['ghost', 'abc123def456'], IPAddress: '172.20.0.3', EndpointID: 'xyz', Gateway: '172.20.0.1'
    } } }
  };
  let created: any = null;
  const fakeDocker = {
    createContainer: (opts: any) => { created = opts; return { id: 'new', start: async () => {} }; },
    getNetwork: () => ({ connect: async () => {} })
  };
  // ... inject fakeDocker, call recreateWithImage(fakeContainer, 'ghost:6-alpine') ...

  const ep = created.NetworkingConfig.EndpointsConfig.ghost_network;
  assert.ok(ep.Aliases.includes('ghost'));                 // service alias preserved
  assert.ok(!ep.Aliases.includes('abc123def456'));         // container-id alias dropped
  assert.equal(ep.IPAddress, undefined);                   // runtime fields not copied
  assert.equal(created.Labels['com.ghost.site'], 'true');
});
```

## Verify before build

1. **`imageGhostVersion`** — confirm the Ghost image you publish exposes
   `GHOST_VERSION` in its config env. The per-site major guard depends on it; fall
   back to the OCI label or a `package.json` read if absent.
2. **`recreateWithImage`** — the alias test above is the guard against silently
   breaking Caddy routing on update, for every site.
3. **DB creds in env** — the agent reads `database__connection__*` from each site
   container's env. Confirm those keys are present on the Ghost services as
   configured in `compose.yml` (they are, via the `database__connection__*`
   environment entries).
4. **Recursive `fs.watch`** — relies on Node ≥20 on Linux. The Dockerfile pins
   `node:20-alpine`.
