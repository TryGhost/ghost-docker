#!/usr/bin/env bash
# The upgrade supervisor, against real containers (docs/upgrade-supervisor.md).
#
#   tests/e2e/upgrade-supervisor.sh
#
# A local site on Ghost 6.61.0 is installed with the supervisor. Inside the
# Ghost container, as Ghost's own uid, the exchange lets Ghost write requests
# and read status, and refuses any change to what the supervisor owns. A
# malformed request and one made while the CLI holds the lock are refused.
# A supervisor killed mid-job reports the job interrupted when it comes back,
# leaving the lock for the operator, who follows its steps. Then a request
# made by hand runs to done: Ghost is on the newest 6.x, backed up first.
#
# It pulls images, starts containers and binds a loopback port. Exits non-zero
# at the first check that fails, naming it.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
MANAGER=ghost-docker:e2e-upgrade-supervisor
FROM=6.61.0

# shellcheck source=/dev/null
source "$ROOT/tests/e2e/skip.sh"
require_docker
command -v jq >/dev/null || {
    printf 'upgrade-supervisor.sh needs jq\n' >&2
    exit 1
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ghost-docker-supervisor-e2e.XXXXXXXX")
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
    case $WORK in */ghost-docker-supervisor-e2e.*) rm -rf -- "$WORK" ;; esac
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
# As Ghost runs: its own user, in its own container.
as_ghost() { compose_in exec -T --user ghost ghost sh -c "$1"; }
status_json() { gd supervisor status --json 2>/dev/null; }
availability() { status_json | jq -r '.availability'; }
job_state() { gd supervisor job "$1" --json 2>/dev/null | jq -r '.state'; }
# Waits for `what` to print `want`, for up to `seconds`.
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
wait_for_any() {
    local pattern=$1 seconds=$2 got=''
    shift 2
    for ((tick = 0; tick < seconds; tick += 2)); do
        got=$("$@" || true)
        [[ $got =~ $pattern ]] && {
            printf '%s' "$got"
            return 0
        }
        sleep 1
    done
    fail "waited ${seconds}s for $* to match $pattern; it is ${got:-nothing}"
}
handwritten() {
    # A request as Ghost writes one, by hand, with the key it is named for.
    local key=$1 version=$2 name=$3
    as_ghost "printf '%s' '{\"protocol\":1,\"request\":{\"component\":\"ghost\",\"toVersion\":\"$version\",\"idempotencyKey\":\"$key\"}}' > /run/ghost-upgrade/requests/.tmp-e2e && chmod 0640 /run/ghost-upgrade/requests/.tmp-e2e && ln /run/ghost-upgrade/requests/.tmp-e2e /run/ghost-upgrade/requests/$name && rm /run/ghost-upgrade/requests/.tmp-e2e"
}

step "Build the manager image from this checkout"
commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf '')
run docker build --quiet --file "$ROOT/manager/Dockerfile" --build-arg GD_VERSION=checkout \
    --build-arg "GD_COMMIT=$commit" --tag "$MANAGER" "$ROOT"
expect_status 0
ok "$MANAGER"

step "A local site on Ghost $FROM with the supervisor"
mkdir -p "$S"
run env GD_IMAGE="$MANAGER" "$ROOT/ghost-docker" --dir "$S" install --local --version "$FROM" \
    --with supervisor --no-prompt
expect_status 0
[[ $(setting COMPOSE_PROFILES) == local,supervisor ]] || fail "the supervisor profile is not selected"
grep -q adapters__upgrade "$S/ghost.env" && fail "the adapter was enabled on a Ghost that does not ship it"
wait_for ready 300 availability
to=$(status_json | jq -r '.file.status.oneClick[] | select(.component == "ghost") | .toVersion')
[[ -n $to && $to != "$FROM" ]] || fail "no one-click Ghost update is offered" "$(status_json)"
[[ $(status_json | jq -r '.file.status.backupRequired') == true ]] || fail "the status does not promise a backup"
ok "ready, offering Ghost $to one-click"

step "As Ghost's uid, the exchange: requests written, status read, nothing of the supervisor's changed"
[[ $(as_ghost 'id -u') == 1000 ]] || fail "Ghost does not run as uid 1000"
as_ghost 'test -r /run/ghost-upgrade/status/status.json' || fail "Ghost cannot read the status"
as_ghost 'echo x > /run/ghost-upgrade/status/status.json' 2>/dev/null && fail "Ghost replaced the status"
as_ghost 'mv /run/ghost-upgrade/status/status.json /run/ghost-upgrade/status/x' 2>/dev/null && fail "Ghost renamed the status"
as_ghost 'touch /run/ghost-upgrade/status/jobs/forged.json' 2>/dev/null && fail "Ghost wrote a job file"
as_ghost 'touch /run/ghost-upgrade/requests/.probe && rm /run/ghost-upgrade/requests/.probe' || fail "Ghost cannot write requests"
compose_in exec -T --user ghost ghost sh -c 'ls /home/ghost' >/dev/null || fail "Ghost cannot run as itself"
[[ -z $(find "$S/.ghost-docker-supervisor" -perm -o=r -type f 2>/dev/null) ]] || fail "the private records are readable by others"
ok "write requests, read status; status, jobs and records are the supervisor's alone"

step "A malformed request is refused"
key=$(printf 'malformed' | shasum -a 256 | cut -d' ' -f1)
id=$key
as_ghost "printf 'not json' > /run/ghost-upgrade/requests/$id.json"
wait_for refused 30 job_state "$id"
gd supervisor job "$id" --json | jq -e '.diagnostics[0].code == "malformed"' >/dev/null || fail "not refused as malformed"
ok "job $id refused, malformed"

step "A request while the CLI holds the lock is refused"
printf '{"operation":"backup","startedAt":"2026-10-14T00:00:00Z"}\n' >"$S/.ghost-docker.lock"
wait_for busy 30 availability
key=$(printf 'locked' | shasum -a 256 | cut -d' ' -f1)
id=$key
handwritten "$key" "$to" "$id.json"
wait_for refused 30 job_state "$id"
rm "$S/.ghost-docker.lock"
wait_for ready 30 availability
ok "refused while locked; ready again once the lock is gone"

step "A supervisor killed mid-job reports it interrupted, with the lock left for the operator"
run gd supervisor request ghost "$to" --json
expect_status 0
id=$(jq -r '.accepted.id' <<<"$OUT")
wait_for_any '^(backing-up|restarting|verifying)$' 300 job_state "$id" >/dev/null
docker kill "$(compose_in ps -q supervisor)" >/dev/null
compose_in --profile supervisor up --detach --wait supervisor >/dev/null 2>&1 || fail "the supervisor did not start again"
wait_for interrupted 60 job_state "$id"
[[ -e $S/.ghost-docker.lock ]] || fail "the interrupted job's lock was removed"
[[ $(availability) == unavailable ]] || fail "the supervisor is not unavailable over an interrupted job"
gd supervisor job "$id" --json | jq -e '.diagnostics[0].details | test("rm .ghost-docker.lock")' >/dev/null ||
    fail "the interrupted job does not say what to do" "$(gd supervisor job "$id")"
ok "job $id interrupted; the lock stays; unavailable"

step "The operator follows the steps"
gd supervisor job "$id"
rm "$S/.ghost-docker.lock"
state=$(gd supervisor job "$id" --json | jq -r '.diagnostics[0].details')
if grep -q 'restore --yes' <<<"$state"; then
    backup=$(sed -n 's/.*restore --yes \(backups\/[^ ]*\).*/\1/p' <<<"$state" | head -1)
    run gd restore --yes "$backup"
    expect_status 0
else
    compose_in up --detach --wait >/dev/null 2>&1 || fail "the site did not start again"
fi
run gd check
expect_status 0
rm -rf "$S/.ghost-docker-update"
wait_for ready 60 availability
ok "checked, and ready again"

step "A request made by hand runs to done"
version_now=$(status_json | jq -r '.file.status.currentVersion')
to=$(status_json | jq -r '.file.status.oneClick[] | select(.component == "ghost") | .toVersion')
[[ -n $to ]] || fail "no update offered after recovery (Ghost $version_now)" "$(status_json)"
run gd supervisor request ghost "$to" --json
expect_status 0
id=$(jq -r '.accepted.id' <<<"$OUT")
# The same request again is the same job.
run gd supervisor request ghost "$to" --json
wait_for "done" 900 job_state "$id"
[[ $(compose_in exec -T ghost printenv GHOST_VERSION) == "$to" ]] || fail "Ghost is not $to"
[[ ! -e $S/.ghost-docker.lock && ! -e $S/.ghost-docker-update ]] || fail "the job left its lock or snapshot"
gd supervisor job "$id" --json | jq -e '.diagnostics[0].message | test("backed up to backups/")' >/dev/null ||
    fail "the job does not name its backup" "$(gd supervisor job "$id")"
[[ $(compose_in ps --format '{{.State}}' supervisor) == running ]] || fail "the job stopped the supervisor"
run gd check
expect_status 0
wait_for ready 60 availability
ok "Ghost $to, backed up first; the supervisor kept running; check passes"

passed 'All checks passed.'
