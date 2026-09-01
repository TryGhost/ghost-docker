# Compose & environment changes (this repo)

All changes are gated behind the `selfupdate` Compose profile, so existing users
are unaffected until they opt in:

```bash
COMPOSE_PROFILES=selfupdate docker compose up -d
```

The agent discovers sites by the `com.ghost.site` label and manages all of them
(see `multi-site.md`). Single-site is just one labelled Ghost service.

## 1. Mark each Ghost site + point it at its own channel subdir

Every managed Ghost service gets the opt-in label and a per-site
`selfupdate__channelPath` (subdir = the compose service name). No socket, no new
privilege on Ghost.

```yaml
  ghost:                                            # site key: "ghost"
    # ...everything existing stays...
    labels:
      com.ghost.site: "true"                        # NEW: agent discovers by this label
    volumes:
      - ${UPLOAD_LOCATION:-./data/ghost}:/var/lib/ghost/content
      - update_channel:/var/lib/ghost/update-channel     # NEW: shared channel volume
    environment:
      # ...existing...
      selfupdate__enabled: ${SELFUPDATE_ENABLED:-false}
      selfupdate__channelPath: /var/lib/ghost/update-channel/ghost   # this site's subdir
```

For an additional site (multi-site work), the same three additions, with the
subdir matching the service name:

```yaml
  ghost-siteb:                                      # site key: "ghost-siteb"
    image: ghost:${GHOST_VERSION:-6-alpine}
    labels:
      com.ghost.site: "true"
    volumes:
      - ./data/ghost-siteb:/var/lib/ghost/content
      - update_channel:/var/lib/ghost/update-channel
    environment:
      # ...its own url / database__connection__database / etc...
      selfupdate__enabled: ${SELFUPDATE_ENABLED:-false}
      selfupdate__channelPath: /var/lib/ghost/update-channel/ghost-siteb
```

> The agent reads each site's DB name/user/password/host and health URL from the
> site container's own env (`database__connection__*`) — so there is **no**
> per-site configuration on the agent itself. Adding a site is just the block
> above plus its normal Ghost config.

## 2. New `update-agent` service (the only privileged component)

Published image, pinned by tag + digest like `ghost/traffic-analytics` and
`ghcr.io/tryghost/activitypub` already are. **Socket-only**: no project-dir mount,
no `COMPOSE_PROJECT_NAME`, no DB creds, no per-site config.

```yaml
  update-agent:
    image: ghost/update-agent:<tag>@sha256:<digest>   # published from the Ghost monorepo
    restart: always
    profiles: [selfupdate]
    read_only: true
    security_opt:
      - no-new-privileges:true
    environment:
      SITE_LABEL: com.ghost.site             # discovers all managed Ghost sites
      IMAGE_REPO: ghost                      # image repo the sites run
      PINNED_TAG: ${GHOST_VERSION:-6-alpine} # shared version model (also the major boundary)
      CHANNEL_PATH: /channel
      SNAPSHOT_PATH: /snapshots
      SNAPSHOT_BEFORE_UPDATE: "true"         # default on; a request may set skip_snapshot
      SNAPSHOT_RETENTION: "5"                # keep last N dumps per site
      HEALTHCHECK_TIMEOUT: "180"             # seconds to wait for healthy after recreate
      DIGEST_POLL_INTERVAL: "3600"           # idle poll to publish available.json per site
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock   # the ONLY container with this
      - update_channel:/channel                     # /channel/<site>/{request,status,available}.json
      - db_snapshots:/snapshots                     # /snapshots/<site>/*.sql.gz
    tmpfs:
      - /tmp                                         # writable scratch for read_only rootfs
    networks:
      - ghost_network                                # reaches each site at http://<site>:2368
```

## 3. Add to the top-level `volumes:` block

```yaml
volumes:
  # ...existing (caddy_data, caddy_config, tinybird_files, tinybird_home, traffic_analytics_data)...
  update_channel:
  db_snapshots:
```

## 4. `.env.example` additions

```bash
# ---------------------------------------------------------------------------
# One-click self-update (optional; Docker Compose profile: selfupdate)
# ---------------------------------------------------------------------------
# Adds an "Update Ghost" control inside Ghost admin. Ghost never gets Docker
# socket access — a single update-agent service (managing every site labelled
# com.ghost.site) does the pull + recreate. Updates stay WITHIN the pinned tag
# below (patch/minor of the same major). Major upgrades are intentionally out of
# scope: do them manually per the upgrade docs.
#
# Enable with:  COMPOSE_PROFILES=selfupdate docker compose up -d
SELFUPDATE_ENABLED=false

# The update boundary AND the major boundary. `6-alpine` only ever resolves to
# the latest Ghost 6.x image, so it can never pull a 7.x. In the shared-version
# model every site tracks this tag.
# GHOST_VERSION=6-alpine
```

## Notes

- **No Caddyfile changes.** The feature is entirely admin-API + shared-volume.
- **Why no `COMPOSE_PROJECT_NAME` / project mount.** The agent recreates each site
  via the Docker API, discovering containers by `com.ghost.site` + the
  `com.docker.compose.service` label. (If you adopt the `docker compose` fallback
  in `architecture.md` §7 instead, you must re-add the project-dir mount and
  project name.)
- **`tinybird-sync` also runs the ghost image** — it is *not* labelled
  `com.ghost.site`, so the agent never touches it. Do not add that label to
  supporting services.
- **Per-site snapshots** live under `/snapshots/<site>/`; retention is applied per
  site.
- **Version scope.** This shows the shared-version model (all sites on
  `GHOST_VERSION`). For per-site versions, drop `PINNED_TAG` from the agent and
  have it read each site's tag from the container image — see `multi-site.md`.
