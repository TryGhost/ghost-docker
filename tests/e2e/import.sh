#!/usr/bin/env bash
# Real imports of real bundles.
#
#   tests/e2e/import.sh
#
# The source sites are installed with Ghost-CLI and exported with the released
# `ghost migrate-export`, so what is imported here is byte for byte what an
# operator would have: a local SQLite site (a `mysql-data` bundle) and a local
# MySQL site (a `mysql-dump` bundle). Nothing is hand-written except the
# deliberately broken copies. Every import runs through the launcher and the
# manager image built from this checkout, into an empty directory, as an
# operator without a checkout would run it.
#
# This installs Ghost twice on the host and starts several containers; it
# takes several minutes. It needs Docker, Node (for Ghost-CLI), jq and curl,
# and for the MySQL source a `mysqldump` on the PATH; that half is skipped
# without one.
#
#   GD_TEST_GHOST_CLI   the exporter to use. Default: npx --yes ghost-cli@1.33.0
#   GD_TEST_KEEP=1      leave the work directory and sites in place afterwards
#
# Exits non-zero at the first check that fails, naming it.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
IMAGE=ghost-docker:e2e
DEFAULT_GHOST=ghost:6-next-alpine

if ! docker info >/dev/null 2>&1; then
    printf 'skipped: no Docker daemon answers here\n'
    exit 0
fi

read -ra GHOST_CLI <<<"${GD_TEST_GHOST_CLI:-npx --yes ghost-cli@1.33.0}"
readonly SOURCE_DB_CONTAINER="ghost-docker-test-import-source-db"
readonly SQLITE_PORT=23711
readonly MYSQL_SITE_PORT=23712
readonly SOURCE_DB_PORT=33711
# Each destination gets its own loopback port from here up.
NEXT_PORT=23720

readonly OWNER_EMAIL="owner@example.com"
readonly OWNER_PASSWORD="Sup3r-secret-pass!"
# Dollar signs and both kinds of quote: the value that dotenv encoding gets wrong.
readonly MAIL_FROM="'Import \$Test \"quoted\"' <noreply@example.com>"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ghost-docker-import-e2e.XXXXXXXX")
WORK=$(CDPATH='' cd -- "$WORK" && pwd -P)
SOURCES=()
DESTINATIONS=()
CURRENT="setup"
OUT=""
RC=0
site=""
port=""

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

# --- Cleanup -----------------------------------------------------------------

# Every destination is taken down and its data removed as root, because the
# database and content belong to the containers' users once they have run.
cleanup() {
    local rc=$? site
    trap - EXIT
    set +e
    if [[ ${GD_TEST_KEEP:-0} == 1 ]]; then
        printf '\nGD_TEST_KEEP is set; everything was left in %s\n' "$WORK" >&2
        exit "$rc"
    fi
    printf '\nCleaning up\n'
    for site in ${DESTINATIONS[@]+"${DESTINATIONS[@]}"}; do
        [[ -f $site/compose.yml ]] &&
            COMPOSE_PROFILES=local compose_in "$site" down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1
    done
    for site in ${SOURCES[@]+"${SOURCES[@]}"}; do
        (cd "$site" && "${GHOST_CLI[@]}" uninstall --no-prompt --force >/dev/null 2>&1)
    done
    docker rm -f "$SOURCE_DB_CONTAINER" >/dev/null 2>&1
    docker run --rm --user 0 --entrypoint rm -v "$WORK:/work" "$IMAGE" -rf /work/sites >/dev/null 2>&1
    case $WORK in
        */ghost-docker-import-e2e.*) rm -rf -- "$WORK" ;;
    esac
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# destination NAME
# Sets `site` to a fresh, empty directory and `port` to its own loopback port.
# Not called in a subshell: it has to record the site for cleanup.
destination() {
    site=$WORK/sites/$1
    mkdir -p "$site"
    DESTINATIONS+=("$site")
    port=$NEXT_PORT
    NEXT_PORT=$((NEXT_PORT + 1))
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

expect_success() {
    [[ $RC -eq 0 ]] || fail "$1 exited $RC" "$OUT"
}

expect_failure() {
    [[ $RC -eq 1 ]] || fail "$1 exited $RC, expected 1" "$OUT"
}

expect_output() {
    grep -qE -- "$1" <<<"$OUT" || fail "the output does not match: $1" "$OUT"
}

# containers_of SITE [docker ps options] -> names of the site's containers.
# SITE is the resolved path: Compose labels the project with it.
containers_of() {
    local site=$1
    shift
    docker ps "$@" --filter "label=com.docker.compose.project.working_dir=$site" --format '{{.Names}}'
}

# expect_untouched SITE
# A failed import must leave the directory as it found it: empty.
expect_untouched() {
    local site=$1
    [[ -z $(ls -A "$site") ]] || fail "the failed import left files behind" "$(ls -A "$site")"
    [[ -z $(containers_of "$site" -a) ]] || fail "the failed import left containers behind"
    ok "the directory is as it was"
}

# tree_digest DIR -> one digest of every file under it
tree_digest() {
    (cd "$1" && find . -type f -exec cksum {} + | sort -k3 | cksum)
}

# http_status URL [curl options]
http_status() {
    local url=$1
    shift
    curl --disable --silent --noproxy '*' --max-time 30 --output /dev/null --write-out '%{http_code}' "$@" "$url"
}

# sign_in BASE ORIGIN JAR
# Signs in with the owner's password and stores the session in JAR.
sign_in() {
    local base=$1 origin=$2 jar=$3 status
    status=$(http_status "$base/ghost/api/admin/session/" --cookie-jar "$jar" --request POST \
        --header 'Content-Type: application/json' --header "Origin: $origin" \
        --data "$(jq -cn --arg u "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" '{username: $u, password: $p}')")
    [[ $status == 201 ]] || fail "signing in at $base answered $status"
}

# make_source NAME PORT TITLE [ghost install options...]
# Installs a local Ghost-CLI site and gives it an owner, a post, an image and
# an awkward configuration value. Sets SOURCE_DIR, SOURCE_BASE and SOURCE_SLUG.
make_source() {
    local name=$1 port=$2 title=$3 url jar response
    shift 3
    SOURCE_DIR=$WORK/$name
    SOURCE_BASE="http://127.0.0.1:$port"
    url="http://localhost:$port"
    jar=$WORK/$name.cookies
    mkdir "$SOURCE_DIR"

    (cd "$SOURCE_DIR" && "${GHOST_CLI[@]}" install "$GHOST_VERSION" --local --no-prompt \
        --port "$port" --url "$url" "$@") >"$WORK/$name.install.log" 2>&1 ||
        fail "ghost install failed" "$(tail -40 "$WORK/$name.install.log")"
    SOURCES+=("$SOURCE_DIR")

    response=$(curl --disable --silent --noproxy '*' --max-time 60 --request POST \
        --header 'Content-Type: application/json' --header "Origin: $url" \
        --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg t "$title" \
            '{setup: [{name: "Import Tester", email: $e, password: $p, blogTitle: $t}]}')" \
        "$SOURCE_BASE/ghost/api/admin/authentication/setup/")
    jq -e '.users[0].id' <<<"$response" >/dev/null 2>&1 || fail "setting up the source owner failed" "$response"

    sign_in "$SOURCE_BASE" "$url" "$jar"
    response=$(curl --disable --silent --noproxy '*' --max-time 60 --cookie "$jar" --request POST \
        --header 'Content-Type: application/json' --header "Origin: $url" \
        --data "$(jq -cn --arg t "Post from $title" '{posts: [{title: $t, status: "published"}]}')" \
        "$SOURCE_BASE/ghost/api/admin/posts/")
    SOURCE_SLUG=$(jq -er '.posts[0].slug' <<<"$response" 2>/dev/null) || fail "creating a post on the source failed" "$response"

    mkdir -p "$SOURCE_DIR/content/images/2026/10"
    printf 'image of %s' "$title" >"$SOURCE_DIR/content/images/2026/10/marker.png"
    printf 'dotfile' >"$SOURCE_DIR/content/images/.hidden-marker"

    jq --arg from "$MAIL_FROM" '.mail = ((.mail // {}) + {from: $from})' \
        "$SOURCE_DIR/config.development.json" >"$SOURCE_DIR/config.tmp"
    mv "$SOURCE_DIR/config.tmp" "$SOURCE_DIR/config.development.json"
    ok "source site at $url, Ghost $GHOST_VERSION"
}

# export_source OUTPUT [migrate-export options...]
export_source() {
    local output=$1
    shift
    (cd "$SOURCE_DIR" && "${GHOST_CLI[@]}" migrate-export --force --no-prompt --output "$output" "$@") \
        >"$output.export.log" 2>&1 || fail "ghost migrate-export failed" "$(tail -40 "$output.export.log")"
}

# expect_imported SITE SLUG TITLE
# Everything that must be true of a running site imported from a source.
expect_imported() {
    local site=$1 slug=$2 title=$3 port base jar body value
    port=$(setting "$site" GHOST_PORT)
    base="http://localhost:$port"
    jar=$site.cookies

    [[ $(setting "$site" COMPOSE_PROFILES) == local ]] || fail "COMPOSE_PROFILES is not local"
    [[ ! -e $site/.ghost-docker-import ]] || fail "the import marker was left behind"
    [[ ! -e $site/.import ]] || fail "the staging directory was left behind"
    [[ $(jq -r .ghost.version "$site/.ghost-docker.json") == "$GHOST_VERSION" ]] ||
        fail "the recorded Ghost version is not the source's"
    ok "configuration and metadata"

    # Staff sign in with the password they had on the source site.
    sign_in "$base" "$base" "$jar"
    body=$(curl --disable --silent --noproxy '*' --max-time 30 --cookie "$jar" --header "Origin: $base" \
        "$base/ghost/api/admin/posts/?filter=slug:$slug&fields=status")
    [[ $(jq -r '.posts | map(.status) | join(",")' <<<"$body" 2>/dev/null) == published ]] ||
        fail "the post is not in the imported site's Admin API" "$body"
    ok "the owner signs in with the source password, and the post is there"

    [[ $(http_status "$base/$slug/") == 200 ]] || fail "the post's page does not render"
    body=$(curl --disable --silent --noproxy '*' --max-time 30 "$base/content/images/2026/10/marker.png")
    [[ $body == "image of $title" ]] || fail "the image was not served as exported" "$body"
    compose_in "$site" exec -T ghost test -f /home/ghost/content/images/.hidden-marker ||
        fail "a dotfile did not travel"
    ok "the post renders and its assets are served"

    # The raw configuration value, as the Ghost process itself receives it.
    value=$(compose_in "$site" exec -T ghost printenv mail__from)
    [[ $value == "$MAIL_FROM" ]] || fail "mail__from reached Ghost as: $value"
    ok "configuration reaches Ghost byte for byte"

    set +e
    OUT=$("$site/ghost-docker" --dir "$site" check 2>&1 </dev/null)
    RC=$?
    set -e
    expect_success "./ghost-docker check"
    ok "./ghost-docker check passes"
}

# break_database BUNDLE_DIR
# Appends a statement that cannot succeed, after the bundle's own transaction.
break_database() {
    # shellcheck disable=SC2016  # SQL identifier quoting
    printf '\nINSERT INTO `no_such_table` VALUES (1);\n' >>"$1/database.sql"
}

# --- Setup -------------------------------------------------------------------

step "Preparing"
for tool in docker jq curl tar node; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"
done
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
ok "working in $WORK, Ghost $GHOST_VERSION, exporter: ${GHOST_CLI[*]}"

# --- A local SQLite site -----------------------------------------------------

step "Install and export a local SQLite site"
make_source source-sqlite "$SQLITE_PORT" "SQLite source"
SQLITE_BASE=$SOURCE_BASE
SQLITE_SLUG=$SOURCE_SLUG
export_source "$WORK/bundle-sqlite" --archive tgz
ARCHIVE=$WORK/bundle-sqlite.tgz
UNPACKED=$WORK/bundle-sqlite-dir
mkdir "$UNPACKED"
tar -xzf "$ARCHIVE" -C "$UNPACKED"
[[ $(jq -r .kind "$UNPACKED/manifest.json") == mysql-data ]] || fail "the exporter did not produce a mysql-data bundle"
[[ $(jq -r .config.mail__from "$UNPACKED/manifest.json") == "$MAIL_FROM" ]] || fail "mail__from is not in the manifest as configured"
ok "a mysql-data bundle, as an archive and unpacked"

step "Import the archive"
destination from-archive
before=$(cksum <"$ARCHIVE")
run_import "$site" --import "$ARCHIVE" --port "$port"
expect_success "the import"
expect_output 'every count matches the bundle'
expect_output 'Ghost is installed'
expect_imported "$site" "$SQLITE_SLUG" "SQLite source"
[[ $(http_status "$SQLITE_BASE/ghost/api/admin/site/") == 200 ]] || fail "the source site is no longer running"
[[ $(cksum <"$ARCHIVE") == "$before" ]] || fail "the archive was modified"
ok "the source is still running and the archive is unchanged"
COMPOSE_PROFILES=local compose_in "$site" down >/dev/null 2>&1

step "A database that will not load leaves nothing behind"
broken=$WORK/bundle-broken-sql
cp -R "$UNPACKED" "$broken"
break_database "$broken"
destination retried
run_import "$site" --import "$broken" --port "$port"
expect_failure "the import of a broken bundle"
expect_output 'no_such_table'
expect_output 'could not be loaded'
expect_output 'as it was before the import'
expect_untouched "$site"

step "The same directory then imports the good bundle, as a directory, with --no-start"
before=$(tree_digest "$UNPACKED")
run_import "$site" --import "$UNPACKED" --port "$port" --no-start
expect_success "the import"
expect_output 'Nothing is running'
[[ -z $(containers_of "$site" -a) ]] || fail "--no-start left containers behind"
[[ $(tree_digest "$UNPACKED") == "$before" ]] || fail "the bundle directory was modified"
ok "nothing is running and the bundle directory is unchanged"
compose_in "$site" up --detach --wait --wait-timeout 600 >/dev/null 2>&1 || fail "the imported site did not start"
expect_imported "$site" "$SQLITE_SLUG" "SQLite source"
compose_in "$site" down >/dev/null 2>&1

step "Row counts that disagree with the bundle fail the import"
tampered=$WORK/bundle-tampered-rows
cp -R "$UNPACKED" "$tampered"
jq '.database.rows.posts += 1' "$UNPACKED/manifest.json" >"$tampered/manifest.json"
destination tampered
run_import "$site" --import "$tampered" --port "$port"
expect_failure "the import of a bundle with wrong row counts"
expect_output 'posts: the bundle records [0-9]+ rows, the database has [0-9]+'
expect_untouched "$site"

step "A failed import that is kept cannot be started, and the next import clears it"
broken=$WORK/bundle-broken-kept
cp -R "$UNPACKED" "$broken"
break_database "$broken"
destination kept
GD_IMPORT_KEEP_FAILED=1 run_import "$site" --import "$broken" --port "$port"
expect_failure "the import of a broken bundle"
expect_output 'kept for inspection'
[[ -e $site/.ghost-docker-import ]] || fail "the kept import is not marked"
[[ $(setting "$site" COMPOSE_PROFILES) == import-incomplete ]] || fail ".env still selects services"
ok "the kept import is marked incomplete"

[[ -z $(containers_of "$site") ]] || fail "the kept import was left running"

# Plain Compose selects no service in this state.
compose_in "$site" up --detach >/dev/null 2>&1 || true
[[ -z $(containers_of "$site") ]] || fail "a partial site was started"
ok "docker compose up starts nothing"

run_import "$site" --local --port "$port"
expect_failure "an ordinary install over an unfinished import"
expect_output 'did not finish'

run_import "$site" --import "$ARCHIVE" --port "$port"
expect_success "the import"
expect_output 'Removing what an earlier, unfinished import left behind'
expect_imported "$site" "$SQLITE_SLUG" "SQLite source"
compose_in "$site" down >/dev/null 2>&1

# --- A local MySQL site ------------------------------------------------------

if ! command -v mysqldump >/dev/null 2>&1; then
    step "A local MySQL site"
    printf '   SKIPPED: there is no mysqldump on this host for the exporter to run\n'
    printf '\nAll checks passed (MySQL source skipped).\n'
    exit 0
fi

step "Install and export a local MySQL site"
# The same server version the destination runs.
mysql_image=$(sed -n 's/^ *image: \(mysql:[^ ]*\).*/\1/p' "$ROOT/compose.yml" | head -1)
docker run --detach --name "$SOURCE_DB_CONTAINER" \
    --env MYSQL_ROOT_PASSWORD=source-root --env MYSQL_DATABASE=ghost_source \
    --publish "127.0.0.1:$SOURCE_DB_PORT:3306" "$mysql_image" >/dev/null
attempts=0
until docker exec "$SOURCE_DB_CONTAINER" mysql -h 127.0.0.1 -uroot -psource-root -e 'SELECT 1' ghost_source >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    ((attempts < 90)) || fail "the source database did not become ready"
    sleep 2
done
make_source source-mysql "$MYSQL_SITE_PORT" "MySQL source" \
    --db mysql --dbhost 127.0.0.1 --dbport "$SOURCE_DB_PORT" --dbuser root --dbpass source-root --dbname ghost_source
MYSQL_SLUG=$SOURCE_SLUG
BUNDLE=$WORK/bundle-mysql
export_source "$BUNDLE"
[[ $(jq -r .kind "$BUNDLE/manifest.json") == mysql-dump ]] || fail "the exporter did not produce a mysql-dump bundle"
# The reason the load rewrites DEFINER clauses: without that, this dump cannot
# be loaded by the site's unprivileged database user.
# shellcheck disable=SC2016  # SQL identifier quoting
grep -q 'DEFINER=`root`@' "$BUNDLE/database.sql" || fail "the dump defines no object as another account; the DEFINER handling is untested"
ok "a mysql-dump bundle that defines objects as the source's root"

step "Import the directory bundle"
destination from-mysql
run_import "$site" --import "$BUNDLE" --port "$port"
expect_success "the import"
expect_output 'the database has a Ghost migration history'
expect_imported "$site" "$MYSQL_SLUG" "MySQL source"

# Views belong to the site's own database user, not the source's root.
# shellcheck disable=SC2016  # expanded by the container's shell
definers=$(compose_in "$site" exec -T db sh -c \
    'MYSQL_PWD="$MYSQL_PASSWORD" mysql -N -u"$MYSQL_USER" "$MYSQL_DATABASE" -e "SELECT DISTINCT definer FROM information_schema.views WHERE table_schema = DATABASE()"')
[[ -n $definers ]] || fail "the imported database has no views to check"
if grep -qv '^ghost@' <<<"$definers"; then
    fail "a view is defined by an account other than the site's" "$definers"
fi
ok "views belong to the site's database user"

printf '\nAll checks passed.\n'
