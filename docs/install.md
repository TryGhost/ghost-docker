# Installation

```bash
mkdir ~/my-site && cd ~/my-site
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- install --local   # or: --domain example.com
```

`install.sh` is the launcher, `ghost-docker`, from the newest release. Piped
into bash it installs the newest release on the `beta` channel; `install`
writes a copy of it into the site, and every later command is
`./ghost-docker ...` from there.

## Releases

A release is a version of the manager image, `ghcr.io/tryghost/ghost-docker`,
which carries the CLI and the stack's files. Releases are `vX.Y.Z` and
`vX.Y.Z-beta.N`, and are ordered by number: `v1.10.0` follows `v1.9.0`,
`beta.10` follows `beta.2`, and a release follows its own betas. Until sites
installed from the `main` branch can be moved to this layout, every release is
a beta.

| Choose | With | Runs |
| --- | --- | --- |
| A channel | `--channel stable` or `--channel beta` (the default) | The newest release on it. `beta` includes releases; `stable` has no betas. |
| A release | `--release vX.Y.Z` (`--to` for `self-update`) | Exactly that release |
| The development image | `GD_CHANNEL=edge` | `edge`, built from every push to `next-docker`. Not a release. |

These go to the launcher with the command: `curl -fsSL
https://docker.ghost.org/install.sh | bash -s -- install --local --release
v0.1.0-beta.1`. A site always runs one image digest, never a channel: `install`
pins the site's launcher to the digest it ran as, and records the channel the
site follows, which `self-update` uses.

Everything happens in the manager image; the host needs Docker Engine 25.0+
with the Compose v2.24+ plugin, and bash. **One directory is one site.** The
site directory is the current directory, or `--dir PATH`.

There are two ways to have a site, and `install` handles both:

| | Image mode | Clone mode |
| --- | --- | --- |
| How | A copy of the launcher, in an empty directory | `./ghost-docker` inside a clone of this repository |
| The stack's files | Written by `install` from the image: `compose.yml`, `caddy/`, `mysql-init/`, `tinybird/`, the examples, with a checksum of each recorded in `.ghost-docker.json` | Used in place; nothing is written over them |
| The launcher | Rewritten into the site, pinned to the image that installed it | The checkout's own, which builds the image from the checkout |
| Updates | `./ghost-docker self-update` | git and Compose ([Updating a clone](#updating-a-clone)) |

After installation every command is `./ghost-docker ...` from the site
directory, and day-to-day operation is plain `docker compose`.

## install

```text
ghost-docker install [--local | --domain example.com [--admin-domain admin.example.com]
                                [--email ops@example.com]]
                     [--port 2368] [--version 6.61.0] [--with activitypub,mailpit]
                     [--channel stable|beta | --release vX.Y.Z] [--no-prompt] [--no-start]
ghost-docker install --import BUNDLE [--port 2368] [--with mailpit] [--no-prompt] [--no-start]
```

| Option | Meaning |
| --- | --- |
| `--local` | Ghost and MySQL, published on `127.0.0.1:PORT`. `NODE_ENV=development`, `RESTART_POLICY=no`. |
| `--domain DOMAIN` | Production: Ghost, MySQL and Caddy with HTTPS on that domain. |
| `--admin-domain DOMAIN` | A separate Ghost Admin domain. Production only. |
| `--email EMAIL` | The ACME account email. Production only; see below. |
| `--port PORT` | The loopback port Ghost is published on, in both modes. Omitted: the first at or above 2368 that is free (see [Ports](#ports-and-your-existing-proxy)). |
| `--version VERSION` | A Ghost version (`6.61.0`, which means `6.61.0-next-alpine`) or a full image tag (`6-next-alpine`). Resolved to an exact digest. Only the `next` variants' layout runs: an image installed by Ghost-CLI, such as the `-alpine` tags, is refused. |
| `--with LIST` | `activitypub`, and `mailpit` for a local site. `analytics` is added after installation; see below. |
| `--channel CHANNEL` | Install the newest release on `stable` or `beta`; see [Releases](#releases). |
| `--release vX.Y.Z` | Install that release. |
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
documents for later steps (`--with supervisor` in S8) do not exist yet, and
are usage errors like any unknown option.

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

`--with mailpit`, for a local site only, runs [Mailpit](https://mailpit.axllent.org)
beside Ghost and sends Ghost's mail to it: staff invites, password resets and
member sign-in links land in a web inbox at `http://127.0.0.1:MAILPIT_PORT`
instead of going nowhere. `install` writes the SMTP settings into `ghost.env`
(`mail__transport`, `mail__options__host` set to the site's
`mailpit-${COMPOSE_PROJECT_NAME}` alias, `mail__options__port`,
`mail__options__secure`); they are yours from then on, like any other line
there. The inbox is published on the loopback interface only, on the first port
at or above 8025 that is free, chosen the way Ghost's is, and kept in
`data/mailpit` across restarts. Newsletters are sent through Mailgun's API,
not SMTP, so Mailpit never sees them. A production site cannot select it:
`--domain` with `--with mailpit` is a usage error, and `config validate`
rejects `mailpit` beside `production` in `COMPOSE_PROFILES`, because it would
catch the site's real mail.

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
   payload would write over, and non-empty `data/ghost`, `data/mysql` or
   `data/mailpit`.
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
   in production, `ghost-local-<directory>-<adjective>-<animal>` locally
   (`ghost-local-blog-secondary-roadrunner`), chosen so that no project on the
   daemon has it — kept in `.env` and independent of the directory name
   afterwards. Two local sites in directories of the same name are two
   projects. A production name another directory's containers already have is
   refused: Compose would take them for this site's. Fresh database passwords of
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
in two commands, once it runs **Ghost 6.61.0 or later**: the first release
published as a `next` image, which is what the import runs. Bring the source up
to date first, in the site's directory, and check the site still works:

```bash
ghost update
```

Then export it with Ghost-CLI 1.33.0 or later:

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
  version: `VERSION-next-alpine`. Upgrade afterwards. `--version` naming a
  different version is a usage error. A bundle from a source older than Ghost
  6.61.0 is refused before anything is created, whichever Ghost-CLI wrote it:
  run `ghost update` in the source, check the site, and export again.
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
through a real mail service will send through it from Docker too, unless
`--with mailpit` is given: then the source's `mail__transport` and
`mail__options__*` are left out (and named, as above), Mailpit's are written
instead, and the imported copy's mail, to real members included, goes to the
inbox. `mail__from` is kept. `--with mailpit` is the only optional service an
import takes; enable the others afterwards.

A `portable` bundle (`--sqlite-format portable`) has no database to load.
The import installs the site and places its content, and Ghost creates its own
database when it starts. The bundle's content JSON and members CSV land in
`data/ghost/data/`, and the summary says what is left to do in Ghost Admin:

1. Create the owner account.
2. Import the content JSON in Settings, Import/Export.
3. Import the members CSV in Members, Import.
4. Activate the theme in Settings, Design.

A portable export carries no integrations, staff logins or Stripe connection,
so set those up again. Export without `--sqlite-format portable` to get a
`mysql-data` bundle, which the import loads completely.

Refused, each with a message that says so:

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
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- install --import ../my-blog-bundle --port 2368
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
- **A theme you develop through a link** in `content/themes/` arrives as a
  copy: the exporter follows the link and copies the folder, so edits there
  no longer reach the site. To keep developing it, mount the folder yourself
  with a `compose.override.yml`; see [Your own Compose
  overrides](configuration.md#your-own-compose-overrides).

Exporting needs Ghost-CLI 1.33.0 or later (`ghost --version`) and a source
on Ghost 6.61.0 or later; on anything older, run `ghost update` there and check
the site works before exporting. When the exporter
refuses a SQLite site because some values would not load into MySQL, it lists
them: fix them in the source and export again, or move the site through Ghost
Admin with `ghost migrate-export --sqlite-format portable` (see the
`portable` bundle above). A Ghost-CLI site on native Windows is exported
there and imported from WSL2, with the bundle under `/mnt/c/`.

## Ports, and your existing proxy

**Installation never stops or reconfigures anything already running.** A
server may proxy other applications, and replacing its web server is not an
installer's decision.

- A port the installer *chooses* moves out of the way of containers, and on
  macOS (OrbStack, Docker Desktop) also of programs on the host, such as a
  Ghost-CLI site. A ghost-docker site that is stopped (`docker compose stop`)
  keeps its port: its containers publish it again when they start. A site
  taken down with `docker compose down` has no containers left, so nothing
  records its port, and a new site may be given the same one.
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

Each service is judged by its own health check, which `up --wait` already
required. `127.0.0.1` inside the manager is the manager, so for the question
no health check answers, whether Caddy serves the site, the manager joins the
site's own Docker network, asks Caddy for Ghost over HTTPS, and leaves again.
Each answer is reported for what it is:

| Check | How | Reported as |
| --- | --- | --- |
| ghost | Its health check: the Admin API answers inside the container. | `ok` or `ERROR` |
| caddy | Its health check: its admin API answers, with its configuration loaded. That says Caddy is up, not that it serves each name; **https** shows that once there is a certificate. | `ok` or `ERROR` |
| https | An HTTPS request to Caddy's container for Ghost's `/ghost/api/admin/site/`, with the domain as its server name and Host, as a browser asks. **serving** means Ghost answered through Caddy, and names the certificate's issuer and expiry; a certificate from a CA browsers do not trust (staging, or Caddy's internal CA) is a `warning`. **pending** means Caddy has no certificate for the name yet, so Ghost could not be asked through it: Caddy obtains one once the domain's DNS reaches this host, `./ghost-docker check` reports the change, and `docker compose logs caddy` shows each attempt. Caddy answering with something other than Ghost (a broken route, a 502), or an out-of-date certificate, is an `ERROR`. | `ok`, `warning`, `note` or `ERROR` |
| admin https | With an admin domain of its own: the same, for that name. On the site's domain, Ghost answering the Admin API path with a redirect to the admin domain counts as Ghost answering. | `ok`, `warning`, `note` or `ERROR` |
| mailpit | With `--with mailpit`: its health check. The check names `mailpit-${COMPOSE_PROJECT_NAME}:1025`, where Ghost sends mail. | `ok` or `ERROR` |
| published ports | The ports Docker says it published. A container cannot reach the host's own loopback interface, so they are not checked from there (the **https** request goes to Caddy's container, not to the host's ports): opening the URL is that check. | `note` |

`check` also judges every service the configuration runs by how compose.yml
says it runs (the `org.ghost.docker.lifecycle` label). A long-running service,
ActivityPub included, must have a container that is running, and healthy where
it has a health check: one that is missing or has stopped is an `ERROR`, even
one that exited 0. A one-shot job (`activitypub-migrate` and the Tinybird jobs)
passes once it has exited 0, is a `note` before it has run, and is an `ERROR`
when it failed. A container of a service the configuration no longer runs is
a `warning`.

A production site installed before its DNS points at the host therefore passes
and reports HTTPS as pending. That is the expected state of a fresh
installation, not a failure. Internal TLS before DNS is deliberately not
offered; for a private name, put `tls internal` in a `caddy/custom/` file.

## After installation

```bash
./ghost-docker check      # diagnose this site: host, configuration, services, database, ingress
./ghost-docker info       # the recorded installation metadata, and where Mailpit's inbox is
./ghost-docker list       # every ghost-docker site on this host, stopped ones included, and its directory
./ghost-docker config get|set|validate
./ghost-docker self-update  # to a newer release of ghost-docker; see below
./ghost-docker backup     # the databases, content and configuration, into backups/
./ghost-docker restore backups/<backup>
```

The routes are a file you edit (`caddy/sites/site.caddy`), followed by
`docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.

`list` asks Compose for its projects and their directories, and Docker's labels
for which of them are sites. There is no registry of installations, so a
site whose containers have never been created cannot be found from outside its
directory, and `list` says so.

`check` exits non-zero when anything is wrong. Its host and configuration
checks still run when Docker is unreachable, which is when they matter most.

## self-update

```text
ghost-docker self-update [--check] [--channel stable|beta | --to vX.Y.Z]
```

Moves a site installed from the image to a newer release of ghost-docker: the
stack's files and the manager image. A clone of the repository is updated with
git and Compose instead ([Updating a clone](#updating-a-clone)). **It never changes Ghost.** `.env`, and the exact Ghost image
`GHOST_IMAGE_REF` pins, are left as they are; updating Ghost is a separate
command, `update` (S7). When a release needs a newer Ghost than the site runs,
`self-update` stops before changing anything and says to upgrade Ghost first.

Without options it updates to the newest release on the channel the site
follows. `--channel` updates to the newest on another channel and follows that
one from then on; `--to` names a release. `--check` says what an update would
do and changes nothing. The update runs as the release it updates to: the
site's launcher starts that image, not the one it is pinned to.

| Option | Meaning |
| --- | --- |
| `--check` | Whether there is an update, and what it would change. Changes nothing. |
| `--channel CHANNEL` | The newest release on `stable` or `beta`, which the site then follows. |
| `--to vX.Y.Z` | Exactly that release. |

In order:

1. **Refusals.** An older release than the site runs is refused, as is a site
   with no `.ghost-docker.json`, a clone, another operation holding the site's lock,
   and a snapshot left by an update that did not finish. Nothing has changed.
2. **The lock.** `.ghost-docker.lock` names the operation and when it started.
   An update that is killed leaves it behind; `check` reports it, and it is
   removed by hand once the site is known to be right. Nothing removes it
   automatically.
3. **The release's images** are pulled while the site keeps running, so the
   slowest step is not part of the outage. An image that cannot be pulled
   yet is pulled again in step 6.
4. **A snapshot** of `.env`, `ghost.env`, the metadata, `compose.override.yml`,
   `caddy/sites/`, `caddy/custom/`, `caddy/global/` and every file the update
   writes, in `.ghost-docker-update/`.
5. **Ghost and ActivityPub are stopped, and a backup taken**, a consistent one
   as `backup --consistent` takes, in `backups/`: a release's services can
   migrate their databases (ActivityPub's, for one) even though Ghost does
   not change. It is kept until you remove it, and `self-update` names it.
   Unlike `backup`, the update does not start them again after the capture:
   they stay stopped until the release starts, or the site is put back, so
   nothing they would accept can be lost by loading the backup back. The
   site is unavailable from here until the release is healthy.
6. **The stack's files.** A file the manager wrote and nobody has edited is
   replaced. An edited one (its checksum is not the one recorded when it was
   written) is kept, the release's version is written beside it as
   `<file>.new`, and `self-update` names both; compare them and merge what you
   need. It never asks. A file the release no longer has is removed when it
   is untouched, and kept when it was edited.
7. **Validate, pull, start, verify.** Compose must resolve the project and the
   configuration must validate; the release's images are pulled; `up --wait`
   brings the services up healthy; the site is verified through its ingress as
   `check` does.
8. **The launcher** is replaced, pinned to the new release's digest. It is
   replaced even when it was edited, because it holds the pin: an edited copy
   is kept as `ghost-docker.edited`. The metadata records the release, the
   one before it, and the files' new checksums. The snapshot is removed.

When a step after the snapshot fails, the snapshot is put back. When the
services had not been changed, Ghost and ActivityPub are then started again,
the same containers, on the files as they were. When they had been, they are
stopped first; `data/ghost` and
`data/mysql` are moved aside into `.ghost-docker-update/data/`, the backup's
content and databases are loaded as `restore` loads them, and the previous
release is started again and must become healthy and verify. The update then
says either **restored** (the site is back on the release it ran, its files,
databases and content as they were) or that **the site needs you**, with what
could not be put back, which of its services are running, and the
`./ghost-docker restore` command that puts the site back from the backup. In
that case the snapshot is left in `.ghost-docker-update/` and the site's
launcher still runs the previous image. An update is never reported as done
because `up` returned zero.

Exit statuses: `0` updated, or nothing to update; `1` refused or failed; `2` a
usage error.

### Updating a clone

`self-update` does not update a site that is a clone of this repository: it
refuses before changing anything, and prints these steps. A clone is yours to
move with git, and its services are Compose's:

```bash
./ghost-docker backup
git fetch --tags
git checkout v0.1.0-beta.2
./ghost-docker config validate
docker compose pull --ignore-buildable
docker compose up -d --wait
./ghost-docker check
```

The launcher builds the manager image from whatever is checked out the next
time it runs. If the site does not come back, check out the commit it ran
before, and restore the backup (`./ghost-docker restore --yes backups/<backup>`):
the backup records the commit checked out when it was taken, and restore
refuses a clone at any other.

## backup and restore

```text
ghost-docker backup [--consistent]
ghost-docker restore [--yes] <backup>
```

### backup

`backup` writes one directory under `backups/` in the site, named by when it
was taken (`backups/2026-10-09T14-03-22Z`), private (`0700`, its files
`0600`), and kept until you remove it. Nothing is rotated or pruned. Copy
backups off the host to keep them safe.

| Path in the backup | What it is |
| --- | --- |
| `manifest.json` | What the backup holds: the site (for a clone, the commit checked out when the backup was taken), the image Compose resolves for each service and, for each running one, the exact image it ran (its ID and registry digests), every table's row count, a SHA-256 of every file, and what is not included. |
| `database/ghost.sql` | A `mysqldump` of Ghost's database, taken as the site's own database user in one consistent snapshot. |
| `database/activitypub.sql` | ActivityPub's database, when the `activitypub` profile is on. |
| `content.tar.gz` | The content directory, `data/ghost`: images, media, files, themes, settings. |
| `site/` | `.env`, `ghost.env`, `.ghost-docker.json`, `compose.override.yml` and the overrides `GD_COMPOSE_OVERRIDES` names, `caddy/sites/`, `caddy/custom/`, `caddy/global/` and, for a site installed from the image, the stack's files and the launcher the site ran. |

A backup is **checked** before it counts as one: every dump is loaded into a
scratch MySQL, in a throwaway container of the MySQL image the site runs, with
the same number of tables as the site's database and, for Ghost's, a
migration history; the content archive is listed. Until then it is written
as `backups/.<name>.partial`, and a failure removes that. **A dump that fails
is an error, not a backup:** `backup` exits `1` and leaves nothing in
`backups/`.

What a backup cannot hold is named in its manifest and in the summary:
Caddy's certificates, which Caddy obtains again when the site starts; the
Tinybird workspace and analytics data outside the site; Mailpit's inbox.

#### What a backup captures

By default a backup is **live**, as Ghost-CLI's was: the site keeps running,
and nothing is unavailable. Each database's dump is one consistent snapshot
of that database, but each database and the content are captured at
different moments. Content written or removed during the backup, and
anything that relates Ghost's and ActivityPub's data, may not match: a
restored post can refer to an image deleted before the content was archived.
On a quiet site this rarely matters. The manifest records
`"consistency": "live"`, and `restore` says so when it restores one.

`--consistent` makes the databases and the content **one moment** of the
site. Ghost and ActivityPub, the services that write them, are stopped
(`docker compose stop`) while the databases are dumped, the content archived
and the site's files copied, then started again, the same containers, before
the backup is checked. The site is unavailable for the capture alone,
typically seconds to a few minutes for a large content directory; Caddy and
MySQL keep running, so visitors get an error from Caddy rather than no
answer. The manifest records `"consistency": "quiesced"`.

The writers end as they began: those that were not running are not started,
and those that were are started again whether the backup succeeds or fails.
If they do not start again, `backup` fails and says so; start them with
`docker compose up -d`. In either mode, if the database was not running, it
is started for the dump and stopped again.

`self-update` takes a consistent backup, and a failed update is put back from
it. It keeps the writers stopped from the backup until the release starts or
the site is put back, rather than for the capture alone: see
[self-update](#self-update).

What the backup records is what Compose resolves from every file the site
runs with, and what the daemon runs, not what `.env` alone says:

- A site whose data Compose mounts anywhere but `data/ghost` and
  `data/mysql`, whether `.env` moved it (`UPLOAD_LOCATION`,
  `MYSQL_DATA_LOCATION`) or an override did, or that mounts anything else
  inside them, is refused rather than half backed up.
- An override `GD_COMPOSE_OVERRIDES` names is backed up with the site, and
  recorded; one outside the site directory is refused. A restore must run with
  the same `GD_COMPOSE_OVERRIDES`.
- A service running another image than its configuration now names, because
  the configuration changed and `docker compose up -d` has not run since, is
  reported as a warning; the manifest records both.
- A Compose project whose containers another directory made is refused
  before anything runs (see [the project name](configuration.md#service-names-on-the-network)).

### restore

`restore` takes a backup's directory, and works in two places:

- **Over its own site**, the directory it was taken from (the same Compose
  project name). This replaces the site, so it asks first; `--yes` answers for
  it, and without a terminal it is required.
- **Into a new, empty directory**, on this host or another, for example
  `./ghost-docker --dir /srv/new-site restore /srv/old-site/backups/<backup>`.
  A backup outside the site directory is mounted read-only by the launcher.
  The site keeps its project name and ports, so nothing on the host may already
  use them: when the site the backup was taken from is still here, take it
  down first (`docker compose down` in its directory). A backup of a clone
  restores into a clone checked out at the commit the backup records, over
  its site as into a new directory.

In order:

1. **Refusals.** The backup is read whole: its manifest, every file against
   its checksum, the archive listed. A manifest that does not match its schema
   is refused, naming its fields: it is damaged, or was made by a development
   release before the first stable one, whose formats are not read. A clone
   at another commit than the backup records, another site's directory, a directory
   with data in it, another operation holding the lock, and a restore that
   did not finish are refused. In a new directory, containers of the same
   project and busy ports are refused, named, and never stopped. Nothing has
   changed.
2. **The lock**, then every image the backup records is pulled before anything
   stops.
3. **Over the site:** it is stopped (`docker compose down`; volumes, such as
   Caddy's certificates, are kept), and its files, `data/ghost` and
   `data/mysql` are moved aside into `.ghost-docker-restore/`.
4. **The backup's files** are written, with the directory's own path in
   `PROJECT_DIR` and the metadata, and Compose must resolve exactly the images
   the backup records: the site is pinned to them. The content is unpacked
   into `data/ghost`.
5. **The databases.** MySQL starts on an empty data directory, which creates
   the site's databases and user from the restored `.env`; each dump is loaded
   as the site's user, and every table's rows must match the manifest.
6. **Start and verify.** `up --wait`, then the site is verified through its
   ingress as `check` does. `.ghost-docker-restore/` is removed.

The outcome is **restored**, or **the site needs you**, with what failed and
what to do. When the site cannot be stopped, nothing is moved, and the restore
says which services are still running. When moving it aside fails, what had
been moved is moved back before anything is written. Once the backup is being
written, a restore that fails stops the services, so nothing writes to a site
that was not verified, and it does not put the old site back by itself: over
a site, the site as it was is in `.ghost-docker-restore/` (`files/` and
`data/`), with the steps to put it back, naming only what is there; `check`
reports the directory until it is removed, and another restore is refused
while it is there. Removing it needs `sudo`, because MySQL owns part of it.

Exit statuses, for both: `0` done; `1` refused or failed; `2` a usage error,
or a restore over a site without `--yes` and no terminal to ask.

## Windows

Through WSL2, with Docker Desktop's WSL integration enabled for your
distribution. Inside WSL the host is Linux and everything here applies. Install
into the Linux filesystem (for example `~/my-site`), not under `/mnt/c`: file
permissions are not enforced there, so `.env` would not be private, and MySQL's
data directory is unreliable on it.
