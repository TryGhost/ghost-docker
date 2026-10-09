#!/usr/bin/env bash
# Migration 0001-compose-profiles, against real containers: an installation
# of the released main layout moved onto this one by the served launcher.
#
#   tests/e2e/migrate-main.sh
#
# The installation is made as main's README made one: a git clone of the
# stack (tests/fixtures/released-main, committed, untagged, with a remote-
# tracking branch), `.env` and `caddy/Caddyfile` copied from the examples and
# edited, ActivityPub enabled, a custom route, a global options block, and a
# compose.override.yml. It runs the official `ghost:6-alpine` image, whose
# layout this release does not run. Then:
#
#   - an edited stack file, and a release image that cannot be pulled, stop
#     the migration before anything changes;
#   - Ghost never becoming healthy on the new layout stops the site, puts
#     main's files back, and the site starts again on them with its data;
#   - the migration through the served launcher, piped as from curl, keeps
#     the project, its volumes, credentials, data, Ghost's version, the
#     routes and the override, and the site answers through Caddy;
#   - running it again is an ordinary self-update with nothing to do.
#
# It pulls images, starts containers and publishes Caddy on two loopback
# ports. Caddy's own CA stands in for a real one (`local_certs`), so nothing
# asks an ACME server. Exits non-zero at the first check that fails.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
REGISTRY=ghcr.io/tryghost/ghost-docker
# A version no real release has, so a published image is never mistaken for it.
RELEASE=v0.0.2-beta.1
IMAGE=$REGISTRY:$RELEASE
DOMAIN=ghost-e2e.test
HTTP_PORT=18080
HTTPS_PORT=18443

# shellcheck source=/dev/null
source "$ROOT/tests/e2e/skip.sh"
require_docker
for tool in git curl; do
    command -v "$tool" >/dev/null || {
        printf 'migrate-main.sh needs %s\n' "$tool" >&2
        exit 1
    }
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ghost-docker-migrate-e2e.XXXXXXXX")
WORK=$(CDPATH='' cd -- "$WORK" && pwd -P)
S=$WORK/sites/main-site
CURRENT=setup
OUT=""
RC=0

cleanup() {
    local rc=$?
    set +e
    [[ -f $S/compose.yml ]] && docker compose --project-directory "$S" -f "$S/compose.yml" \
        --profile '*' down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1
    docker run --rm --user 0 --entrypoint rm -v "$WORK:/work" "$IMAGE" -rf /work/sites >/dev/null 2>&1
    docker rmi "$IMAGE" >/dev/null 2>&1
    case $WORK in */ghost-docker-migrate-e2e.*) rm -rf -- "$WORK" ;; esac
    exit "$rc"
}
trap cleanup EXIT

step() {
    CURRENT=$1
    printf '\n== %s\n' "$1"
}
ok() { printf '   ok    %s\n' "$1"; }
fail() {
    printf '\nFAILED in "%s": %s\n' "$CURRENT" "$1" >&2
    [[ -z ${2:-} ]] || printf -- '--- output ---\n%s\n--------------\n' "$2" >&2
    exit 1
}
run() {
    set +e
    OUT=$("$@" 2>&1 </dev/null)
    RC=$?
    set -e
}
expect_status() { [[ $RC -eq $1 ]] || fail "exited $RC, expected $1" "$OUT"; }
expect_output() { grep -qE -- "$1" <<<"$OUT" || fail "the output does not match: $1" "$OUT"; }

compose_in() { docker compose --project-directory "$S" -f "$S/compose.yml" "$@"; }
# served ARGS... -- the launcher as docker.ghost.org serves it, piped into bash
# in the site directory: no file beside it, so no checkout and no pin.
served() {
    run bash -c 'cd "$1" && GD_IMAGE="$2" bash -s -- "${@:4}" <"$3"' _ "$S" "$IMAGE" "$ROOT/ghost-docker" "$@"
}
# Every file but the data, backups and git's own, with its checksum.
fingerprint() {
    (cd "$S" && find . -type f -not -path './data/*' -not -path './backups/*' -not -path './.git/*' \
        -not -path './.ghost-docker-update/*' -print0 | sort -z | xargs -0 shasum -a 256)
}
ghost_id() { compose_in ps -q ghost; }
# Ghost has booted: main's compose.yml gives it no health check to wait for.
wait_for_ghost() {
    local waited=0
    until compose_in logs ghost 2>/dev/null | grep -q 'Ghost booted'; do
        ((waited < 300)) || fail "Ghost did not boot" "$(compose_in logs --tail 40 ghost 2>&1)"
        sleep 5
        waited=$((waited + 5))
    done
}
root_sql() {
    compose_in exec -T -e MYSQL_PWD=e2e-root-password db mysql -uroot -N -B ghost -e "$1"
}
# https PATH -- through Caddy on the host's port, as a browser would ask.
https() {
    curl --silent --insecure --noproxy '*' --max-time 20 --header "Host: $DOMAIN" \
        --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1" "https://$DOMAIN:$HTTPS_PORT$1" || true
}

# --- The release, and main's installation -----------------------------------------

step "Build the release"
run docker build --quiet --file "$ROOT/manager/Dockerfile" --build-arg "GD_VERSION=$RELEASE" \
    --build-arg "GD_COMMIT=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf '')" --tag "$IMAGE" "$ROOT"
expect_status 0
ok "$IMAGE"

step "An installation of the released main layout, as its README made one"
mkdir -p "$S"
cp -R "$ROOT/tests/fixtures/released-main/." "$S/"
rm "$S/README.md"
cp -R "$ROOT/tinybird" "$S/tinybird"
printf '.env\ndata\n' >"$S/.gitignore"
git -C "$S" init --quiet
git -C "$S" add -A
git -C "$S" -c user.name=e2e -c user.email=e2e@example.com commit --quiet -m 'main'
# As a clone has it: the commit is on a remote-tracking branch, and untagged.
git -C "$S" update-ref refs/remotes/origin/main HEAD
cp "$S/.env.example" "$S/.env"
sed -i.bak \
    -e "s/^# COMPOSE_PROFILES=.*/COMPOSE_PROFILES=activitypub/" \
    -e "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" \
    -e "s/^HTTP_PORT=.*/HTTP_PORT=$HTTP_PORT/" \
    -e "s/^HTTPS_PORT=.*/HTTPS_PORT=$HTTPS_PORT/" \
    -e "s/^DATABASE_ROOT_PASSWORD=.*/DATABASE_ROOT_PASSWORD=e2e-root-password/" \
    -e "s/^DATABASE_PASSWORD=.*/DATABASE_PASSWORD=e2e-app-pa\$\$word/" \
    -e "s/^# ACTIVITYPUB_TARGET=.*/ACTIVITYPUB_TARGET=activitypub:8080/" \
    -e "s/^mail__options__auth__pass=.*/mail__options__auth__pass=e2e-smtp-secret/" \
    "$S/.env"
rm "$S/.env.bak"
printf 'labs__publicAPI=true\n' >>"$S/.env"
# The example, with Caddy's own CA, and a route of the operator's own.
{
    printf '{\n\tlocal_certs\n}\n\n'
    sed 's|^\t# Default proxy everything else to Ghost|\thandle /e2e-custom {\n\t\trespond "custom route kept"\n\t}\n\n\t# Default proxy everything else to Ghost|' \
        "$S/caddy/Caddyfile.example"
} >"$S/caddy/Caddyfile"
cat >"$S/compose.override.yml" <<'EOF'
services:
  ghost:
    environment:
      e2e__override: kept
EOF
run compose_in up -d
expect_status 0
wait_for_ghost
project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$(ghost_id)")
version=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(ghost_id)" | sed -n 's/^GHOST_VERSION=//p')
root_sql 'CREATE TABLE e2e_marker (note varchar(64)); INSERT INTO e2e_marker VALUES ("kept")'
compose_in exec -T ghost sh -c 'printf kept >/var/lib/ghost/content/images/e2e-marker.txt'
[[ $(https /e2e-custom) == 'custom route kept' ]] || fail "main's custom route does not answer" "$(https /e2e-custom)"
docker volume inspect "${project}_caddy_data" >/dev/null || fail "no ${project}_caddy_data volume"
ok "project $project, Ghost $version on ghost:6-alpine, with ActivityPub, a custom route and an override"

# --- Refused before anything changes ------------------------------------------------

step "An edited stack file stops it before anything changes"
printf '# mine\n' >>"$S/compose.yml"
before=$(fingerprint)
ghost_before=$(ghost_id)
served self-update
expect_status 1
expect_output 'these files of the stack were changed here'
expect_output 'compose\.yml'
expect_output 'Nothing has been changed'
[[ $(fingerprint) == "$before" && $(ghost_id) == "$ghost_before" ]] || fail "a refused migration changed the site"
git -C "$S" checkout --quiet -- compose.yml
ok "refused, naming compose.yml"

step "An image the release cannot pull stops it before anything changes"
cp "$S/compose.override.yml" "$WORK/override.yml"
cat >>"$S/compose.override.yml" <<'EOF'
  e2e-unpullable:
    image: ghcr.io/tryghost/ghost-docker-e2e-does-not-exist:1
    profiles: [production]
EOF
before=$(fingerprint)
served self-update
expect_status 1
expect_output "images could not be pulled"
expect_output 'Nothing has been changed'
[[ $(fingerprint) == "$before" && $(ghost_id) == "$ghost_before" ]] || fail "a refused migration changed the site"
cp "$WORK/override.yml" "$S/compose.override.yml"
ok "refused while the site kept running"

step "--check says what it would do and changes nothing"
before=$(fingerprint)
served self-update --check
expect_status 0
expect_output "would move this site onto $RELEASE"
expect_output "Ghost +$version"
[[ $(fingerprint) == "$before" && $(ghost_id) == "$ghost_before" ]] || fail "--check changed the site"
ok "nothing changed"

# --- Failing after startup ---------------------------------------------------------

step "Ghost never healthy on the new layout: stopped, main's files back, data kept"
cat >>"$S/compose.override.yml" <<'EOF'
    healthcheck:
      test: [CMD, "false"]
      interval: 2s
      start_period: 0s
      start_interval: 2s
      retries: 1
EOF
before=$(fingerprint)
served self-update
expect_status 1
expect_output 'The site needs you'
expect_output 'Nothing was loaded over them'
expect_output 'docker compose up -d'
[[ $(fingerprint) == "$before" ]] || fail "main's files were not put back" "$(diff <(printf '%s\n' "$before") <(fingerprint) || true)"
[[ -z $(compose_in ps -q) ]] || fail "the migrated site was left running" "$(compose_in ps)"
ok "stopped, with main's files back"

# The operator's part: the snapshot and the backup are no longer needed.
rm -rf "$S/.ghost-docker-update" "$S/backups"
cp "$WORK/override.yml" "$S/compose.override.yml"
run compose_in up -d
expect_status 0
wait_for_ghost
[[ $(root_sql 'SELECT note FROM e2e_marker') == kept ]] || fail "the marker row is gone"
[[ $(https /e2e-custom) == 'custom route kept' ]] || fail "main's site does not answer again"
ok "main's layout starts again on its data"

# --- The migration --------------------------------------------------------------------

step "The served launcher migrates it"
served self-update
expect_status 0
expect_output "Moved from the released main layout to $RELEASE"
expect_output 'with a certificate from Caddy Local Authority'
setting() { "$S/ghost-docker" --dir "$S" config get "$1" 2>/dev/null; }
[[ $(setting COMPOSE_PROFILES) == production,activitypub ]] || fail "COMPOSE_PROFILES is $(setting COMPOSE_PROFILES)"
[[ $(setting COMPOSE_PROJECT_NAME) == "$project" ]] || fail "the project is $(setting COMPOSE_PROJECT_NAME)"
# shellcheck disable=SC2016 # a literal $, as Compose read it from main's .env
[[ $(setting DATABASE_PASSWORD) == 'e2e-app-pa$word' ]] || fail "the database password changed"
[[ $(setting URL) == "https://$DOMAIN" ]] || fail "URL is $(setting URL)"
[[ $("$S/ghost-docker" --dir "$S" config get ghost.env mail__options__auth__pass 2>/dev/null) == e2e-smtp-secret ]] ||
    fail "the SMTP password did not move to ghost.env"
grep -q '^DOMAIN=' "$S/.env" && fail ".env still has DOMAIN"
grep -q 'local_certs' "$S/caddy/global/legacy.caddy" || fail "the global options were not carried"
grep -q "activitypub-$project:8080" "$S/caddy/sites/site.caddy" || fail "ActivityPub is not this site's" "$(cat "$S/caddy/sites/site.caddy")"
cmp -s "$S/caddy/Caddyfile" "$ROOT/caddy/Caddyfile" || fail "caddy/Caddyfile is not the release's"
[[ -f $S/caddy/Caddyfile.local ]] || fail "the old Caddyfile was not kept"
running=$(docker inspect -f '{{.Config.Image}}' "$(ghost_id)")
[[ $running == "$(setting GHOST_IMAGE_REF)" && $running == ghost@sha256:* ]] || fail "Ghost runs $running"
now=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(ghost_id)")
grep -qx "GHOST_VERSION=$version" <<<"$now" || fail "Ghost's version changed" "$now"
grep -qx 'e2e__override=kept' <<<"$now" || fail "the override does not reach Ghost" "$now"
grep -q 'DATABASE_ROOT_PASSWORD' <<<"$now" && fail "Ghost receives .env's root password"
[[ $(root_sql 'SELECT note FROM e2e_marker') == kept ]] || fail "the marker row is gone"
[[ $(compose_in exec -T ghost cat /home/ghost/content/images/e2e-marker.txt) == kept ]] || fail "the content is gone"
[[ $(https /e2e-custom) == 'custom route kept' ]] || fail "the custom route does not answer" "$(https /e2e-custom)"
[[ $(https /ghost/api/admin/site/) == *"\"url\":\"https://$DOMAIN/\""* ]] || fail "Ghost does not answer through Caddy"
docker volume inspect "${project}_caddy_data" >/dev/null || fail "Caddy's volume is not the site's"
[[ $(find "$S/backups" -mindepth 1 -maxdepth 1 -type d | wc -l) -eq 1 ]] || fail "there is not one backup"
[[ ! -e $S/.ghost-docker-update && ! -e $S/.ghost-docker.lock ]] || fail "the migration left its snapshot or lock"
ok "Ghost $version on its next image, project, volumes, data, routes and override kept"

run "$S/ghost-docker" --dir "$S" check
expect_status 0
ok "check passes"

step "Running it again is an ordinary self-update, with nothing to do"
before=$(fingerprint)
served self-update
expect_status 0
expect_output "already runs $RELEASE"
[[ $(fingerprint) == "$before" ]] || fail "a second run changed files"
ok "nothing to do"

passed "migrate-main.sh: all checks passed."
