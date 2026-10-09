# AGENTS.md

Guidance for coding agents working in this repository. This is the only such
file: there is no separate `CLAUDE.md`.

## What this branch is

`next-docker` rebuilds the self-hosted Ghost Docker setup around a **manager
image**: a TypeScript CLI in a container, started by a launcher (`ghost-docker`)
that needs only Docker and bash on the host. The plan, with the
architecture, the contracts and the step breakdown, is
[docs/ghost-cli-replacement.md](docs/ghost-cli-replacement.md). **Read the
step you are implementing and the §2 contracts it names before writing code.**

Branches:

- `main` — the released layout. Existing installations update from it with
  `git pull`, so nothing here merges into it until the legacy migration (S6b).
- `next-docker` — this branch. Pull requests target it.
- `next` — frozen. A complete bash implementation of the configuration
  foundation, installer and local bundle import, with tests. It is the
  behaviour reference for steps that port it (`git show origin/next:<path>`).
  Do not add to it, and do not port the bash; port what it does.

## Current state

Steps N1–N3, S4, S5b, S5c and S6a: the stack's files and contracts, the
launcher and manager image, releases, and the commands: `install` (local and
production, from the image or a clone, from a channel or a release, and
`--import` of a local Ghost-CLI site's bundle), `self-update` (between releases,
for image-mode sites; a clone is refused, and updated with git and Compose), `backup` and `restore` (over the site, or into a new
directory), `config get|set|validate`, `check`, `info`, `list`, plus
`version`, `doctor` and `help`. Every other `./ghost-docker ...` command or
option in the documents is the planned interface: it does not exist until its
step lands (an unknown command or option exits 2), and the plan says which step
delivers it. `docs/install.md` describes what exists.

- `ghost-docker` (bash) is the only host code. It checks Docker, chooses the
  image, and `docker run`s it (plan §2.10). Add no logic to it that the
  manager could hold. Windows is WSL2 only; there is no native launcher.
  There is no `--migrate`: moving a Ghost-CLI site is documented as
  `ghost stop`, `ghost migrate-export`, `install --import` (S5c). It reads
  `--channel`, `--release` and `--to` to choose the image (and passes them on);
  `self-update` from a pinned site runs the newest release on the site's channel
  (`GD_PINNED_CHANNEL`), not its pin. It mounts `--import`'s bundle, and
  `restore`'s backup when it is outside the site, read-only at its own path.
- `manager/` is the CLI: TypeScript run directly by Node (types stripped, no
  build step, so `erasableSyntaxOnly`), with dependencies installed by pnpm
  (version pinned in `package.json`; `npm i -g corepack && corepack enable`
  provides it). A command's options are a zod object keyed in camelCase,
  each with its brief as `.describe()` (`src/command.ts`): the command line
  (`--admin-domain`, a boolean as a flag) is derived from it and parsed by
  Node's own `util.parseArgs` (strict), then the values by the schema, which
  refuses a bad value or combination as a usage error. `src/cli.ts` holds the
  dispatch table (each command's options, its positional arguments and its
  handler), renders help from it and maps errors to exit codes. Handlers get
  the schema's output and return the exit status. `src/commands/` holds what each command does, `src/context.ts` the
  `GD_*` environment the launcher passes, `src/io.ts` the seam tests
  substitute. Programs are run with execa, the daemon is spoken to directly (below).
- The manager talks to the daemon over the **Engine API** on the mounted
  socket (`src/docker/`: undici transport, zod-typed endpoints, a `runOnce`
  for one-shot containers). It does not shell out to the `docker` CLI; the
  CLI is in the image for Compose only, which has no API (`src/compose.ts`).
- `manager/entrypoint.sh` drops from root to the caller's uid and gid, keeping
  the Docker socket's group. It does not drop under rootless Docker.
- `manager/Dockerfile` builds from the repository root and also carries the
  stack's files under `/opt/ghost-docker/stack` (the payload `install` writes in
  image mode) and the launcher under `/opt/ghost-docker/launcher`.
- `src/project.ts` is a site's Compose project name, chosen once by install
  (production: the domain's; local: the directory's and a random
  adjective-animal pair no project on the daemon has), and who owns a project:
  a command that changes a site first refuses one whose containers another
  directory made (`com.docker.compose.project.working_dir`).
  `src/resolved.ts` is the site as Compose resolves it from every file it
  runs with (project name, files, overrides, each service's image, mounts and
  networks) and as the daemon runs it (each container's image and image ID).
  Backup, restore and check read the site from it, not from `.env`.
- `src/env.ts` is the one dotenv encoder and parser; nothing else reads or
  writes `.env` or `ghost.env`. `src/fs.ts` writes atomically. `src/site.ts`
  holds file names, modes and profiles; `src/config.ts` validation;
  `src/caddy.ts` fills `templates/site.caddy`, the routes install writes; `src/meta.ts` the metadata schema; `src/ghost.ts`
  image resolution; `src/payload.ts` the image-mode files and pinned launcher.
- `src/bundle/manifest.ts` is the bundle v1 manifest as a zod schema. It
  imports nothing but zod, so the exporter in Ghost-CLI can share it; keep
  importer policy out of it. `src/bundle/stage.ts` unpacks and validates a
  bundle in staging; `src/import.ts` holds the import's steps and `Importing`,
  what `install --import` adds to an installation, with the pieces that
  print nothing in `src/import/config.ts` (what ghost.env carries over) and
  `src/import/database.ts` (the client, the DEFINER filter, row counts).
  `src/undo.ts` records what an installation created and removes it on
  failure; an import keeps that record in its marker file.
- Releases (`src/release.ts`): only `vX.Y.Z` and `vX.Y.Z-beta.N`, ordered
  by semver. The manager holds only that; cutting releases is `scripts/`, a
  package of its own that is not in the image. The Release workflow cuts them
  as Ghost and Ghost-CLI do (`scripts/release.ts`: ✨ commits make a minor,
  anything else a patch; release-note emojis select the notes), then publishes the image, its
  moving `beta`/`stable` tags (`image.yml`), and the launcher to GitHub Pages as
  `https://docker.ghost.org/install.sh` (`launcher.yml`). Every release is a
  beta until S6b.
- `src/commands/self-update.ts` moves a site to the release it runs as: snapshot
  in `.ghost-docker-update/`, managed files by checksum (an edited one is kept
  beside `<file>.new`), validate, pull, `up --wait`, verify, and on failure
  put back and report restored or needs-the-operator. It refuses a clone,
  whose update is git's and Compose's. `src/lock.ts` is the site lock (§2.2).
- `src/backup.ts` takes a backup (§2.5): a mysqldump of each of the site's
  databases as its own user, the content as a tarball, the site's files, and
  `backup/manifest.ts` (images, row counts, checksums), written as
  `backups/.<id>.partial` and renamed only once every dump has loaded into a
  scratch MySQL (a `runOnce` of the site's db image) and the archive lists.
  `src/restore.ts` restores one over its site (set aside in
  `.ghost-docker-restore/` until verified) or into an empty directory, through
  a fresh MySQL and the import's client and DEFINER filter. Its outcome is
  done or needs the operator; it never puts the old site back by itself.
- The manager asks a site's services directly: `src/network.ts` joins the
  manager's own container to the network the site's running containers share
  (discovered, never guessed) and leaves it however the work ends, and
  `src/clients.ts` holds the clients, `mysql2` and a TLS handshake.
  Every service is addressed by its per-site alias. Queries go through
  `withSiteDatabase`; dumps are still made and loaded by the db container's own
  `mysqldump` and `mysql`. `src/verify.ts` reports each service's own health check
  and asks the network only for Caddy's certificate: `127.0.0.1` in the
  manager is the manager, and it cannot reach the host's ports. Dockerode and the Docker CLI were weighed and
  not adopted (plan §2.10).

- `compose.yml` — Ghost, MySQL, Caddy, optional analytics and ActivityPub,
  and for local sites Mailpit (`--with mailpit`; validation keeps it out of
  production).
  Site mode is `local` or `production`, selected in `COMPOSE_PROFILES`;
  optional profiles are additive. Long-running services take
  `RESTART_POLICY`; one-shot jobs keep `restart: "no"`.
- `caddy/Caddyfile` is tracked and generic. `install` writes a production
  site's routes into `caddy/sites/site.caddy` once; after that it is the
  operator's and the manager never rewrites it. Other sites go in
  `caddy/custom/`, global options in `caddy/global/`. Snippets take their upstreams and domains as import
  arguments.
- `.env` holds Compose and operator settings, including the MySQL root
  password, and is never passed into the Ghost container. `ghost.env` holds
  Ghost application settings and is the `ghost` service's only `env_file`.
- `docs/configuration.md`, `docs/caddy.md`, `docs/bundle-v1.md` — contracts.
- Migration is `install --import` for local sites only. The legacy
  `scripts/migrate.sh` on `main` does not understand this layout and was not
  brought across; it remains the production path on `main` until production
  import (S5e) exists.

## Rules that hold whatever is being built

- Compose interpolates dotenv values even inside double quotes: a literal `$`
  is written `$$`. Never source or evaluate an env file. One encoder, tested by
  a round trip through real containers. See "Value encoding" in
  `docs/configuration.md`.
- Compose is invoked with `--project-directory` and an explicit `-f`, never
  `-C`, and without an inherited `COMPOSE_FILE`. The site's
  `compose.override.yml`, when there is one, is added after `compose.yml`
  (`composeFiles` in `src/compose.ts`), as plain Compose would.
- A site directory must be mounted into the manager at its own absolute host
  path, because the daemon resolves bind mounts on the host.
- A Ghost version is resolved to a digest and pinned (`GHOST_IMAGE_REF`).
  Changing `GHOST_VERSION` alone never changes what a site runs.
- Installation never stops or reconfigures anything already running. A busy
  port is an error naming what holds it.
- Readiness is a health check passing and the Admin API answering through the
  site's own ingress. A running container is not readiness.
- Docker access is established by asking the daemon, never from group
  membership.
- Commands and options are added when their step lands, not stubbed ahead of
  it; usage errors exit `2`.
- The launcher holds no logic that could live in the manager.

## Tests

Unit tests for the CLI are TypeScript, in `manager/test/`, run by Node's own
test runner against a fake `Io`. Integration tests, in
`manager/test/integration/`, run the same code against the real daemon and the
stack's real MySQL and Caddy, from a container (the manager
Dockerfile's `integration` stage), because the manager joins its own container
to a site's network. End-to-end scenarios that only run the real commands and
check outcomes are shell scripts in `tests/e2e/`. Shell code passes
ShellCheck.

```bash
cd manager && pnpm install
pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm test
pnpm run test:integration     # real daemon and services, from a container; pulls images
tests/e2e/launcher.sh         # stand-in docker, then the real image
tests/e2e/install.sh          # real installs; binds 80/443, pulls images
tests/e2e/import.sh           # Ghost-CLI sites exported and imported; needs Node
tests/e2e/self-update.sh      # self-updates between locally built releases; a clone refused, backed up and restored at its commit
tests/e2e/backup.sh           # a site with ActivityPub backed up, restored over itself and elsewhere; needs jq
cd scripts && pnpm install && pnpm run typecheck && pnpm test   # the release tooling
```

Unit tests fake the daemon at the transport (`test/helpers.ts`: `api`, `run`
and `containers` for the Engine API, `composeRun` for Compose), and the site
network and its services at the `Io` (`sql`, `certificate` and
`network.refuse`). The fake only puts each running service at
its per-site alias; how the network is found, joined and left is the
integration tests' to prove, not the fake's to imitate. `test/site.ts` makes a
site directory from the repository's own files.

## Commits

Commit messages follow [.agents/skills/commit/SKILL.md](.agents/skills/commit/SKILL.md)
(also reachable as `.claude/skills/commit`).

## Common commands

```bash
docker compose ps
docker compose logs -f ghost
docker compose exec ghost sh
docker compose exec db mysql -u root -p
./help
```
