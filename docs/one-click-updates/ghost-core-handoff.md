# Ghost core hand-off — admin UI + endpoint

Ghost admin gains an "Update Ghost" control for the ghost-docker stack. Ghost
performs **no** Docker actions. It only writes a request signal and reads a
status file on a shared volume; the separate privileged `update-agent` container
does the work. This document is the contract the Ghost-core side implements.

## 1. Feature flag & config

```
selfupdate:
  enabled: false                                # env: selfupdate__enabled
  channelPath: /var/lib/ghost/update-channel    # env: selfupdate__channelPath
```

When `enabled` is false, the endpoints return 404 and the admin UI shows no
update affordance. This keeps non-Docker / non-agent installs unaffected.

## 2. Shared-volume contract

Import the schemas from `@tryghost/update-contract` (see `contract.md`) — do not
re-declare shapes here. Files under `channelPath`:

| File | Ghost core | Notes |
|---|---|---|
| `request.json` | **writes** | Server-generated `request_id`; validated with `UpdateRequestSchema`. Atomic write (temp + rename). |
| `status.json` | reads | Validate with `UpdateStatusSchema`. Persists across the Ghost restart, so the UI reads the final state after `recreating`. |
| `available.json` | reads | Validate with `AvailabilitySchema`. Drives the "update available" indicator. |

## 3. Admin API endpoints (new)

### `POST /ghost/api/admin/system/update`
- **Auth:** session, **Owner role only**, CSRF-protected (standard admin API).
  Recommend a client-side re-auth/confirm before enabling the button.
- **Body:** validated by `UpdateRequestBodySchema` — `{ skip_snapshot?: boolean }`.
  `.strict()` rejects any other key.
- **Behavior:** if an update is in flight (status state not in `TERMINAL_STATES`),
  return **409** with the current status. Otherwise generate a `request_id`,
  write `request.json`, return **202** with `{ request_id }`. Non-blocking.
- **Never** accepts or forwards any image/tag/digest/command/path.

### `GET /ghost/api/admin/system/update`
- **Auth:** Owner (admin read-only acceptable).
- **Behavior:** return `status.json` (or `idleStatus()` if none), plus the parsed
  `available.json`, plus display metadata from Ghost's existing update-check
  (friendly version + changelog URL).

### Controller sketch

```ts
import {
  UpdateRequestBodySchema, UpdateRequestSchema, UpdateStatusSchema,
  AvailabilitySchema, TERMINAL_STATES, CHANNEL_FILES, idleStatus
} from '@tryghost/update-contract';

async function requestUpdate(frame) {
  const body = UpdateRequestBodySchema.parse(frame.data);        // strict: rejects smuggled keys
  const current = await readStatus();
  if (current && !TERMINAL_STATES.has(current.state)) return { status: 409, ...current };

  const request = UpdateRequestSchema.parse({
    request_id: `${new Date().toISOString()}-${randomId()}`,
    requested_by: frame.user.id,
    requested_at: new Date().toISOString(),
    skip_snapshot: body.skip_snapshot
  });
  await atomicWrite(path.join(channelPath, CHANNEL_FILES.request), JSON.stringify(request));
  return { status: 202, request_id: request.request_id };
}

async function getUpdateState() {
  const status = await readStatus() ?? idleStatus();
  const available = AvailabilitySchema.parse(JSON.parse(await read(CHANNEL_FILES.available)));
  return { ...status, availability: available };
}
```

## 4. State machine (drives the UI)

```
idle → validating → [rejected]
                  → snapshotting → pulling → recreating → health_check
                      → success
                      → rolling_back → rolled_back
                                    → failed
```

| state | UI |
|---|---|
| idle | current version; "Check for updates" |
| validating | "Preparing…" |
| rejected | reason (e.g. "already running", "major — upgrade manually") |
| snapshotting | "Backing up database…" |
| pulling | "Downloading update…" |
| recreating | "Restarting Ghost…" (expect connection loss; keep polling) |
| health_check | "Verifying…" |
| success | "Updated to X" (+ what's-new link) |
| rolling_back | "Update failed — restoring previous version…" |
| rolled_back | "Rolled back to X. Your site is on the previous version." |
| failed | Clear error + recovery steps + link to logs |

## 5. UI behavior (Settings → About, near the version)

- **Up to date** (`availability.update_available === false`): version +
  "Check for updates".
- **Update available, same major**: target version + changelog + **"Update now"**.
- **Major available** (`availability.major_blocked === true`, or Ghost's
  update-check reports a higher major): informational only — "Ghost `<major>` is
  available. Major upgrades must be performed manually." Link to upgrade docs.
  **No button.**
- **Confirm dialog**: warn "~1–2 min downtime; a database backup is taken first."
  Advanced toggle: "Skip database backup" (default OFF), disabled/greyed when a
  major is involved.
- **In progress**: poll `GET …/update` every ~2s. Survive the Ghost restart
  during `recreating` — the browser briefly loses the connection; keep retrying
  and read the final state (status.json persists in the shared volume,
  independent of Ghost).

## 6. Security requirements (must hold)

1. Endpoints exist only when `selfupdate.enabled` is true.
2. Owner-only + CSRF. No parameter selects what runs — only `skip_snapshot`.
3. Ghost never reads/executes channel content as a command; it only writes a
   request and reads status/availability, validated by the shared schemas.
4. No Ghost code path touches the Docker socket.

## 7. Notes for reviewers

- The agent refuses cross-major updates; the pinned image tag (`6-alpine`)
  already prevents pulling a different major. Do not add a UI path that submits a
  major.
- `knex-migrator` rollback (schema down-migrations) is complementary to — not a
  replacement for — the agent's pre-update `mysqldump`. **Confirm whether current
  core already takes a pre-migration data snapshot**; if so, the agent's snapshot
  can default off and `compose-changes.md` + `architecture.md` should note the
  precedence.
