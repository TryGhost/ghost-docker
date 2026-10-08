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

Steps N1–N3, S5b, S5c and S6a: the stack's files and contracts, the launcher
and manager image, releases, and the commands: `install` (local and
production, from the image or a clone, from a channel or a release, and
`--import` of a local Ghost-CLI site's bundle), `update` (between releases, or
commits of a clone), `config get|set|validate`, `check`, `info`, `list`, plus
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
  `update` from a pinned site runs the newest release on the site's channel
  (`GD_PINNED_CHANNEL`), not its pin.
- `manager/` is the CLI: TypeScript run directly by Node (types stripped, no
  build step, so `erasableSyntaxOnly`), with dependencies installed by pnpm
  (version pinned in `package.json`; `npm i -g corepack && corepack enable`
  provides it). Arguments are parsed by Node's own `util.parseArgs`
  (strict; zod only where a value needs validating): `src/cli.ts` holds the
  dispatch table (each command's kebab-case options with their briefs, its
  positional arguments and its handler), renders help from it and maps errors to
  exit codes. Handlers get option values camelCased and return the exit
  status. `src/commands/` holds what each command does, `src/context.ts` the
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
  numerically. The Release workflow cuts them as Ghost and Ghost-CLI do
  (`manager/scripts/release.ts`: ✨ commits make a minor, anything else a
  patch; release-note emojis select the notes), then publishes the image, its
  moving `beta`/`stable` tags (`image.yml`), and the launcher to GitHub Pages as
  `https://docker.ghost.org/install.sh` (`launcher.yml`). Every release is a
  beta until S6b.
- `src/commands/update.ts` moves a site to the release it runs as: snapshot
  in `.ghost-docker-update/`, managed files by checksum (an edited one is kept
  beside `<file>.new`), validate, pull, `up --wait`, verify, and on failure
  put back and report restored or needs-the-operator. In a clone it checks
  the previous commit out instead. `src/lock.ts` is the site lock (§2.2).
- The manager verifies a site from inside its own containers
  (`src/verify.ts`): `127.0.0.1` in the manager is the manager, and it cannot
  reach the host's ports.

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
test runner against a fake `Io`. End-to-end scenarios that only run the real
commands and check outcomes are shell scripts in `tests/e2e/`. Shell code
passes ShellCheck.

```bash
cd manager && pnpm install
pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm test
tests/e2e/launcher.sh         # stand-in docker, then the real image
tests/e2e/install.sh          # real installs; binds 80/443, pulls images
tests/e2e/import.sh           # Ghost-CLI sites exported and imported; needs Node
tests/e2e/update.sh           # updates between locally built releases, and a clone's commits
```

Unit tests fake the daemon at the transport (`test/helpers.ts`: `api`, `run`
and `containers` for the Engine API, `composeRun` for Compose); `test/site.ts`
makes a site directory from the repository's own files.

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
