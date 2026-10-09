# Roadmap: replacing Ghost-CLI for Docker installations

This document describes remaining work, not implemented interfaces. Add commands and
options only when their step ships. Current usage is in [install.md](install.md), and
current invariants and code ownership are in [architecture.md](architecture.md). When a
step lands, update those documents and remove its completed requirements here.
Scheduling and issue status belong in [the project in
Linear](https://linear.app/ghost/issue/PLA-412).

## Delivery dependencies

| Outcome | Remaining work | Dependencies |
| --- | --- | --- |
| Tagged single-site production | S6b legacy-layout migration, S5e production import, S12 qualification | Existing image self-update, local import, backup and restore |
| Several sites behind shared Caddy | S13 | Existing backup/restore; S6b for converting existing sites |
| Admin-driven Ghost upgrades | S7 host upgrade, S8 supervisor, S9 core adapter/API, S10 Admin | S7 before supervisor execution; S8 protocol before S9; S9 before S10; S13 integration if shipped |
| Later extensions | S11 file secrets, S14 service references, S15 nightlies, S16 Redis | See each step |

Qualify production on Linux with rootful Docker Engine. Local qualification also covers
Docker Desktop, OrbStack and WSL2. Rootless Docker is best effort, not part of the
supported qualification matrix. Daily start, stop and logs stay with Compose. Stack
self-update remains image-only; checkout operators use Git and Compose and retain
backup/restore. Automatic major Ghost/MySQL upgrades and arbitrary downgrades are
outside the planned scope.

### S5e — Production import and cutover

Repo: ghost-docker. `install --import` takes production bundles and the cutover is
documented in [install.md](install.md#moving-a-production-site). Remaining:

Bound expansion and check space for extracted content and the database restore;
compressed archive size times 1.5 is insufficient. Do not guess ownership as uid
1000 under rootless/user namespaces.

Acceptance, on Linux with rootful Docker Engine and a real Ghost-CLI production
install (MySQL, systemd, nginx): same-server and cross-host moves following the
documented steps; a forced import failure leaving the directory as it was, with the
documented recovery bringing back the source and nginx; a separate admin domain
carried from the bundle; exact source version, staff sign-in, records, active theme,
assets, redirects and configuration preserved. This replaces `main`'s
`scripts/migrate.sh`; S12 must not merge `next-docker` into `main` before these
scenarios pass.

### S6b — Migration from the released main layout

Repo: ghost-docker. Depends on image self-update and backup/restore. This migration
remains required regardless of the development-format [compatibility
policy](architecture.md#compatibility), and gates merging into `main`.

Implement ordered release migration scripts, recording completion in metadata when the
first migration needs that field. `0001-compose-profiles` must:

- Handle both absent profiles and existing `analytics,activitypub`, adding
  `production`; preserve credentials and project identity.
- Split Ghost application configuration into `ghost.env`, keeping operator
  settings in `.env`; add `SITE_MODE`, `URL`, `PROJECT_DIR` and an exact pin for
  the currently running Ghost version.
- Preserve the existing untracked Caddyfile before managed files are written.
  Custom routes must still work with snippets that take explicit upstream and
  domain arguments. Preserve supported customizations automatically, or stop
  before changing the live site and explain what must be resolved.

Existing installations have no launcher or metadata. The entry point is the served
launcher from inside the installation (`curl -fsSL https://docker.ghost.org/install.sh |
bash -s -- self-update`), not a raw `git pull` across the breaking change. This is a
migration of the released layout, distinct from self-update of a current `source:
checkout` site.

Acceptance: absent metadata, an untagged starting commit, existing optional profiles,
custom Caddy routes and Compose overrides, skipped releases, repeated invocation and
failed hooks. Failures during migration, pulling or startup must follow the [recovery
boundary](architecture.md#recovery) and report the observed state accurately, retaining
any writes after startup.

### S7 — Host-driven Ghost upgrades

Repo: ghost-docker. Depends on backup/restore and release compatibility. Implement
`./ghost-docker update [version|latest]` following the [recovery
invariants](architecture.md#recovery), initially without a supervisor. Specify the
reusable execution interface so the supervisor cannot diverge from backup/recovery
behavior. Keep supported majors/downgrades constrained and feature compatibility
explicit.

Take the site lock, resolve and pull one exact target image of the same major before
stopping the site, pause writers and capture a checked backup. Update the Ghost pin and
metadata together. Start with `up --wait` and verify ingress; Ghost runs its own
migrations at boot. Recovery follows the startup boundary linked above: switching an
image back does not reverse migrations. Going back to an older version later requires a
deliberate restore.

Acceptance: upgrade across a real database migration, with the analytics sync and deploy
run; a target that fails after startup leaves every accepted write intact and reports
`needs-operator`, with its backup and recovery choices; an early failure restores the
previous files and resumes the paused writers; a concurrent second request is refused by
the lock; another major and a downgrade are refused.

### S8 — Supervisor command, protocol, and installer integration

Repo: ghost-docker. Deps: S7, S9; S13 if it has shipped. Write
`docs/upgrade-supervisor.md` with the exact schemas, transitions, ownership, policy, and
recovery rules below, then implement the supervisor as a long-running command of the
manager image. Reuse S7 behavior. Wire `--with supervisor` and request submission/status
tooling. Scope: one active job, durable status, `interrupted` for work found unfinished,
a 20-job history; no queue and no resuming.

Acceptance: handwritten requests work before Ghost gains an adapter; duplicate and
malformed requests, permission violations, and stale status behave correctly; a request
while a job is active, or while the CLI holds the lock, is refused; a supervisor killed
mid-job reports that job `interrupted` on its next start, with its backup, and leaves
the lock for the operator; history stays within its bound. Verify actual exchange
permissions as Ghost's runtime uid. Installer must not enable an incompatible Ghost
adapter.

#### Supervisor protocol requirements

The supervisor is a command of the manager image, enabled per site; it is not a second
image. The Docker socket is host-privileged; non-root process execution does not remove
that authority. The host operator explicitly enables self-upgrades and controls policy.
Ghost owner/admin authorization permits requests only within that host-defined policy.

The supervisor sees the site directory at the same absolute host path for Compose bind
resolution. Define supported local Docker contexts and socket paths; reject remote
daemons or unsupported rootless setups clearly. Avoid broad writable mounts beyond what
execution requires. Supervisor behavior follows [recovery
invariants](architecture.md#recovery) rather than inventing a second upgrade/recovery
algorithm.

**Execution.** The supervisor is the host
command run on Ghost's behalf, not a job system: the same executor as
`./ghost-docker update` (S7) and the shared recovery rules, with a file exchange in
front of it. So it has:

- **One active job.** A job starts only when no job is active and the
  site lock is free. A request that arrives while one is active, or while the
  CLI holds the lock, is claimed and refused at once (`refused`, naming what
  holds the site), as the CLI refuses a second operation. There is no queue:
  Admin shows the active job and offers the request again when it ends.
- **Durable status.** Every stage boundary of a job, and the supervisor's
  heartbeat, is written atomically to its own file before the side effect
  that follows it. That record is all the journal there is: it says where a
  job stopped and which backup it took, and nothing replays it.
- **An explicit interrupted state.** A job the supervisor finds unfinished when
  it starts (it, Docker or the host was stopped mid-job) is marked
  `interrupted`, with the stage it reached, the backup's path and the lock it
  left. It is never resumed or retried: what the executor had done is exactly
  what a crashed CLI operation leaves, and the operator resolves it the same
  way, with `check` and then `restore` or the command again. The lock stays
  held until then, so no new job starts over a half-changed site.
- **Bounded history.** The active job and the 20 most recent finished ones are
  kept, so Admin can show the last outcome after a restart; older job files
  are removed when a new request is claimed. That is the whole retention rule.

Outside this scope: queues, more than one job, resuming or retrying interrupted work,
scheduled or unattended upgrades, and configurable retention. Each would need a
requirement the above cannot meet.

The protocol document must replace these design requirements before either side is
implemented. It must include:

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
- Job states and their legal transitions: the executor's stages (backing-up,
  pulling, restarting, verifying, restoring), then one final state: `done`,
  `restored`, `needs-operator` (automatic recovery is unsafe or failed; the backup's path and what to do), `refused` (policy, lock, another active job, or a malformed request) or
  `interrupted` (found unfinished on start). No queued state.
- UUID validation, bounded file sizes, no symlink following, exclusive request
  claiming (an atomic rename, so one request is claimed once and a duplicate
  ID is refused), the interrupted-on-start rule, the 20-job history bound, and
  polling backoff.
- Separate request-write and status/job-read permissions for Ghost. A shared writable
  parent directory must not let Ghost replace supervisor-owned status or job files.
  Define initialization/uid ownership and mount layout explicitly.
- A POST can return
  an accepted job ID before the supervisor claims it; distinguish pending, unknown,
  expired, stale supervisor, and protocol mismatch rather than treating all 404s as
  a restart indefinitely.
- Strict target allowlisting, argument-array subprocess invocation, no shell input,
  host-enforced major/backup policy, and the shared site operation lock.

Version discovery must handle registry pagination, rate limits, stale cache, semver
ordering, image architecture, and compatibility requirements. A valid Docker tag alone
is not evidence that an upgrade path is supported.

### S9 — Ghost upgrade adapter and Admin API

Repo: Ghost core. Deps: S8 protocol contract. Follow repository adapter/API guidance.
Implement `NoopUpgradeAdapter` and `FileDropUpgradeAdapter`, permission-checked status/
request/job APIs, rate limiting, capability reporting, and update-notification metadata.
Noop is default; missing/stale supervisor and malformed protocol data produce useful
status without making unrelated Ghost startup depend on supervisor availability.

Acceptance: adapter/controller tests, API permission tests, tmp-exchange protocol tests,
version compatibility, and initialization ordering. Keep Admin UI separate.

Use adapter type `upgrade` and enable FileDrop only for a compatible Ghost version and
an initialized exchange. API endpoints are status, create request and fetch job;
owner/admin only, with a rate-limited POST and normal Admin auth.

### S10 — Admin update experience

Repo: Ghost Admin. Deps: S9. Add the current-version/available-update panel using the
repository's current React/Shade and API conventions. Feature-detect older backends,
show host capabilities, confirm downtime/backup behavior, and display durable job
progress with bounded reconnection and recovery guidance. Wire notification links. Show
the status's two update lists ([protocol
requirements](#supervisor-protocol-requirements)): one-click updates with an action, and
manual ones as a notice with their reason and host steps, such as a stack update to run
with `./ghost-docker self-update`.

Acceptance: older backend, unsupported adapter, owner/admin permissions, successful
restart/reconnect, a refused request while another job runs, stale supervisor, recovery
requiring the operator (`needs-operator`), and `interrupted` states. Include an
integration test with the real supervisor after mocked UI tests.

Feature-detect both absent endpoints on older cores and `supported: false`. UI backup
promises must match the actual enforced policy.

### S11 — Optional file-based secrets

Repo: ghost-docker. Deps: the credential consumers in backup, import, restore and S7-S8.
Add Compose secret files and `_FILE` wiring only for Ghost versions known to support it.
Importing older Ghost 6 images must still work via their supported credential mechanism.
Migrate without changing existing initialized MySQL credentials accidentally.

Update MySQL init scripts, healthchecks, ActivityPub, backup/import/restore helpers, and
supervisor consumers together. Do not assume ActivityPub supports MySQL image `_FILE`
conventions. Set file ownership/readability for actual container users; host mode 0600
alone does not guarantee container access.

Acceptance: root credentials remain absent from Ghost regardless of this feature;
file-enabled supported services do not expose their secret values in environment; legacy
environment-based installs, older imports, restart, and restore still work.

### S12 — Single-site release qualification and documentation

Repo: ghost-docker, with cross-repo fixtures. Deps: S5e and S6b, plus existing install,
backup/restore and self-update; qualify S13, S7-S10 and S11 when they have shipped.
Gates the first stable tag and merging `next-docker` into `main`. Include the launcher
on Linux, macOS and WSL2. Consolidate CI and qualify the actual minimum supported tools
and image versions. Run fresh local/production install, optional-service variants, CLI
migration, legacy stack update, Ghost upgrade/recovery, supervisor/Admin, and restore
scenarios. Include Linux runtime tests and macOS-compatible shell/configuration checks.
Record the [compatibility baseline](architecture.md#compatibility): the exact metadata
schema, backup format, launcher contract and bundle versions the stable release
supports, and the obligations that hold for them from then on.

README/help include quick starts, prerequisites, version/compatibility policy,
backup/restore, migration losses and cutover, custom proxy configuration, diagnostics,
and uninstall. Document deletion of bind-mounted data separately from `down -v`, with
explicit recovery consequences. Explain command equivalences without claiming full CLI
parity for unsupported features. Describe shared infra according to whether S13 has
shipped.

### S13 — Optional shared Caddy

Repo: ghost-docker. Depends on backup/restore for new member sites; converting an
existing site into a member (PLA-504) also needs S6b. Several sites on one server, as
Ghost-CLI ran several sites behind one nginx. 80 and 443 can belong to one Caddy only,
so that Caddy is shared; everything else stays per site, MySQL included, so backup,
restore, upgrade and import are unchanged.

- `install --infra` sets up the shared Caddy once: a Compose project of its own,
  with an external network each member site's Ghost (and optional services) also
  joins. Infra-only configuration must resolve without a Ghost `URL`; review
  required-variable guards and the profile validation when adding this mode. `install --domain` on a server that has it adds the site as a member
  instead of starting a Caddy of its own.
- Each member's routes are a file in the shared Caddy's `sites/` directory,
  written once by its install and then the operator's, as for a single-site install. Upstreams are
  the member's unique aliases, described in [configuration.md](configuration.md#service-names-on-the-network).
- `list` shows the members; removing a site removes its routes file.
- Ghost publishes on loopback as before, so a member can still be reached
  without Caddy.

Acceptance: a shared Caddy with two members on different Ghost versions, each with its
own optional services; upgrading, restoring or removing one leaves the other untouched;
a duplicate domain is refused; a Caddy restart brings both back.

### S14 — Service images as full references

Repo: ghost-docker. Deps: S12; independent of S13. Give every service a full,
registry-qualified reference behind an `.env` variable, pinned by the release with its
digest. `config set` selects a mirror or another registry. There is no registry selector
or separate registry state: the reference is the choice.

Publishing the Tinybird helpers as images belongs here, as references like the rest.

Acceptance: a site with ActivityPub and its migration image overridden to another
registry installs, updates its stack (keeping the overrides), backs up and restores with
the overridden references recorded exactly; an unreachable registry or a missing
architecture fails naming the reference, with no fallback; a reference without a digest
is recorded with the one it resolved to; and an override whose image declares another
version is reported by `check`. ActivityPub's app and migration references stay aligned,
or `check` says they are not.

The manager never rewrites a reference to another registry or falls back to one.
Unavailable registries and missing architectures fail clearly, naming the reference.

Extend metadata to record every pulled reference and resolved digest; the backup
manifest already records each service's resolved reference and running image identity. A
reference without a digest is resolved to one when it is pulled, and that digest is what
is recorded. A different registry is a different reference whose digest is checked,
never assumed equal to the first. Changing a service's reference is a configuration
change, not an upgrade: `check` reports the version the image declares, and an override
that moves a service to another version is the operator's choice, made visible, never
the manager's. Stack updates keep a site's overrides (`.env` is the operator's), and
backup, restore and the supervisor use whatever references the site resolves. Public
pulls must work without credentials; dual publishing upstream is welcome but is not a
ghost-docker requirement.

### S15 — Opt-in Ghost nightly channel on GHCR

Repos: Ghost/image publishing workflow and ghost-docker; Ghost Admin/API if channel or
build metadata requires extending the existing upgrade interface. Deps: S14 image
references and existing S7-S10 upgrade integration. Follow the requirements below. Add
`--ghost-channel stable|nightly`, with stable as default and nightly explicitly opted
in. Nightly images are published to GHCR with immutable source/build identities. Keep
the stack `--channel` independent and do not equate nightly selection with unattended
upgrades.

Acceptance: stable installs never select nightlies; opt-in resolves an exact GHCR build
on supported architectures; successive builds with identical Ghost semver are
distinguishable; tinybird-sync uses the selected Ghost artifact. Exercise discovery
failure, missing images, host major-policy enforcement, backup/recovery, and explicit
channel transitions. Nightly-to-stable must refuse unsafe schema transitions rather than
pretending that image selection rolls back the database.

Publish from an identified source commit, with immutable build tags/metadata and an
optional moving nightly discovery tag. Installation/upgrade resolves discovery to one
exact build and digest; never persist only a moving tag. Use the same Ghost image for
tinybird-sync. Record the Ghost-reported version plus commit/build identity: two nightly
builds may report the same semver. Build discovery and job schemas must handle that
deliberately, without relaxing trusted image allowlists to arbitrary user-supplied
references.

Only nightly sites discover nightly updates. Enabling the channel does not bypass host
major-version policy, backups, writer pauses, compatibility checks, or recovery.
Stable-to-nightly and nightly-to-stable are explicit compatibility-checked transitions;
returning to stable may require waiting for a compatible release or restoring a
checkpoint because schema migrations cannot be undone by changing a tag. Retain exact
recovery images/build metadata even if registry retention removes old nightly tags. Show
the channel and build identity in CLI/status/Admin where applicable.

### S16 — Opt-in per-site Redis caching

Repo: ghost-docker, verifying behavior against supported Ghost versions. Deps: S12 and
existing configuration, installer, backup, upgrade, and secret interfaces; independent
of S13-S15. Follow the requirements below. Add `install --with redis` and the `redis`
profile for existing sites, with the service, version-aware Ghost cache wiring, private
network, healthchecks, credentials, resource policy, diagnostics, and enable/disable
steps. Keep Redis per-site even when shared infra exists. Default installs are
unchanged.

Measure before proposing a default: memory and start-up cost of the extra service, and
Ghost's response times with and without it, on a local install and a small production
site, on supported Ghost versions. Link the measurements from the proposal; a default
for production, and separately for local installs, is a later decision made from them.

Acceptance: `--with redis` installs, local and production, use Redis; default installs
start no Redis and behave as before; enabling and disabling it on an existing site keeps
operator overrides. Verify real cache reads/writes and invalidation, resource limits,
restart/outage/reconnect, upgrade/restore behavior, secret handling, and supported Ghost
version coverage. If S13 has shipped, verify two sites do not share cache data or expose
Redis through the shared ingress network. Specify cache rebuilding/persistence behavior
explicitly. Do not wire speculative traffic-analytics/ActivityPub consumers until their
released interfaces exist and their cache-versus-durable-state requirements are
established.

Ghost's in-memory cache remains the default. A default Redis would cost every site an
extra container; separate evidence is needed for production and local defaults, as
described above.

Use a pinned supported Redis image, private site networking with no published host port,
healthchecks, bounded memory, defined eviction/persistence settings, and credentials
handled through the established secret/config interfaces. Configure the actual cache
features and adapter schema supported by the selected Ghost image; review
`docs/codebase/internal-caching.md`, the built-in Redis adapter, and [Ghost's cache
documentation](https://docs.ghost.org/config#cache-adapters). Do not assume every older
supported image accepts the same cache configuration. Incompatible images must use a
documented supported configuration or fail preflight with the opt-out path, rather than
producing a broken default install.

For existing sites, document enabling it: add the profile, which the manager wires into
Ghost's cache configuration, preserving operator cache overrides and exact image pins.
Routine stack updates must not unexpectedly switch an existing cache backend. Disabling
Redis must also remove/revert generated cache configuration; do not stop it while
leaving Ghost pointed at it. Define/test startup ordering, runtime outage behavior,
reconnects, cache invalidation after upgrade/restore, and the effect of opting out. Do
not promise automatic runtime fallback unless the selected Ghost implementation actually
provides it.

Initial Redis use is rebuildable Ghost cache data. Explicitly document whether it is
persisted for warm restarts and whether backups exclude/rebuild it. Potential later
traffic-analytics/ActivityPub use is an extension point, not a claim of current Redis
support. Before wiring any such consumer, verify its released configuration contract and
distinguish disposable cache from durable queues/counters/salts/other state. Durable
state needs appropriate persistence, eviction, isolation, backup/restore, and upgrade
policy; separate instances when policies differ. Key prefixes or Redis logical DBs alone
do not isolate memory/eviction/durability policies. Redis remains per-site if a shared
Caddy (S13) is in use.
