# Installation

```bash
mkdir ~/my-site && cd ~/my-site
curl -fsSLO https://raw.githubusercontent.com/TryGhost/ghost-docker/next-docker/ghost-docker && chmod +x ghost-docker
./ghost-docker install --local                     # or: --domain example.com
```

The launcher served at `docker.ghost.org`, and the `stable`/`beta` release
channels it resolves, land in S6a. Until then a launcher with no checkout
beside it runs the `edge` image, built from this branch.

Everything happens in the manager image; the host needs Docker Engine 25.0+
with the Compose v2.24+ plugin, and bash. **One directory is one site.** The
site directory is the current directory, or `--dir PATH`.

There are two ways to have a site, and `install` handles both:

| | Image mode | Clone mode |
| --- | --- | --- |
| How | A copy of the launcher, in an empty directory | `./ghost-docker` inside a clone of this repository |
| The stack's files | Written by `install` from the image: `compose.yml`, `caddy/`, `mysql-init/`, `tinybird/`, the examples, with a checksum of each recorded in `.ghost-docker.json` | Used in place; nothing is written over them |
| The launcher | Rewritten into the site, pinned to the image that installed it | The checkout's own, which builds the image from the checkout |

After installation every command is `./ghost-docker ...` from the site
directory, and day-to-day operation is plain `docker compose`.

## install

```text
ghost-docker install [--local | --domain example.com [--admin-domain admin.example.com]
                                [--email ops@example.com]]
                     [--port 2368] [--version 6.3.1] [--with activitypub]
                     [--no-prompt] [--no-start]
ghost-docker install --import BUNDLE [--port 2368] [--no-prompt] [--no-start]
```

| Option | Meaning |
| --- | --- |
| `--local` | Ghost and MySQL, published on `127.0.0.1:PORT`. `NODE_ENV=development`, `RESTART_POLICY=no`. |
| `--domain DOMAIN` | Production: Ghost, MySQL and Caddy with HTTPS on that domain. |
| `--admin-domain DOMAIN` | A separate Ghost Admin domain. Production only. |
| `--email EMAIL` | The ACME account email. Production only; see below. |
| `--port PORT` | The loopback port Ghost is published on, in both modes. Omitted: the first at or above 2368 that is free (see [Ports](#ports-and-your-existing-proxy)). |
| `--version VERSION` | A Ghost version (`6.3.1`, which means `6.3.1-next-alpine`) or a full image tag (`6-alpine`). Resolved to an exact digest. |
| `--with LIST` | `activitypub`. `analytics` is added after installation; see below. |
| `--no-prompt` | Never ask: every input must then be an option. |
| `--no-start` | Write the configuration and routes; create no containers. |
| `--import BUNDLE` | Import a local Ghost-CLI site from the bundle `ghost migrate-export` made; see [Importing a Ghost-CLI site](#importing-a-ghost-cli-site). |

With neither `--local` nor `--domain`, `install` asks which kind of site, and
for a production site its domain. It asks only at a terminal, including when
the launcher was piped from curl. Without one, or with `--no-prompt`, a missing
answer is a usage error naming the option that supplies it; nothing has a
silent default. Every question has an option, so a script never needs to answer
one.

Exit statuses: `0` installed, `1` failed, `2` a usage error. Options the plan
documents for later steps (`--channel` and `--ref` in S6a, `--with supervisor`
in S8) do not exist yet, and are usage errors like any unknown option.

### The ACME email

`--email` is the account Caddy registers with Let's Encrypt (and ZeroSSL, its
fallback). Caddy issues certificates without one; with one, Let's Encrypt
sends expiry and incident notices to it. Omitted means none. It is written
into the site's routes, `caddy/sites/site.caddy`, as `tls <email>`; to change
it later, edit that line and reload Caddy (see [caddy.md](caddy.md)).

### Optional services

`--with activitypub` runs the site's own ActivityPub service, its migration
job and its database; it needs nothing else.

It also sets `labs__publicAPI` in `ghost.env`, which ActivityPub and
analytics both need.

Analytics is set up after installation: its Tinybird login is interactive, in a
browser, and Ghost waits for the Tinybird jobs to finish, so a site cannot start
with it before that login. Add it to an installed site: set the tokens with
`./ghost-docker config set .env TINYBIRD_TRACKER_TOKEN ...` (and
`TINYBIRD_ADMIN_TOKEN`, `TINYBIRD_WORKSPACE_ID`), `labs__publicAPI` in
`ghost.env`, add `analytics` to `COMPOSE_PROFILES`, add its route to
`caddy/sites/site.caddy` in production, and finish the interactive Tinybird login as
[TINYBIRD.md](../TINYBIRD.md) describes. `--with analytics` says so and exits
2.

## What installation does

1. **Refuses what it should not touch**, before anything else: a directory
   that already holds a site (`.env` or `.ghost-docker.json`), stack files the
   payload would write over, and non-empty `data/ghost` or `data/mysql`.
2. **Preflight**: everything `./ghost-docker doctor` checks (Docker and
   Compose versions, platform and architecture, the site directory, file
   ownership, and that a sibling container sees the directory at the same
   path), and disk and memory, which warn rather than refuse.
3. **Ports Docker knows about.** The default port skips any that a container
   publishes. An explicit `--port`, or 80 and 443 for a production site, that
   a container publishes is an error naming the container. Nothing is
   stopped. Ports held by anything else are found when the services start;
   see below.
4. **The exact Ghost image.** The requested tag is pulled, and the pulled
   image is asked for its repository digest and its own `GHOST_VERSION`,
   `GHOST_CONTENT` and `GHOST_INSTALL`; no digest is an error. The pin is written as
   `GHOST_IMAGE_REF=ghost@sha256:...`; Ghost and Tinybird sync both run it, and
   changing `GHOST_VERSION` alone never changes what a site runs.
5. **Identity and secrets.** A stable `COMPOSE_PROJECT_NAME` — `ghost-example-com`
   in production, `ghost-local-<directory>` locally — kept in `.env` and
   independent of the directory name afterwards. Fresh database passwords of
   192 bits each; nothing has a default credential.
6. **Configuration.** `.env` in one atomic write, and a fresh `ghost.env`,
   both mode `0600`, through the one encoder (see
   [configuration.md](configuration.md#value-encoding)). `ghost.env` is not a
   copy of the example, whose SMTP block is a placeholder.
7. **Routing**, in production: `caddy/sites/site.caddy`, written once with
   the site's domains, its network aliases and every snippet argument. It is
   yours from then on; see [caddy.md](caddy.md).
8. **Metadata**: `.ghost-docker.json`, described in
   [configuration.md](configuration.md#installation-metadata).
9. **Start and verify**, unless `--no-start`: `docker compose up --wait`, so
   MySQL and Ghost must pass their own health checks, then the site is reached
   through its own ingress (next section). A running container is not
   readiness.

**A failed installation removes what it created** — containers, network,
volumes, the data directories, `.env`, `ghost.env`, the metadata and the
written stack files — so the same command can simply be run again in the same
directory. That covers a port conflict, a failed pull, a service that never
becomes healthy, and a site that starts but cannot be reached. Before removing
anything it prints the services' last log lines.

## Importing a Ghost-CLI site

A local Ghost-CLI site — the kind `ghost install local` makes — moves to Docker
in two commands. Export it with Ghost-CLI 1.33.0 or later, from the site's
directory:

```bash
ghost migrate-export --output ~/my-site-bundle --archive tgz
```

Then, in a new empty directory, install from the bundle:

```bash
./ghost-docker install --import ~/my-site-bundle.tgz
```

No `--local` is needed: the bundle says what kind of site it is. The launcher
mounts the bundle into the manager read-only, at its own path; the bundle can
be anywhere on the host.

The exporter picks the bundle kind from the source database:

| Source | Bundle kind | Imported how |
| --- | --- | --- |
| Local SQLite | `mysql-data` | Ghost starts once on a fresh MySQL database to create its schema, then every row is loaded and the row counts are compared with the bundle's. |
| Local MySQL | `mysql-dump` | The dump is loaded into a fresh MySQL database. |

Either way the database arrives whole: posts, members, staff accounts and their
passwords, settings, and history. Themes, images, files, media, routes and
redirects come with it, and so does the Ghost configuration from the source's
`config.*.json`, written to `ghost.env` through the same encoder as every other
value. Keys the container sets itself (`url`, `database__*`, `server__*`,
`paths__*` and the rest listed in [bundle-v1.md](bundle-v1.md)) are not
carried; `install` names each one it leaves out, without its value.

What to expect:

- **The exact source version.** The site is installed at the Ghost version it
  was exported from, because a rows-only bundle only fits the schema of that
  version: `VERSION-next-alpine`, or `VERSION-alpine` for a release only
  published in that layout. Upgrade afterwards. `--version` naming a different
  version is a usage error. A source older than Ghost 6 is refused: run
  `ghost update` there first.
- **A new address.** The site is served at `http://localhost:PORT`, on the
  first free port at or above 2368 unless `--port` says
  otherwise. An ordinary export leaves the source running, so the two sit side
  by side until you run `ghost stop` in the source directory. They are separate
  copies from the moment of export.
- **Nothing is merged.** The directory must not already hold a site, and
  `data/ghost` and `data/mysql` must be empty.
- **The bundle is checked before anything changes.** It is unpacked into a
  private staging directory (`.import`) inside the site directory and
  validated there. A path that would leave the bundle, a symbolic or hard
  link, a device or anything else that is not a plain file or directory is
  refused as it is read, as is a manifest that does not meet the
  [contract](bundle-v1.md). The database is loaded as the site's own database
  user, never as root. Importing a bundle still means trusting it: its
  database and themes become your site, so import bundles you made.
- **A failure leaves nothing behind.** If any step fails — the dump will not
  load, the row counts disagree, Ghost will not start on the imported data —
  the containers, data, configuration and stack files the import created are
  removed and the directory is as it was, so the same command can simply be
  run again. The bundle and the source site are never modified. Set
  `GD_IMPORT_KEEP_FAILED=1` to keep what it created for inspection instead.
- **An unfinished import cannot be started.** While an import runs, `.env`
  selects no Compose service (`COMPOSE_PROFILES=import-incomplete`) and
  `.ghost-docker-import` records what it has created. An import that was
  killed, or kept with `GD_IMPORT_KEEP_FAILED`, therefore starts nothing under
  `docker compose up`; an ordinary `install` there is refused, and the next
  `install --import` removes it first.

Bundles are accepted as a directory, a `.tgz`, a plain `.tar`, or a `.zip`
(`--archive zip`). The manager unpacks them itself; nothing on the host is
needed beyond the launcher's own requirements.

Mail settings travel with the configuration. A local site set up to send
through a real mail service will send through it from Docker too.

Refused, each with a message that says so:

- A `portable` bundle (`--sqlite-format portable`): Ghost Admin imports its
  content JSON and members CSV. The message gives the steps: install an empty
  site, import both files in Ghost Admin, copy the content directory. Export
  without `--sqlite-format portable` to get a `mysql-data` bundle instead.
- A bundle from a production installation, and `--import` with `--domain`,
  until production import and cutover (S5e).
- `--import` with `--with`: import the site first, then enable optional
  services.

See the [plan](ghost-cli-replacement.md) for where each lands, and
[bundle-v1.md](bundle-v1.md) for the bundle contract.

### Moving a site to Docker

The commands above copy a site and leave the source running beside the copy.
To move it instead, so that the Docker site takes over the source's address
and nothing is written to the source after it was copied, stop the source
first:

```bash
cd ~/sites/my-blog
ghost stop
ghost migrate-export --output ../my-blog-bundle
mkdir ../my-blog-docker && cd ../my-blog-docker
curl -fsSLO https://raw.githubusercontent.com/TryGhost/ghost-docker/next-docker/ghost-docker && chmod +x ghost-docker
./ghost-docker install --import ../my-blog-bundle --port 2368
```

- **Stop first.** The exporter stops a running site while it copies, and
  starts it again afterwards; it never starts a site that was stopped. Stopped
  first, the source stays stopped, so the copy is its final state.
- **The same address.** `--port` takes the source's port, which is
  `server.port` in its `config.development.json` (2368 unless it was
  installed with another). With the source stopped, the port is free, and the
  Docker site answers at the same `http://localhost:PORT`.
- **Outside the source.** The exporter refuses an output path inside the
  installation, and the Docker site's directory belongs beside it too, not in
  it.
- **If the import fails**, it removes what it created, and `ghost start` in
  the source brings the source back as it was. The bundle is unchanged, so
  the import can be run again from it.
- **Afterwards** the source is stopped and intact. Nothing removes it;
  `ghost start` there brings it back. The bundle holds the site's
  configuration, secrets included: remove it once you no longer need it.

Exporting needs Ghost-CLI 1.33.0 or later (`ghost --version`) and a source
on Ghost 6; on Ghost 5, run `ghost update` there first. When the exporter
refuses a SQLite site because some values would not load into MySQL, it lists
them: fix them in the source and export again, or move the site through Ghost
Admin with `ghost migrate-export --sqlite-format portable` (see the
`portable` refusal above). A Ghost-CLI site on native Windows is exported
there and imported from WSL2, with the bundle under `/mnt/c/`.

## Ports, and your existing proxy

**Installation never stops or reconfigures anything already running.** A
server may proxy other applications, and replacing its web server is not an
installer's decision.

- A port the installer *chooses* moves out of the way of containers, and on
  macOS (OrbStack, Docker Desktop) also of programs on the host, such as a
  Ghost-CLI site.
- A port you *asked for* does not: `--port` on a busy port is an error, because
  a site at an address nothing else expects is worse than a refusal.
- A production site needs 80 and 443. If a container holds them, installation
  stops before writing anything and names it. If another program holds them,
  Docker refuses to start Caddy; the error names the port, says nothing that
  was running was stopped, and the directory is as it was.

The manager runs in a container, so it sees a program outside Docker holding a
port in one of two ways. With Docker Engine on Linux, Docker refuses to publish
the port, and that is a clear error (tested). OrbStack publishes the port
anyway, and the program keeps answering on it, so there the manager asks first:
it connects to the port on `host.docker.internal`, which is the Mac itself,
before choosing Ghost's port or accepting `--port` (tested with OrbStack).
Docker Desktop provides the same name and is expected to behave the same, but
has not been tested. Ports 80 and 443 for a production site are not checked
this way; production is supported on Linux only. Wherever the host's ports
cannot be checked after starting, the installer says they were not verified,
and opening the URL is the check.

To run Ghost behind your own nginx or Apache instead, point it at
`127.0.0.1:${GHOST_PORT}` and edit `compose.yml` to drop the `caddy` service or
move it off 80/443. That is an unsupported manual customization, and stack
updates may touch `compose.yml`; see
[configuration.md](configuration.md#site-modes-and-profiles) for why.

## How a site is verified

`127.0.0.1` inside the manager is the manager, so the site is asked from inside
its own containers, and each answer is reported for what it is:

| Check | How | Reported as |
| --- | --- | --- |
| ghost | Its health check, which `up --wait` already required: the Admin API answers inside the container. | `ok` or `ERROR` |
| caddy | From the ghost container, over the site's network, Caddy is asked for `http://` and the host of `URL` (and of `ADMIN_URL`), and must redirect to HTTPS, which it does only for a name it serves. | `ok` or `ERROR` |
| https | Whether Caddy holds a certificate for the domain. **serving** names the issuer. **pending** means there is none yet: Caddy obtains one once the domain's DNS reaches this host, `./ghost-docker check` reports the change, and `docker compose logs caddy` shows each attempt and why it failed. | `ok` or `note` |
| published ports | The ports Docker says it published. A container cannot reach the host's own loopback interface, so they are not checked from there: opening the URL is that check. | `note` |

A production site installed before its DNS points at the host therefore passes
and reports HTTPS as pending. That is the expected state of a fresh
installation, not a failure. Internal TLS before DNS is deliberately not
offered; for a private name, put `tls internal` in a `caddy/custom/` file.

## After installation

```bash
./ghost-docker check      # diagnose this site: host, configuration, services, database, ingress
./ghost-docker info       # the recorded installation metadata
./ghost-docker list       # every ghost-docker container on this host, stopped ones included
./ghost-docker config get|set|validate
```

The routes are a file you edit (`caddy/sites/site.caddy`), followed by
`docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.

`list` reads Docker's own labels. There is no registry of installations, so a
site whose containers have never been created cannot be found from outside its
directory, and `list` says so.

`check` exits non-zero when anything is wrong. Its host and configuration
checks still run when Docker is unreachable, which is when they matter most.

## Windows

Through WSL2, with Docker Desktop's WSL integration enabled for your
distribution. Inside WSL the host is Linux and everything here applies. Install
into the Linux filesystem (for example `~/my-site`), not under `/mnt/c`: file
permissions are not enforced there, so `.env` would not be private, and MySQL's
data directory is unreliable on it.
