# Reference

How each command behaves in detail: what it checks, what it refuses, and how it
recovers. The steps to follow are in [install.md](install.md); this is what
happens underneath them.

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
   publishes. An explicit `--port`, or 80 and 443 for a production site with
   a Caddy of its own, that a container publishes is an error naming the
   container. Nothing is
   stopped. Ports held by anything else are found when the services start;
   see [Ports](#ports).
4. **The exact Ghost image.** The requested tag is pulled, and the pulled
   image is asked for its repository digest and its own `GHOST_VERSION`,
   `GHOST_CONTENT` and `GHOST_INSTALL`; no digest is an error. The pin is written as
   `GHOST_IMAGE_REF=ghost@sha256:...`; Ghost and Tinybird sync both run it, and
   changing `GHOST_VERSION` alone never changes what a site runs.
5. **Identity and secrets.** A stable `COMPOSE_PROJECT_NAME` — `ghost-example-com`
   in production, `ghost-local-<directory>-<adjective>-<animal>` locally
   (`ghost-local-blog-secondary-roadrunner`), chosen so that no project on the
   daemon has it, or exactly what `--name` gives (`--name acme-theme`) — kept in
   `.env` and independent of the directory name afterwards. Two local sites in directories of the same name are two
   projects. A production name or `--name` another directory's containers
   already have is refused: Compose would take them for this site's. Fresh database passwords of
   192 bits each; nothing has a default credential.
6. **Configuration.** `.env` in one atomic write, and a fresh `ghost.env`,
   both mode `0600`, through the one encoder (see
   [configuration.md](configuration.md#value-encoding)). `ghost.env` is not a
   copy of the example, whose SMTP block is a placeholder.
7. **Routing**, in production: `caddy/sites/site.caddy`, written once with
   the site's domains, its network aliases and every snippet argument. It is
   yours from then on; see [caddy.md](caddy.md). On a server with [the shared
   Caddy](caddy.md#the-shared-caddy), the site selects the `member` profile
   instead of `production` and has no Caddy of its own: the routes are written
   to the shared Caddy's `caddy/sites/<project>.caddy`, through its running
   container, as the owner of that directory, then Caddy validates its whole
   configuration and reloads. Before anything is written, a shared Caddy that
   is not running, a project that already has routes there, and a domain it
   already serves are refused; routes Caddy does not accept are removed again.
8. **Metadata**: `.ghost-docker.json`, described in
   [architecture.md](architecture.md#installation-metadata).
9. **Start and verify**, unless `--no-start`: `docker compose up --wait`, so
   MySQL and Ghost must pass their own health checks, then the site is reached
   through its own ingress (next section). A running container is not
   readiness.

**A failed installation removes what it created** — containers, network,
volumes, the data directories, `.env`, `ghost.env`, the metadata, the
written stack files and a member's routes in the shared Caddy — so the same command can simply be run again in the same
directory. That covers a port conflict, a failed pull, a service that never
becomes healthy, and a site that starts but cannot be reached. Before removing
anything it prints the services' last log lines.

### install --infra

Sets up [the shared Caddy](caddy.md#the-shared-caddy) in an empty directory:
`compose.yml`, `caddy/` and the launcher, an `.env` selecting the `infra`
profile, and the network `ghost-ingress`, labelled with the directory and
project, which no Compose project owns. It takes no site options, and writes
no `ghost.env`, data directories or metadata: there is no Ghost. It refuses a
daemon that already has the network, and 80 and 443 held by a container.
Caddy must start and pass its health check; a failure removes everything,
the network included. Site commands (`check`, `backup`, `update`,
`self-update`, `remove`, ...) refuse its directory; `config` works there.

## remove

`./ghost-docker remove [--yes]` takes the site in this directory down and
leaves everything else on the server as it was. Behind the shared Caddy, it
first removes the site's `caddy/sites/<project>.caddy` there and reloads the
shared Caddy, which must be running. Then `docker compose down` removes the
site's containers and networks; its volumes, directory, data and backups
stay, and `docker compose up -d` starts it again (behind the shared Caddy,
once its routes are back). It asks first, at a terminal; without one it needs
`--yes`. It holds the site's lock, so it is refused while a backup, restore or
update runs.

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
| shared caddy, routes | Behind [the shared Caddy](caddy.md#the-shared-caddy), in place of **caddy**: the shared Caddy's health check, from its container, and that its `caddy/sites/<project>.caddy` exists. A server without the shared Caddy's network is an `ERROR`. **https** then asks the shared Caddy, on its network. | `ok` or `ERROR` |
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

## Ports

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

Ghost, and Mailpit on a local site, are published on `127.0.0.1` only. On a
Linux host, Docker Engine before 28.0.0 lets other machines on the same local
network reach ports published on `127.0.0.1` ([Docker's packet filtering
documentation](https://docs.docker.com/engine/network/packet-filtering-firewalls/)),
so there Ghost can be reached directly, around Caddy. `doctor` and `check` warn
about such an engine; upgrade Docker Engine to 28 or later. Docker Desktop and
OrbStack, and rootless Docker, publish ports another way and are not affected.

## Imports

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

### Mail in a local import

Mail settings travel with the configuration. A local site set up to send
through a real mail service will send through it from Docker too, unless
`--with mailpit` is given: then the source's `mail__transport` and
`mail__options__*` are left out (and named, as above), Mailpit's are written
instead, and the imported copy's mail, to real members included, goes to the
inbox. `mail__from` is kept. `--with mailpit` is the only optional service an
import takes; enable the others afterwards.

### Portable bundles

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

### What an import refuses

- `--import` with `--with`: import the site first, then enable optional
  services. A local site may take `--with mailpit`.
- `--domain`, `--admin-domain` or `--email` with a local site's bundle, and
  `--local` with a production site's.
- A `portable` bundle of a production site. The exporter makes portable
  bundles of local SQLite sites only; a site that must move through Ghost
  Admin is installed new, then its content and members are imported there.
- A bundle the site directory's filesystem has no room for, before anything
  is unpacked. The import needs the bundle's unpacked size, measured from its
  own entries, which stays staged until the import is verified; for a
  database bundle, four times `database.sql` for MySQL's tables, indexes and
  binary log; and 256 MB for a new MySQL. The message names what is needed and
  what is free.

## self-update

The update refuses downgrades, incompatible Ghost versions, absent metadata
(except for [the released main layout](#moving-from-the-released-main-layout)),
checkouts, another operation's lock and an unfinished update snapshot. It pulls
images before the outage where possible, keeps a file snapshot in
`.ghost-docker-update/`, then pauses Ghost and ActivityPub and takes a consistent
backup. The site is unavailable until the release starts and verifies.

With `--no-backup` nothing is paused or backed up: the site keeps running until
the release's services start in its place. This suits a local site whose data
you can lose or have backed up yourself; a failure before startup is still
restored from the snapshot, but after startup there is no backup to go back to.

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

## update

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

With `--no-backup` nothing is paused or backed up: the site keeps running on
the earlier Ghost until the new one starts in its place. This suits a local
site whose data you can lose or have backed up yourself. A failure before
startup is still restored from the snapshot, but the newer Ghost's migrations
cannot be undone without a backup.

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

## Moving from the released main layout

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
| `compose.override.yml`, `COMPOSE_FILE` | Kept, and resolved with the new layout and every `.env` setting before anything changes. `.env`'s `COMPOSE_FILE` must start with `compose.yml`. A mount into `/var/lib/ghost`, where main's Ghost image kept its files, is refused: this layout's image keeps them in `/home/ghost/content`, and a backup holds content only in `data/ghost` |
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
`compose.ipv6.yml`, are not seen by the manager: name them in `.env`'s
`COMPOSE_FILE` before you migrate, and every later command runs them
([configuration](configuration.md#the-compose-invocation-contract)).

## backup

| Path in the backup | What it is |
| --- | --- |
| `manifest.json` | What the backup holds: the site (for a clone, the commit checked out when the backup was taken), the image Compose resolves for each service and, for each running one, the exact image it ran (its ID and registry digests), every table's row count, a SHA-256 of every file, and what is not included. |
| `database/ghost.sql` | A `mysqldump` of Ghost's database, taken as the site's own database user in one consistent snapshot. |
| `database/activitypub.sql` | ActivityPub's database, when the `activitypub` profile is on. |
| `content.tar.gz` | The content directory, `data/ghost`: images, media, files, themes, settings. |
| `site/` | `.env`, `ghost.env`, `.ghost-docker.json`, `compose.override.yml` and the overrides `COMPOSE_FILE` names, `caddy/sites/`, `caddy/custom/`, `caddy/global/` and, for a site installed from the image, the stack's files and the launcher the site ran. |

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

### What a backup captures

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
- An override `.env`'s `COMPOSE_FILE` names is backed up with the site, and
  recorded; one outside the site directory is refused. A restore runs the
  backup's `COMPOSE_FILE`.
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

## restore

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
