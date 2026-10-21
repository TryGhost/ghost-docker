# Caddy routing

`./ghost-docker install --domain` writes this site's routes into
`caddy/sites/site.caddy`, once. From then on the file is yours, as the nginx
file Ghost-CLI generated was: the manager never rewrites it. On a server with
[the shared Caddy](#the-shared-caddy), the routes go into the shared Caddy's
directory instead, in a file named for the site.

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

## Routes moved from the released main layout

A site moved from `main` keeps its own Caddyfile as `caddy/sites/site.caddy`
([install.md](install.md#moving-from-the-released-main-layout)). It imports
main's snippets, which take no arguments, from `caddy/sites/legacy-snippets/`,
and proxies to bare service names (`ghost:2368`), which resolve on the site's
own network. Both keep working. Moving to this layout's snippets and aliases,
as `install` writes them, is optional, and is needed before the site could
join a shared Caddy.

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
| Serve Ghost Admin on its own domain | add it to the block's addresses (`example.com, admin.example.com {`) and give `SecurityHeaders` the admin domain: `import /etc/caddy/snippets/SecurityHeaders "admin.example.com"`. Set `ADMIN_URL` in `.env` too, then `docker compose up -d` |
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

## The shared Caddy

Only one program can hold ports 80 and 443, so several production sites on
one server share one Caddy, as Ghost-CLI's sites shared one nginx. Everything
else stays each site's own: Ghost, MySQL, ActivityPub, analytics, backups,
updates and restores work exactly as they do for a site on its own. A local
site never uses the shared Caddy, and a server without one runs each
production site with its own Caddy, as before.

Set it up once, in a directory of its own, before the sites:

```bash
mkdir ~/caddy && cd ~/caddy
curl -fsSL https://docker.ghost.org/install.sh | bash -s -- install --infra
```

Then install each site as usual, each in its own directory. On a server with
the shared Caddy, `install --domain` joins it: the site has no Caddy of its
own, and its routes are written to the shared Caddy's
`caddy/sites/<project>.caddy`, which Caddy validates and loads before the
site starts. `<project>` is the site's `COMPOSE_PROJECT_NAME`. A domain the
shared Caddy already serves, or a project that already has routes there, is
refused before anything is written. An existing site cannot be moved behind
the shared Caddy yet; it keeps its own Caddy, which needs 80 and 443, so set
the shared Caddy up on a server before its first production site.

| Path, in the shared Caddy's directory | Owner |
| --- | --- |
| `caddy/sites/<project>.caddy` | one per site behind it: written by that site's `install`, then yours |
| `caddy/custom/*.caddy`, `caddy/global/*.caddy` | yours, as for a single site |

Edit a site's routes as described above, then reload the shared Caddy, in
its directory:

```bash
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

A configuration Caddy does not load is not applied: every site keeps being
served as before, and Caddy says why. `./ghost-docker check` in a site's
directory reports the shared Caddy's health, the site's routes file, and
HTTPS through it. `./ghost-docker list` shows the shared Caddy, as `shared
caddy`, and each site behind it as a `member`.

`./ghost-docker remove`, in a site's directory, removes its routes file,
reloads the shared Caddy, and takes the site's containers down; no other site
is touched. The site's directory, data and backups stay until you delete them.
A backup does not hold a site's routes, which are the shared Caddy's files:
restoring a site behind it needs them in place, and says so when they are not.

### How it is connected

The shared Caddy is its own Compose project (`ghost-infra` unless `--name`
says otherwise), with the `infra` profile. `install --infra` creates the
network `ghost-ingress`, which belongs to no Compose project, so taking the
shared Caddy down never takes it away from the sites. Each site behind it
selects the `member` profile, and its Ghost, ActivityPub and analytics join
`ghost-ingress` under their unique aliases (`ghost-<project>:2368` and so
on), which is why routes always use them. MySQL and every one-shot job stay on
the site's own network.

Ghost is still published on the site's loopback port, so a site behind the
shared Caddy can be reached without it, for example from your own proxy.

### What it trusts

The shared network is not isolation between sites. Every container on it can
reach every other site's Ghost, ActivityPub and analytics, and a site's bare
service names (`ghost`, `activitypub`) answer for every site on it, which is
why nothing routes by them. MySQL is never on it. Run sites behind one Caddy
only when you would trust them on one server anyway, as with Ghost-CLI.

The shared Caddy's directory holds every site's routes, and its `caddy_data`
volume their certificates. Its `caddy/` is writable by whoever installed it, and the manager writes a site's
routes as the owner of `caddy/sites/`.

### Restarting and updating it

Restarting the shared Caddy (`docker compose restart`, or `down` then
`up -d`, in its directory) interrupts every site behind it for those seconds,
and brings each back with its routes; certificates are kept in its
`caddy_data` volume. A site's own operations (`update`, `self-update`,
`backup`, `restore`, `docker compose down`) never restart it.

The shared Caddy's image is pinned in its `compose.yml`, from the release it
was installed with. `self-update` updates sites, not the shared Caddy's
directory; moving it to a newer Caddy is changing that pin and running
`docker compose up -d` there, which restarts it as above.

### Capacity

Caddy itself costs little per site: a few routes, and a certificate it renews
in the background. What limits a server is each site's own Ghost and MySQL,
and ActivityPub and analytics where selected, which cost what they would on a
server of their own ([configuration.md](configuration.md#site-modes-and-profiles)
lists the optional services' costs). Size the server for the sum of them.
Let's Encrypt limits how many certificates one account obtains per hour;
installing many sites at once can reach it, and Caddy retries later.
