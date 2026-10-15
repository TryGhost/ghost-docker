#!/usr/bin/env bash
# The whole Admin update flow, by hand, on this machine: Ghost Admin asks the
# upgrade supervisor for an update, and the supervisor performs it. Not run in
# CI: it needs Ghost builds with the update API and Admin UI, and a person to
# click through Admin.
#
#   tests/e2e/admin-update-local.sh --ghost PATH [--from 6.72.0] [--to 6.72.1]
#   tests/e2e/admin-update-local.sh --from-image IMAGE --to-image IMAGE
#
# With --ghost, it builds Ghost's `selfhost` image twice from that checkout
# (Dockerfile.production), as the versions --from and --to, by setting
# ghost/package.json's version for each build and putting it back after. Build
# Ghost Admin in the checkout first: the image copies ghost/core/built/admin.
# With --from-image and --to-image, it uses two images you built, whose
# GHOST_VERSION must be the older and the newer release.
#
# It then:
#   1. runs a registry on localhost:REGISTRY_PORT (5050: macOS takes 5000) and
#      pushes the two builds as localhost:PORT/ghost:<version>-local, and the
#      newer one as <major>-local too, the tag discovery looks for;
#   2. installs a local site on the older build with --with supervisor, from
#      a manager image built from this checkout;
#   3. turns on HttpUpgradeAdapter in ghost.env, which install leaves off
#      until a Ghost release ships the update API;
#   4. waits until the supervisor offers the newer build one-click,
# and stops there, printing the Admin URL and what to click. The site is left
# running; the teardown commands are printed at the end.
#
# Versions are plain releases, X.Y.Z: a prerelease such as 6.72.0-rc.0 would
# make its tag 6.72.0-rc.0-local, whose variant reads as `rc.0-local`. The two
# must be the same major, the newer one newer, and within a minor either policy
# offers it one-click.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
MANAGER=ghost-docker:admin-update-local
REGISTRY_PORT=${REGISTRY_PORT:-5050}
REGISTRY_NAME=ghost-docker-local-registry
REPOSITORY=localhost:$REGISTRY_PORT/ghost

GHOST=""
FROM=6.72.0
TO=6.72.1
FROM_IMAGE=""
TO_IMAGE=""
S=""

usage() {
    sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
}

while (($# > 0)); do
    case $1 in
        --ghost) GHOST=$2 && shift 2 ;;
        --from) FROM=$2 && shift 2 ;;
        --to) TO=$2 && shift 2 ;;
        --from-image) FROM_IMAGE=$2 && shift 2 ;;
        --to-image) TO_IMAGE=$2 && shift 2 ;;
        --dir) S=$2 && shift 2 ;;
        -h | --help) usage ;;
        *) printf 'unknown option: %s\n' "$1" >&2 && usage ;;
    esac
done

die() {
    printf '\nerror: %s\n' "$1" >&2
    exit 1
}
step() { printf '\n== %s\n' "$1"; }
ok() { printf '   ok    %s\n' "$1"; }

release() { [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }
major() { printf '%s' "${1%%.*}"; }
newer() { [[ $(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1) == "$2" && $1 != "$2" ]]; }

if [[ -n $GHOST ]]; then
    [[ -z $FROM_IMAGE && -z $TO_IMAGE ]] || die "choose --ghost or --from-image and --to-image, not both"
    GHOST=$(CDPATH='' cd -- "$GHOST" && pwd -P)
    [[ -f $GHOST/Dockerfile.production && -f $GHOST/ghost/package.json ]] ||
        die "$GHOST is not a Ghost checkout: Dockerfile.production or ghost/package.json is missing"
    [[ -d $GHOST/ghost/core/built/admin ]] ||
        die "Ghost Admin is not built in $GHOST (ghost/core/built/admin is missing); build it there first"
elif [[ -n $FROM_IMAGE && -n $TO_IMAGE ]]; then
    FROM=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$FROM_IMAGE" |
        sed -n 's/^GHOST_VERSION=//p')
    TO=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$TO_IMAGE" |
        sed -n 's/^GHOST_VERSION=//p')
else
    usage
fi
release "$FROM" || die "the older Ghost must be a plain release, X.Y.Z: got '$FROM'"
release "$TO" || die "the newer Ghost must be a plain release, X.Y.Z: got '$TO'"
[[ $(major "$FROM") == "$(major "$TO")" ]] || die "Ghost $FROM and $TO are different majors; update stays within one"
newer "$FROM" "$TO" || die "Ghost $TO is not newer than $FROM"

step "A registry on localhost:$REGISTRY_PORT"
if [[ -z $(docker ps -q --filter "name=^${REGISTRY_NAME}$") ]]; then
    docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
    docker run -d --name "$REGISTRY_NAME" -p "$REGISTRY_PORT:5000" registry:2 >/dev/null
fi
ok "$REGISTRY_NAME"

if [[ -n $GHOST ]]; then
    step "Ghost $FROM and $TO, built from $GHOST"
    package=$GHOST/ghost/package.json
    kept=$(mktemp "${TMPDIR:-/tmp}/ghost-package.XXXXXXXX")
    cp "$package" "$kept"
    trap 'cp "$kept" "$package"; rm -f "$kept"' EXIT
    for version in "$FROM" "$TO"; do
        node -e '
            const fs = require("fs");
            const [file, version] = process.argv.slice(1);
            const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
            pkg.version = version;
            fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
        ' "$package" "$version"
        docker build --file "$GHOST/Dockerfile.production" --target selfhost \
            --build-arg "GHOST_BUILD_VERSION=$version" --tag "$REPOSITORY:$version-local" "$GHOST"
        ok "$REPOSITORY:$version-local"
    done
    cp "$kept" "$package"
    rm -f "$kept"
    trap - EXIT
else
    step "Ghost $FROM and $TO, from $FROM_IMAGE and $TO_IMAGE"
    docker tag "$FROM_IMAGE" "$REPOSITORY:$FROM-local"
    docker tag "$TO_IMAGE" "$REPOSITORY:$TO-local"
    ok "tagged"
fi
docker tag "$REPOSITORY:$TO-local" "$REPOSITORY:$(major "$TO")-local"
for tag in "$FROM-local" "$TO-local" "$(major "$TO")-local"; do
    docker push --quiet "$REPOSITORY:$tag" >/dev/null
done
ok "pushed $FROM-local, $TO-local and $(major "$TO")-local"

step "The manager, built from this checkout"
commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf '')
docker build --quiet --file "$ROOT/manager/Dockerfile" --build-arg GD_VERSION=checkout \
    --build-arg "GD_COMMIT=$commit" --tag "$MANAGER" "$ROOT" >/dev/null
ok "$MANAGER"

step "A local site on Ghost $FROM, with the supervisor"
if [[ -z $S ]]; then
    S=$(mktemp -d "${TMPDIR:-/tmp}/ghost-docker-admin-update.XXXXXXXX")
fi
mkdir -p "$S"
S=$(CDPATH='' cd -- "$S" && pwd -P)
GD_IMAGE="$MANAGER" "$ROOT/ghost-docker" --dir "$S" install --local --ghost-image "$REPOSITORY" \
    --version "$FROM-local" --with supervisor --no-prompt
gd() { "$S/ghost-docker" --dir "$S" "$@"; }
compose_in() { docker compose --project-directory "$S" -f "$S/compose.yml" "$@"; }

step "Ghost's update adapter, on"
gd config set ghost.env adapters__upgrade__active HttpUpgradeAdapter >/dev/null
gd config set ghost.env adapters__upgrade__HttpUpgradeAdapter__socketPath \
    /run/ghost-upgrade/supervisor.sock >/dev/null
compose_in up --detach --wait ghost >/dev/null 2>&1 || die "Ghost did not start again with the adapter on"
ok "HttpUpgradeAdapter, on /run/ghost-upgrade/supervisor.sock"

step "The supervisor offers Ghost $TO one-click"
offered=""
for ((tick = 0; tick < 300; tick += 5)); do
    offered=$(gd supervisor status --json 2>/dev/null |
        jq -r '.status.oneClick[]? | select(.component == "ghost") | .toVersion' || true)
    [[ $offered == "$TO" ]] && break
    sleep 5
done
[[ $offered == "$TO" ]] || die "the supervisor does not offer Ghost $TO: $(gd supervisor status 2>&1)"
ok "Ghost $FROM to $TO"

url=$(gd config get .env URL)
cat <<EOF

Ready. Now, in a browser:

  1. Open $url/ghost/ and create the owner account.
  2. Settings → About: Ghost $TO is offered as an update. Run it, and watch
     it go through its stages to "Updated to $TO". Reload: the job's outcome
     is still shown.

To see an interrupted job, start another update and, while it runs:

  docker compose --project-directory $S -f $S/compose.yml kill supervisor
  docker compose --project-directory $S -f $S/compose.yml --profile supervisor up -d supervisor

The job then reads "interrupted", and the site lock stays for you: follow the
job's own steps (./ghost-docker check, then remove the lock) to clear it.

From the host, as Ghost sees it:

  $S/ghost-docker --dir $S supervisor status
  $S/ghost-docker --dir $S supervisor job <id>
  docker compose --project-directory $S -f $S/compose.yml logs -f supervisor

When you are done:

  docker compose --project-directory $S -f $S/compose.yml --profile '*' down --volumes
  docker run --rm --user 0 --entrypoint rm -v $(dirname "$S"):/work $MANAGER -rf /work/$(basename "$S")
  docker rm -f $REGISTRY_NAME
EOF
