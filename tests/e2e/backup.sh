#!/usr/bin/env bash
# Real backups and restores, against real containers.
#
#   tests/e2e/backup.sh
#
# Builds the manager image from this checkout and installs a local site with
# ActivityPub from it. The site is given an owner, a post, an image, a theme
# of its own and a configuration value, then backed up, changed, and restored
# over itself; then taken down and restored into a new directory. Each restore
# is checked the way an operator would: staff sign in and the post is there,
# the image is served, the theme is active and the configuration is as it was.
# Then the lock refuses a second operation, `check` reports a stale lock, and
# a dump that fails is an error, not a backup.
#
# It pulls images, starts containers and binds a loopback port. It needs jq
# and curl. Exits non-zero at the first check that fails, naming it.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
IMAGE=ghost-docker:e2e-backup
OWNER_EMAIL=owner@example.com
OWNER_PASSWORD='Kept-in-a-backup-2026!'
# A setting of the site's own, with dollar signs and both kinds of quote: what
# dotenv encoding gets wrong. Ghost ignores a key it does not know.
SETTING_KEY=backupE2e__marker
SETTING="Kept \$by 'the' \"backup\""


if ! docker info >/dev/null 2>&1; then
    printf 'skipped: no Docker daemon answers here\n'
    exit 0
fi
for tool in jq curl; do
    command -v "$tool" >/dev/null || {
        printf 'backup.sh needs %s\n' "$tool" >&2
        exit 1
    }
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ghost-docker-backup-e2e.XXXXXXXX")
WORK=$(CDPATH='' cd -- "$WORK" && pwd -P)
CURRENT=setup
OUT=""
RC=0
SITES=()

# Every site is taken down and its data removed as root, because MySQL's data
# directory belongs to MySQL's user once it has run.
cleanup() {
    local rc=$? site
    set +e
    [[ -z ${HOLDER:-} ]] || kill "$HOLDER" 2>/dev/null
    for site in ${SITES[@]+"${SITES[@]}"}; do
        [[ -f $site/.env ]] && docker compose --project-directory "$site" -f "$site/compose.yml" \
            down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1
    done
    docker run --rm --user 0 --entrypoint rm -v "$WORK:/work" "$IMAGE" -rf /work/sites >/dev/null 2>&1
    case $WORK in */ghost-docker-backup-e2e.*) rm -rf -- "$WORK" ;; esac
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

# run COMMAND... -> sets OUT (stdout and stderr) and RC, never exits
run() {
    set +e
    OUT=$("$@" 2>&1 </dev/null)
    RC=$?
    set -e
}
expect_status() { [[ $RC -eq $1 ]] || fail "exited $RC, expected $1" "$OUT"; }
expect_output() { grep -qE -- "$1" <<<"$OUT" || fail "the output does not match: $1" "$OUT"; }

# compose_in SITE ARGS... -- Compose as an operator runs it, from the host.
compose_in() {
    local site=$1
    shift
    docker compose --project-directory "$site" -f "$site/compose.yml" "$@"
}

# gd SITE ARGS... -- the site's own launcher, on the image built here.
gd() { GD_IMAGE=$IMAGE "$A/ghost-docker" --dir "$@"; }

# setting SITE FILE KEY -- one decoded value, through the manager.
setting() { gd "$1" config get "$2" "$3" 2>/dev/null; }

# root_sql SITE SQL -- as MySQL's root, in the site's database container.
root_sql() {
    compose_in "$1" exec -T -e MYSQL_PWD="$(setting "$1" .env DATABASE_ROOT_PASSWORD)" db \
        mysql -uroot -N -B -e "$2"
}

new_site() {
    SITE=$WORK/sites/$1
    mkdir -p "$SITE"
    SITES+=("$SITE")
}

backups_of() { find "$1/backups" -mindepth 1 -maxdepth 1 2>/dev/null | sort; }

# api SITE METHOD PATH [curl options] -- the Admin API, signed in.
api() {
    local site=$1 method=$2 path=$3 base
    shift 3
    base=$(base_of "$site")
    curl --disable --silent --noproxy '*' --max-time 60 --cookie "$site.cookies" \
        --header "Origin: $base" --request "$method" "$@" "$base/ghost/api/admin/$path"
}

base_of() { printf 'http://localhost:%s' "$(setting "$1" .env GHOST_PORT)"; }

# sign_in SITE -- with the owner's password; the session goes in SITE.cookies.
sign_in() {
    local base status
    base=$(base_of "$1")
    status=$(curl --disable --silent --noproxy '*' --max-time 30 --output "$1.session" --write-out '%{http_code}' \
        --cookie-jar "$1.cookies" --request POST --header 'Content-Type: application/json' \
        --header "Origin: $base" \
        --data "$(jq -cn --arg u "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" '{username: $u, password: $p}')" \
        "$base/ghost/api/admin/session/")
    [[ $status == 201 ]] || fail "signing in at $base answered $status" "$(cat "$1.session")"
}

# expect_restored SITE -- everything the backup held, on a running site.
expect_restored() {
    local site=$1 base body
    base=$(base_of "$site")
    [[ ! -e $site/.ghost-docker-restore ]] || fail "the site set aside was left behind"
    [[ ! -e $site/.ghost-docker.lock ]] || fail "the lock was left behind"
    [[ $(setting "$site" .env PROJECT_DIR) == "$site" ]] || fail "PROJECT_DIR is not $site"
    [[ $(jq -r .site.dir "$site/.ghost-docker.json") == "$site" ]] || fail "the metadata's directory is not $site"

    sign_in "$site"
    body=$(api "$site" GET "posts/?filter=slug:$SLUG&fields=status")
    [[ $(jq -r '.posts | map(.status) | join(",")' <<<"$body" 2>/dev/null) == published ]] ||
        fail "the post is not in the restored site" "$body"
    ok "the owner signs in, and the post is there"

    body=$(curl --disable --silent --noproxy '*' --max-time 30 "$base/content/images/2026/10/marker.png")
    [[ $body == 'backed-up image' ]] || fail "the image was not served as backed up" "$body"
    ok "the image is served"

    body=$(api "$site" GET 'themes/')
    [[ $(jq -r '.themes[] | select(.active) | .name' <<<"$body" 2>/dev/null) == e2e-theme ]] ||
        fail "e2e-theme is not the active theme" "$body"
    ok "the site's own theme is active"

    [[ $(setting "$site" ghost.env "$SETTING_KEY") == "$SETTING" ]] || fail "ghost.env lost $SETTING_KEY"
    [[ $(compose_in "$site" exec -T ghost printenv "$SETTING_KEY") == "$SETTING" ]] ||
        fail "Ghost does not see $SETTING_KEY as it was"
    ok "the configuration is as it was, and Ghost runs with it"

    [[ $(root_sql "$site" "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'activitypub'") == "$AP_TABLES" ]] ||
        fail "the activitypub database does not have its $AP_TABLES tables"
    compose_in "$site" ps --format '{{.Service}} {{.State}}' | grep -qx 'activitypub running' ||
        fail "ActivityPub is not running" "$(compose_in "$site" ps)"
    ok "ActivityPub's database is back, and ActivityPub runs"
}

printf 'Docker: %s on %s\n' "$(docker info --format '{{.OperatingSystem}}')" "$(uname -s)"

# --- A site worth backing up -------------------------------------------------

step "Build the manager image, and install a local site with ActivityPub"
run docker build --quiet --file "$ROOT/manager/Dockerfile" --tag "$IMAGE" "$ROOT"
expect_status 0
mkdir -p "$WORK/launcher-only" "$WORK/sites"
cp "$ROOT/ghost-docker" "$WORK/launcher-only/ghost-docker"
new_site e2e-backup-a
A=$SITE
run env GD_IMAGE=$IMAGE "$WORK/launcher-only/ghost-docker" --dir "$A" install --local --with activitypub
expect_status 0
ok "$A"

step "Give it an owner, a post, an image, a theme and a setting"
BASE=$(base_of "$A")
body=$(curl --disable --silent --noproxy '*' --max-time 60 --request POST \
    --header 'Content-Type: application/json' --header "Origin: $BASE" \
    --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" \
        '{setup: [{name: "Backup Tester", email: $e, password: $p, blogTitle: "Backup e2e"}]}')" \
    "$BASE/ghost/api/admin/authentication/setup/")
jq -e '.users[0].id' <<<"$body" >/dev/null 2>&1 || fail "setting up the owner failed" "$body"
sign_in "$A"
body=$(api "$A" POST posts/ --header 'Content-Type: application/json' \
    --data '{"posts": [{"title": "Kept by the backup", "status": "published"}]}')
SLUG=$(jq -er '.posts[0].slug' <<<"$body" 2>/dev/null) || fail "creating a post failed" "$body"
POST_ID=$(jq -er '.posts[0].id' <<<"$body")
# Written by Ghost's own user, as Ghost writes its content.
# shellcheck disable=SC2016 # expanded by the container's shell
compose_in "$A" exec -T --user ghost ghost sh -c \
    'mkdir -p "$GHOST_CONTENT/images/2026/10" && printf "backed-up image" >"$GHOST_CONTENT/images/2026/10/marker.png" &&
     cp -r "$GHOST_CONTENT/themes/casper" "$GHOST_CONTENT/themes/e2e-theme"' ||
    fail "writing the image and the theme failed"
run gd "$A" config set ghost.env "$SETTING_KEY" "$SETTING"
expect_status 0
# Signing in again from a new session would otherwise ask for a code by email,
# and this site sends no mail.
run gd "$A" config set ghost.env security__staffDeviceVerification false
expect_status 0
# Ghost reads its themes, and its environment, when it starts.
compose_in "$A" up --detach --wait ghost >/dev/null 2>&1 || fail "Ghost did not start again"
sign_in "$A"
body=$(api "$A" PUT 'themes/e2e-theme/activate/')
[[ $(jq -r '.themes[0].active' <<<"$body" 2>/dev/null) == true ]] || fail "activating e2e-theme failed" "$body"
AP_TABLES=$(root_sql "$A" "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'activitypub'")
[[ $AP_TABLES -gt 0 ]] || fail "ActivityPub's migrations created no tables"
ok "post $SLUG, images/2026/10/marker.png, e2e-theme active, $SETTING_KEY, $AP_TABLES ActivityPub tables"

# --- Backup --------------------------------------------------------------------

step "Back it up"
run gd "$A" backup
expect_status 0
expect_output 'ok +checked +ghost: [0-9]+ tables, activitypub: [0-9]+ tables, loaded into a scratch MySQL'
expect_output 'Backed up to '
BACKUP=$(backups_of "$A")
[[ $(wc -l <<<"$BACKUP") -eq 1 && -f $BACKUP/manifest.json ]] || fail "there is not one backup" "$BACKUP"
[[ $(jq -r '.databases | map(.name) | join(",")' "$BACKUP/manifest.json") == ghost,activitypub ]] ||
    fail "the backup does not hold both databases"
[[ $(jq -r .images.ghost "$BACKUP/manifest.json") == "$(setting "$A" .env GHOST_IMAGE_REF)" ]] ||
    fail "the manifest does not name the pinned Ghost image"
mode=$(stat -c '%a' "$BACKUP" 2>/dev/null || stat -f '%Lp' "$BACKUP")
[[ $mode == 700 ]] || fail "the backup is $mode, not private"
[[ ! -e $A/.ghost-docker.lock ]] || fail "the lock was left behind"
ok "$BACKUP, checked, private"

# --- Restore over the site -----------------------------------------------------

step "Change the site, then restore the backup over it"
api "$A" DELETE "posts/$POST_ID/" >/dev/null
# shellcheck disable=SC2016 # expanded by the container's shell
compose_in "$A" exec -T --user ghost ghost sh -c 'rm "$GHOST_CONTENT/images/2026/10/marker.png"'
run gd "$A" config set ghost.env "$SETTING_KEY" changed
expect_status 0
run gd "$A" restore "$BACKUP"
expect_status 2
expect_output 'Run it again with --yes'
run gd "$A" restore --yes "$BACKUP"
expect_status 0
expect_output 'Restored http://localhost:[0-9]+ from '
expect_restored "$A"

# --- Restore into a new directory ------------------------------------------------

step "Take the site down, and restore its backup into a new directory"
compose_in "$A" down >/dev/null 2>&1
new_site e2e-backup-b
B=$SITE
# The backup is outside B, so the launcher mounts it read-only.
run gd "$B" restore "$BACKUP"
expect_status 0
expect_output "Restored http://localhost:[0-9]+ from .*, into $B"
cmp -s "$A/compose.yml" "$B/compose.yml" || fail "the stack files were not restored"
expect_restored "$B"

# --- The lock ------------------------------------------------------------------

step "A second operation is refused while one holds the lock"
GD_IMAGE=$IMAGE "$A/ghost-docker" --dir "$B" backup >"$WORK/held.log" 2>&1 </dev/null &
HOLDER=$!
for _ in $(seq 1 60); do
    [[ -e $B/.ghost-docker.lock ]] && break
    sleep 0.5
done
[[ -e $B/.ghost-docker.lock ]] || fail "the backup never took the lock" "$(cat "$WORK/held.log")"
run gd "$B" restore --yes "$BACKUP"
expect_status 1
expect_output 'is held by backup, started'
expect_output 'Nothing has been changed'
wait "$HOLDER" || fail "the backup holding the lock failed" "$(cat "$WORK/held.log")"
HOLDER=""
ok "refused, naming the backup that holds it; that backup finished"

printf '{"operation":"restore from %s","startedAt":"2026-10-09T10:00:00Z"}\n' "${BACKUP##*/}" >"$B/.ghost-docker.lock"
run gd "$B" check
expect_status 1
expect_output 'lock +\.ghost-docker\.lock is held by restore from .*, started 2026-10-09T10:00:00Z'
expect_output 'rm .*\.ghost-docker\.lock'
rm "$B/.ghost-docker.lock"
ok "check reports a stale lock and how to remove it"

# --- A dump that fails -----------------------------------------------------------

step "A dump that fails is an error, not a backup"
before=$(backups_of "$B")
root_sql "$B" "REVOKE SELECT ON \`ghost\`.* FROM 'ghost'@'%'"
run gd "$B" backup
root_sql "$B" "GRANT SELECT ON \`ghost\`.* TO 'ghost'@'%'"
expect_status 1
expect_output 'the ghost database could not be dumped'
[[ $(backups_of "$B") == "$before" ]] || fail "a failed dump left a backup behind" "$(backups_of "$B")"
find "$B/backups" -maxdepth 1 -name '.*.partial' | grep -q . && fail "a partial backup was left behind"
[[ ! -e $B/.ghost-docker.lock ]] || fail "the lock was left behind"
ok "exit 1, and nothing left in backups/"

printf '\nAll backup and restore checks passed.\n'
