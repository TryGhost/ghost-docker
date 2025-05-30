# Tinybird Configuration

Steps:
1. Create a Tinybird account and a Tinybird workspace at [tinybird.co](https://auth.tinybird.co/login).
2. Install tinybird CLI locally
```bash
curl https://tinybird.co | sh
```
3. Run `tb login` locally in the root of this repository. This creates `.tinyb` file which includes your admin token. This file is mounted into the `tinybird-deploy` service and is used to authenticate with your Tinybird workspace.
4. Enable the `analytics` docker compose profile by adding `COMPOSE_PROFILES=analytics` to your `.env` file.
5. Run `docker compose up tinybird-sync`. This will copy the Tinybird files from the Ghost container into a shared volume.
6. Run `docker compose up tinybird-deploy`. This sets up your Tinybird workspace's schema and API endpoints.
7. Copy your Tinybird `stats_page` token: `tb --cloud token copy stats_page` and add it to your `.env` file as `TINYBIRD_STATS_TOKEN`. You can also copy the `stats_page` token from your Tinybird Workspace's UI.
8. Copy your Tinybird `tracker` token: `tb --cloud token copy tracker` and add it to your `.env` file as `TINYBIRD_TRACKER_TOKEN`. You can also copy the `tracker` token from your Tinybird Workspace's UI.
9. Run `docker compose up -d` to start all services in the background.
10. At this point, everything should be working. You can test it's working by visiting your site's homepage, then checking the Stats page in Ghost Admin — you should see a view recorded.
