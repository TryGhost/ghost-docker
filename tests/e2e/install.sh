#!/usr/bin/env bash
# Real installations, against real containers.
#
#   tests/e2e/install.sh
#
# Builds the manager image from this checkout, then installs local and
# production sites with it the two ways an operator can: from the image alone,
# with nothing but a copy of the launcher beside the site, and from a clone of
# the repository. Each check runs the real commands and looks at outcomes: the
# files on disk, the containers Docker runs, and what answers on the host's
# own ports.
#
# It pulls images, starts containers, and binds host ports, including 80 and
# 443 (the checks that need those skip themselves when something else holds
# them). Production sites use the name ghost-e2e.test, which no CA will issue
# for, so HTTPS is pending exactly as it is before a real domain's DNS exists;
# their ACME requests go to Let's Encrypt's staging service.
#
# Exits non-zero at the first check that fails, naming it.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
IMAGE=ghost-docker:e2e
DOMAIN=ghost-e2e.test
PROXY=ghost-docker-e2e-proxy

if ! docker info >/dev/null 2>&1; then
    printf 'skipped: no Docker daemon answers here\n'
    exit 0
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ghost-docker-install-e2e.XXXXXXXX")
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
    for site in ${SITES[@]+"${SITES[@]}"}; do
        [[ -f $site/.env ]] && docker compose --project-directory "$site" -f "$site/compose.yml" \
            down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1
    done
    docker rm -f "$PROXY" >/dev/null 2>&1
    [[ -z ${HOLDER:-} ]] || kill "$HOLDER" 2>/dev/null
    docker run --rm --user 0 --entrypoint rm -v "$WORK:/work" "$IMAGE" -rf /work/sites >/dev/null 2>&1
    case $WORK in */ghost-docker-install-e2e.*) rm -rf -- "$WORK" ;; esac
    exit "$rc"
}
trap cleanup EXIT

step() {
    CURRENT=$1
    printf '\n== %s\n' "$1"
}
ok() { printf '   ok    %s\n' "$1"; }
skip() { printf '   skip  %s\n' "$1"; }
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
refute_output() { ! grep -qE -- "$1" <<<"$OUT" || fail "the output should not match: $1" "$OUT"; }

# The installer's own output, without the services' logs it prints on failure.
summary() { grep -vE '^[a-z-]+-1 +\|' <<<"$OUT" || true; }

# compose_in SITE ARGS... -- Compose as an operator runs it, from the host.
compose_in() {
    local site=$1
    shift
    docker compose --project-directory "$site" -f "$site/compose.yml" "$@"
}

# setting SITE KEY -- one decoded value, through the manager.
setting() { "$1/ghost-docker" --dir "$1" config get "$2" 2>/dev/null; }

# owner_mode PATH -> "UID MODE", on Linux and macOS
owner_mode() { stat -c '%u %a' "$1" 2>/dev/null || stat -f '%u %Lp' "$1"; }

# http_status PORT [HOST] -- what answers on the host's own loopback port.
http_status() {
    curl --silent --noproxy '*' --max-time 20 --output /dev/null --write-out '%{http_code}' \
        --header "Host: ${2:-localhost}" "http://127.0.0.1:$1/ghost/api/admin/site/" || true
}

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# new_site NAME -> SITE, an empty directory that cleanup takes down. Not a
# command substitution: SITES has to grow in this shell, not a subshell.
new_site() {
    SITE=$WORK/sites/$1
    mkdir -p "$SITE"
    SITES+=("$SITE")
}

operating_system=$(docker info --format '{{.OperatingSystem}}')
printf 'Docker: %s on %s\n' "$operating_system" "$(uname -s)"

# --- The image, and a launcher with no checkout beside it --------------------

step "Build the manager image from this checkout"
run docker build --quiet --file "$ROOT/manager/Dockerfile" --tag "$IMAGE" "$ROOT"
expect_status 0
ALONE=$WORK/launcher-only
mkdir -p "$ALONE" "$WORK/sites"
cp "$ROOT/ghost-docker" "$ALONE/ghost-docker"
# The image as an operator without a checkout uses it: named, then pinned.
install_alone() { GD_IMAGE=$IMAGE "$ALONE/ghost-docker" --dir "$1" install "${@:2}"; }
ok "$IMAGE"

# --- A local site, from the image alone --------------------------------------

step "A local site, installed into an empty directory from the image alone"
new_site e2e-local-a
A=$SITE
run install_alone "$A" --local
expect_status 0
expect_output 'Ghost is installed'
expect_output 'ok +ghost +healthy'
expect_output 'note +published ports +Docker publishes Ghost on 127\.0\.0\.1:[0-9]+'
ok "installed and healthy; the host's port is checked below"

for file in compose.yml caddy/Caddyfile caddy/snippets/SecurityHeaders mysql-init/create-multiple-databases.sh \
    tinybird/Dockerfile .env.example ghost.env.example ghost-docker; do
    [[ -e $A/$file ]] || fail "the payload is missing $file" "$(ls -AR "$A")"
done
[[ -x $A/ghost-docker && -x $A/mysql-init/create-multiple-databases.sh ]] || fail "executables lost their mode"
grep -qE '^readonly GD_PINNED_IMAGE="[^"]+"$' "$A/ghost-docker" || fail "the site's launcher is not pinned" "$(grep GD_PINNED_IMAGE "$A/ghost-docker")"
ok "the payload and a pinned launcher were written"

for file in .env ghost.env .ghost-docker.json; do
    [[ $(owner_mode "$A/$file") == "$(id -u) 600" ]] || fail "$file is $(owner_mode "$A/$file"), not $(id -u) 600"
done
# data/ghost and data/mysql are the images' own business once their services
# have run: Ghost and MySQL take ownership of them.
for file in compose.yml caddy/Caddyfile ghost-docker data; do
    [[ $(owner_mode "$A/$file") == "$(id -u) "* ]] || fail "$file belongs to $(owner_mode "$A/$file")"
done
ok "credentials are private, and what the manager wrote belongs to $(id -u)"

pin=$(setting "$A" GHOST_IMAGE_REF)
[[ $pin =~ ^ghost@sha256:[0-9a-f]{64}$ ]] || fail "GHOST_IMAGE_REF is $pin"
grep -q "\"digest\": \"${pin#ghost@}\"" "$A/.ghost-docker.json" || fail "the metadata does not record $pin" "$(cat "$A/.ghost-docker.json")"
running=$(docker inspect -f '{{.Config.Image}}' "$(compose_in "$A" ps -q ghost)")
[[ $running == "$pin" ]] || fail "Ghost runs $running, not $pin"
ok "Ghost runs exactly $pin"

port=$(setting "$A" GHOST_PORT)
status=$(http_status "$port")
[[ $status == 200 ]] || fail "the loopback port $port answered $status"
bindings=$(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}} {{end}}{{end}}' "$(compose_in "$A" ps -q ghost)")
[[ $bindings == "127.0.0.1 " ]] || fail "Ghost is published on: $bindings"
ok "the Admin API answers on 127.0.0.1:$port, and only there"

password=$(setting "$A" DATABASE_PASSWORD)
[[ ${#password} -ge 32 && $password != *change-me* && $password != "$(setting "$A" DATABASE_ROOT_PASSWORD)" ]] ||
    fail "the generated passwords are weak or shared"
ok "generated credentials"

run env -u GD_IMAGE "$A/ghost-docker" --dir "$A" check
expect_status 0
expect_output 'This site looks healthy'
expect_output 'ok +database +accepts a client connection'
run "$A/ghost-docker" --dir "$A" list
expect_output 'ghost-local-e2e-local-a +local +ghost'
ok "check passes through the site's own pinned launcher, and list finds the site"

# --- A second local site beside it ------------------------------------------

step "A second local site, beside the first"
new_site e2e-local-b
B=$SITE
run install_alone "$B" --local
expect_status 0
[[ $(setting "$A" GHOST_PORT) != "$(setting "$B" GHOST_PORT)" ]] || fail "the two sites share a port"
[[ $(setting "$A" COMPOSE_PROJECT_NAME) != "$(setting "$B" COMPOSE_PROJECT_NAME)" ]] || fail "the two sites share an identity"
for site in "$A" "$B"; do
    [[ $(http_status "$(setting "$site" GHOST_PORT)") == 200 ]] || fail "$site does not answer"
done
ok "distinct identities and ports, and both answer at once"
compose_in "$B" down --volumes >/dev/null 2>&1

# --- --no-start, and the encoder through real containers ------------------------

step "--no-start starts nothing"
new_site e2e-no-start
N=$SITE
run install_alone "$N" --local --no-start
expect_status 0
expect_output 'Nothing is running'
[[ -z $(compose_in "$N" ps --all --quiet) ]] || fail "containers were created"
compose_in "$N" config --quiet || fail "the configuration it wrote does not resolve"
ok "configured, valid, and nothing created"

step "Values written by config set reach a container exactly"
# Each value goes in through the manager's encoder and comes out of a real
# container through Compose. VAR is set where Compose runs, so an
# interpolation that should not happen shows.
# shellcheck disable=SC2016,SC1003  # every one of these is meant literally
values=(
    'plain'
    'with spaces  '
    'dollar $VAR'
    'braced ${VAR}'
    'double dollar $$'
    'lone dollar $'
    'double"quote'
    "single'quote"
    'back\slash'
    "backslash quote \\'"
    ''
    '["a", "b", 1]'
    '{"k": "v", "n": [1, 2]}'
    'hash # not a comment'
    $'line1\nline2'
    $'tab\there'
    'trailing backslash \'
)
keys=()
for i in "${!values[@]}"; do
    "$N/ghost-docker" --dir "$N" config set ghost.env "E2E_V$i" -- "${values[$i]}" >/dev/null 2>&1 ||
        fail "config set refused value $i"
    keys+=("E2E_V$i")
done
# And through .env, interpolated into the ghost service's environment.
"$N/ghost-docker" --dir "$N" config set .env TINYBIRD_WORKSPACE_ID -- "${values[3]} ${values[6]} ${values[9]}" >/dev/null 2>&1
# shellcheck disable=SC2016  # a Node program, not shell
run env VAR=INTERPOLATED docker compose --project-directory "$N" -f "$N/compose.yml" \
    run --rm --no-deps -T --entrypoint node ghost -e '
for (const key of process.argv.slice(1)) {
  process.stdout.write(Buffer.from(process.env[key] ?? "<unset>").toString("base64") + "\n");
}' "${keys[@]}" tinybird__workspaceId
expect_status 0
seen=()
while IFS= read -r line; do
    [[ $line =~ ^[A-Za-z0-9+/=]*$ ]] || continue
    seen+=("$(printf '%s' "$line" | base64 -d 2>/dev/null || printf '%s' "$line" | base64 -D)")
done <<<"$OUT"
for i in "${!values[@]}"; do
    [[ ${seen[$i]-<missing>} == "${values[$i]}" ]] ||
        fail "value $i reached the container as [${seen[$i]-<missing>}], not [${values[$i]}]" "$OUT"
done
[[ ${seen[${#values[@]}]} == "${values[3]} ${values[6]} ${values[9]}" ]] ||
    fail "a .env value reached the container as [${seen[${#values[@]}]}]"
ok "${#values[@]} values through ghost.env, and one through .env, arrive verbatim"

# --- A port another program holds ---------------------------------------------

step "A port held by a program Docker does not manage"
new_site e2e-port-conflict
P=$SITE
busy=24771
if command -v python3 >/dev/null 2>&1 && port_free "$busy"; then
    python3 -c 'import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(); time.sleep(900)' "$busy" &
    HOLDER=$!
    sleep 1
    run install_alone "$P" --local --port "$busy"
    if ((RC == 0)) && [[ $(uname -s) != Linux ]]; then
        # Docker Desktop and OrbStack publish over the program holding the
        # port; the manager refuses first only when it can reach the host.
        skip "$operating_system published $busy over the program holding it, without an error"
        compose_in "$P" down --volumes >/dev/null 2>&1
    else
        expect_status 1
        if grep -qE 'already in use on this host by something outside Docker' <<<"$OUT"; then
            # Where the manager can see the host's ports (Docker Desktop,
            # OrbStack), it refuses the port before writing anything.
            expect_output '--port'
            expect_output 'Nothing has been changed'
            refused="refused before anything was written, naming --port"
        else
            # On Linux, Docker's own words name the port; the manager adds
            # what to do.
            expect_output "127\\.0\\.0\\.1:$busy"
            expect_output 'already (in use|allocated)'
            expect_output 'choose another for Ghost with --port'
            expect_output 'Nothing that was already running was stopped'
            refused="an error naming the port and --port"
        fi
        [[ -z $(ls -A "$P") ]] || fail "the failed installation left files behind" "$(ls -A "$P")"
        [[ -z $(compose_in "$P" ps --all --quiet 2>/dev/null || true) ]] || fail "it left containers behind"
        kill -0 "$HOLDER" || fail "the program holding the port was stopped"
        ok "$refused, the directory as it was, the holder untouched"
        run install_alone "$P" --local --port 24772
        expect_status 0
        ok "the same command with a free --port succeeds"
        compose_in "$P" down --volumes >/dev/null 2>&1
    fi
    kill "$HOLDER" 2>/dev/null || true
    HOLDER=""
else
    skip "needs python3 and a free port $busy"
fi

# --- An existing proxy on 80 and 443 ------------------------------------------

step "A proxy already serving 80 and 443"
new_site e2e-existing-proxy
X=$SITE
if port_free 80 && port_free 443; then
    caddy_image=$(sed -n 's/^ *image: \(caddy:[^ ]*\)$/\1/p' "$ROOT/compose.yml")
    docker run -d --name "$PROXY" -p 80:80 -p 443:443 "$caddy_image" \
        caddy respond --listen :80 "the operator's own proxy" >/dev/null
    run install_alone "$X" --domain "$DOMAIN"
    expect_status 1
    expect_output "port 80 is already in use by the Docker container $PROXY"
    expect_output 'Nothing was stopped\. Nothing has been changed\.'
    [[ $(docker inspect -f '{{.State.Running}}' "$PROXY") == true ]] || fail "the proxy was stopped"
    [[ -z $(ls -A "$X") ]] || fail "files were written" "$(ls -A "$X")"
    ok "refused before anything was written, naming the container, which still runs"
    docker rm -f "$PROXY" >/dev/null
else
    skip "something on this host already holds 80 or 443"
fi

# --- A production site, from the image alone ------------------------------------

production_checks() {
    expect_output 'ok +ghost +healthy'
    expect_output "ok +caddy +http://$DOMAIN redirects to HTTPS through caddy:80 on the site network"
    expect_output "note +https +pending: there is no certificate for $DOMAIN yet"
    expect_output 'note +published ports +.*Caddy on .*:80'
    # And from the host itself, as an operator's own curl would see it.
    location=$(curl --silent --noproxy '*' --max-time 20 --output /dev/null --write-out '%{redirect_url}' \
        --header "Host: $DOMAIN" http://127.0.0.1/ || true)
    [[ $location == "https://$DOMAIN/"* ]] || fail "port 80 on the host did not redirect $DOMAIN to HTTPS (got '$location')" "$OUT"
}

step "A production site before its DNS exists, from the image alone"
if port_free 80 && port_free 443; then
    new_site e2e-production
    S=$SITE
    mkdir -p "$S/caddy/global"
    printf 'acme_ca https://acme-staging-v02.api.letsencrypt.org/directory\n' >"$S/caddy/global/staging.caddy"
    run install_alone "$S" --domain "$DOMAIN" --email ops@example.com
    expect_status 0
    production_checks
    ok "Caddy serves the name on the site network and on the host's port 80; HTTPS pending"
    grep -q $'^\ttls ops@example.com$' "$S/caddy/sites/site.caddy" || fail "--email did not reach the routes" "$(cat "$S/caddy/sites/site.caddy")"
    [[ $(cat "$S/caddy/global/staging.caddy") == 'acme_ca https://acme-staging-v02.api.letsencrypt.org/directory' ]] ||
        fail "the operator's global options were changed"
    [[ $(setting "$S" RESTART_POLICY) == unless-stopped && $(setting "$S" URL) == "https://$DOMAIN" ]] || fail "not configured as production"
    ok "the ACME email is rendered, and caddy/global/ is untouched"

    run "$S/ghost-docker" --dir "$S" check
    expect_status 0
    expect_output 'note +https +pending'
    ok "check passes and reports HTTPS as pending"
    compose_in "$S" down --volumes >/dev/null 2>&1
else
    skip "something on this host already holds 80 or 443"
fi

# --- Optional services, from the image alone ------------------------------------

step "ActivityPub and the analytics helpers, from the image alone"
new_site e2e-activitypub
AP=$SITE
run install_alone "$AP" --local --with activitypub
expect_status 0
run compose_in "$AP" ps --all --format '{{.Service}} {{.State}} {{.ExitCode}}'
expect_output '^activitypub running'
expect_output '^activitypub-migrate exited 0'
[[ $(setting "$AP" labs__publicAPI) == true ]] || fail "labs__publicAPI was not set"
ok "ActivityPub runs, its migration completed (mysql-init/ created its database)"
run compose_in "$AP" --profile analytics build tinybird-login tinybird-deploy
expect_status 0
ok "the analytics helper images build from the tinybird/ written there"
compose_in "$AP" down --volumes >/dev/null 2>&1

# --- From a clone ---------------------------------------------------------------

step "A local and a production site from a clone of the repository"
clone_of_this_checkout() {
    local target=$1
    mkdir -p "$target"
    (cd "$ROOT" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf -) | tar -x -C "$target"
    git -C "$target" init -q
    git -C "$target" add -A
    git -C "$target" -c user.email=e2e@example.com -c user.name=e2e commit -qm candidate
}
L=$WORK/sites/e2e-clone-local
SITES+=("$L")
clone_of_this_checkout "$L"
run "$L/ghost-docker" --dir "$L" install --local
expect_status 0
expect_output 'ok +ghost +healthy'
[[ -z $(git -C "$L" status --porcelain) ]] || fail "installing changed the checkout" "$(git -C "$L" status --porcelain)"
grep -q '"source": "checkout"' "$L/.ghost-docker.json" || fail "the metadata does not say checkout"
grep -q "\"commit\": \"$(git -C "$L" rev-parse HEAD)\"" "$L/.ghost-docker.json" || fail "the metadata does not record the commit"
[[ $(http_status "$(setting "$L" GHOST_PORT)") == 200 ]] || fail "the clone's site does not answer"
ok "local: the files are used in place, nothing tracked changed, and the commit is recorded"
compose_in "$L" down --volumes >/dev/null 2>&1

if port_free 80 && port_free 443; then
    C=$WORK/sites/e2e-clone-production
    SITES+=("$C")
    clone_of_this_checkout "$C"
    mkdir -p "$C/caddy/global"
    printf 'acme_ca https://acme-staging-v02.api.letsencrypt.org/directory\n' >"$C/caddy/global/staging.caddy"
    run "$C/ghost-docker" --dir "$C" install --domain "$DOMAIN"
    expect_status 0
    production_checks
    [[ -z $(git -C "$C" status --porcelain) ]] || fail "installing changed the checkout" "$(git -C "$C" status --porcelain)"
    ok "production: routing passes and HTTPS is pending"
    compose_in "$C" down --volumes >/dev/null 2>&1
else
    skip "production from a clone: something on this host already holds 80 or 443"
fi

printf '\nAll install checks passed.\n'
