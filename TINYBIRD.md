# Tinybird Configuration

Note: Currently Traffic Analytics features are behind a feature flag. For now, you'll need to enable it by following the steps below:

1. Create a Tinybird account and a Tinybird workspace at [tinybird.co](https://auth.tinybird.co/login). You can select any cloud/region you choose.
1. Run `docker compose run --rm tinybird-login` to login to your Tinybird account following the steps given
1. Run `docker compose run --rm tinybird-sync`. This will copy the Tinybird files from the Ghost image into a shared volume. The service should log "Tinybird files synced into shared volume.", then exit.
1. Run `docker compose run --rm tinybird-deploy` and wait for the service to exit successfully. This will create your Tinybird datasources, pipes and API endpoints. It may take a minute or two to complete the first time. You should see "Deployment #1 is live!" in your terminal before the service exits.
1. Run `docker compose run --rm tinybird-login get-tokens`
1. Copy and paste the values from the previous step into your `.env` file
1. Run `docker compose --profile=analytics up -d` to start all services in the background
1. Add `analytics` to `COMPOSE_PROFILES=` in the top of your `.env` file to automatically include the `analytics` profile when running `docker compose` commands
1. At this point, everything should be working. You can test it's working by visiting your site's homepage, then checking the Stats page in Ghost Admin — you should see a view recorded.

## Destructive deployments

Deployments allow destructive operations so Ghost upgrades can remove obsolete
resources, including materialized views. Before deploying, we run
`tb --cloud --output json deploy --check --allow-destructive-operations` to ask
Tinybird for the proposed changes without applying them. Deployment stops if the
plan's `deleted_datasource_names` includes `analytics_events`, if the check fails,
or if the JSON plan is missing or unrecognized. Other resource deletions are allowed.
Sync also stops on missing source directories or copy errors.

This guard prevents planned deletion of the raw analytics datasource. It does not protect
against destructive schema changes to that datasource or deletions of other
resources. Use a workspace dedicated to Ghost. The check and deploy are separate
requests; avoid concurrent deployments or changes to project files between them.

After updating these scripts, rebuild the helper image with
`docker compose build --no-cache tinybird-deploy` to install a current Tinybird CLI
with JSON deployment-check output.
