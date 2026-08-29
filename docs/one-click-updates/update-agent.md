# update-agent — Node/TypeScript implementation

A single-purpose container that owns the Docker socket and performs exactly one
fixed action: pull the pinned Ghost image and recreate the `ghost` service. It
lives in the Ghost monorepo, is tested in CI, shares the Zod contract with core,
and is published as `ghost/update-agent`.

## Repo placement (Ghost monorepo)

```
packages/update-contract/              # shared Zod contract — see contract.md
apps/update-agent/                     # this package (mirrors apps/* like traffic-analytics)
├── package.json
├── tsconfig.json
├── Dockerfile
├── src/
│   ├── index.ts                       # watch loop + state machine
│   ├── docker.ts                      # dockerode: discover / pull / version / recreate / rollback
│   └── snapshot.ts                    # mysqldump helper
└── test/
    └── recreate.test.ts               # asserts network alias is preserved
```

The agent depends on `@tryghost/update-contract` (workspace) so request/status/
availability shapes cannot drift from Ghost core.

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
Node built-ins (`node:fs`, `node:zlib`, `node:child_process`, `node:http`).
`mysqldump` comes from the image, not npm.

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

/** Find the compose-managed target container by service label (no project name needed). */
export async function findTarget(service: string): Promise<Docker.Container> {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`com.docker.compose.service=${service}`] }
  });
  if (list.length === 0) throw new Error(`no container with compose service label "${service}"`);
  return docker.getContainer(list[0].Id);
}

/** Ghost version baked into an image ref (official image sets ENV GHOST_VERSION). */
export async function imageGhostVersion(ref: string): Promise<string | null> {
  const info = await docker.getImage(ref).inspect();
  const env = info.Config?.Env ?? [];
  const line = env.find(e => e.startsWith('GHOST_VERSION='));
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
 * CRITICAL: network aliases (e.g. "ghost") must survive, or Caddy/DB DNS break.
 * Returns the previous image Id so the caller can roll back.
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
    ...info.Config,               // Image, Env, Labels (incl. compose labels), Cmd, Entrypoint, ExposedPorts…
    Image: imageRef,
    HostConfig: info.HostConfig,  // Binds, RestartPolicy, NetworkMode, PortBindings, Healthcheck…
    name,
    // Attach the FIRST network at create time; connect the rest afterward.
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
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql.gz'));
  const withTime = await Promise.all(files.map(async f => ({ f, t: (await stat(path.join(dir, f))).mtimeMs })));
  withTime.sort((a, b) => b.t - a.t);
  for (const { f } of withTime.slice(keep)) await unlink(path.join(dir, f)).catch(() => {});
}
```

## `apps/update-agent/src/index.ts`

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
import { dumpDatabase, pruneSnapshots } from './snapshot.js';

const CFG = {
  service: process.env.TARGET_SERVICE || 'ghost',
  repo: process.env.IMAGE_REPO || 'ghost',
  tag: process.env.PINNED_TAG || '6-alpine',
  channel: process.env.CHANNEL_PATH || '/channel',
  snapshots: process.env.SNAPSHOT_PATH || '/snapshots',
  snapshot: (process.env.SNAPSHOT_BEFORE_UPDATE ?? 'true') === 'true',
  retention: Number(process.env.SNAPSHOT_RETENTION || 5),
  healthUrl: process.env.HEALTHCHECK_URL || 'http://ghost:2368/ghost/api/admin/site/',
  healthTimeout: Number(process.env.HEALTHCHECK_TIMEOUT || 180),
  pollInterval: Number(process.env.DIGEST_POLL_INTERVAL || 3600),
  db: {
    host: process.env.DATABASE_HOST || 'db',
    user: process.env.DATABASE_USER || 'ghost',
    password: process.env.DATABASE_PASSWORD as string,
    database: process.env.DATABASE_NAME || 'ghost'
  }
};
const imageRef = `${CFG.repo}:${CFG.tag}`;
const statusPath = path.join(CFG.channel, CHANNEL_FILES.status);
const requestPath = path.join(CFG.channel, CHANNEL_FILES.request);
const availPath = path.join(CFG.channel, CHANNEL_FILES.available);

let busy = false;
let lastRequestId: string | null = null;
let currentRequestId: string | null = null;
const ctx = { fromVersion: null as string | null, fromDigest: null as string | null,
              toVersion: null as string | null, toDigest: null as string | null };

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

// Every status write is validated by the shared schema before it hits disk.
async function writeStatus(state: UpdateState, detail = '', extra: Partial<UpdateStatus> = {}): Promise<void> {
  const status = UpdateStatusSchema.parse({
    request_id: extra.request_id ?? currentRequestId,
    state, phase_detail: detail,
    from_version: ctx.fromVersion, from_digest: ctx.fromDigest,
    to_version: ctx.toVersion, to_digest: ctx.toDigest,
    error: extra.error ?? null, rollback: extra.rollback ?? null,
    updated_at: new Date().toISOString()
  });
  await atomicWrite(statusPath, JSON.stringify(status));
  console.log(`[update-agent] ${status.state} ${detail}`);
}

function waitHealthy(url: string, timeoutS: number): Promise<boolean> {
  const deadline = Date.now() + timeoutS * 1000;
  return new Promise(resolve => {
    const tick = () => {
      const req = httpGet(url, res => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve(true);
        retry();
      });
      req.on('error', retry);
    };
    const retry = () => (Date.now() < deadline ? setTimeout(tick, 3000) : resolve(false));
    tick();
  });
}

async function runUpdate(req: UpdateRequest): Promise<void> {
  currentRequestId = req.request_id;
  await writeStatus('validating', 'checking preconditions');

  const container = await d.findTarget(CFG.service);
  const info = await container.inspect();
  ctx.fromDigest = await d.repoDigestOfImage(info.Image, CFG.repo);
  ctx.fromVersion = await d.imageGhostVersion(info.Image);
  const previousImageId = info.Image;

  await writeStatus('pulling', `pulling ${imageRef}`);
  await d.pull(imageRef);
  ctx.toDigest = await d.repoDigestOfImage(imageRef, CFG.repo);
  ctx.toVersion = await d.imageGhostVersion(imageRef);

  if (ctx.fromDigest && ctx.fromDigest === ctx.toDigest) {
    return writeStatus('success', 'already up to date');
  }
  // MAJOR GUARD — majors are out of scope (the pinned tag also prevents them).
  if (ctx.fromVersion && ctx.toVersion && d.majorOf(ctx.fromVersion) !== d.majorOf(ctx.toVersion)) {
    return writeStatus('rejected',
      `major update ${ctx.fromVersion} → ${ctx.toVersion} not supported; upgrade manually`);
  }

  if (CFG.snapshot && !req.skip_snapshot) {
    await writeStatus('snapshotting', 'backing up database');
    await mkdir(CFG.snapshots, { recursive: true });
    await dumpDatabase({ ...CFG.db, outFile: path.join(CFG.snapshots, `${req.request_id}.sql.gz`) });
    await pruneSnapshots(CFG.snapshots, CFG.retention);
  }

  await writeStatus('recreating', 'restarting ghost (brief downtime)');
  await d.recreateWithImage(container, imageRef);

  await writeStatus('health_check', 'verifying new version');
  if (await waitHealthy(CFG.healthUrl, CFG.healthTimeout)) {
    return writeStatus('success', `updated to ${ctx.toVersion ?? ctx.toDigest}`);
  }

  // rollback: retag pinned tag → previous image, recreate
  await writeStatus('rolling_back', 'new version unhealthy; restoring previous');
  await d.retag(previousImageId, CFG.repo, CFG.tag);
  const again = await d.findTarget(CFG.service);
  await d.recreateWithImage(again, imageRef);
  if (await waitHealthy(CFG.healthUrl, CFG.healthTimeout)) {
    return writeStatus('rolled_back', `restored ${ctx.fromVersion ?? 'previous'}`,
      { rollback: { to_digest: ctx.fromDigest } });
  }
  await writeStatus('failed', 'update failed and rollback did not recover; operator action required',
    { error: 'unhealthy_after_rollback' });
}

async function onRequest(): Promise<void> {
  let raw: string;
  try { raw = await readFile(requestPath, 'utf8'); } catch { return; }
  const parsed = UpdateRequestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) { console.warn('[update-agent] invalid request', parsed.error.issues); return; }
  if (parsed.data.request_id === lastRequestId) return;                 // de-dup
  if (busy) { currentRequestId = parsed.data.request_id; return writeStatus('rejected', 'an update is already running'); }

  busy = true; lastRequestId = parsed.data.request_id;
  try { await runUpdate(parsed.data); }
  catch (err) { await writeStatus('failed', 'unexpected error', { error: String((err as Error).message) }); }
  finally { busy = false; }
}

async function publishAvailability(): Promise<void> {
  try {
    const container = await d.findTarget(CFG.service);
    const info = await container.inspect();
    const running = await d.repoDigestOfImage(info.Image, CFG.repo);
    const latest = await d.remoteDigest(imageRef);
    const runningVersion = await d.imageGhostVersion(info.Image);
    const avail = AvailabilitySchema.parse({
      update_available: !!(running && latest && !running.endsWith(latest)),
      running_digest: running, latest_digest: latest,
      running_version: runningVersion, latest_version: null,
      major_blocked: false,                 // set true if a newer *major* tag is detected out-of-band
      checked_at: new Date().toISOString()
    });
    await atomicWrite(availPath, JSON.stringify(avail));
  } catch (err) { console.warn('[update-agent] availability check failed', err); }
}

await mkdir(CFG.channel, { recursive: true });
console.log(`[update-agent] starting (service=${CFG.service} tag=${CFG.tag})`);
await publishAvailability();
setInterval(publishAvailability, CFG.pollInterval * 1000);
await onRequest();                                                       // handle a request present at boot
watch(CFG.channel, (_e, file) => { if (file === CHANNEL_FILES.request) void onRequest(); });
```

## `apps/update-agent/test/recreate.test.ts` (the critical test)

The one behavior worth an integration test: recreate preserves the `ghost`
network alias (Caddy's `reverse_proxy ghost:2368` and DB DNS depend on it).
Sketch using a mocked dockerode:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('recreateWithImage preserves network aliases and compose labels', async () => {
  const inspectData = {
    Id: 'abc123def456',
    Name: '/ghost-docker-ghost-1',
    Image: 'sha256:OLD',
    Config: { Image: 'ghost:6-alpine', Labels: { 'com.docker.compose.service': 'ghost' }, Env: [] },
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
  assert.equal(created.Labels['com.docker.compose.service'], 'ghost');
});
```

## Verify before build

1. **`imageGhostVersion`** — confirm the Ghost image you publish exposes
   `GHOST_VERSION` in its config env. The major guard depends on it; fall back to
   the OCI label or a `package.json` read if absent.
2. **`recreateWithImage`** — the alias test above is the guard against silently
   breaking Caddy routing on update.
3. **`remoteDigest`** — `docker.getImage(ref).distribution()` requires the
   registry be reachable/anonymous; fine for the public Ghost image. If you pin
   a private mirror, add auth.
