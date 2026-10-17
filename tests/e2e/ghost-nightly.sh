#!/usr/bin/env bash
# Ghost's nightly channel, against real nightly builds (docs/configuration.md#ghost-channel).
#
#   tests/e2e/ghost-nightly.sh
#
# A local site with the upgrade supervisor is installed on an older nightly
# build of Ghost's main branch, chosen by its date tag. The supervisor offers
# the latest build one-click, though both may report the same version, and a
# request made by hand moves the site to it across whatever migrations main
# has gained since. update then has nothing newer, and refuses a version.
#
# It pulls images, starts containers and binds a loopback port. Exits non-zero
# at the first check that fails, naming it.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
MANAGER=ghost-docker:e2e-ghost-nightly

# shellcheck source=/dev/null
source "$ROOT/tests/e2e/skip.sh"
require_docker
for tool in jq curl; do
    command -v "$tool" >/dev/null || {
        printf 'ghost-nightly.sh needs %s\n' "$tool" >&2
        exit 1
    }
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ghost-docker-nightly-e2e.XXXXXXXX")
WORK=$(CDPATH='' cd -- "$WORK" && pwd -P)
S=$WORK/site
CURRENT=setup
OUT=""
RC=0

cleanup() {
    local rc=$?
    set +e
    [[ -f $S/.env ]] && docker compose --project-directory "$S" -f "$S/compose.yml" \
        --profile '*' down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1
    docker run --rm --user 0 --entrypoint rm -v "$WORK:/work" "$MANAGER" -rf /work/site >/dev/null 2>&1
    docker rmi "$MANAGER" >/dev/null 2>&1
    case $WORK in */ghost-docker-nightly-e2e.*) rm -rf -- "$WORK" ;; esac
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
    [[ ! -f $S/.env ]] || docker compose --project-directory "$S" -f "$S/compose.yml" \
        logs --no-color --tail 60 supervisor >&2 2>&1 || true
    exit 1
}

run() {
    set +e
    OUT=$("$@" 2>&1 </dev/null)
    RC=$?
    set -e
}
expect_status() { [[ $RC -eq $1 ]] || fail "exited $RC, expected $1" "$OUT"; }

gd() { "$S/ghost-docker" --dir "$S" "$@"; }
compose_in() { docker compose --project-directory "$S" -f "$S/compose.yml" "$@"; }
setting() { gd config get "$1" 2>/dev/null; }
# shellcheck source=supervisor-api.sh
source "$ROOT/tests/e2e/supervisor-api.sh"
wait_for() {
    local want=$1 seconds=$2 got=''
    shift 2
    for ((tick = 0; tick < seconds; tick += 2)); do
        got=$("$@" || true)
        [[ $got == "$want" ]] && return 0
        sleep 2
    done
    fail "waited ${seconds}s for $* to be $want; it is ${got:-nothing}"
}

step "Choose an older nightly build"
# The date tags, newest first; the build before latest's is the one to start from.
tags=$(curl --silent --fail --max-time 30 \
    'https://hub.docker.com/v2/repositories/ghost/nightly/tags?page_size=25&ordering=last_updated' |
    jq -r '.results[].name | select(test("^[0-9]{8}$"))')
latest_digest=$(curl --silent --fail --max-time 30 \
    'https://hub.docker.com/v2/repositories/ghost/nightly/tags/latest' | jq -r '.digest')
FROM=""
for tag in $tags; do
    digest=$(curl --silent --fail --max-time 30 \
        "https://hub.docker.com/v2/repositories/ghost/nightly/tags/$tag" | jq -r '.digest')
    if [[ $digest != "$latest_digest" ]]; then
        FROM=$tag
        break
    fi
done
[[ -n $FROM ]] || fail "no nightly build older than latest was found" "$tags"
ok "starting from $FROM"

step "Build the manager image from this checkout"
commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf '')
run docker build --quiet --file "$ROOT/manager/Dockerfile" --build-arg GD_VERSION=checkout \
    --build-arg "GD_COMMIT=$commit" --tag "$MANAGER" "$ROOT"
expect_status 0
ok "$MANAGER"

step "A local site on nightly $FROM, with the supervisor"
mkdir -p "$S"
run env GD_IMAGE="$MANAGER" "$ROOT/ghost-docker" --dir "$S" install --local --ghost-channel nightly \
    --version "$FROM" --with supervisor --no-prompt
expect_status 0
grep -qE 'Channel +nightly' <<<"$OUT" ||
    fail "the summary does not say the site is on the nightly channel" "$OUT"
PROJECT=$(setting COMPOSE_PROJECT_NAME)
[[ $(setting GHOST_IMAGE) == ghost/nightly ]] || fail "GHOST_IMAGE is not ghost/nightly"
[[ $(setting GHOST_IMAGE_REF) == ghost/nightly@sha256:* ]] || fail "the build is not pinned by digest"
from_version=$(compose_in exec -T ghost printenv GHOST_VERSION)
ok "Ghost $from_version, $(setting GHOST_IMAGE_REF)"

step "The supervisor offers the latest build one-click"
wait_for ready 300 availability
to=$(offered_ghost)
[[ -n $to ]] || fail "no one-click nightly update is offered" "$(status_json)"
ok "Ghost $to"

step "A request made by hand moves the site to it"
run request_update "$to"
[[ ${OUT%% *} == 202 ]] || fail "the request was not accepted" "$OUT"
id=$(jq -r '.id' <<<"${OUT#* }")
wait_for "done" 900 job_state "$id"
[[ $(compose_in exec -T ghost printenv GHOST_VERSION) == "$to" ]] || fail "Ghost is not $to"
[[ $(setting GHOST_IMAGE_REF) == "ghost/nightly@$latest_digest" ]] ||
    fail "the site is not on latest's build ($latest_digest)" "$(setting GHOST_IMAGE_REF)"
run gd check
expect_status 0
ok "Ghost $to, ghost/nightly@$latest_digest; check passes"

step "update has nothing newer, and refuses a version"
run gd update
expect_status 0
grep -q 'already runs Ghost' <<<"$OUT" || fail "update offered something past latest" "$OUT"
run gd update 6.70.1
expect_status 2
ok "nothing to update; a version is refused"

passed 'All checks passed.'
