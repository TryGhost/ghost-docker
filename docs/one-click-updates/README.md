# One-Click Ghost Updates (socket-isolated) — Plan

Enable an Owner-initiated "Update Ghost" control **inside Ghost admin** for this
Docker Compose stack, without ever giving the Ghost container access to the
Docker daemon. A separate, single-purpose **update-agent** owns the socket and
performs exactly one fixed action: pull the pinned Ghost image and recreate the
`ghost` service.

> Status: **draft for review**. Nothing here is wired up yet. These documents are
> the design + implementation hand-off for two codebases: `tryghost/ghost-docker`
> (this repo — compose wiring) and the Ghost monorepo (the admin UI/endpoint plus
> the published `update-agent` image and shared contract package).

## Document set

| Doc | What it covers | Whose work |
|---|---|---|
| [`architecture.md`](./architecture.md) | Goals, prior art, threat model, invariants, architecture, state machine, transport rationale | Both |
| [`contract.md`](./contract.md) | The shared Zod contract (`@tryghost/update-contract`): request / status / availability schemas | Ghost monorepo |
| [`compose-changes.md`](./compose-changes.md) | `compose.yml` additions, new volumes, `.env.example` additions | This repo |
| [`update-agent.md`](./update-agent.md) | The Node/TS agent: repo placement, `package.json`, `Dockerfile`, `docker.ts`, `snapshot.ts`, `index.ts`, tests | Ghost monorepo |
| [`ghost-core-handoff.md`](./ghost-core-handoff.md) | Admin API endpoints, auth, config flag, UI state machine | Ghost core |

## The idea in one paragraph

Ghost admin gets an "Update now" button (Owner-only). Pressing it makes Ghost
**write a request file** to a shared volume — it does not, and cannot, run any
Docker command. The privileged `update-agent` container watches that volume,
validates the request against a shared Zod schema, takes a database snapshot,
pulls the pinned Ghost image, recreates the `ghost` container via the Docker API
(preserving its network alias so Caddy keeps routing), health-checks the result,
and rolls back on failure. Progress is written back to the same volume as a
status file that the admin UI polls. Major-version upgrades are intentionally
out of scope.

## Decisions locked

| Decision | Choice | Rationale |
|---|---|---|
| Transport (Ghost → agent) | **File-drop + fs.watch** (`request.json` → `status.json`) | No listener inside the privileged container; smallest attack surface; instant via inotify |
| Agent implementation | **Node/TypeScript**, published image `ghost/update-agent` | Lives in Ghost monorepo, tested in CI, shares Zod types with core |
| Recreate mechanism | **Docker API via `dockerode`** (Watchtower model) | Socket-only; no project-dir mount or `COMPOSE_PROJECT_NAME` coupling |
| Contract | **Shared Zod package** imported by core + agent | Single source of truth; `.strict()` rejects smuggled fields at the boundary |
| Version-available signal | **Agent digest-drift** + Ghost update-check for display | Digest drift is the true Docker signal; update-check gives friendly version/changelog |
| Pre-update DB snapshot | **On by default, skippable per-update** | Complements `knex-migrator` rollback; deferred to core's own snapshot if it exists |
| Major-version updates | **Out of scope** | Breaking-change risk; the pinned tag (`6-alpine`) already prevents them |

## Prior art (we are not inventing this)

- **Home Assistant Supervisor** — update button lives in the app UI; a separate
  privileged container performs pull+recreate. Exactly this shape. Cautionary
  note: HA is deprecating Supervisor due to it growing into a general-purpose
  manager — hence our "keep the agent single-purpose" invariant.
- **Watchtower** (`nicholas-fedor/watchtower`; original `containrrr/watchtower`
  archived read-only Dec 2025) — reference implementation for token-gated
  triggering and for **recreating a container via the Docker API while
  preserving its config/labels**. Our `recreateWithImage` follows this model.
- **Tecnativa/docker-socket-proxy** — the least-privilege socket-broker pattern.
  Recreating a container needs the root-equivalent API endpoints, which is why a
  fixed-action agent beats a general proxy here.
- **Nextcloud (Docker)** — in-app updater is *disabled* in Docker; official path
  is "pull new image, recreate," and "one major version at a time." Reinforces
  keeping execution out of the app and the major-version guardrail.

## Open confirmations before build

1. **`imageGhostVersion`** assumes the official Ghost image exposes
   `GHOST_VERSION` in its config env (used for the major guard). Verify against
   the image you publish; fall back to the OCI version label or a `package.json`
   read if absent.
2. **`recreateWithImage`** must preserve the `ghost` **network alias** — Caddy's
   `reverse_proxy ghost:2368` and the DB DNS depend on it. This is the one
   behavior to cover with an integration test.
3. Confirm whether current Ghost core already takes a **pre-migration data
   snapshot**. If so, the agent's snapshot can default off and this plan should
   note the precedence.
