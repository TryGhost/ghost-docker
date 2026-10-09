# Migration bundle v1 — encoding contract

Ghost-CLI exports a migration bundle; ghost-docker imports it. This document
owns its format and importer requirements. Use Ghost-CLI **1.33.3 or later**;
see the exporter's [migration bundle documentation](https://github.com/TryGhost/Ghost-CLI/blob/v1.33.3/docs/migration-bundle.md)
and [operator import steps](install.md#importing-a-ghost-cli-site).

The strict schema in [`manager/src/bundle/manifest.ts`](../manager/src/bundle/manifest.ts)
depends only on zod so the exporter can share it; importer policy stays outside
it. Bundle v1 is not frozen: exporter, importer, documentation and fixtures
change together, without draft-format adapters.

Local `mysql-dump`, `mysql-data` and `portable` bundles are supported, and
production `mysql-dump` and `mysql-data` ones. For a portable bundle the manager
installs the site and content; JSON and members CSV are imported through Ghost
Admin. A portable bundle of a production site is refused. `sourceInstallType`
selects the site mode; a production site is served on the hosts of `url` and
`adminUrl` unless the operator names others (on another domain, `adminUrl` is
not carried), and a URL with plain `http`, a
port or a path is refused rather than served at another address.

## Bundle kinds

| `kind` | Source | Database payload | Fidelity |
| --- | --- | --- | --- |
| `mysql-dump` | MySQL (`mysql`/`mysql2`), local or production | `mysqldump` of the selected database: schema and data | Complete database |
| `mysql-data` | Local SQLite; the exporter's default for SQLite | Data-only MySQL `INSERT`s for every table; no schema | Complete database, loaded into a schema Ghost creates |
| `portable` | Local SQLite, only with `--sqlite-format portable` | Content JSON and members CSV from the Admin API | Lossy; see "Portable fidelity" below |

Production SQLite installations and unknown database clients are rejected by
the exporter and are not a supported source.

`mysql-data` is the expected route for a local SQLite site. `portable` is the
fallback for a source whose rows the exporter refuses to write as `mysql-data`
because MySQL would reject them. The importer never substitutes one kind for
another: it imports the kind the manifest declares.

## Manifest

```json
{
  "bundleVersion": 1,
  "bundleCreatedAt": "2026-09-02T12:00:00Z",
  "sourceInstallType": "production",
  "kind": "mysql-dump",
  "ghost": {
    "version": "6.61.0"
  },
  "url": "https://example.com",
  "adminUrl": "https://admin.example.com",
  "database": {"path": "database.sql"},
  "content": "content/",
  "config": {
    "mail__options__auth__pass": "p$ssword",
    "mail__from": "'Acme Support' <support@example.com>"
  }
}
```

### Required metadata

| Field | Requirement |
| --- | --- |
| `bundleVersion` | Must be `1`. |
| `bundleCreatedAt` | **Required.** RFC 3339 timestamp in UTC. |
| `sourceInstallType` | **Required.** Exactly `local` or `production`. Derived from the source instance’s actual local/production process classification; the importer selects its mode from this field. |
| `kind` | Required. Exactly `mysql-dump`, `mysql-data` or `portable`; see "Bundle kinds". Any other value is rejected. |
| `ghost.version` | Exact source Ghost version, 6.61.0 or a later 6.x release, including any prerelease suffix (`6.61.0-rc.1` is older than 6.61.0). The import happens *at* this version, and upgrading is a separate operation; see "Minimum source version". |
| `url` | Required public URL, unchanged from source config. |
| `adminUrl` | Optional separate admin URL, unchanged. |
| `database.path` | Required relative path: `database.sql` for `mysql-dump` and `mysql-data`, content JSON for portable. |
| `database.rows` | Required for `mysql-data` only; a map of table name to the number of rows written. Rejected as malformed if absent, not an object, or holding a value that is not a non-negative integer. |
| `database.members` | Required for portable only; relative members CSV path. A successful zero-byte export means no members; skip member import for that file. |
| `content` | Required `content/` asset root. |
| `config` | Required raw string map, described below. |

`mysql-data` `database` example:

```json
{
  "path": "database.sql",
  "rows": {"migrations": 354, "posts": 3, "users": 1}
}
```

Portable `database` example (filenames can vary; always read the manifest):

```json
{
  "path": "content/data/content-from-v6.61.0-on-2026-09-14-12-00-00.json",
  "members": "content/data/members-from-v6.61.0-on-2026-09-14-12-00-00.csv"
}
```

`kind` appears only at the top level and the version only at `ghost.version`.
Matching exporter fixtures are in `tests/fixtures/migration-bundle-v1/` and
Ghost-CLI's `test/fixtures/migration-bundle-v1/`.

A bundle missing `bundleCreatedAt` or `sourceInstallType`, or carrying a
`sourceInstallType` outside that set, is rejected. There is no inference
fallback and no default.

Every path in the manifest is validated. Path traversal and absolute member
paths are rejected, and so is every symbolic link, wherever it points,
including in directory bundles: the exporter materializes theme links and
never emits one, so the importer has no reason to follow any. Devices, FIFOs
and other special files are rejected the same way.

A bundle is accepted as a directory, a gzip-compressed tar (`--archive tgz`),
an uncompressed tar, or a zip (`--archive zip`). The manager unpacks each
itself, so nothing on the host is needed for any of them.

### `config`

`config` is a **flat map of Ghost configuration keys to raw string values**.

- Keys are the flattened `section__subsection__key` form.
- Values are the **raw strings**, exactly as Ghost would receive them. They
  carry **no dotenv quoting and no dotenv escaping** of any kind: no
  surrounding quotes added by the exporter, no `$$` for a dollar sign, no
  backslash escapes.
- Serializing those values safely for Docker Compose is the **importer's**
  job. The importer writes them into `ghost.env` using the encoding described
  in [configuration.md](configuration.md).

So a mail password of `p$ssword` appears in the manifest as the
JSON string `"p$ssword"`, and reaches `ghost.env` as `mail__options__auth__pass="p$$ssword"`.
An exporter that pre-quotes or pre-escapes a value produces a corrupted
import, and the round trip is tested through real Docker Compose containers
rather than by comparing exporter strings.

### Keys the importer omits

The container owns these keys, so the importer drops them from `config`
rather than writing them into `ghost.env`, where they would be silently
overridden:

- `url`, `admin__url`
- `database__*`
- `server__*`
- `paths__*`
- `process`, `logging__transports`, `logging__path`
- upgrade-adapter controls

With `install --import --with mailpit`, the importer also drops the source's
mail transport (`mail__transport`, `mail__options__*`) and writes the site's
Mailpit in its place, so a local copy never sends real mail. `mail__from` is
kept.

Public and admin URLs are mapped deliberately into `.env` (`URL`,
`ADMIN_URL`; the domains are their hosts), preserving supported path and port semantics or
rejecting an unsupported URL with a clear message. Operator overrides of
URL and mode given at import time are retained.

The exact keys are whatever `compose.yml` sets in the `ghost` service's
`environment`, read from the resolved Compose configuration rather than kept as
a second list; `./ghost-docker config validate` enforces it.

## Importing `mysql-data`

`database.sql` in a `mysql-data` bundle carries every row of every SQLite
table, including `migrations` and `migrations_lock`, as MySQL `INSERT`s. IDs,
staff credentials, members, subscriptions, history and core settings (session
secrets, JWT keys, `site_uuid`) travel unchanged. The file contains **no
schema**. SQLite does not record the column sizes, unsigned integers or prefix
index lengths of Ghost's MySQL schema, so DDL rebuilt from it would be a
non-canonical database that later Ghost migrations do not expect. The importer
never synthesizes schema. It must:

1. Provision an empty `utf8mb4` database and its user.
2. Start Ghost at exactly `ghost.version` against that database, with no
   public ingress, and wait for it to finish creating its schema, views and
   fixtures. Stop it.
3. Load `database.sql` with the `mysql` client, as the site's database user. The file disables foreign key
   checks, uses strict SQL mode, and empties and refills each table inside one
   transaction, so a failure (for example a column the destination schema
   lacks) rolls back and the import fails as a whole.
4. Compare `SELECT COUNT(*)` for every table named in `database.rows` with the
   recorded count. A mismatch fails the import.
5. Start Ghost. Its migrations see the source's migration history.

The importing Ghost image must therefore be the source version exactly: a
newer image creates a schema the source rows were not written for.

## Minimum source version

A bundle's `ghost.version` must be **6.61.0** or a later 6.x release. Every
import runs at exactly that version, in the version's `next` `ghost` image
(`VERSION-next-alpine`), and 6.61.0 is the first release published in that
variant, for amd64 and arm64 alike. Older releases exist only in the
Ghost-CLI-installed `-alpine` layout, which ghost-docker does not run.

Both sides check it, independently. `ghost migrate-export` refuses an older
source before Ghost is stopped or anything is written; ordinary `ghost export`
is unaffected. The importer refuses an older bundle, such as one written by a
Ghost-CLI release that only checked for 6.x, before anything is provisioned.
Either way, the fix is in the source installation: `ghost update`, check that
the site works, then `ghost migrate-export` again.

Dates are written as UTC `YYYY-MM-DD HH:MM:SS`. `migrations_lock` is written
unlocked. The exporter refuses, before producing a bundle, strings longer than
their declared `varchar` length and unique keys that differ only by case or
accents. One class of bad data is not detectable from SQLite and surfaces at
step 3: plain `text` values over 64KB in columns Ghost's MySQL schema declares
as `text`. Report that failure with the option of re-exporting as `portable`.

## Importing `mysql-dump`

The dump is loaded with the `mysql` client into the empty database, as the
site's database user and never as root, so a dump can affect nothing but that
database. `mysqldump` records the account that defined each view and trigger
(`DEFINER=`), and creating an object on another account's behalf needs a
privilege that user deliberately lacks. Those clauses are therefore removed
from mysqldump's own version-comment lines during the load, and the objects
belong to the site's user, which is the account Ghost connects as. Nothing
else in the dump is rewritten.

After the load the importer checks that the database has a Ghost migration
history, then starts Ghost on it.

## Reading the bundle

The manager unpacks a bundle into a private staging directory inside the site
directory, and every later step works from that copy. Before anything else on
the host changes:

- archive entries are filtered as they are extracted: an absolute path, a `..`
  component, a symbolic or hard link, a device or any other special entry is
  refused, and so is a directory bundle that contains one;
- the manifest is validated against a schema that encodes this document. The
  schema is the single definition of the manifest and is intended to be shared
  with the exporter;
- the files the manifest names must exist as regular files.

None of this depends on an already-valid site `.env` or on a running Ghost,
because neither exists yet at that point in the import.

This is validation, not isolation. Importing a bundle means trusting it: its
SQL becomes the site's database and its themes become the site, so no amount
of care in unpacking makes a hostile bundle safe to import. What the importer
does guarantee is narrower and worth having: a bundle cannot write outside the
site directory, and its SQL runs as the site's own database user, so it can
touch nothing but that site's database.

## Source consistency and cutover

Ghost-CLI's `ghost migrate-export --leave-stopped` deliberately leaves the source
stopped after successful export and attempts to stop it after export failure.
Preflight rejection leaves the source unchanged. Ordinary exports restore its
original running state, including a stopped portable source temporarily started
for the API. Failed exports remove partial outputs. Recovery is `ghost start`
in the original installation; verify `ghost ls` if a lifecycle operation failed.

SQLite sources are local development sites only; production SQLite and
unsupported clients are rejected. `--sqlite-format mysql-data|portable` selects
how a SQLite database travels, defaults to `mysql-data`, and is refused for
MySQL sources.

`mysql-data` reads the SQLite file after Ghost is stopped, so it is a consistent
snapshot and needs no API access or staff token. MySQL sources are likewise
stopped before copying assets and dumping the database; external database
writers must also be quiescent.

Portable capture order is content JSON → members CSV → stop Ghost → copy assets.
Users must avoid editing throughout export. This is sequential capture, **not an
atomic snapshot or write freeze**; `bundleCreatedAt` is manifest creation time.

Directories/files/archives are private from creation (`0700`/`0600`). Existing
outputs, source overlap (including symlink aliases), and archive collisions are
refused before source lifecycle changes. Supported content includes hidden files,
full themes, settings, files/images/media, and data redirects. Runtime logs/apps,
SQLite files, external storage and custom adapters are omitted. Individual theme
directory links under `content/themes/` are resolved and materialized as regular
directories, including CLI defaults linked through `current` and external
development themes. Output may not overlap their resolved targets. Broken/cyclic
theme links, links to non-directories, nested links and other content links/special
files are rejected explicitly by the exporter.

### Portable fidelity

Portable content/member files preserve Ghost API response bytes, not a complete
database. Author data travels but reusable staff authentication does not; IDs may
be remapped by import. Default content export omits integrations/API keys/webhooks,
member and subscription relationship tables, comments and event/email history.
CSV carries member fields and customer/tier references, not complete paid
subscription or per-newsletter relationships. Re-establish staff access and
integrations; reconnect/reconcile Stripe using a supported importer.

`mysql-dump` and `mysql-data` bundles preserve database records and
relationships without these losses; external services and storage still need
separate configuration.

See the exporter's [fidelity and recovery documentation](https://github.com/TryGhost/Ghost-CLI/blob/v1.33.3/docs/migration-bundle.md).
The manager places a portable bundle's content and leaves its content JSON and
members CSV to Ghost Admin; their fidelity is that of Ghost Admin's own import.

Keep the final source stopped and intact until the destination is accepted.
Restarting it permits writes that invalidate the final snapshot.
