# Tinybird Configuration

Note: Currently Traffic Analytics features are behind a feature flag. For now, you'll need to enable it by following the steps below:

1. Create a Tinybird account and a Tinybird workspace at [tinybird.co](https://auth.tinybird.co/login). You can select any cloud/region you choose.
1. Run `docker compose run --rm tinybird-login` to login to your Tinybird account following the steps given
1. Run `docker compose run --rm tinybird-sync`. This will copy the Tinybird files from the Ghost container into a shared volume. The service should log "Tinybird files synced into shared volume.", then exit.
1. Run `docker compose run --rm tinybird-deploy` and wait for the service to exit successfully. This will create your Tinybird datasources, pipes and API endpoints. It may take a minute or two to complete the first time. You should see "Deployment #1 is live!" in your terminal before the service exits.
1. Run `docker compose run --rm tinybird-login get-tokens`
1. Copy and paste the values from the previous step into your `.env` file (Tinybird credentials are operator settings, not Ghost application settings)
1. Run `docker compose --profile=analytics up -d` to start all services in the background
1. Add `analytics` to `COMPOSE_PROFILES` in your `.env` file, alongside the site mode, to include the `analytics` profile automatically when running `docker compose` commands. Profiles are additive: adding `analytics` does not change the site mode.
1. Run `scripts/caddy.sh apply` so the generated routes proxy `/.ghost/analytics/` to this site's analytics service (production only)
1. At this point, everything should be working. You can test it's working by visiting your site's homepage, then checking the Stats page in Ghost Admin — you should see a view recorded.

Tinybird credentials, workspace selection and schema deployment belong to this
site. `tinybird-sync` and `tinybird-deploy` are distinct steps and are one-shot
jobs: they keep `restart: "no"` and stay stopped after they complete. Copying
new Tinybird files into the shared volume is not a deployment — a Ghost upgrade
must run `tinybird-deploy` after `tinybird-sync`.
