# Upgrade supervisor — file-drop protocol v1

The upgrade supervisor runs Ghost updates that a site's owner or administrator
asks for in Ghost Admin. It runs on the host's behalf, within a policy set by the
host's operator. This document is the contract between the two ends:

- **The supervisor**: `supervisor run`, a long-running command of the manager
  image. It is enabled per site with `install --with supervisor`.
- **`FileDropUpgradeAdapter`**: Ghost core's `upgrade` adapter. It writes requests
  and reads status and jobs.

Both ends build from this document. The shapes Ghost renders are the
`@tryghost/adapter-base-upgrade` schemas (`packages/adapters/upgrade-base/src/schemas.ts`
in Ghost). The protocol wraps those shapes and adds nothing to them. What this
document adds is the envelope around them, the exchange's files and ownership,
and the rules each end follows.

Any change to what is on disk changes `protocol`, and this document, both ends
and their fixtures change together. Before the first stable release of
ghost-docker, this is a development format, as
[architecture.md](architecture.md#compatibility) describes.

## What the supervisor is

The supervisor is the host command, run on Ghost's behalf. It is not a job system.
It runs Ghost updates through the same executor as `./ghost-docker update`
(`manager/src/update.ts`), takes the same site lock, and follows the same
[recovery rules](architecture.md#recovery). The file exchange sits in front of
that executor. As a result:

- **One active job.** A job starts only when no job is active and the site lock
  is free. A request that arrives while a job is active, or while another
  operation holds the lock, is claimed and refused at once (`refused`, naming
  what holds the site). There is no queue: Admin shows the active job and offers
  the request again once that job ends.
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
| `supervisor` in `COMPOSE_PROFILES` | `.env` | The supervisor runs. Without it, nothing reads requests. |
| `SUPERVISOR_UPDATES` | `.env` | `minor` (default): any newer release of the site's Ghost major. `patch`: newer releases of the same minor only. |
| `adapters__upgrade__active` | `ghost.env` | `FileDropUpgradeAdapter` lets Ghost show updates and send requests. Install sets it only for a Ghost that has the adapter (see [Installation](#installation)). |

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
the `oneClick` list the supervisor has published at that moment. Otherwise it is
`refused` with `target-unapproved`.

The job then pulls exactly `<toVersion>-<variant>`. If that image reports any
other `GHOST_VERSION`, the job is refused. The supervisor pins and runs the
digest of what it pulled. Request text never reaches a shell or an image
reference: the only value taken from a request is a version that is already
known.

## The exchange

The exchange is two named volumes in `compose.yml`, defined for every site. Ghost
mounts both on every site. Without the supervisor they stay empty and the default
`NoopUpgradeAdapter` never reads them. Ghost boots whether or not they hold
anything.

| Volume | Owner, mode | Ghost (`ghost` service) | Supervisor |
| --- | --- | --- | --- |
| `upgrade_requests` | Ghost's uid : operator's gid, `2770` | `/run/ghost-upgrade/requests`, read-write | `/run/ghost-upgrade/requests`, read-write |
| `upgrade_status` | operator's uid : operator's gid, `0755` | `/run/ghost-upgrade/status`, **read-only** | `/run/ghost-upgrade/status`, read-write |

The supervisor's private state is in the site directory, in
`.ghost-docker-supervisor/` (operator-owned, `0700`). Ghost never mounts it. That
directory holds:

- each job's full record: the digest it pins, the stage reached, the backup's
  path and the lock;
- the discovery cache;
- the pruned-job list.

It survives `docker compose down -v`, which empties the volumes, and it is the
record the interrupted-on-start rule reads.

### Ownership

Ghost can write only `upgrade_requests`. Everything Ghost reads but must not
change is in `upgrade_status`, a separate volume. Ghost mounts it read-only and
does not own it. A writable parent directory therefore never contains
supervisor-owned files.

- **Ghost's uid:** read from the pinned Ghost image (`id -u ghost`). The
  next-variant images use 1000. If the image has no `ghost` user, the
  supervisor refuses to start.
- **Operator's uid/gid:** the `SUPERVISOR_UID` and `SUPERVISOR_GID` that install
  records, those of whoever ran it. The supervisor runs as that user, with the
  Docker socket's group, as every manager command does.
- **Setting ownership:** volumes are created owned by root. On every start, the
  supervisor checks both volume roots, and sets their owner and mode with a
  short-lived root helper when they differ. That covers first start, a
  `down -v`, and a Ghost update that changed Ghost's uid.

The supervisor needs a local Docker daemon, on the socket paths the launcher
supports. It refuses to start under rootless Docker or user-namespace remapping,
where container uids do not match the host's, and on a remote daemon. It sees
the site directory at its own absolute host path, so Compose resolves binds on
the host, as every manager command does.

### Files

| Path | Written by | Read by | Bound |
| --- | --- | --- | --- |
| `requests/<id>.json` | Ghost | supervisor | 4 KiB |
| `status/status.json` | supervisor | Ghost | 256 KiB |
| `status/jobs/<id>.json` | supervisor | Ghost | 64 KiB |

`<id>` is a job ID, as defined in [Job IDs](#job-ids). Any other name in
`requests/` is ignored and, if older than 10 minutes, removed.

Rules for each side:

- **Reading, by the supervisor:** requests come from Ghost, which the host
  trusts less than itself, so the supervisor opens them with `O_NOFOLLOW`, then
  `fstat`s the descriptor. A request must be a regular file within its bound,
  read to the bound plus one byte so an oversize file is refused without being
  read in full. One with more than one link is left for the next scan rather
  than claimed: Ghost's own request has two for an instant, between `link` and
  `unlink`. The supervisor opens only names it constructed and never follows a
  name out of the exchange.
- **Reading, by Ghost:** plain reads. Ghost reads only what the supervisor
  wrote, and its own requests, and the supervisor is the more trusted end, so
  the checks above would protect nothing there.
- **Writing:** both ends write a temporary file (`.tmp-<random>`) in the target
  directory, `fsync` it, then move it into place. The supervisor uses `rename`.
  Ghost uses `link` followed by `unlink`, so a request never replaces one that
  already exists. The directory is `fsync`ed afterwards.
- **Permissions:** the supervisor writes files `0644`. Ghost's requests are
  `0640`, set with `fchmod` whatever Ghost's umask. The requests directory is
  setgid, so a request takes the operator's group rather than Ghost's, and the
  supervisor reads it through that group.

## Messages

Every file is an envelope:

- `protocol`: the integer `1`.
- One base-schema body.
- The few fields the transport itself needs.

A reader refuses any `protocol` it does not know. Ghost reports that as
`availability: 'incompatible'`, and the supervisor reports it as a
`refused` job.

### Request

```json
{
  "protocol": 1,
  "request": {
    "component": "ghost",
    "toVersion": "6.72.0",
    "idempotencyKey": "9f2c…64 lowercase hex…"
  }
}
```

- **`request`:** `createUpgradeRequestSchema`, as it is.
- **File name:** the job ID derived from `idempotencyKey`.
- **Request time:** the file's mtime. The supervisor refuses a request whose
  mtime is more than 10 minutes old, or more than 1 minute in the future, with
  `request-expired`.

### Job

```json
{
  "protocol": 1,
  "job": {
    "id": "3b2c…",
    "state": "backing-up",
    "component": "ghost",
    "fromVersion": "6.68.0",
    "toVersion": "6.72.0",
    "createdAt": "2026-10-14T20:01:02Z",
    "updatedAt": "2026-10-14T20:01:09Z",
    "diagnostics": []
  }
}
```

`job` is `upgradeJobSchema`. The supervisor never writes `pending`: a request it
has not claimed has no job file yet, and the adapter answers `pending` from the
request file itself.

Diagnostics are plain text meant for Admin:

- **Bounds:** at most 10 entries per job.
- **`source`:** `ghost-docker`.
- **`help`:** links to [install.md](install.md)'s recovery sections.

What the operator must do goes in `message` and `details`, and paths are given
relative to the site directory. The backup a job took is named in the diagnostic
of every final state.

### Status

```json
{
  "protocol": 1,
  "heartbeatAt": "2026-10-14T20:01:15Z",
  "status": {
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
  },
  "prunedJobIds": []
}
```

- **`status`:** the supported branch of `upgradeStatusSchema`. The supervisor
  writes only `ready`, `busy` or `unavailable`:
  - `busy`: a job is active, or another operation holds the site lock.
  - `unavailable`: something the operator must resolve. Examples are an
    interrupted job's lock, an unreadable lock, a leftover
    `.ghost-docker-update/`, or an unreachable daemon.

  A diagnostic always says which of these it is.
- **`heartbeatAt`:** rewritten every 15 seconds, and with every other change to
  the status.
- **`pollAfterMs`:** `2000` while a job is active, `30000` otherwise.
- **`prunedJobIds`:** the 50 most recently pruned job IDs, newest first.

### Job IDs

A job's ID is the request's `idempotencyKey` itself: 64 lowercase hex
characters, which the base `upgradeJobIdSchema` (an opaque token) accepts. The
request file is `requests/<idempotencyKey>.json` and its job
`status/jobs/<idempotencyKey>.json`. Ghost has the ID before the supervisor has
seen the request, a repeated key always names the same job, and one intent has
one file name.

The key reveals nothing to reuse: Ghost's Admin API hashes the client's key with
the caller's own user ID, so knowing one lets nobody replay someone else's
request.

## What each end does

### Ghost: status

1. **No status file**, or the exchange is missing: answer
   `{supported: true, availability: 'unavailable'}` with a diagnostic. Ghost
   reports `{supported: false, reason: 'not-configured'}` only when the adapter
   is not active.
2. **Unknown `protocol`**, or an envelope or body that fails its schema: answer
   `incompatible`, with a diagnostic.
3. **`heartbeatAt` more than 60 seconds old**, or more than 60 seconds in the
   future: answer `stale`.
4. **Otherwise:** return `status` as it is.

### Ghost: create a request

A replay is answered before any availability or policy check, so a retry
after a lost answer learns its job even while that job runs, or once its update
is no longer offered.

1. **Take the job ID**, the key, and read status for its `prunedJobIds`.
2. **Look for an earlier request with the same key:**
   - If `status/jobs/<id>.json` exists: return its job when `component` and
     `toVersion` match, otherwise reject with `idempotency-conflict`.
   - If `requests/<id>.json` exists: compare it the same way, and return a
     `pending` job.
   - If the ID is in `prunedJobIds`: reject with `request-expired`.
3. **Check status.** If it is not `ready`, reject with `unavailable` (for
   unavailable, stale or incompatible) or `busy`.
4. **Check the target.** If `{component, toVersion}` is not in `oneClick`, reject
   with `target-unapproved`.
5. **Write `requests/<id>.json`** with `link`. If the name already exists, an
   identical request raced this one: run step 2 again.
6. **Return** `{id, state: 'pending', component, toVersion, createdAt, updatedAt}`.
   Both timestamps are the time of writing.

### Ghost: look up a job

Check, in order, and return the first that applies:

1. `status/jobs/<id>.json` exists: return its `job`. A job file whose `job.id`
   is not its file name is refused as malformed.
2. `requests/<id>.json` exists, and its mtime is under 10 minutes old: return
   `pending`.
3. The ID is in `prunedJobIds`, or the request is older than 10 minutes:
   return `expired`.
4. Otherwise: return `unknown`.

A `pending` job that stays pending while the heartbeat is fresh means the
supervisor has not claimed the request yet. Status reports a stopped supervisor
as `stale`.

### Supervisor: claiming

Every 2 seconds, the supervisor reads up to 32 entries of `requests/`. It takes
only names of the form `<key>.json` (64 hex characters), oldest mtime first, and leaves alone any
with more than one link, which Ghost is still writing (removed only once more
than 10 minutes old). For each:

1. **Check for a duplicate.** If a private record for that ID already exists, the
   request is a duplicate that the adapter's look-up raced: remove it and do
   nothing else.
2. **Claim it.** Create the private record exclusively (`O_CREAT|O_EXCL`). This
   is the claim: a request is claimed once, by one supervisor, whatever happens
   to the request file afterwards.
3. **Validate it.** Read and validate the request. A malformed request is
   `refused` with `malformed`. A request is also malformed when it fails its
   bound, the file checks, the schema or `protocol`, or when its file name is not
   `request.idempotencyKey`. A request whose time is out of bounds is refused with
   `request-expired`.
4. **Check that the site is free.** If a job is active or the site lock is held,
   the request is `refused` with `busy`, naming the holder.
5. **Check the target.** If it is not in `oneClick`, the request is `refused`
   with `target-unapproved`.
6. **Publish the job file, then remove the request.** The adapter therefore
   always finds one or the other.

A refusal is a finished job with one diagnostic. Claiming also prunes the history
(see [Retention](#retention)).

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

1. **Set ownership.** Check the volumes' ownership and set it if needed.
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
3. **Publish, then discover.** Publish status from the last discovery at once,
   so the heartbeat starts before the slow image pulls, then run discovery and
   publish again. A request whose ID already has a record is removed on the
   first scan.

## Retention

The supervisor keeps the active job and the 20 most recently finished jobs, both
as private records and as job files.

- **Pruning:** when a request is claimed, older finished jobs are pruned.
  Their IDs go into `prunedJobIds`, which keeps 50 IDs.
- **Stray files:** request files older than 10 minutes are removed.

That is the whole retention rule.

## Installation

`install --with supervisor` does the following:

- adds `supervisor` to `COMPOSE_PROFILES`;
- records `SUPERVISOR_UID`, `SUPERVISOR_GID` and `MANAGER_IMAGE_REF` (a
  checkout uses `ghost-docker:checkout`) in `.env`;
- sets `SUPERVISOR_UPDATES=minor`.

Install enables `FileDropUpgradeAdapter` in `ghost.env` only when the site's
Ghost is at least the first release that ships it. That release is recorded in
`manager/src/ghost.ts` once Ghost releases it. Below that version, install leaves
the adapter off and says so. The supervisor still runs, and requests can be made
by hand. Ghost's settings, for when Ghost reaches that release:

```
adapters__upgrade__active=FileDropUpgradeAdapter
adapters__upgrade__FileDropUpgradeAdapter__exchangePath=/run/ghost-upgrade
```

`self-update` keeps `MANAGER_IMAGE_REF` on the release it installs, so the
supervisor runs the same manager as the launcher. It refuses while a job holds
the lock.

## Requests by hand

These work before Ghost has an adapter. They write and read the exchange through
a short-lived container that runs as Ghost's uid and mounts the volumes as Ghost
does. They therefore exercise Ghost's permissions, not the operator's:

```bash
./ghost-docker supervisor status
./ghost-docker supervisor request ghost 6.72.0
./ghost-docker supervisor job <id>
```

`request` follows [Ghost's steps](#ghost-create-a-request), using a random
idempotency key, and prints the job ID.

## Fixtures

`manager/test/fixtures/upgrade-supervisor/` holds valid and invalid examples of
each message. The supervisor's tests read them. Ghost's adapter tests should read
copies of them at the same `protocol`. A fixture changes only together with this
document.
