# Compose & environment changes (this repo)

All changes are gated behind the `selfupdate` Compose profile, so existing users
are unaffected until they opt in:

```bash
COMPOSE_PROFILES=selfupdate docker compose up -d
```

## 1. Add to the existing `ghost` service

No socket, no new privilege — just the shared volume and the feature flag Ghost
core reads.

```yaml
  ghost:
    # ...everything existing stays...
    volumes:
      - ${UPLOAD_LOCATION:-./data/ghost}:/var/lib/ghost/content
      - update_channel:/var/lib/ghost/update-channel     # NEW: signal/status contract
    environment:
      # ...existing...
      selfupdate__enabled: ${SELFUPDATE_ENABLED:-false}   # NEW: Ghost core feature flag
      selfupdate__channelPath: /var/lib/ghost/update-channel
```

## 2. New `update-agent` service (the only privileged component)

Uses the published image, pinned by tag + digest exactly like
`ghost/traffic-analytics` and `ghcr.io/tryghost/activitypub` already are in this
file. It is **socket-only**: no project-dir mount, no `COMPOSE_PROJECT_NAME`.

```yaml
  update-agent:
    image: ghost/update-agent:<tag>@sha256:<digest>   # published from the Ghost monorepo
    restart: always
    profiles: [selfupdate]
    read_only: true
    security_opt:
      - no-new-privileges:true
    environment:
      TARGET_SERVICE: ghost                 # fixed; never taken from a request
      IMAGE_REPO: ghost                     # what the ghost service image resolves to
      PINNED_TAG: ${GHOST_VERSION:-6-alpine}# the update boundary (also the major boundary)
      CHANNEL_PATH: /channel
      SNAPSHOT_PATH: /snapshots
      SNAPSHOT_BEFORE_UPDATE: "true"        # default on; a request may set skip_snapshot
      SNAPSHOT_RETENTION: "5"               # keep last N dumps
      HEALTHCHECK_URL: http://ghost:2368/ghost/api/admin/site/
      HEALTHCHECK_TIMEOUT: "180"            # seconds to wait for healthy after recreate
      DIGEST_POLL_INTERVAL: "3600"          # idle poll to publish available.json
      # DB creds for mysqldump (reuse existing stack vars)
      DATABASE_HOST: db
      DATABASE_USER: ${DATABASE_USER:-ghost}
      DATABASE_PASSWORD: ${DATABASE_PASSWORD:?DATABASE_PASSWORD required}
      DATABASE_NAME: ghost
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock   # the ONLY container with this
      - update_channel:/channel                     # request.json / status.json / available.json
      - db_snapshots:/snapshots                     # pre-update backups
    tmpfs:
      - /tmp                                         # writable scratch for read_only rootfs
    networks:
      - ghost_network                                # only for the healthcheck HTTP call
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
# Adds an "Update Ghost" control inside Ghost admin. The Ghost container never
# gets Docker socket access — a separate single-purpose update-agent service
# does the pull + recreate. Updates stay WITHIN the pinned tag below (patch/minor
# of the same major). Major upgrades are intentionally out of scope: do them
# manually per the upgrade docs.
#
# Enable with:  COMPOSE_PROFILES=selfupdate docker compose up -d
SELFUPDATE_ENABLED=false

# The update boundary AND the major boundary. `6-alpine` only ever resolves to
# the latest Ghost 6.x image, so it can never pull a 7.x.
# GHOST_VERSION=6-alpine
```

## Notes

- **No Caddyfile changes.** The feature is entirely admin-API + shared-volume;
  nothing new is exposed externally.
- **Why the agent no longer needs `COMPOSE_PROJECT_NAME` or a project mount.**
  It recreates the `ghost` container via the Docker API, discovering it by the
  `com.docker.compose.service=ghost` label. See `update-agent.md`. (If you
  instead adopt the `docker compose` fallback described in `architecture.md` §7,
  you must re-add the project-dir mount and `COMPOSE_PROJECT_NAME`.)
- **`db_snapshots` retention.** The agent keeps the newest `SNAPSHOT_RETENTION`
  dumps and prunes the rest. Sized for a handful of full `mysqldump` outputs;
  adjust to your disk allowance.
