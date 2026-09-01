# Multi-site

Multi-site is being implemented as **multiple distinct Ghost compose services**
behind a **single shared Caddy + MySQL** layer. One `update-agent` container
manages **all** of them. This document defines the conventions that let a single
agent serve 1..N sites, and single-site is simply the N=1 case.

## Why one agent for all sites

A single updater keeps exactly **one** socket-holding container no matter how
many sites run. The alternative — an updater sidecar per Ghost service — would
multiply the privileged surface with every site, for no benefit. This mirrors
Watchtower: one privileged instance managing many containers. The agent stays
`read_only`, single-fixed-action, and socket-only regardless of site count.

## Conventions

### 1. Site discovery — explicit opt-in label

The agent enumerates the containers it manages by an explicit label, **not** by
image. This matters: `tinybird-sync` in `compose.yml` also runs the `ghost`
image, so image-matching would wrongly include it. Each managed Ghost service
carries:

```yaml
labels:
  com.ghost.site: "true"
```

The agent lists containers with that label and treats each as a site. Its
**site key** is the compose service name, read from the standard
`com.docker.compose.service` label (`ghost`, `ghost-siteb`, …).

### 2. Per-site channel — each Ghost writes only its own request

The shared channel volume is namespaced by site key, so no Ghost can address
another site (each admin only ever knows about itself):

```
/channel/<site-key>/request.json
/channel/<site-key>/status.json
/channel/<site-key>/available.json
```

Each Ghost service sets `selfupdate__channelPath` to its own subdirectory. The
agent watches the whole `/channel` tree (recursive `fs.watch`, Node ≥20) and maps
the subdirectory name → the container with that service label. The request never
*names* a container; the path already scopes it to one site, preserving the
"nothing in the request selects what runs" invariant.

### 3. Self-describing sites — no per-site agent config

The agent derives everything about a site from the site's own container via
`inspect`, so **adding a site needs zero updater configuration**:

| Needed | Source (on the site container) |
|---|---|
| Database name | env `database__connection__database` |
| Database user | env `database__connection__user` |
| Database password | env `database__connection__password` |
| Database host | env `database__connection__host` (default `db`) |
| Health URL | `http://<site-key>:2368/ghost/api/admin/site/` (compose adds the service name as a network alias) |
| Image / version | container image ref → `RepoDigests`, `GHOST_VERSION` env |

The agent already holds the socket, so reading these from `inspect` is not a new
capability. There is **no** DB env on the agent itself.

### 4. Per-site locking

Single-flight is keyed by site, not global — updating site A must not block site
B. Snapshots are namespaced too: `/snapshots/<site-key>/<request_id>.sql.gz`.

## Version scope — one decision to make

Does the update target apply globally or per-site?

- **Shared (recommended for the shared-layer model):** every site tracks the same
  `GHOST_VERSION` (e.g. `6-alpine`). The agent pulls one image and updates each
  site to it. Simple, and matches "one shared platform version."
- **Per-site:** each site pins its own tag, read from that site's container image.
  Also fully derivable from `inspect`, but the UI would need to let sites diverge,
  and you'd carry mixed versions against one MySQL. Only adopt if you actually
  need staggered rollouts.

Either way the **major-version guard is per-site**: a site is only updated within
its own major (and the pinned tag already prevents crossing it).

## What does not change

- The Zod contract (`contract.md`) — schemas are identical; only the file
  *location* is namespaced per site. Optionally add a `site` field to
  `status`/`available` for the agent's own logging, but Ghost core doesn't need it
  (it reads its own subdir).
- The lifecycle/state machine, snapshot → pull → recreate → health-gate →
  rollback — all run per-site.
- Ghost core's endpoints — each site's Ghost points `channelPath` at its own
  subdir and is otherwise unchanged.

## Single-site is N=1

A single-site deployment is one managed Ghost service with the `com.ghost.site`
label, one channel subdir, one lock entry. No special-casing: the same agent code
path handles it. Existing single-site users who don't opt into `selfupdate` see no
change at all.
