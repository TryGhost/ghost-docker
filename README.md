# Ghost Docker

Configuration to run Ghost and its services with Docker Compose.

> **This is the `next-docker` development branch.** It is being rebuilt around
> a manager image: a small CLI in a container, started by a bash launcher that
> uses Docker. It installs local and production sites, imports local Ghost-CLI
> sites, backs up and restores them, and updates image installations between
> beta releases, and moves installations of the released `main` layout onto it.
> Production import remains on the [roadmap](docs/ghost-cli-replacement.md). For a supported setup
> today, use the `main` branch.

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
afterwards. `backup` and `restore` protect its data; `self-update` moves image
installations to a newer stack release. Checkouts use Git and Compose directly.
See [docs/install.md](docs/install.md) for supported commands and recovery.

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
| [`docs/configuration.md`](docs/configuration.md) | The configuration contract: env files, value encoding, site modes and overrides |
| [`docs/caddy.md`](docs/caddy.md) | The site's routes, and how to change them |
| [`docs/bundle-v1.md`](docs/bundle-v1.md) | The Ghost-CLI migration bundle format |
| [`scripts/`](scripts) | Release tooling the workflows run: cutting a release, moving tags, release notes |
| [`pages/`](pages) | The front page of docker.ghost.org, published with each release beside `install.sh` |
| [`docs/architecture.md`](docs/architecture.md) | Current manager boundaries, state ownership and recovery invariants |
| [`docs/ghost-cli-replacement.md`](docs/ghost-cli-replacement.md) | Remaining requirements and release gates |

## Site modes

`install --local` selects Ghost and MySQL on loopback. A production install
adds Caddy with automatic HTTPS. [Configuration](docs/configuration.md#site-modes-and-profiles)
defines the modes and optional profiles; [installation](docs/install.md#optional-services)
explains how to enable them.

## Requirements

Docker Engine 25.0+ with the Compose v2.24+ plugin, and bash to start the
launcher. Nothing else on the host. Windows is supported through WSL2.

## Developing

Use Node 26 and the pnpm version pinned by each package (through Corepack).
The repository has two independent packages, `manager/` and `scripts/`; there is
no root bootstrap or check command.

From `manager/`:

```sh
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run test:integration   # real daemon, MySQL and Caddy; runs in a container
```

From `scripts/`, run `pnpm install --frozen-lockfile`, `pnpm run typecheck` and
`pnpm test` for release-tool changes. From the repository root:

```sh
tests/e2e/launcher.sh        # stand-in Docker, then the real image
tests/e2e/install.sh         # real installations: pulls images, binds 80 and 443
tests/e2e/self-update.sh     # release updates, failed-update write retention and recovery
tests/e2e/migrate-main.sh    # an installation of the released main layout, migrated
tests/e2e/backup.sh          # real backups and restores, including ActivityPub
tests/e2e/import.sh          # real Ghost-CLI sites exported and imported
```

Shell changes also pass ShellCheck. Unit tests substitute `Io` at the Engine API,
Compose and service-client boundaries (`manager/test/helpers.ts`). Integration
tests use the manager Dockerfile's `integration` stage to exercise real Compose
and network attachment. E2E tests check operator-visible outcomes. New tests
should prove behavior at the appropriate boundary, not duplicate the code path.

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
