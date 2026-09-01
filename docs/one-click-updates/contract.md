# Shared contract — `@tryghost/update-contract`

A single Zod package, imported by **both** Ghost core (writes `request.json`,
reads `status.json`/`available.json`) and the **update-agent** (reads
`request.json`, writes `status.json`/`available.json`). Because both sides import
the same schemas, a change to the contract is a compile-time break in both — they
cannot silently drift. `.strict()` on the request schema rejects unknown keys, so
no `image`/`command`/`path` can be smuggled through the request boundary.

## Package placement (Ghost monorepo)

```
packages/update-contract/
├── package.json
├── tsconfig.json
└── src/index.ts
```

## `packages/update-contract/package.json`

```json
{
  "name": "@tryghost/update-contract",
  "version": "0.1.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "type": "module",
  "scripts": { "build": "tsc", "test": "node --test" },
  "dependencies": { "zod": "^3.23.8" }
}
```

## `packages/update-contract/src/index.ts`

```ts
import { z } from 'zod';

export const CHANNEL_FILES = {
  request: 'request.json',
  status: 'status.json',
  available: 'available.json'
} as const;

export const UpdateStateSchema = z.enum([
  'idle', 'validating', 'rejected', 'snapshotting', 'pulling',
  'recreating', 'health_check', 'success', 'rolling_back', 'rolled_back', 'failed'
]);
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const TERMINAL_STATES: ReadonlySet<UpdateState> =
  new Set(['idle', 'rejected', 'success', 'rolled_back', 'failed']);

// ── What the Owner-only admin POST accepts from the browser ──────────────
// `.strict()` REJECTS unknown keys, so no image / tag / command / path can be
// smuggled through the request boundary.
export const UpdateRequestBodySchema = z.object({
  skip_snapshot: z.boolean().default(false)
}).strict();
export type UpdateRequestBody = z.infer<typeof UpdateRequestBodySchema>;

// ── What Ghost writes to request.json (server-generated id + audit) ──────
export const UpdateRequestSchema = z.object({
  request_id: z.string().min(1),
  requested_by: z.string().nullable().default(null),
  requested_at: z.string().datetime(),
  skip_snapshot: z.boolean().default(false)
}).strict();
export type UpdateRequest = z.infer<typeof UpdateRequestSchema>;

// ── What the agent writes to status.json ─────────────────────────────────
export const UpdateStatusSchema = z.object({
  request_id: z.string().nullable(),
  state: UpdateStateSchema,
  phase_detail: z.string().default(''),
  from_version: z.string().nullable().default(null),
  from_digest: z.string().nullable().default(null),
  to_version: z.string().nullable().default(null),
  to_digest: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  rollback: z.object({
    to_digest: z.string().nullable(),
    reason: z.string().optional()
  }).nullable().default(null),
  updated_at: z.string().datetime()
}).strict();
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

// ── What the agent publishes for the "update available" indicator ────────
export const AvailabilitySchema = z.object({
  update_available: z.boolean(),
  running_digest: z.string().nullable(),
  latest_digest: z.string().nullable(),
  running_version: z.string().nullable().default(null),
  latest_version: z.string().nullable().default(null),
  // true when a newer image exists but it is a DIFFERENT MAJOR → UI shows
  // "upgrade manually", offers no button, and the agent refuses it.
  major_blocked: z.boolean().default(false),
  checked_at: z.string().datetime()
}).strict();
export type Availability = z.infer<typeof AvailabilitySchema>;

export const idleStatus = (): UpdateStatus => UpdateStatusSchema.parse({
  request_id: null, state: 'idle', updated_at: new Date().toISOString()
});
```

## File semantics

The three files live under a **per-site subdirectory** of the shared channel
volume — `/<channelPath>/<site-key>/{request,status,available}.json` — so each
site's Ghost reads/writes only its own (see `multi-site.md`). The schemas below
are identical for every site; only the path is namespaced. Single-site is the
N=1 case with one subdir.

| File | Writer | Reader | Notes |
|---|---|---|---|
| `request.json` | Ghost core | update-agent | One request at a time per site; `request_id` de-duplicates. Carries no command; the path already scopes it to one site. |
| `status.json` | update-agent | Ghost core | Atomic write (temp + rename). Persists across Ghost restarts — the UI reads the final state after `recreating`. |
| `available.json` | update-agent | Ghost core | Refreshed per site on the agent's idle poll (`DIGEST_POLL_INTERVAL`). |

> Optionally add a `site` field to `UpdateStatusSchema` / `AvailabilitySchema` for
> the agent's own logging. Ghost core doesn't need it — it reads its own subdir —
> so it's left out to keep the payloads minimal.

## Round-trip test (lives in the package)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpdateRequestSchema, UpdateRequestBodySchema, UpdateStatusSchema } from '../src/index.js';

test('request body rejects smuggled keys', () => {
  const r = UpdateRequestBodySchema.safeParse({ skip_snapshot: false, image: 'evil:latest' });
  assert.equal(r.success, false); // .strict() blocks `image`
});

test('status round-trips', () => {
  const s = UpdateStatusSchema.parse({ request_id: 'x', state: 'pulling', updated_at: new Date().toISOString() });
  assert.equal(s.state, 'pulling');
  assert.equal(s.rollback, null);
});
```
