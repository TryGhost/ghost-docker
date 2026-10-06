# Caddy routing

> **Status.** Commands written `./ghost-docker ...` are provided by the manager
> CLI described in [the plan](ghost-cli-replacement.md). It lands in steps N2 and
> N3; until then this branch holds the Compose and Caddy configuration and these
> contracts, and no tooling.

`./ghost-docker install` applies routes for a production site, so a fresh installation
already has validated, installed and verified routes. Everything below is for
changing them afterwards.

## Layout

| Path | Tracked | Owner |
| --- | --- | --- |
| `caddy/Caddyfile` | yes | generic entry point, do not edit |
| `caddy/snippets/*` | yes | reusable route fragments, imported with arguments |
| `caddy/sites/*.caddy` | no | **generated** by `./ghost-docker caddy` |
| `caddy/custom/*.caddy` | no | operator owned, never generated or overwritten |
| `caddy/global/*.caddy` | no | operator owned global options, never overwritten |
| `caddy/.staging/` | no | candidate tree, validated before installation |

The tracked `Caddyfile` imports the three directories through Caddy
placeholders, so a candidate configuration can be validated with the exact
file that will be installed:

```caddyfile
{
	import {$CADDY_GLOBAL_DIR:/etc/caddy/global}/*.caddy
}

import {$CADDY_SITES_DIR:/etc/caddy/sites}/*.caddy
import {$CADDY_CUSTOM_DIR:/etc/caddy/custom}/*.caddy
```

## Applying routes

```bash
./ghost-docker caddy render     # render the candidate into caddy/.staging
./ghost-docker caddy apply      # render, validate, install, reload, verify
./ghost-docker caddy validate   # validate the installed configuration
./ghost-docker caddy reload     # explicit reload of the running Caddy
```

`apply` is transactional:

1. Render the candidate into `caddy/.staging/sites/`.
2. Validate the tracked `Caddyfile` against the staged sites *and* the
   operator's `custom/` and `global/` files.
3. Install the candidate atomically into `caddy/sites/`, keeping a backup.
4. Validate the installed configuration.
5. Reload the running Caddy explicitly.
6. Verify that Caddy's *loaded* configuration actually routes the expected
   hostnames — a zero exit status from `reload` is not verification.

If validation, reload or verification fails, the previous on-disk
configuration is restored and reloaded, and the command fails.

Production uses an explicit reload. Caddy documents `--watch` as a local
development feature, so it is not used.

## Import arguments

Snippets take their upstreams and domains as import arguments:

```caddyfile
import /etc/caddy/snippets/TrafficAnalytics traffic-analytics-my-site:3000
import /etc/caddy/snippets/ActivityPub activitypub-my-site:8080
import /etc/caddy/snippets/SecurityHeaders "admin.example.com"
```

A missing argument is only a *warning* during Caddy's adaptation — the
resulting server starts and misbehaves at runtime. `./ghost-docker caddy` promotes
that warning to an error, and the renderer refuses to install a file with an
unresolved template placeholder.

## Custom routes

Put your own server blocks in `caddy/custom/*.caddy`. They are imported after
the generated routes, validated together with them, and never rewritten. Ghost
is reachable on the Compose network as `ghost-$COMPOSE_PROJECT_NAME:2368`.

Global options — an ACME account email, a DNS provider, or Caddy's internal CA
for a staging host — go in `caddy/global/*.caddy`:

```caddyfile
email ops@example.com
```

## Optional services

Analytics routes are rendered only when the `analytics` profile is enabled.

ActivityPub routes are always rendered. With the `activitypub` profile enabled
they point at this site's own service; otherwise they point at
`ACTIVITYPUB_TARGET` (the hosted service by default). ActivityPub, its
migration job, database grants, storage and serving URL all belong to the
site.
