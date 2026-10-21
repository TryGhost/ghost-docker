# Installation

```bash
mkdir ~/my-site && cd ~/my-site
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- install --local   # or: --domain example.com
```

That installs a site in the current directory and starts it. `install.sh` is
the `ghost-docker` launcher; `install` writes a copy into the site, and every
later command is `./ghost-docker ...` from the site directory. Day-to-day
operation is plain `docker compose`.

As with Ghost-CLI's `ghost install`, a site is a production one unless
`--local` is given; without `--domain`, `install` asks for the domain.

This is a beta. To report a problem or send feedback, see
[Reporting a problem](#reporting-a-problem). What each command does in detail,
and what it refuses, is in [reference.md](reference.md).

**Requirements:** Docker Engine 25.0+ with the Compose v2.24+ plugin, bash,
and curl for the install command above. Production is supported on Linux with rootful Docker Engine. On Windows,
see [Windows](#windows).

**One directory is one site.** The site directory is the current directory, or
`--dir PATH`.

## Releases

A release is a version of the manager image, `ghcr.io/tryghost/ghost-docker`,
which carries the CLI and the stack's files. Releases are `vX.Y.Z` and
`vX.Y.Z-beta.N`. Until sites installed from the `main` branch can be moved to
this layout, every release is a beta.

| Choose | With | Runs |
| --- | --- | --- |
| A channel | `--channel stable` or `--channel beta` (the default) | The newest release on it. `beta` includes releases; `stable` has no betas. |
| A release | `--release vX.Y.Z` (`--to` for `self-update`) | Exactly that release |
| The development image | `GD_CHANNEL=edge` | `edge`, built from every push to `next-docker`. Not a release. |

Pass these to the launcher with the command, for example
`bash -s -- install --local --release v0.1.0-beta.5`. `install` pins the site's
launcher to the exact image digest it ran, and records the channel, which
`self-update` follows.

A site can also be a clone of this repository, running `./ghost-docker` from
the checkout. A clone builds the manager image from the checkout, uses its
stack files in place, and is updated with git ([Updating a
clone](#updating-a-clone)) rather than `self-update`.

## install

```text
ghost-docker install [--local | --domain example.com [--admin-domain admin.example.com]
                                [--email ops@example.com]]
                     [--name NAME] [--port 2368] [--version 6.61.0] [--with activitypub,mailpit,supervisor]
                     [--channel stable|beta | --release vX.Y.Z] [--no-prompt] [--no-start]
ghost-docker install --import BUNDLE [--name NAME] [--port 2368] [--with mailpit] [--no-prompt] [--no-start]
ghost-docker install --import BUNDLE [--domain DOMAIN] [--admin-domain DOMAIN] [--email EMAIL] [--no-start]
```

| Option | Meaning |
| --- | --- |
| `--local` | Ghost and MySQL on `127.0.0.1:PORT`, for development. |
| `--domain DOMAIN` | A production site: Ghost, MySQL and Caddy with HTTPS on `DOMAIN`. Asked for at a terminal when omitted. |
| `--admin-domain DOMAIN` | A separate Ghost Admin domain. Production only. |
| `--email EMAIL` | The email Caddy registers with Let's Encrypt, which sends expiry notices to it. Production only; optional. |
| `--name NAME` | The site's `COMPOSE_PROJECT_NAME`: lowercase letters, digits and dashes, at most 45 characters. Default: `ghost-example-com` in production, a generated `ghost-local-...` name locally. |
| `--port PORT` | The loopback port Ghost is published on. Default: the first free port at or above 2368. |
| `--version VERSION` | A Ghost version (`6.61.0`) or a full `next` image tag (`6-next-alpine`), pinned to its exact digest. |
| `--ghost-image REPO` | Ghost's image repository, for testing your own Ghost builds. Not with `--import`. |
| `--ghost-channel C` | `stable` (default) or `nightly` builds of Ghost's `main`, for testing only. See [Ghost channel](configuration.md#ghost-channel). |
| `--with LIST` | Optional services; see [below](#optional-services). |
| `--channel`, `--release` | Which ghost-docker release to install; see [Releases](#releases). |
| `--no-prompt` | Never ask: every input must be an option. |
| `--no-start` | Write the configuration and routes; start nothing. |
| `--import BUNDLE` | Import a Ghost-CLI site; see [Importing a Ghost-CLI site](#importing-a-ghost-cli-site). |

`install` refuses a directory that already holds a site or data, checks the
host first (as `./ghost-docker doctor` does), generates fresh database
passwords, then starts the site and verifies it through its own ingress. **A
failed installation removes everything it created**, so the same command can
simply be run again. Details: [What installation does](reference.md#what-installation-does).

Exit statuses: `0` installed, `1` failed, `2` a usage error.

### Optional services

| Service | For | What it does |
| --- | --- | --- |
| `--with activitypub` | Production | Runs the site's own ActivityPub service and database, routed through Caddy. |
| `--with mailpit` | Local | Sends Ghost's mail (invites, password resets, sign-in links) to a [Mailpit](https://mailpit.axllent.org) inbox at `http://127.0.0.1:MAILPIT_PORT` (`./ghost-docker info` shows it). Newsletters go through Mailgun's API, so Mailpit never sees them. |
| `--with supervisor` | Either | Lets Ghost Admin run Ghost updates within the site's major version, each with a checked backup first. Needs Ghost 6.72.0 or later; refused under rootless Docker. See [upgrade-supervisor.md](upgrade-supervisor.md). |

ActivityPub and analytics need Caddy's routes, so a local site cannot select
them; Mailpit would catch a production site's real mail, so a production site
cannot select it.

**Analytics** is added after installation, because its Tinybird login is
interactive:

1. Set the tokens: `./ghost-docker config set .env TINYBIRD_TRACKER_TOKEN ...`,
   and `TINYBIRD_ADMIN_TOKEN` and `TINYBIRD_WORKSPACE_ID` the same way.
2. Set `labs__publicAPI` in `ghost.env`.
3. Add `analytics` to `COMPOSE_PROFILES`.
4. Add its route to `caddy/sites/site.caddy`.
5. Finish the Tinybird login as [TINYBIRD.md](../TINYBIRD.md) describes.

## Importing a Ghost-CLI site

A Ghost-CLI site, local or production, moves to Docker with its posts,
members, staff accounts, settings, themes, images and configuration. It needs:

- **Ghost-CLI 1.34.0 or later** (`ghost --version`), and
- **Ghost 6.61.0 or later** in the site, the first release with a `next` image.
  The import runs exactly the version the site runs; upgrade afterwards.

Update the source first, in its directory, and check the site still works:

```bash
npm install -g ghost-cli@latest
ghost update
```

Then export it, and install from the bundle in a new, empty directory:

```bash
ghost migrate-export --output ~/my-site-bundle --archive tgz
mkdir ~/my-site && cd ~/my-site
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- install --import ~/my-site-bundle.tgz
```

No `--local` or `--domain` is needed: the bundle says what kind of site it is.
A local site gets a new address, `http://localhost:PORT`; a production site
keeps its own domain (see [below](#importing-a-production-site)).

Good to know:

- **This copies the site.** An export stops the source while it copies and
  starts it again, so both run side by side until you `ghost stop` the source.
  To move it instead, see [Moving a site to Docker](#moving-a-site-to-docker).
- **The bundle is checked before anything changes**, and **a failed import
  removes what it created**; the bundle and the source are never modified.
  `GD_IMPORT_KEEP_FAILED=1` keeps a failed import for inspection.
- **Import bundles you made.** Their database and themes become your site.
- **Mail settings come with it.** A local site imported with `--with mailpit`
  sends its mail to Mailpit instead; that is the only `--with` an import takes.
- **The bundle holds secrets.** Remove it once you no longer need it.
- A SQLite site exported with `--sqlite-format portable` brings no database:
  you create the owner and import the content and members in Ghost Admin. See
  [Portable bundles](reference.md#portable-bundles).

Bundle kinds, checks and refusals: [Imports](reference.md#imports). The
bundle format: [bundle-v1.md](bundle-v1.md).

### Importing a production site

A production site's bundle is installed as a production site, as
`install --domain` makes one.

- **Its own domains**, from the bundle's `url` and `adminUrl`. `--domain` and
  `--admin-domain` serve it elsewhere. The site must be served over HTTPS at
  its domain's root: a source URL with `http`, a port or a path is refused,
  naming the `--domain` that would serve it.
- **Its mail.** The source's mail settings are carried, and the site sends
  real mail through them.
- **Its staff.** Sign in with the source's staff accounts. Ghost emails a
  sign-in code to confirm the new device, so mail has to work.
- **Nothing is stopped.** If nginx or Apache still holds ports 80 and 443,
  Caddy cannot start and the import fails, naming the port. Stopping it is
  part of the move below.

### Moving a site to Docker

To *move* a local site, so the Docker site takes over its address and the
source gets no writes after the copy, stop the source first:

```bash
cd ~/sites/my-blog
ghost stop
ghost migrate-export --output ../my-blog-bundle
mkdir ../my-blog-docker && cd ../my-blog-docker
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- install --import ../my-blog-bundle --port 2368
```

- **Stop first.** The exporter never starts a site that was stopped, so the
  bundle is the source's final state.
- **The same address.** Pass the source's port (`server.port` in its
  `config.development.json`, 2368 by default) as `--port`.
- **Outside the source.** Keep the bundle and the new site out of the
  Ghost-CLI install directory.
- **Going back:** the source is left stopped and intact. If the import fails,
  `ghost start` in the source brings it back.
- **A linked theme** in `content/themes/` arrives as a copy. To keep
  developing it, mount the folder with a `compose.override.yml`; see [Your own
  Compose overrides](configuration.md#your-own-compose-overrides).

If the exporter refuses a SQLite site because some values would not load into
MySQL, it lists them: fix them in the source and export again, or use
`--sqlite-format portable`. A Ghost-CLI site on native Windows is exported
there and imported from WSL2, with the bundle under `/mnt/c/`.

### Moving a production site

A production move is the local one plus a proxy and DNS. The source is
stopped before its final export, so the two sites never both take writes, and
stays stopped and intact as your way back. The site is down from `ghost stop`
until the Docker site serves it; there is no maintenance page. Run the export
and the import as the same user.

#### On the same server

The Docker site's Caddy takes over ports 80 and 443 from Ghost-CLI's nginx:

```bash
cd /var/www/ghost
ghost stop
ghost migrate-export --output ~/my-site-bundle
sudo systemctl stop nginx
mkdir ~/my-site && cd ~/my-site
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- install --import ~/my-site-bundle
```

- **Stop nginx yourself.** If it serves other sites too, move those first, or
  keep the source (see [Ports](#ports-and-your-existing-proxy)).
- DNS already points here; Caddy gets its own certificate when it starts.
- **If the import fails:** `sudo systemctl start nginx`, then `ghost start` in
  the source. The bundle is unchanged, so you can retry.
- **Afterwards**, stop both from starting at boot: `sudo systemctl disable
  nginx`, and disable the source's `ghost_...` service
  (`systemctl list-unit-files 'ghost_*'` names it).

#### To another host

```bash
# On the old host
cd /var/www/ghost
ghost stop
ghost migrate-export --output ~/my-site-bundle --archive tgz
scp ~/my-site-bundle.tgz new-host:

# On the new host
mkdir ~/my-site && cd ~/my-site
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- install --import ~/my-site-bundle.tgz
```

Then point DNS at the new host; `./ghost-docker check` reports HTTPS as
pending until it does. Lower the DNS TTL a day ahead. If the import fails,
`ghost start` on the old host brings the site back. Otherwise keep the old
site stopped, since a second copy would take writes the new one never sees,
and disable its service once the new site is accepted.

#### A rehearsal copy

To try the move first, export without `ghost stop` and import on another
domain without starting:

```bash
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- install --import ~/my-site-bundle.tgz --domain staging.example.com --no-start
```

**A copied database sends real mail and talks to Stripe.** Before starting
it, remove the `mail__` and `bulkEmail__` settings from `ghost.env`, then
clear Mailgun, Stripe and webhooks in its database:

```bash
docker compose up -d db
docker compose exec db sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' <<'SQL'
UPDATE settings SET value = NULL WHERE `key` IN ('mailgun_api_key', 'mailgun_domain', 'stripe_secret_key', 'stripe_publishable_key', 'stripe_connect_secret_key', 'stripe_connect_publishable_key');
DELETE FROM webhooks;
SQL
docker compose up -d
```

Remove the copy when you are done: `docker compose down`, then delete the
directory, with `sudo` because MySQL owns `data/mysql`. For the real move, export again with the source stopped, to a new path.

## Ports, and your existing proxy

**Installation never stops or reconfigures anything already running.**

- A port `install` chooses skips ports other containers publish, and on
  macOS ports other programs hold too. A busy port you ask for with `--port`
  is an error.
- A production site needs 80 and 443. If anything holds them, installation
  fails, names the port, and leaves the directory as it was.

**On Linux, use Docker Engine 28 or later.** Ghost (and Mailpit) are published
on `127.0.0.1` only, but older engines let other machines on the local network
reach those ports, and so Ghost around Caddy. `doctor` and `check` warn about
such an engine. Docker Desktop, OrbStack and rootless Docker are not affected.

To run Ghost behind your own nginx or Apache instead, point it at
`127.0.0.1:${GHOST_PORT}` and drop the `caddy` service from `compose.yml` or
move it off 80/443. That is an unsupported customization, and stack updates
may touch `compose.yml`; see
[configuration.md](configuration.md#site-modes-and-profiles).

How ports are detected on each platform: [Ports](reference.md#ports).

## After installation

```bash
./ghost-docker check      # diagnose this site: host, configuration, services, database, ingress
./ghost-docker info       # the recorded installation metadata, and where Mailpit's inbox is
./ghost-docker list       # every ghost-docker site on this host, and its directory
./ghost-docker config get|set|validate
./ghost-docker update     # Ghost; see below
./ghost-docker self-update  # ghost-docker itself; see below
./ghost-docker backup     # the databases, content and configuration, into backups/
./ghost-docker restore backups/<backup>
```

`check` exits non-zero when anything is wrong. A new production site whose DNS
does not point at the host yet reports HTTPS as **pending**; that is expected,
and Caddy gets a certificate once it does. What each check means: [How a site
is verified](reference.md#how-a-site-is-verified).

The routes are a file you edit, `caddy/sites/site.caddy`, followed by
`docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`; see
[caddy.md](caddy.md).

## update

```text
ghost-docker update [--check] [--no-backup] [<version> | latest]
```

Updates the site's Ghost to the newest release of the same major version, or
the version named, such as `6.68.0`. Ghost runs its own database migrations
when it starts.

| Option | Meaning |
| --- | --- |
| `--check` | Whether there is a newer Ghost, and which. Changes nothing. |
| `--no-backup` | Take no backup first, and keep the site running until the new Ghost replaces it. Going back then needs a backup of your own. |
| `<version>` | Exactly that Ghost. Omitted, or `latest`: the newest of the site's major. |

The update pulls the new image while the site runs, takes a consistent backup
(the site is down from here), pins the new image and starts the site. On
success the backup stays in `backups/`; going back to the earlier Ghost means
restoring it, which discards anything written since. A failure before the new
Ghost starts puts everything back (**restored**); one after stops the site,
since the new Ghost may have migrated the database, and says **the site needs
you**, with the ways on. What it refuses, and the recovery:
[update](reference.md#update).

Exit statuses: `0` updated, or nothing to update; `1` refused or failed; `2` a
usage error.

### From Ghost Admin: the upgrade supervisor

A site installed `--with supervisor` runs these updates when Ghost Admin asks,
one at a time, with the same outcomes and recovery as `update`, and Admin
shows each job's progress. A job the supervisor could not finish is reported
**interrupted**, with the operator's steps. Logs: `docker compose logs -t
supervisor`. The protocol and recovery rules are in
[upgrade-supervisor.md](upgrade-supervisor.md).

## self-update

```text
ghost-docker self-update [--check] [--no-backup] [--channel stable|beta | --to vX.Y.Z]
```

Updates ghost-docker itself (the stack's files and the manager image) to the
newest release on the site's channel. **It never changes Ghost**; use
[`update`](#update) for that. If a release needs a newer Ghost than the site
runs, it stops first and says so.

| Option | Meaning |
| --- | --- |
| `--check` | Whether there is an update, and what it would change. Changes nothing. |
| `--channel CHANNEL` | The newest release on `stable` or `beta`, which the site then follows. |
| `--to vX.Y.Z` | Exactly that release. |
| `--no-backup` | Take no backup first. Not allowed when [moving from the released main layout](#moving-from-the-released-main-layout). |

Files you never edited are replaced. **An edited file is kept**, with the
release's version beside it as `<file>.new`: compare and merge them. The site
is down from the backup until the new release starts and verifies. A failure
before the new release starts puts everything back (**restored**); one after
stops the site, puts the previous release's files back, and says **the site
needs you**, with the ways on. What it refuses, and the recovery:
[self-update](reference.md#self-update).

Exit statuses: `0` updated, or nothing to update; `1` refused or failed; `2` a
usage error.

### Updating a clone

A clone of this repository is updated with git and Compose instead:

```bash
./ghost-docker backup
git fetch --tags
git checkout v0.1.0-beta.5
./ghost-docker config validate
docker compose pull --ignore-buildable
docker compose up -d --wait
./ghost-docker check
```

If the site does not come back, check out the commit it ran before and
restore the backup (`./ghost-docker restore --yes backups/<backup>`).

### Moving from the released main layout

A site installed from `main` before this layout (a git clone with one `.env`,
a hand-edited `caddy/Caddyfile`, and no `ghost-docker` launcher) moves onto it
once. With Ghost and its database running, in the site directory:

```bash
cd /path/to/your/ghost-docker
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- self-update --check
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- self-update
```

**Do not `git pull` across this change.** The new Compose file selects no
services without the new settings, and a pull cannot write them.

The migration keeps the project name, data, credentials and domains, moves
Ghost's settings into `ghost.env`, pins the `next` image of the exact Ghost
version running (6.61.0 or later; upgrade older sites on main first), and
carries `caddy/Caddyfile` over as written. It checks everything before
changing anything, takes a checked backup, and verifies the site through
Caddy; Ghost is down from the backup until the new layout starts. Edited
stack files, and Compose files passed with `-f` rather than named in `.env`'s
`COMPOSE_FILE`, stop it before anything changes. Afterwards, update with
`./ghost-docker self-update`, not git. What each setting becomes, and the
recovery: [Moving from the released main
layout](reference.md#moving-from-the-released-main-layout).

## backup and restore

```text
ghost-docker backup [--consistent]
ghost-docker restore [--yes] <backup>
```

`backup` writes the databases, the content (`data/ghost`) and the site's
configuration into a private, timestamped directory such as
`backups/2026-10-09T14-03-22Z`. Every dump is test-loaded before the backup
counts: **a backup that fails is an error, and leaves nothing behind.**
Nothing is rotated or pruned; copy backups off the host to keep them safe. By
default a backup is **live**, as Ghost-CLI's was: the site keeps running, and
the databases and content are captured at slightly different moments;
`--consistent` stops Ghost and ActivityPub for the capture, so everything is
from one moment. What a backup holds, and leaves out: [backup](reference.md#backup).

`restore` works in two places:

- **Over its own site.** This replaces the site, so it asks first; `--yes`
  answers for it, and is required without a terminal.
- **Into a new, empty directory**, on this host or another:
  `./ghost-docker --dir /srv/new-site restore /srv/old-site/backups/<backup>`.
  The site keeps its project name and ports, so take the original down first
  (`docker compose down`) if it is on the same host. A clone's backup restores
  into a clone at the commit it records.

The backup is fully checked, and its images pulled, before anything stops. A
restore over a site that fails keeps the site as it was in
`.ghost-docker-restore/`, with the steps to put it back; what it refuses, and
the order it works in: [restore](reference.md#restore).

Exit statuses, for both: `0` done; `1` refused or failed; `2` a usage error,
or a restore over a site without `--yes` and no terminal to ask.

## Windows

Through WSL2, with Docker Desktop's WSL integration enabled for your
distribution. Install into the Linux filesystem (for example `~/my-site`), not
under `/mnt/c`, where `.env` would not be private and MySQL's data is
unreliable.

## Reporting a problem

[Open an issue with the beta's form](https://github.com/TryGhost/ghost-docker/issues/new?template=next-docker-beta.yml). It labels the issue
`next-docker` and asks for what triage needs first:

- what happened, and the command and its output;
- `./ghost-docker version`, or the install command you ran if there is no site
  yet;
- the platform, and the kind of site;
- `./ghost-docker doctor` and `./ghost-docker check`, from the site directory.

Remove passwords, tokens, and anything you would rather not share from what
you paste, logs included. Never paste `.env` or `ghost.env`.
