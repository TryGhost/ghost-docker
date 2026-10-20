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
| Tagged single-site production | S5e production import, S12 qualification | Existing image self-update, local import, backup and restore |
| Several sites behind shared Caddy | S13 | Existing backup/restore and released-main migration |
| Admin-driven Ghost upgrades | S9 core adapter/API, S10 Admin | Existing `update` and upgrade supervisor; S9 before S10; S13 integration if shipped |
| Later extensions | S11 file secrets, S14 service references, S15 nightly transitions, S16 Redis | See each step |

Qualify production on Linux with rootful Docker Engine. Local qualification also covers
Docker Desktop, OrbStack and WSL2. Rootless Docker is best effort, not part of the
supported qualification matrix. Daily start, stop and logs stay with Compose. Stack
self-update remains image-only; checkout operators use Git and Compose and retain
backup/restore. Automatic major Ghost/MySQL upgrades and arbitrary downgrades are
outside the planned scope.

### S5e — Production import and cutover

Repo: ghost-docker. `install --import` takes production bundles and the cutover is
documented in [install.md](install.md#moving-a-production-site). Remaining:

Do not guess ownership as uid 1000 under rootless/user namespaces.

Acceptance, on Linux with rootful Docker Engine and a real Ghost-CLI production
install (MySQL, systemd, nginx): same-server and cross-host moves following the
documented steps; a forced import failure leaving the directory as it was, with the
documented recovery bringing back the source and nginx; a separate admin domain
carried from the bundle; exact source version, staff sign-in, records, active theme,
assets, redirects and configuration preserved.
`tests/e2e/production-import.sh` covers the same-server move, the forced failure and
its recovery, and the admin domain in CI; the cross-host move is run by hand. This replaces `main`'s
`scripts/migrate.sh`; S12 must not merge `next-docker` into `main` before these
scenarios pass.

### S9 — Ghost upgrade adapter and Admin API

Repo: Ghost core. Deps: the supervisor's protocol ([upgrade-supervisor.md](upgrade-supervisor.md)).
Follow repository adapter/API guidance. Implement `NoopUpgradeAdapter` and, against the
protocol, `HttpUpgradeAdapter`, permission-checked status/
request/job APIs, rate limiting, capability reporting, and update-notification metadata.
Noop is default; missing/stale supervisor and malformed protocol data produce useful
status without making unrelated Ghost startup depend on supervisor availability.

Acceptance: adapter/controller tests, API permission tests, protocol tests against a test socket,
version compatibility, and initialization ordering. Keep Admin UI separate.

Use adapter type `upgrade`; a Ghost without it ignores the HTTP adapter's settings. API endpoints are status, create request and fetch job;
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

Repo: ghost-docker. Deps: the credential consumers in backup, import, restore, `update` and the upgrade supervisor.
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

Repo: ghost-docker, with cross-repo fixtures. Deps: S5e, plus existing install,
backup/restore, self-update, released-main migration and the upgrade supervisor; qualify S13,
S9-S10 and S11 when they have shipped.
Gates the first stable tag and merging `next-docker` into `main`. Include the launcher
on Linux, macOS and WSL2. Consolidate CI and qualify the actual minimum supported tools
and image versions. Run fresh local/production install, optional-service variants, CLI
migration, legacy stack update, Ghost upgrade/recovery, supervisor/Admin, and restore
scenarios. On a site with analytics, `update` must rerun Tinybird sync from the new
image and the deploy must succeed; it needs a Tinybird login, so it is run by hand. Before merging, pin the migration tests' `GD_RELEASED_MAIN`
(default `origin/main`, in `manager/test/site.ts`, `tests/e2e/migrate-main.sh` and
the manager CI job) to `main`'s last commit, and rerun them. Include Linux runtime tests and macOS-compatible shell/configuration checks.
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
existing site into a member (PLA-504) starts from a site on this layout, which the
released-main migration provides. Several sites on one server, as
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

### S15 — Opt-in Ghost nightly channel

Repo: ghost-docker. `install --ghost-channel nightly` runs Ghost's nightly builds of
`main` from `ghost/nightly` on Docker Hub, and `update` and the upgrade supervisor move a
nightly site to newer builds, ordered by build time, as
[configuration.md](configuration.md#ghost-channel) describes.
`tests/e2e/ghost-nightly.sh` moves a site from an older build to the latest through the
supervisor in CI. Remaining:

Explicit, compatibility-checked channel transitions. Stable-to-nightly and
nightly-to-stable must refuse unsafe schema transitions rather than pretending that image
selection rolls back the database; returning to stable may mean waiting for a
compatible release or restoring a checkpoint.

Recovery images for nightly sites: Hub keeps a limited history, so retain the exact
build a backup ran, or say clearly at restore that it is gone. Show the channel and the
build's commit (`org.opencontainers.image.revision`) in `info`, `check` and the
supervisor's status.

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
