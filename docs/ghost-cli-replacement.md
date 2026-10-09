# Plan: ghost-docker as a Ghost-CLI replacement

Status: re-based 2026-10-05 around a manager image. This is an implementation
plan, not authorization to execute its steps.

This document lives in the repository so that every branch carries the
contracts it is implementing against. Amend it in the pull request that changes
a decision, rather than letting the code and the plan drift apart.

**How we got here.** A first implementation was written as bash scripts on the
`next` branch: configuration and Compose foundation (S1), an installer (S2) and
local bundle import (S5b), about 3,900 lines of bash with a Node test suite.
It worked, and it showed where the approach was heading: every remaining step
(portable import, updates, backup, multi-site) would be more bash, while backup,
upgrades and the supervisor were already planned for a container image, leaving
the logic split across two languages. This branch, `next-docker`, starts again
from `main` with one implementation: a small CLI inside a manager image, started
by a launcher that needs only Docker. `next` is frozen and kept as the behaviour
reference; where a step below ports something that exists there, it names the
files.

Repos involved:

- `TryGhost/ghost-docker`: the Compose stack, the manager image, the launchers.
- `TryGhost/Ghost-CLI`: migration bundle export (`ghost migrate-export`, released
  in 1.33.0).
- `TryGhost/Ghost`: upgrade adapter and Admin API (PR #31277, open), and Admin UI.

Each step in §3 is a separate work package and a separate pull request. Read its
dependencies and the contracts in §2 before implementing it.

## 1. Scope and decisions

| Topic | Decision |
| --- | --- |
| Initial audience | Local and single-site production installations; most servers run one site. Theme developers and migration-tool authors moving local Ghost-CLI sites come first. |
| Site model | One directory = one site. One `compose.yml`, with `local` and `production` modes selected through `COMPOSE_PROFILES`. |
| Where tooling runs | In a **manager image** published from this repository: a TypeScript CLI with its own dependencies and Compose. The host runs only a **launcher** that checks Docker and starts the image. See §2.10. |
| Supported platforms | Production: Linux with Docker Engine (rootful), the counterpart of Ghost-CLI's Ubuntu with systemd. Local sites: also Docker Desktop, OrbStack and WSL2. Rootless Docker is best effort: the identity rules handle it (§2.10), but it is not in the qualification matrix. |
| Host requirements | Docker Engine 25.0+ with the Compose v2.24+ plugin, and bash for the launcher. No `jq`, `curl`, `git` or Node on the host. `git` only when working from a clone. |
| Distribution | The manager image carries `compose.yml`, the Caddy configuration and the CLI, and writes them into the site directory. A tagged release is an image tag. A git clone of this repository also works: the launcher builds the image from the checkout and uses the files in place. See §2.7. |
| Docker socket | The manager is given the Docker socket for every command, including install. That is host-privileged, and it is accepted: whoever runs the launcher already has that access. |
| File ownership | Everything the manager writes into the site directory is owned by the user who ran the launcher. The entrypoint starts as root to read the socket's group, then drops to the caller's uid and gid. See §2.10. |
| Windows | Through WSL2 only, which is Linux: Docker Desktop's WSL2 backend puts `docker` and its socket inside the distro, and the launcher runs there unchanged. No native launcher; §2.10 records the design to use if one is ever wanted. |
| Versions | Resolve and persist an exact Ghost image version on installation. Ghost upgrades and stack updates are separate operations. Record resolved image digests for recovery. |
| Installation | Scriptable `install`, with a flag for every prompt. Local mode uses MySQL too. |
| Migration | Ghost-CLI exports a bundle (`ghost migrate-export`, Ghost-CLI 1.33.0+); the manager imports it. Three kinds: `mysql-dump` (MySQL sources), `mysql-data` (default for local SQLite sources: data-only MySQL inserts loaded into a schema Ghost creates), and `portable` (an explicit SQLite fallback through the Admin API). For a `portable` bundle the manager installs the site and places its content; its content JSON and members CSV are imported through Ghost Admin on the new site, as anyone moving a Ghost site by hand does today. Moving a site is documented, not wrapped: `ghost stop`, `ghost migrate-export`, `install --import` on the source's port. The legacy `scripts/migrate.sh` stays on `main`, where it works, and is not carried onto this branch, whose layout it does not understand; it disappears from `main` when this branch merges, which S12 allows only after production import (S5e) has passed its tests. |
| Upgrades | Optional supervisor using a file exchange and the Docker socket. Ship a tested host-driven upgrade first, then reuse its recovery contract in the supervisor. Both are commands of the manager. |
| UX | Standard Compose commands for daily operation; `./ghost-docker` for installation, diagnosis, configuration, migration, backup/restore, and upgrades. No wrapper binary named `ghost`. |
| Configuration | `.env` contains Compose/operator settings; `ghost.env` contains only Ghost application settings. Do not pass the whole `.env` into Ghost. A mounted Ghost JSON config file was evaluated as a replacement for `ghost.env` and rejected; see §2.1. |
| Recovery rigor | Ghost-CLI's level, made reliable: back up before changing, restore on failure, report truthfully, one operation at a time on a site (§2.5). No journals, maintenance ingress or crash-resume; more is built only when a real failure shows it is needed. |
| Shared infrastructure | S13: one Caddy shared by several sites on a server, each site keeping its own MySQL. Not a dependency of local or single-site production installations. Scheduled after tagged single-site production and before Admin-driven upgrades, so the upgrade supervisor is built once against per-site projects. |
| ActivityPub and analytics | Per-site, including for future members of shared infrastructure. Each site owns its ActivityPub database/storage and Tinybird configuration/deployment lifecycle. |
| Ghost nightly channel | Future explicit opt-in via `--ghost-channel nightly`; published to GHCR, independently of the stack release channel. Stable remains the default. |
| Service image registry | Future `--image-registry dockerhub|ghcr` selects dual-published traffic-analytics and ActivityPub images, including migrations. |
| Redis | Default on new installations once S16 ships, with explicit `--without redis` opt-out. |
| Tests | Unit tests for the CLI in TypeScript. End-to-end scenarios that only run the real commands and check outcomes are shell scripts in `tests/e2e/`, so they do not depend on how the commands are implemented. |

Explicitly document initial limitations: no shared-infra provisioning, no automatic
major Ghost/MySQL upgrades, no arbitrary downgrade support, and no import of a
`portable` bundle's content JSON and members CSV (they go through Ghost Admin).

## 2. Architecture and contracts

### 2.1 Compose modes and configuration

Initial service profiles:

| Service | Profiles | Lifecycle |
| --- | --- | --- |
| `ghost` | `local`, `production` | Long-running |
| `db` | `local`, `production` | Long-running |
| `caddy` | `production` | Long-running |
| `traffic-analytics` | `analytics` | Long-running, per-site |
| `activitypub` | `activitypub` | Long-running, per-site |
| `activitypub-migrate` | `activitypub` | One-shot |
| `tinybird-*` | `analytics` | Setup/deployment jobs, per-site |
| `upgrade-supervisor` | `supervisor` | Long-running, optional |

Caddy is part of the `production` mode, not an optional profile. Making
bring-your-own-proxy a first-class path was considered and rejected: it would
mean owning validation of the operator's proxy configuration, and the failure it
guards against is subtle — a wrong `X-Forwarded-Proto` yields incorrect absolute
URLs and non-secure cookies, so the site half works rather than failing. That is
a poor thing to support on someone else's proxy.

An operator who already runs nginx or Apache can still do it, as a manual
customization rather than a supported mode: Ghost publishes on
`127.0.0.1:${GHOST_PORT}` in every mode, so they point their proxy there and
edit `compose.yml` to drop the caddy service or move it off 80/443. Document
that this is unsupported and that stack updates may touch `compose.yml`.

Profiles are additive, not mutually exclusive or conditional configuration. Validate
that exactly one site mode is selected. Optional services must not accidentally
activate unrelated modes. Explicitly targeted Compose services can run even when
their profiles are inactive; helper commands must account for dependencies.

Example generated Compose settings (credentials omitted):

```dotenv
# Local
COMPOSE_PROFILES=local
COMPOSE_PROJECT_NAME=ghost-local-example-secondary-roadrunner
PROJECT_DIR=/absolute/path/to/site
NODE_ENV=development
URL=http://localhost:2368
GHOST_PORT=2368
RESTART_POLICY=no
GHOST_VERSION=6.3.1-alpine
DATABASE_HOST=db
DATABASE_NAME=ghost
DATABASE_USER=ghost

# Production uses the same variable contract with:
# COMPOSE_PROFILES=production
# NODE_ENV=production
# URL=https://example.com
# RESTART_POLICY=unless-stopped
# Optional: ADMIN_URL=https://admin.example.com
# Optional profiles are added only after their configuration is validated.
```

Requirements:

- Ghost publishes `127.0.0.1:${GHOST_PORT:-2368}:2368`. When no port is supplied
  the installer starts at 2368 and skips ports that Docker's own containers
  already publish, which is what keeps several local sites apart. An explicit
  port is never changed. See "Ports are not probed" in §2.8.
- Parameterize database host, name, and user now, even though single-site defaults
  remain `db`/`ghost`/`ghost`. Use the same connection contract for backup and import.
- Set a unique Ghost network alias `ghost-${COMPOSE_PROJECT_NAME}` and use it in
  generated proxy routes and helper clients. Never rely on `ghost` for shared-network
  addressing when S13 is introduced.
- Persist the project name independently of the directory name. Moving a site still
  requires updating and validating `PROJECT_DIR` and bind mounts.
- Choose a local project name no project on the daemon has (the directory's
  name and a random adjective-animal pair), and refuse, before any change, a
  project whose containers another directory made: Compose addresses a
  project by name alone.
- Use `restart: ${RESTART_POLICY:-unless-stopped}` only for long-running services.
  Setup, migration, and deployment jobs retain `restart: "no"`.
- Initially `URL` may be required because every supported mode contains Ghost. Do
  not put `:?` guards on optional-service variables such as `PROJECT_DIR`.
  Validate requirements by mode before provisioning or startup. Revisit URL's guard
  before adding infra-only mode in S13.
- Keep the initial default network naming unchanged. Do not introduce an empty
  `name:` as a guessed equivalent of an omitted field.
- `ghost.env` is the only application `env_file` for the initial release. Explicit
  Compose environment entries override container-owned keys; the importer
  rejects/omits those keys.

Application configuration stays in `ghost.env`. Replacing it with a mounted
Ghost JSON config file was evaluated, because dotenv cannot hold an arbitrary
value safely: Compose interpolates `env_file` values, so an SMTP password of
`Pa$$w0rd!` reaches Ghost as `Pa$w0rd!`, and `s3cr$t!` reaches it as `s3cr!`,
with no error anywhere. It was rejected — the findings are recorded here so the
question is not reopened from scratch.

Verified against `ghost:6-alpine` (Ghost 6.61.0, nconf 0.13.0):

- The image ships `config.production.json` in Ghost's install directory
  (`/home/ghost` in the `next` variants, `/var/lib/ghost` in the older layout),
  with `config.development.json` symlinked to it. It sets `url`, `server`,
  `mail.transport: "Direct"`, `logging.transports`, `process`, `security` and
  `paths.contentPath`.
- nconf is first-added-wins, and `loader.js` registers `custom-env`
  (`config.<env>.json`) *before* `local-env-jsonc` (`config.local.jsonc`). So
  `config.local.jsonc` cannot override anything the image ships, including
  `mail.transport`, and is unusable as the operator's config file.
- A file mounted over `config.<env>.json` is read, and all value shapes survive:
  strings, numbers, booleans, nested objects, storage adapters, labs flags. A
  `$` in a value survives verbatim.
- Compose `environment` entries outrank every config file, so container-owned
  keys stay enforced by construction either way.
- nconf coerces env var types too (`port=465` arrives as a number), so the env
  form loses nothing on typing.

Why it was rejected:

- Comments are the main reason to prefer a config file over dotenv for
  hand-editing, and they require JSONC. `jq` cannot parse JSONC at all, so
  validation and every programmatic read would fail on a commented file, and
  writes would strip the comments. The format would fight the tooling.
- Strict JSON keeps `jq` working but has no comments, and because the image
  already ships `config.production.json`, our file would replace it rather than
  layer over it — pinning a hand-maintained copy of the image's defaults that
  silently drifts when the image changes them. Layering would need a Ghost
  loader change registering a custom-env JSONC file *before* `custom-env`.
- Multi-line values are awkward in both directions: JSON requires `\n` escapes,
  dotenv allows literal newlines that the helpers refuse to edit.

Under the manager CLI the tooling objections weaken, since JavaScript can read
and write JSONC. The layering objection is unchanged and decides the question on
its own.

The residual risk is accepted: a hand-written `$$` is indistinguishable from a
correctly escaped single `$`, so no linter can catch it. Mitigation is to write
values with `./ghost-docker config set`, which encodes correctly, and
`config validate`, which catches the bare-`$` case. Document that hand-editing a value containing
`$` is unsafe.

The initial release keeps `ghost.env`, including for imports of older Ghost
versions. A future JSONC format would require a Ghost loader change and an
explicit compatibility/migration design; it is not a dependency of any step here.

- Add site/mode labels and a real Ghost readiness probe. A running container or
  redirect response alone does not establish readiness.
- Cap container logs and make optional-service resource costs visible.

Before publishing the minimum Docker/Compose versions, run the mode matrix against
that exact minimum and a current version. The installed Compose v5.1.2 accepted
interpolated restart `no` and network `external=true`; that is not verification of
older versions. Include `start_interval` and any env-file features in compatibility
checks. The launcher is the only host code: keep it free of GNU-only behaviour
and runnable by bash 3.2.

### 2.2 Environment values, metadata, and permissions

The manager must never source or evaluate an env file. Define a serializer
and parser with round-trip tests through Docker Compose itself, including `$VAR`,
`${VAR}`, `$$`, spaces, quotes, backslashes, newlines, empty strings, and JSON arrays.
Do not assume double-quoted values are literal: Compose interpolates them.

Keep arbitrary application configuration in `ghost.env`; root DB credentials,
project paths, network settings, and other operator controls stay out of Ghost's
environment. Write credential-bearing files privately, with restrictive umask and
atomic replacement preserving intended ownership/mode. Logs list sensitive key names,
never their values. Add file-based credentials later only for supported Ghost images.

`.ghost-docker.json` is gitignored and contains a schema version, installation time,
mode, release channel, how the stack was installed (`image` or `checkout`), installed
stack version/commit and the manager image the site's launcher is pinned to, project
identity, the resolved Ghost image, a checksum of every file written from the image
(§2.7), and completed migrations. An installation that predates metadata must be
supported explicitly.

Backup, restore, Ghost upgrade and stack update take a lock file (`.ghost-docker.lock`) in the site
directory for the length of the operation, so two of them cannot run on one site
at once. A lock left behind by a crashed run names its operation and start time;
`check` reports it and how to remove it, and nothing removes it automatically.
Install and import write into an empty directory, and `config set` replaces one
file atomically, so they do not lock.

### 2.3 Caddy and optional services

- Track a generic Caddyfile importing `sites/*.caddy` and operator-managed
  `custom/*.caddy` and `global/*.caddy`. Ignore the site's routes and operator
  files in Git.
- `install` renders the site's routes once, into `sites/site.caddy`, with
  explicit upstreams (the site's network aliases), public/admin domains and
  optional-service targets, and every import argument; missing arguments may
  survive adaptation and fail at runtime. After that the file is the
  operator's, as Ghost-CLI's generated nginx file was: no command rewrites it,
  and changing routes is editing it and reloading Caddy. Verification (§2.8)
  confirms Caddy serves each domain. Most servers run one site and set their
  routes once; a validate/install/reload/rollback command for them was built
  in N3 and taken out again as not worth its code. Shared infrastructure (S13)
  brings generation back where several sites share one Caddy.
- Use explicit reload in production, not `--watch`. Caddy documents watch as a local
  development feature. Use `docker compose --project-directory "$DIR" ...`, not `-C`.
- Migrations must preserve custom routes. Do not silently replace a customized
  Caddyfile with a generated approximation after printing a warning.
- ActivityPub, its migration job, database grants, storage, and serving URL belong
  to the site. Test retrieval of uploaded ActivityPub assets through the site's URL.
- Tinybird credentials/workspace selection and schema deployment belong to the site.
  Treat sync and deploy as distinct steps. A Ghost upgrade must run the required
  deployment after sync, not merely copy new files into a volume.
- Specify schema compatibility and recovery for analytics before automated upgrades
  with analytics are supported. Do not imply a Ghost DB restore undoes remote schema
  changes. Unsupported combinations must fail preflight with an actionable message.

### 2.4 Bundle format and migration

Reference: `docs/migration-bundle.md` in Ghost-CLI at tag `v1.33.0`, the first
release containing `ghost migrate-export` (PR #2333). The released exporter is the
authority for what a bundle contains, and `docs/bundle-v1.md` in this repository
matches it.

Bundle kinds:

| Kind | Source | Database payload | Import path |
| --- | --- | --- | --- |
| `mysql-dump` | MySQL/mysql2 | Schema and data for the selected database | Provision, load, start Ghost |
| `mysql-data` | Local SQLite; the exporter's default | Data-only MySQL `INSERT`s for every table, including migration history; `database.rows` holds per-table counts | Provision, boot Ghost once at the exact source version to create the schema, stop it, load, verify counts, start Ghost |
| `portable` | Local SQLite with `--sqlite-format portable` | Content JSON and members CSV from the Admin API | Provision, place the content, start Ghost on an empty database; the JSON and CSV through Ghost Admin |

`mysql-data` is the expected route for local SQLite sites and preserves IDs, staff
credentials, members and settings. `portable` is the exporter's fallback for a
source whose data it refuses to write as `mysql-data` (values MySQL would
reject). The manager installs the site and places its content, Ghost creates an
empty database on first start, and the summary names what is left in Ghost
Admin: the owner account, the content JSON, the members CSV and the theme. That
is what Ghost-CLI users do today when they move a site, and its losses are those
of Ghost's own import.

Before freezing the contract:

- Define `config` as a map of flattened keys to raw string values, without embedded
  dotenv quoting. The importer serializes these values safely for Docker Compose.
- Require `bundleCreatedAt` and `sourceInstallType: local|production`. Infer installation
  mode from `sourceInstallType`; validate kind, supported Ghost version, and all paths.
- Update exporter, importer, documentation, and fixtures together before freezing
  bundle v1. The unpublished draft format does not need backward compatibility.
- Test actual Compose round trips rather than only comparing exporter strings.
- Record the consistency/cutover behavior: the exporter currently restarts Ghost.
  Add a documented final-export mode that leaves the source stopped, with explicit
  operator selection, and preserve the current restart behavior for ordinary exports.
  Portable exports support local SQLite development sites only: content API export,
  then members CSV, then stop Ghost and copy assets. Captures are sequential; users
  must avoid editing during export. Do not implement write-freeze machinery or
  require Ghost changes. Final export leaves the source stopped for cutover.

Import sequence:

1. Validate target state and available space. The target is always a fresh site
   directory; refuse merging into an existing database or content tree.
2. Inspect/extract into private staging. Reject path traversal, absolute member paths,
   and escaping symlinks/hardlinks, including in directory bundles. Bound expansion
   and check space for extracted content, database restore, and recovery copies;
   compressed archive size times 1.5 is not a sufficient estimate.
3. Read/validate the manifest from the staged copy against the manifest schema
   (see "Reading the bundle" in `docs/bundle-v1.md`). This cannot depend on an
   already-valid site `.env` or already-running Ghost. Importing a bundle means
   trusting it, so the guarantees are that it cannot write outside the site
   directory and that its SQL runs as the site's own database user.
4. Resolve the exact source Ghost image and check architecture/availability before
   changing the target. Import at the source version; upgrading is a separate step.
5. Generate `.env` and `ghost.env`; retain operator URL/mode overrides. Omit
   container-owned config including `url`, `admin__url`, database, server, paths,
   process, logging, and upgrade-adapter controls. Map public/admin URLs deliberately,
   preserving supported path/port semantics or rejecting unsupported URLs clearly.
6. Stage content including hidden files and establish ownership appropriate to the
   selected Docker mode. Do not blindly apply host uid 1000 under rootless/userns.
7. Restore the selected database only, with explicit connection and database name.
   `mysql-dump` does not contain CREATE DATABASE/users/grants. Provision first, then
   restore before Ghost is started; propagate pipeline failures. `mysql-data`
   contains no schema at all: provision an empty utf8mb4 database, start Ghost
   once at exactly `ghost.version` with no ingress so it creates its own schema
   and fixtures, stop it, then load `database.sql` with the `mysql` client and
   compare per-table `COUNT(*)` with `database.rows`. Never synthesize DDL from
   the bundle.
8. Verify the expected content and records, the active theme and assets, redirects,
   URLs and configuration. A failed import removes what it created, so it is
   re-run rather than resumed.
9. Cutover is the operator's, documented rather than automated: take a final
   export with `--leave-stopped`, so the source cannot take writes the copy will
   not have; import; then point DNS at the new host, or on the same server stop
   the old proxy and start the new site's Caddy. The source stays intact until
   the operator removes it.

A copied database sends real email, newsletters and webhooks once it runs, so the
documentation says to stop the source before the destination starts serving, and
to remove mail settings from a copy started elsewhere as a rehearsal.

#### Local imports

A local import targets a fresh site directory that has never served traffic, so
it does not depend on the S4 recovery runtime. The failure contract is simpler: nothing
outside the new site directory is modified, and a failed import removes what it created
(containers, the data it wrote into directories it had verified empty,
configuration, staging) so the same command can be run again in the same
directory. While an import is in progress the directory is marked incomplete and
`.env` selects no Compose service, so an import interrupted before it could clean
up cannot be started; the next import clears it first. There is no ingress to
switch (step 9).

A production import differs only in step 9 and in its URLs: separate admin URLs,
and an existing proxy holding 80 and 443 on the same server.

#### Moving a local site

There is no `--migrate` command. Moving a local Ghost-CLI site to Docker is
documented as three steps in `docs/install.md`, "Moving a site to Docker":

1. `ghost stop` in the source. The exporter never starts a source that was
   stopped, so the bundle is the source's final state and nothing writes to
   the source afterwards. No `--leave-stopped` is needed.
2. `ghost migrate-export --output PATH`, with PATH outside the installation
   (the exporter refuses one inside it).
3. `install --import PATH --port PORT` in a new directory beside the source,
   with the source's own `server.port`, now free. If it fails, it removes
   what it created; `ghost start` in the source puts the operator back where
   they began.

A launcher wrapper was built for S5c and dropped before it merged (PR #344).
Over these three commands it added a confirmation, a default directory and
port, and a restart on failure that was needed only because it stopped the
source itself. It cost about 280 lines of host bash in a launcher that is
meant to hold no logic, and it parsed Ghost-CLI's output (the version line,
the exporter's messages, `.ghostpid`). Ghost-CLI's own exporter is the right
place to say what to run next, since it knows the site's port; it will print
the next steps once more of the plan has landed.

### 2.5 Backup, upgrade, and recovery

Ghost-CLI's level, made reliable. Ghost-CLI's `ghost update` installed the new
version beside the old one and could switch back; `ghost backup` exported the
content. This stack does the same with a real database backup, and states what
it does:

- a backup is taken and checked before an upgrade or a stack update changes
  anything;
- a failure restores that backup and the previous image and configuration;
- the outcome is reported truthfully: done, restored, or needs the operator,
  with what to do;
- two operations cannot run on one site at once (the lock in §2.2).

Not built: journals that resume an operation killed at an arbitrary point,
maintenance ingress, retention policies, and a fault-injection matrix. A crashed
operation leaves its lock and its backup; `check` says so, and the operator
restores or re-runs. Each is added only when a real failure shows it is needed,
in the step that needs it.

**Backup** is a directory under `backups/` in the site: a `mysqldump` of each of
the site's databases (Ghost's, and ActivityPub's when that profile is on) taken
as the site's user, a tarball of the content directory, `.env`, `ghost.env`,
the site's Caddy files, `compose.override.yml`, the metadata and, in image
mode, the stack's files and launcher, and a manifest naming the exact image of
each service, every table's row count and every file's checksum. Checked means
every dump loads into a scratch MySQL of the site's own image and the archive
lists; until then it is `backups/.<id>.partial`, and a failure removes it. It
is written private, and kept until the operator removes it. State outside the
site (a Tinybird workspace), Caddy's certificates and Mailpit's inbox are named
in the manifest as not included.

A backup is **live** by default, as Ghost-CLI's was: each database one
snapshot, but captured at a different moment from the others and from the
content. `--consistent` stops Ghost and ActivityPub, the services that write
them, while they are captured and starts them again before the check, so
they are one moment of the site at the cost of a brief outage; stack updates
take a consistent one. The manifest records which.

**Restore** works over the backup's own site or into a new, empty directory.
It reads the backup whole and checks every checksum first, then takes the lock
and pulls the recorded images. Over a site it stops the site and sets its
files and data aside in `.ghost-docker-restore/`. It writes the backup's files
with the directory's own path, requires Compose to resolve exactly the
recorded images, unpacks the content, starts MySQL on an empty data directory
and loads each dump as the site's user, checking every table's rows. Then
`up --wait`, and it verifies as `check` does. The outcome is done, or needs
the operator with what to do; the set-aside site is removed only once the
restore is verified.

**Recovery** is one module (`manager/src/recovery.ts`) that restore, stack
updates and, when they land, Ghost upgrades and the supervisor share: services
stopped and their state observed through Compose, never assumed; data and
files set aside one boundary at a time, so instructions name only copies that
exist and never direct a removal on the strength of a step that did not
complete; and a backup's content and databases loaded into the site. It
resumes nothing.

**Ghost upgrade:**

1. Take the lock. Resolve the target to one exact image of the same major and
   pull it before anything stops. Refuse other majors and downgrades.
2. Back up.
3. Change the pin (and its metadata) and `up --wait`. Ghost runs its own
   migrations at boot and rolls back one that fails.
4. Verify as `check` does. On a failure, put the previous pin back and restore the
   backup, then verify again: `restored`, or `needs the operator` if that fails
   too, with the backup's path.

Switching images back is not reversing migrations, and a rollback after traffic
has resumed would discard newer writes: going back to an older version later is
a restore, chosen deliberately, never a side effect of asking for an old tag.

### 2.6 Supervisor and Ghost integration

The supervisor is a command of the manager image (§2.10), enabled per site; it is
not a second image. The Docker socket is
host-privileged; non-root process execution does not remove that authority. The host
operator explicitly enables self-upgrades and controls policy. Ghost owner/admin
authorization permits requests only within that host-defined policy.

The supervisor sees the site directory at the same absolute host path for Compose
bind resolution. Define supported local Docker contexts and socket paths; reject remote
daemons or unsupported rootless setups clearly. Avoid broad writable mounts beyond
what execution requires. Supervisor behavior follows §2.5 rather than inventing a
second upgrade/recovery algorithm.

Write the protocol document before implementing either side. It must include:

- Versioned JSON schemas for status, requests, and jobs; exact version/image fields;
  timestamps/heartbeat; supported capabilities; bounded error details.
- Available updates in the status, in two lists. **One-click**: what the
  supervisor can perform within the host's policy, which Admin offers to run.
  **Manual**: what needs steps on the host, with the reason and the steps, which
  Admin shows as a notice. Each entry names its component (`ghost`, `stack`, and
  any added later) and its from/to versions; Admin renders both lists without
  component-specific rules. Stack updates are always manual: the stack update
  replaces the supervisor's own image and can change `compose.yml`, so it stays
  a host command (`./ghost-docker self-update`). A Ghost upgrade the host's policy
  forbids, or one that needs a newer stack, is manual too and says why.
- Request states including queued, backing-up, pulling, restarting, verifying, done,
  failed, restoring, rolled-back, and recovery-required, plus legal transitions.
- UUID validation, bounded file sizes, no symlink following, exclusive request
  claiming, deduplication, restart recovery, retention, and polling backoff.
- Separate request-write and status/job-read permissions for Ghost. A shared writable
  parent directory must not let Ghost replace supervisor-owned status or job files.
  Define initialization/uid ownership and mount layout explicitly.
- Atomic publication and durable journaling around side effects. A POST can return
  an accepted job ID before the supervisor claims it; distinguish pending, unknown,
  expired, stale supervisor, and protocol mismatch rather than treating all 404s as
  a restart indefinitely.
- Strict target allowlisting, argument-array subprocess invocation, no shell input,
  host-enforced major/backup policy, and the shared site operation lock.

Ghost adapter type: `upgrade`. Canonical implementation names:
`NoopUpgradeAdapter` and `FileDropUpgradeAdapter`; use these exact names in config,
code, docs, and tests. Enable FileDrop only for a compatible Ghost version and an
initialized exchange. Noop remains the default. Absence of a supervisor is a
supported state, not a Ghost startup failure.

Admin API: status, create request, and fetch job. Owner/admin only, rate-limited POST,
with the normal Admin auth/permission conventions. Admin feature-detects both absent
endpoints on older cores and `supported: false`. Polling survives restart with a
bounded reconnect period and useful stalled/recovery-required states. UI backup
promises must match the actual enforced policy.

Version discovery must handle registry pagination, rate limits, stale cache, semver
ordering, image architecture, and compatibility requirements. A valid Docker tag
alone is not evidence that an upgrade path is supported.

### 2.7 Releases, distribution and updates

A release is an image. `ghcr.io/tryghost/ghost-docker` is built from this
repository and carries the CLI and the **release payload**: every file
`compose.yml` needs beside it in order to run every profile.

| Payload | Why |
| --- | --- |
| `compose.yml`, `compose.ipv6.yml` | The stack |
| `caddy/Caddyfile`, `caddy/snippets/` | Mounted by the `caddy` service |
| `mysql-init/` | Mounted by `db`; creates the ActivityPub database |
| `tinybird/` | Build context of the Tinybird helper services in the `analytics` profile |
| `.env.example`, `ghost.env.example` | Reference |

The payload is defined by what `compose.yml` references, not by this table: a
test resolves every bind mount and build context in the Compose file and fails
when one is not in the image. A site installed from the image with no checkout
must be able to start both optional profiles. Building the Tinybird helpers at
install time is a cost of the current stack; publishing them as images instead
belongs with service image distribution (S14). Tags:

| Tag | Meaning |
| --- | --- |
| `vX.Y.Z`, `vX.Y.Z-beta.N` | A release. Immutable. |
| `stable`, `beta` | The newest release on that channel. Moving. Used only to *resolve* a release. |
| `edge` | Built from the development branch on every push. Not a release. |

Releases are cut as Ghost's and Ghost-CLI's are: a Release workflow, run by
hand, works out the next version from the squash commits since the last
release (a ✨ feature makes it a minor; anything else, dependency updates
included, a patch), tags `next-docker`, and publishes the image, its moving
tags, the GitHub release (notes from the commits that carry a release-note
emoji) and the served launcher. release-please was planned and not used: it
reads only Conventional Commits, and this repository's titles are past-tense
sentences, so it would have found nothing to release. Version selection is
numeric and tested, never lexical. Until the legacy migration exists (S6b)
every release is a beta, and `main` keeps the pre-`next-docker` layout that
existing installations update with `git pull`.

Rules:

- **A site is pinned to a digest.** Installation resolves a channel or tag to
  one image digest, records the version and digest in `.ghost-docker.json`, and
  writes a launcher into the site directory that runs exactly that digest. A
  moving tag is never what a site runs.
- **The image writes the files.** The release payload in the site directory is
  a copy of the image's, written by `install` and replaced by `self-update`. They are not
  edited by operators; operator-owned files are `.env`, `ghost.env`,
  `caddy/sites/site.caddy` (written once by `install`), `caddy/custom/` and
  `caddy/global/`. A release that changes a snippet's arguments must say how
  to change the site's routes, or carry a migration that edits them; it may
  not overwrite them. The manager records a checksum of each
  file it wrote, so `self-update` can tell an untouched file from an edited one. An
  untouched file is replaced. An edited one is kept, the release's version is
  written beside it as `<file>.new`, and `self-update` names both; it never asks.
- **Clone mode.** A launcher that finds itself in a checkout of this repository
  builds the image locally from that checkout and uses the files in place,
  writing nothing over them. Metadata records `source: checkout` and the commit
  the site was last installed or updated at. This is how the stack is
  developed, and how someone who wants to read everything first installs it.

  Updating such a site is `git checkout` of a newer ref followed by
  `./ghost-docker self-update`. That is the same update as in image mode — validate,
  pull the service images the new `compose.yml` names, apply, verify — except
  that the payload is already in place and is not written. A tracked tree with
  local modifications is refused. On a failure the updater puts the operator's
  files back and checks out the previous commit (recorded in metadata), and the
  launcher has kept the previous manager image, tagged with its commit.
- **The launcher is served** by GitHub Pages, deployed from GitHub Actions,
  with the custom domain `docker.ghost.org`: `https://docker.ghost.org/install.sh`.
  It is the repository's own `ghost-docker`, published by a workflow on release
  and never by hand. Test the served file rather than the checkout's copy.

`./ghost-docker self-update [--check] [--channel stable|beta] [--to vX.Y.Z]` updates
the stack, not Ghost. Preserve the exact Ghost pin; if a stack release requires a
newer Ghost, stop with the required upgrade sequence. Initially reject stack
downgrades unless the relevant migrations explicitly support them.

The names follow Ghost-CLI, where `ghost update` updates Ghost: `update` is
Ghost's (S7), and ghost-docker's own update is `self-update`. A bare `update`
is an unknown command until S7 lands; there is no alias to the stack's.

The updater is the *target* release's image, started by the site's launcher. It
runs entirely outside the files it replaces, which is what makes this tractable:
there is no script rewriting itself mid-run.

Flow:

1. Take the lock; in clone mode refuse a dirty tracked tree.
2. Resolve the release, refuse a downgrade, and record the previous version and
   digest.
3. Back up (§2.5). A snapshot in `.ghost-docker-update/` keeps the operator's
   files and, in image mode, the payload being replaced; the backup keeps the
   databases and content, which a release's services may migrate even when
   Ghost's pin does not change.
4. Write the managed files, run the release's migration scripts in order (each
   recorded in metadata when it completes), validate Compose, pull images, `up
   --wait`, and verify as `check` does.
5. On a failure, put the previous payload and configuration back (in clone mode,
   by checking the previous commit out). Once services had changed, stop them
   first and load the backup's databases and content (recovery.ts) before `up
   --wait` and verify. Report restored or needs the operator. Never report
   success because `up -d` returned zero.
6. On success, rewrite the site's launcher to pin the new digest. The launcher
   holds the pin, so it is replaced even when edited; an edited copy is kept as
   `ghost-docker.edited`.

Migration `0001-compose-profiles` moves an installation made from `main` before
this layout: it must handle both an absent profile setting and existing
`analytics,activitypub` values, adding `production` in either case. Split
application config into `ghost.env`, preserve credentials and project identity, add
URL/PROJECT_DIR and an exact pin for the currently running Ghost version. Move an
existing untracked Caddyfile aside before the managed one is written. Preserve
customizations automatically when supported; otherwise stop before changing the
live setup and present the required configuration resolution. Test custom routes,
legacy Compose overrides, skipped releases, repeat invocation, and failed hooks.

Existing installations have no launcher. Their way in is the served launcher run
from inside the checkout (`curl -fsSL https://docker.ghost.org/install.sh | bash
-s -- self-update`); do not tell them to use raw `git pull` to cross the breaking
change.

### 2.8 The launcher and its commands

```text
ghost-docker install [--local | --domain example.com [--admin-domain admin.example.com]
                                [--email ops@example.com]]
                     [--dir PATH] [--port 2368] [--version 6.3.1]
                     [--channel stable|beta] [--release vX.Y.Z]
                     [--with analytics,activitypub,supervisor]
                     [--import BUNDLE] [--no-start]
ghost-docker check | info | list
ghost-docker config get|set|validate ...
ghost-docker self-update | backup | restore | update  (as their steps land)
```

First use is the served launcher:

```sh
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- install --domain example.com
```

On Windows that command runs in a WSL2 terminal.

Installation writes a copy of the launcher into the site directory, pinned to
the image digest that installed it. Every later command is `./ghost-docker ...`
from there.

Unknown options fail clearly with exit `2`. An option whose step has not landed
does not exist until it does, so it is an unknown option like any other. Use the
terminal for interactive input even when the launcher itself was piped from
`curl`; `--no-prompt` must not silently accept destructive choices, and every
prompt has a flag or environment-variable equivalent.

Preflight is split by what has to work when Docker is broken:

- **In the launcher**, before any image is pulled: Docker is installed, the
  daemon answers within a deadline, the Compose plugin is present. Test daemon
  access by asking the daemon, never from `docker` group membership. These are
  the only checks that cannot run in a container.
- **In the manager:** Docker and Compose versions, platform and architecture
  (from `docker info`), a writable site directory, disk, memory,
  optional-service credentials, URL/DNS, and Compose/Caddy validation.

**Ports are not probed.** The manager cannot see the host's ports from inside a
container, and the first plan for this branch worked around that by having the
daemon publish each port on a throwaway container. That was dropped: Docker
already refuses to start a service whose port is taken, and says which port.
So:

- A port held by another container is known without probing, from what Docker
  reports its containers publish. The default local port skips those.
- A port held by anything else is discovered when the services start. The
  installer catches that failure, names the port and the option that changes
  it (`--port`), and states that nothing already running was stopped.
- Because the conflict now surfaces after configuration has been written, **a
  failed installation removes what it created**, so the same command can be run
  again in the same directory. Installation needs that for a failed pull or a
  service that never becomes healthy as well.

Supported platforms are as in §1: production on Linux with rootful Docker
Engine, local sites also on Docker Desktop, OrbStack and WSL2. Rootless Docker
is best effort and not claimed as supported; do not infer it from linger alone.

**Reaching a site in order to verify it.** `127.0.0.1` inside the manager is the
manager, not the host, so the first implementation's probes of host loopback
cannot be ported as they were. Each service is judged by its own Compose
health check, which `up --wait` already requires, and the manager repeats none
of them. Only what no health check can answer is asked from the site's own
network (§2.10, "Reaching a site's services"). Nothing is described as more
than it is:

- **Ghost**: its health check, in which the Admin API answers inside the
  container.
- **Caddy**: its health check, in which its admin API answers with its
  configuration loaded. That says Caddy is up, not that the generated routes
  serve each name: Caddy 2.10 redirects any name to HTTPS, served or not (the
  integration tests found this), so a redirect from port 80 would prove no
  more. Proving routing is PLA-517's.
- **Published ports are reported, not verified.** A container cannot reach
  the host's loopback interface on every platform (Docker Desktop and OrbStack
  run the daemon in a VM, rootless Docker in a user namespace), and whether a
  `--network host` container lands on the host cannot always be told from
  `docker info`. So the manager lists the ports Docker
  says it published (`docker compose ps --format json`) and says they were not
  checked from the host; the installer prints the URL, and opening it is that
  check. An earlier revision of N3 probed them from the host's namespace on
  Linux with Docker Engine; it was dropped as not worth its code.
- **HTTPS, as an issuance state, not a probe result.** Caddy obtains a public
  certificate for a public domain name in the background, retrying with
  backoff for up to thirty days, and keeps it in its data volume; it does not
  substitute its internal CA when issuance fails. So before DNS points at the
  host there is no certificate, and no probe can show more. The manager makes
  a TLS handshake with Caddy for the domain and reports *serving* (Caddy
  presents a certificate that names it, with its issuer) or *pending* (the
  handshake fails, or the certificate does not name it; the message names the domain, says
  that Caddy obtains one once the domain's DNS reaches this host, that
  `./ghost-docker check` reports the change, and that `docker compose logs
  caddy` shows each attempt). Telling an issuance error that DNS will not cure
  (a CAA record, a rejected ACME account, a rate limit) apart from the errors
  expected before DNS exists was built and dropped: Caddy's log already says
  which, and the operator is pointed at it. *Pending* is not a failure of
  installation. Temporary internal TLS before DNS is deliberately not offered:
  it would be a second TLS state to transition out of, and a self-signed
  certificate on a public name is a browser warning to click through, which is
  the habit this setup should not teach. Operators who want internal TLS for a
  private name put `tls internal` in `caddy/custom/`, as today.

A production site before its DNS points at the host therefore has Caddy
healthy, its ports reported as published, and HTTPS shown as pending. That is the
expected state of a fresh production installation, and the output says so in
those words.

Keep nginx/apache running until cutover; a server may proxy other applications,
so replacing its whole service requires an explicit operator choice. Installation
never stops or reconfigures anything already running: a port in use is an error
naming the port, and the container holding it when Docker knows one. Bringing your own proxy is a documented manual edit of
`compose.yml`, not a supported mode; see §2.1.

Installation writes configuration, renders routing, initializes permissions and
metadata, then verifies readiness before publishing the Admin URL. `--no-start`
must not start application services. Imported sites follow the isolated flow in
§2.4.

`list` includes stopped containers (`docker ps -a` with labels) and states what
cannot be discovered without a registry. `check` works for single-site installs
and validates actual DB connectivity, configuration, readiness, and recovery
state.

### 2.9 Final-phase image distribution, nightly builds, and Redis

These extensions follow single-site qualification and do not block the initial
release. Their numbering is a delivery sequence, not a requirement to ship shared
infra before single-site registry selection or Redis. Each extends the acceptance
matrix and operator documentation when it ships.

Future installer interface (add only as the relevant steps land):

```text
--image-registry dockerhub|ghcr
--ghost-channel stable|nightly
--without redis
```

Keep `--channel stable|beta` for the ghost-docker stack release. Persist stack channel,
Ghost channel, selected service registry, and resolved image identities separately.
`--image-registry` applies to traffic-analytics, ActivityPub, and its migration image;
it does not promise mirrors of MySQL, Caddy, Redis, stable Ghost, or every other
third-party image. Ghost nightly is GHCR-only regardless of this registry selection.
Help and installation summaries must make that scope clear.

Dual publishing must use a single tested release build for both registries, include
matching architecture manifests and version metadata, and define complete-publication
checks before advertising a release. Verify registry-specific digests; do not assume
references in two registries have interchangeable digests. Persist full resolved image
references and provenance. Registry selection must survive stack updates, upgrades,
backup/restore, and supervisor execution. Changing registries must preserve service
versions and data, and must not silently run database migrations or newer code.

Before stable releases are dual-published, preserve the existing mixed registry
locations. On new installs after S14, default eligible services to Docker Hub; existing
installs keep their recorded locations until explicitly switched. Confirm actual
repository ownership/names in each publishing repo rather than inventing GHCR or
Docker Hub paths. Registry outages or missing architecture artifacts fail clearly;
no silent cross-registry fallback. Public image pulls should work without credentials.

Nightly is an explicitly selected Ghost channel, not a stack prerelease channel and
not an automatic-update schedule. Publish to the agreed Ghost GHCR repository from
an identified source commit, with immutable build tags/metadata and an optional moving
nightly discovery tag. Installation/upgrade resolves discovery to one exact build and
digest; never persist only a moving tag. Use the same Ghost image for tinybird-sync.
Record the Ghost-reported version plus commit/build identity: two nightly builds may
report the same semver. Build discovery and job schemas must handle that deliberately,
without relaxing trusted image allowlists to arbitrary user-supplied references.

Only nightly sites discover nightly updates. Enabling the channel does not bypass
host major-version policy, backups, write freezing, compatibility checks, or recovery.
Stable-to-nightly and nightly-to-stable are explicit compatibility-checked transitions;
returning to stable may require waiting for a compatible release or restoring a
checkpoint because schema migrations cannot be undone by changing a tag. Retain exact
recovery images/build metadata even if registry retention removes old nightly tags.
Show the channel and build identity in CLI/status/Admin where applicable.

Redis becomes the default per-site service for fresh local and production installs
when S16 lands. Add `redis` to the generated profiles by default and support
`--without redis` to retain compatible in-memory Ghost caching. The original §2.1
profile table describes the initial release; S16 extends it as follows:

| Service | Profiles | Lifecycle | Installation default |
| --- | --- | --- | --- |
| `redis` | `redis` | Long-running, per-site | Enabled on new sites unless explicitly excluded |

Use a pinned supported Redis image, private site networking with no published host
port, healthchecks, bounded memory, defined eviction/persistence settings, and
credentials handled through the established secret/config interfaces. Configure the
actual cache features and adapter schema supported by the selected Ghost image;
review `docs/codebase/internal-caching.md`, the built-in Redis adapter, and
[Ghost's cache documentation](https://docs.ghost.org/config#cache-adapters). Do not
assume every older supported image accepts the same cache configuration. Incompatible
images must use a documented supported configuration or fail preflight with the opt-out
path, rather than producing a broken default install.

For existing sites, provide a documented enablement migration that preserves operator
cache overrides and exact image pins. Routine stack updates must not unexpectedly
switch an existing cache backend. Disabling Redis must also remove/revert generated
cache configuration; do not stop it while leaving Ghost pointed at it. Define/test
startup ordering, runtime outage behavior, reconnects, cache invalidation after
upgrade/restore, and the effect of opting out. Do not promise automatic runtime
fallback unless the selected Ghost implementation actually provides it.

Initial Redis use is rebuildable Ghost cache data. Explicitly document whether it is
persisted for warm restarts and whether backups exclude/rebuild it. Potential later
traffic-analytics/ActivityPub use is an extension point, not a claim of current Redis
support. Before wiring any such consumer, verify its released configuration contract
and distinguish disposable cache from durable queues/counters/salts/other state.
Durable state needs appropriate persistence, eviction, isolation, backup/restore, and
upgrade policy; separate instances when policies differ. Key prefixes or Redis logical
DBs alone do not isolate memory/eviction/durability policies. Redis remains per-site
if a shared Caddy (S13) is in use.

### 2.10 Where the tooling runs

Two layers. The boundary is set by one question: does this have to work before
an image can run?

**The launcher.** `ghost-docker` (bash), the only code that runs on the host.
Keep it to a few hundred lines and to exactly these jobs:

- Check that Docker is installed, the daemon answers, and Compose is present, and
  say what to do when they are not.
- Decide which image to run: the digest pinned in the site's own launcher; or a
  release resolved from `--channel`/`--release`; or, in a checkout of this
  repository, an image built from it.
- Start it: `docker run` with the Docker socket, the site directory, the caller's
  identity and a terminal, following the contract below.
- Pass the manager's exit status through unchanged.

Anything that could be a manager command is one; the launcher gains no logic
that the manager could hold.

**The manager image.** A TypeScript CLI on pinned Node and Alpine, with its npm
dependencies, the Compose binary, and the stack's files.
The manager speaks to the daemon over the Engine API on the mounted socket,
with each endpoint it uses typed by a zod schema; it does not parse the
`docker` CLI's output. Compose has no API and is run as a program.
One image, several commands; the upgrade supervisor (§2.6) is one of them, not a
second image. Every operation that reads or changes a site lives here: install,
configuration, Caddy rendering, import, diagnosis, update, backup and restore,
upgrades.

Rationale: §2.6 already requires a privileged image published from this
repository, and requires that it "follows §2.5 rather than inventing a second
upgrade/recovery algorithm". One implementation in that image, used by every
command, is the only arrangement in which that holds. It also removes the host
as a variable: no bash 3.2 compatibility, no GNU-versus-BSD utilities, no list
of required host tools, and the same code path on Linux, macOS and WSL2.

Contract for every manager invocation:

- **The site directory is mounted at its own absolute host path.** Compose bind
  sources are resolved by the daemon against the host filesystem, so a site
  mounted anywhere else silently binds a different host path. Verified: a site
  mounted at `/site` renders `source: /site/data/ghost`, which the daemon then
  creates on the host. The launcher mounts `DIR` at `DIR` and sets it as the
  working directory; the manager refuses to run when `PROJECT_DIR` and its
  working directory disagree.
- **Identity.** The launcher passes the caller's uid and gid, on hosts that
  have them. The entrypoint
  starts as root, reads the group that owns the mounted Docker socket, and drops
  to the caller's uid and gid with that group added, so everything written into
  the site directory belongs to the caller and no ownership is fixed up
  afterwards. Three cases it must recognise:
  - *Rootless Docker:* root in the container already is the caller. Do not drop.
  - *Docker Desktop and OrbStack:* file sharing maps ownership to the caller
    whatever the container user is. Dropping is harmless and still done.
  - *Files owned by a service's user,* such as MySQL's data directory once it
    has run. Removing or archiving those needs root, in a short-lived step that
    does only that.
- **The Docker socket** is host-privileged and is mounted for every command.
  On Linux, support local daemons and the default and rootless socket paths:
  resolve the socket from the active Docker context, and reject a remote daemon
  clearly, because bind mounts would then refer to another machine's
  filesystem. On Docker Desktop and OrbStack the daemon is in a VM and the
  socket to mount is the VM's own, at the default path, whatever the host-side
  endpoint is.
- **Terminal.** Prompts need the launcher to attach a terminal even when it was
  itself piped from `curl`. Every prompt has a flag equivalent.
- **Bundles and other inputs** outside the site directory are mounted read-only
  at their own absolute path, by the launcher, from the options it was given.
- **Exit codes and structured errors** propagate through the launcher
  unchanged. A wrapper that collapses failures into "docker run failed" is not
  acceptable.
- **Compose is run by the manager**, with its own client against the host
  daemon: `--project-directory`, an explicit `-f`, and no inherited
  `COMPOSE_FILE`. `docker compose config` is how configuration is resolved; do
  not reimplement Compose interpolation.

**Reaching a site's services.** The manager does not run programs inside a
site's containers to ask it questions. It joins the site's network and speaks
to each service itself: `mysql2` for the database (connectivity, table and row
counts, migration history), and a TLS handshake for the certificate Caddy
presents (`src/network.ts`, `src/clients.ts`). Ghost, Caddy and Mailpit are
otherwise judged by their own health checks; that Ghost's mail reaches
Mailpit is the install e2e's to prove.

- The network is discovered, never guessed: the one the running containers
  Compose lists for the site share, as the daemon reports them, so a network
  an override renames or makes external is found the same way.
- Each service is addressed by its per-site alias (`db-<project>`), which stays
  unambiguous on a network several sites share, and otherwise by its address
  on that network.
- The manager joins only a network that exists, because a container on it is
  running, and leaves it however the work ends, before anything can take the
  site down: `compose down` cannot remove a network with a container still on
  it. Phases that overlap share one attachment, and the last to finish leaves;
  a network the manager was already on is not taken from it. The supervisor
  (§2.6) repeats these phases on the same code.
- Dumps are still made and loaded by the `mysqldump` and `mysql` of the db
  container's own version, through `compose exec`: the clients ask questions,
  they do not move data. A direct check proves a service answers on the
  site's network; it does not replace the ingress checks of §2.8.

What this rests on, that the daemon resolves the per-site aliases for a
container attached after it started, the network comes down once the manager
has left, and the clients really talk to the stack's MySQL and Caddy,
is what `manager/test/integration` tests, against the real daemon, from a
container of the manager Dockerfile's `integration` stage.

**Engine API client: kept, not Dockerode.** Dockerode was evaluated (PLA-513)
and not adopted. Its 5.x release brings `@grpc/grpc-js`, `protobufjs` and
`tar-fs` for BuildKit sessions and build contexts, and `ssh2` through
`docker-modem` for remote daemons, none of which the manager uses (it refuses
a remote daemon); about 16 MB and 53 packages with the optional native
dependencies left out. Its answers are untyped, so every endpoint would still
be wrapped in the zod schema this section requires, and its tests would need
a fake HTTP server or mocks of its methods in place of the one transport
function they fake now, which is no smaller. Of the client's 536 lines of
code it would replace about 150: the socket transport, the request and
error helpers, scanning a pull's progress stream, demultiplexing a
one-shot container's log stream, and part of the create, start, wait and
remove sequence. About 250 if the zod schemas went too, leaving the
daemon's answers checked by nothing. The rest is the manager's own
policy, which stays either way: rootless detection, the ports of stopped
sites, label filters, a one-shot container's deadline, kill and cleanup,
and joining and leaving networks.

**The Docker CLI is not in the image.** The image carries Compose's
standalone binary, not the `docker` CLI. Adding the CLI would let the manager
run `docker network connect` and the like, at the cost of a second client of
the daemon whose output would have to be parsed; everything it would do is
one Engine API request, typed.

**Windows is WSL2.** Docker Desktop's recommended backend on Windows is WSL2,
and its WSL integration puts `docker` and the daemon socket inside the distro,
so the launcher runs there exactly as on Linux: a Unix socket to mount, a uid
and gid to pass, and a site directory that can be mounted at its own path.
Nothing above is special-cased for it. A migration from a Ghost-CLI install on
native Windows still works, in two steps: `ghost migrate-export` in the
Windows shell, then `install --import` from WSL2 with the bundle under
`/mnt/c/`.

A native Windows launcher was built during N2 and removed before it merged.
It had to assume three things nobody had verified: that the Docker Desktop
VM's socket can stand in for the Windows named pipe, that files written by the
image's default user are usable from Windows, and that `C:\Users\me\site`
is `/run/desktop/mnt/host/c/Users/me/site` to the daemon. Every Windows
PowerShell 5.1 difference cost a CI round trip against a stand-in Docker that
could prove none of it. If native Windows is ever wanted, the design is not a
translating launcher. The manager can `docker inspect` its own container and
read the daemon-side `Source` of the site mount, so the launcher shrinks to a
few lines of `.cmd` with `-v "%CD%:/site"` and the manager learns the daemon's
path at runtime, verified rather than assumed. What that still needs working
out is how Compose, running inside the manager, reads the site's files at
that daemon-side path: a symlink inside the manager, if Compose does not
resolve it away. That is the open question recorded in Linear, and it is not
on the path to any milestone.

**Qualifying a platform** is one path exercised end to end, which `doctor`
performs everywhere: the manager writes a file into the site directory, then
asks the daemon to start a **sibling container that bind-mounts the site
directory by the path the manager was given** and reads the file back. That
fails if the daemon cannot be reached, if the manager's path means a different
directory to the daemon, or if the file is not where the daemon looks.
`version`, or a `doctor` that only inspects the manager's own view, qualifies
nothing: all of it can be wrong while those succeed.

What this does **not** solve, and should not be claimed to: Compose's dotenv
interpolation. Anything writing `.env` still encodes a literal `$` as `$$`
regardless of implementation language, and §2.1 records why the alternative
config format was rejected.

What it costs, deliberately accepted:

- Nothing can be diagnosed by the manager when the image cannot be pulled or
  Docker is down. The launcher's own checks cover exactly that case and must
  give an actionable message for each.
- Every command pays a container start.
- An image has to be published before anything can be installed, so image
  publishing is part of the first step that ships a command (N2).

Rules carried over from the first implementation, which hold whatever the
language:

- Release discovery accepts only `vX.Y.Z` and `vX.Y.Z-beta.N`, ordered
  numerically.
- Pull Ghost once, require a repository digest, and persist `GHOST_IMAGE_REF` as
  `repository@sha256:...`. Ghost and Tinybird sync both execute this reference.
  `GHOST_IMAGE`/`GHOST_VERSION` retain the requested repository/tag as
  provenance. Changing those fields alone never changes an installed site's pin.
  Upgrades, imports and restore set the complete reference deliberately and keep
  metadata in sync.
- `GHOST_CONTENT_PATH` and `GHOST_TINYBIRD_PATH` come from the resolved image's
  own `GHOST_CONTENT` and `GHOST_INSTALL`, so the layout and the configuration
  cannot disagree.
- Generate a fresh `.env` in one atomic write through the one encoder.
- Use Compose `up --wait --wait-timeout` with the existing health checks and
  one-shot dependency conditions, and keep a separate ingress check: the wait
  establishes readiness, not reachability.
- HTTP and HTTPS probes use deadlines, bypass proxy configuration and preserve
  Host/SNI. Routing, published ports and HTTPS issuance are the three separate
  results of "Reaching a site in order to verify it" (§2.8); a production
  install before DNS reports HTTPS as pending, not as a failure.

## 3. Implementation steps

Steps are work packages: one pull request each, against `next-docker`, stacked
on the steps they depend on. A step is done when its acceptance items are
demonstrated, not when its code exists. Mark a step's status in its section when
its pull request lands, and amend the affected contract in §2 in the same pull
request rather than afterwards.

Step names: `N1`–`N3` are new with this architecture. `S`-numbered steps keep
the names they had in the first implementation, so existing pull requests,
issues and documents still resolve; the letter suffixes are parts of one step.

"Reference" lines name files on the frozen `next` branch. They show behaviour
that was built, tested and reviewed there. Port the behaviour and its tests'
intent, not the bash.

### Delivery order

Dates agreed on 2026-10-08, after `v0.1.0-beta.1` shipped. Engineering dates
are kept in Linear; these are the targets they were set from.

| Milestone | Outcome | Steps | Target |
| --- | --- | --- | --- |
| M0 Foundation | A manager image and launchers exist, and `install` works for local and production sites. | N1, N2, N3 | done |
| M1 Local sites | A theme developer or migration-tool author moves each local Ghost-CLI site to Docker with the documented steps. Local mode runs Ghost and MySQL with no Caddy. | S5b, S5c | done |
| M2 Tagged single-site production | Production installs from a tagged release at `docker.ghost.org`, updates between releases, has backup/restore, imports a production Ghost-CLI site, and migrates the pre-`next-docker` layout. | S6a, S4, S6b, S5e; S12 | S4 13 Oct, S6b 16 Oct, S5e 22 Oct; S12 18 Dec |
| M3 Multi-site | Several sites on one host behind one shared Caddy, each with its own MySQL. | S13 | 28 Oct |
| M4 One-click Admin updates | Ghost Admin requests an upgrade that the host executes and recovers. | S7, S8, S9, S10 | S7 21 Oct, S9 merged 21 Oct, S8 27 Oct, S10 merged 28 Oct |

S11 and S14-S16 follow M4.

October runs three tracks in parallel: migration (S4, S6b, S5e), multi-site
(S13) and one-click updates (S7-S10). A beta is cut before the pause, on
29 October, and active work pauses from **30 October**: November is a feedback
period on that beta. December is for what the feedback finds, then S12: the
first stable release, and `next-docker` merged into `main`, by **18
December**.

If October overruns, work slips in this order: S10 moves to a November Ghost
release; then converting existing sites into a shared Caddy (PLA-504) moves to
December; then the pause moves to 6 November. S4, S6b and S5e do not slip.

```text
N1 foundation: stack files, contracts, plan    done
N2 manager image, launchers, publishing        done
N3 install, config, caddy, check               done

M1
S5b local import                               done
S5c moving a local site, documented           done

M2
S6a releases, served launcher, update          done
S4  backup/restore, lock                       done
S6b legacy-layout migration                    needs S4, S6a
S5e production import and cutover              needs S5b
S12 release qualification                      needs the rest of M2

M3
S13 shared Caddy                               needs S4; converting existing sites (PLA-504) needs S6b

M4
S7  host Ghost upgrade                         needs S4, S6a
S8  supervisor                                 needs S7, S9; S13 if shipped
S9  Ghost adapter/API                          Ghost PR #31277
S10 Admin UI                                   needs S9

Later
S11 file-based secrets                         needs S4-S8 credential consumers
S14 service image registries                   needs S12
S15 Ghost nightly channel                      needs S14
S16 default Redis                              needs S12
```

S13 keeps MySQL per site, so a new member site needs only S4: backup, restore,
upgrade and import are the same for it as for a site alone. Converting a site
that already runs its own Caddy into a member is separate work (PLA-504),
which needs S6b.

S7 depends only on S4 and S6a, and runs in October alongside the supervisor
that reuses its execution interface. Until it ships, the documented Ghost
upgrade is editing the exact version pin and running `docker compose up -d`
after `./ghost-docker backup`.

Work that exists outside this branch:

- `next` (frozen): the bash implementation of S1, S2 and S5b, with its tests.
- PR #300 (draft, against `next`): S4 as bash dispatcher plus a TypeScript
  manager. Its `manager/` directory was the starting point for N2 and S4,
  which have both landed; it is reference only.
- `codex/update-supervisor` (local branch): an S8 prototype stacked on PR #300.
  Parked until the adapter contract in Ghost PR #31277 settles.

### N1 — Foundation: stack files, contracts and plan

Repo: ghost-docker. Deps: none. Bring to `next-docker`, from `next`, everything
that is not tooling: `compose.yml` with its profiles, health checks and labels;
the tracked `caddy/Caddyfile`, snippets and the `custom/`, `global/` and
`sites/` layout; `.env.example` and `ghost.env.example`; the contract documents
(`docs/bundle-v1.md`, `docs/configuration.md`, `docs/caddy.md`); the manifest
fixtures; and this plan. Image pins follow `main`, which has moved on since
`next` branched. No scripts and no tests of scripts.

Acceptance: `docker compose config` resolves in local mode, production mode, and
production with both optional profiles, from a hand-written `.env`. The
documents describe commands as `./ghost-docker ...` and say that they do not
exist yet.

Status: implemented by the pull request that introduced this revision of the
plan. After it the branch is not installable by any tool: a hand-written `.env`
is the only way to stand a site up until N3. The legacy `scripts/migrate.sh`
was deliberately not brought across: it sets no site mode and cannot generate
routes, so on this layout it produces a site that does not start.

### N2 — Manager image, launchers and publishing

Repo: ghost-docker. Deps: N1. The skeleton every later step fills in. Implement
§2.10 and the image half of §2.7.

- `manager/`: a TypeScript CLI on a pinned Node image, with a real dependency
  set (`package.json`, lockfile, install at build), a command dispatcher,
  structured errors with the exit codes of §2.8, and the commands `version` and
  `doctor`. `doctor` reports what the manager can see: Docker and Compose
  versions, platform, the site directory, its ownership, and whether
  `PROJECT_DIR` matches. PR #300's `manager/` (Dockerfile with Docker client and
  Compose, type-stripped TypeScript, lint and type-check setup) is the starting
  point.
- The image carries the release payload of §2.7 at a known path, and reports
  its own version. A test fails when `compose.yml` references a bind mount or
  build context that the image does not contain.
- The entrypoint implements the identity rules of §2.10, including the rootless
  case.
- `ghost-docker` (bash), implementing the launcher contract of §2.10: Docker
  checks with actionable messages, image selection (pinned digest, channel/ref,
  or build from checkout), the `docker run` invocation, terminal attachment
  when piped, exit-status passthrough.
- A workflow that builds the image for `linux/amd64` and `linux/arm64` and
  publishes `edge` on pushes to `next-docker` and the version tag on release
  tags, and CI that builds the image and runs the tests on Linux, plus the
  launcher on macOS.

A PowerShell launcher for native Windows was built in this step and removed
before merging; §2.10 says why and what to do instead if one is wanted.

Acceptance: from a clone, `./ghost-docker version` and `./ghost-docker doctor`
build the image and run on Linux and macOS; a file the manager writes into the
site directory is owned by the caller under rootful and rootless Docker; the
launcher's refusals (no Docker, daemon down, no Compose) are tested without a
daemon; the manager's exit status and a usage error reach the caller unchanged;
the published `edge` image runs the same commands without a checkout. `doctor`
includes the sibling-container check of §2.10 and passes on Linux and macOS.

### N3 — install, config, caddy, check

Repo: ghost-docker. Deps: N2. The first commands: `install` for local and
production sites, `config get|set|unset|validate`, `caddy
render|apply|validate|reload`, and `check`, `info`, `list`. Implement §2.1-§2.3
and §2.8.

Port the behaviour of S1 and S2, which is recorded in `next`'s documents and
tests rather than restated here: preflight; stable project identity; generated
credentials; exact Ghost image resolution and digest pin; `.env` and `ghost.env`
written through one encoder with Compose round-trip tests; Caddy rendering,
validation, atomic installation, reload and verification; `.ghost-docker.json`;
readiness and ingress verification; never stopping or reconfiguring anything
already running. In image mode `install` writes the managed files of §2.7 and a
pinned launcher into the site directory; in clone mode it writes neither.

New in this step, not on `next`: `--email`, the ACME account email. Caddy
needs none to issue, but Let's Encrypt sends expiry and incident notices to
it. It is a flag only, never a prompt: omitted means none. It is
rendered into the site's routes as `tls <email>` only when given, so it lives
with the site that uses it and `caddy/global/` stays operator owned; it is
validated as an address before it reaches the Caddyfile. It is not kept in
`.env`: the routes are the operator's file after install, and changing the
address is editing its `tls` line.

Reference: `install.sh`, `scripts/lib/{env,config,compose,caddy,meta,preflight,install}.sh`,
`docs/install.md`, and `tests/{env,env-compose,config,caddy,compose-matrix,ingress,install,install-e2e,meta}.test.mjs`
on `next`. The test files are the most complete statement of what must hold.

Acceptance: `tests/e2e/install.sh` installs a local and a production site from
the image and from a clone, on Linux and macOS, and checks what
`install-e2e.test.mjs` checked: the pin, file modes and ownership, a port
conflict as an error naming the port, after which the directory is as it was
and the same command succeeds on a free port, an existing proxy on 80/443 left
running, two local sites side by side, `--no-start` starting nothing, and
local ingress verified on the loopback port, and production ingress verified
by "Reaching a site in order to verify it" (§2.8) before DNS and a public
certificate exist: routing passes, the published ports are reported, and
HTTPS is reported as pending. A site
installed into an empty directory from the published image alone, with no
checkout, starts with `--with activitypub`, and its `analytics` helper images
build from the payload written there. The dotenv encoder passes the round trip through real containers for
`$VAR`, `${VAR}`, `$$`, spaces, both quote types, backslashes, newlines, empty
strings and JSON arrays.

Status: implemented. `tests/e2e/install.sh` passes against Docker Engine 28 and
29 on Linux and against OrbStack on macOS; [install.md](install.md) documents the
commands. Decisions made while building it, which later steps rely on:

- **Resolution.** The requested Ghost tag is pulled and the pin is the
  repository digest the pulled image carries. Resolving the digest first
  through the registry and pulling that would close the window in which the
  tag moves between the pull and the inspect; it was built and taken out
  again as not worth its code.
- **Verification** runs inside the site's own containers (`docker compose
  exec`), not in a probe container of its own. A site that starts but fails
  it is a failed installation and is removed. HTTPS is *serving* or *pending*
  only; see §2.8 for what was dropped and why.
- **No `caddy` command.** `install` writes `caddy/sites/site.caddy` once and
  the file is the operator's from then on (§2.3); `docs/caddy.md` lists the
  edits people make. The `CADDY_*_DIR` placeholders, which existed so a staged
  candidate could be validated with the tracked Caddyfile, are gone from the
  Caddyfile and compose.yml.
- **A failed installation** is undone by `docker compose down --volumes` with
  every profile enabled, then the data directories it created, removed as root
  in a short-lived container of the manager image (MySQL owns its files by
  then), then the files it wrote. Directories that existed before are kept.
- **Ports.** The only ports the manager can know are taken are the ones
  containers publish; it refuses those before writing anything. A program
  outside Docker holding a port is found at `up`. OrbStack publishes the port
  over such a program without an error, so on macOS with OrbStack that conflict
  is not detected at all; the e2e records it as skipped there. The e2e itself
  requests the host's ports with curl, which is the check the manager cannot
  make. A failed `up` is reported in Compose's own words, which name the port
  (their wording differs between Docker 28 and 29, so it is quoted, not
  parsed), followed by `--port` and that nothing running was stopped.
- **The Tinybird path** comes from the image's declared environment: the older
  layout declares `GHOST_CLI_INSTALL` and keeps Ghost under `current/`; the
  `next` variants do not. No container is started to look.
- **`--channel` and `--release`** arrived with S6a. Choosing a release is the
  launcher's job; the manager records the channel it was given (or the one
  `--release` implies) and otherwise derives it from the version the manager image
  carries (`vX.Y.Z` stable, `-beta.N` beta, `edge-…` edge).
- **Prompts.** At a terminal, `install` asks for the site mode and a
  production site's domain when no option gave them (`@inquirer/select` and
  `@inquirer/input`); `--no-prompt`, or no terminal, makes a missing answer a
  usage error naming its option. `--with analytics` is a usage error that says
  how to add analytics to the installed site: its `tinybird-login` job is an
  interactive browser login and Ghost waits for the Tinybird jobs, so `up
  --wait` cannot succeed before it. The final-phase options (`--image-registry`,
  `--ghost-channel`, `--without`) are not accepted at all until their steps
  land; as unknown options they exit 2.
- **The launcher passes `GD_COMPOSE_OVERRIDES`** into the manager when it is
  set, so the opt-in to an override file in docs/configuration.md reaches the
  manager's Compose runs. It is the one setting passed through, besides the
  launcher's own contract (§2.10).
- **Operator keys** in the wrong file are derived from `compose.yml`'s
  interpolations, the settings `.env.example` documents, `COMPOSE_*` and the
  keys `.env` holds, so `GHOST_PORT` in `ghost.env` is caught on a local site too.
- **No `DOMAIN` setting.** Nothing in Compose or Caddy reads one since the
  routes became a file, so the domain is the host of `URL` (and the admin
  domain the host of `ADMIN_URL`); a second copy only needed a check that the
  two agreed.
- **Metadata** gained `source`, `stack.image` and `payload` (the checksums of
  §2.7); `schemaVersion` stays 1, since nothing has been released with it.
- **Fewer commands than listed above.** `caddy render|apply|validate|reload`
  and `config unset` were cut before merging: the routes are an operator file
  (above), and removing a line from an env file carries no encoding risk, so
  `unset` bought nothing over an editor.
### S3 — Ghost-CLI export command

Status: implemented and released in Ghost-CLI 1.33.0 (PR #2333).
`docs/bundle-v1.md` is in step with it.

### S5 — Bundle import and migration cutover

Repo: ghost-docker. Implement §2.4 as `install --import`, and document
moving a site with it. Three parts; each is its own pull request. (S5a, syncing the contract
with the released exporter, is done.)

**S5b — Local import.** Deps: N3. Not S4; see "Local imports" in §2.4. Import
`sourceInstallType: local` bundles of kind `mysql-dump` and `mysql-data`.

Status: implemented (`install --import`). `manager/src/bundle/manifest.ts`
is the zod schema, written to depend on nothing but zod so the exporter can
use it; `manager/src/bundle/stage.ts` unpacks with node-tar and yauzl;
`manager/src/import.ts` holds the steps. `tests/e2e/import.sh` is the
acceptance test.

- Unpack with a tar library and an entry filter as in "Reading the bundle" in
  `docs/bundle-v1.md`; directory bundles and zip archives too.
- Validate the manifest with a zod schema that encodes `docs/bundle-v1.md`,
  written so that it can be published and used by the exporter.
- The exact source Ghost image; raw config values into `ghost.env`, dropping
  container-owned keys; content placed before any container mounts it.
- `mysql-data`: Ghost boots once to create the schema, rows are loaded, and
  per-table counts are compared with `database.rows`.
- `mysql-dump`: loaded as the site's own database user, with `DEFINER=` clauses
  dropped from mysqldump's version-comment lines so that is possible.
- A failed import removes what it created; an interrupted one cannot be started
  and is cleared by the next import.
- A `portable` bundle is installed with its content and no database load; the
  summary names the Ghost Admin steps (§2.4). A `production` bundle is refused
  until S5e.

Reference: `scripts/lib/import.sh`, the import blocks of `install.sh`,
`tests/import.test.mjs` and `tests/e2e/import.sh` on `next`. That e2e script is
implementation-independent and is brought across with the launcher's command
names substituted; it is the acceptance test.

Acceptance: `tests/e2e/import.sh` passes on Linux and macOS with real bundles
from Ghost-CLI 1.33.0 for a SQLite and a MySQL source: staff sign in with the
source password; post, asset and dotfile fidelity; a config value with `$` and
both quote types reaches Ghost byte for byte; the bundle is unmodified; a broken
dump and tampered row counts each leave the directory as it was; a re-run in the
same directory succeeds; `--no-start` leaves nothing running. Unit tests cover
every refusal in `tests/import.test.mjs`.

**S5c — Moving a local site, documented.** Deps: S5b. "Moving a local
site" in §2.4: stop, export, import on the source's port, written up in
`docs/install.md`. No command.

Status: done. `tests/e2e/import.sh` follows the documented steps for its real
SQLite and MySQL sources: the stopped source is not started by the export,
and the Docker site answers on the source's port. A launcher `--migrate` was
built and dropped (§2.4 says why). Ghost-CLI printing these steps after an
export is a later change in Ghost-CLI.

**S5e — Production import and cutover.** Deps: S5b. Production bundles
(`sourceInstallType: production`): separate admin URLs, the same-server case
with an existing proxy on 80/443, and the documented cutover of §2.4 step 9.
Documents the production move the same way, with the source stopped
before the final export.

Acceptance: a same-server migration with an existing proxy on 80/443, and a
cross-host migration following the documented cutover. This part is what
replaces the legacy `scripts/migrate.sh` on `main`: S12 must not merge this
branch into `main` before it passes.

### S6 — Releases, the served launcher, and updates

Repo: ghost-docker. Implement §2.7 in two parts.

**S6a — Releases, served launcher, and `self-update`.** Deps: N3. A release workflow on
`next-docker` producing beta tags and dependency-only patch releases;
image tags `vX.Y.Z[-beta.N]`, `stable` and `beta` published from release tags;
tested release resolution; the workflow serving the launcher at
`docker.ghost.org`; managed-file checksums; and `self-update` between releases of
this layout as described in §2.7, without the legacy migration.

Acceptance: the served launchers install the newest beta and an explicit
`--release`; version selection is tested against prerelease ordering rather than
lexical sort; a dependency-only change produces a release; `self-update` moves a site
between two releases with the Ghost pin unchanged and the launcher re-pinned,
refuses a downgrade, keeps a hand-edited managed file and writes the release's
beside it, and restores the previous files when validation fails before
services change.
In clone mode, a failed update between two refs whose `compose.yml` differs
leaves the checkout at the previous commit with the previous configuration and
the site running, and a dirty tree is refused before anything changes.

Status: implemented. `tests/e2e/self-update.sh` covers `self-update` in both modes
against releases built locally; `launcher.yml` installs the newest beta and an
explicit `--release` with the served launcher after each release. Decisions made
while building it:

- **No release-please** (§2.7). The Release workflow and
  `scripts/release.ts` cut releases as Ghost and Ghost-CLI do, and
  the commit skill gained their release-note emojis. A tag pushed with
  `GITHUB_TOKEN` starts no workflow, so the release workflow calls the image
  and launcher workflows itself; a release tag pushed by hand still publishes
  through `image.yml`. Versions start at `v0.1.0-beta.1`; a bump is applied to
  the newest release that is not a beta, and betas of a newer version count
  up toward it.
- **Moving tags** go only to a release that is the newest on their channel, so
  a patch to an older line never moves `beta` backwards. A release tag is
  refused if the image already exists. The launcher is served only from the
  newest release.
- **The release tooling is its own package**, `scripts/`, outside the
  manager and its image: only tag validation and ordering are the
  manager's (`manager/src/release.ts`). Both order releases with semver,
  behind a check that accepts only the published formats.
- **GitHub Pages deploys from Actions**, not a `gh-pages` branch: each deploy
  is the whole site built from the release, and there is no branch anyone
  could push to by hand. The custom domain lives in the repository's Pages
  settings, and the `github-pages` environment allows `next-docker`.
- **`--release`**, not the planned `--ref`: it names a release tag, never a
  git ref, and `--version` is already the Ghost version.
- **The launcher's default** is the `beta` channel, which includes releases.
  It resolves `--channel` and `--release`/`--to` itself and passes them on. A
  pinned site's `self-update` runs the newest release on the channel recorded in
  the launcher (`GD_PINNED_CHANNEL`), because the updater is the target.
- **Downgrades** are told by release number in image mode, and by ancestry in
  a clone. A site on `edge` may update to anything; a build that is not a
  release cannot update a site that runs one.
- **Ghost compatibility** is `MINIMUM.ghost` in `versions.ts`. A release that
  raises it stops the update of an older site before anything changes, with
  the upgrade sequence.
- **The lock** (§2.2) is `.ghost-docker.lock`, taken by `self-update`; S4 uses the
  same module. An interrupted update's snapshot also blocks the next one
  until the operator removes it.
- **Validation** requires Compose to resolve the project, which plain
  `config validate` only warns about.
- **Metadata** gained `updatedAt` and `stack.previous`, defaulting to `null`
  so files written before them still read; `schemaVersion` stays 1.
- **Backup-backed recovery** (PLA-512, ahead of S6b): `self-update` takes a
  backup after its snapshot. A failure once the services changed stops them,
  sets the data aside in `.ghost-docker-update/data/`, loads the backup's
  databases and content, and starts and verifies the previous release; if
  that fails, it names the backup to `restore`. The backup is kept either way.
  A site whose `.env` moves its data is refused, as `backup` refuses it.

**S6b — Legacy-layout migration and transactional updates.** Deps: S4, S6a. The
release migration scripts (run in order, recorded in metadata), migration
`0001-compose-profiles`, the way in for installations that have no launcher, and
backup-backed recovery (§2.5). Gates
merging `next-docker` into `main`.

Acceptance: update from the layout on `main`, including existing optional
profiles, custom Caddy routes/overrides, absent metadata, and an untagged
starting commit. A failure during a migration, the pull or startup ends restored,
or reports that the operator is needed, accurately.

### S4 — Backup, restore and the lock

Repo: ghost-docker. Deps: N3. `./ghost-docker backup` and `restore` as described
in §2.5, and the lock of §2.2 on backup, restore and (when they land) upgrade
and update. Backups are their own format, not migration bundles.

PR #300 implemented a much larger version against the bash layout. Its
TypeScript (`manager/storage.ts`, `probes.ts`, `process.ts`) and its tests are
material to draw on; its journals, maintenance handling and bash dispatcher are
not carried over.

Acceptance: back up a site with ActivityPub, restore it into the same directory
and into a fresh one, and verify the database (staff sign in), assets, theme and
configuration; a second operation is refused while one holds the lock; a stale
lock is reported by `check`; a dump that fails is an error, not a backup.

Status: implemented. `tests/e2e/backup.sh` covers every acceptance item against
real containers; `docs/install.md` describes both commands. Decisions made
while building it:

- **Live by default, consistent on request** (PLA-515): `backup` keeps the
  site running, as Ghost-CLI's did, with the weaker guarantee documented.
  `backup --consistent`, and the backup `self-update` takes, stop Ghost and
  ActivityPub for the capture (dumps, content, site files) and start them
  again, not recreated, before the scratch check; they end as they began on
  success and failure. The manifest records `consistency` (absent means
  live), so the backup version stays 1. `tests/e2e/backup.sh` seeds
  ActivityPub records, changes them after the backup, and checks their exact
  values after both restores.
- **One dump per database**, `database/<name>.sql`, as the site's user:
  `--single-transaction --no-tablespaces --set-gtid-purged=OFF`, no routines
  or events, which need privileges the site's user does not have and Ghost
  does not use. A dump that does not end with mysqldump's completion line is
  refused as cut short.
- **"The dump loads" is checked in a scratch MySQL**, a one-shot container of
  the site's own db image with the backup mounted read-only and no network,
  never the site's own server. Its row counts go into the manifest, and the
  number of tables must equal the live database's; Ghost's must have a
  migration history.
- **The stack's files travel with an image-mode backup**, with the launcher,
  so a restore anywhere runs exactly the images the site ran, whichever
  manager restores it. A clone's backup records its commit and restores into
  a clone checked out at it.
- **The manifest holds a SHA-256 of every file**, and restore checks them all,
  and lists the archive, before it changes anything.
- **Restore always starts MySQL on an empty data directory** and loads the
  dumps into it, over a site as into a new directory: no tables left over
  from a newer schema, and the root password always matches the restored
  `.env`.
- **Over a site, `restore` asks** (`--yes` answers; with no terminal it is
  required), and sets the site aside in `.ghost-docker-restore/`, each data
  directory moved as root by its own one-shot container because MySQL owns its
  data. A site that cannot be stopped is left in place; a set-aside that fails
  is moved back before anything is written. Once writing, a failure stops the
  services and reports "needs the operator", with the services' observed
  state and the steps to put it back, naming only copies that exist; it does
  not put it back itself. `check` reports the directory and another restore is
  refused while it is there.
- **Into a new directory**, the site keeps its project name and ports, so
  containers of the same project and busy ports are refused, named, never
  stopped. `PROJECT_DIR` and the metadata's `site.dir` are rewritten to the
  new directory.
- **The backup is a positional argument**, `restore <backup>`. The launcher
  mounts it read-only at its own path when it is outside the site, as it does
  `--import`'s bundle.
- **A site whose `.env` moves its data** (`UPLOAD_LOCATION`,
  `MYSQL_DATA_LOCATION`) is refused rather than half backed up.
- **No metadata changes**: `schemaVersion` stays 1.

### S7 — Host-driven Ghost upgrades

Repo: ghost-docker. Deps: S4 and S6a compatibility rules. Implement `./ghost-docker
update [version|latest]` following §2.5, initially without a supervisor. Specify the reusable
execution interface so the supervisor cannot diverge from backup/recovery behavior.
Keep supported majors/downgrades constrained and feature compatibility explicit.

Acceptance: upgrade across a real database migration, with the analytics sync
and deploy run; a target that fails to start after migrating is restored from
the backup and reported `restored`; a concurrent second request is refused by
the lock; another major and a downgrade are refused.

### S8 — Supervisor command, protocol, and installer integration

Repo: ghost-docker. Deps: S7, S9; S13 if it has shipped. A
prototype exists on `codex/update-supervisor`; rework it against the adapter
contract merged from Ghost PR #31277 rather than starting over. Write
`docs/upgrade-supervisor.md` with the exact §2.6 schemas, transitions, ownership,
policy, and recovery rules, then implement the supervisor as a long-running
command of the manager image. Reuse S7 behavior. Wire `--with supervisor` and
request submission/status tooling.

The status lists available updates as one-click and manual (§2.6): Ghost
upgrades the policy allows, and stack updates and Ghost upgrades it does not, the
latter with the reason and the host command.

Acceptance: handwritten requests work before Ghost gains an adapter; duplicate and
malformed requests, permission violations, stale status, supervisor crashes, and
host-operation conflicts behave correctly. Verify actual exchange permissions as
Ghost's runtime uid. Installer must not enable an incompatible Ghost adapter.

### S9 — Ghost upgrade adapter and Admin API

Repo: Ghost core. Deps: S8 protocol contract. Follow repository adapter/API guidance.
Implement `NoopUpgradeAdapter` and `FileDropUpgradeAdapter`, permission-checked status/
request/job APIs, rate limiting, capability reporting, and update-notification metadata.
Noop is default; missing/stale supervisor and malformed protocol data produce useful
status without making unrelated Ghost startup depend on supervisor availability.

Acceptance: adapter/controller tests, API permission tests, tmp-exchange protocol
tests, version compatibility, and initialization ordering. Keep Admin UI separate.

### S10 — Admin update experience

Repo: Ghost Admin. Deps: S9. Add the current-version/available-update panel using the
repository's current React/Shade and API conventions. Feature-detect older backends,
show host capabilities, confirm downtime/backup behavior, and display durable job
progress with bounded reconnection and recovery guidance. Wire notification links.
Show the status's two update lists (§2.6): one-click updates with an action, and
manual ones as a notice with their reason and host steps, such as a stack update
to run with `./ghost-docker self-update`.

Acceptance: older backend, unsupported adapter, owner/admin permissions, successful
restart/reconnect, queued job, stale supervisor, failed restore, and recovery-required
states. Include an integration test with the real supervisor after mocked UI tests.

### S11 — Optional file-based secrets

Repo: ghost-docker. Deps: N3 and the credential consumers in S4-S8. Add Compose secret
files and `_FILE` wiring only for Ghost versions known to support it. Importing older
Ghost 6 images must still work via their supported credential mechanism. Migrate
without changing existing initialized MySQL credentials accidentally.

Update MySQL init scripts, healthchecks, ActivityPub, backup/import/restore helpers,
and supervisor consumers together. Do not assume ActivityPub supports MySQL image
`_FILE` conventions. Set file ownership/readability for actual container users;
host mode 0600 alone does not guarantee container access.

Acceptance: root credentials remain absent from Ghost regardless of this feature;
file-enabled supported services do not expose their secret values in environment;
legacy environment-based installs, older imports, restart, and restore still work.

### S12 — Single-site release qualification and documentation

Repo: ghost-docker, with cross-repo fixtures. Deps: M2 (S4, S5, S6) at minimum; qualify
S13, S7-S10 and S11 when they have shipped. Gates the first stable tag and merging
`next-docker` into `main`. Include the launcher on Linux, macOS and WSL2.
Consolidate CI and qualify the actual minimum supported tools and image versions.
Run fresh local/production install, optional-service variants, CLI migration,
legacy stack update, Ghost upgrade/recovery, supervisor/Admin, and restore scenarios.
Include Linux runtime tests and macOS-compatible shell/configuration checks.

README/help include quick starts, prerequisites, version/compatibility policy,
backup/restore, migration losses and cutover, custom proxy configuration, diagnostics,
and uninstall. Document deletion of bind-mounted data separately from `down -v`, with
explicit recovery consequences. Explain command equivalences without claiming full
CLI parity for unsupported features. Describe shared infra according to whether
S13 has shipped.

### S13 — Optional shared Caddy

Repo: ghost-docker. Deps: S4 for new member sites; converting an existing
site into a member (PLA-504) also needs S6b. Several sites on one server, as Ghost-CLI ran
several sites behind one nginx. 80 and 443 can belong to one Caddy only, so that
Caddy is shared; everything else stays per site, MySQL included, so backup,
restore, upgrade and import are unchanged.

- `install --infra` sets up the shared Caddy once: a Compose project of its own,
  with an external network each member site's Ghost (and optional services) also
  joins. `install --domain` on a server that has it adds the site as a member
  instead of starting a Caddy of its own.
- Each member's routes are a file in the shared Caddy's `sites/` directory,
  written once by its install and then the operator's, as in N3. Upstreams are
  the member's unique aliases, which N1 already requires.
- `list` shows the members; removing a site removes its routes file.
- Ghost publishes on loopback as before, so a member can still be reached
  without Caddy.

Acceptance: a shared Caddy with two members on different Ghost versions, each
with its own optional services; upgrading, restoring or removing one leaves the
other untouched; a duplicate domain is refused; a Caddy restart brings both back.

### S14 — Dual-published service images and registry selection

Repos: ghost-docker plus the traffic-analytics and ActivityPub publishing repositories.
Deps: S12; independent of S13. Follow §2.9. Publish traffic-analytics, ActivityPub, and
ActivityPub migrations to both Docker Hub and GHCR, then add
`install --image-registry dockerhub|ghcr` and a documented registry-switch operation.
Persist full image identities and registry choice; apply it consistently to upgrade,
stack update, recovery, and supervisor flows. Preserve historical mixed registry
locations until a site explicitly switches. Do not broaden the flag to unmirrored
third-party images.

Acceptance: both registries serve equivalent releases on supported architectures;
partial publication is not advertised as complete; unauthenticated public pulls work;
select/install/update/restore and same-version registry switches succeed. Exercise
missing artifacts, unavailable registries, and ActivityPub app/migration version
alignment. Confirm switches do not mutate application data or upgrade versions.

### S15 — Opt-in Ghost nightly channel on GHCR

Repos: Ghost/image publishing workflow and ghost-docker; Ghost Admin/API if channel
or build metadata requires extending the existing upgrade interface. Deps: S14 image
resolution and existing S7-S10 upgrade integration. Follow §2.9. Add
`--ghost-channel stable|nightly`, with stable as default and nightly explicitly opted
in. Nightly images are published to GHCR with immutable source/build identities.
Keep the stack `--channel` independent and do not equate nightly selection with
unattended upgrades.

Acceptance: stable installs never select nightlies; opt-in resolves an exact GHCR
build on supported architectures; successive builds with identical Ghost semver are
distinguishable; tinybird-sync uses the selected Ghost artifact. Exercise discovery
failure, missing images, host major-policy enforcement, backup/recovery, and explicit
channel transitions. Nightly-to-stable must refuse unsafe schema transitions rather
than pretending that image selection rolls back the database.

### S16 — Default per-site Redis caching with opt-out

Repo: ghost-docker, verifying behavior against supported Ghost versions. Deps: S12
and existing configuration, installer, backup, upgrade, and secret interfaces;
independent of S13-S15. Follow §2.9. Make Redis the default for new local/production
sites, with explicit `--without redis` opt-out and documented adoption for existing
sites. Add the service/profile, version-aware Ghost cache wiring, private network,
healthchecks, credentials, resource policy, diagnostics, and enable/disable migration.
Keep Redis per-site even when shared infra exists.

Acceptance: new local/production installs use Redis by default; opt-out starts a
working site without it; existing operator overrides survive migration. Verify real
cache reads/writes and invalidation, resource limits, restart/outage/reconnect,
upgrade/restore behavior, secret handling, and supported Ghost version coverage.
If S13 has shipped, verify two sites do not share cache data or expose Redis through
the shared ingress network. Specify cache rebuilding/persistence behavior explicitly.
Do not wire speculative traffic-analytics/ActivityPub consumers until their released
interfaces exist and their cache-versus-durable-state requirements are established.

## 4. Reference notes from review

- Compose interpolates inactive services. `env_file` does not supply Compose's own
  `${...}` interpolation. Double-quoted dotenv values can interpolate dollar signs.
- A Compose profile named in the environment enables nothing unless a service lists
  it. Profiles do not change a service's fields or combine as logical AND conditions.
- `COMPOSE_FILE` affects override auto-loading; explicit `-f` replaces the selected
  list. Every helper, supervisor invocation, and IPv6 example must use one contract.
- Host and container bind paths must agree for a container invoking host Docker.
  Docker context and user namespace differences also affect paths/ownership.
- Restart policy is not migration orchestration or readiness. One-shot jobs must
  remain one-shot, and failed schema migrations need database-aware recovery.
- The existing MySQL init script reads root credentials from environment; update it
  as well as the healthcheck when introducing secret files.
- Git checkout cannot overwrite an untracked file with a tracked file. Pre-checkout
  migration backups and recovery must include configuration, not just a Git ref.
- Authoritative references: [Compose profiles](https://docs.docker.com/compose/how-tos/profiles/),
  [dotenv interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)
  and [Caddy commands](https://caddyserver.com/docs/command-line).
