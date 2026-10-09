# Manager architecture

The manager handles Ghost-specific installation, configuration, diagnosis,
import, backup/restore and image-installation self-update. Docker Compose owns
ordinary start, stop and logs. Unimplemented features and their acceptance
criteria live in the [roadmap](ghost-cli-replacement.md).

## Documentation ownership

| Subject | Authoritative home |
| --- | --- |
| Commands, installation, migration steps and operator recovery | [install.md](install.md) |
| Environment encoding, profiles, overrides and image pins | [configuration.md](configuration.md) |
| Routes and operator edits | [caddy.md](caddy.md) |
| Migration bundle format, source requirements and fidelity | [bundle-v1.md](bundle-v1.md) |
| Manager boundaries, state and recovery invariants | This document |
| Outstanding requirements and release gates | [ghost-cli-replacement.md](ghost-cli-replacement.md) |
| Developer setup and validation commands | [README](../README.md#developing) |

Schemas and file inventories are defined in code; documentation explains their
meaning rather than maintaining another field list.

## Launcher and manager

The host runs the bash launcher, `ghost-docker`. It checks Docker availability,
daemon access and the Compose plugin, selects a manager image, mounts inputs,
attaches a terminal and passes the manager's exit code through. Everything that
can run after the image starts belongs in the manager. The launcher must remain
compatible with bash 3.2; Windows uses WSL2.

For image installations, the site's launcher is pinned to an immutable manager
image. A `self-update` invocation selects the target release on the requested
channel or `--to` version; the updater runs outside the files it replaces.
A checkout builds `ghost-docker:checkout` from its current files. Git and Compose
own checkout updates; the manager records no persistent checkout history.

The image runs TypeScript directly on Node with type stripping
(`erasableSyntaxOnly`, no build step). Command schemas in `src/command.ts` supply
options and help to the dispatch table in `src/cli.ts`; parsing is strict and
usage errors exit 2. `src/io.ts` provides the test seam.

The manager uses the Engine API through `src/docker/` (undici transport and
zod-validated responses). Compose runs as a program because it has no API. The
image carries the standalone Compose binary, not the Docker CLI. Service probes
use native clients; bulk database operations use version-matched MySQL tools.

### Host boundary

- Mount the site at its **own absolute host path**: the daemon resolves bind
  sources on the host, not inside the manager. `src/context.ts` validates the
  launcher's `GD_*` input; command preflight checks the working directory and
  `PROJECT_DIR` agree.
- The Docker socket grants host authority. The entrypoint drops to the caller's
  uid/gid with the socket's group added. Under rootless Docker, container root
  already maps to the caller and must not drop again. Short-lived root helpers
  handle service-owned data, such as MySQL's files.
- The launcher resolves local sockets from Docker's context, using the VM socket
  on Docker Desktop/OrbStack. Remote daemons are refused because host bind paths
  would refer to a different machine.
- External import bundles and restore backups are mounted read-only at their
  own paths. Prompts use the terminal even when the launcher is piped from curl.
- `doctor` writes a file and reads it through a sibling container mounting the
  same host path. Seeing the directory inside the manager alone cannot establish
  that the daemon sees the same files.

## Configuration and site identity

[Configuration](configuration.md) owns the dotenv and Compose invocation
contracts. `src/env.ts` is the one encoder/parser, `src/fs.ts` writes atomically,
and `src/config.ts` checks the configuration split. Operator keys are derived
from Compose's interpolated variables, `.env.example`, `COMPOSE_*` and existing
`.env` keys. Container-owned values are checked against Compose's resolved
Ghost environment.

`src/site.ts` defines names and profiles and reads operator settings.
`src/resolved.ts` reads effective images, mounts, networks and project identity
from Compose, including overrides; container identity comes from the daemon.
Use this resolved view when checking or recording what a site will run, rather
than inferring it from `.env`. `composeFileList` in `src/compose.ts` owns file
ordering, and `composeOverrides` derives additional overrides from that list.

`src/project.ts` chooses a stable project name at install. Local names include
a random adjective/animal pair unused on the daemon; production names derive
from the domain. Compose addresses containers by project name alone, so commands
that operate on a site refuse containers belonging to another working directory
(`com.docker.compose.project.working_dir`).

### Installation metadata

The strict schema in [`src/meta.ts`](../manager/src/meta.ts) defines
`.ghost-docker.json`. It records installation provenance, resolved Ghost identity
and managed-file checksums. It is private, gitignored, atomically written and
machine-owned. Missing metadata is distinct from invalid metadata; commands
requiring it refuse either with an actionable diagnostic.

`source` distinguishes files installed from the image from files used in a
checkout. `stack.image` is the manager pin. `payload` stores the checksum of each
managed file; it is empty for a checkout. A self-update replaces untouched files,
keeps edited ones beside the release's `<file>.new`, and records the new release's
checksums. The launcher must be re-pinned even if edited; its edited copy is kept.
`updatedAt` and `stack.previous` describe the last successful update.

Metadata describes the installation, not a second live configuration. Backup
asks Git for a checkout's actual current commit and Compose/the daemon for its
configuration and images at capture time.

## Installation and import

Installation uses a fresh destination and never stops or reconfigures an existing
site or proxy. Container-published ports can be checked before startup; conflicts
outside Docker may surface only when Compose starts services. `src/undo.ts`
records created resources so a failed installation removes only its own work.
`--no-start` creates no application containers.

`src/ghost.ts` resolves and inspects the pulled image, including its declared
layout. `src/payload.ts` writes the image's stack files and pinned launcher;
checkout files stay in place. Caddy routes are rendered once from
`templates/site.caddy`, then belong to the operator. [caddy.md](caddy.md) owns
route edits and reload instructions.

`src/bundle/manifest.ts` defines the migration bundle schema and depends only on
zod so the exporter can share it. Import policy stays outside that schema.
`src/bundle/stage.ts` stages and validates input, `src/import.ts` sequences the
import, and `src/import/config.ts` and `database.ts` handle configuration and SQL.
The [bundle contract](bundle-v1.md#minimum-source-version) owns minimum versions
and exact-version loading: import and upgrade remain separate operations.

An import writes into a fresh site and records what it creates in an incomplete
marker. Until verified, `.env` selects no services, so ordinary Compose cannot
start a half-imported site. A failed import removes its work; the next import
clears interrupted work before retrying. A portable bundle's JSON and members CSV
are imported through Ghost Admin, as [install.md](install.md) describes. The
bundle's `sourceInstallType` selects the site mode; a production import is an
ordinary production install on the bundle's domains, refused before any write
when its URLs cannot be served as they are. Moving the source's traffic (stopping
it, its proxy, DNS) is documented, not automated.

## Verification and service access

`src/commands/site.ts` judges services against the resolved configuration and their
lifecycle labels: a long-running service must be running and, if it has a health
check, healthy. One-shot jobs must exit successfully; absence before their first
run is reported separately. Unknown services default to the stricter long-running
rule. Restart policy alone is neither readiness nor migration orchestration.

`src/network.ts` discovers a shared network from the site's running containers,
attaches the manager, and detaches it when the last overlapping phase finishes.
An attachment that already existed is preserved. Detachment must finish before
Compose removes the site's network. Per-site aliases avoid ambiguity on shared
networks; a container address is the fallback when an override removes its alias.

`src/clients.ts` uses mysql2 and HTTPS/TLS directly. Query deadlines and bounded
connection cleanup ensure that a stalled database cannot hold the network or
site lock indefinitely. Dumps and loads still use the db image's `mysqldump`
and `mysql`; native clients handle queries, not bulk data movement.

`src/verify.ts` reports container health and, in production, an ingress request
for Ghost's Admin site endpoint. Production requests reach Caddy on the site's network with
the public/admin Host and SNI, and must return the configured canonical site URL.
A healthy proxy or a certificate alone does not prove the route reaches this
site. Published host ports are reported separately: the manager's loopback is
not the host's. [Installation verification](install.md#how-a-site-is-verified) documents
operator-visible results, including pending certificates before DNS cutover.

## Recovery

`src/lock.ts` serializes backup, restore, self-update and `config set`. Atomic
file replacement alone cannot prevent overlapping read/modify/write operations
from losing a change. Lock acquisition refuses rather than waits. An interrupted
operation leaves its lock for the operator; nothing clears it automatically.
Install/import operate on a fresh destination and do not take this lock.

### File inventory and backups

`siteFiles` in `src/meta.ts` combines operator paths from `src/site.ts`, additional
Compose overrides and an image installation's payload. Backup copies that
inventory; restore sets it aside together with the backup's recorded files.
Update snapshots cover operator files and every path that update can replace,
remove or create. An override is identified by its full path: a nested
`overrides/compose.override.yml` is an additional file, not the root override.
Additional overrides outside the site are refused for backup.

`src/backup.ts` refuses moved/nested data mounts it cannot capture and image drift
before starting anything for a dump. Stopped long-running containers count: their
data may have been written by an image different from the newly configured one.
One-shot containers describe completed jobs and do not establish image drift.
The strict [`backup/manifest.ts`](../manager/src/backup/manifest.ts) schema records
configured images, immutable identities of running services, checksums and
consistency. Image backups carry the stack and launcher; checkout backups require
the captured Git revision on restore.

A backup becomes complete only after its dumps load in scratch MySQL of the
site's version and its content archive lists successfully. Until then it is a
private `.partial` directory. The [operator guide](install.md#backup-and-restore)
owns backup contents, exclusions and live/consistent usage.

### Writer ownership and update failures

`src/writers.ts` pauses only writers that were running. Standalone consistent
backup resumes them after capture, before scratch validation. Self-update owns
the pause from before capture until it attempts to start the release, or restores
the old files and resumes the same containers after an early failure.

**Attempting service startup is the recovery boundary.** Even a failing
`up --wait` can migrate data and accept writes. After that attempt, self-update
stops services, restores files when stopping succeeds, and leaves data untouched
for the operator. It never automatically loads the earlier backup over newer
writes. Before that boundary, recovery restores files and resumes the paused
writers. Recovery reports observed service state and retains the snapshot if an
operator is needed. The [operator guide](install.md#self-update) owns the recovery
commands and their data-loss tradeoffs.

### Restore

Before changing the destination, restore validates checksums, target ownership,
override selection, configuration and immutable image identity. Compose resolves
exactly the files restore will write, using the backup's copies (the checkout's
own base Compose file for checkout restores) and `.env` with the destination's
`PROJECT_DIR`. Absolute override/data paths must retain their meaning; validation
must not reinterpret them under a temporary project directory.

`src/recovery.ts` provides observed service shutdown, verified copies set aside
one boundary at a time, and loading backup data into a fresh MySQL directory.
Before restore writes anything, a failed set-aside puts back what moved. After
writing begins, a failure stops services and needs the operator; it does not
automatically put the old site back. Instructions name only copies that exist.
The set-aside site is removed only after verification succeeds.

There is no automatic crash resume, maintenance ingress, or backup retention
policy. Future Ghost upgrades and the supervisor must use these same recovery
invariants; their remaining requirements belong in the roadmap.

## Releases and compatibility

`src/release.ts` accepts and orders `vX.Y.Z` and `vX.Y.Z-beta.N` with semver.
The separate `scripts/` package cuts releases; it is not in the manager image.
The Release workflow selects a minor for a feature commit (✨), otherwise a
patch, and selects release notes by the commit skill's emojis. Publishing moves
channel tags only forwards, refuses to overwrite release images and serves the
launcher only from the newest release. GitHub Pages deploys through Actions.

`manager/Dockerfile` carries the runtime, stack payload and launcher. Payload
coverage tests check the mounts/build contexts referenced by Compose. A release
must retain operator routes or supply a deliberate migration when snippet
arguments change. Self-update preserves Ghost's exact pin and refuses incompatible
Ghost versions and stack downgrades. Operator release selection is documented in
[install.md](install.md#releases).

### Compatibility

The first stable release establishes the metadata, backup and launcher compatibility
baseline. Before it, these are development formats: change strict schemas directly,
without defaults, adapters or migrations for earlier development snapshots. Keep
useful fresh/damaged-install diagnostics. Bundle v1 has its own
[contract](bundle-v1.md).

S12 must record the exact schema/format/launcher versions supported by the stable
release here. Subsequent changes must be compatible or explicitly versioned with
a migration or old-format reader; pinned launchers must still start newer update
managers.

### Migration from the released main layout

`src/legacy.ts` is migration `0001-compose-profiles`: the one way an installation
of the released `main` layout (a clone with no metadata) reaches this layout,
entered through the served launcher's `self-update`. `src/legacy/caddy.ts`
carries the operator's Caddyfile as written, with main's environment variables
filled in and main's snippets kept beside it rather than translated into this
layout's shape; Caddy decides whether it loads. `src/legacy/config.ts` splits
its `.env`.
It decides everything before changing anything: Compose resolves the staged
configuration with the operator's overrides and Caddy loads the staged routes.
It then follows self-update's recovery boundary, reusing its snapshot, writer
pause and backup; the backup skips drift refusal because the stopped containers
deliberately ran main's images. The metadata is written last and is the only
record of completion: a site with it is never migrated again. There is no
general migration framework; a later migration from a released layout adds
what it needs.
