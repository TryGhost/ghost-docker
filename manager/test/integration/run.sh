#!/usr/bin/env bash
# The manager's integration tests, against the real daemon and real services.
#
#   manager/test/integration/run.sh        (or: pnpm run test:integration)
#
# What the unit tests cannot fake honestly: how the daemon attaches a running
# container to a network, what names resolve on it afterwards, whether the
# network can be removed once the manager has left, and whether the clients
# really talk to MySQL and Caddy. The manager joins its own
# container to a site's network, so the tests run where it does: in a
# container, the manager Dockerfile's `integration` stage (the pinned Node,
# the production dependencies and Compose, with the source, the tests and the
# stack files), with the Docker socket mounted. The image that ships is the
# e2e scripts' to test; this tests the code against the real daemon.
#
# It pulls the MySQL and Caddy images compose.yml pins and binds no
# host port. It fails, rather than skipping, when no daemon answers.
set -euo pipefail

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
ROOT=$(CDPATH='' cd -- "$HERE/../../.." && pwd -P)
IMAGE=ghost-docker:integration
SOCKET=${GD_DOCKER_SOCKET:-/var/run/docker.sock}
# Every project, network and volume of this run is named gd-it-RUN-...
RUN=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')

if ! docker info >/dev/null 2>&1; then
    printf 'integration tests need a Docker daemon, and none answers here\n' >&2
    exit 1
fi

docker build --quiet --file "$ROOT/manager/Dockerfile" --target integration --tag "$IMAGE" "$ROOT" >/dev/null

# Site directories are mounted at their own path, as the launcher mounts a
# site, because the daemon resolves Compose's bind mounts on the host.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/gd-integration.XXXXXXXX")
WORK=$(CDPATH='' cd -- "$WORK" && pwd -P)

cleanup() {
    # What a run that did not finish left behind. The tests take their sites
    # down themselves; this only matters when they could not.
    docker ps --all --format '{{.ID}} {{.Label "com.docker.compose.project"}}' |
        awk -v prefix="gd-it-$RUN-" 'index($2, prefix) == 1 { print $1 }' |
        xargs -r docker rm --force --volumes >/dev/null 2>&1 || true
    docker network ls --format '{{.Name}}' | grep "^gd-it-$RUN-" |
        xargs -r docker network rm >/dev/null 2>&1 || true
    docker volume ls --format '{{.Name}}' | grep "^gd-it-$RUN-" |
        xargs -r docker volume rm >/dev/null 2>&1 || true
    # MySQL's files belong to its own user: removed from a container.
    docker run --rm --volume "$WORK:$WORK" --entrypoint find "$IMAGE" "$WORK" -mindepth 1 -delete \
        >/dev/null 2>&1 || true
    rmdir "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

tty=()
[[ ! -t 1 ]] || tty=(--tty)

docker run --rm --init ${tty[@]+"${tty[@]}"} \
    --volume "$SOCKET:/var/run/docker.sock" \
    --volume "$WORK:$WORK" \
    --env "GD_INTEGRATION_DIR=$WORK" \
    --env "GD_INTEGRATION_RUN=$RUN" \
    "$IMAGE"
