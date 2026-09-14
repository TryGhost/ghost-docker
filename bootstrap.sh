#!/usr/bin/env bash
# Select a ghost-docker release, put it somewhere, and run its installer.
#
#   curl -fsSL https://ghost.org/docker/bootstrap.sh | bash -s -- --domain example.com
#
#   bootstrap.sh [--channel stable|beta] [--ref vX.Y.Z] [--dir PATH]
#                [installer options...]
#
#   --channel CHANNEL  stable (default) or beta. Selects the newest release on
#                      that channel.
#   --ref REF          Install this exact tag instead of resolving a channel.
#   --dir PATH         Where to put the checkout. Default: ./ghost-docker
#
# Every other option is passed to the selected release's install.sh unchanged;
# run `bootstrap.sh --help` after the checkout exists, or see install.sh, for
# that list.
#
# This file contains bootstrap logic only. Installation logic belongs to the
# release, so that a site is always installed by the code it is pinned to. Release
# selection uses jq directly because there is no checkout to source yet.
set -euo pipefail

GD_BOOTSTRAP_REPO=${GD_BOOTSTRAP_REPO:-https://github.com/TryGhost/ghost-docker.git}

channel=stable
ref=""
dir=""
declare -a passthrough=()

die() {
    printf 'error: %s\n' "$1" >&2
    exit "${2:-1}"
}

usage() {
    local line
    {
        read -r line
        while IFS= read -r line; do
            [[ $line == '#'* ]] || break
            line=${line#\#}
            printf '%s\n' "${line# }"
        done
    } <"$0"
}

# _timeout SECONDS COMMAND...
# Runs a command with a deadline, returning 124 when it is killed. `timeout(1)`
# is GNU coreutils and is absent on macOS, so this is spelled out. A daemon
# that has wedged stops answering rather than returning an error, so the check
# that exists to report that must not be able to hang on it.
_timeout() {
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

# --- Release selection -----------------------------------------------------

# _latest_release CHANNEL
# Only the release formats we publish are accepted. Sort numeric components
# with jq (already a prerequisite), independent of locale and Git user config.
# A stable release follows every beta of the same version.
_latest_release() {
    local refs
    refs=$(git ls-remote --tags --refs "$GD_BOOTSTRAP_REPO") || return 1
    printf '%s\n' "$refs" | jq -Rser --arg channel "$1" '
        [split("\n")[]
         | capture("refs/tags/(?<tag>v(?<major>[0-9]+)\\.(?<minor>[0-9]+)\\.(?<patch>[0-9]+)(?:-beta\\.(?<beta>[0-9]+))?)$")
         | select($channel == "beta" or .beta == null)
         | .order = [(.major|tonumber), (.minor|tonumber), (.patch|tonumber),
                     (if .beta == null then 1 else 0 end), ((.beta // "0")|tonumber)]]
        | sort_by(.order) | last | .tag // empty'
}

# Sourcing this file with GD_BOOTSTRAP_SOURCED=1 defines the helpers above and
# stops, so that release selection can be tested without cloning anything.
if [[ ${GD_BOOTSTRAP_SOURCED:-0} == 1 ]]; then
    return 0
fi

# --- Options ---------------------------------------------------------------

while (($#)); do
    case $1 in
        --channel)
            [[ ${2:-} ]] || die "--channel needs a value" 2
            channel=$2
            shift
            ;;
        --channel=*) channel=${1#*=} ;;
        --ref)
            [[ ${2:-} ]] || die "--ref needs a value" 2
            ref=$2
            shift
            ;;
        --ref=*) ref=${1#*=} ;;
        --dir)
            [[ ${2:-} ]] || die "--dir needs a value" 2
            dir=$2
            shift
            ;;
        --dir=*) dir=${1#*=} ;;
        -h | --help)
            usage
            exit 0
            ;;
        *) passthrough+=("$1") ;;
    esac
    shift
done

case $channel in
    stable | beta) ;;
    *) die "--channel must be stable or beta" 2 ;;
esac

# --- Preflight -------------------------------------------------------------
#
# Only what the bootstrap itself needs, plus the tools the installer will
# require, so a missing prerequisite is reported before anything is cloned.
# Daemon access is established by asking the daemon, not by looking at group
# membership: neither rootless Docker nor a remote DOCKER_HOST involves the
# docker group, and being in it does not mean the daemon is running.

# The target directory is checked first: it costs nothing, and being told the
# directory is wrong beats waiting on a daemon probe to find that out.
[[ -n $dir ]] || dir=./ghost-docker

if [[ -e $dir ]]; then
    [[ -d $dir ]] || die "$dir exists and is not a directory"
    if [[ -n $(ls -A "$dir" 2>/dev/null) ]]; then
        die "$dir is not empty. Choose an empty directory with --dir, or install
  from inside an existing checkout with its own install.sh."
    fi
fi

missing=""
for cmd in git docker jq curl; do
    command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
done
[[ -z $missing ]] || die "these are required and not installed:$missing"

_timeout 20 docker info >/dev/null 2>&1 ||
    die "the Docker daemon is not reachable, or is not answering. Start Docker,
  wait for it to report running, and try again."

_timeout 20 docker compose version >/dev/null 2>&1 ||
    die "the Docker Compose v2 plugin is not available. See https://docs.docker.com/compose/install/"

if [[ -z $ref ]]; then
    printf 'Resolving the newest %s release\n' "$channel"
    ref=$(_latest_release "$channel") ||
        die "no $channel release was found in $GD_BOOTSTRAP_REPO"
    printf '  %s\n' "$ref"
fi

# A prerelease tag implies the beta channel, whether or not it was named.
case $ref in *-beta.*) channel=beta ;; esac

# --- Checkout --------------------------------------------------------------

printf 'Cloning %s at %s into %s\n' "$GD_BOOTSTRAP_REPO" "$ref" "$dir"
git clone --quiet --depth 1 --branch "$ref" "$GD_BOOTSTRAP_REPO" "$dir" ||
    die "could not clone $GD_BOOTSTRAP_REPO at $ref"

target=$(CDPATH='' cd -- "$dir" && pwd -P)

[[ -x $target/install.sh ]] ||
    die "$ref does not contain an executable install.sh, so it cannot be installed by this bootstrap"

# The installer is the release's, and owns everything from here: preflight,
# configuration, routing and verification. Its exit status is this script's.
printf '\n'
exec "$target/install.sh" --dir "$target" --channel "$channel" --ref "$ref" \
    ${passthrough[@]+"${passthrough[@]}"}
