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
| Where tooling runs | In a **manager image** published from this repository: a TypeScript CLI with its own dependencies, a Docker client and Compose. The host runs only a **launcher** that checks Docker and starts the image. See §2.10. |
| Host requirements | Docker Engine 25.0+ with the Compose v2.24+ plugin, and a shell for the launcher: bash on Linux and macOS, PowerShell on Windows. No `jq`, `curl`, `git` or Node on the host. `git` only when working from a clone. |
| Distribution | The manager image carries `compose.yml`, the Caddy configuration and the CLI, and writes them into the site directory. A tagged release is an image tag. A git clone of this repository also works: the launcher builds the image from the checkout and uses the files in place. See §2.7. |
| Docker socket | The manager is given the Docker socket for every command, including install. That is host-privileged, and it is accepted: whoever runs the launcher already has that access. |
| File ownership | Everything the manager writes into the site directory is owned by the user who ran the launcher. The entrypoint starts as root to read the socket's group, then drops to the caller's uid and gid. See §2.10. |
| Windows | Through WSL2, which is Linux. Natively, through a PowerShell launcher, as an experiment: the daemon connection, file ownership and bind-mount paths are all unverified there, and §2.10 says what qualifies them. |
| Versions | Resolve and persist an exact Ghost image version on installation. Ghost upgrades and stack updates are separate operations. Record resolved image digests for recovery. |
| Installation | Scriptable `install`, with a flag for every prompt. Local mode uses MySQL too. |
| Migration | Ghost-CLI exports a bundle (`ghost migrate-export`, Ghost-CLI 1.33.0+); the manager imports it. Three kinds: `mysql-dump` (MySQL sources), `mysql-data` (default for local SQLite sources: data-only MySQL inserts loaded into a schema Ghost creates), and `portable` (explicit SQLite fallback through the Admin API, with documented losses). `--migrate` runs the export and the import in one command. The legacy `scripts/migrate.sh` stays on `main`, where it works, and is not carried onto this branch, whose layout it does not understand; it disappears from `main` when this branch merges, which S12 allows only after production import (S5e) has passed its fidelity and recovery tests. |
| Upgrades | Optional supervisor using a file exchange and the Docker socket. Ship a tested host-driven upgrade first, then reuse its recovery contract in the supervisor. Both are commands of the manager. |
| UX | Standard Compose commands for daily operation; `./ghost-docker` for installation, diagnosis, configuration, migration, backup/restore, and upgrades. No wrapper binary named `ghost`. |
| Configuration | `.env` contains Compose/operator settings; `ghost.env` contains only Ghost application settings. Do not pass the whole `.env` into Ghost. A mounted Ghost JSON config file was evaluated as a replacement for `ghost.env` and rejected; see §2.1. |
| Recovery rigor | §2.5 and the update flow in §2.7 describe a ceiling. The floor for the first stable release is: back up before changing, restore on failure, report truthfully, one operation at a time. See the note at the top of §2.5. |
| Shared infrastructure | S13. Not a dependency of local or single-site production installations. Scheduled after tagged single-site production and before Admin-driven upgrades, so the upgrade supervisor is built once against per-site projects. |
| ActivityPub and analytics | Per-site, including for future members of shared infrastructure. Each site owns its ActivityPub database/storage and Tinybird configuration/deployment lifecycle. |
| Ghost nightly channel | Future explicit opt-in via `--ghost-channel nightly`; published to GHCR, independently of the stack release channel. Stable remains the default. |
| Service image registry | Future `--image-registry dockerhub|ghcr` selects dual-published traffic-analytics and ActivityPub images, including migrations. |
| Redis | Default on new installations once S16 ships, with explicit `--without redis` opt-out. |
| Tests | Unit tests for the CLI in TypeScript. End-to-end scenarios that only run the real commands and check outcomes are shell scripts in `tests/e2e/`, so they do not depend on how the commands are implemented. |

Explicitly document initial limitations: no shared-infra provisioning, no automatic
major Ghost/MySQL upgrades, no arbitrary downgrade support, and no claim of lossless
SQLite-to-MySQL migration through the portable API export.

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
COMPOSE_PROJECT_NAME=ghost-local-example
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
# DOMAIN=example.com
# RESTART_POLICY=unless-stopped
# Optional: ADMIN_DOMAIN=admin.example.com
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
- Use `restart: ${RESTART_POLICY:-unless-stopped}` only for long-running services.
  Setup, migration, and deployment jobs retain `restart: "no"`.
- Initially `URL` may be required because every supported mode contains Ghost. Do
  not put `:?` guards on optional-service variables such as `PROJECT_DIR` or DOMAIN.
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
checks. The launchers are the only host code: keep the bash one free of GNU-only
behaviour and the PowerShell one to what Windows PowerShell 5.1 provides.

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
mode, release channel, installed stack version/commit, project identity, and completed
migrations. Separate durable operation journals record in-progress work and recovery
state. An installation that predates metadata must be supported explicitly.

All mutating operations on a site acquire the same host-visible operation lock:
install/reconfigure, import, restore, Ghost upgrade, and stack update. Define stale
lock recovery after a crashed process; never discard a lock solely due to elapsed
time. S13 adds an infra-wide registration lock.

### 2.3 Caddy and optional services

- Track a generic Caddyfile importing generated `sites/*.caddy` and operator-managed
  `custom/*.caddy`. Ignore generated/operator files in Git.
- Render sites from a template with explicit upstream, public/admin domains, and
  optional-service targets. Preserve every import argument; missing arguments may
  survive adaptation and fail at runtime.
- Validate a candidate configuration, atomically install it, reload Caddy, and verify
  routing. Restore the previous on-disk configuration if validation/reload fails.
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
| `portable` | Local SQLite with `--sqlite-format portable` | Content JSON and members CSV from the Admin API | Isolated authenticated API import; lossy |

`mysql-data` is the expected route for local SQLite sites and preserves IDs, staff
credentials, members and settings. `portable` remains supported as the fallback
for a source whose data the exporter refuses to write as `mysql-data` (values
MySQL would reject). It is never selected automatically: the operator chooses it
knowing the documented losses.

Before freezing the contract:

- Define `config` as a map of flattened keys to raw string values, without embedded
  dotenv quoting. The importer serializes these values safely for Docker Compose.
- Require `bundleCreatedAt` and `sourceInstallType: local|production`. Infer installation
  mode from `sourceInstallType`; validate kind, supported Ghost version, and all paths.
- Update exporter, importer, documentation, and fixtures together before freezing
  bundle v1. The unpublished draft format does not need backward compatibility.
- Test actual Compose round trips rather than only comparing exporter strings.
- Define portable-import losses explicitly, including identity/authentication and
  integration/subscription relationships as applicable. Establish the supported
  fidelity matrix from fixtures and real exporter/importer behavior.
- Record the consistency/cutover behavior: the exporter currently restarts Ghost.
  Add a documented final-export mode that leaves the source stopped, with explicit
  operator selection, and preserve the current restart behavior for ordinary exports.
  Portable exports support local SQLite development sites only: content API export,
  then members CSV, then stop Ghost and copy assets. Captures are sequential; users
  must avoid editing during export. Do not implement write-freeze machinery or
  require Ghost changes. Final export leaves the source stopped for cutover.

Import sequence:

1. Acquire the site lock. Validate target state and available space. Default to a
   fresh target; refuse merging into an existing live database/content tree.
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
8. For portable data, start an isolated destination with no public ingress, set up
   the owner, authenticate, and perform multipart content/member imports. Explicitly
   mount the helper script. Use the unique service alias, correct Host/Origin/proxy
   semantics, and handle separate admin URLs, HTTPS, sessions, and supported auth.
   Owner credentials may come from a prompt or private file, not only command args.
9. Verify the expected content/member records, active theme/assets, redirects, URLs,
   and supported configuration. Preserve a journal so a retry cannot duplicate a
   partially completed portable import. Prefer recreating the isolated target from
   the bundle when resumability cannot be proved.
10. Switch ingress only after verification and an explicit final-source write freeze.
    Explain DNS/proxy cutover for cross-host moves. Keep the old installation and
    recovery instructions intact until the operator accepts the destination.

`install --import` must not start normal production ingress before this workflow.
For rehearsal/local imports, provide a safe documented way to suppress outbound
email, newsletters, payments/webhooks, and federation activity. Do not silently send
real production traffic from a copied database.

#### Local imports

A local import targets a fresh site directory that has never served traffic, so
it does not depend on the S4 recovery runtime. The failure contract is simpler: nothing
outside the new site directory is modified, and a failed import removes what it created
(containers, the data it wrote into directories it had verified empty,
configuration, staging) so the same command can be run again in the same
directory. While an import is in progress the directory is marked incomplete and
`.env` selects no Compose service, so an import interrupted before it could clean
up cannot be started; the next import clears it first. Steps 1 and 10 above reduce accordingly: there
is no pre-existing site lock to honour and no ingress to switch. Path validation,
private staging, the exact source image, raw config handling and verification all
still apply. When S4 lands, local import adopts the shared operation lock like
every other mutating command.

Production imports keep the full sequence and require S4.

#### `--migrate`

`--migrate` is a wrapper: detect a Ghost-CLI installation, run
`ghost migrate-export`, and hand the resulting bundle to the `--import` path. It
adds no import logic of its own, so both entry points share one tested
implementation. The export half runs in the launcher, on the host, because that
is where Ghost-CLI and the source site are; the import half is the manager's.
The launcher mounts the bundle read-only for it.

- Source selection: the current directory by default, or `--migrate=PATH`. The
  directory must contain a `.ghost-cli` file. Require Ghost-CLI 1.33.0 or later
  from the output of `ghost --version`; the version recorded in `.ghost-cli` is
  the last one used, not the one installed. Report a Ghost 5.x source before
  running anything, with the `ghost update` instruction.
- Locations: the exporter refuses an output path inside the installation or its
  content directory, and a site directory created under the current directory
  would be inside the source. With `--migrate`, default the site directory to a
  sibling of the source directory and write the bundle to a private directory
  outside both; `--dir` overrides the site directory. Keep the bundle after a
  successful import and print its path.
- Mode: taken from the manifest's `sourceInstallType`; `--local`/`--domain` are
  not required for a local source.
- Prompts: under `curl | bash` stdin is the script, so the exporter runs with
  the terminal attached. The launcher asks for its own confirmation once and passes
  `--force` to skip the exporter's beta prompt; with `--no-prompt` the operator
  must have requested migration explicitly and `--force --no-prompt` is passed.
- Source lifecycle: `--migrate` never starts or restarts the source Ghost. A
  `mysql-data` or `mysql-dump` export needs Ghost stopped, not running, so the
  export is run with `--leave-stopped`: a running source is stopped and stays
  stopped, and a source that was already stopped is never started. The Docker
  site therefore takes the source's own port and URL when that port is free,
  and `--port` overrides the choice. If the import then fails and the source
  was running beforehand, start it again with `ghost start` so the operator is
  back where they began; say so either way. The one exception is the portable
  retry below, which exports through the Admin API and so needs Ghost running;
  the exporter starts and stops it itself.
- Export failure: surface the exporter's message unchanged. When `mysql-data`
  validation refuses the source, offer one retry with `--sqlite-format portable`
  after showing the portable losses. Never fall back without that confirmation,
  and never under `--no-prompt`.
- Scope: local installations first (S5c). On a production installation
  `--migrate` refuses with a pointer to the manual export/import procedure until
  production cutover is implemented (S5e), because an existing proxy holds ports
  80/443 and the cutover rules above apply.
- The source installation is never modified beyond what `ghost migrate-export`
  itself does, and is never removed. After a successful migration it is left
  stopped and intact; `ghost start` there brings it back.

### 2.5 Backup, upgrade, and recovery

**This section is a ceiling, not a floor.** It describes the most careful
version of each operation, so that nothing here is designed in a way that rules
it out. It is more than most self-hosted software does, and the first stable
release does not have to reach all of it. The floor for that release is:

- a verified backup is taken before an upgrade or a stack update changes
  anything;
- a failure restores that backup and the previous image and configuration;
- the outcome is reported truthfully: done, restored, or needs the operator;
- two operations cannot run on one site at once.

Beyond the floor — resuming an operation killed at an arbitrary point from its
journal, maintenance ingress during upgrades, retention policies, the full
fault-injection matrix — is built when a step shows it is needed, and each of
S4, S6b and S7 states in its pull request which parts it implements and which it
defers. Deferring is a decision recorded there, not an omission. What must not
be deferred is honesty: never report success or a completed rollback that was
not verified.

Implement backup and restore before promising automated rollback. Backups include
the Ghost database, content, site configuration, versions/digests, and a manifest.
Document optional-service state and which remote changes cannot be restored locally.
Use restrictive permissions, retention controls, space checks, and a restore drill.
Neither `docker compose down -v` nor a database-only export is a complete backup.

Ghost upgrade contract:

1. Acquire the operation lock; validate current state, target, compatibility, disk
   space, and backup capability. Reject unsupported majors/downgrades. Resolve
   `latest` to one exact supported same-major version and immutable image identity.
2. Pull/verify the target before downtime. Record the previous image digest and
   configuration; retain the previous image for recovery.
3. Enable maintenance ingress and stop application writes/background writers.
   Create and verify a consistent recovery checkpoint of all affected local state.
   Production automated upgrades require this checkpoint; request input cannot waive it.
4. Persist the journal before mutation. Apply the exact image configuration, run
   migrations/startup and the supported optional-service deployment sequence.
5. Verify database/application readiness and proxy routing while external writes
   remain blocked. Resume traffic only after verification, then mark the job done.
6. If verification fails, restore the checkpoint and previous image/configuration
   using the tested recovery procedure. Report `rolled-back` only after verifying
   the restored system. If restore fails or affected external state cannot safely
   be reconciled, retain maintenance mode and report `recovery-required`.

Do not confuse switching images with reversing schema migrations. A later rollback
after traffic has resumed needs a separate deliberate recovery workflow because
restoring the pre-upgrade snapshot would discard newer writes. A generic request
for an older version must not bypass this rule.

On restart, reconcile an interrupted operation from its journal and actual container/
database state; never blindly replay destructive steps. Inject failures at pull,
backup, config write, migration, readiness, restore, and process interruption.

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

Release-please manages releases. Configure dependency changes explicitly as
releasable patches; do not assume `chore(deps)` does that by default. Specify beta
release mechanics and test version selection rather than using lexical sorting.
Until the legacy migration exists (S6b) every release is a beta, and `main` keeps
the pre-`next-docker` layout that existing installations update with `git pull`.

Rules:

- **A site is pinned to a digest.** Installation resolves a channel or tag to
  one image digest, records the version and digest in `.ghost-docker.json`, and
  writes a launcher into the site directory that runs exactly that digest. A
  moving tag is never what a site runs.
- **The image writes the files.** The release payload in the site directory is
  a copy of the image's, written by `install` and replaced by `update`. They are not
  edited by operators; operator-owned files are `.env`, `ghost.env`,
  `caddy/custom/` and `caddy/global/`. The manager records a checksum of each
  file it wrote, so `update` can tell an untouched file from an edited one. An
  untouched file is replaced. An edited one is never replaced silently: `update`
  names it, keeps a backup copy beside it, and asks before replacing it. Under
  `--no-prompt` it stops instead, unless `--replace-edited` was given.
- **Clone mode.** A launcher that finds itself in a checkout of this repository
  builds the image locally from that checkout and uses the files in place,
  writing nothing over them. Metadata records `source: checkout` and the commit
  the site was last installed or updated at. This is how the stack is
  developed, and how someone who wants to read everything first installs it.

  Updating such a site is `git checkout` of a newer ref followed by
  `./ghost-docker update`. That is the same update as in image mode — validate,
  pull the service images the new `compose.yml` names, apply, verify — except
  that the payload is already in place and is not written. The checkout has
  happened before the updater starts, so the recovery boundary cannot be "the
  files as the updater found them": those are already the new ones. It is
  instead:
  - the **previous commit**, read from metadata, which Git holds and which
    fully determines the previous payload;
  - a snapshot of the operator's files (`.env`, `ghost.env`, `caddy/custom/`,
    `caddy/global/`, generated routes, metadata), which a checkout never
    touches;
  - the **previous manager image**, which the launcher keeps by tagging every
    image it builds with its commit.

  A tracked tree with local modifications, or a checkout whose recorded commit
  cannot be found, is refused before anything changes. On a failure the
  updater restores the snapshot and checks the previous commit out again, so
  the directory is never left as new payload with old configuration, and says
  which manager image belongs to it.
- **The launcher is served** from the `gh-pages` branch with the custom domain
  `docker.ghost.org`: `https://docker.ghost.org/install.sh` and
  `https://docker.ghost.org/install.ps1`. They are the repository's own
  `ghost-docker` and `ghost-docker.ps1`, published by a workflow on release and
  never by hand. Test the served files rather than the checkout's copies.

`./ghost-docker update [--check] [--channel stable|beta] [--to vX.Y.Z]` updates
the stack, not Ghost. Preserve the exact Ghost pin; if a stack release requires a
newer Ghost, stop with the required upgrade sequence. Initially reject stack
downgrades unless the relevant migrations explicitly support them.

The updater is the *target* release's image, started by the site's launcher. It
runs entirely outside the files it replaces, which is what makes this tractable:
there is no script rewriting itself mid-run.

Transactional flow:

1. Acquire the site lock; reject unresolved operations and, in clone mode, a
   dirty tracked tree or an unknown previous commit.
2. Resolve the release, check compatibility, show changes, and record the
   previous version and digest.
3. Back up `.env`, `ghost.env`, generated and custom Caddy files, metadata, and
   the migration journal; and the payload being replaced, which in image mode is
   a copy of the files and in clone mode is the previous commit.
4. Run the target release's migrations, journalled per phase. Idempotency does
   not substitute for recovery. Record completion only after the corresponding
   stage succeeds.
5. Write the managed files, validate Compose and Caddy, pull images, apply the
   release, and verify readiness. Define safe handling of DB/ActivityPub
   schema-affecting stack changes using the backup/recovery contract; do not
   blindly roll back a migrated service image.
6. On failure, restore the previous payload and configuration together where
   safe (in clone mode, by checking the previous commit out). If
   stateful service changes already occurred, use their recovery procedure or
   report recovery-required. Never report success merely because `up -d`
   returned zero.
7. On success, rewrite the site's launcher to pin the new digest.

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
-s -- update`); do not tell them to use raw `git pull` to cross the breaking
change.

### 2.8 The launcher and its commands

```text
ghost-docker install [--local | --domain example.com [--admin-domain admin.example.com]
                                [--email ops@example.com]]
                     [--dir PATH] [--port 2368] [--version 6.3.1]
                     [--channel stable|beta] [--ref vX.Y.Z]
                     [--with analytics,activitypub,supervisor]
                     [--import BUNDLE | --migrate[=PATH]] [--no-prompt] [--no-start]
ghost-docker check | info | list
ghost-docker config get|set|unset|validate ...
ghost-docker caddy render|apply|validate|reload
ghost-docker update | backup | restore | upgrade      (as their steps land)
```

First use is the served launcher:

```sh
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- install --domain example.com
```

```powershell
& ([scriptblock]::Create((irm https://docker.ghost.org/install.ps1))) install --local
```

Installation writes a copy of the launcher into the site directory, pinned to
the image digest that installed it. Every later command is `./ghost-docker ...`
from there.

Unknown or not-yet-supported options fail clearly: exit `2` for a usage error,
`3` for a documented option whose step has not landed, naming that step. Use the
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

Rootless support requires verified socket, port, ownership, and boot behaviour;
do not infer support from linger alone.

**Reaching a site in order to verify it.** `127.0.0.1` inside the manager is the
manager, not the host, so the first implementation's probes of host loopback
cannot be ported as they were. Verification has three parts, reported
separately, and none is described as more than it is:

- **Routing, over the site's own network.** A probe attached to the site's
  Compose network requests Ghost at its unique alias
  (`ghost-${COMPOSE_PROJECT_NAME}:2368`). In production it also requests Caddy
  on port 80 with the site's `Host` header and expects the redirect to HTTPS
  that Caddy issues only for a name it serves, and it asks Caddy's admin API
  (`docker compose exec caddy`, `127.0.0.1:2019/config/`) whether each domain
  is in the running configuration, as `caddy_verify` did on `next`. This shows
  that the services answer and that the generated routes send each domain where
  it should go. It says nothing about the host, and it does not need a
  certificate.
- **Published ports, from the host's network namespace, where that namespace
  can be entered.** On a Linux host with Docker Engine, a short-lived container
  of the manager image started with `--network host` requests `127.0.0.1` on
  the published ports: Ghost's loopback port, and Caddy's HTTP port with `Host`
  preserved. That is the request an operator's own `curl` would make.
  Everywhere else the daemon is in a VM, or in a user namespace:
  - *Docker Desktop:* `--network host` enters the VM's namespace unless the
    host-networking option of Desktop 4.34 or later is enabled, and nothing in
    `docker info` says whether it is. Both outcomes look like success.
  - *OrbStack:* host networking is native, but it is one more platform to be
    shown rather than assumed.
  - *Rootless Docker:* the namespace entered is the daemon's, not the host's.

  On those platforms the manager does not start the sibling. It reports the
  ports the daemon says it published (`docker compose ps --format json`), and
  the output says that they were not verified from the host. The installer
  still prints the URL; opening it is the verification. No probe is attempted
  whose result cannot be told apart from the result it is meant to rule out.
- **HTTPS, as an issuance state, not a probe result.** Caddy obtains a public
  certificate for a public domain name in the background, retrying with
  backoff for up to thirty days; it does not substitute its internal CA when
  issuance fails, and until a certificate exists the TLS handshake for that
  name fails whatever trust the client ignores. So before DNS points at the
  host there is no certificate, and no probe can show more. The routing probe
  attempts the handshake with the site's SNI and reports one of three states:
  *serving* (a certificate exists, with its issuer and whether it is publicly
  trusted), *pending* (no certificate yet; the message names the domain, says
  that Caddy obtains one once the domain's DNS reaches this host, and that
  `./ghost-docker check` reports the change), or *failing*. Failing is
  reserved for issuance errors in Caddy's log that pointing DNS at the host
  will not cure: a CAA record that forbids the issuer, a rejected ACME
  account, a rate limit. Those are quoted. The errors expected before DNS
  exists, an unknown name or a challenge that reached another address, keep
  the state *pending*, with the last attempt's message shown. *Pending* is not
  a failure of installation. Temporary internal TLS before DNS is deliberately
  not offered: it would be a second TLS state to transition out of, and a
  self-signed certificate on a public name is a browser warning to click
  through, which is the habit this setup should not teach. Operators who want
  internal TLS for a private name put `tls internal` in `caddy/custom/`, as
  today.

A production site before its DNS points at the host therefore passes routing,
has its ports either verified or reported as published, and shows HTTPS as
pending. That is the expected state of a fresh production installation, and the
output says so in those words.

Keep nginx/apache running until cutover; a server may proxy other applications,
so replacing its whole service requires an explicit operator choice. Installation
never stops or reconfigures anything already running: a port in use is an error
naming the port, and the container holding it when Docker knows one. Bringing your own proxy is a documented manual edit of
`compose.yml`, not a supported mode; see §2.1.

Installation writes configuration, renders routing, initializes permissions and
metadata, then verifies readiness before publishing the Admin URL. `--no-start`
must not start application services. Imported sites follow the isolated flow in
§2.4; `--migrate` is the same flow preceded by a Ghost-CLI export.

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
if shared Caddy/MySQL infra is enabled.

### 2.10 Where the tooling runs

Two layers. The boundary is set by one question: does this have to work before
an image can run?

**The launcher.** `ghost-docker` (bash) and `ghost-docker.ps1` (PowerShell), the
only code that runs on the host. Keep each to a few hundred lines and to exactly
these jobs:

- Check that Docker is installed, the daemon answers, and Compose is present, and
  say what to do when they are not.
- Decide which image to run: the digest pinned in the site's own launcher; or a
  release resolved from `--channel`/`--ref`; or, in a checkout of this
  repository, an image built from it.
- Start it: `docker run` with the Docker socket, the site directory, the caller's
  identity and a terminal, following the contract below.
- Run `ghost migrate-export` for `--migrate`, because Ghost-CLI lives on the host
  and not in the image.
- Pass the manager's exit status through unchanged.

The two launchers implement one contract and must not drift. Anything that could
be a manager command is one; the launcher gains no logic that the manager could
hold.

**The manager image.** A TypeScript CLI on a pinned Node image, with its npm
dependencies, a Docker client and the Compose plugin, and the stack's files.
One image, several commands; the upgrade supervisor (§2.6) is one of them, not a
second image. Every operation that reads or changes a site lives here: install,
configuration, Caddy rendering, import, diagnosis, update, backup and restore,
upgrades.

Rationale: §2.6 already requires a privileged image published from this
repository, and requires that it "follows §2.5 rather than inventing a second
upgrade/recovery algorithm". One implementation in that image, used by every
command, is the only arrangement in which that holds. It also removes the host
as a variable: no bash 3.2 compatibility, no GNU-versus-BSD utilities, no list
of required host tools, and the same code path on Linux, macOS and Windows.

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

**Native Windows is three unverified assumptions, and they stand or fall
together.** On Linux and macOS the contract above is ordinary practice. On
Windows each part of it needs something that has not been shown to work:

1. *The daemon connection.* The Windows Docker client talks to a named pipe,
   which is not a Unix socket and cannot be mounted into a Linux container.
   The launcher instead mounts the daemon's own socket inside the Docker
   Desktop VM (`//var/run/docker.sock`).
2. *Ownership.* There is no uid or gid to pass. The manager runs as the
   image's default user, and what it writes has to be readable, writable and
   removable by the Windows user who ran the launcher.
3. *Nested bind paths.* `C:\Users\me\site` cannot be an identical Linux mount
   point. The launcher mounts it at the path the daemon uses for that
   directory (by default `/run/desktop/mnt/host/c/Users/me/site`) and gives the
   manager that path, so that the bind mounts Compose asks the daemon for
   resolve to the same directory.

Running `version`, or a `doctor` that only inspects the manager's own view,
does not qualify any of this: all three can be wrong while those succeed.
Qualification is one path exercised end to end, which `doctor` performs on
every platform: the manager writes a file into the site directory, then asks
the daemon to start a **sibling container that bind-mounts the site directory
by the path the manager was given** and reads the file back. That fails if the
daemon cannot be reached, if the manager's path means a different directory to
the daemon, or if the file is not where the daemon looks. On Windows the file
must additionally be readable and removable from the Windows side afterwards.

Native Windows stays experimental, and is described as such wherever it is
mentioned, until that check has passed on a real Docker Desktop installation
and a site has been started there. CI cannot show it: hosted Windows runners
do not run Linux containers.

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

| Milestone | Outcome | Steps |
| --- | --- | --- |
| M0 Foundation | A manager image and launchers exist, and `install` works for local and production sites. | N1, N2, N3 |
| M1 Local sites | A theme developer or migration-tool author moves each local Ghost-CLI site to Docker with one command. Local mode runs Ghost and MySQL with no Caddy. | S5b, S5c, S5d |
| M2 Tagged single-site production | Production installs from a tagged release at `docker.ghost.org`, updates between releases, has backup/restore, imports a production Ghost-CLI site, and migrates the pre-`next-docker` layout. | S6a, S4, S5e, S6b, S12 |
| M3 Multi-site | Several sites on one host behind shared Caddy/MySQL. | S13 |
| M4 One-click Admin updates | Ghost Admin requests an upgrade that the host executes and recovers. | S7, S8, S9, S10 |

S11 and S14-S16 follow M4.

```text
N1 foundation: stack files, contracts, plan    this pull request
N2 manager image, launchers, publishing        needs N1
N3 install, config, caddy, check               needs N2

M1
S5b local import                               needs N3
S5c local --migrate                            needs S5b
S5d portable import                            needs S5b

M2
S6a releases, served launcher, update          needs N3
S4  backup/restore, lock, journal              needs N3
S5e production import and cutover              needs S4, S5b; S5d for portable sources
S6b legacy-layout migration                    needs S4, S6a
S12 release qualification                      needs the rest of M2

M3
S13 shared infrastructure                      needs S4, S5e, S6b

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

S7 depends only on S4 and S6a. It is scheduled with M4 because it defines the
execution interface the supervisor reuses, but it can be pulled into M2 if
operators need a scripted Ghost upgrade sooner. Until it ships, the documented
Ghost upgrade is editing the exact version pin and running `docker compose up -d`
after a manual backup.

Work that exists outside this branch:

- `next` (frozen): the bash implementation of S1, S2 and S5b, with its tests.
- PR #300 (draft, against `next`): S4 as bash dispatcher plus a TypeScript
  manager. Its `manager/` directory is the starting point for N2 and S4.
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
- `ghost-docker` (bash) and `ghost-docker.ps1` (PowerShell), implementing the
  launcher contract of §2.10: Docker checks with actionable messages, image
  selection (pinned digest, channel/ref, or build from checkout), the `docker
  run` invocation, terminal attachment when piped, exit-status passthrough.
- A workflow that builds the image for `linux/amd64` and `linux/arm64` and
  publishes `edge` on pushes to `next-docker` and the version tag on release
  tags, and CI that builds the image and runs the tests on Linux, plus the bash
  launcher on macOS and the PowerShell launcher on Windows.

Also `ghost-docker.cmd`, a two-line shim that starts the PowerShell launcher from
`cmd.exe` with the execution policy bypassed for that one process: a default
Windows client refuses to run `.ps1` files, and the launcher's logic (deadlines,
path translation, argument handling) is not something batch can carry.

Acceptance: from a clone, `./ghost-docker version` and `./ghost-docker doctor`
build the image and run on Linux and macOS; a file the manager writes into the
site directory is owned by the caller under rootful and rootless Docker; the
launcher's refusals (no Docker, daemon down, no Compose) are tested without a
daemon; the manager's exit status and a usage error reach the caller unchanged;
the published `edge` image runs the same commands without a checkout. `doctor`
includes the sibling-container check of §2.10 and passes on Linux and macOS.
The PowerShell launcher's own behaviour is tested on a Windows runner against a
stand-in `docker`; the pull request states that this does not qualify native
Windows, and what would.

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
it, and it is the question people expect at setup. Production installs prompt
for it when a terminal exists, blank meaning none; it is stored as
`ACME_EMAIL` in `.env` and rendered into the generated site file as `tls
{$ACME_EMAIL}` only when set, so it lives with the site that uses it and
`caddy/global/` stays operator owned. `config set ACME_EMAIL` followed by
`caddy apply` changes it later.

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
certificate exist: routing passes, the published ports are verified from the
host on Linux and reported as unverified on macOS, and HTTPS is reported as
pending. A site
installed into an empty directory from the published image alone, with no
checkout, starts with `--with activitypub`, and its `analytics` helper images
build from the payload written there. The dotenv encoder passes the round trip through real containers for
`$VAR`, `${VAR}`, `$$`, spaces, both quote types, backslashes, newlines, empty
strings and JSON arrays.

### S3 — Ghost-CLI export command

Status: implemented and released in Ghost-CLI 1.33.0 (PR #2333).
`docs/bundle-v1.md` is in step with it.

### S5 — Bundle import and migration cutover

Repo: ghost-docker. Implement §2.4 as `install --import` and `install
--migrate`. Four parts; each is its own pull request. (S5a, syncing the contract
with the released exporter, is done.)

**S5b — Local import.** Deps: N3. Not S4; see "Local imports" in §2.4. Import
`sourceInstallType: local` bundles of kind `mysql-dump` and `mysql-data`.

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
- A `portable` bundle is refused with exit 3 until S5d; a `production` bundle
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

**S5c — Local `--migrate`.** Deps: S5b. Implement "`--migrate`" in §2.4 for
local installations. The export half is in both launchers, the import half is
S5b.

Acceptance: run from inside a local SQLite and a local MySQL Ghost-CLI install,
directly and through the served launcher; a non-install directory, a Ghost-CLI
older than 1.33.0, a Ghost 5.x source and a production install are each refused
before any change; the source is stopped by the export and never started; the
Docker site takes the source's port; after a failed import a source that was
running is running again; exporter failure is surfaced, with the portable retry
offered only interactively.

**S5d — Portable import.** Deps: S5b. Step 8 of the import sequence: isolated
destination with no public ingress, owner setup, authenticated multipart content
and member imports, documented losses verified. `manager/demo-import.mjs` on
`codex/update-supervisor` is a starting point, not a finished implementation.
Enables the `--migrate` portable retry.

Acceptance: a portable bundle from a local SQLite source, including an empty
members file; each documented loss demonstrated by a test rather than asserted;
a retry cannot duplicate a partially completed import.

**S5e — Production import and cutover.** Deps: S4, S5b; S5d for portable
sources. The full §2.4 sequence for `sourceInstallType: production`: site lock,
recovery copies, separate admin URLs, isolated verification, final-export
(`--leave-stopped`) handling, explicit ingress switch, and source-restart
instructions. Extends `--migrate` to production installations.

Acceptance: a same-server migration with an existing proxy on 80/443 and a
cross-host migration; partial retries; rehearsal imports with outbound side
effects suppressed. This part is what replaces the legacy `scripts/migrate.sh`
on `main`: S12 must not merge this branch into `main` before it passes.

### S6 — Releases, the served launcher, and updates

Repo: ghost-docker. Implement §2.7 in two parts.

**S6a — Releases, served launcher, and `update`.** Deps: N3. release-please on
`next-docker` producing beta tags and explicit dependency-only patch releases;
image tags `vX.Y.Z[-beta.N]`, `stable` and `beta` published from release tags;
tested release resolution; the `gh-pages` workflow serving the launchers at
`docker.ghost.org`; managed-file checksums; and `update` between releases of
this layout as described in §2.7, without the legacy migration.

Acceptance: the served launchers install the newest beta and an explicit
`--ref`; version selection is tested against prerelease ordering rather than
lexical sort; a dependency-only change produces a release; `update` moves a site
between two releases with the Ghost pin unchanged and the launcher re-pinned,
refuses a downgrade, asks before replacing a hand-edited managed file and keeps
a backup of it (stopping instead under `--no-prompt` without `--replace-edited`),
and restores the previous files when validation fails before services change.
In clone mode, a failed update between two refs whose `compose.yml` differs
leaves the checkout at the previous commit with the previous configuration and
the site running, and a dirty tree is refused before anything changes.

**S6b — Legacy-layout migration and transactional updates.** Deps: S4, S6a. The
journalled migration framework, migration `0001-compose-profiles`, the way in
for installations that have no launcher, and checkpoint-backed recovery. Gates
merging `next-docker` into `main`.

Acceptance: update from the layout on `main`, including existing optional
profiles, custom Caddy routes/overrides, absent metadata, and an untagged
starting commit. Inject failures before and after migrations, pull, and startup;
verify complete recovery or an accurate recovery-required outcome.

### S4 — Backup, restore, locks, and recovery journal

Repo: ghost-docker. Deps: N3. Implement the reusable §2.5 checkpoint/restore
contract as manager commands: explicit DB connection abstraction, operation
lock, maintenance handling, retention, and journals. Backups include required
local application/configuration state and describe optional-service limitations.
Define supported backup formats independently of migration bundles; a portable
export is not a lossless recovery checkpoint.

Add the shared operation lock to every mutating command that already exists
(install, config, caddy, import): §2.2 requires it.

PR #300 implemented this against the bash layout. Its TypeScript
(`manager/main.ts`, `storage.ts`, `probes.ts`, `process.ts`, `types.ts`), its
recovery documentation and its tests carry over; its bash dispatcher and its
changes to bash helpers do not. Land it as reviewable slices: the lock on
existing commands, then checkpoints, then restore and interrupted-operation
recovery.

Acceptance: restore a representative site to a fresh destination and verify
database, assets/theme/configuration; inject interrupted backup/restore, full
disk, stale lock, and SQL pipeline failure. Recover without exposing an
incomplete destination.

### S7 — Host-driven Ghost upgrades

Repo: ghost-docker. Deps: S4 and S6a compatibility rules. Implement `./ghost-docker
upgrade [version|latest]` following §2.5, initially without a supervisor. Specify the reusable
execution interface so the supervisor cannot diverge from backup/recovery behavior.
Keep supported majors/downgrades constrained and feature compatibility explicit.

Acceptance: upgrade across an actual database migration, verify optional analytics
sync/deploy, inject startup failure after migration, and restore the checkpoint.
Test process interruption at each mutation boundary, two concurrent requests, and
refusal of unsupported transitions. A live database restore drill is a release gate.

### S8 — Supervisor command, protocol, and installer integration

Repo: ghost-docker. Deps: S7, S9; S13's shared-DB rules if it has shipped. A
prototype exists on `codex/update-supervisor`; rework it against the adapter
contract merged from Ghost PR #31277 rather than starting over. Write
`docs/upgrade-supervisor.md` with the exact §2.6 schemas, transitions, ownership,
policy, and recovery rules, then implement the supervisor as a long-running
command of the manager image. Reuse S7 behavior. Wire `--with supervisor` and
request submission/status tooling.

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
`next-docker` into `main`. Include the launchers on Linux, macOS and Windows.
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

### S13 — Optional shared Caddy/MySQL infrastructure

Repo: ghost-docker. Deps: S4, S5e, S6b. Scheduled before S7-S10 so upgrades and the
supervisor are built against per-site projects. Only now introduce `infra` and `site` modes and
`--infra-only`/`--infra` installation. ActivityPub, traffic analytics, and Tinybird
jobs remain per-site; no shared analytics/federation variants in this step.

Design/implementation requirements:

- Extend the complete profile/dependency matrix: infra has no Ghost, Caddy must not
  require an inactive Ghost, and URL cannot remain universally required. Optional
  jobs must not accidentally provision a member's local database.
- Assign unique database names/users and restricted grants per site, with distinct
  ActivityPub database/grants where enabled. Backups/restores target a site's DBs,
  never the whole shared MySQL instance during a site operation.
- Make DB endpoint selection explicit. If private DB opt-in is offered, add a real
  `db` profile and isolate/address it without ambiguous shared `db` aliases.
- Separate private service networks from shared ingress/database connectivity where
  appropriate. Shared networks are not tenant isolation; document the trust model.
- Parameterize every optional-service upstream. No global `ghost`, `activitypub`,
  or `traffic-analytics` alias is safe across member projects. Verify that shared
  Caddy routes ActivityPub assets to the correct site's storage-serving endpoint.
- Resolve network names from actual infra configuration. If a Compose override is
  needed for external networking, explicitly support it: persist the file list,
  make helpers honor it, document override auto-loading changes and IPv6 composition.
  Do not claim COMPOSE_FILE is unused if a fallback actually sets it.
- Add register/unregister/list/check. Serialize registrations, reject duplicate
  domains/project identities, provision DB grants safely, validate/reload Caddy, and
  leave recoverable state after partial failure. Purge requires explicit selection
  and cannot delete another site's data/user grants.
- Route shared-DB operations through the established DB abstraction. The supervisor
  cannot assume `exec db` in its own project or access an unmounted infra checkout.
  Keep infra root credentials out of member configuration and supervisor scope.
- Define supported Ghost/MySQL/infra version combinations and infra maintenance/
  backup policy. An infra `down` or DB update affects every member; verify recovery
  and clearly report this blast radius. Set capacity limits and connection budgets.
- Default new shared setups to dedicated infra. Do not promise converting an existing
  single-site installation by merely changing profiles. If offering a conversion,
  include stopped MySQL transfer, Caddy certificate volume ownership/identity,
  unchanged data, checkpoint, verification, and tested rollback as part of this phase.

Acceptance: dedicated infra plus two sites on different exact Ghost versions, each
with per-site optional services; upgrade/restore/remove one without touching the
other's data; exercise private DB opt-in if supported, concurrent registration,
cross-site route checks, infra restart/outage, and partial provisioning recovery.
Document unsupported combinations rather than silently falling back to shared aliases.

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
  [dotenv interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/),
  [Caddy commands](https://caddyserver.com/docs/command-line), and
  [release-please](https://github.com/googleapis/release-please).
