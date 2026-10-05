# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this branch is

`next-docker` rebuilds the self-hosted Ghost Docker setup around a **manager
image**: a TypeScript CLI in a container, started by a launcher (`ghost-docker`,
`ghost-docker.ps1`) that needs only Docker on the host. The plan, with the
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

Step N1 only: the stack's files and the contracts. There is **no tooling** on
this branch yet. `./ghost-docker ...` commands in the documents are the planned
interface; the plan says which step delivers each.

- `compose.yml` — Ghost, MySQL, Caddy, optional analytics and ActivityPub.
  Site mode is `local` or `production`, selected in `COMPOSE_PROFILES`;
  optional profiles are additive. Long-running services take
  `RESTART_POLICY`; one-shot jobs keep `restart: "no"`.
- `caddy/Caddyfile` is tracked and generic. Generated routes go in
  `caddy/sites/`, operator routes in `caddy/custom/`, global options in
  `caddy/global/`. Snippets take their upstreams and domains as import
  arguments.
- `.env` holds Compose and operator settings, including the MySQL root
  password, and is never passed into the Ghost container. `ghost.env` holds
  Ghost application settings and is the `ghost` service's only `env_file`.
- `docs/configuration.md`, `docs/caddy.md`, `docs/bundle-v1.md` — contracts.
- `scripts/migrate.sh`, `scripts/config-to-env.js` — the legacy Ghost-CLI
  migration, kept until production import (S5e) replaces it.

## Rules that hold whatever is being built

- Compose interpolates dotenv values even inside double quotes: a literal `$`
  is written `$$`. Never source or evaluate an env file. One encoder, tested by
  a round trip through real containers. See "Value encoding" in
  `docs/configuration.md`.
- Compose is invoked with `--project-directory` and an explicit `-f`, never
  `-C`, and without an inherited `COMPOSE_FILE`.
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
- Options for steps that have not landed exit `3` and name the step; usage
  errors exit `2`.
- The two launchers implement one contract. Logic that could live in the
  manager does.

## Tests

Unit tests for the CLI are TypeScript. End-to-end scenarios that only run the
real commands and check outcomes are shell scripts in `tests/e2e/`. Shell code
passes ShellCheck.

## Common commands

```bash
docker compose ps
docker compose logs -f ghost
docker compose exec ghost sh
docker compose exec db mysql -u root -p
./help
```
