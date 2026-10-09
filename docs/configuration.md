# Configuration

## Two files, two audiences

| File | Contents | Read by |
| --- | --- | --- |
| `.env` | Compose and operator settings: project identity, site mode, ports, data locations, restart policy, and infrastructure credentials such as `DATABASE_ROOT_PASSWORD`. | Docker Compose, for `${...}` interpolation |
| `ghost.env` | Ghost application settings only, in Ghost's `section__subsection__key` form. | The `ghost` container, as its only `env_file` |

`.env` is **never** passed into the Ghost container. It holds the MySQL root
password and other infrastructure controls that Ghost has no reason to see.

Keys the container owns — `url`, `admin__url`, `NODE_ENV`, `server__*`,
`paths__*` and `database__*` — are set as explicit Compose `environment`
entries. Compose `environment` overrides `env_file`, so setting them in
`ghost.env` has no effect; `./ghost-docker config validate` rejects them rather
than letting them look effective.

That check is **derived, not listed**. Validation asks Compose what the
container actually receives (`docker compose config`, which is pure parsing and
needs no daemon) and reports any `ghost.env` key whose effective value differs.
An entry added to `compose.yml` is therefore caught the moment it is added,
with nothing to keep in sync. The same applies to operator settings in the
wrong file: the set of keys that belong in `.env` is derived from the variables
Compose reports it interpolates (`docker compose config --variables`, which
includes `compose.override.yml`), the settings `.env.example` documents
(commented out or not), `COMPOSE_*`, and whatever `.env` already defines.

A site's domain is not a setting of its own: it is the host of `URL`, and an
admin domain the host of `ADMIN_URL`. A production `URL` must be `https://`.
Caddy serves the addresses in `caddy/sites/site.caddy`; `check` asks it for
each host, so a change to one that is not made to the other is reported.

Both files hold credentials and should be mode `0600`. The helpers write them
atomically with a restrictive umask and preserve the mode of an existing file.

## Value encoding

Migration bundle v1 config values are raw strings, with no dotenv encoding. The
importer applies the rules below exactly once when writing `ghost.env`; public
and admin URLs are separate manifest fields mapped to `.env`. See
[bundle-v1.md](bundle-v1.md) for the schema and source guarantees.

Compose interpolates dotenv values, **including inside double quotes**, and
`env_file` values are no exception. A literal dollar sign must be written `$$`.
There is no quoting a person naturally reaches for that avoids this, and the
only symptom is a wrong value at runtime:

```dotenv
mail__options__auth__pass=s3cr$t!     # Ghost receives: s3cr!
mail__options__auth__pass=Pa$$w0rd!   # Ghost receives: Pa$w0rd!
```

Let the helper encode it instead of guessing:

```bash
./ghost-docker config set ghost.env mail__options__auth__pass 'Pa$$w0rd!'
./ghost-docker config get ghost.env mail__options__auth__pass
```

The file may be left out: a key `.env` is meant to hold (as derived above)
goes there, and any other in `ghost.env`, so `config set GHOST_PORT 2369`
writes `.env`. A value that starts with a dash follows `--`. `set` replaces the
key's assignment in place, keeping the comments around it, writes the file
atomically, and keeps its mode; a new file is `0600`. It holds
`.ghost-docker.lock` while it reads and writes, so a second `set`, or a
`backup`, `restore` or `self-update`, running at the same time is refused
rather than one of the two changes being lost. Only the key name is printed,
never a value.

`./ghost-docker config validate` reports values Compose would interpolate by
accident. It cannot catch every case: a hand-written `$$` is indistinguishable
from a correctly escaped single `$`, so writing values through `config set`
is the only way to be sure.

`ghost.env` keeps Ghost's image-provided defaults. Replacing its JSON config
would require maintaining a copy of those defaults; use `config set` for
values needing escaping.

### The rules

These are what Docker Compose (compose-go/dotenv) actually implements. The
manager reads them the same way, and `manager/test/integration/compose.test.ts`
checks every hand-written case in `manager/test/dotenv.ts` against the Compose
in the image:

| form | interpolated | escapes |
| --- | --- | --- |
| `KEY="value"` | yes — write `$$` (or `\$`) for a literal `$` | `\\` → `\`, `\"` → `"`, `\$` → `$`, `\n` → LF, `\r` → CR, `\t` → TAB, `\a` `\b` `\f` `\v`, `\0` and three octal digits; any other backslash is kept as it is, `\'` included |
| `KEY='value'` | no | `\'` → `'`; any other backslash is kept as it is |
| `KEY=value` | yes — `$$` for a literal `$` | none: `some\tvalue` is a backslash and a `t`; trailing whitespace trimmed, a space then `#` starts a comment (a tab then `#` does not) |

Double quotes are therefore the only form that can represent every value, and
are what the tooling writes.

One limitation: a value whose quotes span several lines is valid dotenv but is
not editable through `./ghost-docker config`. Such a key is skipped when listing
keys and when linting, and reading or writing it fails with a message telling you
to edit it by hand. Nothing the tooling writes ever produces one — newlines are
encoded as `\n`.

Values are read back by the manager, which parses the file as data and never
sources or evaluates it. It logs key names only, never
values — there is no list of "sensitive" keys to keep in sync, because any
value in either file may be a credential.

## Site modes and profiles

Site mode is selected through `COMPOSE_PROFILES`, and exactly one of `local`
or `production` must be present:

| Profile | Services | Ingress |
| --- | --- | --- |
| `local` | `ghost`, `db` | Ghost on `127.0.0.1:${GHOST_PORT}` |
| `production` | `ghost`, `db`, `caddy` | Caddy on `${HTTP_PORT}` / `${HTTPS_PORT}` |

Optional per-site profiles are added to the same list and are purely additive.
Adding one never changes the site mode:

| Profile | Services | Cost |
| --- | --- | --- |
| `analytics` | `traffic-analytics` plus the Tinybird one-shot jobs | one long-running Node service (~100-200 MB RSS) and a Tinybird workspace |
| `activitypub` | `activitypub`, `activitypub-migrate` | one long-running Node service (~150-250 MB RSS), one migration job per start, one extra MySQL database |
| `mailpit` | `mailpit`, its inbox on `127.0.0.1:${MAILPIT_PORT}` | one long-running Go service (~20-30 MB RSS); its messages in `${MAILPIT_DATA_LOCATION}` |

`mailpit` is for local sites only: validation rejects it beside `production`,
where it would catch the site's real mail. Selecting the profile only runs
Mailpit; Ghost sends to it because `ghost.env` says so (`install --with
mailpit` writes those settings; see [install.md](install.md#optional-services)).

`supervisor` is reserved for the upgrade supervisor and currently defines no
service. Any other profile name is rejected by validation.

ActivityPub and analytics are **per-site**: each site owns its ActivityPub
database, storage and serving URL, and its own Tinybird credentials, workspace
selection and schema deployment.

Ghost is always published on the loopback interface only, in both modes, so it
is never exposed publicly except through Caddy.

Caddy is part of `production` rather than an optional profile, deliberately: a
supported bring-your-own-proxy path would mean validating the operator's
forwarded-header configuration, and getting `X-Forwarded-Proto` wrong yields
incorrect absolute URLs and non-secure cookies — a site that half works. If you
already run nginx or Apache, you can still point it at
`127.0.0.1:${GHOST_PORT}` and edit `compose.yml` to drop the caddy service or
move it off 80/443, but that is an unsupported manual customization and stack
updates may touch `compose.yml`.

## Lifecycle

Long-running services (`ghost`, `db`, `caddy`, `traffic-analytics`,
`activitypub`, `mailpit`) use `restart: ${RESTART_POLICY:-unless-stopped}`.

One-shot jobs (`activitypub-migrate`, `tinybird-login`, `tinybird-sync`,
`tinybird-deploy`) keep `restart: "no"`. A completed or failed job stays
stopped; the restart policy is not migration orchestration and is not
readiness.

`ghost`, `db`, `caddy` and `mailpit` have real health checks: Ghost's probe
requires the Admin API to answer, MySQL's probe requires a real client
connection to the application database, Caddy's requires its admin API to
answer with its configuration loaded, and Mailpit's asks its own readiness
endpoint. A running container or a redirect is not readiness. `check` and
installation report these health checks; they do not repeat them. Caddy's
admin API stays on, on `127.0.0.1:2019` inside its container, because the
health check and `caddy reload` both use it.

Container logs are capped (`LOG_MAX_SIZE`, `LOG_MAX_FILE`) so a long-running
site cannot fill the disk.

## Service names on the network

Each service has a unique alias suffixed with the project name:

- `ghost-${COMPOSE_PROJECT_NAME}:2368`
- `db-${COMPOSE_PROJECT_NAME}:3306`
- `traffic-analytics-${COMPOSE_PROJECT_NAME}:3000`
- `activitypub-${COMPOSE_PROJECT_NAME}:8080`
- `mailpit-${COMPOSE_PROJECT_NAME}:1025` (SMTP)

Generated proxy routes and helper clients use these, never the bare service
name. `COMPOSE_PROJECT_NAME` is the site's stable identity and is kept
independent of the directory name. `install` chooses it once: the domain's in
production, and locally the directory's name and a random pair
(`ghost-local-blog-secondary-roadrunner`) that no project on the daemon has,
so two local sites in directories of the same name never share one.

Compose finds a project's containers by its name alone, so two directories
with one name would each act on the other's containers. Before `install`,
`self-update`, `backup` and `restore` change anything, and before `check`
reads the services, the manager asks the daemon which directory the
project's containers were made in (Compose's
`com.docker.compose.project.working_dir` label), and refuses a project whose
containers another directory made. A site moved to a new directory is one of
these until its old containers are removed: `docker compose down` in the new
directory, then start it again.

The manager uses them too. `check`, `install`, `self-update`, `backup`, `restore`
and an import join the site's network while they ask its services
something, and leave it afterwards. They find the network from the site's
running containers, so one an override renames or makes external works the
same way. A service whose alias an override removes is reached by its
address on the network instead.

## Database connection

`DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME` and `DATABASE_USER` are
parameterized even though the single-site defaults (`db`, `3306`, `ghost`,
`ghost`) do not change. Backup, restore and import all use the same connection
contract.

## Installation metadata

`.ghost-docker.json` is private and machine-owned; do not hand-edit it. Use
`./ghost-docker info` to inspect it. Its meaning and schema ownership are
specified in [architecture.md](architecture.md#installation-metadata).
[Compatibility](architecture.md#compatibility) begins with the first stable
release; earlier development formats may be refused.

For locks, interrupted updates and set-aside restores, follow the
[operator recovery instructions](install.md#backup-and-restore).

## The Compose invocation contract

Every manager command uses one contract:

```bash
docker compose --project-directory "$DIR" -f "$DIR/compose.yml" ...
```

`--project-directory`, never `-C`. `COMPOSE_FILE` is unset by the manager,
because it changes override auto-loading, and an explicit `-f` replaces the
selected list. The manager adds the site's `compose.override.yml` after
`compose.yml` when it exists, which is what plain `docker compose` does on its
own, so the two run the same site (see [Your own Compose
overrides](#your-own-compose-overrides)). Opt into any other override file
with `GD_COMPOSE_OVERRIDES` (a comma-separated list, in merge order):

```bash
GD_COMPOSE_OVERRIDES=compose.ipv6.yml ./ghost-docker check
```

Relative paths are relative to the site. Only the root `compose.override.yml`
is implicit: `overrides/compose.override.yml` is an additional override like
any other. Backup requires additional overrides to be inside the site, records
their order and copies them; restore requires the same selection. Use matching
`-f` arguments for direct Compose commands.

The manager passes only Docker connection/tool-path variables from its own
environment, so its image's settings cannot override the site's `.env`.
Explicit profile selections apply only to that invocation.

## Your own Compose overrides

For local changes the stack does not offer, such as an extra mount or a
different published address, put a `compose.override.yml` in the site
directory. It is yours: installation never writes one and updates never
touch it, and a clone's `.gitignore` leaves it out.

Plain `docker compose` in the site directory merges `compose.override.yml`
into `compose.yml` on its own, and every `./ghost-docker` command adds it the
same way, so both run the site with your changes and nothing has to be set.
That includes installation: a `compose.override.yml` already in a new site
directory is used from the first start.

An override is a manual customization: when a stack update changes a service
your file also changes, read both. To develop a theme against a local site,
mount its folder over the copy in the content directory. Read-only keeps the
container's user from writing into your folder:

```yaml
# compose.override.yml
services:
  ghost:
    volumes:
      - /Users/me/code/my-theme:/home/ghost/content/themes/my-theme:ro
```

The path inside the container is `GHOST_CONTENT_PATH` (`/home/ghost/content`
for the default image) followed by `themes/<name>`; activate the theme in
Ghost Admin as usual, and `docker compose restart ghost` when a change does
not show.

## Ghost image layout

Install and import require the `next` image layout. The manager reads the
image's `GHOST_CONTENT` and `GHOST_INSTALL` declarations to set
`GHOST_CONTENT_PATH` and `GHOST_TINYBIRD_PATH`; it refuses the older
Ghost-CLI-installed layout. `config validate` checks the content path against
the pulled image's own declaration, and skips that check before it is pulled.
The [bundle contract](bundle-v1.md#minimum-source-version) defines the migration
minimum and exact source-version requirement.

## Existing installations

Do not use `git pull` to move a released `main` installation to this layout.
That migration is still [roadmap work](ghost-cli-replacement.md#s6b--migration-from-the-released-main-layout).
Moving a Ghost-CLI site is a separate, supported import described in
[install.md](install.md#importing-a-ghost-cli-site).

## Installed image pins

The installer writes `GHOST_IMAGE_REF=ghost@sha256:...`. This is the authoritative
reference for Ghost and Tinybird sync, so a later pull cannot move the site to a
new image. `GHOST_IMAGE` and `GHOST_VERSION` record the requested repository/tag;
without `GHOST_IMAGE_REF`, they remain the fallback for manually configured sites.
Image-changing operations must update the pin and recorded metadata together.
