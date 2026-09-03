#!/usr/bin/env bash
# Inspect and validate a site's configuration split.
#
#   scripts/config.sh validate [DIR]      validate .env and ghost.env by mode
#   scripts/config.sh set FILE KEY VALUE  write one value, safely and atomically
#   scripts/config.sh unset FILE KEY
#   scripts/config.sh mode [DIR]          print the selected site mode
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "$0")/lib/common.sh"

cmd=${1:-}
(($#)) && shift || true

case "$cmd" in
    validate)
        dir="${1:-$GD_ROOT_DIR}"
        if config_validate "$dir"; then
            printf 'configuration in %s is valid\n' "$dir"
        else
            exit 1
        fi
        ;;
    set)
        (($# == 3)) || {
            usage
            exit 2
        }
        env_set "$1" "$2" "$3"
        # Key names only. Values are never printed: any of them may be a
        # credential, and a list of "sensitive" names would silently miss one.
        printf 'updated %s in %s\n' "$2" "$1" >&2
        ;;
    unset)
        (($# == 2)) || {
            usage
            exit 2
        }
        env_unset "$1" "$2"
        ;;
    mode)
        dir="${1:-$GD_ROOT_DIR}"
        compose_site_mode "$(env_get "$dir/.env" COMPOSE_PROFILES)"
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
