# Coolify deployment

Two compose files live here; pick one when you create the Coolify resource.

| File | Ghost | Notes |
| --- | --- | --- |
| `coolify/docker-compose.6.yml` | 6.x | Ghost 6, MySQL 8, Tinybird traffic analytics, ActivityPub.  Fronted by `ghost-gate` (the only public service), which also runs the Tinybird setup wizard.  **Requires Tinybird** — use this if you want analytics. |
| `coolify/docker-compose.5.yml` | 5.x | Legacy Ghost 5 template kept for migrations from the old Coolify Ghost service.  No analytics, no ActivityPub. |

## Quick start (Ghost 6 with analytics)

1. **Add resource** → **Public Repository** → `https://github.com/BadPirate/ghost-docker.git`
2. **Build Pack**: `Docker Compose`.  **Docker Compose Location**: `coolify/docker-compose.6.yml`
3. On the `ghost-gate` service, attach your FQDN and set the **domain port to `3989`**.  No other service needs a public FQDN.
4. Fill the required env vars (`MYSQL_DATABASE`, `MAIL_FROM`, `MAIL_OPTIONS_*`).  Coolify auto-generates the MySQL credentials and the `SERVICE_URL_GHOST_GATE` / `SERVICE_URL_GHOST_GATE_3989` values.
5. Deploy.  `ghost-gate` comes up, bootstraps the MySQL app user + databases, and becomes healthy as soon as that finishes — Coolify/Traefik then start routing traffic to it.
6. Open the FQDN.  `ghost-gate` is serving the setup page.  Paste a **Tinybird workspace admin token**, click **Generate**, copy the four `TINYBIRD_*` values it shows into Coolify's env editor, and **redeploy**.  On restart `ghost-gate` flips to proxy mode and Ghost becomes reachable at the same URL.

`docker-compose.6.yml` assumes you want Tinybird analytics; without the `TINYBIRD_*` vars the wizard keeps waiting and Ghost is not served.  If you don't want analytics, use `docker-compose.5.yml` (or Ghost's upstream image) instead.

## How `ghost-gate` routes

Once the four `TINYBIRD_*` env vars are set:

- `/.ghost/analytics/*` → `http://traffic-analytics:3000/*` (prefix stripped — matches `caddy/snippets/TrafficAnalytics`)
- `/.well-known/webfinger`, `/.well-known/nodeinfo`, `/.ghost/activitypub/*` → `http://activitypub:8080` (path preserved)
- everything else → `http://ghost:2368`

Because the tracker posts stay same-origin (`${SERVICE_URL_GHOST_GATE}/.ghost/analytics/...`), there is no CORS to configure and no Traefik label soup.

Override individual upstreams with `PROXY_GHOST_UPSTREAM`, `PROXY_ANALYTICS_UPSTREAM`, `PROXY_ACTIVITYPUB_UPSTREAM` if the Docker DNS names differ in your setup.

## Migrating from the legacy Coolify Ghost template

1. Create the new app as above; **do not** deploy yet.
2. Copy the env vars from your old Ghost 5 app (Developer view in Coolify makes this easier).
3. On the Coolify host, copy the existing volumes into the new app's volumes:
   ```
   cd /var/lib/docker/volumes
   cp -r <old>_ghost-mysql-data   <new>_ghost-mysql-data
   cp -r <old>_ghost-content-data <new>_ghost-content-data
   ```
4. Deploy the new app.  Complete the Tinybird setup (step 6 above).
5. Verify the site, then stop the old app and swap the FQDN over.

## Gotchas

- **Do not** paste the literal string `SERVICE_URL_GHOST` (or `SERVICE_URL_GHOST_GATE`) into `ADMIN_DOMAIN`; that is a variable name, not a URL, and Ghost will fail with `ERR_INVALID_URL`.  Remove `ADMIN_DOMAIN` from the env, or set it to a full `https://…` URL if you really use a separate admin host.
- `SERVICE_URL_GHOST_GATE` must have **no trailing slash** (e.g. `https://godutch.us`).
- Set `MAIL_FROM` to a valid transactional From line, e.g. `"'Your Site' <noreply@mg.yourdomain.com>"`.  Without it Ghost logs `Missing mail.from config` and uses a generated address.
