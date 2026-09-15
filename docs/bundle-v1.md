# Migration bundle v1 — encoding contract

Ghost-CLI exports a migration bundle; ghost-docker imports it. This document
fixes the parts of the format that the importer depends on. It is the
authority for the encoding and required metadata; the exporter
(Ghost-CLI PR #2333 and its `docs/migration-bundle.md`) and its fixtures are
updated to match.

**Bundle v1 is unpublished.** There is no draft-format compatibility path: a
bundle that does not meet this contract is rejected with an actionable error,
not silently adapted. Exporter, importer, documentation and fixtures change
together, and only then is v1 frozen.

Steps referenced below are defined in
[the implementation plan](ghost-cli-replacement.md); each lands as its own
pull request.

Status of the work:

- This document and the importer-side contract: **S1** (this step).
- Exporter implementation, fixtures and cutover support: **S3**.
- Importer implementation and the cutover workflow: **S5**.

The importer's target is `ghost.env`. Replacing it with a mounted Ghost JSON
config file was evaluated and rejected; see §2.1 of
[the plan](ghost-cli-replacement.md). The serialization rules below therefore
stand as written.
- Migration of existing Ghost-CLI installations: **S6**.

## Manifest

```json
{
  "bundleVersion": 1,
  "bundleCreatedAt": "2026-09-02T12:00:00Z",
  "sourceInstallType": "production",
  "kind": "mysql-dump",
  "ghost": {
    "version": "6.2.0"
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
| `kind` | Required `mysql-dump` or `portable`. MySQL/mysql2 or local SQLite development respectively. |
| `ghost.version` | Exact source Ghost 6.x version. Validated as supported; the import happens *at* this version, and upgrading is a separate operation. |

| `url` | Required public URL, unchanged from source config. |
| `adminUrl` | Optional separate admin URL, unchanged. |
| `database.path` | Required relative path: `database.sql` for MySQL, content JSON for portable. |
| `database.members` | Required for portable only; relative members CSV path. A successful zero-byte export means no members; skip member import for that file. |
| `content` | Required `content/` asset root. |
| `config` | Required raw string map, described below. |

Portable `database` example (filenames can vary; always read the manifest):

```json
{
  "path": "content/data/content-from-v6.2.0-on-2026-09-14-12-00-00.json",
  "members": "content/data/members-from-v6.2.0-on-2026-09-14-12-00-00.csv"
}
```

`kind` appears only at the top level and the version only at `ghost.version`.
There are no `database.kind`, `ghostVersion`, or `sourceEnvironment` aliases.
Matching exporter fixtures are in `tests/fixtures/migration-bundle-v1/` and
Ghost-CLI's `test/fixtures/migration-bundle-v1/`.

A bundle missing `bundleCreatedAt` or `sourceInstallType`, or carrying a
`sourceInstallType` outside that set, is rejected. There is no inference
fallback and no default.

Every path in the manifest is validated. Path traversal, absolute member
paths, and symlinks or hardlinks that escape the bundle are rejected,
including in directory bundles.

### `config`

`config` is a **flat map of Ghost configuration keys to raw string values**.

- Keys are the flattened `section__subsection__key` form.
- Values are the **raw strings**, exactly as Ghost would receive them. They
  carry **no dotenv quoting and no dotenv escaping** of any kind: no
  surrounding quotes added by the exporter, no `$$` for a dollar sign, no
  backslash escapes.
- Serializing those values safely for Docker Compose is the **importer's**
  job. The importer writes them into `ghost.env` using the encoding described
  in [configuration.md](configuration.md) and at the top of
  [scripts/lib/env.sh](../scripts/lib/env.sh).

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

Public and admin URLs are mapped deliberately into `.env` (`URL`, `DOMAIN`,
`ADMIN_DOMAIN`, `ADMIN_URL`), preserving supported path and port semantics or
rejecting an unsupported URL with a clear message. Operator overrides of
URL and mode given at import time are retained.

The authoritative list is `GD_CONTAINER_OWNED_KEYS` and
`GD_CONTAINER_OWNED_PREFIXES` in [scripts/lib/config.sh](../scripts/lib/config.sh);
`scripts/config.sh validate` enforces it.

## Reading the manifest

The manifest is read and validated using a pinned helper container, with no
Compose dependencies, no published ports, and read-only access to the bundle.
It cannot depend on an already-valid site `.env` or on a running Ghost,
because neither exists yet at that point in the import.

The container is not about JSON parsing convenience — `jq` is available on the
host and is used freely for the site's own `.ghost-docker.json` and operation
journals. It is about isolating untrusted bundle content: path traversal,
absolute member paths, escaping links, and unbounded expansion are all
properties of a file someone else produced.

## Source consistency and cutover (S3)

Ghost-CLI's `ghost migrate-export --leave-stopped` deliberately leaves the source
stopped after successful export and attempts to stop it after export failure.
Preflight rejection leaves the source unchanged. Ordinary exports restore its
original running state, including a stopped portable source temporarily started
for the API. Failed exports remove partial outputs. Recovery is `ghost start`
in the original installation; verify `ghost ls` if a lifecycle operation failed.

Portable sources are local SQLite development sites only. Capture order is content
JSON → members CSV → stop Ghost → copy assets. Users must avoid editing throughout
export. This is sequential capture, **not an atomic snapshot or write freeze**;
`bundleCreatedAt` is manifest creation time. Production SQLite and unsupported
clients are rejected. MySQL is stopped before copying assets and dumping its DB;
external database writers must also be quiescent.

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

Portable content/member files preserve Ghost API response bytes, not a complete
database. Author data travels but reusable staff authentication does not; IDs may
be remapped by import. Default content export omits integrations/API keys/webhooks,
member and subscription relationship tables, comments and event/email history.
CSV carries member fields and customer/tier references, not complete paid
subscription or per-newsletter relationships. Re-establish staff access and
integrations; reconnect/reconcile Stripe using a supported importer.

See the exporter's [fidelity and recovery documentation](https://github.com/TryGhost/Ghost-CLI/blob/claude/ghost-cli-migration-export-c00253/docs/migration-bundle.md).
S3 verifies schema, source lifecycle, private output, system-tar extraction and
real Compose value transport. S5 must qualify destination owner setup, ID mapping,
member imports and subscription reconciliation end to end before promising their
fidelity. S3 does not implement the Docker importer.

## Remaining S5 work

The importer, isolated destination, verification, and ingress cutover are S5.
Keep the final source stopped and intact until the destination is accepted;
restarting it permits writes that invalidate the final snapshot. Real production
cutover must prevent writes before the final MySQL export.
