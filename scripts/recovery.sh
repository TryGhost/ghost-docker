#!/usr/bin/env bash
# Private recovery checkpoints (not portable migration bundles).
#
#   scripts/recovery.sh backup [--keep N]
#   scripts/recovery.sh restore CHECKPOINT --project NAME [--local --port PORT]
#   scripts/recovery.sh activate          expose a verified restored site
#   scripts/recovery.sh recover           reconcile an interrupted operation
#   scripts/recovery.sh status
#
# Run from the destination checkout for restore. It must be fresh. Restore
# remains isolated until activate. See docs/recovery.md before a restore drill.
set -euo pipefail
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "$0")/lib/common.sh"
cmd=${1:---help}
if (($#)); then shift; fi
case "$cmd" in
    --help | -h | help) usage; exit 0 ;;
    status)
        if [[ -f $GD_ROOT_DIR/.ghost-operation.json ]]; then
            jq '{id,kind,phase,updatedAt,checkpoint,error}' "$GD_ROOT_DIR/.ghost-operation.json"
        else
            printf 'No unfinished operation.\n'
        fi
        if [[ -d $GD_ROOT_DIR/.ghost-operation-lock ]]; then printf 'Operation lock exists.\n'; fi
        exit 0 ;;
    backup | restore | recover | activate) ;;
    *) usage >&2; exit 2 ;;
esac
[[ -z ${GD_COMPOSE_OVERRIDES:-} && -z ${COMPOSE_FILE:-} ]] || {
    printf 'Recovery does not support Compose overrides.\n' >&2; exit 1;
}
# Docker Desktop and OrbStack expose local Unix sockets with host path sharing.
if [[ -n ${DOCKER_CONTEXT:-} ]]; then
    endpoint=$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')
else
    endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
fi
[[ $endpoint == unix://* && -S ${endpoint#unix://} ]] || {
    printf 'Recovery requires a local Unix-socket Docker context.\n' >&2; exit 1;
}
security=$(docker info --format '{{json .SecurityOptions}}')
[[ $security != *rootless* && $security != *userns* ]] || {
    printf 'Rootless/userns recovery has not been validated and is unsupported.\n' >&2; exit 1;
}
recovery=false
[[ $cmd != recover && $cmd != activate ]] || recovery=true
operation_acquire "$GD_ROOT_DIR" "$recovery"
trap operation_release EXIT

# Release users can select a published digest. Source checkouts build the
# checked-out implementation; run by immutable image ID, never by a mutable tag.
if [[ -n ${GD_MANAGER_IMAGE:-} ]]; then
    [[ $GD_MANAGER_IMAGE == *@sha256:* || $GD_MANAGER_IMAGE == sha256:* ]] || {
        printf 'GD_MANAGER_IMAGE must be an immutable digest or local image ID.\n' >&2; exit 1;
    }
    docker image inspect "$GD_MANAGER_IMAGE" >/dev/null 2>&1 || docker pull "$GD_MANAGER_IMAGE" >&2
    manager_image=$(docker image inspect --format '{{.Id}}' "$GD_MANAGER_IMAGE")
else
    docker build -q -f "$GD_ROOT_DIR/manager/Dockerfile" "$GD_ROOT_DIR" >"$GD_ROOT_DIR/.ghost-manager-image"
    manager_image=$(cat "$GD_ROOT_DIR/.ghost-manager-image")
fi
args=(--mount "type=bind,source=$GD_ROOT_DIR,target=$GD_ROOT_DIR"
      --mount "type=bind,source=${endpoint#unix://},target=/var/run/docker.sock")
if [[ $cmd == restore ]]; then
    (($#)) || { usage >&2; exit 2; }
    checkpoint=$(CDPATH='' cd -- "$1" && pwd -P)
    shift
    [[ $checkpoint != "$GD_ROOT_DIR" && $GD_ROOT_DIR != "$checkpoint/"* ]] || exit 2
    args+=(--mount "type=bind,source=$checkpoint,target=/checkpoint,readonly")
    set -- /checkpoint "$@"
fi
# Recover needs the original checkpoint, which is recorded as a host path.
if [[ $cmd == recover && -f $GD_ROOT_DIR/.ghost-operation.json ]]; then
    checkpoint=$(jq -r '.sourcePath // empty' "$GD_ROOT_DIR/.ghost-operation.json")
    if [[ -n $checkpoint ]]; then
        args+=(--mount "type=bind,source=$checkpoint,target=/checkpoint,readonly")
    fi
fi
manager_name="ghost-recovery-$$-$RANDOM"
docker info --format '{{.ID}}' >"$GD_OPERATION_LOCK/daemon"
printf '%s\n' "$manager_name" >"$GD_OPERATION_LOCK/manager"
docker run --rm --name "$manager_name" --init \
    "${args[@]}" \
    -e "GD_SITE=$GD_ROOT_DIR" -e "GD_OWNER_UID=$(id -u)" -e "GD_OWNER_GID=$(id -g)" \
    -e "GD_DAEMON_ID=$(cat "$GD_OPERATION_LOCK/daemon")" \
    -e "GD_MANAGER_IMAGE=$manager_image" -e "GD_CHECKPOINT_SOURCE=${checkpoint:-}" \
    "$manager_image" "$cmd" "$@"
