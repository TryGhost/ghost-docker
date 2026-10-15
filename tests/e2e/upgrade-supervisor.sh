#!/usr/bin/env bash
# The upgrade supervisor, against real containers (docs/upgrade-supervisor.md).
#
#   tests/e2e/upgrade-supervisor.sh
#
# A local site on Ghost 6.61.0 is installed with the supervisor. Inside the
# Ghost container, as Ghost's own uid, Ghost reaches the supervisor's socket
# through its read-only mount and cannot replace it; another uid cannot reach
# it. A malformed request and one made while the CLI holds the lock are refused.
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
# A call to the supervisor's API as Ghost makes one: Ghost's uid, the volume
# mounted read-only as Ghost mounts it. In a container of its own, because
# Ghost's is stopped for parts of an update. Prints the status, then the body.
ghost_http() {
    docker run --rm --user 1000:1000 --network none \
        -v "$(setting COMPOSE_PROJECT_NAME)_upgrade:/run/ghost-upgrade:ro" --entrypoint node "$MANAGER" -e '
const [method, path, body] = process.argv.slice(1);
const r = require("http").request({socketPath: "/run/ghost-upgrade/supervisor.sock", method, path, agent: false},
  res => { let b = ""; res.on("data", d => b += d); res.on("end", () => console.log(res.statusCode + " " + b)); });
r.on("error", e => console.log("error " + e.code));
r.end(body || undefined);
' "$1" "$2" "${3:-}"
}
# The body of a call that answered 200.
api() {
    local out
    out=$(ghost_http "$@")
    [[ ${out%% *} == 200 ]] || return 1
    printf '%s' "${out#* }"
}
status_json() { api GET /v1/status; }
availability() { status_json | jq -r '.availability'; }
job_json() { api GET "/v1/jobs/$1"; }
job_state() { job_json "$1" | jq -r '.state'; }
new_key() { head -c 32 /dev/urandom | shasum -a 256 | cut -d' ' -f1; }
# POST /v1/requests for Ghost `$1` with key `$2`; OUT is the status and body.
request() {
    run ghost_http POST /v1/requests "{\"component\":\"ghost\",\"toVersion\":\"$1\",\"idempotencyKey\":\"$2\"}"
}
answered() { [[ ${OUT%% *} == "$1" ]] || fail "answered ${OUT%% *}, expected $1" "$OUT"; }
body() { printf '%s' "${OUT#* }"; }
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
# A call to the API from inside Ghost's container, as Ghost's own user.
as_ghost_http() {
    local method=$1 path=$2 body=${3:-}
    as_ghost "node -e '
const r = require(\"http\").request({socketPath: \"/run/ghost-upgrade/supervisor.sock\", method: \"$method\", path: \"$path\", agent: false},
  res => { let b = \"\"; res.on(\"data\", d => b += d); res.on(\"end\", () => console.log(res.statusCode + \" \" + b)); });
r.on(\"error\", e => { console.log(\"error \" + e.code); });
r.end(process.argv[1] || undefined);
' '$body'"
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
to=$(status_json | jq -r '.oneClick[] | select(.component == "ghost") | .toVersion')
[[ -n $to && $to != "$FROM" ]] || fail "no one-click Ghost update is offered" "$(status_json)"
[[ $(status_json | jq -r '.backupRequired') == true ]] || fail "the status does not promise a backup"
ok "ready, offering Ghost $to one-click"

step "As Ghost's uid, the socket: reached through a read-only mount, never replaced"
[[ $(as_ghost 'id -u') == 1000 ]] || fail "Ghost does not run as uid 1000"
run as_ghost_http GET /v1
[[ $OUT == '200 {"protocol":1}' ]] || fail "Ghost cannot reach the supervisor" "$OUT"
as_ghost 'rm -f /run/ghost-upgrade/supervisor.sock' 2>/dev/null && fail "Ghost removed the socket"
as_ghost 'touch /run/ghost-upgrade/forged' 2>/dev/null && fail "Ghost wrote into the socket's volume"
run docker run --rm --user 2000:2000 --network none \
    -v "$(setting COMPOSE_PROJECT_NAME)_upgrade:/run/ghost-upgrade:ro" --entrypoint node "$MANAGER" -e \
    "require('http').get({socketPath: '/run/ghost-upgrade/supervisor.sock', path: '/v1'}, () => console.log('reached')).on('error', e => console.log(e.code))"
[[ $OUT == EACCES ]] || fail "a uid other than Ghost's reached the socket" "$OUT"
[[ -z $(find "$S/.ghost-docker-supervisor" -perm -o=r -type f 2>/dev/null) ]] || fail "the private records are readable by others"
ok "Ghost reaches it and cannot replace it; uid 2000 is refused; the records are private"

step "A malformed request is refused"
run as_ghost_http POST /v1/requests 'not json'
[[ $OUT == 400\ * ]] || fail "a malformed request was not refused with 400" "$OUT"
jq -e '.error.code == "malformed"' <<<"${OUT#400 }" >/dev/null || fail "not refused as malformed" "$OUT"
[[ ! -e $S/.ghost-docker.lock ]] || fail "a malformed request took the lock"
ok "400 malformed, and nothing taken"

step "A request while the CLI holds the lock is refused"
printf '{"operation":"backup","startedAt":"2026-10-14T00:00:00Z"}\n' >"$S/.ghost-docker.lock"
wait_for busy 30 availability
request "$to" "$(new_key)"
answered 409
body | jq -e '.error.code == "busy"' >/dev/null || fail "not refused as busy" "$OUT"
rm "$S/.ghost-docker.lock"
wait_for ready 30 availability
ok "busy while locked; ready again once the lock is gone"

step "A supervisor killed mid-job reports it interrupted, with the lock left for the operator"
request "$to" "$(new_key)"
answered 202
id=$(body | jq -r '.id')
wait_for_any '^(backing-up|restarting|verifying)$' 300 job_state "$id" >/dev/null
docker kill "$(compose_in ps -q supervisor)" >/dev/null
compose_in --profile supervisor up --detach --wait supervisor >/dev/null 2>&1 || fail "the supervisor did not start again"
wait_for interrupted 60 job_state "$id"
[[ -e $S/.ghost-docker.lock ]] || fail "the interrupted job's lock was removed"
[[ $(availability) == unavailable ]] || fail "the supervisor is not unavailable over an interrupted job"
job_json "$id" | jq -e '.diagnostics[0].details | test("rm .ghost-docker.lock")' >/dev/null ||
    fail "the interrupted job does not say what to do" "$(job_json "$id")"
ok "job $id interrupted; the lock stays; unavailable"

step "The operator follows the steps"
job_json "$id" | jq -r '.diagnostics[0].details'
rm "$S/.ghost-docker.lock"
state=$(job_json "$id" | jq -r '.diagnostics[0].details')
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
version_now=$(status_json | jq -r '.currentVersion')
to=$(status_json | jq -r '.oneClick[] | select(.component == "ghost") | .toVersion')
[[ -n $to ]] || fail "no update offered after recovery (Ghost $version_now)" "$(status_json)"
key=$(new_key)
request "$to" "$key"
answered 202
id=$(body | jq -r '.id')
# The same request again is the same job, answered 200.
request "$to" "$key"
answered 200
[[ $(body | jq -r '.id') == "$id" ]] || fail "a replay named another job" "$OUT"
wait_for "done" 900 job_state "$id"
[[ $(compose_in exec -T ghost printenv GHOST_VERSION) == "$to" ]] || fail "Ghost is not $to"
[[ ! -e $S/.ghost-docker.lock && ! -e $S/.ghost-docker-update ]] || fail "the job left its lock or snapshot"
job_json "$id" | jq -e '.diagnostics[0].message | test("backed up to backups/")' >/dev/null ||
    fail "the job does not name its backup" "$(job_json "$id")"
[[ $(compose_in ps --format '{{.State}}' supervisor) == running ]] || fail "the job stopped the supervisor"
run gd check
expect_status 0
wait_for ready 60 availability
ok "Ghost $to, backed up first; the supervisor kept running; check passes"

passed 'All checks passed.'
