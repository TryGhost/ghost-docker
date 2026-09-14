# Installation

```bash
curl -fsSL https://ghost.org/docker/bootstrap.sh | bash -s -- --domain example.com
```

Two scripts, with a deliberate boundary between them:

| Script | Owned by | Does |
| --- | --- | --- |
| `bootstrap.sh` | nothing — it is the thing you curl | Selects a release, clones it, runs that release's installer |
| `install.sh` | the checkout it lives in | Everything else: preflight, configuration, routing, verification |

The split exists so a site is always installed by the code it is pinned to.
`bootstrap.sh` resolves a tag, clones it, and `exec`s that checkout's
`install.sh`; it never installs anything itself. Its exit status is the
installer's.

**One checkout is one site.** `install.sh` installs into its own directory and
refuses `--dir` pointing anywhere else, naming `bootstrap.sh` as the way to
install into a new one.

## bootstrap.sh

```text
bootstrap.sh [--channel stable|beta] [--ref vX.Y.Z] [--dir PATH]
             [installer options...]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--channel` | `stable` | Newest release on that channel. `beta` also considers `vX.Y.Z-beta.N`. |
| `--ref` | resolved from the channel | Install this exact tag. A prerelease tag implies the beta channel. |
| `--dir` | `./ghost-docker` | Where the checkout goes. Must be empty or absent. |

Everything else is passed to the release's `install.sh` unchanged.

Releases are selected in **semver order**, not lexically: `v1.10.0` is newer
than `v1.9.0`, `v1.2.0-beta.10` is newer than `v1.2.0-beta.2`, and `v1.2.0` is
newer than any `v1.2.0-beta.N`. `GD_BOOTSTRAP_REPO` overrides the source
repository, which is how the tests install from a candidate release built out of
the working tree.

## install.sh

```text
install.sh [--local | --domain example.com [--admin-domain admin.example.com]]
           [--dir PATH] [--port 2368] [--version 6.3.1]
           [--channel stable|beta] [--ref vX.Y.Z]
           [--with analytics,activitypub]
           [--no-prompt] [--no-start]
```

| Option | Meaning |
| --- | --- |
| `--local` | Ghost and MySQL, published on `127.0.0.1:PORT`. `NODE_ENV=development`, `RESTART_POLICY=no`. |
| `--domain DOMAIN` | Production: Ghost, MySQL and Caddy with HTTPS on that domain. |
| `--admin-domain DOMAIN` | A separate Ghost Admin domain. Production only. |
| `--port PORT` | The loopback port. Omitted: the first free port at or above 2368. |
| `--version VERSION` | A Ghost version (`6.3.1`) or a full image tag (`6-alpine`). |
| `--with LIST` | `analytics`, `activitypub`, or both. |
| `--no-prompt` | Never ask. Every required input must then be supplied. |
| `--no-start` | Write the configuration and routes; start no application services. |

Exit codes: `0` success, `1` failure, `2` usage error, `3` a documented option
whose step has not landed.

### Prompts

Prompts read from `/dev/tty`, so an installer piped from `curl` can still ask a
question. **Every required input has a flag or environment variable**, so
`--no-prompt` is fully scriptable, and no prompt has a silent default: without a
terminal, a required answer is an error naming the flag that supplies it.

### Options that are not implemented yet

These are part of the documented interface and fail with exit code `3`, naming
the step they belong to, rather than being reported as unknown options:

| Option | Lands in |
| --- | --- |
| `--import BUNDLE` | S5. `scripts/migrate.sh` is the supported migration path today. |
| `--with supervisor` | S8. The profile is reserved and defines no service. |
| `--image-registry`, `--ghost-channel`, `--without` | S14–S16. |

## What installation does

1. **Preflight**, mode aware, entirely in host shell so it still works when
   Docker is missing or stopped: platform, required tools, Docker Engine and
   Compose versions, a writable site directory, disk, memory, and the ports the
   selected mode needs.
2. **Identity.** A stable `COMPOSE_PROJECT_NAME` — `ghost-example-com` in
   production, `ghost-local-<directory>` locally — kept independent of the
   directory name and used as the suffix of every service network alias.
3. **Secrets.** Fresh application and root database passwords, 192 bits each.
   Nothing ships with a default credential.
4. **Exact Ghost image.** The requested version is pulled, and the image is
   asked for its own `GHOST_VERSION`, `GHOST_CONTENT` and `GHOST_INSTALL`. The
   *exact* version tag is written to `.env` — never a moving one — and the
   digest is recorded in `.ghost-docker.json` for recovery. `GHOST_CONTENT_PATH`
   and `GHOST_TINYBIRD_PATH` come from the image, so the mounted content
   directory and the image layout cannot disagree.
5. **Configuration.** `.env` and `ghost.env`, both mode `0600`. `.env` starts
   from the tracked example so its comments survive; `ghost.env` is written
   fresh, because the example's SMTP block is a placeholder and a site shipping
   with `smtp.example.com` configured fails to send mail in a way that looks
   like a Ghost bug.
6. **Routing**, in production: routes are rendered, validated, installed and
   verified through `scripts/caddy.sh apply`. Files in `caddy/custom/` and
   `caddy/global/` are yours and are never touched.
7. **Metadata.** `.ghost-docker.json`, described in
   [configuration.md](configuration.md#installation-metadata).
8. **Start and verify**, unless `--no-start`: the database and Ghost must report
   *healthy* through their own health checks, and the Admin API must answer
   through the ingress the site actually uses. A running container is not
   readiness, and `up -d` returning zero is not a working site.

## Ports, and your existing proxy

**Installation never stops or reconfigures anything already running.** A server
may proxy other applications, and replacing its web server is not an installer's
decision to make.

- A port the installer *chooses* moves out of the way: with no `--port`, it
  takes the first free one at or above 2368.
- A port you *asked for* does not. `--port` on a busy port is an error, because
  silently using a different one produces a site at an address nothing else is
  configured for.
- In production, 80 and 443 are required. If something already holds them, the
  installation fails and names what holds it — a Docker container by name where
  it can. Nothing is stopped, and no configuration is written.

To run Ghost behind your own nginx or Apache, point it at
`127.0.0.1:${GHOST_PORT}` and edit `compose.yml` to drop the `caddy` service or
move it off 80/443. That is an unsupported manual customization and stack
updates may touch `compose.yml`; see
[configuration.md](configuration.md#site-modes-and-profiles) for why
bring-your-own-proxy is not a mode.

## Optional services

`--with analytics` needs Tinybird credentials. They are read from the
environment rather than taken as flags, so an unattended install does not put a
token into the process table or the shell history:

```bash
TINYBIRD_TRACKER_TOKEN=... TINYBIRD_ADMIN_TOKEN=... TINYBIRD_WORKSPACE_ID=... \
  ./install.sh --domain example.com --with analytics --no-prompt
```

Without them, and without a terminal to ask, installation fails rather than
configuring a half-enabled profile. The Tinybird login is interactive and is not
run by the installer; the summary prints the two commands that finish it. See
[TINYBIRD.md](../TINYBIRD.md).

`--with activitypub` needs no credentials. Either optional profile sets
`labs__publicAPI` in `ghost.env`, which both features require.

## Host tools

Beyond `bash`, the installer requires **`docker`** (with Compose v2) and
**`jq`**; `bootstrap.sh` also needs **`git`**. Everything else it invokes is
POSIX and listed in `GD_HOST_UTILITIES` in `scripts/lib/preflight.sh`. That list
is the tool contract, and `tests/install-e2e.test.mjs` runs an install with a
`PATH` containing exactly it — so a GNU-only or unusual dependency added to a
code path fails a test rather than someone's server.

Node.js is **not** required to install or run a site. It runs the test suite.

Docker access is established by **asking the daemon**, never by checking
`docker` group membership: neither rootless Docker nor a remote `DOCKER_HOST`
involves that group, and being in it does not mean the daemon is running. A
daemon that has wedged answers nothing rather than returning an error, so every
read-only probe has a deadline and reports that state instead of hanging.

## After installation

```bash
scripts/site.sh check      # diagnose this site
scripts/site.sh list       # every ghost-docker container on this host
scripts/site.sh info       # the recorded installation metadata
```

`site.sh list` reads Docker's own labels, including stopped containers. There is
no host-wide registry of installations, so a checkout whose containers have
never been created cannot be discovered from outside it — `list` says so rather
than implying the list is complete.

`site.sh check` validates the configuration for its mode, verifies a real client
connection to the application database, checks service health, and re-runs the
ingress verification. It degrades to useful host-level output when Docker is
unreachable, which is when it matters most.
