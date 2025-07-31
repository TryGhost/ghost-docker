# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a comprehensive Docker Compose setup for running Ghost CMS in production with automatic HTTPS, optional analytics, and ActivityPub support. The repository orchestrates multiple services including Ghost, MySQL, Caddy (reverse proxy), and optional Tinybird analytics and ActivityPub federation.

## Architecture

The project uses Docker Compose to orchestrate these services:

1. **Ghost** - The main CMS application (runs on internal port 2368)
2. **MySQL** - Database backend with health checks and support for multiple databases
3. **Caddy** - Reverse proxy handling HTTPS/SSL, routing, and external access
4. **Traffic Analytics** (optional profile) - Tinybird integration for web analytics
5. **ActivityPub** (optional profile) - Federated social networking support
6. **Supporting services** - Tinybird setup tools and ActivityPub migrations

Services communicate internally via Docker networks. Caddy handles all external traffic routing including special paths for analytics (`/_tinybird`) and ActivityPub (`/.well-known/`, `/activitypub/`).

## Common Commands

```bash
# Core operations
docker compose up -d                    # Start Ghost + MySQL + Caddy
docker compose down                     # Stop all services
docker compose logs -f [service]        # View logs (e.g., ghost, mysql, caddy)
docker compose ps                       # Check service status
docker compose pull                     # Update all images
docker compose restart ghost            # Restart just Ghost

# With optional profiles
docker compose --profile=analytics up -d     # Include analytics services
docker compose --profile=activitypub up -d   # Include ActivityPub services
COMPOSE_PROFILES=analytics,activitypub docker compose up -d  # Start everything

# Tinybird analytics setup (if using analytics profile)
docker compose run --rm tinybird-login       # Interactive Tinybird login
docker compose --profile=analytics up tinybird-sync   # Sync datasources/pipes
docker compose --profile=analytics up tinybird-deploy # Deploy configuration

# Development & debugging
docker compose exec ghost sh            # Access Ghost container shell
docker compose exec mysql mysql -u root -p  # Access MySQL CLI
```

## Configuration

All configuration is done via environment variables. Key patterns:

- **Required variables**: `DOMAIN`, `DATABASE_PASSWORD`, `DATABASE_ROOT_PASSWORD`
- **Ghost config pattern**: `section__subsection__key=value` (e.g., `mail__options__service=Mailgun`)
- **Developer experiments**: Must set `labs__publicAPI=true` for analytics/ActivityPub features
- **Data persistence**: Volumes stored in `./data/ghost` and `./data/mysql`

### Key configuration files:
- `.env` - Main environment configuration (create from `.env.example`)
- `compose.yml` - Docker Compose service definitions
- `Caddyfile` - Reverse proxy routing configuration
- `mysql-init/create-multiple-databases.sh` - MySQL multi-database initialization

## Migration from Ghost CLI

The repository includes comprehensive migration tools:

- `scripts/migrate.sh` - Main migration script that:
  - Backs up existing Ghost installation
  - Automatically tries Ghost's database credentials first
  - Only prompts for alternative credentials if needed
  - Uses `--no-tablespaces` flag to avoid PROCESS privilege requirements
  - Converts config.json to environment variables
  - Preserves content and database
  - Creates recovery script with clear restoration instructions
  - Sets up Docker Compose environment

- `scripts/config-to-env.js` - Converts Ghost JSON config to .env format

## Development Workflow

1. Clone repository and copy `.env.example` to `.env`
2. Configure required environment variables (domain, passwords)
3. Run `docker compose up -d` to start services
4. Access Ghost at `https://DOMAIN` (Caddy handles SSL automatically)
5. Monitor logs with `docker compose logs -f ghost`

For analytics setup, see `TINYBIRD.md` for detailed instructions.

## Important Notes

- Ghost runs internally on port 2368; Caddy exposes it on 80/443
- Email configuration is critical even without newsletter features (used for admin notifications)
- MySQL health checks ensure database is ready before Ghost starts
- The compose file uses yaml-language-server schema for IDE completion support
- For production, always use strong passwords and consider additional security measures
