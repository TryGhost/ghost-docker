#!/usr/bin/env bash
# Real backups and restores, against real containers.
#
#   tests/e2e/backup.sh
#
# Builds the manager image from this checkout and installs a local site with
# ActivityPub from it. The site is given an owner, a post, an image, a theme
# of its own, a configuration value and ActivityPub records, then backed up
# consistently (Ghost and ActivityPub stopped for the capture and running
# again after),
# changed, and restored over itself; then taken down and restored into a new
# directory. Each restore is checked the way an operator would: staff sign in
# and the post is there, the image is served, the theme is active, the
# configuration is as it was, and ActivityPub's records hold exactly what was
# backed up. Then the lock refuses a second operation, `check` reports a
# stale lock, a dump that fails is an error, not a backup, and leaves the
# writers running, and a backup by default is live and never stops them.
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
# ActivityPub records of its own tables: a site it serves and a stored
# object. Fresh migrations would recreate the tables, never these rows.
AP_SEED=$(
    cat <<'SQL'
INSERT INTO activitypub.sites (host, webhook_secret, ghost_pro) VALUES ('e2e-seed.example', 'kept-by-the-backup', 0);
INSERT INTO activitypub.key_value (`key`, value) VALUES ('e2e-seed', '{"kept": "by the backup", "n": 1}');
SQL
)
# What the seed reads back as; a restore must give exactly this.
AP_RECORDS=$(
    cat <<'SQL'
SELECT CONCAT_WS('|', host, webhook_secret, ghost_pro) FROM activitypub.sites WHERE host LIKE 'e2e-%' ORDER BY host;
SELECT CONCAT('key_value|', value) FROM activitypub.key_value WHERE `key` = 'e2e-seed';
SQL
)
# After the backup: one record changed, one removed, one added.
AP_CHANGES=$(
    cat <<'SQL'
UPDATE activitypub.sites SET webhook_secret = 'changed-after-the-backup' WHERE host = 'e2e-seed.example';
DELETE FROM activitypub.key_value WHERE `key` = 'e2e-seed';
INSERT INTO activitypub.sites (host, webhook_secret, ghost_pro) VALUES ('e2e-after.example', 'added-after-the-backup', 0);
SQL
)


# What this host cannot run fails the run, unless GD_E2E_ALLOW_SKIP=1.
# shellcheck source=/dev/null
source "$ROOT/tests/e2e/skip.sh"
require_docker
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

# started_at SITE -- when Ghost's and ActivityPub's containers last started.
started_at() {
    compose_in "$1" ps -q ghost activitypub | xargs docker inspect --format '{{.State.StartedAt}}'
}

# writers SITE -- Ghost's and ActivityPub's containers, with their state.
writers() {
    local service
    for service in ghost activitypub; do
        printf '%s %s %s\n' "$service" "$(compose_in "$1" ps --all -q "$service")" \
            "$(compose_in "$1" ps --all --format '{{.State}}' "$service")"
    done
}

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
    body=$(root_sql "$site" "$AP_RECORDS")
    [[ $body == "$AP_EXPECTED" ]] ||
        fail "ActivityPub's records are not as backed up" "$(printf 'expected:\n%s\nfound:\n%s' "$AP_EXPECTED" "$body")"
    compose_in "$site" ps --format '{{.Service}} {{.State}}' | grep -qx 'activitypub running' ||
        fail "ActivityPub is not running" "$(compose_in "$site" ps)"
    ok "ActivityPub's records are exactly as backed up, and ActivityPub runs"
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
root_sql "$A" "$AP_SEED" || fail "seeding ActivityPub's records failed"
AP_EXPECTED=$(root_sql "$A" "$AP_RECORDS")
if ! grep -qx 'e2e-seed.example|kept-by-the-backup|0' <<<"$AP_EXPECTED" ||
    ! grep -q '^key_value|.*"kept": "by the backup"' <<<"$AP_EXPECTED"; then
    fail "ActivityPub's records do not read back as seeded" "$AP_EXPECTED"
fi
ok "post $SLUG, images/2026/10/marker.png, e2e-theme active, $SETTING_KEY, $AP_TABLES ActivityPub tables with records of their own"

# --- Backup --------------------------------------------------------------------

step "Back it up consistently, with Ghost and ActivityPub stopped for the capture"
writers_before=$(writers "$A")
grep -q '^activitypub .* running$' <<<"$writers_before" || fail "ActivityPub is not running before the backup" "$writers_before"
run gd "$A" backup --consistent
expect_status 0
expect_output 'ghost and activitypub stopped, so nothing writes during the capture'
expect_output 'ghost and activitypub running again, and healthy'
expect_output 'ok +checked +ghost: [0-9]+ tables, activitypub: [0-9]+ tables, loaded into a scratch MySQL'
expect_output 'Backed up to '
# Started again, not recreated: the same containers, running.
[[ $(writers "$A") == "$writers_before" ]] ||
    fail "the writers are not as they were before the backup" "$(printf 'before:\n%s\nafter:\n%s' "$writers_before" "$(writers "$A")")"
BACKUP=$(backups_of "$A")
[[ $(wc -l <<<"$BACKUP") -eq 1 && -f $BACKUP/manifest.json ]] || fail "there is not one backup" "$BACKUP"
[[ $(jq -r '.databases | map(.name) | join(",")' "$BACKUP/manifest.json") == ghost,activitypub ]] ||
    fail "the backup does not hold both databases"
[[ $(jq -r .images.ghost "$BACKUP/manifest.json") == "$(setting "$A" .env GHOST_IMAGE_REF)" ]] ||
    fail "the manifest does not name the pinned Ghost image"
mode=$(stat -c '%a' "$BACKUP" 2>/dev/null || stat -f '%Lp' "$BACKUP")
[[ $mode == 700 ]] || fail "the backup is $mode, not private"
[[ ! -e $A/.ghost-docker.lock ]] || fail "the lock was left behind"
[[ $(jq -r .consistency "$BACKUP/manifest.json") == quiesced ]] || fail "the manifest does not record a quiesced backup"
ok "$BACKUP, checked, private, consistent; Ghost and ActivityPub running again in the same containers"

# --- Restore over the site -----------------------------------------------------

step "Change the site, then restore the backup over it"
api "$A" DELETE "posts/$POST_ID/" >/dev/null
# shellcheck disable=SC2016 # expanded by the container's shell
compose_in "$A" exec -T --user ghost ghost sh -c 'rm "$GHOST_CONTENT/images/2026/10/marker.png"'
root_sql "$A" "$AP_CHANGES" || fail "changing ActivityPub's records failed"
[[ $(root_sql "$A" "$AP_RECORDS") != "$AP_EXPECTED" ]] || fail "ActivityPub's records did not change"
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

step "A consistent backup whose dump fails is an error, not a backup, and leaves the writers running"
before=$(backups_of "$B")
writers_before=$(writers "$B")
# A view whose table is gone: mysqldump cannot dump it, and Ghost, which
# never reads it, still starts. Taking a privilege away from Ghost's user
# instead would also stop Ghost starting again after the capture.
root_sql "$B" 'CREATE TABLE ghost.e2e_gone (n INT); CREATE VIEW ghost.e2e_broken AS SELECT n FROM ghost.e2e_gone; DROP TABLE ghost.e2e_gone'
run gd "$B" backup --consistent
root_sql "$B" 'DROP VIEW ghost.e2e_broken'
expect_status 1
expect_output 'the ghost database could not be dumped'
[[ $(backups_of "$B") == "$before" ]] || fail "a failed dump left a backup behind" "$(backups_of "$B")"
find "$B/backups" -maxdepth 1 -name '.*.partial' | grep -q . && fail "a partial backup was left behind"
[[ ! -e $B/.ghost-docker.lock ]] || fail "the lock was left behind"
[[ $(writers "$B") == "$writers_before" ]] ||
    fail "the writers are not as they were before the failed backup" "$(printf 'before:\n%s\nafter:\n%s' "$writers_before" "$(writers "$B")")"
ok "exit 1, nothing left in backups/, and Ghost and ActivityPub running again"

step "A backup is live by default: it never stops the writers, and says what it guarantees"
writers_before=$(writers "$B")
started_before=$(started_at "$B")
run gd "$B" backup
expect_status 0
expect_output 'captured at different moments'
LIVE=$(backups_of "$B" | tail -n 1)
[[ $(jq -r .consistency "$LIVE/manifest.json") == live ]] || fail "the manifest does not record a live backup"
[[ $(writers "$B") == "$writers_before" ]] || fail "a live backup changed the writers"
[[ $(started_at "$B") == "$started_before" ]] ||
    fail "a live backup restarted Ghost or ActivityPub"
ok "$LIVE, recorded as live; Ghost and ActivityPub never restarted"

passed 'All backup and restore checks passed.'
