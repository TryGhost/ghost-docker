# shellcheck shell=bash
# Calls to the upgrade supervisor's API as Ghost makes them: Ghost's uid
# (1000), with the site's `upgrade` volume mounted read-only as Ghost mounts
# it. In a container of its own, because Ghost's is stopped for parts of an
# update. Sourced by the end-to-end scenarios; needs MANAGER (an image with
# node) and PROJECT (the site's COMPOSE_PROJECT_NAME).

# Prints the status code, a space, then the body.
ghost_http() {
    docker run --rm --user 1000:1000 --network none \
        -v "${PROJECT}_upgrade:/run/ghost-upgrade:ro" --entrypoint node "$MANAGER" -e '
const [method, path, body] = process.argv.slice(1);
const r = require("http").request({socketPath: "/run/ghost-upgrade/supervisor.sock", method, path, agent: false},
  res => { let b = ""; res.on("data", d => b += d); res.on("end", () => console.log(res.statusCode + " " + b)); });
r.on("error", e => console.log("error " + e.code));
r.end(body || undefined);
' "$1" "$2" "${3:-}"
}

# The body of a call that answered 200; fails otherwise.
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
offered_ghost() { status_json | jq -r '.oneClick[]? | select(.component == "ghost") | .toVersion'; }
new_key() { head -c 32 /dev/urandom | shasum -a 256 | cut -d' ' -f1; }
# POST /v1/requests for Ghost `$1`, with key `$2` (a new one when omitted).
request_update() {
    ghost_http POST /v1/requests \
        "{\"component\":\"ghost\",\"toVersion\":\"$1\",\"idempotencyKey\":\"${2:-$(new_key)}\"}"
}
