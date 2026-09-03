#!/usr/bin/env bash
# Host preflight: everything that has to be true before a site can be installed
# or is worth diagnosing when one is broken.
#
# These checks run in host shell rather than in a container, deliberately: they
# have to work on a host where Docker is missing, stopped, or unreachable, so
# they cannot depend on being able to run an image. See section 2.10 of
# docs/ghost-cli-replacement.md.
#
# Every check prints one record, `STATUS<TAB>LABEL<TAB>DETAIL`, where STATUS is
# `ok`, `warn` or `error`. Callers render the records; `preflight_failed`
# decides the exit status. That keeps the checks free of presentation and makes
# them straightforward to assert on.
#
# Portability: no GNU-only utilities, no `sort -V`, no `ss`/`lsof`/`curl`
# requirement, and daemon access is established by using the daemon rather than
# by inspecting group membership.

# shellcheck disable=SC2034
GD_PREFLIGHT_LIB_LOADED=1

# Host commands the installer and helpers actually invoke. Anything not on this
# list must not appear in a code path an operator can reach; the minimum-tools
# test runs an install with a PATH containing only these.
readonly GD_REQUIRED_COMMANDS=(docker jq)

# Every other host utility the installer and helpers invoke. These are POSIX
# and present on any supported host, so they are not preflight checks; they are
# recorded here as the tool contract, and tests/install-e2e.test.mjs runs an
# install with a PATH built from exactly this list plus GD_REQUIRED_COMMANDS.
# Adding a utility to a code path without adding it here fails that test, which
# is the point: it is how a GNU-only or unusual dependency gets noticed.
readonly GD_HOST_UTILITIES=(
    awk basename bash cat chmod chown cp cut date df dirname env grep head id
    ls mkdir mktemp mv od rm sed sleep sort stat sysctl tr uname
)

# Recommended free space for a site: Ghost and MySQL images, the database, and
# uploaded content. Below this an install will probably succeed and then fail
# later, so it is a warning rather than a refusal.
readonly GD_RECOMMENDED_DISK_MB=5120
readonly GD_RECOMMENDED_MEMORY_MB=1024

# How long a read-only Docker probe may take before it is treated as
# unreachable. A daemon that has wedged does not return an error, it stops
# answering; without a bound, the check that exists to diagnose that hangs
# instead of reporting it.
GD_DOCKER_PROBE_TIMEOUT=${GD_DOCKER_PROBE_TIMEOUT:-20}

# _gd_timeout SECONDS COMMAND...
# Runs a command with a deadline, returning 124 when it is killed. `timeout(1)`
# is GNU coreutils and is not present on macOS, so this is spelled out.
_gd_timeout() {
    local seconds=$1 pid waited=0
    shift
    "$@" &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
        if ((waited >= seconds)); then
            kill -9 "$pid" 2>/dev/null
            wait "$pid" 2>/dev/null
            return 124
        fi
        sleep 1
        waited=$((waited + 1))
    done
    wait "$pid"
}

# _gd_docker SECONDS ARGS...
# `docker ARGS` with a deadline, printing what it wrote to stdout and stderr.
#
# The output goes through a temporary file rather than a pipe, deliberately: a
# docker client can leave a helper process behind holding the write end, and a
# command substitution then waits for that helper long after the client itself
# has been killed — which is exactly the wedged-daemon case this deadline
# exists to report.
_gd_docker() {
    local seconds=$1 tmp rc
    shift
    tmp=$(fs_mktemp_dir gd-docker)/out || return 1
    _gd_timeout "$seconds" docker "$@" >"$tmp" 2>&1 </dev/null
    rc=$?
    cat "$tmp" 2>/dev/null
    rm -rf "$(dirname "$tmp")"
    return $rc
}

# docker_responsive [SECONDS]
# True when the daemon answers within the deadline. This is the one question
# every other Docker check depends on, and it is answered by asking the daemon,
# never by inspecting group membership: neither rootless Docker nor a remote
# DOCKER_HOST involves the docker group, and being in it does not mean the
# daemon is running.
docker_responsive() {
    command -v docker >/dev/null 2>&1 || return 1
    _gd_docker "${1:-$GD_DOCKER_PROBE_TIMEOUT}" info >/dev/null 2>&1
}

# _gd_report STATUS LABEL DETAIL
_gd_report() {
    printf '%s\t%s\t%s\n' "$1" "$2" "$3"
}

# preflight_failed RECORDS
# True when any record is an error. Warnings never fail a preflight.
preflight_failed() {
    printf '%s\n' "$1" | grep -q '^error	'
}

# preflight_render RECORDS
# Renders records for a person. Errors and warnings go to stderr so that a
# caller can separate them from a summary on stdout.
preflight_render() {
    local status label detail
    while IFS=$'\t' read -r status label detail; do
        [[ -n $status ]] || continue
        case $status in
            ok) printf '  ok       %-22s %s\n' "$label" "$detail" ;;
            warn) printf '  warning  %-22s %s\n' "$label" "$detail" >&2 ;;
            *) printf '  ERROR    %-22s %s\n' "$label" "$detail" >&2 ;;
        esac
    done <<<"$1"
}

# version_compare A B
# Prints -1, 0 or 1 for A against B, comparing dot separated numeric
# components. Trailing non-numeric parts (`-beta.1`, `+ce`) are ignored, which
# is what a minimum-version check needs. Implemented here because `sort -V` is
# not portable and lexical comparison gets 2.9.0 and 2.24.0 backwards.
version_compare() {
    local a=$1 b=$2 i x y
    local -a av bv
    a=${a#v}
    b=${b#v}
    a=${a%%[-+]*}
    b=${b%%[-+]*}
    IFS=. read -ra av <<<"$a"
    IFS=. read -ra bv <<<"$b"
    for ((i = 0; i < 4; i++)); do
        x=${av[i]:-0}
        y=${bv[i]:-0}
        # A component that is not a number sorts as zero rather than crashing.
        [[ $x =~ ^[0-9]+$ ]] || x=0
        [[ $y =~ ^[0-9]+$ ]] || y=0
        if ((10#$x > 10#$y)); then
            printf '1\n'
            return 0
        fi
        if ((10#$x < 10#$y)); then
            printf -- '-1\n'
            return 0
        fi
    done
    printf '0\n'
}

# version_at_least VERSION MINIMUM
version_at_least() {
    [[ $(version_compare "$1" "$2") != "-1" ]]
}

# preflight_os
preflight_os() {
    local os arch
    os=$(uname -s 2>/dev/null || printf 'unknown')
    arch=$(uname -m 2>/dev/null || printf 'unknown')
    case $os in
        Linux | Darwin) ;;
        *)
            _gd_report error "operating system" "$os is not supported; Linux and macOS are"
            return
            ;;
    esac
    case $arch in
        x86_64 | amd64 | arm64 | aarch64) ;;
        *)
            _gd_report error architecture "$arch has no published images for the services this stack runs"
            return
            ;;
    esac
    _gd_report ok platform "$os/$arch"
}

# preflight_commands [COMMAND...]
preflight_commands() {
    local cmd missing=""
    local -a wanted=("$@")
    ((${#wanted[@]})) || wanted=("${GD_REQUIRED_COMMANDS[@]}")
    for cmd in "${wanted[@]}"; do
        command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
    done
    if [[ -n $missing ]]; then
        _gd_report error "required tools" "missing:${missing}"
        return
    fi
    _gd_report ok "required tools" "${wanted[*]}"
}

# _gd_daemon_hint
# What to actually do about an unreachable daemon on this host.
_gd_daemon_hint() {
    case $(uname -s 2>/dev/null) in
        Darwin) printf 'start Docker Desktop or OrbStack and wait for it to report running' ;;
        Linux)
            if [[ -d /run/systemd/system ]]; then
                printf 'start it with: sudo systemctl start docker'
            else
                printf 'start the Docker daemon for this system'
            fi
            ;;
        *) printf 'start the Docker daemon' ;;
    esac
}

# preflight_docker
# Docker and Compose, in the order a failure should be reported: the binary,
# then daemon access, then versions. Daemon access is tested by asking the
# daemon a question. Membership of the `docker` group is neither necessary
# (rootless, sudo-less contexts, a remote DOCKER_HOST) nor sufficient (a
# stopped daemon), so it is not what gets checked.
preflight_docker() {
    local out rc version compose_version

    if ! command -v docker >/dev/null 2>&1; then
        _gd_report error docker "not installed; see https://docs.docker.com/engine/install/"
        return
    fi

    out=$(_gd_docker "$GD_DOCKER_PROBE_TIMEOUT" info --format '{{.ServerVersion}}')
    rc=$?
    if ((rc == 124)); then
        _gd_report error "docker daemon" "did not answer within ${GD_DOCKER_PROBE_TIMEOUT}s; it is running but not responding ($(_gd_daemon_hint))"
        return
    fi
    if ((rc != 0)); then
        _gd_report error "docker daemon" "not reachable ($(_gd_daemon_hint)); docker said: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
        return
    fi
    version=$out
    [[ -n $version ]] || version=$(_gd_docker "$GD_DOCKER_PROBE_TIMEOUT" version --format '{{.Server.Version}}' || printf '')

    if [[ -z $version ]]; then
        _gd_report warn "docker engine" "reachable, but the version could not be determined"
    elif version_at_least "$version" "$GD_MIN_DOCKER_VERSION"; then
        _gd_report ok "docker engine" "$version"
    else
        _gd_report error "docker engine" "$version is older than the required $GD_MIN_DOCKER_VERSION (healthcheck start_interval)"
    fi

    if ! compose_version=$(_gd_docker "$GD_DOCKER_PROBE_TIMEOUT" compose version --short); then
        _gd_report error "docker compose" "the Compose v2 plugin is not available; see https://docs.docker.com/compose/install/"
        return
    fi
    if version_at_least "$compose_version" "$GD_MIN_COMPOSE_VERSION"; then
        _gd_report ok "docker compose" "$compose_version"
    else
        _gd_report error "docker compose" "$compose_version is older than the required $GD_MIN_COMPOSE_VERSION (env_file required:, depends_on required:)"
    fi
}

# port_in_use PORT
# True when something already accepts connections on the loopback interface.
# bash's own /dev/tcp is used so that no probing utility has to be installed;
# a container publishing on 0.0.0.0 answers here too.
port_in_use() {
    local port=$1
    [[ $port =~ ^[0-9]+$ ]] || return 1
    (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 && return 0
    return 1
}

# port_holder PORT
# Best effort description of what holds a port, for the error message only.
# Docker is asked first because a published container port is the case an
# operator most needs named; host tools are used when they happen to exist.
port_holder() {
    local port=$1 line out

    if command -v docker >/dev/null 2>&1; then
        while IFS= read -r line; do
            case $line in
                *":$port->"*)
                    printf 'docker container %s\n' "${line%%$'\t'*}"
                    return 0
                    ;;
            esac
        done <<<"$(_gd_docker "$GD_DOCKER_PROBE_TIMEOUT" ps --format '{{.Names}}	{{.Ports}}')"
    fi

    if command -v lsof >/dev/null 2>&1; then
        out=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -Fc 2>/dev/null | sed -n 's/^c//p' | head -1)
        [[ -n $out ]] && {
            printf 'process %s\n' "$out"
            return 0
        }
    fi
    if command -v ss >/dev/null 2>&1; then
        out=$(ss -ltnH "sport = :$port" 2>/dev/null | head -1)
        [[ -n $out ]] && {
            printf 'a listener (ss: %s)\n' "$out"
            return 0
        }
    fi

    printf 'another process\n'
}

# preflight_port PORT PURPOSE
# A port that is already in use is an error, never something to resolve by
# stopping whatever holds it: on a server that may be the operator's own proxy,
# serving other applications.
preflight_port() {
    local port=$1 purpose=$2
    if port_in_use "$port"; then
        _gd_report error "port $port" "already in use by $(port_holder "$port"); $purpose needs it. Free it, or choose another port. Nothing was stopped."
        return
    fi
    _gd_report ok "port $port" "free ($purpose)"
}

# free_port [START] [COUNT]
# The first free port at or above START. Used only when no port was requested:
# an explicitly requested port that is busy is an error, not something to work
# around silently.
free_port() {
    local port=${1:-2368} limit=${2:-200} tried=0
    while ((tried < limit)); do
        if ! port_in_use "$port"; then
            printf '%s\n' "$port"
            return 0
        fi
        port=$((port + 1))
        tried=$((tried + 1))
    done
    return 1
}

# preflight_disk DIR
preflight_disk() {
    local dir=$1 probe avail_kb avail_mb
    probe=$dir
    while [[ -n $probe && ! -d $probe ]]; do probe=$(dirname "$probe"); done
    [[ -d $probe ]] || probe=.

    # -P is POSIX output; -k is kibibytes on both GNU and BSD df.
    avail_kb=$(df -Pk "$probe" 2>/dev/null | awk 'NR==2 {print $4}')
    [[ $avail_kb =~ ^[0-9]+$ ]] || {
        _gd_report warn "disk space" "could not be determined for $probe"
        return
    }
    avail_mb=$((avail_kb / 1024))
    if ((avail_mb < GD_RECOMMENDED_DISK_MB)); then
        _gd_report warn "disk space" "${avail_mb} MB free on $probe; ${GD_RECOMMENDED_DISK_MB} MB is recommended for images, the database and content"
        return
    fi
    _gd_report ok "disk space" "${avail_mb} MB free on $probe"
}

# preflight_memory
preflight_memory() {
    local total_mb=""
    if [[ -r /proc/meminfo ]]; then
        total_mb=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)
    elif command -v sysctl >/dev/null 2>&1; then
        total_mb=$(sysctl -n hw.memsize 2>/dev/null)
        [[ $total_mb =~ ^[0-9]+$ ]] && total_mb=$((total_mb / 1024 / 1024))
    fi
    [[ $total_mb =~ ^[0-9]+$ ]] || {
        _gd_report warn memory "could not be determined"
        return
    }
    if ((total_mb < GD_RECOMMENDED_MEMORY_MB)); then
        _gd_report warn memory "${total_mb} MB; Ghost and MySQL together want at least ${GD_RECOMMENDED_MEMORY_MB} MB"
        return
    fi
    _gd_report ok memory "${total_mb} MB"
}

# preflight_writable DIR
# The site directory has to be writable by the user running this, and its
# bind-mounted data directories have to exist at daemon start.
preflight_writable() {
    local dir=$1 probe=$1
    while [[ -n $probe && ! -d $probe ]]; do probe=$(dirname "$probe"); done
    if [[ ! -w $probe ]]; then
        _gd_report error "site directory" "$probe is not writable by $(id -un 2>/dev/null || printf 'this user')"
        return
    fi
    _gd_report ok "site directory" "$dir"
}

# preflight_site DIR MODE GHOST_PORT [HTTP_PORT] [HTTPS_PORT]
# The whole mode-aware preflight, as one record stream.
preflight_site() {
    local dir=$1 mode=$2 ghost_port=$3 http_port=${4:-80} https_port=${5:-443}

    preflight_os
    preflight_commands "${GD_REQUIRED_COMMANDS[@]}"
    preflight_docker
    preflight_writable "$dir"
    preflight_disk "$dir"
    preflight_memory
    preflight_port "$ghost_port" "Ghost on the loopback interface"
    if [[ $mode == production ]]; then
        preflight_port "$http_port" "Caddy HTTP"
        preflight_port "$https_port" "Caddy HTTPS"
    fi
}
