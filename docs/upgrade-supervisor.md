# Upgrade supervisor — HTTP protocol v1

The upgrade supervisor runs Ghost updates that a site's owner or administrator
asks for in Ghost Admin. It runs on the host's behalf, within a policy set by the
host's operator. This document is the contract between the two ends:

- **The supervisor**: `supervisor run`, a long-running command of the manager
  image. It is enabled per site with `install --with supervisor`, and serves a
  small HTTP API on a Unix socket.
- **`HttpUpgradeAdapter`**: Ghost core's `upgrade` adapter, the API's client.

Both ends build from this document. The bodies are the
`@tryghost/adapter-base-upgrade` schemas (`packages/adapters/upgrade-base/src/schemas.ts`
in Ghost), as they are. What this document adds is the transport: the socket and
who may reach it, the endpoints, their status codes, and the rules each end
follows. Nothing in it is specific to Docker, so another host can serve the same
API, over TCP with a bearer token.

Any change to the API changes `protocol`, and this document, both ends and their
fixtures change together. Before the first stable release of ghost-docker, this
is a development format, as [architecture.md](architecture.md#compatibility)
describes.

## What the supervisor is

The supervisor is the host command, run on Ghost's behalf. It is not a job system.
It runs Ghost updates through the same executor as `./ghost-docker update`
(`manager/src/update.ts`), takes the same site lock, and follows the same
[recovery rules](architecture.md#recovery). The API sits in front of that
executor. As a result:

- **One active job.** A job starts only when no job is active and the site lock
  is free. A request that arrives while a job is active, or while another
  operation holds the lock, is rejected at once as `busy`, naming what holds the
  site. There is no queue: Admin shows the active job and offers the request
  again once that job ends.
- **Durable status.** Every stage boundary of a job is written atomically before
  the side effect that follows it. That record is the only journal: it says
  where a job stopped and which backup it took. Nothing replays it.
- **Interrupted, never resumed.** A job the supervisor finds unfinished when it
  starts is marked `interrupted`. That happens when the supervisor, Docker or
  the host stopped mid-job. The job is never resumed or retried, and the lock it
  holds stays held for the operator. The operator resolves it as they would a
  crashed CLI `update`.
- **Bounded history.** The supervisor keeps the active job and the 20 most recent
  finished jobs.

Out of scope: queues, concurrent jobs, resuming or retrying, scheduled or
unattended upgrades, configurable retention, and stack updates run from Admin.

## Policy

The host's operator decides whether a site can be updated from Admin, and within
what limits. Ghost's owner/admin authorization permits requests only within that
policy.

| Setting | Where | Meaning |
| --- | --- | --- |
| `supervisor` in `COMPOSE_PROFILES` | `.env` | The supervisor runs. Without it, nothing answers on the socket. |
| `SUPERVISOR_UPDATES` | `.env` | `minor` (default): any newer release of the site's Ghost major. `patch`: newer releases of the same minor only. |
| `adapters__upgrade__active` | `ghost.env` | `HttpUpgradeAdapter` lets Ghost show updates and send requests. Install sets it only for a Ghost that has the adapter (see [Installation](#installation)). |

These rules are fixed rather than set by policy:

- **Majors are never one-click.** `update` does not perform major upgrades.
- **Every job takes a consistent, checked backup** before it changes anything,
  as `update` does, so status always reports `backupRequired: true`.
- **Stack updates are never one-click.** They replace the supervisor's own image
  and can change `compose.yml`, so they stay a host command
  (`./ghost-docker self-update`).

## Available updates

The status lists updates in the base schema's two lists. Admin renders both
without rules of its own for any component.

| Situation | List | `reason` and `steps` |
| --- | --- | --- |
| Newer Ghost in the site's major, within `SUPERVISOR_UPDATES` | `oneClick` | — |
| Newer Ghost in the site's major, outside `SUPERVISOR_UPDATES` (`patch` policy, newer minor) | `manual` | The host allows patch updates only. `./ghost-docker update <version>` in the site directory. |
| The next Ghost major exists | `manual` | Major upgrades are not run from Admin. Points to the operator guide. |
| Newer stack release on the site's channel (image installations) | `manual` | The update replaces the supervisor itself. `./ghost-docker self-update`. |
| A Ghost the policy would allow, but which needs a newer stack | `manual` | Names the stack release it needs. Reserved: no release declares this yet. |

Checkouts report no `stack` entries. Git and Compose own their updates, and the
supervisor cannot tell what a newer checkout is.

Each component names its versions:

- **`ghost`**: the version is the image's `GHOST_VERSION`.
- **`stack`**: the version is the manager release, `vX.Y.Z`.

### Discovery

Discovery works as `update --check` does: the supervisor pulls
`<major>-<variant>` (and `<major+1>-<variant>`) and reads `GHOST_VERSION` from
the image. A tag that pulls is not by itself evidence of an update. The version
must order with semver, be newer than the site's, and come from a next-variant
image.

- **When it runs:** on start, then every 6 hours, and after each job.
- **When a check fails** (registry unreachable or rate-limited): the last result
  is kept, a warning diagnostic records the failed check, and `oneClick` is
  emptied once the last success is more than 24 hours old.
- **Stack releases:** found the way `self-update --check` finds them.

### Target allowlisting

A request's `component` must be `ghost`, and `{component, toVersion}` must be in
the `oneClick` list the supervisor offers at that moment. Otherwise it is
rejected as `target-unapproved`.

The job then pulls exactly `<toVersion>-<variant>`. If that image reports any
other `GHOST_VERSION`, the job is refused. The supervisor pins and runs the
digest of what it pulled. Request text never reaches a shell or an image
reference: the only value taken from a request is a version that is already
known.

## The socket

The supervisor listens on `/run/ghost-upgrade/supervisor.sock`, in a named
volume, `upgrade`, defined in `compose.yml` for every site.

| | Mount | Access |
| --- | --- | --- |
| Ghost (`ghost` service) | `/run/ghost-upgrade`, **read-only** | connects to the socket |
| Supervisor | `/run/ghost-upgrade`, read-write | creates the socket, and listens |

Without the supervisor the volume stays empty and the default
`NoopUpgradeAdapter` never looks in it. Ghost boots whether or not the socket
exists.

### Who may connect

The socket's permissions are the authentication. There is no shared key.

- **The directory is the gate.** The volume root is owned by the operator's
  uid and Ghost's gid, mode `0750`. The socket inside it is `0666`. So only the
  operator and Ghost's group can reach the socket, and nothing but Ghost and
  the supervisor mounts the volume.
- **Ghost cannot replace the socket.** Its mount is read-only. Connecting to a
  Unix socket is not a write to the filesystem, so the read-only mount does not
  stop Ghost from connecting.
- **Ghost's uid and gid:** read from the pinned Ghost image (`id -u ghost`,
  `id -g ghost`). The next-variant images use 1000. If the image has no `ghost`
  user, the supervisor refuses to start.
- **Operator's uid/gid:** the `SUPERVISOR_UID` and `SUPERVISOR_GID` that install
  records, those of whoever ran it. The supervisor runs as that user, with the
  Docker socket's group, as every manager command does.
- **Setting ownership:** volumes are created owned by root. On every start, the
  supervisor checks the volume root, and sets its owner and mode with a
  short-lived root helper when they differ. That covers first start, a
  `down -v`, and a Ghost update that changed Ghost's uid. It then removes a
  socket left by an earlier run and listens.

A forged request from anything else in Ghost's container can still only run an
update already offered as one-click, with a backup taken first.

The supervisor needs a local Docker daemon, on the socket paths the launcher
supports. It refuses to start under rootless Docker or user-namespace remapping,
where container uids do not match the host's, and on a remote daemon. It sees
the site directory at its own absolute host path, so Compose resolves binds on
the host, as every manager command does.

### What the supervisor keeps

Its private state is in the site directory, in `.ghost-docker-supervisor/`
(operator-owned, `0700`). Ghost never sees it. That directory holds:

- each job's record: the job, the stage reached, the backup's path and the lock;
- the discovery cache;
- the IDs of pruned jobs, so it can answer `expired` for them.

It survives `docker compose down -v`, and it is the record the
interrupted-on-start rule reads.

## The API

All paths are under `/v1`. Request and response bodies are JSON
(`application/json`). A request body is at most 4 KiB.

| Endpoint | Success | Body |
| --- | --- | --- |
| `GET /v1` | `200` | `{"protocol": 1}` |
| `GET /v1/status` | `200` | the supported branch of `upgradeStatusSchema` |
| `POST /v1/requests` | `202` accepted, `200` a replay | the job (`upgradeJobSchema`) |
| `GET /v1/jobs/<id>` | `200` | the job, or `{"id": "<id>", "state": "unknown" \| "expired"}` (`upgradeJobResultSchema`) |

A failure is a status code with an error body:

```json
{ "error": { "code": "busy", "diagnostics": [ … ] } }
```

| Status | `code` | When |
| --- | --- | --- |
| `400` | `malformed` | The body is not JSON, or fails `createUpgradeRequestSchema`; or a job ID fails `upgradeJobIdSchema`. |
| `404` | `not-found` | No such endpoint. |
| `405` | `method-not-allowed` | The endpoint does not take that method. |
| `409` | `busy` | A job is active, or another operation holds the site lock. |
| `409` | `idempotency-conflict` | The key was used for another update. |
| `410` | `request-expired` | The key's job has been pruned. |
| `413` | `too-large` | The body is over 4 KiB. |
| `422` | `target-unapproved` | The update is not offered as one-click. |
| `503` | `unavailable` | Something the operator must resolve; the diagnostics say what. |

`code` is one of the base `upgradeErrorCodeSchema` codes wherever one fits.
`diagnostics` follows `upgradeDiagnosticsSchema`.

### Status

```json
{
  "supported": true,
  "availability": "ready",
  "backupRequired": true,
  "currentVersion": "6.68.0",
  "oneClick": [{ "component": "ghost", "fromVersion": "6.68.0", "toVersion": "6.72.0" }],
  "manual": [
    {
      "component": "stack",
      "fromVersion": "v1.4.0",
      "toVersion": "v1.5.0",
      "reason": "A stack update replaces the upgrade supervisor itself, so it runs on the host.",
      "steps": ["In the site directory, run ./ghost-docker self-update"]
    }
  ],
  "activeJobId": null,
  "pollAfterMs": 30000,
  "diagnostics": []
}
```

The supervisor reports only `ready`, `busy` or `unavailable`:

- `busy`: a job is active, or another operation holds the site lock.
- `unavailable`: something the operator must resolve. Examples are an
  interrupted job's lock, an unreadable lock, a leftover `.ghost-docker-update/`,
  or an invalid `SUPERVISOR_UPDATES`.

A diagnostic always says which of these it is. `pollAfterMs` is `2000` while a
job is active and `30000` otherwise.

### Job

```json
{
  "id": "9f2c…64 lowercase hex…",
  "state": "backing-up",
  "component": "ghost",
  "fromVersion": "6.68.0",
  "toVersion": "6.72.0",
  "createdAt": "2026-10-14T20:01:02Z",
  "updatedAt": "2026-10-14T20:01:09Z",
  "diagnostics": []
}
```

An accepted job starts as `pending` and moves through the executor's stages to
a final state ([Running a job](#supervisor-running-a-job)). `refused` is rare: it
is for a refusal decided after acceptance, such as an image that does not report
the version asked for. Refusals decided when the request arrives are error
responses instead.

Diagnostics are plain text meant for Admin:

- **Bounds:** at most 10 entries per job or status.
- **`source`:** `ghost-docker`.
- **`help`:** links to [install.md](install.md)'s recovery sections.

What the operator must do goes in `message` and `details`, and paths are given
relative to the site directory. The backup a job took is named in the diagnostic
of every final state.

### Job IDs

A job's ID is the request's `idempotencyKey` itself: 64 lowercase hex
characters, which the base `upgradeJobIdSchema` (an opaque token) accepts.
Ghost knows the ID before it sends the request, and a repeated key always names
the same job.

The key reveals nothing to reuse: Ghost's Admin API hashes the client's key with
the caller's own user ID, so knowing one lets nobody replay someone else's
request.

## What each end does

### Ghost: reaching the supervisor

Ghost connects with Node's `http` and `socketPath`, with a 5-second timeout. It
reports:

- `{supported: false, reason: 'not-configured'}` when the adapter is not active;
- `unavailable` when the socket is missing, refuses the connection or times
  out, or answers `503`;
- `incompatible` when `GET /v1` does not answer `200 {"protocol": 1}`, or a body
  fails its base schema.

Ghost checks the protocol once per process and again after any failure.

### Supervisor: a request

`POST /v1/requests` is decided in this order. A replay is answered before any
availability or policy check, so a retry after a lost answer learns its job
even while that job runs, or once its update is no longer offered.

1. **Read it.** Over 4 KiB is `413`. Not JSON, or not the request schema, is
   `400 malformed`.
2. **A replay?** If the key has a job: the same `component` and `toVersion`
   answer `200` with that job; anything else is `409 idempotency-conflict`. If
   the key's job was pruned: `410 request-expired`.
3. **Available?** If the supervisor is `unavailable`: `503`. If it is `busy`:
   `409 busy`, naming what holds the site.
4. **Offered?** If `{component, toVersion}` is not in `oneClick`:
   `422 target-unapproved`.
5. **Accept it.** Create the job's record exclusively, take the site lock
   (`409 busy` if another operation took it first), answer `202` with the
   `pending` job, and start the job.

The checks and the acceptance run without yielding to another request, so two
requests can never both be accepted.

### Supervisor: a job lookup

`GET /v1/jobs/<id>` answers the job when it has a record, `expired` when the ID
was pruned, and `unknown` otherwise.

### Supervisor: running a job

The supervisor takes the site lock as `supervisor job <id>: update Ghost to
<version>`, then runs the same plan as `update <version>`.

Before each step, the job is written in its new state:

| State | Before |
| --- | --- |
| `pulling` | Pulling exactly `<toVersion>-<variant>`, and checking its version |
| `backing-up` | The snapshot, the writer pause and the checked backup. The backup's path is recorded as soon as the backup exists. |
| `restarting` | Starting the services, after the new pin is written |
| `verifying` | Verification |
| `restoring` | Recovery, after a failure |

The final state is the executor's outcome:

| Final state | When | Diagnostic |
| --- | --- | --- |
| `done` | The update succeeded. | Names the backup. |
| `restored` | It failed before startup was attempted. The files are back and the services are as they were. | Names the backup. |
| `needs-operator` | Startup was attempted, or recovery itself failed. | Gives the backup and the operator's choices, as `update` prints them. |

Rules while a job runs:

- The supervisor never starts, stops or recreates its own container. Compose
  operations in a job name the site's services other than `supervisor`.
- The lock is released when a job reaches `done` or `restored`. After
  `needs-operator`, the lock is also released, as it is after the CLI's
  `update`: the site is stopped and the diagnostic says what to do.

### Supervisor: starting

1. **Set ownership.** Check the volume's ownership and set it if needed.
2. **Mark unfinished jobs interrupted.** Any private record that is not final is
   rewritten as `interrupted`. Its diagnostic names the stage it reached, the
   backup (if one was taken), whether it held the lock, and the operator's
   steps, in an order that works:
   - run `./ghost-docker check`;
   - remove the lock, since `restore` and `update` refuse while it is held;
   - for a job past `backing-up`: fix and start the new Ghost, or
     `./ghost-docker restore --yes <backup>`. For a job in `backing-up`:
     `docker compose up -d`, because the writers may be paused;
   - once `check` passes, remove `.ghost-docker-update/`.

   A lock naming an interrupted job is left in place. While it is held, status is
   `unavailable`.
3. **Listen, then discover.** Listen at once, offering what the last discovery
   found, so Ghost and the health check get answers before the slow image
   pulls; then run discovery.

## Retention

The supervisor keeps the active job and the 20 most recently finished jobs.
When a request is accepted, older finished jobs are pruned, and their IDs are
kept, up to 50, so a lookup or a replay of one answers `expired`.

That is the whole retention rule.

## Installation

`install --with supervisor` does the following:

- adds `supervisor` to `COMPOSE_PROFILES`;
- records `SUPERVISOR_UID`, `SUPERVISOR_GID`, `MANAGER_IMAGE_REF` (a checkout
  uses `ghost-docker:checkout`) and `DOCKER_SOCKET` in `.env`;
- sets `SUPERVISOR_UPDATES=minor`.

Install enables `HttpUpgradeAdapter` in `ghost.env` only when the site's
Ghost is at least the first release that ships it. That release is recorded in
`manager/src/ghost.ts` once Ghost releases it. Below that version, install leaves
the adapter off and says so. The supervisor still runs, and requests can be made
by hand. Ghost's settings, for when Ghost reaches that release:

```
adapters__upgrade__active=HttpUpgradeAdapter
adapters__upgrade__HttpUpgradeAdapter__socketPath=/run/ghost-upgrade/supervisor.sock
```

`self-update` keeps `MANAGER_IMAGE_REF` on the release it installs, so the
supervisor runs the same manager as the launcher. It refuses while a job holds
the lock.

## Requests by hand

These work before Ghost has an adapter. They call the API through a short-lived
container that runs as Ghost's uid and mounts the volume as Ghost does, so they
exercise Ghost's access, not the operator's:

```bash
./ghost-docker supervisor status
./ghost-docker supervisor request ghost 6.72.0
./ghost-docker supervisor job <id>
```

`request` sends a random idempotency key and prints the job ID.

## Fixtures

`manager/test/fixtures/upgrade-supervisor/` holds valid and invalid examples of
each body: the request, status, job, job lookup and error responses. The
supervisor's tests read them. Ghost's adapter tests should read
copies of them at the same `protocol`. A fixture changes only together with this
document.
