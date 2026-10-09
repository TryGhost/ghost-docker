#!/usr/bin/env bash
# A real Ghost-CLI production site moved to Docker on the same server.
#
#   GD_TEST_HOST_CHANGES=1 tests/e2e/production-import.sh
#
# The source is installed the way Ghost-CLI installs production: MySQL on the
# host, a systemd service, nginx on port 80, and a separate admin domain. It
# is moved the way "Moving a production site" in docs/install.md says, on the
# same server: first with nginx left running, which must fail without
# changing anything, and recover with the documented steps; then for real.
# The bundle is the released exporter's; the import runs through the launcher
# and the manager image built from this checkout.
#
# This changes the host: it installs a site under /var/www, a systemd service
# and an nginx site, creates a MySQL user, and stops and starts nginx. It is
# written for a disposable Linux machine, such as a CI runner, and refuses to
# run without GD_TEST_HOST_CHANGES=1. It needs passwordless sudo, systemd,
# nginx running on port 80, MySQL running with root's password in
# GD_TEST_MYSQL_ROOT_PASSWORD (default: root), Ghost-CLI installed globally
# (the systemd service runs it as the `ghost` user), jq and curl.
#
#   GD_TEST_GHOST_CLI   the Ghost-CLI command. Default: ghost
#   GD_TEST_KEEP=1      leave the work directory, source and sites in place
#
# Exits non-zero at the first check that fails, naming it.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
IMAGE=ghost-docker:e2e
DEFAULT_GHOST=ghost:6-next-alpine
DOMAIN=ghost-e2e.test
ADMIN_DOMAIN=admin.$DOMAIN
SOURCE=/var/www/ghost-e2e

# What this host cannot run fails the run, unless GD_E2E_ALLOW_SKIP=1.
# shellcheck source=/dev/null
source "$ROOT/tests/e2e/skip.sh"
require_docker

read -ra GHOST_CLI <<<"${GD_TEST_GHOST_CLI:-ghost}"
readonly MYSQL_ROOT_PASSWORD=${GD_TEST_MYSQL_ROOT_PASSWORD:-root}
readonly OWNER_EMAIL="owner@example.com"
readonly OWNER_PASSWORD="Sup3r-secret-pass!"
readonly TITLE="Production source"
# Dollar signs and both kinds of quote: the value that dotenv encoding gets wrong.
readonly MAIL_FROM="'Import \$Test \"quoted\"' <noreply@example.com>"

SITES=()
SOURCE_INSTALLED=0
CURRENT="setup"
OUT=""
RC=0

# --- Reporting ---------------------------------------------------------------

step() {
    CURRENT=$1
    printf '\n== %s\n' "$1"
}

ok() { printf '   ok    %s\n' "$1"; }

fail() {
    printf '\nFAILED in "%s": %s\n' "$CURRENT" "$1" >&2
    if [[ -n ${2:-} ]]; then
        printf -- '--- output ---\n%s\n--------------\n' "$2" >&2
    fi
    exit 1
}

# --- Helpers -----------------------------------------------------------------

# compose_in SITE ARGS... -- Compose as an operator runs it, from the host.
compose_in() {
    local site=$1
    shift
    docker compose --project-directory "$site" -f "$site/compose.yml" "$@"
}

# setting SITE KEY -- one decoded value of .env, through the manager.
setting() { GD_IMAGE=$IMAGE "$ALONE/ghost-docker" --dir "$1" config get "$2" 2>/dev/null; }

# ghost_cli ARGS... -- Ghost-CLI in the source's directory; output to $WORK/ghost.log.
ghost_cli() {
    (cd "$SOURCE" && "${GHOST_CLI[@]}" "$@") >"$WORK/ghost.log" 2>&1 ||
        fail "ghost $* failed" "$(tail -40 "$WORK/ghost.log")"
}

# run_import SITE ARGS... -> sets OUT and RC, never exits
run_import() {
    local site=$1
    shift
    set +e
    OUT=$(GD_IMAGE=$IMAGE "$ALONE/ghost-docker" --dir "$site" install --no-prompt "$@" 2>&1 </dev/null)
    RC=$?
    set -e
}

expect_output() {
    grep -qE -- "$1" <<<"$OUT" || fail "the output does not match: $1" "$OUT"
}

# new_site NAME -> SITE, an empty directory that cleanup takes down, holding
# the test CA: Caddy's own, for every name at once, standing in for the CA a
# real domain gets.
new_site() {
    SITE=$WORK/sites/$1
    mkdir -p "$SITE/caddy/global"
    printf 'local_certs\n' >"$SITE/caddy/global/test-ca.caddy"
    SITES+=("$SITE")
}

# source_active -- systemd runs the source's Ghost.
source_active() { systemctl is-active --quiet "$SERVICE"; }

# nginx_serves_source -- nginx on port 80 answers for the domain with the
# source's Ghost: Ghost, not nginx, redirects to the HTTPS URL.
nginx_serves_source() {
    local location
    location=$(curl --disable --silent --noproxy '*' --max-time 20 --output /dev/null \
        --write-out '%{redirect_url}' --header "Host: $DOMAIN" "http://127.0.0.1/" || true)
    [[ $location == "https://$DOMAIN/" ]]
}

# source_api METHOD PATH [curl options] -- the source's Admin API, straight to
# Ghost, as nginx would forward an HTTPS request for the admin domain.
source_api() {
    local method=$1 path=$2
    shift 2
    curl --disable --silent --noproxy '*' --max-time 60 --request "$method" \
        --header "Host: $ADMIN_DOMAIN" --header 'X-Forwarded-Proto: https' \
        --header "Origin: https://$ADMIN_DOMAIN" --header 'Content-Type: application/json' \
        "$@" "http://127.0.0.1:$SOURCE_PORT/ghost/api/admin/$path"
}

# site_https URL [curl options] -- through the host's port 443 and Caddy, as a
# browser asks, trusting Caddy's test CA.
site_https() {
    local url=$1
    shift
    curl --disable --silent --insecure --noproxy '*' --max-time 30 \
        --resolve "$DOMAIN:443:127.0.0.1" --resolve "$ADMIN_DOMAIN:443:127.0.0.1" "$@" "$url"
}

# --- Cleanup -----------------------------------------------------------------

cleanup() {
    local rc=$? site
    trap - EXIT
    set +e
    if [[ ${GD_TEST_KEEP:-0} == 1 ]]; then
        printf '\nGD_TEST_KEEP is set; everything was left in %s and %s\n' "$WORK" "$SOURCE" >&2
        exit "$rc"
    fi
    printf '\nCleaning up\n'
    for site in ${SITES[@]+"${SITES[@]}"}; do
        [[ -f $site/compose.yml ]] &&
            compose_in "$site" down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1
    done
    if [[ $SOURCE_INSTALLED == 1 ]]; then
        (cd "$SOURCE" && "${GHOST_CLI[@]}" uninstall --no-prompt --force >/dev/null 2>&1)
        sudo rm -rf "$SOURCE"
    fi
    sudo systemctl start nginx >/dev/null 2>&1
    docker run --rm --user 0 --entrypoint rm -v "$WORK:/work" "$IMAGE" -rf /work/sites >/dev/null 2>&1
    case $WORK in
        */ghost-docker-production-import-e2e.*) rm -rf -- "$WORK" ;;
    esac
    exit "$rc"
}

# --- Setup -------------------------------------------------------------------

step "Preparing"
if [[ ${GD_TEST_HOST_CHANGES:-} != 1 ]]; then
    skip "this installs a Ghost-CLI production site on the host; set GD_TEST_HOST_CHANGES=1 on a disposable machine"
    passed "Nothing ran."
    exit 0
fi
for tool in docker jq curl sudo systemctl mysql mysqldump "${GHOST_CLI[0]}"; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"
done
sudo -n true 2>/dev/null || fail "sudo needs a password here"
systemctl is-active --quiet nginx || fail "nginx is not running: the existing proxy is part of the scenario"
[[ ! -e $SOURCE ]] || fail "$SOURCE already exists"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ghost-docker-production-import-e2e.XXXXXXXX")
WORK=$(CDPATH='' cd -- "$WORK" && pwd -P)
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker build --quiet --file "$ROOT/manager/Dockerfile" --tag "$IMAGE" "$ROOT" >/dev/null ||
    fail "the manager image could not be built"
# A launcher with no checkout beside it, as an operator without one has.
ALONE=$WORK/launcher-only
mkdir -p "$ALONE" "$WORK/sites"
cp "$ROOT/ghost-docker" "$ALONE/ghost-docker"

# The source is installed at the version the default image ships, so the
# import never depends on an image for a release published minutes ago.
docker pull --quiet "$DEFAULT_GHOST" >/dev/null
GHOST_VERSION=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$DEFAULT_GHOST" |
    sed -n 's/^GHOST_VERSION=//p')
[[ -n $GHOST_VERSION ]] || fail "$DEFAULT_GHOST does not declare GHOST_VERSION"
ok "working in $WORK, Ghost $GHOST_VERSION, Ghost-CLI $("${GHOST_CLI[@]}" --version 2>/dev/null | head -1)"

# --- The source --------------------------------------------------------------

step "Install a Ghost-CLI production site: MySQL, systemd, nginx and an admin domain"
sudo mkdir -p "$SOURCE"
sudo chown "$(id -u):$(id -g)" "$SOURCE"
sudo chmod 775 "$SOURCE"
SOURCE_INSTALLED=1
ghost_cli install "$GHOST_VERSION" --no-prompt --no-setup-ssl \
    --url "https://$DOMAIN" --admin-url "https://$ADMIN_DOMAIN" \
    --db mysql --dbhost localhost --dbuser root --dbpass "$MYSQL_ROOT_PASSWORD" --dbname ghost_e2e
SOURCE_PORT=$(jq -r .server.port "$SOURCE/config.production.json")
SERVICE=$(systemctl list-unit-files --no-legend 'ghost_*' | awk 'NR == 1 { print $1 }')
[[ -n $SERVICE ]] || fail "Ghost-CLI made no ghost_* systemd service"
source_active || fail "$SERVICE is not running"
nginx_serves_source || fail "nginx does not serve the source on port 80"
ok "Ghost $GHOST_VERSION as $SERVICE on 127.0.0.1:$SOURCE_PORT, behind nginx"

response=$(source_api POST authentication/setup/ \
    --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg t "$TITLE" \
        '{setup: [{name: "Import Tester", email: $e, password: $p, blogTitle: $t}]}')")
jq -e '.users[0].id' <<<"$response" >/dev/null 2>&1 || fail "setting up the source owner failed" "$response"
# The session cookie is Secure, so curl's jar would not send it over plain
# HTTP to Ghost's port; it is passed as a header instead.
cookie=$(source_api POST session/ --dump-header - --output /dev/null \
    --data "$(jq -cn --arg u "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" '{username: $u, password: $p}')" |
    sed -n 's/^[Ss]et-[Cc]ookie: \(ghost-admin-api-session=[^;]*\).*/\1/p')
[[ -n $cookie ]] || fail "signing in to the source failed"
response=$(source_api POST posts/ --header "Cookie: $cookie" \
    --data "$(jq -cn --arg t "Post from $TITLE" '{posts: [{title: $t, status: "published"}]}')")
SLUG=$(jq -er '.posts[0].slug' <<<"$response" 2>/dev/null) || fail "creating a post on the source failed" "$response"

# Content belongs to the `ghost` user Ghost-CLI made.
sudo -u ghost mkdir -p "$SOURCE/content/images/2026/10"
printf 'image of %s' "$TITLE" | sudo -u ghost tee "$SOURCE/content/images/2026/10/marker.png" >/dev/null
# Written in place, keeping the file's owner and mode. In production Ghost
# emails staff a code when they sign in from a new device, and nothing here
# can deliver mail: without a mail service the sign-in fails with a 500. The
# setting is carried like any other, so the Docker site has it too.
jq --arg from "$MAIL_FROM" \
    '.mail = ((.mail // {}) + {from: $from}) | .security = ((.security // {}) + {staffDeviceVerification: false})' \
    "$SOURCE/config.production.json" >"$WORK/config.json"
cat "$WORK/config.json" >"$SOURCE/config.production.json"
ok "an owner, a post, an image, an awkward mail__from, and no device verification"

# --- A forced failure --------------------------------------------------------

step "Imported with nginx still on port 80, it fails and changes nothing"
ghost_cli stop
source_active && fail "$SERVICE is still running after ghost stop"
BUNDLE=$WORK/bundle
ghost_cli migrate-export --force --no-prompt --output "$BUNDLE"
source_active && fail "the export started the stopped source"
[[ $(jq -r '[.sourceInstallType, .kind, .adminUrl] | join(" ")' "$BUNDLE/manifest.json") == "production mysql-dump https://$ADMIN_DOMAIN" ]] ||
    fail "the bundle is not a production mysql-dump with the admin URL" "$(jq . "$BUNDLE/manifest.json")"
ok "stopped, and exported a production mysql-dump bundle without being started"

new_site failed
run_import "$SITE" --import "$BUNDLE"
[[ $RC -eq 1 ]] || fail "the import with nginx on port 80 exited $RC, expected 1" "$OUT"
expect_output ':80.*(address already in use|port is already allocated)'
expect_output 'Nothing that was already running was stopped|is as it was before the import'
# Only the test CA, which was there before, is left.
[[ $(cd "$SITE" && find . -mindepth 1 | sort | tr '\n' ' ') == "./caddy ./caddy/global ./caddy/global/test-ca.caddy " ]] ||
    fail "the failed import left files behind" "$(cd "$SITE" && find . -mindepth 1)"
[[ -z $(docker ps -a --filter "label=com.docker.compose.project.working_dir=$SITE" --format '{{.Names}}') ]] ||
    fail "the failed import left containers behind"
systemctl is-active --quiet nginx || fail "the import stopped nginx"
ok "it named port 80, removed what it created, and left nginx running"

step "The documented recovery brings the source back behind nginx"
sudo systemctl start nginx
ghost_cli start
source_active || fail "$SERVICE did not start"
nginx_serves_source || fail "nginx does not serve the source again"
ok "ghost start: the source answers through nginx, as before"

# --- The move ----------------------------------------------------------------

step "Move the site as docs/install.md describes, on the same server"
ghost_cli stop
# The exporter refuses an existing output, so the final export is a new bundle.
BUNDLE=$WORK/bundle-final
ghost_cli migrate-export --force --no-prompt --output "$BUNDLE"
source_active && fail "the final export started the stopped source"
sudo systemctl stop nginx
new_site moved
run_import "$SITE" --import "$BUNDLE"
[[ $RC -eq 0 ]] || fail "the import exited $RC" "$OUT"
expect_output 'ok +mysql-dump +a production site'
expect_output "https +serving: Ghost answers through Caddy at https://$DOMAIN"
expect_output "admin https +serving: .* at https://${ADMIN_DOMAIN//./\\.}"
expect_output "Sign in to Ghost Admin with the source site's staff accounts"
ok "imported, and verified through Caddy for both domains"

[[ $(setting "$SITE" COMPOSE_PROFILES) == production ]] || fail "COMPOSE_PROFILES is not production"
[[ $(setting "$SITE" URL) == "https://$DOMAIN" ]] || fail "URL is not the source's"
[[ $(setting "$SITE" ADMIN_URL) == "https://$ADMIN_DOMAIN" ]] || fail "ADMIN_URL is not the source's"
[[ $(jq -r .ghost.version "$SITE/.ghost-docker.json") == "$GHOST_VERSION" ]] ||
    fail "the recorded Ghost version is not the source's"
ok "the source's domains and exact Ghost version"

# Staff sign in, through the host's port 443, with the source's password.
jar=$WORK/moved.cookies
[[ $(compose_in "$SITE" exec -T ghost printenv security__staffDeviceVerification) == false ]] ||
    fail "the source's security settings did not reach Ghost"
body=$(site_https "https://$ADMIN_DOMAIN/ghost/api/admin/session/" --write-out '\n%{http_code}' \
    --cookie-jar "$jar" --request POST --header 'Content-Type: application/json' --header "Origin: https://$ADMIN_DOMAIN" \
    --data "$(jq -cn --arg u "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" '{username: $u, password: $p}')")
status=${body##*$'\n'}
[[ $status == 201 ]] ||
    fail "signing in at https://$ADMIN_DOMAIN answered $status" \
        "${body%$'\n'*}"$'\n'"$(compose_in "$SITE" logs --no-color --tail 40 ghost 2>&1)"
body=$(site_https "https://$ADMIN_DOMAIN/ghost/api/admin/posts/?filter=slug:$SLUG&fields=status" \
    --cookie "$jar" --header "Origin: https://$ADMIN_DOMAIN")
[[ $(jq -r '.posts | map(.status) | join(",")' <<<"$body" 2>/dev/null) == published ]] ||
    fail "the post is not in the imported site's Admin API" "$body"
ok "the owner signs in on the admin domain with the source password, and the post is there"

[[ $(site_https "https://$DOMAIN/$SLUG/" --output /dev/null --write-out '%{http_code}') == 200 ]] ||
    fail "the post's page does not render at https://$DOMAIN"
body=$(site_https "https://$DOMAIN/content/images/2026/10/marker.png")
[[ $body == "image of $TITLE" ]] || fail "the image was not served as exported" "$body"
value=$(compose_in "$SITE" exec -T ghost printenv mail__from)
[[ $value == "$MAIL_FROM" ]] || fail "mail__from reached Ghost as: $value"
ok "the post and its image are served on the domain, and the configuration reached Ghost"

set +e
OUT=$("$SITE/ghost-docker" --dir "$SITE" check 2>&1 </dev/null)
RC=$?
set -e
[[ $RC -eq 0 ]] || fail "./ghost-docker check exited $RC" "$OUT"
ok "./ghost-docker check passes"

source_active && fail "the source is running beside the Docker site"
[[ -f $SOURCE/config.production.json && -d $SOURCE/content/themes ]] || fail "the source was changed"
ok "the source is stopped and intact"

passed 'All checks passed.'
