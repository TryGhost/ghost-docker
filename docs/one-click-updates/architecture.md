# Architecture

## 1. Goals & non-goals

**Goals**
- Owner-initiated update from inside Ghost admin.
- Ghost container holds no Docker capability of any kind.
- The privileged component's action is fixed — it cannot be told *what* to run.
- Safe by default: pre-update DB snapshot, digest rollback, refuse cross-major.
- Clear in-UI progress and failure reporting.

**Non-goals**
- Updating any service other than `ghost` (not MySQL, Caddy, ActivityPub,
  analytics, or the agent itself).
- Arbitrary tag/version selection from the UI.
- **Major-version upgrades** — out of scope by design (breaking-change risk).
- Zero-downtime updates. A brief restart is expected and acceptable.
- Replacing scheduled/auto-update tooling — this can coexist with it.

## 2. Threat model

| Threat | Mitigation |
|---|---|
| Stolen admin session / CSRF from browser | Endpoint is Owner-role-only, session-authenticated, CSRF-protected; optional re-auth confirm |
| **RCE inside the Ghost container** | Ghost holds no socket and no command channel. Worst case: attacker drops the same signal a legit update would — forcing a re-pull of the **pinned** tag. Cannot exec, choose an image, or reach other containers |
| Compromised agent | Minimal image, single fixed action, no inbound listener (file-signal only), every action logged |
| Bad/failed image or migration | Pre-update DB snapshot + previous-image rollback + health-gated success |
| Replay / double-trigger | Monotonic `request_id` + agent-side single-flight lock |
| Smuggled parameters in the request | Shared Zod schema is `.strict()` — unknown keys (`image`, `command`, `path`) are rejected at parse time |

## 3. Hard invariants (never relax — even though we own both codebases)

1. The Ghost container never mounts `/var/run/docker.sock` (directly or via proxy).
2. The agent accepts **no** parameter describing *what* to run. Its action is fixed.
3. The Ghost→agent signal carries only a `request_id`, audit info, and a
   `skip_snapshot` boolean — never a command, path, or image reference.
4. Any secret shared with the agent lives in the agent's own env only; nothing
   the agent needs is ever sent to the browser.

> **Why the invariants hold even though we control Ghost's code.** Owning the
> code does not shrink Ghost's *runtime* attack surface (uploads, themes,
> integrations). These invariants are what preserve the security value under full
> Ghost RCE, so they hold regardless of what we can change in Ghost.

## 4. Architecture

Chosen design: **file-drop signal + Docker-API recreate**. The agent is
socket-only (no compose file or project name required), discovers the target by
compose service label, and reports progress through the shared volume.

```
┌───────────────────────── Ghost admin (browser) ─────────────────────────┐
│  Settings → About: "Update available → Update now"   ← polls Ghost status │
└──────────────┬────────────────────────────────────────────▲──────────────┘
               │ Admin API (Owner-only, CSRF)                │ GET status
               ▼                                             │
┌───────────────────────── ghost (container) ─────────────────────────────┐
│  POST /ghost/api/admin/system/update → writes request.json               │
│  GET  /ghost/api/admin/system/update → reads status.json + available.json │
│  NO docker socket. NO network path to the agent.                          │
└──────────────┬────────────────────────────────────────────▲──────────────┘
               │ writes request.json   (shared volume)       │ reads status/avail
               ▼                                             │
┌───────────────────────── update-agent (container) ──────────────────────┐
│  fs.watch(request.json) → validate (Zod) → snapshot DB → pull pinned tag  │
│  → recreate ghost via Docker API (preserve alias) → health-gate           │
│  → success | rollback ; writes status.json + available.json               │
│  OWNS /var/run/docker.sock. Fixed action only. Discovers ghost by label.  │
└──────────────────────────────────────────────────────────────────────────┘
```

## 5. Update lifecycle (state machine)

```
idle
 └─(request.json seen)─► validating
      ├─ rejected (major / already-running) ─────────────► idle
      └─ ok ─► snapshotting ─► pulling ─► recreating ─► health_check
                                                          ├─ healthy ─► success ─► idle
                                                          └─ unhealthy ─► rolling_back
                                                                            ├─ ok  ─► rolled_back ─► idle
                                                                            └─ fail─► failed ─► idle (manual)
```

| State | Meaning | UI shows |
|---|---|---|
| `idle` | No update in progress | Version + "Check for updates" |
| `validating` | Request checked (major guard, digest resolvable) | "Preparing…" |
| `rejected` | Precondition failed (major update, concurrent update) | Reason + guidance |
| `snapshotting` | DB backup running | "Backing up database…" |
| `pulling` | Pulling target image | "Downloading update…" |
| `recreating` | Recreating the ghost container | "Restarting Ghost…" (expect connection loss) |
| `health_check` | Waiting for Ghost health endpoint | "Verifying…" |
| `success` | New version healthy | "Updated to X" |
| `rolling_back` / `rolled_back` | New image failed health; previous restored | "Update failed, rolled back to X" |
| `failed` | Rollback also failed — needs operator | Error + recovery steps + logs link |

## 6. Transport rationale (why file-drop)

All three candidate transports avoid any TCP port or Caddy exposure. They differ
in whether a **listener runs inside the privileged agent**:

| Transport | Responsiveness | Listener in privileged container? | Bidirectional | TCP/Caddy surface |
|---|---|---|---|---|
| **File-drop + fs.watch** (chosen) | Instant (inotify wakes immediately — not polling) | **No** | via `status.json` | None |
| Unix domain socket | Instant | Yes (socket server) | Native req/resp | None |
| Internal HTTP + token | Instant | Yes (HTTP server) | Native req/resp | None (internal only) |

A Unix domain socket over the shared volume is entirely feasible (both
containers share the host kernel; bind the `.sock` in the volume, align UID/mode)
and is a reasonable middle option. We chose file-drop because `fs.watch` already
gives instant pickup and `status.json` already gives the response channel — so
we get the same responsiveness **without putting a request-parsing listener into
the privileged process**. That smaller attack surface is the deciding factor.

## 7. Why Docker-API recreate (not `docker compose`)

The agent recreates the `ghost` container through the Docker API (`dockerode`),
copying the existing container's config with the new image — the same approach
Watchtower uses. Benefits:

- **Socket-only.** No need to mount the user's `compose.yml`/`.env` or set
  `COMPOSE_PROJECT_NAME`, which makes the published image portable across setups.
- **Discovery by label.** The agent finds the target via
  `com.docker.compose.service=ghost`, regardless of container naming or project.

Cost / the thing to test hard:

- **Network-alias preservation.** Compose adds the service name (`ghost`) as a
  network alias. The recreate must re-apply it, or Caddy's `reverse_proxy
  ghost:2368` and the database DNS break. See `update-agent.md` for how
  `recreateWithImage` handles endpoint config, and the test that asserts it.

The fallback, if the recreate logic proves fiddly to maintain, is to shell out to
`docker compose up -d --no-deps --force-recreate ghost` — trivially correct
recreation, at the cost of mounting the project dir and requiring the project
name. Documented here as the alternative, not the default.

## 8. Relationship to automated updates

This coexists with scheduled/unattended updates. The same agent could
additionally run on a timer, or a Watchtower-style tool can run alongside; both
share the invariant that Ghost never holds the socket. Deployments that want only
automation set `SELFUPDATE_ENABLED=false` and rely on the scheduler.
