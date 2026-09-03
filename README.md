# Ghost Docker

Configuration to run Ghost and its services with Docker Compose.

Requires **bash**, **Docker Engine 25.0+**, **Docker Compose v2.24+** and **jq**.

## Install

```sh
# A production site with HTTPS
curl -fsSL https://ghost.org/docker/bootstrap.sh | bash -s -- --domain example.com

# A local development site
curl -fsSL https://ghost.org/docker/bootstrap.sh | bash -s -- --local
```

`bootstrap.sh` selects a release, clones it, and runs that checkout's
`install.sh`, which does everything else: preflight, an exact Ghost version pin,
generated passwords, configuration, routing, and verifying that the site answers
through its own ingress before it says it is installed.

Every prompt has a flag, so `--no-prompt` is fully scriptable. Installation
never stops or reconfigures anything already running on this host: a port that
is in use is an error naming what holds it. See [docs/install.md](docs/install.md).

```sh
scripts/site.sh check    # diagnose this site
scripts/site.sh list     # every ghost-docker container on this host
```

## Configuration

Two files, deliberately separate:

- `.env` — Compose and operator settings, including infrastructure credentials.
  Never passed into the Ghost container. Start from [`.env.example`](.env.example).
- `ghost.env` — Ghost application settings only, the sole `env_file` of the
  `ghost` service. Start from [`ghost.env.example`](ghost.env.example).

```sh
cp .env.example .env && chmod 0600 .env
cp ghost.env.example ghost.env && chmod 0600 ghost.env
scripts/config.sh validate
```

Both are written for you by `install.sh`; the examples are for hand-built
sites and for reference. See [docs/configuration.md](docs/configuration.md) for
the full contract: value encoding, site modes, profiles, lifecycle, service
aliases and metadata.

## Site modes

Exactly one site mode is selected through `COMPOSE_PROFILES`:

```sh
# Local: Ghost + MySQL, published on 127.0.0.1:${GHOST_PORT}
COMPOSE_PROFILES=local docker compose up -d

# Production: Ghost + MySQL + Caddy with automatic HTTPS
COMPOSE_PROFILES=production docker compose up -d
```

Optional per-site profiles are additive:

```sh
COMPOSE_PROFILES=production,analytics,activitypub docker compose up -d
```

## Routing

Production routes are generated, validated and installed by:

```sh
scripts/caddy.sh apply
```

Add your own routes as `.caddy` files in `caddy/custom/` and global options in
`caddy/global/`; neither is ever overwritten. See [docs/caddy.md](docs/caddy.md).

## Day-to-day

```sh
docker compose ps
docker compose logs -f ghost
docker compose pull && docker compose up -d
docker compose exec ghost sh
```

Run `./help` for a longer list.

## Analytics

See [TINYBIRD.md](TINYBIRD.md).

## Implementation plan

[docs/ghost-cli-replacement.md](docs/ghost-cli-replacement.md) is the plan this
repository is being built against: the architecture contracts, the step
breakdown, and the decisions behind them. Each step lands as its own pull
request, stacked on the ones it depends on.

## Migrating from Ghost-CLI

`scripts/migrate.sh` remains the supported path today; it writes Ghost
configuration into `ghost.env`. The migration bundle format that replaces it is
specified in [docs/bundle-v1.md](docs/bundle-v1.md).

## Upgrading an existing checkout

This layout is a breaking change for installations made before it landed —
`caddy/Caddyfile` is now tracked, the Caddy snippets take import arguments, and
Ghost configuration moves out of `.env`. See
[Existing installations](docs/configuration.md#existing-installations) before
pulling.

## IPv6 networking

IPv6 networking is opt-in because it requires newer Docker and Docker Compose
versions than the base setup. Enable it by including the IPv6 override file:

```sh
docker compose -f compose.yml -f compose.ipv6.yml up -d
```

The helper scripts take the same override through `GD_COMPOSE_OVERRIDES`:

```sh
GD_COMPOSE_OVERRIDES=compose.ipv6.yml scripts/caddy.sh validate
```

## Tests

The test suite runs on Node.js 20+ using its built-in test runner. There are no
dependencies and no `package.json`: Node is a development requirement only, and
the repository is not a Node package.

```sh
# helpers, mode matrix, Caddy routes, installer decisions, metadata
node --test --test-timeout=120000 tests/*.test.mjs

# local and production ingress, against real containers
GD_TEST_INGRESS=1 node --test --test-timeout=900000 tests/ingress.test.mjs

# real installations from a candidate release built out of the working tree
GD_TEST_INSTALL=1 node --test --test-timeout=1800000 tests/install-e2e.test.mjs
```

Docker-dependent tests are skipped when no daemon is reachable. Set
`GD_TEST_MIN_COMPOSE=/path/to/docker-compose` to also run the mode matrix
against the declared minimum Compose.

# Copyright & License

Copyright (c) 2013-2026 Ghost Foundation - Released under the [MIT license](LICENSE).
