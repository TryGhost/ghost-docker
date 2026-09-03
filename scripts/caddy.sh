#!/usr/bin/env bash
# Generate, validate and install this site's Caddy routes.
#
#   scripts/caddy.sh render [DIR]    render the candidate tree into caddy/.staging
#   scripts/caddy.sh validate [DIR]  validate the installed routes
#   scripts/caddy.sh apply [DIR]     render, validate, install, reload, verify
#   scripts/caddy.sh reload [DIR]    explicit reload of the running Caddy
#
# Production uses an explicit reload; Caddy's --watch is a development feature.
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "$0")/lib/common.sh"

cmd=${1:-}
(($#)) && shift || true
dir="${1:-$GD_ROOT_DIR}"

case "$cmd" in
    render)
        staged=$(caddy_render "$dir")
        printf 'staged routes in %s\n' "$staged"
        cat "$staged"/*.caddy
        ;;
    validate)
        caddy_validate "$dir"
        printf 'installed Caddy configuration is valid\n'
        ;;
    apply)
        caddy_apply "$dir"
        printf 'Caddy routes applied\n'
        ;;
    reload)
        caddy_reload "$dir"
        printf 'Caddy reloaded\n'
        ;;
    '' | -h | --help | help)
        usage
        ;;
    *)
        printf 'unknown command: %s\n' "$cmd" >&2
        usage >&2
        exit 2
        ;;
esac
