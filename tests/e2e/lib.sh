# shellcheck shell=bash
# Sourced by the e2e scripts: how a run reports, `run` and what to expect of
# it, and a work directory removed on exit. skip.sh, what happens when this
# host cannot run a scenario, comes with it. Written for bash 3.2, which
# launcher.sh runs on.
#
# A script calls `work_dir NAME` for WORK, a private temporary directory. On
# exit, `cleanup` runs the script's own `teardown`, if it defines one, then
# removes WORK. `fail` runs the script's `on_fail`, if any, before exiting.

# shellcheck source=/dev/null
source "$(dirname -- "${BASH_SOURCE[0]}")/skip.sh"

CURRENT=setup
OUT=""
RC=0
WORK=""

# work_dir NAME -- WORK, a private temporary directory, resolved as the
# launcher resolves paths: /tmp is a symlink on macOS.
work_dir() {
    WORK=$(mktemp -d "${TMPDIR:-/tmp}/ghost-docker-$1-e2e.XXXXXXXX")
    WORK=$(CDPATH='' cd -- "$WORK" && pwd -P)
}

cleanup() {
    local rc=$?
    set +e
    if declare -F teardown >/dev/null; then
        teardown
    fi
    case $WORK in */ghost-docker-*-e2e.*) rm -rf -- "$WORK" ;; esac
    exit "$rc"
}
trap cleanup EXIT

# step NAME -- the scenario every check until the next belongs to.
step() {
    CURRENT=$1
    printf '\n== %s\n' "$1"
}
ok() { printf '   ok    %s\n' "$1"; }
# fail MESSAGE [OUTPUT] -- the first check that fails ends the run, naming it.
fail() {
    printf '\nFAILED in "%s": %s\n' "$CURRENT" "$1" >&2
    [[ -z ${2:-} ]] || printf -- '--- output ---\n%s\n--------------\n' "$2" >&2
    if declare -F on_fail >/dev/null; then
        on_fail
    fi
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
