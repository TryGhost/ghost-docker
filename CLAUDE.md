# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a comprehensive Docker Compose setup for running Ghost CMS in production with automatic HTTPS, optional analytics, and ActivityPub support. The repository orchestrates multiple services including Ghost, MySQL, Caddy (reverse proxy), and optional Tinybird analytics and ActivityPub federation.

## Architecture

The project uses Docker Compose to orchestrate these services:

1. **Ghost** - The main CMS application (runs on internal port 2368)
2. **MySQL** - Database backend with health checks and support for multiple databases
3. **Caddy** - Reverse proxy handling HTTPS/SSL, routing, and external access
4. **Traffic Analytics** (optional profile) - Tinybird integration for web analytics
5. **ActivityPub** (optional profile) - Federated social networking support
6. **Supporting services** - Tinybird setup tools and ActivityPub migrations

Services communicate internally via Docker networks, addressed through unique
per-site aliases (`ghost-${COMPOSE_PROJECT_NAME}`, `db-…`, `activitypub-…`,
`traffic-analytics-…`) rather than bare service names. Caddy handles all
external traffic routing, including analytics (`/.ghost/analytics/`) and
ActivityPub (`/.ghost/activitypub/`, `/.well-known/webfinger`,
`/.well-known/nodeinfo`).

Site mode is selected through `COMPOSE_PROFILES` and exactly one of `local` or
`production` must be present. Optional per-site profiles (`analytics`,
`activitypub`) are additive and never change the mode. Caddy is part of
`production`, not optional; bring-your-own-proxy is an unsupported manual edit
of `compose.yml`. `supervisor` is a
reserved profile name with no service yet.

Long-running services use `restart: ${RESTART_POLICY:-unless-stopped}`;
one-shot jobs (`activitypub-migrate`, `tinybird-*`) keep `restart: "no"`.

## Common Commands

```bash
# Installation
curl -fsSL .../bootstrap.sh | bash -s -- --domain example.com   # release-selecting shim
./install.sh --local --no-prompt --no-start                     # checkout-owned installer
scripts/site.sh check                   # doctor: config, health, DB, ingress
scripts/site.sh list                    # every managed container on this host

# Core operations
docker compose up -d                    # Start the services for the selected mode
docker compose down                     # Stop all services
docker compose logs -f [service]        # View logs (e.g., ghost, mysql, caddy)
docker compose ps                       # Check service status
docker compose pull                     # Update all images
docker compose restart ghost            # Restart just Ghost

# With optional profiles
docker compose --profile=analytics up -d     # Include analytics services
docker compose --profile=activitypub up -d   # Include ActivityPub services
COMPOSE_PROFILES=analytics,activitypub docker compose up -d  # Start everything

# Tinybird analytics setup (if using analytics profile)
docker compose run --rm tinybird-login       # Interactive Tinybird login
docker compose --profile=analytics up tinybird-sync   # Sync datasources/pipes
docker compose --profile=analytics up tinybird-deploy # Deploy configuration

# Development & debugging
docker compose exec ghost sh            # Access Ghost container shell
docker compose exec db mysql -u root -p  # Access MySQL CLI

# Configuration helpers (never source an env file; always atomic writes)
scripts/config.sh validate              # Validate .env and ghost.env by mode
scripts/config.sh set ghost.env KEY VAL # Write one value safely
scripts/config.sh unset ghost.env KEY

# Caddy routes
scripts/caddy.sh apply                  # Render, validate, install, reload, verify

# Tests (Node 20+ built-in runner, no dependencies and no package.json;
# docker tests skip without a daemon)
node --test --test-timeout=120000 tests/*.test.mjs
GD_TEST_INGRESS=1 node --test --test-timeout=900000 tests/ingress.test.mjs
GD_TEST_INSTALL=1 node --test --test-timeout=1800000 tests/install-e2e.test.mjs
```

## Configuration

Configuration is split by audience. See `docs/configuration.md` for the full
contract.

- `.env` — Compose and operator settings: project identity, site mode, ports,
  data locations, restart policy, and infrastructure credentials such as
  `DATABASE_ROOT_PASSWORD`. **Never passed into the Ghost container.**
- `ghost.env` — Ghost application settings only, in `section__subsection__key`
  form. The sole `env_file` of the ghost service. Container-owned keys (`url`,
  `admin__url`, `NODE_ENV`, `server__*`, `paths__*`, `database__*`) are set as
  Compose `environment` entries and are rejected here. That rejection is
  derived by asking `docker compose config` what the container receives, not
  from a hardcoded list, so it cannot drift from `compose.yml`.

Compose interpolates dotenv values, including inside double quotes. Write a
literal dollar sign as `$$`, or use `scripts/config.sh set`, which serializes
safely. Never source an env file; use `scripts/lib/env.sh`.

- **Developer experiments**: set `labs__publicAPI=true` in `ghost.env` for the
  analytics/ActivityPub features
- **Data persistence**: `UPLOAD_LOCATION` and `MYSQL_DATA_LOCATION`

### Key files
- `bootstrap.sh` — curl-able release-selecting shim; bootstrap logic only
- `install.sh` — checkout-owned installer. One checkout is one site
- `.env` / `.env.example` — operator configuration
- `ghost.env` / `ghost.env.example` — application configuration
- `.ghost-docker.json` — generated installation metadata (schema v1, read and
  written by `scripts/lib/meta.sh`; a missing file means "pre-metadata install",
  not a broken site)
- `compose.yml` — service definitions
- `caddy/Caddyfile` — tracked generic entry point; site routes are generated
  into `caddy/sites/`, operator routes live in `caddy/custom/`, global options
  in `caddy/global/`
- `scripts/lib/*.sh` — shared helpers (env, fs, compose, config, caddy, meta,
  preflight, install)
- `scripts/site.sh` — `list`, `check`/doctor, `info`
- `mysql-init/create-multiple-databases.sh` — MySQL multi-database initialization

## Migration from Ghost CLI

The repository includes comprehensive migration tools:

- `scripts/migrate.sh` - Main migration script that:
  - Backs up existing Ghost installation
  - Automatically tries Ghost's database credentials first
  - Only prompts for alternative credentials if needed
  - Uses `--no-tablespaces` flag to avoid PROCESS privilege requirements
  - Converts config.json to environment variables
  - Preserves content and database
  - Creates recovery script with clear restoration instructions
  - Sets up Docker Compose environment

- `scripts/config-to-env.js` - Converts Ghost JSON config to ghost.env format.
  CommonJS; there is no package.json in this repository, so `.js` is CommonJS
  by default. This is the only host Node dependency, and `install.sh --import`
  removes it

## Installer

`install.sh` is checkout-owned and installs into its own directory; `--dir`
elsewhere is refused. `bootstrap.sh` selects a release by semver order (never
lexically), clones it, and `exec`s that checkout's installer. Ghost versions are
resolved to an exact tag by asking the pulled image for its own `GHOST_VERSION`,
`GHOST_CONTENT` and `GHOST_INSTALL`; the digest goes into `.ghost-docker.json`.

Rules that must not regress:

- Installation never stops or reconfigures anything already running. A chosen
  port moves out of the way; an explicitly requested busy port is an error, and
  so is an occupied 80/443 in production.
- Every prompt reads `/dev/tty` and has a flag or environment-variable
  equivalent. No prompt has a silent default.
- Docker access is established by asking the daemon, never from `docker` group
  membership. Read-only probes have deadlines so a wedged daemon is reported
  rather than hung on.
- Host tools are `docker` + `jq` (+ `git` for the bootstrap) plus the POSIX
  utilities in `GD_HOST_UTILITIES`; `tests/install-e2e.test.mjs` installs with a
  `PATH` of exactly that list.
- Options for steps that have not landed (`--import`, `--with supervisor`,
  `--image-registry`, `--ghost-channel`, `--without`) exit 3 naming the step,
  not as unknown options.

See `docs/install.md`.

## Development Workflow

1. Copy `.env.example` to `.env` and `ghost.env.example` to `ghost.env`
   (both mode `0600`) — or let `install.sh` do it
2. Configure the required variables for the mode; run `scripts/config.sh validate`
3. Production only: `scripts/caddy.sh apply`
4. Run `docker compose up -d`
5. Access Ghost at `URL`; monitor with `docker compose logs -f ghost`

All shell code is `bash`, kept compatible with bash 3.2 so it runs on macOS's
system bash: no `declare -A`, `mapfile`, `${v,,}` or namerefs. It must pass
`shellcheck`, which picks the dialect from the shebang. Tests are `.mjs` files
in `tests/` run by Node's built-in runner: the shell libraries are exercised
through a real shell via `tests/helpers.mjs`, while fixtures, structured-output
parsing and assertions are JavaScript.

For analytics setup, see `TINYBIRD.md` for detailed instructions.

## Implementation plan

`docs/ghost-cli-replacement.md` is the plan this repository is being built
against, including the architecture contracts (§2) and the step breakdown (§3).
Read the relevant step and its dependencies before implementing one, and amend
the affected contract in the same pull request when a decision changes. Steps
land as stacked pull requests in the dependency order given in §3.

## Important Notes

- Runtime prerequisites: `bash`, Docker Engine 25.0.0, Docker Compose v2.24.0,
  and `jq` (used by the helpers for JSON). `install.sh` verifies
  them in preflight; `scripts/migrate.sh` already required `jq`
- Node.js is a development/test requirement only, never needed to run a site.
  The exception is the legacy `scripts/migrate.sh`, retired by `install.sh --import`
- Ghost runs internally on port 2368 and is published on `127.0.0.1` only;
  Caddy exposes 80/443 in production
- The default image is a `next` variant, which installs Ghost directly under
  `/home/ghost` instead of the older `/var/lib/ghost/versions/<v>` + `current`
  layout. `GHOST_CONTENT_PATH` and `GHOST_TINYBIRD_PATH` exist so pinning an
  older `GHOST_VERSION` stays possible
- Helpers use one Compose contract: `docker compose --project-directory "$DIR"
  -f "$DIR/compose.yml"`, never `-C`, never `COMPOSE_FILE`
- `ghost` and `db` have real readiness health checks; a running container is
  not readiness
- Container logs are capped via `LOG_MAX_SIZE` / `LOG_MAX_FILE`
- Email configuration is critical even without newsletter features (used for admin notifications)
- MySQL health checks ensure database is ready before Ghost starts
- The compose file uses yaml-language-server schema for IDE completion support
- For production, always use strong passwords and consider additional security measures
