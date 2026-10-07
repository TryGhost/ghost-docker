# Caddy global options

Files matching `*.caddy` in this directory are imported into Caddy's global
options block. Use them for settings that apply to the whole server rather than
to one site, for example:

```caddyfile
# Issue certificates from Caddy's internal CA instead of a public ACME CA.
# Useful for staging hosts and test domains.
local_certs
```

Reload Caddy after a change:

```bash
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```
