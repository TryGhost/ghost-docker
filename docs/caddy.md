# Caddy routing

`./ghost-docker install --domain` writes this site's routes into
`caddy/sites/site.caddy`, once. From then on the file is yours, as the nginx
file Ghost-CLI generated was: the manager never rewrites it.

## Layout

| Path | Tracked | Owner |
| --- | --- | --- |
| `caddy/Caddyfile` | yes | generic entry point, do not edit |
| `caddy/snippets/*` | yes | reusable route fragments, imported with arguments |
| `caddy/sites/site.caddy` | no | this site's routes: written by `install`, then yours |
| `caddy/custom/*.caddy` | no | yours: other sites on the same server |
| `caddy/global/*.caddy` | no | yours: global options |

The tracked `Caddyfile` imports the three directories:

```caddyfile
{
	import /etc/caddy/global/*.caddy
}

import /etc/caddy/sites/*.caddy
import /etc/caddy/custom/*.caddy
```

## Changing routes

Edit the file, then reload Caddy explicitly:

```bash
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
./ghost-docker check     # Caddy serves each domain, and HTTPS
```

A reload loads the new configuration whole or not at all: if it does not
load, Caddy says why and keeps serving the previous one. Production uses an
explicit reload; Caddy documents `--watch` as a local development feature.

The changes people make most often, inside the site's block:

| To | Change |
| --- | --- |
| Set or change the ACME account email | `tls ops@example.com` (`install --email` writes this line; without it, the line is there commented out) |
| Serve Ghost Admin on its own domain | add it to the block's addresses (`example.com, admin.example.com {`) and give `SecurityHeaders` the admin domain: `import /etc/caddy/snippets/SecurityHeaders "admin.example.com"`. Set `ADMIN_DOMAIN` and `ADMIN_URL` in `.env` too, then `docker compose up -d` |
| Route analytics, after adding the `analytics` profile | `import /etc/caddy/snippets/TrafficAnalytics traffic-analytics-<project>:3000` (see [TINYBIRD.md](../TINYBIRD.md)) |
| Use this site's own ActivityPub, after adding the `activitypub` profile | change the ActivityPub import to `activitypub-<project>:8080` |
| Redirect `www.` | a block of its own: `www.example.com { redir https://example.com{uri} }` |

`<project>` is `COMPOSE_PROJECT_NAME` from `.env`. Upstreams are always the
site's unique network aliases (`ghost-<project>:2368` and so on), never the
bare service names.

Global options such as a DNS provider, or Caddy's internal CA for a staging
host, go in `caddy/global/*.caddy`:

```caddyfile
acme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}
```

## Import arguments

Snippets take their upstreams and domains as import arguments:

```caddyfile
import /etc/caddy/snippets/TrafficAnalytics traffic-analytics-my-site:3000
import /etc/caddy/snippets/ActivityPub activitypub-my-site:8080
import /etc/caddy/snippets/SecurityHeaders "admin.example.com"
```

Every argument is required. A missing one is only a *warning* when Caddy
loads the file, and the site then misbehaves at runtime, so check Caddy's
output when you reload.

## Optional services

ActivityPub routes are always present. With the `activitypub` profile they
point at this site's own service; otherwise at the hosted service,
`https://ap.ghost.org`. ActivityPub, its migration job, database grants,
storage and serving URL all belong to the site.
