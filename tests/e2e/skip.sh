# shellcheck shell=bash
# Sourced by the e2e scripts: what happens when this host cannot run a
# scenario.
#
# By default that is a failure, so a run that passes is one that ran
# everything, which is what CI relies on. GD_E2E_ALLOW_SKIP=1 skips it on
# purpose instead, for a laptop without a free port 80 or a host without
# Docker, and the summary names every scenario skipped. Written for bash 3.2,
# which launcher.sh runs on.

SKIPPED=()

# skip REASON -- the current scenario cannot run here: fail, or skip it when
# GD_E2E_ALLOW_SKIP=1.
skip() {
    if [[ ${GD_E2E_ALLOW_SKIP:-} != 1 ]]; then
        printf '\nFAILED in "%s": it cannot run here: %s\n' "${CURRENT:-setup}" "$1" >&2
        printf 'Set GD_E2E_ALLOW_SKIP=1 to skip what this host cannot run, on purpose.\n' >&2
        exit 1
    fi
    printf '   SKIPPED  %s\n' "$1"
    SKIPPED+=("${CURRENT:-setup}: $1")
}

# passed MESSAGE -- the last line of a run: MESSAGE, then every scenario skipped.
passed() {
    printf '\n%s\n' "$1"
    if ((${#SKIPPED[@]} > 0)); then
        printf 'Skipped, with GD_E2E_ALLOW_SKIP=1 (%d):\n' "${#SKIPPED[@]}"
        printf '  - %s\n' "${SKIPPED[@]}"
    fi
}

# require_docker -- every scenario after this needs the daemon; without one,
# the rest is skipped (or the run fails) here.
require_docker() {
    docker info >/dev/null 2>&1 && return 0
    skip "no Docker daemon answers here"
    passed "Nothing that needs Docker ran."
    exit 0
}
