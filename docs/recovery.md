# Recovery checkpoints

S4 introduces `scripts/recovery.sh` and a containerized manager. The host still
needs only the installer prerequisites; Node runs inside the manager. A source
checkout builds its own manager before downtime and executes the resulting image
ID. Releases publish `ghcr.io/tryghost/ghost-docker/manager`; set
`GD_MANAGER_IMAGE=ghcr.io/tryghost/ghost-docker/manager@sha256:…` to use a published
immutable digest. Mutable image tags are refused. The journal, checkpoint and installation metadata (when present) record the actual
manager image ID. Publication is wired to release tags; no registry publication is
needed to use a source checkout.

```sh
scripts/recovery.sh backup --keep 5
scripts/recovery.sh status
```

Backups are private directory checkpoints under `.ghost-backups/`, **not migration
bundles**. Copy the entire checkpoint directory to private off-host storage. It
contains database credentials and all site data. Completed checkpoints have a
versioned manifest and SHA-256 inventory. Incomplete `.partial-*` directories are
never offered as completed backups or removed by retention. Retention removes only
verified completed checkpoints, keeping the newest requested count (default five).
A failed backup remains journaled; inspect it and run `recover` to restore the
previous service state. Partial files remain available for inspection/removal.

The initial supported configuration is the stack-managed MySQL database, local or
production mode, optionally ActivityPub, and data bind mounts beneath
`PROJECT_DIR/data`. External MySQL, Compose overrides, symlinks/hardlinks/special
files, analytics, supervisor, rootless Docker and user namespaces are refused
before downtime. Local Unix sockets are required; Docker Desktop/OrbStack must
share the site's absolute path with the daemon. The manager mounts that same path,
the socket, and (for restore) a read-only checkpoint. Docker socket access is
host-privileged. No unrelated host directories are mounted writable.

A checkpoint includes:

- A logical SQL dump of the explicitly selected Ghost database, and ActivityPub's
  database when enabled, including schema, triggers, routines and events.
- The entire Ghost content tree, including hidden files, themes and ActivityPub
  uploads, with recorded ownership and modes.
- `.env`, `ghost.env`, installation metadata when present, the stack's Compose
  definition, MySQL initialization scripts and the full Caddy configuration tree.
- Exact registry image digests, manager identity and file checksums.

Caddy's certificate and cache volumes are regenerated, so activation may need
certificate issuance. Analytics is currently refused because its persistent queues
and remote deployment state need their own recovery contract. Ghost/ActivityPub
backups do not undo delivered email, payments, webhooks, federation messages or
other remote effects. Extra databases unrelated to the enabled services are not
included. External writers to the managed databases must be stopped by the
operator; an enabled MySQL event scheduler with active events is refused.

Backup disables restart policies and stops every application/ingress container,
including background workers and custom Caddy routes, while leaving MySQL running.
Requests fail to connect during maintenance. The stopped ingress is intentional:
custom routes cannot bypass a maintenance response. After snapshot verification,
the manager restores each container's previous restart policy and running/stopped
state and verifies readiness before reporting completion. It checks available space
with conservative database/content allowances and a 256 MiB reserve; actual write
errors still fail the operation. Checkpoints are published only after file writes,
manifest verification and directory synchronization.

## Restore drill or recovery to a fresh checkout

Restore into a separate checkout with no `.env`, metadata, existing data or
containers belonging to the chosen destination project. Use a checkout containing
S4. The source checkpoint's stack configuration and image versions are restored;
upgrading is a separate operation.

```sh
# Run these from the fresh destination checkout.
scripts/recovery.sh restore /absolute/path/to/checkpoint \
    --project ghost-rehearsal --local --port 2468
scripts/recovery.sh status
# Once you intend to run this copy normally:
scripts/recovery.sh activate
```

`--local` changes the destination's mode, URL and port and disables optional
profiles for a rehearsal. Without it, the checkpoint's mode/URLs/profiles are
retained. `--project` is always explicit and must not already exist on this daemon.
Generated production routes are rendered for the new identity at activation;
operator Caddy files are retained and must be appropriate for the destination.

Restore checks the checkpoint before mutation, pulls its immutable images, restores
SQL and files, compares every table row count and the content inventory, then boots a temporary Ghost without published ports on an internal
Docker network. This verification container can reach MySQL but cannot send mail or
webhooks to external services. It is removed after verification. Normal Ghost,
ActivityPub, jobs and Caddy remain stopped. The journal remains at `verified` until
`activate`; configuration helpers also remain locked out by that journal.

**Activation enables normal outbound behavior and ingress.** Use it only when the
copy is intended to become a running site. Production cutover, DNS and ensuring the
old site no longer accepts writes are operator responsibilities. Activation verifies
Compose health and production proxy routing before clearing the journal. Restore
does not overwrite an existing installed site: preserve that site and use a fresh
destination. It does not claim an automatic rollback of a live deployment.

## Interrupted operations

Every supported mutating entrypoint (install, config edits, Caddy edits and
recovery) shares `.ghost-operation-lock`. The manager also keeps a durable
`.ghost-operation.json` journal, written before side effects. `site.sh check`
reports unresolved operations. Direct `docker compose` commands bypass these
safeguards; do not run them concurrently with managed operations.

```sh
scripts/recovery.sh status
scripts/recovery.sh recover
```

Locks never expire by age. Recovery checks the host PID, Docker daemon identity and any manager container;
a live or ambiguous owner is not stolen. An unreachable daemon prevents reclamation.
An incomplete owner record requires manual inspection. A reused PID can conservatively
block recovery; inspect the owner rather than deleting a live lock.

For interrupted backups, recovery reconciles saved container identities and returns
them to their original state. It does not promote an unfinished checkpoint. For a
restore that has never activated, recovery removes any verification container and
repeats restoration from the same verified checkpoint into the same destination.
Partial SQL restores cannot be mistaken for resumable imports. Once activation has
begun, recovery only retries readiness/activation; it **never replays the checkpoint**
because new writes may already exist. Failed restore verification leaves ingress
blocked. Preserve the journal and checkpoint until recovery is resolved.

## Verification

`node --test tests/recovery.test.mjs` checks lock exclusion/reclamation, daemon
identity, checkpoint integrity, retention, failed durable writes (`ENOSPC`) and
SQL producer/consumer exit propagation. The standard helper suite also covers the
host configuration interfaces that share the lock.

`GD_TEST_RECOVERY=1 node --test --test-timeout=1800000 tests/recovery-e2e.test.mjs`
runs real local, HTTPS production and ActivityPub restore drills. Each kills the
host dispatcher while its backup manager is still alive, checks that recovery
cannot steal that lock, kills the manager, and recovers. It also kills restore
during verification and recovers without ingress. Assertions cover database values,
active theme, hidden assets, application configuration including multiline literal
values, private checkpoint permissions, isolation, activation and restart policy.
These drills run in CI. The release publishing workflow itself requires a release
tag and package publishing credentials.
