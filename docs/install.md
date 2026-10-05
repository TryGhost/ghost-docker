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
           [--import BUNDLE] [--no-prompt] [--no-start]
```

| Option | Meaning |
| --- | --- |
| `--local` | Ghost and MySQL, published on `127.0.0.1:PORT`. `NODE_ENV=development`, `RESTART_POLICY=no`. |
| `--domain DOMAIN` | Production: Ghost, MySQL and Caddy with HTTPS on that domain. |
| `--admin-domain DOMAIN` | A separate Ghost Admin domain. Production only. |
| `--port PORT` | The loopback port. Omitted: the first free port at or above 2368. |
| `--version VERSION` | A Ghost version (`6.3.1`) or a full image tag (`6-alpine`). |
| `--with LIST` | `analytics`, `activitypub`, or both. |
| `--import BUNDLE` | Import a local Ghost-CLI site from a migration bundle. See [Importing a Ghost-CLI site](#importing-a-ghost-cli-site). |
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
| `--import` of a `portable` bundle | S5d. Export without `--sqlite-format portable` to get a `mysql-data` bundle. |
| `--import` of a production site, or with `--domain` | S5e. `scripts/migrate.sh` is the supported path for a production site today. |
| `--migrate` | S5c. Run `ghost migrate-export` yourself and pass the bundle to `--import`. |
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
   repository digest is required and written as `GHOST_IMAGE_REF=ghost@sha256:...`
   in `.env`, and recorded in `.ghost-docker.json` for recovery. Both Ghost and
   Tinybird sync use that pin; the requested tag is provenance only.
   `GHOST_CONTENT_PATH` and `GHOST_TINYBIRD_PATH` come from the image, so the mounted content
   directory and the image layout cannot disagree.
5. **Configuration.** `.env` and `ghost.env`, both mode `0600`. `.env` is generated
   in one atomic write, with optional defaults documented in `.env.example`.
   `ghost.env` is written fresh, because the example's SMTP block is a placeholder and a site shipping
   with `smtp.example.com` configured fails to send mail in a way that looks
   like a Ghost bug.
6. **Routing**, in production: routes are rendered, validated, installed and
   verified through `scripts/caddy.sh apply`. Files in `caddy/custom/` and
   `caddy/global/` are yours and are never touched.
7. **Metadata.** `.ghost-docker.json`, described in
   [configuration.md](configuration.md#installation-metadata).
8. **Start and verify**, unless `--no-start`: Compose `up --wait --wait-timeout`
   waits for the selected services; the database and Ghost must report
   *healthy* through their own health checks, and the Admin API must answer
   through the ingress the site actually uses. A running container is not
   readiness, and `up -d` returning zero is not a working site.

## Importing a Ghost-CLI site

A local Ghost-CLI site — the kind `ghost install local` makes — moves to Docker
in two commands. Export it with Ghost-CLI 1.33.0 or later, from the site's
directory:

```bash
ghost migrate-export --output ~/my-site-bundle --archive tgz
```

Then install from the bundle:

```bash
curl -fsSL https://ghost.org/docker/bootstrap.sh | bash -s -- --import ~/my-site-bundle.tgz
```

or, in a checkout you already have, `./install.sh --import ~/my-site-bundle.tgz`.
No `--local` is needed: the bundle says what kind of site it is.

The exporter picks the bundle kind from the source database:

| Source | Bundle kind | Imported how |
| --- | --- | --- |
| Local SQLite | `mysql-data` | Ghost creates its schema in a fresh MySQL database, then every row is loaded and the row counts are compared with the bundle's. |
| Local MySQL | `mysql-dump` | The dump is loaded into a fresh MySQL database. |

Either way the database arrives whole: posts, members, staff accounts and their
passwords, settings, and history. Themes, images, files, media, routes and
redirects come with it, and so does the Ghost configuration from the source's
`config.*.json`, written to `ghost.env`.

What to expect:

- **The exact source version.** The site is installed at the Ghost version it
  was exported from, because a rows-only bundle only fits the schema of that
  version. Upgrade afterwards. `--version` naming a different version is an
  error. A source older than Ghost 6 is refused: run `ghost update` there first.
- **A new address.** The site is served at `http://localhost:PORT`, on the
  first free port at or above 2368 unless `--port` says otherwise. An ordinary
  export leaves the source running, so the two sit side by side until you run
  `ghost stop` in the source directory. They are separate copies from the
  moment of export.
- **Nothing is merged.** The checkout must not already hold a site, and
  `data/ghost` and `data/mysql` must be empty.
- **The bundle is checked before anything changes.** It is unpacked into a
  private staging directory inside the checkout and validated there. A path
  that would leave the bundle, a symbolic link, or anything else that is not a
  plain file or directory is refused, as is a manifest that does not meet the
  [contract](bundle-v1.md). The database is loaded as the site's own database
  user, never as root. Importing a bundle still means trusting it: its
  database and themes become your site, so import bundles you made.
- **A failure leaves nothing behind.** If any step fails — the dump will not
  load, the row counts disagree, Ghost will not start on the imported data —
  the containers, data and configuration the import created are removed and
  the checkout is as it was, so the same command can simply be run again. The
  bundle and the source site are never modified. Set `GD_IMPORT_KEEP_FAILED=1`
  to keep the wreckage for inspection instead; it cannot be started, and the
  next `--import` clears it first.

Bundles are accepted as a directory, a `.tgz`, or a plain `.tar`, and as a
`.zip` (`--archive zip`) where `unzip` is installed. Archives are unpacked with
the host's `tar`.

Mail settings travel with the configuration. A local site set up to send
through a real mail service will send through it from Docker too.

Not yet supported, each refused with a message that says so: `portable`
bundles, bundles from a production installation, combining `--import` with
`--with`, and `--migrate` (running the export for you). See the
[plan](ghost-cli-replacement.md) for where each lands, and
[bundle-v1.md](bundle-v1.md) for the bundle contract.

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

## Windows

Supported through **WSL2**, with Docker Desktop's WSL integration enabled for
your distribution (Docker Desktop → Settings → Resources → WSL integration).
Inside WSL the host is Linux, and everything in this document applies as
written. PowerShell, `cmd` and Git Bash are not supported: the scripts are
bash and depend on Docker bind mounts, file modes and devices that those
environments do not provide. Git Bash is refused with a message saying so.

- **Install into the Linux filesystem**, for example `~/ghost`, not under
  `/mnt/c`. On a Windows drive file permissions are not enforced, so `.env` is
  not private, bind mounts are slow, and MySQL's data directory is unreliable.
  Preflight warns when the site directory is on one.
- **Editing themes.** The site's files are inside WSL, at
  `data/ghost/themes` in the checkout. Open them from Windows through
  `\\wsl$\<distribution>\home\<you>\ghost`, or with an editor's WSL
  integration.
- **Migrating a Ghost-CLI site that runs on Windows.** Export it on Windows
  with `ghost migrate-export`, then import the bundle from WSL through its
  `/mnt/c/...` path, for example
  `./install.sh --import /mnt/c/Users/you/my-site-bundle.tgz`. Reading a bundle
  from a Windows drive is fine; only the site itself has to live in WSL.

This path follows from how WSL2 works rather than from a test run: the test
suite runs on Linux and macOS. Treat it as expected to work, and report what
does not.

## Host tools

Beyond `bash`, the installer requires **`docker`** (with Compose v2),
**`jq`** and **`curl`**; `bootstrap.sh` also needs **`git`**. Other utilities
use the supported Linux/macOS interfaces and are listed in `GD_HOST_UTILITIES`
in `scripts/lib/preflight.sh`. That list
is the tool contract, and `tests/install-e2e.test.mjs` runs an install with a
`PATH` containing exactly it — so a GNU-only or unusual dependency added to a
code path fails a test rather than someone's server.

Changing `GHOST_VERSION` alone does not change an installed site: `GHOST_IMAGE_REF`
is authoritative. A deliberate image change must update that pin and its metadata.

The HTTPS probe checks routing through the published host port with the correct
Host/SNI. It accepts internal certificates and does not certify public TLS trust.

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
