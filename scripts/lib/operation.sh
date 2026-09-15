#!/usr/bin/env bash
# One host-visible lock for every supported mutating entrypoint. Never expire
# a lock by age. A dead owner needs explicit `recovery.sh recover`.
operation_acquire() {
    local dir=$1 recovery=${2:-false} lock pid manager state daemon
    lock=$dir/.ghost-operation-lock
    if [[ -e $dir/.ghost-operation.json && $recovery != true ]]; then
        printf 'An unfinished operation requires scripts/recovery.sh recover.\n' >&2
        return 1
    fi
    if ! mkdir -m 700 "$lock" 2>/dev/null; then
        [[ $recovery == true && -d $lock && ! -L $lock ]] || {
            printf 'Site is locked; use scripts/recovery.sh recover after its owner exits.\n' >&2
            return 1
        }
        # Missing/partial owner records are ambiguous and require inspection.
        pid=$(cat "$lock/pid") || return 1
        [[ $pid =~ ^[0-9]+$ ]] || return 1
        if kill -0 "$pid" 2>/dev/null || ps -p "$pid" >/dev/null 2>&1; then
            printf 'Refusing to steal a live operation lock (PID %s).\n' "$pid" >&2
            return 1
        fi
        manager=$(cat "$lock/manager" 2>/dev/null) || manager=""
        if [[ -n $manager ]]; then
            daemon=$(docker info --format '{{.ID}}' 2>/dev/null) || return 1
            [[ -f $lock/daemon && $(cat "$lock/daemon") == "$daemon" ]] || {
                printf 'Use the Docker daemon that owns this operation lock.\n' >&2
                return 1
            }
            state=$(docker inspect --format '{{.State.Running}}' "$manager" 2>/dev/null) || state=false
            [[ $state == false ]] || { printf 'The manager is still running.\n' >&2; return 1; }
        fi
        mkdir "$lock/reclaim" 2>/dev/null || return 1
        rm -f "$lock/pid" "$lock/manager" "$lock/daemon"
        rmdir "$lock/reclaim" "$lock" || return 1
        mkdir -m 700 "$lock" || return 1
    fi
    printf '%s\n' "$$" >"$lock/pid"
    GD_OPERATION_LOCK=$lock
    export GD_OPERATION_LOCK
    # The journal may have appeared between the first check and mkdir.
    if [[ -e $dir/.ghost-operation.json && $recovery != true ]]; then
        operation_release
        printf 'An unfinished operation requires scripts/recovery.sh recover.\n' >&2
        return 1
    fi
}

operation_release() {
    [[ -n ${GD_OPERATION_LOCK:-} ]] || return 0
    local pid manager running
    manager=$(cat "$GD_OPERATION_LOCK/manager" 2>/dev/null) || manager=""
    if [[ -n $manager ]]; then
        docker info >/dev/null 2>&1 || return 0
        running=$(docker inspect --format '{{.State.Running}}' "$manager" 2>/dev/null) || running=false
        [[ $running == false ]] || return 0
    fi
    pid=$(cat "$GD_OPERATION_LOCK/pid" 2>/dev/null) || return 0
    [[ $pid == "$$" ]] || return 0
    rm -f "$GD_OPERATION_LOCK/pid" "$GD_OPERATION_LOCK/manager" "$GD_OPERATION_LOCK/daemon"
    rmdir "$GD_OPERATION_LOCK" 2>/dev/null || true
}
