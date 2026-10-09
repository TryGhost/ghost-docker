# Ghost Docker

Configuration to run Ghost and its services with Docker Compose.

> **This is the `next-docker` development branch.** It is being rebuilt around
> a manager image: a small CLI in a container, started by a launcher that needs
> only Docker. It installs local and production sites, imports local Ghost-CLI
> sites, and updates between its own beta releases; backups and production
> imports are still to come. See [the plan](docs/ghost-cli-replacement.md) for
> what lands when. For a supported setup today, use the `main` branch.

## The launcher

```sh
# Linux, macOS, and Windows through WSL2; or --domain example.com --email ops@example.com
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- install --local
./ghost-docker check
./ghost-docker self-update
```

`install` writes the configuration, generates credentials, pins Ghost to an
exact image digest, writes Caddy's routes, starts the site and
reaches it through its own ingress; a failed installation removes what it
created. `config`, `check`, `info`, `list` and `doctor` look after it
afterwards, and `self-update` moves it to a newer release of ghost-docker. See [docs/install.md](docs/install.md). The other commands in these
documents are the planned interface, and each arrives with its plan step.

Everything runs in a container. From a clone of this repository the launcher
builds that image from the clone; anywhere else it uses the published one,
`ghcr.io/tryghost/ghost-docker`: the newest beta, a `--channel`, or a
`--release`. The site directory is the current directory,
or `--dir PATH`.

On Windows, run the launcher inside WSL2: install Docker Desktop with the
WSL2 backend, open a WSL terminal, and use `./ghost-docker` there as on
Linux. There is no native Windows launcher.

## What is here

| Path | What it is |
| --- | --- |
| [`ghost-docker`](ghost-docker) | The launcher: the only code that runs on the host |
| [`manager/`](manager) | The CLI, and the image it runs in |
| [`compose.yml`](compose.yml) | The stack: Ghost, MySQL, Caddy, and optional analytics and ActivityPub services |
| [`caddy/`](caddy) | The tracked Caddyfile and snippets, and where the site's routes go |
| [`.env.example`](.env.example), [`ghost.env.example`](ghost.env.example) | Operator settings and Ghost application settings, deliberately separate |
| [`docs/install.md`](docs/install.md) | Installing a site, and how it is verified |
| [`docs/configuration.md`](docs/configuration.md) | The configuration contract: the two files, value encoding, site modes, metadata |
| [`docs/caddy.md`](docs/caddy.md) | The site's routes, and how to change them |
| [`docs/bundle-v1.md`](docs/bundle-v1.md) | The Ghost-CLI migration bundle format |
| [`scripts/`](scripts) | Release tooling the workflows run: cutting a release, moving tags, release notes |
| [`pages/`](pages) | The front page of docker.ghost.org, published with each release beside `install.sh` |
| [`docs/ghost-cli-replacement.md`](docs/ghost-cli-replacement.md) | The plan: architecture, contracts, and steps |

## Site modes

Exactly one site mode is selected through `COMPOSE_PROFILES`:

```sh
# Local: Ghost + MySQL, published on 127.0.0.1:${GHOST_PORT}
COMPOSE_PROFILES=local docker compose up -d

# Production: Ghost + MySQL + Caddy with automatic HTTPS
COMPOSE_PROFILES=production docker compose up -d
```

Optional per-site profiles are additive: `analytics`, `activitypub`.

`./ghost-docker install` sets them, and writes a production site's routes into
`caddy/sites/site.caddy` once; the file is yours from then on.

## Requirements

Docker Engine 25.0+ with the Compose v2.24+ plugin, and bash to start the
launcher. Nothing else on the host. Windows is supported through WSL2.

## Developing

```sh
cd manager && pnpm install     # pnpm via corepack: npm i -g corepack && corepack enable
pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm test

manager/test/integration/run.sh  # the manager against the real daemon, MySQL and Caddy

tests/e2e/launcher.sh        # the launcher against a stand-in docker, then the real image
tests/e2e/install.sh         # real installations: pulls images, binds 80 and 443
tests/e2e/self-update.sh     # real updates between releases built here; a clone refused, backed up and restored
tests/e2e/backup.sh          # real backups and restores, with ActivityPub
tests/e2e/import.sh          # real Ghost-CLI sites exported and imported
```

An e2e script fails when this host cannot run one of its scenarios (no
Docker, port 80 or 443 already held, no `mysqldump`), so a passing run, and
CI, ran everything. `GD_E2E_ALLOW_SKIP=1` skips those on purpose instead, and
the run ends by naming each one it skipped.

Releases are cut by the Release workflow (Actions → Release → Run workflow),
with [`scripts/release.ts`](scripts/release.ts), as Ghost's and Ghost-CLI's are; see [docs/install.md](docs/install.md#releases).

## IPv6 networking

IPv6 networking is opt-in because it requires newer Docker and Docker Compose versions than the base setup. Enable it by including the IPv6 override file:

```sh
docker compose -f compose.yml -f compose.ipv6.yml up -d
```

## Analytics

See [TINYBIRD.md](TINYBIRD.md).

# Copyright & License

Copyright (c) 2013-2026 Ghost Foundation - Released under the [MIT license](LICENSE).
