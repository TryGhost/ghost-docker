# Custom Caddy routes

Files matching `*.caddy` in this directory are imported after this site's
routes in `caddy/sites/`. Use them for other sites on the same server, for
example:

```caddyfile
status.example.com {
	import /etc/caddy/snippets/Logging
	reverse_proxy 172.17.0.1:9000
}
```

Snippets live in `caddy/snippets/` and are imported by absolute path. Ghost
itself is reachable on the Compose network as `ghost-$COMPOSE_PROJECT_NAME:2368`.

Reload Caddy after a change; it refuses a configuration that does not load and
keeps serving the previous one:

```bash
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```
