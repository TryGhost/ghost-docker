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
`ghost.env` has no effect; `scripts/config.sh validate` rejects them rather
than letting them look effective.

That check is **derived, not listed**. Validation asks Compose what the
container actually receives (`docker compose config`, which is pure parsing and
needs no daemon) and reports any `ghost.env` key whose effective value differs.
An entry added to `compose.yml` is therefore caught the moment it is added,
with nothing to keep in sync. The same applies to operator settings in the
wrong file: the set of keys that belong in `.env` is derived from the variables
`compose.yml` interpolates, plus `COMPOSE_*`, plus whatever `.env` already
defines.

Both files hold credentials and should be mode `0600`. The helpers write them
atomically with a restrictive umask and preserve the mode of an existing file.

## Value encoding

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
scripts/config.sh set ghost.env mail__options__auth__pass 'Pa$$w0rd!'
```

`scripts/config.sh validate` reports values Compose would interpolate by
accident. It cannot catch every case: a hand-written `$$` is indistinguishable
from a correctly escaped single `$`, so writing values through `config.sh set`
is the only way to be sure.

### A limit worth knowing

Nothing above makes a hand-written `Pa$$w0rd!` safe: `$$` is indistinguishable
from a correctly escaped single `$`, so no linter can catch it. **Do not
hand-edit a value containing `$`** — use `scripts/config.sh set`, which encodes
it correctly.

Mounting Ghost's own JSON config file instead of `ghost.env` would remove the
interpolation layer entirely. It was evaluated and rejected; §2.1 of
[the plan](ghost-cli-replacement.md) records the findings and the reasons.

### The rules

These are what Docker Compose (compose-go/dotenv) actually implements, verified
by round-tripping real containers in `tests/env-compose.test.mjs`:

| form | interpolated | escapes |
| --- | --- | --- |
| `KEY="value"` | yes — write `$$` for a literal `$` | `\\` → `\`, `\"` → `"`, `\$` → `$`, `\n` → LF, `\r` → CR, `\t` → TAB |
| `KEY='value'` | no | `\'` → `'` only, and a backslash immediately before a quote is not representable |
| `KEY=value` | yes | trailing whitespace trimmed, ` #` starts a comment |

Double quotes are therefore the only form that can represent every value, and
are what the helpers write. JSON string escaping is identical to the
double-quoted dotenv escaping apart from `$`, so `jq` does the character-level
decoding, and bash substitution does the encoding.

One limitation: a value whose quotes span several lines is valid dotenv but is
not editable through these helpers. Such a key is skipped when listing keys and
when linting, and reading or writing it fails with a message telling you to
edit it by hand. Nothing these helpers write ever produces one — newlines are
encoded as `\n`.

Values are read back through `scripts/lib/env.sh`, which parses the file as
data and never sources or evaluates it. Helpers log key names only, never
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
`activitypub`) use `restart: ${RESTART_POLICY:-unless-stopped}`.

One-shot jobs (`activitypub-migrate`, `tinybird-login`, `tinybird-sync`,
`tinybird-deploy`) keep `restart: "no"`. A completed or failed job stays
stopped; the restart policy is not migration orchestration and is not
readiness.

`ghost` and `db` have real health checks: Ghost's probe requires the Admin API
to answer, and MySQL's probe requires a real client connection to the
application database. A running container or a redirect is not readiness.

Container logs are capped (`LOG_MAX_SIZE`, `LOG_MAX_FILE`) so a long-running
site cannot fill the disk.

## Service names on the network

Each service has a unique alias suffixed with the project name:

- `ghost-${COMPOSE_PROJECT_NAME}:2368`
- `db-${COMPOSE_PROJECT_NAME}:3306`
- `traffic-analytics-${COMPOSE_PROJECT_NAME}:3000`
- `activitypub-${COMPOSE_PROJECT_NAME}:8080`

Generated proxy routes and helper clients use these, never the bare service
name. `COMPOSE_PROJECT_NAME` is the site's stable identity and is kept
independent of the directory name.

## Database connection

`DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME` and `DATABASE_USER` are
parameterized even though the single-site defaults (`db`, `3306`, `ghost`,
`ghost`) do not change. Backup, restore and import all use the same connection
contract.

## Installation metadata

`.ghost-docker.json` records the schema version, installation time, mode,
release channel, installed stack version/commit/ref, project identity, resolved
Ghost image and digest, selected profiles, and completed migrations. Its schema
is specified in §2.2 of [the plan](ghost-cli-replacement.md). It is gitignored,
mode `0600`, and machine generated — do not hand-edit it. Durable operation
journals for in-progress work and recovery state are separate files, and land
with backup/restore in S4.

```json
{
  "schemaVersion": 1,
  "installedAt": "2026-09-03T09:12:44Z",
  "mode": "production",
  "channel": "stable",
  "stack": { "version": "v1.2.3", "commit": "…", "ref": "v1.2.3" },
  "site": {
    "project": "ghost-example-com", "dir": "/opt/ghost/example.com",
    "url": "https://example.com", "domain": "example.com", "adminDomain": null
  },
  "ghost": {
    "image": "ghost", "tag": "6.62.0-next-alpine",
    "version": "6.62.0", "digest": "sha256:…"
  },
  "profiles": ["production"],
  "migrations": []
}
```

A field that was not supplied is `null` rather than an empty string, so "not
known" and "deliberately empty" stay distinguishable. The digest is the
immutable image identity, recorded so the exact image can be found again during
recovery even after a tag moves.

`scripts/lib/meta.sh` is the reader and writer. It writes atomically, refuses a
document without the right `schemaVersion`, and refuses to *read* one written by
a newer schema rather than misinterpreting it.

An installation that predates this file is supported explicitly: `meta_present`
answers that question, and readers must treat a missing file as "unknown,
pre-metadata install", not as a broken site. `scripts/site.sh info` prints that
state in words.

## The Compose invocation contract

Every helper uses one contract:

```bash
docker compose --project-directory "$DIR" -f "$DIR/compose.yml" ...
```

`--project-directory`, never `-C`. `COMPOSE_FILE` is unset by the helpers,
because it changes override auto-loading, and an explicit `-f` replaces the
selected list. Opt into an override file with `GD_COMPOSE_OVERRIDES`:

```bash
GD_COMPOSE_OVERRIDES=compose.ipv6.yml scripts/caddy.sh validate
```

## Ghost image layout

The default `GHOST_VERSION` is a `next` variant, which installs Ghost directly
under `/home/ghost`. The older variants use `/var/lib/ghost/versions/<v>` with a
`current` symlink. Two variables carry the difference so that pinning an older
image still works:

| Variable | Default (`next`) | Older layout |
| --- | --- | --- |
| `GHOST_CONTENT_PATH` | `/home/ghost/content` | `/var/lib/ghost/content` |
| `GHOST_TINYBIRD_PATH` | `/home/ghost/core/server/data/tinybird` | `/var/lib/ghost/current/core/server/data/tinybird` |

Set both if you pin a `GHOST_VERSION` from the older layout; the content mount
and the Tinybird sync job read them.

`scripts/config.sh validate` checks that `GHOST_CONTENT_PATH` matches the image
by reading the image's own `GHOST_CONTENT` variable, rather than inferring it
from the tag name — so a future layout change is caught without updating a
mapping. The check is skipped when the image has not been pulled yet.

## Prerequisites

Runtime, on the server:

- `bash` — the helper scripts and `scripts/migrate.sh` are bash. Kept
  compatible with bash 3.2 so macOS's system bash works for local development.
- Docker Engine 25.0.0 — for `healthcheck.start_interval`
- Docker Compose v2.24.0 — for `env_file` `required` and `depends_on` `required`
- `jq` — used by the helpers for JSON, including `.ghost-docker.json`

`install.sh` verifies all three during preflight, and `bootstrap.sh` also needs
`git`. `scripts/migrate.sh` already required `jq`, so this is not a new
prerequisite for existing servers.

Every other host utility the scripts invoke is POSIX and is listed in
`GD_HOST_UTILITIES` in `scripts/lib/preflight.sh`. That list is the tool
contract: `tests/install-e2e.test.mjs` runs a complete installation with a
`PATH` built from exactly it, so a GNU-only or otherwise unusual dependency
fails a test rather than someone's server. Nothing decides Docker access from
`docker` group membership — see [install.md](install.md#host-tools).

Development only, not needed on a server:

- Node.js 20+, to run the test suite with its built-in runner
  (`node --test tests/*.test.mjs`). There is no `package.json` and nothing to
  install; the repository is not a Node package.

The one exception is the legacy `scripts/migrate.sh`, which shells out to
`scripts/config-to-env.js` and so needs Node on the host. `install.sh --import`
replaces that script outright, and the dependency goes with it.

Both the declared minimum and a current Compose are exercised by
`tests/compose-matrix.test.mjs`.

## Existing installations

This layout is a breaking change for checkouts made before it landed. The
migration is owned by the stack updater (S6); the changes it has to handle are:

- `caddy/Caddyfile` is now **tracked**. An existing installation has an
  untracked file at that exact path, and Git refuses to overwrite an untracked
  file with a tracked one. The updater moves the operator's file aside — into
  `caddy/custom/` where its routes keep working — *before* the checkout.
- The snippets in `caddy/snippets/` now take their upstreams and domains as
  import arguments instead of reading `{$DOMAIN}` / `{$ACTIVITYPUB_TARGET}`
  from the Caddy container's environment, which the `caddy` service no longer
  sets. A hand-written Caddyfile that imports them needs the arguments added.
- Ghost application configuration moves from `.env` to `ghost.env`. `.env`
  keeps the Compose and operator settings and is no longer passed into the
  Ghost container.
- `COMPOSE_PROFILES` must gain a site mode (`production` for an existing
  server), and `SITE_MODE`, `URL`, `PROJECT_DIR` and an exact `GHOST_VERSION`
  pin must be added.

`scripts/migrate.sh` still migrates a Ghost-CLI installation and has been
updated to write Ghost configuration into `ghost.env`. It is kept until the
bundle import in [docs/bundle-v1.md](bundle-v1.md) has passed fidelity and
recovery testing.

## Why `jq` is a prerequisite

The helpers use `jq` for JSON, starting with `.ghost-docker.json`.

The implementation plan originally recorded "No host Node or jq requirement".
That was changed during S1, deliberately, and §1 of
[the plan](ghost-cli-replacement.md) now records the decision:

- `scripts/migrate.sh` already declared `jq` in its `required_commands`
  preflight, so servers running the supported migration path already have it.
- Hand-rolling a JSON writer and reader in shell to avoid it cost about
  240 lines and bought nothing an operator can see.

Node.js is **not** a runtime requirement. It is used only to run the test
suite. `install.sh` verifies `docker`, `docker compose` and `jq` during
preflight, and does not require Node.
