# Plan: ghost-docker as a Ghost-CLI replacement

Status: revised 2026-09-02 after code and Compose review. This is an implementation
plan, not authorization to execute its steps. Single-site installations are the
initial release target. Shared infrastructure, image distribution/channel extensions,
and default Redis follow in the final phases.

This document lives in the repository so that every branch in the stack carries
the contracts it is implementing against. Amend it in the PR that changes a
decision, rather than letting the code and the plan drift apart.

Repos involved:

- `TryGhost/ghost-docker`: installation, configuration, import, upgrades, operations.
- `TryGhost/Ghost-CLI`: migration bundle export, PR #2333.
- `TryGhost/Ghost`: upgrade adapter, Admin API, and Admin UI.

Each step below is a separate work package. Read its dependencies and the contracts
in this document before implementation. Do not treat step prompts as independent
of those contracts. Update operator documentation and tests with each step.

## 1. Scope and decisions

| Topic | Decision |
| --- | --- |
| Initial audience | Local and single-site production installations; most servers run one site. |
| Site model | One checkout = one site. One base `compose.yml`, with `local` and `production` modes selected through `COMPOSE_PROFILES`. |
| Shared infrastructure | Deferred to S13, after the single-site replacement is complete. It is not a dependency of the initial release. |
| ActivityPub and analytics | Per-site initially, including for future members of shared infrastructure. Each site owns its ActivityPub database/storage and Tinybird configuration/deployment lifecycle. No shared ActivityPub or analytics service in S13. |
| Versions | Resolve and persist an exact Ghost image version on installation. Ghost upgrades and stack/repository updates are separate operations. Record resolved image digests for recovery. |
| Distribution | Clone at a release tag. Stable tags `vX.Y.Z`; beta tags `vX.Y.Z-beta.N`. A bootstrap shim selects the release and delegates to that checkout. |
| Installation | Scriptable `install.sh`, with flags for every required prompt. Local mode uses MySQL too. Requires `bash`, `docker`, `docker compose` and `jq` on the host, verified in preflight; `scripts/migrate.sh` already required both `bash` and `jq`. Helper scripts stay bash 3.2 compatible so macOS's system bash works. No host Node requirement for a new install; Node is otherwise only used to run the test suite. The one exception is the legacy `scripts/migrate.sh`, which shells out to `scripts/config-to-env.js` and therefore still needs Node until `install.sh --import` replaces it. |
| Migration | Ghost-CLI exports a bundle; Docker imports it. Fix the encoding contract before declaring v1 frozen. `install.sh --import` replaces `scripts/migrate.sh` outright rather than living alongside it; retire the old scripts, and with them the last host Node dependency, only after replacement fidelity and recovery tests pass. |
| Upgrades | Optional supervisor using a file exchange and Docker socket. Ship a tested host-driven upgrade operation first, then reuse its recovery contract in the supervisor. |
| UX | Standard Compose commands for daily operation; scripts for installation, doctor/list, migration, backup/restore, and upgrades. No wrapper binary named `ghost`. |
| Where tooling runs | A thin host shell layer (bootstrap, preflight/doctor, dispatch) plus a pinned manager image that holds the stateful operations. See §2.10. Host requirements stay `bash`, `docker`, `docker compose`, `jq`; no host language runtime. |
| Configuration | `.env` contains Compose/operator settings; `ghost.env` contains only Ghost application settings. Do not pass the whole `.env` into Ghost. A mounted Ghost JSON config file was evaluated as a replacement for `ghost.env` and rejected; see §2.1. |
| Ghost nightly channel | Future explicit opt-in via `--ghost-channel nightly`; published to GHCR, independently of the stack release channel. Stable remains the default. |
| Service image registry | Future `--image-registry dockerhub|ghcr` selects dual-published traffic-analytics and ActivityPub images, including migrations. Preserve existing selections when updating. |
| Redis | Default on new installations once S16 ships, with explicit `--without redis` opt-out. Existing sites adopt through a documented migration. Per-site caching first; future durable uses require their own state policy. |
| Multi-site prototype | Retire the old 1800-line single-project generator on `feat/multisite`. Salvage tested helpers and DB provisioning logic only after review. |

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

- Ghost publishes `127.0.0.1:${GHOST_PORT:-2368}:2368`. The installer picks a free
  port when none is supplied; an explicit occupied port is an error.
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
- `ghost.env` is the only application `env_file`, and is transitional. Explicit
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

The residual risk is accepted: a hand-written `$$` is indistinguishable from a
correctly escaped single `$`, so no linter can catch it. Mitigation is to write
values with `scripts/config.sh set`, which encodes correctly, and `env_lint`,
which catches the bare-`$` case. Document that hand-editing a value containing
`$` is unsafe.

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

- Ghost publishes `127.0.0.1:${GHOST_PORT:-2368}:2368`. The installer picks a free
  port when none is supplied; an explicit occupied port is an error.
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
- `ghost.env` is the only application `env_file`, and is transitional. Explicit
  Compose environment entries override container-owned keys; the importer
  rejects/omits those keys.

Application configuration is moving from `ghost.env` to a mounted JSON config
file, because dotenv cannot hold an arbitrary value safely: Compose interpolates
`env_file` values, so an SMTP password of `Pa$$w0rd!` reaches Ghost as
`Pa$w0rd!` with no error anywhere. Verified against `ghost:6-alpine`
(Ghost 6.61.0, nconf 0.13.0):

- The image ships `config.production.json` in Ghost's install directory
  (`/home/ghost` in the `next` variants, `/var/lib/ghost` in the older layout),
  with `config.development.json` symlinked to it. It sets `url`, `server`,
  `mail.transport: "Direct"`, `logging.transports`, `process`, `security` and
  `paths.contentPath`.
- nconf is first-added-wins. `loader.js` registers `custom-env`
  (`config.<env>.json`) *before* `local-env-jsonc` (`config.local.jsonc`), so
  `config.local.jsonc` cannot override anything the image ships — including
  `mail.transport`. It is not usable as the operator's config file.
- Compose `environment` entries still outrank every config file, so
  container-owned keys stay enforced by construction.
- `localUtils.jsoncFormat` already exists and wraps `jsonc-parser`.

The Ghost change this depends on is to register a custom-env JSONC file
*before* `custom-env` in `core/shared/config/loader.js`:

```js
nconf.file('custom-env-jsonc', {
    file: path.join(customConfigPath, 'config.' + env + '.jsonc'),
    format: localUtils.jsoncFormat,
});
nconf.file('custom-env', path.join(customConfigPath, 'config.' + env + '.json'));
```

Ordering is the point. Registered first, the operator's file layers *over* the
image's shipped defaults instead of replacing them, so ghost-docker never has
to keep its own copy of those defaults in sync. Comments and trailing commas
come along for free.

Two constraints follow:

- The file is per-environment, so it mounts as `config.${NODE_ENV}.jsonc`;
  local mode (`NODE_ENV=development`) needs `config.development.jsonc`.
- It sets a Ghost version floor. §2.4 imports at the *source* Ghost version, so
  a site imported from a Ghost that predates this change would not read the
  file at all. S5 must either detect that and fall back, or require a floor for
  imported sources; it cannot assume the feature is present.
- Add site/mode labels and a real Ghost readiness probe. A running container or
  redirect response alone does not establish readiness.
- Cap container logs and make optional-service resource costs visible.

Before publishing the minimum Docker/Compose versions, run the mode matrix against
that exact minimum and a current version. The installed Compose v5.1.2 accepted
interpolated restart `no` and network `external=true`; that is not verification of
older versions. Include `start_interval` and any env-file features in compatibility
checks. Avoid dependencies on undeclared host utilities or GNU-only shell behavior.

### 2.2 Environment values, metadata, and permissions

`scripts/lib/env.sh` must never source or evaluate an env file. Define a serializer
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

Reference: Ghost-CLI PR #2333 and its `docs/migration-bundle.md`. Review the local
`claude/ghost-cli-migration-export-c00253` branch without assuming it is merged.

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
  Portable exports require a running source; final export must arrange a write freeze
  before taking API/content snapshots, then leave it stopped for cutover.

Import sequence:

1. Acquire the site lock. Validate target state and available space. Default to a
   fresh target; refuse merging into an existing live database/content tree.
2. Inspect/extract into private staging. Reject path traversal, absolute member paths,
   and escaping symlinks/hardlinks, including in directory bundles. Bound expansion
   and check space for extracted content, database restore, and recovery copies;
   compressed archive size times 1.5 is not a sufficient estimate.
3. Read/validate the manifest using a pinned helper container, with no Compose
   dependencies, no public ports, and read-only access to the bundle. This cannot
   depend on an already-valid site `.env` or already-running Ghost.
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
   restore before Ghost is started; propagate pipeline failures.
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

`install.sh --import` must not start normal production ingress before this workflow.
For rehearsal/local imports, provide a safe documented way to suppress outbound
email, newsletters, payments/webhooks, and federation activity. Do not silently send
real production traffic from a copied database.

### 2.5 Backup, upgrade, and recovery

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

Publish an optional supervisor image from this repo. The Docker socket is
host-privileged; non-root process execution does not remove that authority. The host
operator explicitly enables self-upgrades and controls policy. Ghost owner/admin
authorization permits requests only within that host-defined policy.

The supervisor sees the checkout at the same absolute host path for Compose bind
resolution. Define supported local Docker contexts and socket paths; reject remote
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

### 2.7 Stack versions and repository updates

Release-please manages releases. Configure dependency changes explicitly as
releasable patches; do not assume `chore(deps)` does that by default. Specify beta
release mechanics and test version selection rather than using lexical sorting.

`scripts/update.sh [--check] [--channel stable|beta] [--to vX.Y.Z]` updates the stack,
not Ghost. Preserve the exact Ghost pin; if a stack release requires a newer Ghost,
stop with the required upgrade sequence. Initially reject stack downgrades unless
the relevant migrations explicitly support them.

Transactional flow:

1. Acquire the site lock; reject a dirty tracked tree and unresolved operations.
2. Fetch/resolve the release, check compatibility, show changes, and record the
   previous commit SHA (the source may not have been installed from a tag).
3. Run a stable updater/helper outside files being replaced. Back up `.env`,
   `ghost.env`, generated/custom Caddy files, metadata, and migration journal.
4. Obtain pre-checkout hooks from the target release. Journal their phases and run
   them before checkout where necessary; then checkout and run post-checkout hooks.
   Idempotency does not substitute for recovery. Record completion only after the
   corresponding stage succeeds.
5. Validate Compose and Caddy, pull images, apply the release, and verify readiness.
   Define safe handling of DB/ActivityPub schema-affecting stack changes using the
   backup/recovery contract; do not blindly roll back a migrated service image.
6. On failure, restore the previous code and configuration where safe. If stateful
   service changes already occurred, use their recovery procedure or report
   recovery-required. Never report success merely because `up -d` returned zero.

Migration `0001-compose-profiles` must handle both an absent profile setting and
existing `analytics,activitypub` values, adding `production` in either case. Split
application config into `ghost.env`, preserve credentials and project identity, add
URL/PROJECT_DIR and an exact pin for the currently running Ghost version.

Move an existing untracked Caddyfile before checkout introduces the tracked file.
Preserve customizations automatically when supported; otherwise stop before changing
the live setup and present the required configuration resolution. Test custom routes,
legacy Compose overrides, skipped releases, repeat invocation, and failed hooks.

Publish a bootstrap path for existing installations that do not yet have update.sh;
do not tell them to execute a script absent from their checkout or use raw git pull
to cross the breaking change.

### 2.8 Installer and day-to-day operations

```text
install.sh [--local | --domain example.com [--admin-domain admin.example.com]]
           [--dir PATH] [--port 2368] [--version 6.3.1]
           [--channel stable|beta] [--ref vX.Y.Z]
           [--with analytics,activitypub,supervisor]
           [--import BUNDLE] [--no-prompt] [--no-start]
```

The curl-able shim contains only bootstrap logic; installation logic lives at the
selected release. Pin the selected release before executing its helpers. Unknown or
not-yet-supported flags fail clearly. Use `/dev/tty` for interactive input; no-prompt
must not silently accept destructive choices.

Preflight covers supported OS/architecture, Docker and Compose versions, selected
daemon access/context, required tools, writable directories, memory/disk, ports,
optional-service credentials, URL/DNS, and compose/caddy validation. Test daemon
access instead of requiring root/docker-group membership. Rootless support requires
verified socket, port, ownership, and boot behavior; do not infer support from linger
alone. Handle systems without systemd or explicitly narrow the supported platforms.

Check daemon startup on Linux; document Docker Desktop/OrbStack startup for local
macOS. Bind-mounted paths must be available at daemon startup. Keep nginx/apache
running until cutover; a server may proxy other applications, so replacing its whole
service requires an explicit operator choice. Installation must not stop or
reconfigure an existing proxy. Bringing your own proxy is a documented manual
edit of `compose.yml`, not a supported mode; see §2.1.

Installation writes configuration, renders routing, initializes permissions and
metadata, then verifies readiness before publishing the Admin URL. `--no-start`
must not start application services. Imported sites follow the isolated flow in §2.4.

`site.sh list` includes stopped containers (`docker ps -a` with labels) and, where
possible, known installations with no current container. State what cannot be
discovered without a registry. `site.sh check`/doctor works for single-site installs
and validates actual DB connectivity, configuration, readiness, and recovery state.

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

Operations split across two layers. The boundary is set by one question: does
this have to work when Docker is broken?

**Host shell.** Small, portable, and the only thing that runs before an image
exists.

- The bootstrap shim: check Docker, resolve the release, pull the manager
  image, exec into it.
- Preflight and `doctor`. These must diagnose a host where Docker is missing,
  stopped, or unreachable, so they cannot depend on the manager image. They may
  use it for deeper checks when it is available, and must degrade to useful
  host-level output when it is not.
- A dispatcher that maps a command to a `docker run` of the manager image, with
  the mount and identity rules below.
- Anything that must survive the manager image being unpullable.

**Manager image.** Pinned, published from this repo, and where the stateful
work lives: install orchestration, import, backup and restore, Ghost upgrades,
and stack updates. It is one image with several entrypoints, not several
images.

Rationale, not preference: §2.6 already publishes a privileged supervisor image
from this repo and requires that it "follows §2.5 rather than inventing a second
upgrade/recovery algorithm". If S4-S7 implement backup, upgrade and recovery in
host shell while S8 implements a supervisor in an image, that algorithm exists
twice. Putting the stateful operations in the image the supervisor already needs
keeps one implementation, and the supervisor becomes an entrypoint on it rather
than a parallel codebase.

Contract for every manager invocation:

- **The site directory is mounted at its own absolute host path.** Compose bind
  sources are resolved by the daemon against the host filesystem, so a site
  mounted anywhere else silently binds a different host path. Verified: a site
  mounted at `/site` renders `source: /site/data/ghost`, which the daemon then
  creates on the host. Refuse to run when `PROJECT_DIR` and the mount point
  disagree.
- The Docker socket is host-privileged. Running the manager as a non-root user
  does not reduce that authority. Mount nothing writable beyond what the
  operation needs.
- Define uid/gid ownership for every file the manager writes into the site
  directory. Do not assume host uid 1000, and account for rootless and userns
  remapping.
- Interactive prompts go through `/dev/tty` into the container; every prompt has
  a flag equivalent so `--no-prompt` is fully scriptable.
- The manager version is pinned with the stack release, resolved by the
  bootstrap, and recorded in `.ghost-docker.json` so an operation can be
  reproduced later.
- Exit codes and structured errors propagate through the dispatcher unchanged. A
  wrapper that collapses failures into "docker run failed" is not acceptable.

What this does **not** solve, and should not be claimed to: Compose's dotenv
interpolation. Anything writing `.env` still encodes a literal `$` as `$$`
regardless of implementation language, and §2.1 records why the alternative
config format was rejected.

When install.sh resolves the exact Ghost image (§1), it should write
`GHOST_CONTENT_PATH` and `GHOST_TINYBIRD_PATH` into `.env` from that image's own
`GHOST_CONTENT`, so the layout and the configuration cannot disagree in the
first place. S1 validates the pair; S2 should set it.

Sequencing: this decision has to be made before S2, because it determines
whether `install.sh` is the installer or a bootstrap that runs one. Steps
already shipped in host shell (S1's `config.sh` and `caddy.sh`) stay where they
are; the boundary does not run through them.

#### When the manager image lands, and what its first tenant is

Revised 2026-09-03, after S2. Two questions kept coming up — *should the image
ship sooner?* and *should env validation and Caddy generation move into it?* —
so the boundary above is stated concretely rather than left to inference: when
the image lands, and exactly which helpers move onto it versus stay host shell.

**The image's first tenant is the first stateful operation, at S4, not S8.**
§2.6 already publishes a privileged supervisor image from this repo and requires
it to "follow §2.5 rather than inventing a second upgrade/recovery algorithm."
If S4–S7 implement backup, restore, upgrade and recovery in host shell and S8
then re-implements them in an image, that algorithm exists twice, and the second
copy is the one under the privileged supervisor. So the manager image is
introduced in **S4**, with backup/restore as its first entrypoint; S5 (import),
S7 (upgrade) and S8 (supervisor) are further entrypoints on the same image, not
parallel codebases. This is a scheduling clarification, not a new component:
§2.10 already defined the image and the dispatcher. It does **not** move S4's
deliverable — S4 still ships backup/restore — it fixes the language they are
written in so they are not rewritten at S8. The host dispatcher (this section's
mount, identity and exit-code rules) is written in S4 alongside its first
`docker run` target.

**Some config helpers move into the manager CLI at S4; a specific subset must
not.** The dividing line is not "config versus stateful" — it is whether the
helper can run *before and without* a working daemon, and whether it derives its
answer by asking Docker. This was worked out concretely after S2, against the
real files, because "put the helpers in a node container so the scripts get
smaller" is a reasonable instinct that turns out to be right for two files and
wrong for two others.

The manager image exists from S4 for backup/restore, and the dispatcher (§2.10's
mount/identity/exit-code rules) is written there. Once both exist, moving the
*pure* config logic onto them is close to free and is a real simplification, so
S4 (or S5, whichever first needs them container-side) does it:

- **Moves into the manager CLI.** `env.sh` (the `$$` serializer/parser, ~260
  lines of bash regex state machine → ~60 lines of `JSON.parse`/stringify plus
  one encoder) and `meta.sh` (`.ghost-docker.json`, ~245 lines of `jq` → native
  JSON). Caddy *rendering* (`caddy_render` and `_caddy_site_block`, pure template
  emission) moves with them. These are pure functions of files on disk; nothing
  in them asks the daemon a question. The bash versions are deleted, not
  wrapped — a straight substitution, which is the easy-to-review kind of diff.

- **Stays host shell, permanently.** Two reasons, each disqualifying on its own:

  - *Runs before/without the image.* The bootstrap resolves the manager from the
    release tag and can have it write the first `.env`, but the bootstrap shim
    itself, preflight, and `site.sh check`/doctor must diagnose a host where
    Docker is missing, stopped, or wedged. They cannot be `docker run`. (S2
    verified this the hard way: a wedged daemon mid-session was still diagnosed
    by host-shell preflight precisely because it does not depend on the image.)
  - *Derives its answer by asking Docker.* `config.sh validate` establishes the
    container-owned keys by asking `docker compose config` what the container
    receives (`config_ghost_environment`, the "derived, not listed" guarantee).
    `caddy_validate`/`reload`/`verify` drive the running caddy container through
    `compose_run`. Moving these into the manager would mean either bundling the
    Docker/Compose CLI inside the manager and running compose-in-a-container over
    a mounted socket, or reimplementing Compose interpolation in node — which is
    exactly the drift that "ask Compose" was chosen to avoid. Neither is worth
    it, so validation and caddy orchestration stay where they can call Compose
    directly.

Consequences to accept deliberately: config logic ends up split — `config
get/set/unset` in the manager CLI, `config validate` in host shell — because the
two halves have different daemon dependencies. That split is the honest cost, and
it is smaller than the cost of dragging a Docker CLI into the manager image to
avoid it. Containerizing the movable helpers also does **not** solve Compose's
`$$` interpolation: a literal `$` is encoded `$$` regardless of implementation
language, as recorded above. And the net line count of the move, counting the
Dockerfile, publish pipeline and privileged dispatcher it rides on, is roughly a
wash — the reason to do it is that env/meta stop being bash, not that the repo
gets shorter. Which is why it waits for S4: on a PR that builds the image and
dispatcher anyway, the env/meta deletion is pure upside; as a standalone change
it would stand up a privileged image and publish pipeline to save ~130 counted
lines, which does not clear the bar.

So the dispatcher-plus-image model covers the **stateful** commands (backup,
restore, import, upgrade, supervisor) and, from S4, the **pure** config helpers
(`env`, `meta`, caddy render). Preflight, doctor, the bootstrap shim, `config
validate` and caddy orchestration stay host shell — the first three because they
must run when there is no usable image, the last two because they answer by
asking Docker. Host requirements stay `bash`, `docker`, `docker compose`, `jq`;
no host language runtime is added.

## 3. Implementation steps

The numbering is revised from the original plan; use names as well as numbers when
referring to older discussions. These are work packages, not instructions to create
parallel agents or separate tasks automatically.

Each step includes a copyable implementation prompt. Give the implementation session
this plan (attach it or make the path below accessible), then paste the prompt for
that step. The full step requirements and acceptance criteria remain part of its
scope. A prompt authorizes only that work package, not execution of later steps.
Dependency checks should inspect the actual implementation, not rely on step numbers
being marked complete in a document.

```text
S1 contracts/config + Compose foundation
 ├─ S2 installer
 ├─ S3 migration exporter (can begin after the bundle contract is settled)
 └─ S4 backup/restore and operation journal
S5 importer/cutover          needs S2, S3, S4
S6 stack releases/updater    needs S1, S2, S4
S7 host Ghost upgrade       needs S4, S6 compatibility rules
S8 supervisor protocol/app  needs S7
S9 Ghost adapter/API        needs S8 protocol contract
S10 Admin UI                needs S9
S11 file-based secrets      needs S1, S4-S8 credential consumers
S12 release qualification   needs S1-S10; qualify S11 if included
S13 shared infrastructure   needs S12; optional
S14 service image registries needs S12; independent of S13
S15 Ghost nightly channel   needs S14 image resolution; explicit opt-in
S16 default Redis           needs S12; independent of S13-S15
```

That graph is also the branch order. Each step is one pull request stacked on
the ones it depends on, so a reviewer sees only that step's diff, and the
contracts in §2 stay reviewable in the branch that changes them. Steps with a
shared dependency and no dependency on each other (S2, S3 and S4 on S1) can be
separate stacks off the same base. Mark a step's status in its section when its
PR lands, and amend the affected contract in §2 in the same PR rather than
afterwards.

### S1 — Contracts, configuration, and Compose foundation

Status: implemented, with one deliberate deferral. The `.ghost-docker.json`
schema is specified in §2.2 but its reader/writer moved to S2, alongside
`install.sh`, which is the first thing that writes the file. See
`docs/configuration.md`, `docs/caddy.md` and `docs/bundle-v1.md` for the
contracts as built, and the note in §1 on the `jq` prerequisite, which this
step resolved.

Repo: ghost-docker, coordinating the bundle schema with Ghost-CLI. Implement §2.1-2.3
and define the bundle encoding contract in §2.4. Establish `.env`/`ghost.env`, safe
env helpers, atomic writes, metadata schema, unique aliases, DB variables, Caddy
templates, readiness, log limits, and lifecycle-specific restart policies. Keep
infra/member modes out of the supported initial matrix. Preserve existing installs
through the S6 migration path; do not delete migrate.sh yet.

Acceptance: all supported mode/optional-service configurations validate on minimum
and current Compose; local and production HTTPS smoke tests pass; one-shot jobs stay
stopped after completion; actual container configuration preserves edge-case values
and excludes root credentials. Shellcheck and focused helper tests pass.

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository first. Treat the
referenced step, its dependencies, and the architecture contracts as the
requirements for this implementation.

Implement S1 — Contracts, configuration, and Compose foundation. Read the
repository instructions and inspect the existing Compose, Caddy, migration
helpers, and optional-service setup first.

Follow sections 2.1–2.4 and S1 of the plan. Establish the application/operator
config split, safe env serialization, atomic writes, metadata schema,
parameterized DB connection, unique service aliases, readiness checks, capped
logs, and local/production profiles. Keep one-shot restart policies distinct
from long-running services. Generate and validate Caddy routes with explicit
production reload. ActivityPub and analytics remain per-site; do not add
shared-infra modes or remove the existing migration scripts.

Document the unpublished bundle v1 contract: raw string values in config and
required bundleCreatedAt/sourceInstallType metadata, with no draft-format
compatibility path. Leave exporter implementation to S3 and legacy-install
migration to S6.

Verify all supported profile combinations on the declared minimum and current
Compose, local and production ingress, one-shot completion, and real Compose
round trips for special characters. Confirm Ghost receives no infrastructure
root credentials.

Complete this step only. Update the relevant documentation and focused tests
as part of the implementation. Finish with a summary of changed
behavior/files, verification results, and any unmet acceptance criteria or
blockers for dependent steps.
```

### S2 — Local and single-site production installer

Status: implemented. `bootstrap.sh` is the release-selecting shim and
`install.sh` the checkout-owned installer; `scripts/lib/meta.sh` is the
`.ghost-docker.json` reader/writer deferred from S1, and `scripts/site.sh`
provides `list` and `check`/doctor. See `docs/install.md` for the contract as
built. Two deliberate notes for dependent steps: the bring-your-own-proxy path
stays the documented manual edit of `compose.yml` from §2.1, and the operation
lock in §2.2 is *not* implemented here — it lands with the other mutating
operations in S4, so S4 must add it to installation as well as to its own.

Repo: ghost-docker. Deps: S1. Implement §2.8 for fresh installs, exact version
resolution, stable identity, scriptable prompts, custom proxy use, and optional
service setup. `--import`/supervisor behavior may initially fail as unimplemented
until their steps land; do not advertise working support prematurely. Do not add
infra flags yet.

Acceptance: CI installs local and production from a candidate release source, checks
Admin readiness through the intended ingress, validates no-prompt/no-start behavior,
and runs two independent local sites. Cover explicit port conflicts and a server
with an existing proxy: installation must fail clearly on the port conflict
rather than stopping the operator's proxy or silently taking its ports.

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository first. Treat the
referenced step, its dependencies, and the architecture contracts as the
requirements for this implementation.

Implement S2 — Local and single-site production installer. Read repository
instructions and verify the S1 configuration/helpers are present before
building on them. S1 deferred the `.ghost-docker.json` reader/writer to this step:
implement it against the schema in §2.2, since install.sh is its first writer.

Follow section 2.8 and S2. Implement the release-selecting bootstrap and
checkout-owned installer with exact Ghost version resolution, stable project
identity, private config files, generated passwords, mode-aware preflight,
free-port selection, optional-service setup, Caddy rendering, readiness
verification, and a useful final summary. Never stop or reconfigure an existing
proxy; fail clearly on a port conflict instead. Prompts must work through /dev/tty;
every required input must be scriptable. Honor --no-prompt and --no-start. Do
not add infra flags; reject import/supervisor options clearly if their
implementation has not landed.

Add candidate-release CI for local and production installs, two separate local
sites, explicit port conflicts, an existing proxy, and no-prompt/no-start
behavior. Exercise the selected minimum tools and avoid assuming GNU-only
utilities or docker-group access.

Complete this step only. Update the relevant documentation and focused tests
as part of the implementation. Finish with a summary of changed
behavior/files, verification results, and any unmet acceptance criteria or
blockers for dependent steps.
```

### S3 — Complete the Ghost-CLI export contract and cutover support

Repo: Ghost-CLI, PR #2333 branch. Deps: agreed S1/§2.4 contract. Review the current
export implementation/tests, use raw values in `config`, require the v1 metadata,
test plain-tar extraction, and implement/document deliberate final-export behavior. Review portable snapshot consistency and supported losses.
Use the actual `lib/tasks/import/` implementation as the API reference, not a
nonexistent `lib/tasks/import.js`. Keep the beta warning until qualification.

Acceptance: fixture exports cover MySQL/portable, ordinary restart-on-failure,
intentional leave-stopped cutover, permissions, and configuration round trips.
Run the Ghost-CLI suite and lint; update bundle documentation and command reference.

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository first. Treat the
referenced step, its dependencies, and the architecture contracts as the
requirements for this implementation.

Implement S3 — Complete the Ghost-CLI export contract and cutover support in
the TryGhost/Ghost-CLI repository. Read repository instructions and inspect PR
#2333's claude/ghost-cli-migration-export-c00253 branch and its existing
changes. Preserve unrelated work. Verify the S1 bundle contract is settled
before changing the exporter.

Follow section 2.4 and S3. Make bundle v1 config contain raw flattened string
values, require bundleCreatedAt and sourceInstallType, and update exporter,
bundle docs, and fixtures together. Do not add configValues, legacy
quoted-config decoding, or a sourceEnvironment fallback for mode selection:
this format has not shipped.

Implement deliberate final-export/cutover behavior while preserving ordinary
export restart semantics. Address write-freeze and snapshot consistency for
portable exports; document precisely which data/relationships the portable
format cannot preserve. Use lib/tasks/import/ as the API reference. Keep the
beta warning until qualification.

Test MySQL and portable exports, normal restart-on-failure, intentional
leave-stopped cutover, private bundle permissions, plain-tar extraction on
another host, and actual Compose configuration round trips. Run the Ghost-CLI
test suite and lint.

Complete this step only. Update the relevant documentation and focused tests
as part of the implementation. Finish with a summary of changed
behavior/files, verification results, and any unmet acceptance criteria or
blockers for dependent steps.
```

### S4 — Backup, restore, locks, and recovery journal

Repo: ghost-docker. Deps: S1. Implement the reusable §2.5 checkpoint/restore contract,
explicit DB connection abstraction, operation lock, maintenance handling, retention,
and journals. Backups include required local application/configuration state and
describe optional-service limitations. Define supported backup formats independently
of migration bundles; a portable export is not a lossless recovery checkpoint.

This is where the §2.10 manager image lands (see "When the manager image lands,
and what its first tenant is"). Backup/restore is its first entrypoint, so the
recovery algorithm S7 and S8 reuse exists once, in the image, not in host shell
awaiting a rewrite. Write the host dispatcher here — the `docker run` mount,
identity and exit-code rules from §2.10 — and route backup/restore through it.

With the image and dispatcher built, migrate the **pure** config helpers onto
them: `env.sh` and `meta.sh` become manager-CLI entrypoints (`config get/set/
unset`, `meta ...`), and `caddy_render` moves with them; the bash versions are
deleted, a straight substitution. This is optional to S4's backup/restore
deliverable and may slip to S5 if it competes for review attention, but it is
cheapest here because the image already exists. The helpers that must stay host
shell do not move: preflight, the bootstrap shim and `site.sh check`/doctor
(they run without the image), and `config validate` plus caddy
orchestration (`caddy_validate`/`reload`/`verify`, which answer by asking
`docker compose`). Expect config logic to end up split — `config get/set` in the
manager, `config validate` in host shell — as §2.10 records.

Also add the shared operation lock to installation/reconfigure retroactively:
§2.2 requires install to take it, and S2 deferred it to this step.

Acceptance: restore a representative site to a fresh destination and verify database,
assets/theme/configuration; inject interrupted backup/restore, full disk, stale lock,
and SQL pipeline failure. Recover without exposing an incomplete destination.

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository first. Treat the
referenced step, its dependencies, and the architecture contracts as the
requirements for this implementation.

Implement S4 — Backup, restore, locks, and recovery journal. Read repository
instructions and verify the S1 configuration and metadata interfaces before
implementing their consumers.

Follow sections 2.2 and 2.5 and S4. Provide reusable backup/restore operations
with explicit DB connection and database selection, a shared host-visible
operation lock, maintenance ingress, durable journals, private checkpoint
files, retention, and space checks. Include the required database, content,
configuration, and version/digest metadata. Define how interrupted operations
reconcile actual state and recover stale locks without stealing a live
operation's lock.

Document optional-service state and remote-state limitations. Keep recovery
checkpoints separate from portable migration bundles. Do not claim success or
rollback completion until the destination or restored system has been
verified.

Run a restore drill against a representative disposable site, verifying
database, theme/assets, and configuration. Inject interrupted backup/restore,
full disk, stale lock, and SQL pipeline failures; ensure incomplete restored
sites stay inaccessible.

Complete this step only. Update the relevant documentation and focused tests
as part of the implementation. Finish with a summary of changed
behavior/files, verification results, and any unmet acceptance criteria or
blockers for dependent steps.
```

### S5 — Bundle import and migration cutover

Repo: ghost-docker. Deps: S2, S3, S4. Implement §2.4 and wire `install.sh --import`.
Use a bootstrap helper without dependencies, staged data, the explicit DB target,
isolated portable import, and verified cutover. Support manifest defaults overridden
by flags and deliberate source-restart/recovery instructions.

Acceptance: exercise both bundle kinds produced by the exporter, raw config values,
separate admin URLs, asset/theme/redirect fidelity, partial retries, invalid archives,
and a same-server migration. Verify the documented portable losses. Only then delete
`scripts/migrate.sh` and `scripts/config-to-env.js` and replace their documentation.

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository first. Treat the
referenced step, its dependencies, and the architecture contracts as the
requirements for this implementation.

Implement S5 — Bundle import and migration cutover. Read repository
instructions and verify S2 installer, S3 exporter contract/fixtures, and S4
recovery primitives are available. Consult the Ghost-CLI migration-bundle
document in the exporter branch.

Follow section 2.4 and S5. Implement scripts/import.sh and install.sh --import
using private staging, safe path/link validation, an independent pinned
manifest helper, required v1 metadata, raw config values, explicit target DB
selection, and the exact source Ghost image. Do not support the unpublished
quoted-config draft format.

Handle mysql-dump and isolated authenticated portable imports, explicitly
mount helper scripts, preserve URL/admin overrides, and verify
content/assets/configuration before cutover. Define safe partial retries and
source write-freeze/restart instructions. Rehearsal imports need documented
outbound-side-effect controls. Public ingress must not expose an uninitialized
or partially imported site.

Test real exporter-produced bundles of both kinds, special config values,
separate admin URLs, themes/assets/redirects, retries, invalid archives, and
same-server cutover. Verify portable losses explicitly. Delete
migrate.sh/config-to-env.js only after these replacement fidelity and recovery
gates pass; update all migration documentation.

Complete this step only. Update the relevant documentation and focused tests
as part of the implementation. Finish with a summary of changed
behavior/files, verification results, and any unmet acceptance criteria or
blockers for dependent steps.
```

### S6 — Stack releases, updater, and legacy migration

Repo: ghost-docker. Deps: S1, S2, S4. Implement §2.7, release-please configuration,
beta resolution, bootstrap update instructions, and the transactional migration
framework. Preserve the exact Ghost version across stack updates. Use a stable
updater runtime while replacing the checkout itself.

Acceptance: update from the pre-S1 layout, including existing optional profiles,
custom Caddy routes/overrides, absent metadata, and an untagged starting commit.
Inject failures before/after hooks, pull, and startup; verify complete recovery or an
accurate recovery-required outcome. Test dependency-only release generation.

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository first. Treat the
referenced step, its dependencies, and the architecture contracts as the
requirements for this implementation.

Implement S6 — Stack releases, updater, and legacy migration. Read repository
instructions and verify S1, S2, and S4 interfaces and recovery behavior before
implementing stack updates.

Follow section 2.7 and S6. Configure release-please and stable/beta version
resolution, including explicit dependency-only patch releases. Implement
update.sh and a bootstrap path for installations where that script does not
exist. Stack updates preserve the exact Ghost pin and reject incompatible
upgrade ordering.

Run the updater from a stable location while replacing the checkout. Record
the previous commit SHA, acquire the operation lock, snapshot
configuration/metadata, journal pre/post-checkout migrations, validate
Compose/Caddy, and verify readiness. Restore code and configuration together
on safe failures; stateful schema changes require the applicable checkpoint
recovery or an accurate recovery-required state.

Cover pre-S1 installs with absent or existing analytics/activitypub profiles,
untracked custom Caddyfiles, Compose overrides, absent metadata, and untagged
starting commits. Preserve custom routes. Test skipped releases, repeated
hooks, dependency-only releases, and failures during hooks/pull/startup with
complete recovery verification.

Complete this step only. Update the relevant documentation and focused tests
as part of the implementation. Finish with a summary of changed
behavior/files, verification results, and any unmet acceptance criteria or
blockers for dependent steps.
```

### S7 — Host-driven Ghost upgrades

Repo: ghost-docker. Deps: S4 and S6 compatibility rules. Implement `scripts/upgrade.sh
[version|latest]` following §2.5, initially without a supervisor. Specify the reusable
execution interface so the supervisor cannot diverge from backup/recovery behavior.
Keep supported majors/downgrades constrained and feature compatibility explicit.

Acceptance: upgrade across an actual database migration, verify optional analytics
sync/deploy, inject startup failure after migration, and restore the checkpoint.
Test process interruption at each mutation boundary, two concurrent requests, and
refusal of unsupported transitions. A live database restore drill is a release gate.

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository first. Treat the
referenced step, its dependencies, and the architecture contracts as the
requirements for this implementation.

Implement S7 — Host-driven Ghost upgrades. Read repository instructions and
verify S4's tested checkpoint/restore primitives and S6's
compatibility/version rules are available.

Follow section 2.5 and S7. Implement scripts/upgrade.sh [version|latest] and a
reusable execution interface that S8 can invoke without duplicating recovery
logic. Acquire the shared site lock, resolve an exact supported image, pull
before downtime, enforce a verified checkpoint, freeze writes, journal
mutations, and verify readiness before resuming traffic. Reject unsupported
major changes and arbitrary downgrades.

Support the defined per-site optional-service sequence, including Tinybird
sync and deploy. Detect unsupported remote-schema recovery combinations during
preflight. Image reversion alone is not database rollback: restore and verify
the checkpoint before reporting rolled-back, otherwise retain maintenance and
report recovery-required.

Exercise an actual database migration, failed startup after migration, a
verified restore, interruption at mutation boundaries, concurrent requests,
and unsupported transitions. Do not add the supervisor or Admin feature in
this step.

Complete this step only. Update the relevant documentation and focused tests
as part of the implementation. Finish with a summary of changed
behavior/files, verification results, and any unmet acceptance criteria or
blockers for dependent steps.
```

### S8 — Supervisor image, protocol, and installer integration

Repo: ghost-docker. Deps: S7. Write `docs/upgrade-supervisor.md` with the exact §2.6
schemas, transitions, ownership, policy, and recovery rules, then implement the
supervisor with a supported Node runtime and minimal dependencies. Reuse S7 behavior.
Wire `--with supervisor`, request submission/status tooling, and pinned image versions.
Publish amd64/arm64 images to approved registries through CI.

Acceptance: handwritten requests work before Ghost gains an adapter; duplicate and
malformed requests, permission violations, stale status, supervisor crashes, and
host-operation conflicts behave correctly. Verify actual exchange permissions as
Ghost's runtime uid. Installer must not enable an incompatible Ghost adapter.

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository first. Treat the
referenced step, its dependencies, and the architecture contracts as the
requirements for this implementation.

Implement S8 — Supervisor image, protocol, and installer integration. Read
repository instructions and verify S7 exposes a tested reusable
upgrade/recovery interface.

Follow section 2.6 and S8. First write docs/upgrade-supervisor.md with exact
versioned JSON schemas, transitions, host policy, exchange ownership/mount
layout, durability, request claiming/deduplication, stale status, retention,
and interrupted-job recovery. Then implement the supervisor and container
packaging using S7's operation contract. Use the same site lock as host
operations. Keep Docker socket authority and supported context/path/uid
behavior explicit.

Wire install.sh --with supervisor, request/status tooling, pinned image
versions, and amd64/arm64 image publishing CI. Enable FileDropUpgradeAdapter
only on compatible Ghost versions with an initialized exchange; manual request
submission must work before the Ghost integration lands. Use strict target
validation and argument-array subprocesses.

Test successful requests, duplicates/malformed files, permissions as Ghost's
actual uid, stale status, supervisor crashes, host-operation conflicts, and
recovery. Ghost must not be able to replace supervisor-owned status/job files
through a writable parent.

Complete this step only. Update the relevant documentation and focused tests
as part of the implementation. Finish with a summary of changed
behavior/files, verification results, and any unmet acceptance criteria or
blockers for dependent steps.
```

### S9 — Ghost upgrade adapter and Admin API

Repo: Ghost core. Deps: S8 protocol contract. Follow repository adapter/API guidance.
Implement `NoopUpgradeAdapter` and `FileDropUpgradeAdapter`, permission-checked status/
request/job APIs, rate limiting, capability reporting, and update-notification metadata.
Noop is default; missing/stale supervisor and malformed protocol data produce useful
status without making unrelated Ghost startup depend on supervisor availability.

Acceptance: adapter/controller tests, API permission tests, tmp-exchange protocol
tests, version compatibility, and initialization ordering. Keep Admin UI separate.

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository first. Treat the
referenced step, its dependencies, and the architecture contracts as the
requirements for this implementation.

Implement S9 — Ghost upgrade adapter and Admin API in the TryGhost/Ghost
repository. Read repository and subsystem instructions, including the relevant
Admin API skill, and verify S8's versioned protocol contract is available in
the Docker repository's docs/upgrade-supervisor.md.

Follow section 2.6 and S9. Add the upgrade adapter type with
NoopUpgradeAdapter as the default and FileDropUpgradeAdapter as the canonical
file-exchange implementation. Implement status, request creation, and job
retrieval using the agreed schemas and normal Ghost owner/admin authorization,
rate limiting, and error conventions. Add capability/update-notification
metadata for the later Admin UI.

Handle pending/unknown jobs, malformed data, stale or absent supervisors, and
protocol mismatches deliberately. Supervisor availability must not become a
dependency for unrelated Ghost startup. Respect host-controlled policy rather
than letting request input waive backups or compatibility restrictions.

Add adapter/controller, permissions, initialization, and temporary-exchange
protocol tests. Keep Admin UI changes for S10 and verify the canonical adapter
names match configuration, documentation, and the supervisor installer.

Complete this step only. Update the relevant documentation and focused tests
as part of the implementation. Finish with a summary of changed
behavior/files, verification results, and any unmet acceptance criteria or
blockers for dependent steps.
```

### S10 — Admin update experience

Repo: Ghost Admin. Deps: S9. Add the current-version/available-update panel using the
repository's current React/Shade and API conventions. Feature-detect older backends,
show host capabilities, confirm downtime/backup behavior, and display durable job
progress with bounded reconnection and recovery guidance. Wire notification links.

Acceptance: older backend, unsupported adapter, owner/admin permissions, successful
restart/reconnect, queued job, stale supervisor, failed restore, and recovery-required
states. Include an integration test with the real supervisor after mocked UI tests.

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository first. Treat the
referenced step, its dependencies, and the architecture contracts as the
requirements for this implementation.

Implement S10 — Admin update experience in the TryGhost/Ghost repository. Read
the current Admin/React/Shade/API instructions and verify S9's endpoints and
capabilities before building the UI.

Follow section 2.6 and S10. Add the current/available Ghost version panel,
host capability handling, update confirmation, job progress, and notification
links using established Admin conventions. Feature-detect missing endpoints on
older backends as well as an unsupported adapter. Backup/downtime promises
must reflect the host-enforced policy.

Persist enough job identity to resume progress after Ghost restarts. Use
bounded reconnection/backoff and distinguish queued, stale, failed, restoring,
rolled-back, and recovery-required outcomes with useful operator guidance. Do
not treat every 404 as an indefinitely restarting service.

Test older backends, unsupported adapters, owner/admin permissions, successful
restart and reconnect, queued requests, stale supervisors, failed restores,
and recovery-required states. Include a real supervisor integration scenario
after the focused mocked UI tests.

Complete this step only. Update the relevant documentation and focused tests
as part of the implementation. Finish with a summary of changed
behavior/files, verification results, and any unmet acceptance criteria or
blockers for dependent steps.
```

### S11 — Optional file-based secrets

Repo: ghost-docker. Deps: S1 and the credential consumers in S4-S8. Add Compose secret
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

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository first. Treat the
referenced step, its dependencies, and the architecture contracts as the
requirements for this implementation.

Implement S11 — Optional file-based secrets. Read repository instructions and
inspect the existing S1 configuration split and credential consumers in S4–S8
before changing credential transport. This is optional hardening, not a new
requirement for every installation.

Follow section 2.2 and S11. Add private Compose secret files and _FILE wiring
only for verified compatible Ghost images. Preserve supported
environment-based operation for existing installs and imports of older Ghost
images; never rotate initialized MySQL credentials accidentally during
conversion.

Update MySQL initialization, healthchecks, ActivityPub, backup/import/restore
helpers, and supervisor consumers together. Verify each service's actual
file-secret support and runtime uid/read permissions rather than assuming
MySQL conventions apply to all.

Test migration, restart, restore, supported file-enabled services, and
older-image imports. Confirm root credentials never enter Ghost's environment
and file-enabled services do not expose their resolved secrets there. Document
remaining service-specific limitations and compatibility boundaries.

Complete this step only. Update the relevant documentation and focused tests
as part of the implementation. Finish with a summary of changed
behavior/files, verification results, and any unmet acceptance criteria or
blockers for dependent steps.
```

### S12 — Single-site release qualification and documentation

Repo: ghost-docker, with cross-repo fixtures. Deps: S1-S10; include S11 if shipping.
Consolidate CI and qualify the actual minimum supported tools and image versions.
Run fresh local/production install, optional-service variants, CLI migration,
legacy stack update, Ghost upgrade/recovery, supervisor/Admin, and restore scenarios.
Include Linux runtime tests and macOS-compatible shell/configuration checks.

README/help include quick starts, prerequisites, version/compatibility policy,
backup/restore, migration losses and cutover, custom proxy configuration, diagnostics,
and uninstall. Document deletion of bind-mounted data separately from `down -v`, with
explicit recovery consequences. Explain command equivalences without claiming full
CLI parity for unsupported features. Keep shared infra marked deferred.

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository first. Treat the
referenced step, its dependencies, and the architecture contracts as the
requirements for this implementation.

Implement S12 — Single-site release qualification and documentation, using the
Ghost-CLI and Ghost repositories for cross-repo fixtures/integration as
needed. Read repository instructions and verify S1–S10 are implemented;
include S11 qualification only if it is part of the release.

Follow S12 and the acceptance contracts throughout the plan. Consolidate CI
around the actual supported minimum/current tools and image versions. Exercise
fresh local and production installation, optional services, CLI bundle
migration, existing-stack update, Ghost upgrade and recovery, supervisor/Admin
interaction, and a real restore drill. Include Linux runtime checks and
macOS-compatible shell/configuration checks.

Finish README/help and operational documentation covering version policy,
custom proxies, migration fidelity/cutover, backup/restore, diagnostics, and
uninstall. Explain bind-mounted data deletion separately from down -v, and do
not claim unsupported CLI parity. Keep shared infra explicitly deferred to
S13.

Resolve qualification defects within this release scope. Report the tested
matrix and any remaining release blockers with evidence; do not infer
readiness from successful happy-path installs alone or start the optional
shared-infra phase.

Complete this step only. Update the relevant documentation and focused tests
as part of the implementation. Finish with a summary of changed
behavior/files, verification results, and any unmet acceptance criteria or
blockers for dependent steps.
```

### S13 — Optional shared Caddy/MySQL infrastructure

Repo: ghost-docker. Deps: S12. Only now introduce `infra` and `site` modes and
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

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository first. Treat the
referenced step, its dependencies, and the architecture contracts as the
requirements for this implementation.

Implement S13 — Optional shared Caddy/MySQL infrastructure. Read repository
instructions and verify S12's single-site qualification is complete before
expanding the architecture.

Follow all S13 design requirements and the existing backup/upgrade/config
contracts. Add dedicated infra/site modes and --infra-only/--infra
provisioning, revisiting profile dependencies and globally required variables.
ActivityPub, traffic analytics, and Tinybird deployment jobs remain per-site;
do not add shared versions of them.

Use unique restricted DB identities, explicit DB targets, unambiguous service
aliases, and deliberate private/shared networks. Integrate registration locks,
duplicate checks, validated Caddy reload, recoverable provisioning, and safe
site-scoped removal. Ensure site backup/restore/supervisor operations cannot
affect another site's databases or require its supervisor to hold infra root
credentials. Define infra capacity, version, and maintenance policy. Persist
any required Compose file selection consistently.

Default to dedicated infra. If offering conversion or private DB opt-in,
implement and test their complete data/volume/recovery paths rather than just
changing profiles. Test two Ghost versions with per-site optional services,
isolated upgrade/restore/purge, concurrent registration, route/asset
separation, infra outages, and partial failures. Document unsupported
combinations and the infrastructure-wide maintenance impact.

Complete this step only. Update the relevant documentation and focused tests
as part of the implementation. Finish with a summary of changed
behavior/files, verification results, and any unmet acceptance criteria or
blockers for dependent steps.
```

### S14 — Dual-published service images and registry selection

Repos: ghost-docker plus the traffic-analytics and ActivityPub publishing repositories.
Deps: S12; independent of S13. Follow §2.9. Publish traffic-analytics, ActivityPub, and
ActivityPub migrations to both Docker Hub and GHCR, then add
`install.sh --image-registry dockerhub|ghcr` and a documented registry-switch operation.
Persist full image identities and registry choice; apply it consistently to upgrade,
stack update, recovery, and supervisor flows. Preserve historical mixed registry
locations until a site explicitly switches. Do not broaden the flag to unmirrored
third-party images.

Acceptance: both registries serve equivalent releases on supported architectures;
partial publication is not advertised as complete; unauthenticated public pulls work;
select/install/update/restore and same-version registry switches succeed. Exercise
missing artifacts, unavailable registries, and ActivityPub app/migration version
alignment. Confirm switches do not mutate application data or upgrade versions.

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository, especially section 2.9
and S14. Implement S14 here and in the actual traffic-analytics/ActivityPub
image publishing repositories. Read each repository's instructions and inspect
its release workflows before editing. Verify S12 is complete; S13 is not
required.

Add dual publishing to Docker Hub and GHCR from one tested release build,
covering traffic-analytics, ActivityPub, and ActivityPub migrations. Resolve
actual repository names/permissions and publish matching versions/platforms
with verified identities. Define how partial publication is handled before
releases are advertised.

Add --image-registry dockerhub|ghcr, durable registry/image settings, and an
explicit same-version switch workflow. Default new eligible installs to Docker
Hub after both registries are ready; preserve existing image locations on
updates. Carry the selected references through Compose, updater, supervisor,
backup, and recovery. The flag covers these services only; nightly Ghost
remains GHCR-only and third-party images retain their declared registries. Do
not add silent fallback to another registry.

Test both registries/platforms, public pulls, missing/partial artifacts,
same-version switches, data preservation, app/migration alignment, and
restore. Update help/docs and report implementation changes, validation, and
any unmet acceptance criteria. Implement this step only; do not begin nightly
or Redis work.
```

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

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository, especially section 2.9
and S15. Implement S15 in the verified Ghost image publishing workflow and
here, with targeted Ghost upgrade API/Admin changes if required. Read
repository instructions and inspect the S14 image resolver and S7-S10 upgrade
integration before changing them.

Publish opt-in Ghost nightlies to the agreed GHCR repository with immutable
tags, source commit/build metadata, supported architecture manifests, and
clear retention. Add --ghost-channel stable|nightly; stable is default.
Persist the Ghost channel separately from the stack stable/beta channel and
service image registry choice. Resolve discovery tags to exact builds/digests
and use that artifact for tinybird-sync.

Extend discovery/status/job data to distinguish builds that report identical
semver. Maintain trusted repository allowlists, host major policy, mandatory
production checkpoints, and database-aware recovery. Show channel/build
identity to operators. Require explicit compatible channel transitions;
returning to stable may require a later compatible release or checkpoint
restore. Channel selection does not authorize automatic background upgrades.

Test stable isolation, explicit opt-in, consecutive same-semver builds, GHCR
failures, architecture coverage, sync-image consistency, channel transitions,
and recovery after a migrated nightly fails. Update docs/tests and report
remaining blockers. Complete S15 only; do not start Redis implementation.
```

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

**Implementation prompt**

```text
Read docs/ghost-cli-replacement.md in this repository, especially section 2.9
and S16. Implement S16 here. Read repository instructions and verify S12 plus
the installer/configuration, backup/upgrade, and secret interfaces. S13-S15
are not prerequisites.

Add a pinned, private per-site Redis service and enable its profile by default
on new local and production installs. Implement --without redis and a
documented existing-site enable/disable migration that preserves operator
cache overrides. Configure the Redis adapter/cache features actually supported
by each selected Ghost image, using
docs/codebase/internal-caching.md in the TryGhost/Ghost repository and the
corresponding adapter code as references; verify older image compatibility.

Define credentials, healthchecks, startup ordering, bounded memory/eviction,
optional cache persistence, runtime failure/reconnect behavior, and
invalidation on restore or upgrade. No host port is published. Disabling Redis
must revert the generated Ghost configuration too. Do not silently change an
existing site's cache backend on update or promise runtime fallback without
verifying Ghost's implementation.

Initially treat Redis as rebuildable Ghost cache. Document extension points
for future analytics/ActivityPub consumers, but do not invent their
configuration or mix durable state into an evictable cache instance. Different
durability/eviction requirements need separate state policy and, where
appropriate, separate instances.

Test default installs, opt-out, existing-site migration/overrides, actual
cache use, restart/outage, resource limits, secrets, upgrade/restore, and
older Ghost versions. Test site isolation if shared infra is present. Update
help/docs and report changed behavior, verification, and unmet acceptance
criteria. Complete this step only.
```

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
