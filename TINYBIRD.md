# Tinybird Configuration

Note: Currently Traffic Analytics features are behind a feature flag. For now, you'll need to enable developer experiments by setting `ENABLE_DEV_EXPERIMENTS=true` in your `.env` file, and enable the Traffic Analytics feature flag under Settings > Labs > Private Features.

Steps:
1. Create a Tinybird account and a Tinybird workspace at [tinybird.co](https://auth.tinybird.co/login). You can select any cloud/region you choose.
1. Run `docker compose run --rm tinybird-login` to login to your Tinybird account
1. Run `docker compose --profile=analytics up tinybird-sync`. This will copy the Tinybird files from the Ghost container into a shared volume. The service should log "Tinybird files synced into shared volume.", then exit.
1. Run `docker compose --profile=analytics up tinybird-deploy` and wait for the service to exit successfully. This will create your Tinybird datasources, pipes and API endpoints. It may take a minute or two to complete the first time. You should see "Deployment #1 is live!" in your terminal before the service exits.
1. Find your workspace's events API endpoint: `docker compose run --rm tinybird-login tb --cloud info`, copy the value of "api", and add it to your `.env` file as `TINYBIRD_API_URL`. You can also find this value in your Tinybird Workspace's UI. 
1. Using the UI link from the previous step, open your workspace and click on *Tokens* in the left hand menu
1. Copy your Tinybird `stats_page` token and add it to your `.env` file as `TINYBIRD_STATS_TOKEN`
1. Copy your Tinybird `tracker` token and add it to your `.env` file as `TINYBIRD_TRACKER_TOKEN`
1. Run `docker compose --profile=analytics up -d` to start all services in the background. You can also set `COMPOSE_PROFILES=analytics` in your `.env` file to automatically include the `analytics` profile when running `docker compose` commands.
1. At this point, everything should be working. You can test it's working by visiting your site's homepage, then checking the Stats page in Ghost Admin — you should see a view recorded.
