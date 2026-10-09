#!/usr/bin/env bash
# The bash launcher, end to end.
#
#   tests/e2e/launcher.sh
#
# Two halves. The first needs no Docker at all: it puts a stand-in `docker` on
# the PATH and checks what the launcher says when Docker cannot be used, and
# exactly how it would start the manager. The second builds the real image
# from this checkout and runs it, and is skipped with a message when there is
# no daemon.
#
# Exits non-zero at the first check that fails, naming it.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
LAUNCHER=$ROOT/ghost-docker
BASH_BIN=${GD_TEST_BASH:-$(command -v bash)}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ghost-docker-launcher-e2e.XXXXXXXX")
WORK=$(CDPATH='' cd -- "$WORK" && pwd -P)
CURRENT=setup
OUT=""
RC=0

cleanup() {
    local rc=$?
    case $WORK in */ghost-docker-launcher-e2e.*) rm -rf -- "$WORK" ;; esac
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
refute_output() { ! grep -qE -- "$1" <<<"$OUT" || fail "the output should not match: $1" "$OUT"; }

# --- A stand-in docker ---------------------------------------------------------
#
# FAKE_DOCKER selects how it behaves; every invocation is appended to
# $WORK/calls, one argument per line, so the `docker run` the launcher builds
# can be read back exactly.

FAKE=$WORK/fake-bin
mkdir "$FAKE"
cat >"$FAKE/docker" <<'FAKE_DOCKER'
#!/bin/sh
{ printf 'CALL\n'; for arg in "$@"; do printf '%s\n' "$arg"; done; } >>"$FAKE_CALLS"
case "$FAKE_DOCKER:$1" in
    down:info) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;;
    hang:info) sleep 30; exit 0 ;;
    rootless:info) echo "[name=seccomp,profile=builtin name=rootless]"; exit 0 ;;
    *:info) echo "[name=seccomp,profile=builtin]"; exit 0 ;;
    nocompose:compose) echo "docker: 'compose' is not a docker command." >&2; exit 1 ;;
    *:compose) echo "Docker Compose version v2.40.3"; exit 0 ;;
    *:context) echo "${FAKE_ENDPOINT:-unix:///var/run/docker.sock}"; exit 0 ;;
    *:build) echo "sha256:built"; exit 0 ;;
    *:run) exit "${FAKE_RUN_STATUS:-0}" ;;
esac
exit 0
FAKE_DOCKER
chmod +x "$FAKE/docker"
export FAKE_CALLS=$WORK/calls

# with_fake MODE COMMAND...
with_fake() {
    local mode=$1
    shift
    : >"$FAKE_CALLS"
    run env FAKE_DOCKER="$mode" PATH="$FAKE:$PATH" "$@"
}

# The arguments of the last `docker run`, one per line.
run_args() {
    awk '/^CALL$/ { block = ""; next } { block = block $0 "\n" } END { printf "%s", block }' "$FAKE_CALLS"
}
expect_run_arg() { run_args | grep -qxF -- "$1" || fail "docker run was not given: $1" "$(run_args)"; }

SITE=$WORK/site
mkdir "$SITE"
# A Linux socket path the launcher will accept without a daemon.
SOCKET_DIR=$WORK/run
mkdir "$SOCKET_DIR"

# --- Without Docker --------------------------------------------------------------

step "Docker is not installed"
EMPTY=$WORK/empty-bin
mkdir "$EMPTY"
for tool in uname dirname sleep id; do ln -s "$(command -v "$tool")" "$EMPTY/$tool"; done
run env PATH="$EMPTY" "$BASH_BIN" "$LAUNCHER" version
expect_status 1
expect_output 'Docker is not installed'
expect_output 'docs\.docker\.com/get-docker'
ok "says so, and where to get it"

step "The daemon is not running"
with_fake down "$BASH_BIN" "$LAUNCHER" --dir "$SITE" version
expect_status 1
expect_output 'the Docker daemon is not reachable'
refute_output 'docker run'
ok "says so, and starts nothing"

step "The daemon does not answer"
with_fake hang env GD_DOCKER_TIMEOUT=1 "$BASH_BIN" "$LAUNCHER" --dir "$SITE" version
expect_status 1
expect_output 'did not answer within 1 seconds'
ok "gives up after the deadline instead of hanging"

step "Compose is not installed"
with_fake nocompose "$BASH_BIN" "$LAUNCHER" --dir "$SITE" version
expect_status 1
expect_output 'the Docker Compose plugin is not installed'
ok "says so"

step "A shell that cannot run it"
GITBASH=$WORK/gitbash-bin
mkdir "$GITBASH"
printf '#!/bin/sh\necho MINGW64_NT-10.0-22631\n' >"$GITBASH/uname"
chmod +x "$GITBASH/uname"
run env PATH="$GITBASH:$FAKE:$PATH" FAKE_DOCKER=ok "$BASH_BIN" "$LAUNCHER" version
expect_status 1
expect_output 'WSL2'
ok "Git Bash is pointed at WSL2"

step "The site directory"
with_fake ok "$BASH_BIN" "$LAUNCHER" --dir "$WORK/no-such-directory" version
expect_status 2
expect_output 'is not a directory'
with_fake ok "$BASH_BIN" "$LAUNCHER" --dir
expect_status 2
expect_output '--dir needs a path'
ok "a missing directory and a missing value are usage errors"

if [[ $(uname -s) == Linux ]]; then
    step "A remote daemon"
    with_fake ok env DOCKER_HOST=tcp://10.0.0.5:2376 "$BASH_BIN" "$LAUNCHER" --dir "$SITE" version
    expect_status 1
    expect_output 'remote daemon \(tcp://10\.0\.0\.5:2376\)'
    ok "is refused: its bind mounts would be on another machine"
fi

# From here the stand-in accepts everything, and the question is what the
# launcher asks it to run. On Linux the socket has to exist to be accepted.
fake_socket_env=()
if [[ $(uname -s) == Linux ]]; then
    python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$SOCKET_DIR/docker.sock"
    fake_socket_env=(DOCKER_HOST="unix://$SOCKET_DIR/docker.sock")
    expected_socket=$SOCKET_DIR/docker.sock
else
    expected_socket=/var/run/docker.sock
fi

step "How the manager is started"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} GD_IMAGE=example/manager:1 \
    "$BASH_BIN" "$LAUNCHER" --dir "$SITE" doctor --json
expect_status 0
expect_run_arg "$expected_socket:/var/run/docker.sock"
expect_run_arg "$SITE:$SITE"
expect_run_arg "GD_SITE_DIR=$SITE"
expect_run_arg "GD_UID=$(id -u)"
expect_run_arg "GD_GID=$(id -g)"
expect_run_arg "GD_ROOTLESS=0"
expect_run_arg "GD_HOST_OS=$(uname -s)"
expect_run_arg "GD_SOURCE=image"
expect_run_arg "example/manager:1"
[[ $(run_args | tail -3) == $'example/manager:1\ndoctor\n--json' ]] ||
    fail "the image and the command are not the last arguments, in order" "$(run_args)"
run_args | grep -qxF -- '--tty' && fail "a terminal was attached with none present" "$(run_args)"
ok "socket, site directory at its own path, identity, then the image and the command"

step "The site directory is resolved, and defaults to the current directory"
ln -s "$SITE" "$WORK/link-to-site"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} GD_IMAGE=example/manager:1 \
    "$BASH_BIN" "$LAUNCHER" --dir="$WORK/link-to-site" version
expect_run_arg "$SITE:$SITE"
(cd "$SITE" && with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} GD_IMAGE=example/manager:1 \
    "$BASH_BIN" "$LAUNCHER" version && expect_run_arg "$SITE:$SITE")
ok "a symlinked path is mounted as the real one"

step "Compose overrides reach the manager"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} GD_IMAGE=example/manager:1 \
    GD_COMPOSE_OVERRIDES=compose.ipv6.yml "$BASH_BIN" "$LAUNCHER" --dir "$SITE" version
expect_run_arg "GD_COMPOSE_OVERRIDES=compose.ipv6.yml"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} GD_IMAGE=example/manager:1 \
    "$BASH_BIN" "$LAUNCHER" --dir "$SITE" version
run_args | grep -q '^GD_COMPOSE_OVERRIDES=' && fail "an unset GD_COMPOSE_OVERRIDES was passed" "$(run_args)"
ok "GD_COMPOSE_OVERRIDES is passed when set, and only then"

step "A bundle to import is mounted read-only at its own path"
mkdir -p "$WORK/exports/bundle-dir"
: >"$WORK/exports/bundle.tgz"
ln -s "$WORK/exports" "$WORK/link-to-exports"
(cd "$WORK" && with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} GD_IMAGE=example/manager:1 \
    "$BASH_BIN" "$LAUNCHER" --dir "$SITE" install --import link-to-exports/bundle.tgz --no-start &&
    expect_run_arg "$WORK/exports/bundle.tgz:$WORK/exports/bundle.tgz:ro" &&
    expect_run_arg "$WORK/exports/bundle.tgz")
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} GD_IMAGE=example/manager:1 \
    GD_IMPORT_KEEP_FAILED=1 "$BASH_BIN" "$LAUNCHER" --dir "$SITE" install --import="$WORK/link-to-exports/bundle-dir"
expect_run_arg "$WORK/exports/bundle-dir:$WORK/exports/bundle-dir:ro"
expect_run_arg "--import"
expect_run_arg "GD_IMPORT_KEEP_FAILED=1"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} GD_IMAGE=example/manager:1 \
    "$BASH_BIN" "$LAUNCHER" --dir "$SITE" install --import "$WORK/missing.tgz"
expect_run_arg "$WORK/missing.tgz"
run_args | grep -q ':ro$' && fail "a bundle that does not exist was mounted" "$(run_args)"
ok "resolved, mounted read-only and passed by that path; a missing one is left to the manager"

step "A backup to restore is mounted read-only, unless it is in the site"
mkdir -p "$WORK/elsewhere/backups/2026-10-09T10-00-00Z" "$SITE/backups/2026-10-09T11-00-00Z"
(cd "$WORK" && with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} GD_IMAGE=example/manager:1 \
    "$BASH_BIN" "$LAUNCHER" --dir "$SITE" restore --yes elsewhere/backups/2026-10-09T10-00-00Z &&
    expect_run_arg "$WORK/elsewhere/backups/2026-10-09T10-00-00Z:$WORK/elsewhere/backups/2026-10-09T10-00-00Z:ro" &&
    expect_run_arg "$WORK/elsewhere/backups/2026-10-09T10-00-00Z" &&
    expect_run_arg "--yes")
(cd "$SITE" && with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} GD_IMAGE=example/manager:1 \
    "$BASH_BIN" "$LAUNCHER" restore backups/2026-10-09T11-00-00Z &&
    expect_run_arg "$SITE/backups/2026-10-09T11-00-00Z")
run_args | grep -q ':ro$' && fail "a backup inside the site was mounted again" "$(run_args)"
rm -rf "$WORK/elsewhere" "$SITE/backups"
ok "one outside the site is mounted at its own path; one inside it is passed by its path"

step "Rootless Docker"
with_fake rootless env ${fake_socket_env[@]+"${fake_socket_env[@]}"} GD_IMAGE=example/manager:1 \
    "$BASH_BIN" "$LAUNCHER" --dir "$SITE" version
expect_run_arg "GD_ROOTLESS=1"
ok "is passed on, so the manager does not drop to a subordinate uid"

step "Which image"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} "$BASH_BIN" "$LAUNCHER" --dir "$SITE" version
expect_run_arg "ghost-docker:checkout"
expect_run_arg "GD_SOURCE=checkout"
grep -qx 'build' "$FAKE_CALLS" || fail "a checkout did not build its image" "$(cat "$FAKE_CALLS")"
ok "a checkout builds from itself"

cp "$LAUNCHER" "$WORK/standalone-launcher"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} "$BASH_BIN" "$WORK/standalone-launcher" --dir "$SITE" version
expect_run_arg "ghcr.io/tryghost/ghost-docker:beta"
expect_run_arg "GD_SOURCE=image"
expect_run_arg "GD_CHANNEL=beta"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} GD_CHANNEL=edge "$BASH_BIN" "$WORK/standalone-launcher" --dir "$SITE" version
expect_run_arg "ghcr.io/tryghost/ghost-docker:edge"
ok "outside a checkout, the published channel: beta, or GD_CHANNEL"

step "Choosing a release"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} "$BASH_BIN" "$LAUNCHER" --dir "$SITE" install --local --channel stable
expect_run_arg "ghcr.io/tryghost/ghost-docker:stable"
expect_run_arg "GD_CHANNEL=stable"
expect_run_arg "--pull"
grep -qx 'build' "$FAKE_CALLS" && fail "a channel was asked for, and the checkout was built" "$(cat "$FAKE_CALLS")"
[[ $(run_args | tail -5) == $'ghcr.io/tryghost/ghost-docker:stable\ninstall\n--local\n--channel\nstable' ]] ||
    fail "--channel is not passed on to the command" "$(run_args)"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} "$BASH_BIN" "$LAUNCHER" --dir "$SITE" install --release=v1.10.0-beta.2
expect_run_arg "ghcr.io/tryghost/ghost-docker:v1.10.0-beta.2"
expect_run_arg "--release=v1.10.0-beta.2"
run_args | grep -qx -- '--pull' && fail "a release, whose tag never moves, was pulled every time" "$(run_args)"
run_args | grep -q '^GD_CHANNEL=' && fail "a release was named, and a channel was passed on" "$(run_args)"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} "$BASH_BIN" "$LAUNCHER" --dir "$SITE" self-update --to v2.0.0
expect_run_arg "ghcr.io/tryghost/ghost-docker:v2.0.0"
ok "--channel, --release and --to choose the image, and reach the command"

for bad in "--channel nightly" "--channel" "--release 1.2.3" "--release v1.2" "--to v1.2.3-rc.1" "--release v01.2.3" "--channel beta --release v1.0.0"; do
    # shellcheck disable=SC2086 # split on purpose
    with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} "$BASH_BIN" "$LAUNCHER" --dir "$SITE" install $bad
    expect_status 2
    grep -qx 'run' "$FAKE_CALLS" && fail "$bad: the manager was started" "$(cat "$FAKE_CALLS")"
done
ok "only stable, beta, vX.Y.Z and vX.Y.Z-beta.N are accepted, before Docker is asked anything"

with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} "$BASH_BIN" "$WORK/standalone-launcher" --dir "$SITE" version
expect_run_arg "--pull"
expect_run_arg "always"
ok "a channel is pulled every time it runs"

sed 's|^readonly GD_PINNED_IMAGE=""$|readonly GD_PINNED_IMAGE="ghcr.io/tryghost/ghost-docker@sha256:abc123"|' \
    "$LAUNCHER" >"$WORK/pinned-launcher"
grep -q 'sha256:abc123' "$WORK/pinned-launcher" || fail "the pin placeholder is not where install will look for it"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} "$BASH_BIN" "$WORK/pinned-launcher" --dir "$SITE" version
expect_run_arg "ghcr.io/tryghost/ghost-docker@sha256:abc123"
run_args | grep -qx -- '--pull' && fail "a pinned digest was pulled by the launcher" "$(run_args)"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} GD_IMAGE=example/manager:1 "$BASH_BIN" "$WORK/standalone-launcher" --dir "$SITE" version
run_args | grep -qx -- '--pull' && fail "an image named with GD_IMAGE was pulled" "$(run_args)"
ok "a site's own copy runs the digest it was pinned to; neither it nor GD_IMAGE is pulled"

sed 's|^readonly GD_PINNED_CHANNEL=""$|readonly GD_PINNED_CHANNEL="stable"|' "$WORK/pinned-launcher" >"$WORK/pinned-stable"
grep -qx 'readonly GD_PINNED_CHANNEL="stable"' "$WORK/pinned-stable" ||
    fail "the channel placeholder is not where install will look for it"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} "$BASH_BIN" "$WORK/pinned-stable" --dir "$SITE" self-update
expect_run_arg "ghcr.io/tryghost/ghost-docker:stable"
expect_run_arg "GD_CHANNEL=stable"
expect_run_arg "--pull"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} "$BASH_BIN" "$WORK/pinned-stable" --dir "$SITE" self-update --check
expect_run_arg "ghcr.io/tryghost/ghost-docker:stable"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} "$BASH_BIN" "$WORK/pinned-stable" --dir "$SITE" self-update --channel beta
expect_run_arg "ghcr.io/tryghost/ghost-docker:beta"
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} "$BASH_BIN" "$WORK/pinned-stable" --dir "$SITE" check
expect_run_arg "ghcr.io/tryghost/ghost-docker@sha256:abc123"
# `update` is not the stack's: it runs the site's own pin like any other command.
with_fake ok env ${fake_socket_env[@]+"${fake_socket_env[@]}"} "$BASH_BIN" "$WORK/pinned-stable" --dir "$SITE" update
expect_run_arg "ghcr.io/tryghost/ghost-docker@sha256:abc123"
ok "a site's self-update runs the newest release on the channel it follows, not its pin"

step "Piped from curl"
set +e
OUT=$(FAKE_DOCKER=ok PATH="$FAKE:$PATH" env ${fake_socket_env[@]+"${fake_socket_env[@]}"} \
    "$BASH_BIN" -s -- --dir "$SITE" version <"$LAUNCHER" 2>&1)
RC=$?
set -e
expect_status 0
expect_run_arg "ghcr.io/tryghost/ghost-docker:beta"
ok "runs with no file of its own, and uses the published image"

step "The manager's exit status"
for status in 0 1 2 3; do
    : >"$FAKE_CALLS"
    run env FAKE_DOCKER=ok FAKE_RUN_STATUS=$status PATH="$FAKE:$PATH" ${fake_socket_env[@]+"${fake_socket_env[@]}"} \
        GD_IMAGE=example/manager:1 "$BASH_BIN" "$LAUNCHER" --dir "$SITE" anything
    expect_status "$status"
done
ok "0, 1, 2 and 3 each reach the caller unchanged"

# --- With Docker -------------------------------------------------------------------

if ! docker info >/dev/null 2>&1; then
    printf '\n== The real image\n   SKIPPED: no Docker daemon is reachable\n'
    printf '\nAll checks passed (real image skipped).\n'
    exit 0
fi

step "Build from this checkout and run"
run "$LAUNCHER" --dir "$SITE" version
expect_status 0
expect_output '^ghost-docker checkout'
ok "$OUT"

run "$LAUNCHER" --dir "$SITE" doctor
expect_status 0
for label in 'manager' 'docker engine' 'platform' 'docker compose' 'site directory' 'identity' 'writable' 'bind mounts'; do
    expect_output "ok +$label"
done
refute_output 'ERROR|warning'
[[ -z $(ls -A "$SITE") ]] || fail "doctor left something in the site directory" "$(ls -A "$SITE")"
ok "doctor passes, a sibling container sees the site directory, and nothing is left in it"

commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf '')
if [[ -n $commit ]]; then
    docker image inspect "ghost-docker:checkout-${commit:0:12}" >/dev/null 2>&1 ||
        fail "the image built from this checkout was not also tagged with its commit"
    ok "the image is also tagged ghost-docker:checkout-${commit:0:12}"
fi

step "Files the manager writes belong to the caller"
run "$LAUNCHER" --dir "$SITE" doctor --keep-probe
expect_status 0
probe=$SITE/.ghost-docker-probe
[[ -f $probe ]] || fail "the probe file was not left" "$OUT"
owner=$(stat -c '%u:%g' "$probe" 2>/dev/null || stat -f '%u:%g' "$probe")
[[ ${owner%%:*} == "$(id -u)" ]] || fail "the probe belongs to uid ${owner%%:*}, not $(id -u)" "$OUT"
[[ -O $probe ]] || fail "this user does not own the probe file"
rm -f "$probe"
ok "owned by uid $(id -u) on the host, and removable without privileges"

step "Exit statuses, through the real launcher and image"
run "$LAUNCHER" --dir "$SITE" frobnicate
expect_status 2
expect_output 'unknown command: frobnicate'
run "$LAUNCHER" --dir "$SITE" doctor --bogus
expect_status 2
expect_output 'ghost-docker doctor --help'
run "$LAUNCHER" --dir "$SITE" help
expect_status 0
expect_output 'USAGE'
expect_output 'ghost-docker doctor'
ok "2 for a usage error, 0 for help"

step "The image, as a published one would be used"
with_dir=$WORK/elsewhere
mkdir "$with_dir"
cp "$LAUNCHER" "$with_dir/ghost-docker"
run env GD_IMAGE=ghost-docker:checkout "$with_dir/ghost-docker" --dir "$SITE" doctor
expect_status 0
expect_output 'from a published image'
ok "runs with no checkout beside the launcher"

step "The stack's files are in the image"
run docker run --rm --entrypoint sh ghost-docker:checkout -c \
    'cd /opt/ghost-docker/stack && ls compose.yml caddy/Caddyfile caddy/snippets .env.example ghost.env.example mysql-init >/dev/null && docker-compose version --short && node --version'
expect_status 0
ok "compose.yml, Caddy configuration and examples; Compose and Node present"

step "The stack in the image resolves"
run docker run --rm --entrypoint sh \
    -e URL=http://localhost:2368 -e DATABASE_PASSWORD=x -e DATABASE_ROOT_PASSWORD=y -e COMPOSE_PROFILES=local \
    ghost-docker:checkout -c 'docker-compose -f /opt/ghost-docker/stack/compose.yml config --quiet'
expect_status 0
ok "docker-compose config accepts it, using the image's own Compose"

step "The image holds everything compose.yml refers to"
# The release payload is defined by the Compose file, not by a list: every
# bind mount source and build context it names, with every profile on, has to
# be in the image. Data directories are created at install and are exempt.
# shellcheck disable=SC2016  # a Node program, not shell
run docker run --rm --entrypoint sh \
    -e URL=https://example.com -e DATABASE_PASSWORD=x -e DATABASE_ROOT_PASSWORD=y \
    -e COMPOSE_PROFILES=production,analytics,activitypub \
    ghost-docker:checkout -c 'cd /opt/ghost-docker/stack && docker-compose -f compose.yml config --format json | node -e "
const fs = require(\"fs\");
const project = JSON.parse(fs.readFileSync(0, \"utf8\"));
const stack = process.cwd() + \"/\";
const missing = [];
let checked = 0;
for (const [name, service] of Object.entries(project.services)) {
  const paths = (service.volumes || []).filter((v) => v.type === \"bind\").map((v) => v.source);
  if (service.build) paths.push(service.build.context);
  for (const path of paths) {
    if (!path.startsWith(stack) || path.startsWith(stack + \"data/\")) continue;
    checked += 1;
    if (!fs.existsSync(path)) missing.push(name + \": \" + path.slice(stack.length));
  }
}
if (missing.length) { console.error(\"not in the image:\\n\" + missing.join(\"\\n\")); process.exit(1); }
console.log(checked + \" paths\");
"'
expect_status 0
expect_output '^[1-9][0-9]* paths$'
ok "every bind mount and build context of every profile ($OUT)"

printf '\nAll checks passed.\n'
