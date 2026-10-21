#!/usr/bin/env bash
# Several production sites behind one shared Caddy, against real containers.
#
#   tests/e2e/shared-caddy.sh
#
# Builds the manager image from this checkout, sets up the shared Caddy with
# `install --infra`, and installs two production sites behind it: one on
# Ghost 6.61.0 with ActivityPub, one on the newest Ghost 6, each with its own
# MySQL. Caddy serves them with its own test CA under names curl resolves to
# this host. A third site asking for a domain the shared Caddy already serves
# is refused before anything is written. Then each operation on one site is
# checked to leave the other as it was, the same containers serving the same
# routes: updating the first site's Ghost, backing it up and restoring it over
# itself, restarting and recreating the shared Caddy (both sites come back),
# and removing the second site, whose routes go with it.
#
# It pulls images, starts containers and binds ports 80 and 443 (it fails
# when something else holds them, or is skipped with GD_E2E_ALLOW_SKIP=1). It
# needs jq and curl. Exits non-zero at the first check that fails, naming it.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
IMAGE=ghost-docker:e2e-shared-caddy
FROM=6.61.0
DOMAIN_A=alpha-e2e.test
DOMAIN_B=bravo-e2e.test

# What this host cannot run fails the run, unless GD_E2E_ALLOW_SKIP=1.
# shellcheck source=/dev/null
source "$ROOT/tests/e2e/lib.sh"
require_docker
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if ! port_free 80 || ! port_free 443; then
    skip "something on this host already holds 80 or 443"
    passed "Nothing ran: the shared Caddy is on 80 and 443."
    exit 0
fi
if docker network inspect ghost-ingress >/dev/null 2>&1; then
    skip "this daemon already has a shared Caddy (the network ghost-ingress)"
    passed "Nothing ran: a daemon has one shared Caddy."
    exit 0
fi
for tool in jq curl; do
    command -v "$tool" >/dev/null || {
        printf 'shared-caddy.sh needs %s\n' "$tool" >&2
        exit 1
    }
done

work_dir shared-caddy
SITES=()
SITE=""

# The members first, then the shared Caddy and its network, then every
# directory, removed as root: MySQL's data belongs to MySQL's user.
teardown() {
    local site
    for site in ${SITES[@]+"${SITES[@]}"}; do
        [[ -f $site/.env ]] && docker compose --project-directory "$site" -f "$site/compose.yml" \
            down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1
    done
    [[ -f ${CADDY:-}/.env ]] && docker compose --project-directory "$CADDY" -f "$CADDY/compose.yml" \
        down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1
    docker network rm ghost-ingress >/dev/null 2>&1
    docker run --rm --user 0 --entrypoint rm -v "$WORK:/work" "$IMAGE" -rf /work/sites >/dev/null 2>&1
}

on_fail() {
    [[ -z ${CADDY:-} ]] || docker compose --project-directory "$CADDY" -f "$CADDY/compose.yml" \
        logs --no-color --tail 40 caddy >&2 2>&1 || true
}

# gd SITE ARGS... -- a site's own launcher, on the image built here.
gd() { GD_IMAGE=$IMAGE "$1/ghost-docker" --dir "$@"; }

# through DOMAIN -- what Ghost's site endpoint answers for DOMAIN, through the
# shared Caddy on this host's port 443, trusting its test CA as told to.
through() {
    curl --disable --silent --insecure --noproxy '*' --max-time 20 --resolve "$1:443:127.0.0.1" \
        "https://$1/ghost/api/admin/site/" | jq -r '.site.url' 2>/dev/null || true
}

# serves DOMAIN -- Ghost for DOMAIN answers through the shared Caddy, waiting
# for Caddy's certificate and for Ghost to boot.
serves() {
    local tries=0
    until [[ $(through "$1") == "https://$1/" ]]; do
        tries=$((tries + 1))
        ((tries < 90)) || fail "Ghost for $1 does not answer through the shared Caddy" "$(through "$1")"
        sleep 2
    done
}

# containers SITE -- each of the site's containers, with when it started.
containers() {
    compose_in "$1" ps --all -q | sort | xargs docker inspect --format '{{.Id}} {{.State.StartedAt}}'
}

# routes -- the shared Caddy's routes files, with their checksums.
routes() { (cd "$CADDY/caddy/sites" && find . -type f | sort | xargs shasum -a 256); }

# untouched SITE BEFORE -- SITE's containers are the ones there were, as they were.
untouched() {
    [[ $(containers "$1") == "$2" ]] || fail "$(basename "$1")'s containers changed" "$(containers "$1")"
}

printf 'Docker: %s on %s\n' "$(docker info --format '{{.OperatingSystem}}')" "$(uname -s)"

step "Build the manager image, and set up the shared Caddy"
run docker build --quiet --file "$ROOT/manager/Dockerfile" --tag "$IMAGE" "$ROOT"
expect_status 0
mkdir -p "$WORK/launcher-only" "$WORK/sites/caddy/caddy/global"
cp "$ROOT/ghost-docker" "$WORK/launcher-only/ghost-docker"
CADDY=$WORK/sites/caddy
# Caddy's own CA for the names, at once: a test fixture standing in for the
# CA a real domain gets.
printf 'local_certs\n' >"$CADDY/caddy/global/test-ca.caddy"
run env GD_IMAGE=$IMAGE "$WORK/launcher-only/ghost-docker" --dir "$CADDY" install --infra
expect_status 0
expect_output 'The shared Caddy is installed'
[[ $(setting "$CADDY" COMPOSE_PROFILES) == infra ]] || fail "the shared Caddy's profiles are not infra"
[[ ! -e $CADDY/.ghost-docker.json && ! -e $CADDY/mysql-init ]] || fail "the shared Caddy has a site's files"
[[ $(docker network inspect ghost-ingress --format '{{index .Labels "org.ghost.docker.infra.dir"}}') == "$CADDY" ]] ||
    fail "the network does not say where the shared Caddy is"
[[ $(compose_in "$CADDY" ps --format '{{.Service}} {{.Health}}') == 'caddy healthy' ]] ||
    fail "Caddy is not the only service, or not healthy" "$(compose_in "$CADDY" ps)"
run env GD_IMAGE=$IMAGE "$WORK/launcher-only/ghost-docker" --dir "$WORK/sites/second" install --infra
expect_status 1
expect_output "already has the shared Caddy in $CADDY"
ok "$CADDY, on ghost-ingress; a second is refused"

step "Two sites behind it, on different Ghost versions, each with its own MySQL"
new_site alpha
A=$SITE
run env GD_IMAGE=$IMAGE "$WORK/launcher-only/ghost-docker" --dir "$A" install --domain "$DOMAIN_A" \
    --version "$FROM" --with activitypub --no-prompt
expect_status 0
expect_output 'served by the shared Caddy'
new_site bravo
B=$SITE
run env GD_IMAGE=$IMAGE "$WORK/launcher-only/ghost-docker" --dir "$B" install --domain "$DOMAIN_B" --no-prompt
expect_status 0
for site in "$A" "$B"; do
    [[ $(setting "$site" COMPOSE_PROFILES) == member* ]] || fail "$site is not a member"
    [[ ! -e $site/caddy ]] || fail "$site has a Caddy of its own"
    [[ -z $(compose_in "$site" ps -q caddy) ]] || fail "$site runs a Caddy"
    [[ -n $(compose_in "$site" ps -q db) ]] || fail "$site has no MySQL of its own"
done
[[ -f $CADDY/caddy/sites/ghost-alpha-e2e-test.caddy && -f $CADDY/caddy/sites/ghost-bravo-e2e-test.caddy ]] ||
    fail "the routes are not in the shared Caddy" "$(ls "$CADDY/caddy/sites")"
[[ -n $(compose_in "$A" ps -q activitypub) ]] || fail "alpha's ActivityPub is not running"
version_a=$(compose_in "$A" exec -T ghost printenv GHOST_VERSION)
version_b=$(compose_in "$B" exec -T ghost printenv GHOST_VERSION)
[[ $version_a == "$FROM" && $version_b != "$FROM" ]] || fail "the sites run $version_a and $version_b"
serves "$DOMAIN_A"
serves "$DOMAIN_B"
for site in "$A" "$B"; do
    run gd "$site" check
    expect_status 0
    expect_output 'shared caddy +healthy'
    expect_output 'routes +.*\.caddy, in the shared Caddy'
done
run gd "$A" list
expect_status 0
expect_output '^ghost-infra +shared caddy '
expect_output '^ghost-alpha-e2e-test +member '
expect_output '^ghost-bravo-e2e-test +member '
ok "alpha on Ghost $version_a with ActivityPub, bravo on Ghost $version_b; both served, check passes"

step "A domain the shared Caddy serves is refused before anything is written"
new_site charlie
run env GD_IMAGE=$IMAGE "$WORK/launcher-only/ghost-docker" --dir "$SITE" install --domain "www.$DOMAIN_B" \
    --admin-domain "$DOMAIN_A" --no-prompt
expect_status 1
expect_output "already serves $DOMAIN_A"
[[ -z $(find "$SITE" -mindepth 1 -not -name .ghost-docker-probe) ]] ||
    fail "the refused install wrote into its directory" "$(ls -A "$SITE")"
ok "refused, and $SITE is empty"

before_b=$(containers "$B")
routes_before=$(routes)

step "Updating alpha's Ghost leaves bravo untouched"
run gd "$A" update
expect_status 0
expect_output "Updated Ghost from $FROM to "
[[ $(compose_in "$A" exec -T ghost printenv GHOST_VERSION) != "$FROM" ]] || fail "alpha still runs $FROM"
serves "$DOMAIN_A"
untouched "$B" "$before_b"
[[ $(routes) == "$routes_before" ]] || fail "the routes changed" "$(routes)"
[[ $(through "$DOMAIN_B") == "https://$DOMAIN_B/" ]] || fail "bravo no longer answers"
ok "alpha updated; bravo's containers and every route as they were"

step "Backing alpha up and restoring it over itself leaves bravo untouched"
run gd "$A" backup
expect_status 0
backup=$(find "$A/backups" -mindepth 1 -maxdepth 1 | sort | tail -1)
jq -e '.notIncluded | any(test("shared Caddy"))' "$backup/manifest.json" >/dev/null ||
    fail "the backup does not say it leaves the routes out" "$(cat "$backup/manifest.json")"
run gd "$A" restore --yes "$backup"
expect_status 0
serves "$DOMAIN_A"
untouched "$B" "$before_b"
[[ $(routes) == "$routes_before" ]] || fail "the routes changed" "$(routes)"
ok "restored $(basename "$backup"); bravo's containers and every route as they were"

step "Restarting, and recreating, the shared Caddy brings both back"
before_a=$(containers "$A")
compose_in "$CADDY" restart caddy >/dev/null 2>&1 || fail "Caddy did not restart"
serves "$DOMAIN_A"
serves "$DOMAIN_B"
out=$(compose_in "$CADDY" down 2>&1) || fail "the shared Caddy did not come down" "$out"
docker network inspect ghost-ingress >/dev/null 2>&1 || fail "taking the shared Caddy down removed its network"
compose_in "$CADDY" up --detach --wait >/dev/null 2>&1 || fail "the shared Caddy did not start again"
serves "$DOMAIN_A"
serves "$DOMAIN_B"
untouched "$A" "$before_a"
untouched "$B" "$before_b"
ok "both answer after a restart and after down and up; neither site's containers changed"

step "Removing bravo removes its routes, and leaves alpha untouched"
run gd "$B" remove
expect_status 2
expect_output 'Run it again with --yes'
run gd "$B" remove --yes
expect_status 0
[[ ! -e $CADDY/caddy/sites/ghost-bravo-e2e-test.caddy ]] || fail "bravo's routes are still there"
[[ -f $CADDY/caddy/sites/ghost-alpha-e2e-test.caddy ]] || fail "alpha's routes went too"
[[ -z $(compose_in "$B" ps --all -q) ]] || fail "bravo's containers are still there"
[[ -f $B/.env ]] || fail "bravo's directory was not kept"
[[ $(through "$DOMAIN_B") != "https://$DOMAIN_B/" ]] || fail "bravo still answers"
serves "$DOMAIN_A"
untouched "$A" "$before_a"
run gd "$A" list
expect_output '^ghost-alpha-e2e-test +member '
refute_output 'ghost-bravo-e2e-test'
ok "bravo removed with its routes; alpha's containers as they were, and served"

passed 'All shared Caddy checks passed.'
