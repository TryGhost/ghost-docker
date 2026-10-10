# Installation

```bash
mkdir ~/my-site && cd ~/my-site
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- --local   # or: --domain example.com
```

`install.sh` is the launcher, `ghost-docker`, from the newest release. Piped
into bash with no command, it runs `install` with the options given, from the
newest release on the `beta` channel. As with Ghost-CLI's `ghost install`, a
site is a production one unless `--local` is given: plain `curl -fsSL
https://docker.ghost.org/install.sh | bash` asks for its domain. `install`
writes a copy of the launcher into the site, and every later command is
`./ghost-docker ...` from there. Other commands can still be piped by name:
`bash -s -- self-update`.

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
https://docker.ghost.org/install.sh | bash -s -- --local --release
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
ghost-docker install --import BUNDLE [--domain DOMAIN] [--admin-domain DOMAIN] [--email EMAIL] [--no-start]
```

| Option | Meaning |
| --- | --- |
| `--local` | Ghost and MySQL, published on `127.0.0.1:PORT`. `NODE_ENV=development`, `RESTART_POLICY=no`. |
| `--domain DOMAIN` | The production site's domain: Ghost, MySQL and Caddy with HTTPS on it. Production is the default; asked for at a terminal when omitted. |
| `--admin-domain DOMAIN` | A separate Ghost Admin domain. Production only. |
| `--email EMAIL` | The ACME account email. Production only; see below. |
| `--port PORT` | The loopback port Ghost is published on, in both modes. Omitted: the first at or above 2368 that is free (see [Ports](#ports-and-your-existing-proxy)). |
| `--version VERSION` | A Ghost version (`6.61.0`, which means `6.61.0-next-alpine`) or a full image tag (`6-next-alpine`). Resolved to an exact digest. Only the `next` variants' layout runs: an image installed by Ghost-CLI, such as the `-alpine` tags, is refused. |
| `--with LIST` | `activitypub`, and `mailpit` for a local site. `analytics` is added after installation; see below. |
| `--channel CHANNEL` | Install the newest release on `stable` or `beta`; see [Releases](#releases). |
| `--release vX.Y.Z` | Install that release. |
| `--no-prompt` | Never ask: every input must then be an option. |
| `--no-start` | Write the configuration and routes; create no containers. |
| `--import BUNDLE` | Import a local or production Ghost-CLI site from the bundle `ghost migrate-export` made; see [Importing a Ghost-CLI site](#importing-a-ghost-cli-site). |

Without `--local`, the site is a production one, as with Ghost-CLI's
`ghost install`, and `install` asks for the domain `--domain` would give. It
asks only at a terminal, including when the launcher was piped from curl.
Without one, or with `--no-prompt`, a missing answer is a usage error naming
the option that supplies it. Every question has an option, so a script never needs to answer
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
   [architecture.md](architecture.md#installation-metadata).
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

A Ghost-CLI site, local (`ghost install local`) or production, moves to Docker
in two commands, once it runs **Ghost 6.61.0 or later**: the first release
published as a `next` image, which is what the import runs. Bring the source up
to date first, Ghost-CLI and then the site, in the site's directory, and check
the site still works:

```bash
npm install -g ghost-cli@latest
ghost update
```

Then export it with Ghost-CLI 1.33.4 or later:

```bash
ghost migrate-export --output ~/my-site-bundle --archive tgz
```

Then, in a new empty directory, install from the bundle:

```bash
./ghost-docker install --import ~/my-site-bundle.tgz
```

No `--local` or `--domain` is needed: the bundle says what kind of site it
is, and a production site is imported as one, on its own domain (see
[below](#importing-a-production-site)). The launcher
mounts the bundle into the manager read-only, at its own path; the bundle can
be anywhere on the host.

The exporter picks the bundle kind from the source database:

| Source | Bundle kind | Imported how |
| --- | --- | --- |
| Local SQLite | `mysql-data` | Ghost starts once on a fresh MySQL database to create its schema, then every row is loaded and the row counts are compared with the bundle's. |
| Local or production MySQL | `mysql-dump` | The dump is loaded into a fresh MySQL database. |

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
- **A new address**, for a local site. It is served at `http://localhost:PORT`, on the
  first free port at or above 2368 unless `--port` says
  otherwise. An ordinary export preserves the source's original running state, so the two sit side
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

- `--import` with `--with`: import the site first, then enable optional
  services. A local site may take `--with mailpit`.
- `--domain`, `--admin-domain` or `--email` with a local site's bundle, and
  `--local` with a production site's.
- A `portable` bundle of a production site. The exporter makes portable
  bundles of local SQLite sites only; a site that must move through Ghost
  Admin is installed new, then its content and members are imported there.

### Importing a production site

A bundle of a production site is installed as a production site: Ghost,
MySQL and Caddy with HTTPS, as `install --domain` makes one, with the source's
database, content and configuration.

- **Its own domains.** The domain comes from the bundle's `url`, and a
  separate Ghost Admin domain from its `adminUrl` when the source had one.
  `--domain` and `--admin-domain` serve it on others instead; `--email` names
  the ACME account, as for any production site. On a domain other than the
  source's, the source's admin domain is not carried, with a warning: Ghost
  Admin is on the site's own domain unless `--admin-domain` names another. Caddy serves a site over HTTPS,
  on 443, at its domain's root, so a source URL with plain `http`, a port, or
  a path is refused before anything changes: it names the `--domain` (or
  `--admin-domain`) that serves the site at that host's root over HTTPS, which
  changes its address.
- **Its mail.** The source's mail settings are carried into `ghost.env`, and
  the imported site sends real mail through them. `--with mailpit` is for
  local sites only.
- **Its staff.** The database arrives whole, so there is no owner to create:
  sign in with the source's staff accounts. Ghost treats the new site as a new
  device and emails a sign-in code, through the carried mail settings, so mail
  has to work.
- **Nothing is stopped.** Installation never stops anything already running
  (see [Ports](#ports-and-your-existing-proxy)). Where nginx or Apache still
  holds 80 and 443, as on the server Ghost-CLI ran on, Docker cannot start
  Caddy: the import fails naming the port, and removes what it created.
  Stopping that proxy is a step of the move below, not the importer's.

Production is supported on Linux with rootful Docker Engine.

See the [roadmap](ghost-cli-replacement.md) for remaining work, and
[bundle-v1.md](bundle-v1.md) for the bundle contract.

### Moving a site to Docker

These are the steps for a local site; a production site's are in [Moving a
production site](#moving-a-production-site), below.

The commands above copy a site and leave the source running beside the copy.
To move it instead, so that the Docker site takes over the source's address
and nothing is written to the source after it was copied, stop the source
first:

```bash
cd ~/sites/my-blog
ghost stop
ghost migrate-export --output ../my-blog-bundle
mkdir ../my-blog-docker && cd ../my-blog-docker
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- --import ../my-blog-bundle --port 2368
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

Exporting needs Ghost-CLI 1.33.4 or later (`ghost --version`) and a source
on Ghost 6.61.0 or later; on anything older, run `ghost update` there and check
the site works before exporting. When the exporter
refuses a SQLite site because some values would not load into MySQL, it lists
them: fix them in the source and export again, or move the site through Ghost
Admin with `ghost migrate-export --sqlite-format portable` (see the
`portable` bundle above). A Ghost-CLI site on native Windows is exported
there and imported from WSL2, with the bundle under `/mnt/c/`.

### Moving a production site

A production move is the local one with a proxy and DNS in it. The source is
stopped before its final export, so the bundle is its final state and the two
sites never both take writes; it stays stopped and intact, and is how you go
back, until you remove it. Nothing here is automated: there is no maintenance
page, and the site is down from `ghost stop` until the Docker site serves it.

First, in either case, bring the source up to date and check it, as above:
Ghost-CLI 1.33.4 or later, and the site on a Ghost release with a `next`
image. The import runs exactly that release; upgrade afterwards. Run the
export and the import as the same user, who can read the bundle the exporter
made private to them.

#### On the same server

The Docker site takes over ports 80 and 443 from Ghost-CLI's nginx:

```bash
cd /var/www/ghost
ghost stop
ghost migrate-export --output ~/my-site-bundle
sudo systemctl stop nginx
mkdir ~/my-site && cd ~/my-site
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- --import ~/my-site-bundle
```

- **Stop nginx yourself.** Nothing in the import stops it; it may serve other
  sites too, which the Docker site's Caddy does not. Move those first (see
  [your existing proxy](#ports-and-your-existing-proxy)), or keep the source.
- **The same domain.** DNS already points here. Caddy obtains its own
  certificate when it starts, which `./ghost-docker check` reports.
- **If the import fails**, it removes what it created. Put everything back
  with `sudo systemctl start nginx`, then `ghost start` in the source. The
  bundle is unchanged, so the import can be run again from it.
- **Afterwards**, keep both from coming back at boot, which would take the
  ports and the writes: `sudo systemctl disable nginx`, and disable the source's
  service, `ghost_` and its domain (`systemctl list-unit-files 'ghost_*'`
  names it). The source's files and MySQL database stay as they were.

#### To another host

```bash
# On the old host
cd /var/www/ghost
ghost stop
ghost migrate-export --output ~/my-site-bundle --archive tgz
scp ~/my-site-bundle.tgz new-host:

# On the new host
mkdir ~/my-site && cd ~/my-site
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- --import ~/my-site-bundle.tgz
```

Then point the domain's DNS at the new host. Until it moves, `check` reports
HTTPS as pending: Caddy obtains a certificate once the domain reaches this
host. A low DNS TTL, set a day ahead, shortens the time some visitors still
reach the old host. If the import fails, `ghost start` on the old host brings
the site back; DNS has not moved.

The source is stopped before the new site can serve, and stays stopped:
`ghost start` there would let a second copy take writes the new one never
sees. Disable its service as above once the new site is accepted.

#### A rehearsal copy

To try the move first, import a copy on another domain or host while the
source keeps running. An ordinary export, without `ghost stop`, stops the
source while it copies and starts it again. Import without starting, on a
domain of its own (the source's admin domain is not carried to it; name the
copy's own with `--admin-domain` if it needs one):

```bash
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- --import ~/my-site-bundle.tgz --domain staging.example.com --no-start
```

**A copied database sends real mail.** Before starting the copy, remove the
`mail__` and `bulkEmail__` settings from `ghost.env`, so staff emails and
newsletters go nowhere. The importer leaves them, because a move needs them.
Newsletters' Mailgun account, webhooks and Stripe are also configured in the
database, and a scheduled post would send its newsletter to real members, and
Stripe keys let the copy register its own webhook with the live account. Clear
them in the copy's database before Ghost starts on it:

```bash
docker compose up -d db
docker compose exec db sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' <<'SQL'
UPDATE settings SET value = NULL WHERE `key` IN ('mailgun_api_key', 'mailgun_domain', 'stripe_secret_key', 'stripe_publishable_key', 'stripe_connect_secret_key', 'stripe_connect_publishable_key');
DELETE FROM webhooks;
SQL
docker compose up -d
```

Then use the copy, and remove it (`docker compose down`, then the directory)
once the rehearsal is done. Its bundle is not the move's: export again, with
the source stopped and to a new path (the exporter never writes over an
existing bundle), for the move itself.

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
| https | An HTTPS request to Caddy's container for Ghost's `/ghost/api/admin/site/`, with the domain as its server name and Host, as a browser asks. **serving** means this site's Ghost answered through Caddy: Ghost reports its site's URL, and that must be the site's `URL` (by either name, the canonical one, not the admin domain). It names the certificate's issuer and expiry; a certificate from a CA browsers do not trust (staging, or Caddy's internal CA) is a `warning`. **pending** means Caddy has no certificate for the name yet, so Ghost could not be asked through it: Caddy obtains one once the domain's DNS reaches this host, `./ghost-docker check` reports the change, and `docker compose logs caddy` shows each attempt. Caddy answering with something other than Ghost (a broken route, a 502), another site's Ghost (a route to the wrong upstream), or an out-of-date certificate, is an `ERROR`. | `ok`, `warning`, `note` or `ERROR` |
| admin https | With an admin domain of its own: the same, for that name. Ghost reached by the admin domain still reports the site's `URL`, which is what is checked. On the site's domain, Ghost answering the Admin API path with a redirect to the admin domain counts as Ghost answering; the admin domain's own answer then names the site. | `ok`, `warning`, `note` or `ERROR` |
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
`GHOST_IMAGE_REF` pins, are left as they are; Ghost is updated by
[`update`](#update).
When a release needs a newer Ghost than the site runs,
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

The update refuses downgrades, incompatible Ghost versions, absent metadata
(except for [the released main layout](#moving-from-the-released-main-layout)),
checkouts, another operation's lock and an unfinished update snapshot. It pulls
images before the outage where possible, keeps a file snapshot in
`.ghost-docker-update/`, then pauses Ghost and ActivityPub and takes a consistent
backup. The site is unavailable until the release starts and verifies.

Untouched managed files are replaced. Edited files stay beside the release's
`<file>.new`; compare and merge them. Removed managed files are deleted only if
untouched. On success, the launcher is pinned to the new release, metadata is
updated and the snapshot is removed. An edited launcher is kept as
`ghost-docker.edited` because its pin must be replaced.

The backup stays in `backups/` until you remove it. The lock names the operation
and start time; a killed update leaves it for you to inspect and remove only
after checking the site. The [architecture](architecture.md#recovery) describes
the recovery invariants.

When an update fails after the snapshot but before attempting service startup,
the snapshot is put back and any paused writers resume in the same containers,
on the files as they were: **restored**. A failure to restore files or resume
writers is reported as needing the operator.

Once startup has been attempted, even if `up --wait` fails, Ghost may accept
writes and the release may change the databases and content before a later
step fails.
Loading the backup would discard those, so the update never does it by
itself. It stops the services, puts the files back (the launcher still runs
the previous image), leaves the data as it is, and says **the site needs
you**, with two ways on:

- `./ghost-docker restore --yes backups/<backup>`, the backup the update took:
  the site exactly as it was when the update began, discarding anything
  written since.
- If the release did not change the data (`docker compose logs` says what it
  did), `docker compose up -d` starts the previous release on it as it is.

The snapshot is left in `.ghost-docker-update/` until you remove it, and
another update is refused while it is there. An update is never reported as
done because `up` returned zero.

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

### Moving from the released main layout

An installation made from `main` before this layout (a git clone with one
`.env`, a hand-edited `caddy/Caddyfile`, and no `ghost-docker` launcher) moves
onto it once, with the launcher as docker.ghost.org serves it, run in the
site directory:

```bash
cd /path/to/your/ghost-docker
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- self-update --check
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- self-update
```

**Do not `git pull` across this change.** The new layout's Compose file selects
no services without the new settings, and a pull cannot write them.

`self-update` finds no `.ghost-docker.json` and main's `.env`, and runs migration
`0001-compose-profiles`. Ghost and its database must be running, so it can
read the Ghost version the site runs and back the site up. Before changing
anything it works out and checks all of this, and stops, naming what to
resolve, if any of it cannot be carried over:

| What | Becomes |
| --- | --- |
| `COMPOSE_PROFILES` | `production`, plus `analytics` and `activitypub` if they were on |
| Compose project | The same name, set as `COMPOSE_PROJECT_NAME`, so Caddy's certificates and every volume stay the site's |
| `DOMAIN`, `ADMIN_DOMAIN` | `URL`, `ADMIN_URL` |
| Credentials, ports, data locations, Tinybird settings | Kept in `.env`, with `SITE_MODE`, `PROJECT_DIR` and the rest of this layout's settings added |
| Ghost's configuration in `.env` (`mail__*`, `labs__*`, anything Ghost read) | Moved to `ghost.env`, with the values Ghost actually received. Keys the container sets itself (`url`, `database__*`) are listed and left out, as they were overridden on main too |
| `ghost:6-alpine` | The `next` image of **exactly the running version**, pinned by digest (`GHOST_IMAGE_REF`). Ghost 6.61.0 is the first with one: upgrade an older Ghost on main first (`docker compose pull ghost && docker compose up -d`) |
| `caddy/Caddyfile` | Kept as `caddy/Caddyfile.local`, and carried into `caddy/sites/site.caddy` as written: `{$DOMAIN}`, `{$ADMIN_DOMAIN}` and `{$ACTIVITYPUB_TARGET}` filled in, and `import snippets/...` pointed at main's snippets, kept in `caddy/sites/legacy-snippets/`. A leading global options block moves to `caddy/global/legacy.caddy`. Caddy loads the result before anything changes; if it does not load, nothing is changed |
| `compose.override.yml`, `GD_COMPOSE_OVERRIDES` | Kept, and resolved with the new layout and every `.env` setting before anything changes. A mount into `/var/lib/ghost`, where main's Ghost image kept its files, is refused: this layout's image keeps them in `/home/ghost/content`, and a backup holds content only in `data/ghost` |
| Stack files (`compose.yml`, snippets, `mysql-init/`) | The release's. Git must show them unedited: a change in the work tree or in a commit no remote has stops the migration. Move such changes into `compose.override.yml` or a `.caddy` file of your own afterwards |

Then it keeps a copy of every file it writes in `.ghost-docker-update/`, stops
Ghost and ActivityPub, writes the new layout and `.ghost-docker.json`, takes a
checked backup into `backups/`, starts the site on the new layout and verifies
it through Caddy. Ghost is unavailable from the backup until the new layout
starts.

Recovery follows [self-update](#self-update)'s: a failure before startup puts
main's files back and starts Ghost again in the same containers. A failure
after startup stops the services, puts main's files back, leaves the data as
it is, and says **the site needs you**. Ghost's version never changes, so
`docker compose up -d` starts main's layout on that data. The backup holds the
databases and content as they were before the migration started anything;
once the migration has run, `./ghost-docker restore --yes backups/<backup>`
puts them back.

Afterwards the directory is a site installed from the image: update it with
`./ghost-docker self-update`, not git (its `.git` is left in place, and shows
the stack files as changed). Running the served command again is an ordinary
self-update. Compose files you used with `-f` by hand, such as
`compose.ipv6.yml`, are not seen by the manager: name them with
`GD_COMPOSE_OVERRIDES` when you migrate, as for every manager command
([configuration](configuration.md#the-compose-invocation-contract)).

## update

```text
ghost-docker update [--check] [<version> | latest]
```

Moves the site's Ghost to a newer release of the same major version, in an
image installation or a clone: the newest (`latest`, the default) or the
version named, such as `6.68.0`, of the image variant the site runs. Ghost runs
its own database migrations when it starts. `--check` says whether there is a
newer Ghost and which, and changes nothing; it pulls the image to find out.

| Option | Meaning |
| --- | --- |
| `--check` | Whether there is a newer Ghost, and which. Changes nothing. |
| `<version>` | Exactly that Ghost, such as `6.68.0`. Omitted, or `latest`: the newest of the site's major. |

The update refuses another major version, an older Ghost, a tag that is not the
version named, a `GHOST_IMAGE_REF` that is not the one the metadata records,
another operation's lock and an unfinished update snapshot. It pulls the new
Ghost while the site keeps running, keeps `.env` and the metadata in
`.ghost-docker-update/`, then pauses Ghost and ActivityPub and takes a
consistent backup. It writes the new pin to `.env` (`GHOST_IMAGE_REF`, with
`GHOST_VERSION` and the image's content paths) and to the metadata together,
then starts the site and verifies it. Ghost, and Tinybird sync with analytics,
run the new image. The site is unavailable from the backup until Ghost has
migrated and become healthy.

On success the snapshot is removed and the backup stays in `backups/` until you
remove it. Going back to the earlier Ghost means restoring that backup, which
discards anything written since: an older Ghost does not undo a newer one's
migrations.

A failure before startup is attempted puts `.env` and the metadata back and
starts the paused writers again in the same containers: **restored**.

Once startup has been attempted, the new Ghost may have migrated the database
and accepted writes, even if it never became healthy. The update stops the
services and leaves the data **and the new pin** as they are: unlike
`self-update`, it does not put the old pin back, because the old Ghost would
then run on a database it does not know. It says **the site needs you**, with
two ways on:

- `./ghost-docker restore --yes backups/<backup>`, the backup the update took:
  the earlier Ghost and the site exactly as they were when the update began,
  discarding anything written since.
- Find why the new Ghost did not start (`docker compose logs ghost`), fix it,
  and start it: `docker compose up -d`, then `./ghost-docker check`.

The snapshot is left in `.ghost-docker-update/` until you remove it, and
another update is refused while it is there.

Exit statuses: `0` updated, or nothing to update; `1` refused or failed; `2` a
usage error.

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

`self-update` takes a consistent backup, which it names when a failed update
needs you to restore it. It keeps the writers stopped from the backup until the release starts or
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
- A site running other images than its configuration now names, because the
  configuration changed and `docker compose up -d` has not run since (say, a
  clone checked out at a commit that bumps MySQL), is **refused** before
  anything is captured, naming each service, what it runs and what is
  configured. A stopped container counts too: starting a stopped database
  for the dump with another MySQL image could upgrade its data before
  anything was backed up. A restore runs the configuration a backup holds, and its data
  was written by what ran; a backup of both could not be restored as the site
  ran. Apply the configuration, or put it back, then back up again.
  `self-update` refuses such a site too, before it changes anything, and
  `check` warns of it.
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
   project and busy ports are refused, named, and never stopped. The
   backup's configuration (for a clone, with the clone's `compose.yml`) is
   resolved outside the site, and must name exactly the images the backup
   records and mount the data where restore loads it. Nothing has changed.
2. **The lock**, then every image the backup records is pulled before anything
   stops, and each service that was running must get, by its image ID or a
   registry digest, the very image it ran. A reference that names another
   image on this host is refused. Nothing has changed. A site that followed
   Ghost's tag, with no `GHOST_IMAGE_REF`, is restored pinned to the Ghost it
   ran, by its registry digest: the tag may have moved since, and a newer Ghost
   would migrate the restored data. Remove the pin to follow the tag again.
3. **Over the site:** it is stopped (`docker compose down`; volumes, such as
   Caddy's certificates, are kept), and `data/ghost`, `data/mysql` and every
   file the restore replaces (the site's own and the backup's, overrides
   included) are moved aside into `.ghost-docker-restore/`, each copy checked
   against its original before the original is removed.
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
