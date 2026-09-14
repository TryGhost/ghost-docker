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
    "version": "5.130.3"
  },
  "config": {
    "url": "https://example.com",
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
| `sourceInstallType` | **Required.** Exactly `local` or `production`. The importer infers the installation mode from this field. |
| `kind` | Bundle kind. Validated against the kinds the importer supports. |
| `ghost.version` | Exact source Ghost version. Validated as supported; the import happens *at* this version, and upgrading is a separate operation. |

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

So a mail password of `p$ssword` appears in the manifest as the four-character
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

## Not settled in this step

The following are defined by their own steps and are **not** promised here:

- Exporter behaviour, including the documented final-export mode that leaves
  the source stopped for cutover, and the preserved restart behaviour for
  ordinary exports (S3).
- The portable-import fidelity matrix and the explicit list of losses, which
  is established from fixtures and real exporter/importer behaviour (S3/S5).
- The import sequence, isolated destination, verification and cutover (S5).
