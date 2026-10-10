#!/usr/bin/env bash
# Real Ghost updates, against real containers and Ghost's own migrations.
#
#   tests/e2e/ghost-update.sh
#
# A local site is installed on Ghost 6.61.0, the oldest `next` image, and
# given an owner, a post and an image. An override whose health check passes
# only for 6.61.0 makes the newest Ghost 6 start, migrate the database, and
# never become healthy: the update stops for the operator, leaving the
# migrated data and the new pin, and the backup it names puts 6.61.0 back.
# Without the override the update succeeds across those migrations, keeping
# the post, the image and the owner's sign-in. Going back down is refused.
#
# It pulls images, starts containers and binds a loopback port. Exits non-zero
# at the first check that fails, naming it.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
MANAGER=ghost-docker:e2e-ghost-update
FROM=6.61.0

# What this host cannot run fails the run, unless GD_E2E_ALLOW_SKIP=1.
# shellcheck source=/dev/null
source "$ROOT/tests/e2e/skip.sh"
require_docker
for tool in jq curl; do
    command -v "$tool" >/dev/null || {
        printf 'ghost-update.sh needs %s\n' "$tool" >&2
        exit 1
    }
done

OWNER_EMAIL=owner@example.com
OWNER_PASSWORD='Kept-through-a-Ghost-update-2026!'

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ghost-docker-ghost-update-e2e.XXXXXXXX")
WORK=$(CDPATH='' cd -- "$WORK" && pwd -P)
S=$WORK/site
CURRENT=setup
OUT=""
RC=0

cleanup() {
    local rc=$?
    set +e
    [[ -f $S/.env ]] && docker compose --project-directory "$S" -f "$S/compose.yml" \
        down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1
    docker run --rm --user 0 --entrypoint rm -v "$WORK:/work" "$MANAGER" -rf /work/site >/dev/null 2>&1
    docker rmi "$MANAGER" >/dev/null 2>&1
    case $WORK in */ghost-docker-ghost-update-e2e.*) rm -rf -- "$WORK" ;; esac
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
setting() { "$S/ghost-docker" --dir "$S" config get "$1" 2>/dev/null; }
records() { grep -q "\"$1\": \"$2\"" "$S/.ghost-docker.json"; }
ghost_version() { compose_in exec -T ghost printenv GHOST_VERSION; }
root_sql() {
    compose_in exec -T -e MYSQL_PWD="$(setting DATABASE_ROOT_PASSWORD)" db \
        mysql -uroot -N -B "$(setting DATABASE_NAME || printf ghost)" -e "$1"
}
migrations() { root_sql 'SELECT COUNT(*) FROM migrations'; }
base() { printf 'http://localhost:%s' "$(setting GHOST_PORT)"; }
api() {
    local method=$1 path=$2
    shift 2
    curl --disable --silent --noproxy '*' --max-time 30 --cookie "$WORK/cookies" \
        --header "Origin: $(base)" --request "$method" "$@" "$(base)/ghost/api/admin/$path"
}
sign_in() {
    local status
    status=$(curl --disable --silent --noproxy '*' --max-time 30 --output "$WORK/session" --write-out '%{http_code}' \
        --cookie-jar "$WORK/cookies" --request POST --header 'Content-Type: application/json' \
        --header "Origin: $(base)" \
        --data "$(jq -cn --arg u "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" '{username: $u, password: $p}')" \
        "$(base)/ghost/api/admin/session/")
    [[ $status == 201 ]] || fail "signing in answered $status" "$(cat "$WORK/session")"
}
post_titles() { api GET 'posts/?limit=all&fields=title' | jq -r '.posts[].title' | sort; }
image() { curl --disable --silent --noproxy '*' --max-time 30 "$(base)/content/images/2026/10/marker.png"; }
# Ghost answers on its port, waiting for it to boot.
answers() {
    local tries=0
    until [[ $(curl --silent --noproxy '*' --max-time 10 --output /dev/null --write-out '%{http_code}' \
        "$(base)/ghost/api/admin/site/" || true) == 200 ]]; do
        tries=$((tries + 1))
        ((tries < 60)) || return 1
        sleep 2
    done
}
fingerprint() {
    (cd "$S" && find . -type f -not -path './data/*' -not -path './backups/*' -print0 | sort -z |
        xargs -0 shasum -a 256)
}

step "Build the manager image from this checkout"
commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf '')
run docker build --quiet --file "$ROOT/manager/Dockerfile" --build-arg GD_VERSION=checkout \
    --build-arg "GD_COMMIT=$commit" --tag "$MANAGER" "$ROOT"
expect_status 0
ok "$MANAGER"

step "A local site on Ghost $FROM, with an owner, a post and an image"
mkdir -p "$S"
run env GD_IMAGE="$MANAGER" "$ROOT/ghost-docker" --dir "$S" install --local --version "$FROM" --no-prompt
expect_status 0
records version "$FROM" || fail "the metadata does not record Ghost $FROM" "$(cat "$S/.ghost-docker.json")"
from_pin=$(setting GHOST_IMAGE_REF)
answers || fail "Ghost $FROM does not answer"
body=$(curl --disable --silent --noproxy '*' --max-time 60 --request POST \
    --header 'Content-Type: application/json' --header "Origin: $(base)" \
    --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" \
        '{setup: [{name: "Update Tester", email: $e, password: $p, blogTitle: "Ghost update e2e"}]}')" \
    "$(base)/ghost/api/admin/authentication/setup/")
jq -e '.users[0].id' <<<"$body" >/dev/null 2>&1 || fail "setting up the owner failed" "$body"
# Signing in from a new session would otherwise ask for a code by email.
run "$S/ghost-docker" --dir "$S" config set ghost.env security__staffDeviceVerification false
expect_status 0
compose_in up --detach --wait ghost >/dev/null 2>&1 || fail "Ghost did not start again"
sign_in
body=$(api POST posts/ --header 'Content-Type: application/json' \
    --data '{"posts": [{"title": "Kept through the Ghost update", "status": "published"}]}')
jq -e '.posts[0].id' <<<"$body" >/dev/null 2>&1 || fail "creating a post failed" "$body"
# shellcheck disable=SC2016 # expanded by the container's shell
compose_in exec -T --user ghost ghost sh -c \
    'mkdir -p "$GHOST_CONTENT/images/2026/10" && printf "kept image" >"$GHOST_CONTENT/images/2026/10/marker.png"' ||
    fail "writing the image failed"
from_migrations=$(migrations)
ok "Ghost $(ghost_version), $from_pin, $from_migrations migrations"

step "--check names the newest Ghost $FROM's major has, and changes nothing"
before=$(fingerprint)
run "$S/ghost-docker" --dir "$S" update --check
expect_status 0
expect_output "This site runs Ghost $FROM\\."
expect_output 'An update is available: Ghost 6\.'
to=$(sed -n 's/^An update is available: Ghost \([^,]*\),.*/\1/p' <<<"$OUT")
[[ -n $to && $to != "$FROM" ]] || fail "no newer Ghost was named" "$OUT"
[[ $(fingerprint) == "$before" ]] || fail "--check changed files"
ok "Ghost $to"

step "Ghost $to migrates and never becomes healthy: the operator is left the data, and restores"
# Healthy only on Ghost $FROM, after long enough for the new Ghost to migrate.
cat >"$S/compose.override.yml" <<EOF
services:
  ghost:
    healthcheck:
      test: ["CMD-SHELL", "test \"\$\$GHOST_VERSION\" = $FROM"]
      interval: 5s
      timeout: 5s
      start_period: 90s
      start_interval: 5s
      retries: 1
EOF
compose_in up --detach --wait ghost >/dev/null 2>&1 || fail "Ghost $FROM is not healthy with the override"
run "$S/ghost-docker" --dir "$S" update
expect_status 1
expect_output 'did not start and become healthy'
expect_output 'The site needs you\.'
expect_output "Ghost $to started before the update failed, so it may have migrated"
expect_output "switching back to $FROM would not undo"
expect_output 'restore --yes backups/'
[[ $(setting GHOST_IMAGE_REF) != "$from_pin" ]] || fail "the pin was put back to Ghost $FROM over its migrations"
records version "$to" || fail "the metadata does not record Ghost $to" "$(cat "$S/.ghost-docker.json")"
[[ -z $(compose_in ps -q ghost) ]] || fail "Ghost $to is still running"
[[ -e $S/.ghost-docker-update/files/.env && ! -e $S/.ghost-docker.lock ]] || fail "the update did not keep its snapshot, or left its lock"
compose_in up --detach --wait db >/dev/null 2>&1 || fail "the database did not start for a look"
failed_migrations=$(migrations)
((failed_migrations > from_migrations)) ||
    fail "Ghost $to's migrations were undone without the operator ($failed_migrations, was $from_migrations)"
ok "Ghost $to's pin and its $failed_migrations migrations left as they are; the services stopped"

backup=$(sed -n 's/^ *\.\/ghost-docker restore --yes \(backups\/[^ ]*\)$/\1/p' <<<"$OUT" | head -1)
[[ -n $backup ]] || fail "the update did not name the backup to restore" "$OUT"
run "$S/ghost-docker" --dir "$S" restore --yes "$backup"
expect_status 0
rm -rf "$S/.ghost-docker-update"
[[ $(setting GHOST_IMAGE_REF) == "$from_pin" ]] || fail "the restore did not pin Ghost $FROM"
records version "$FROM" || fail "the metadata does not record Ghost $FROM" "$(cat "$S/.ghost-docker.json")"
[[ $(ghost_version) == "$FROM" ]] || fail "Ghost $(ghost_version) runs, not $FROM"
[[ $(migrations) == "$from_migrations" ]] || fail "the database is not Ghost $FROM's"
answers || fail "Ghost $FROM does not answer after the restore"
sign_in
grep -qx 'Kept through the Ghost update' <<<"$(post_titles)" || fail "the post was not restored"
ok "restored from $backup: Ghost $FROM, its database and the post"

step "Updated to Ghost $to across its migrations"
rm "$S/compose.override.yml"
compose_in up --detach --wait ghost >/dev/null 2>&1 || fail "Ghost $FROM did not start without the override"
run "$S/ghost-docker" --dir "$S" update
expect_status 0
expect_output "Updated Ghost from $FROM to $to\\."
to_pin=$(setting GHOST_IMAGE_REF)
[[ $to_pin != "$from_pin" ]] || fail "the pin did not change"
records version "$to" || fail "the metadata does not record Ghost $to" "$(cat "$S/.ghost-docker.json")"
running=$(docker inspect -f '{{.Config.Image}}' "$(compose_in ps -q ghost)")
[[ $running == "$to_pin" ]] || fail "Ghost runs $running, not $to_pin"
[[ $(ghost_version) == "$to" ]] || fail "Ghost $(ghost_version) runs, not $to"
((($(migrations)) > from_migrations)) || fail "Ghost $to ran no migrations"
[[ ! -e $S/.ghost-docker-update && ! -e $S/.ghost-docker.lock ]] || fail "the update left its snapshot or lock"
answers || fail "Ghost $to does not answer"
sign_in
grep -qx 'Kept through the Ghost update' <<<"$(post_titles)" || fail "the post was lost"
[[ $(image) == 'kept image' ]] || fail "the image is not served"
run "$S/ghost-docker" --dir "$S" check
expect_status 0
ok "Ghost $to, $to_pin, $(migrations) migrations; the owner signs in, the post and image are kept, check passes"

step "Nothing more to do, and back down is refused"
before=$(fingerprint)
run "$S/ghost-docker" --dir "$S" update
expect_status 0
expect_output "already runs Ghost $to"
run "$S/ghost-docker" --dir "$S" update "$FROM"
expect_status 1
expect_output "newer than $FROM\\. update never moves a site to an"
[[ $(fingerprint) == "$before" ]] || fail "a refused update changed files"
ok "and nothing changed"

passed 'All checks passed.'
