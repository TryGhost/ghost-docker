# Ghost Docker for Coolify

Configuration to run Ghost and its services with Docker Compose

- [docker-compose.5.yml] - Original Coolify 5 Ghost configuration available from coolify as a template (for reference / backwards compatibility)

- [docker-compose.6.local.yml] - Modifications that allow running ghost 6 (with tinybird analytics and wizard) locally. `docker compose up -f coolify/docker-compose.6.yml -f coolify/docker-compose.6.local.yml`

- [docker-compose.6.yml] - For use with coolify, see setup below.

## Ghost 6 with Tinybird Analytics

### New Install

Requirements: Coolify UI v4, host with at least 5GB disk space and 2GB RAM

Primary purpose was to make it easy to configure a new / existing ghost 6 instance to run from coolify, still requires tinybird at this time, but there is a useful setup tool built in (Wizard) which also functions as a gateway after configuration.

1. In Coolify UI Project: Add Resource
2. As Public Repository: https://github.com/BadPirate/ghost-docker.git
3. Select Build Pack: "Docker Compose"
4. Docker Compose Location: `/coolify/docker-compose.6.yml`
5. General -> Domains for wizard: https://<your coolify domain>:3989
6. Deploy
7. After deployment, visit (From links for ghost-gate or at the URL) and configure tinybird
8. Stop deployment, paste the tinybird config variables into Environment section of your deployment and relaunch
9. Profit! (?)

### Upgrade existing coolify ghost 5 template based install

1. In Coolify UI Project: Add Resource
2. As Public Repository: https://github.com/BadPirate/ghost-docker.git
3. Select Build Pack: "Docker Compose"
4. Docker Compose Location: `/coolify/docker-compose.6.yml`
5. General -> Domains for wizard: https://<your coolify domain>:3989
6. Deploy
7. Stop the deployment after it successfully opens
8. On your server, cd into docker volumes `/var/lib/docker/volumes/` find the app ID for your old version ghost blog, and the app ID for the new version, and replace new empty content with existing older content:
  - `rm -rf ${NEWID}_ghost-content-data; cp -r ${OLDID}_ghost-content-data ${NEWID}_ghost-content-data`
  - `rm -rf ${NEWID}_ghost-mysql-data; cp -r ${OLDID}_ghost-mysql-data ${NEWID}_ghost-mysql-data`
9. In Coolify UI, copy the environment variables (including passwords for mysql) from the old template based app and put them into your new docker compose based app
10. Deploy again, ghost-gate will migrate your database
11. After deployment, visit (From links for ghost-gate or at the URL) and configure tinybird
12. Stop deployment, paste the tinybird config variables into Environment section of your deployment and relaunch
13. Profit! (?)