# Ghost Docker

A production-ready Docker Compose configuration for self-hosting [Ghost](https://ghost.org/).

## Overview

This repository provides a complete Docker Compose setup for running Ghost with:
- **Caddy** - Automatic HTTPS with Let's Encrypt
- **MySQL 8.0** - Database backend
- **Ghost 5** - The latest version of Ghost
- **Optional Analytics** - Ghost's new traffic analytics with Tinybird integration

## Prerequisites

- Docker Engine 20.10+ and Docker Compose v2+
- A domain name pointing to your server
- Open ports 80 and 443 for web traffic

## Quick Start

1. **Clone this repository**
   ```bash
   git clone https://github.com/TryGhost/ghost-docker.git
   cd ghost-docker
   ```

2. **Create a `.env` file** with your configuration:
    ```bash
    cp .env.example .env
    ```
    Update the values in your `.env` file:
    ```bash
    # Required variables
    DOMAIN=your-domain.com
    DATABASE_PASSWORD=your_secure_password
    DATABASE_ROOT_PASSWORD=your_root_password
    
    # Optional variables
    DATABASE_USER=ghost  # defaults to 'ghost'

    ```

3. **Start the services**
   ```bash
   docker compose up -d
   ```

4. **Access your Ghost instance**
   
   - Visit `https://your-domain.com` to see your site
   - Visit `https://your-domain.com/ghost` to access the admin panel
   - Complete the setup wizard to create your admin account

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DOMAIN` | Yes | - | Your domain name (e.g., example.com) |
| `DATABASE_PASSWORD` | Yes | - | Password for the Ghost database user |
| `DATABASE_ROOT_PASSWORD` | Yes | - | MySQL root password |
| `DATABASE_USER` | No | ghost | MySQL username for Ghost |

### Services

#### Core Services (Always Running)

- **caddy**: Reverse proxy with automatic HTTPS
  - Handles SSL certificates via Let's Encrypt
  - Routes traffic to Ghost
  - Adds security headers
  - Redirects www to non-www

- **ghost**: The Ghost application
  - Runs on Alpine Linux for smaller image size
  - Content stored in persistent volume
  - Configured to use MySQL database

- **db**: MySQL 8.0 database
  - Data persisted in Docker volume
  - Creates both `ghost` and `activitypub` databases
  - Exposed on port 3306 for external access (optional)

#### Analytics Services (Optional)

Analytics setup requires a Tinybird account. See [TINYBIRD.md](TINYBIRD.md) for setup instructions.

## Volumes

- `ghost_content`: Ghost's content directory (themes, images, etc.)
- `db_data`: MySQL database files
- `caddy_data`: Caddy certificates and data
- `caddy_config`: Caddy configuration
- `tinybird_files`: Tinybird configuration files
- `tinybird_data`: Tinybird authentication info (`.tinyb` file)

## Updating Ghost

1. **Pull the latest images**:
   ```bash
   docker compose pull
   ```

2. **Recreate containers with new images**:
   ```bash
   docker compose up -d
   ```

Ghost handles database migrations automatically on startup.

## Troubleshooting

### View logs
```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f ghost
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Copyright & License

Copyright (c) 2013-2025 Ghost Foundation - Released under the [MIT license](LICENSE).
