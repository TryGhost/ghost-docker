# Custom Caddy routes

Files matching `*.caddy` in this directory are imported after the generated
site routes in `caddy/sites/`. They are never generated and never overwritten
by `scripts/caddy.sh`, and they are validated together with the generated
routes before any configuration is installed or reloaded.

Snippets live in `caddy/snippets/` and are imported by absolute path, for
example:

```caddyfile
status.example.com {
	import /etc/caddy/snippets/Logging
	reverse_proxy 172.17.0.1:9000
}
```

Ghost itself is reachable on the Compose network as `ghost-$COMPOSE_PROJECT_NAME:2368`.
