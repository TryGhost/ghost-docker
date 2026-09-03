#!/usr/bin/env bash
# Loads every ghost-docker shell library in dependency order.
#
# Usage from a script in scripts/:
#   . "$(dirname "$0")/lib/common.sh"

# shellcheck disable=SC2034
GD_COMMON_LIB_LOADED=1

GD_LIB_DIR=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
GD_ROOT_DIR=$(CDPATH='' cd -- "$GD_LIB_DIR/../.." && pwd)

# shellcheck source=scripts/lib/fs.sh
. "$GD_LIB_DIR/fs.sh"
# shellcheck source=scripts/lib/env.sh
. "$GD_LIB_DIR/env.sh"
# shellcheck source=scripts/lib/compose.sh
. "$GD_LIB_DIR/compose.sh"
# shellcheck source=scripts/lib/config.sh
. "$GD_LIB_DIR/config.sh"
# shellcheck source=scripts/lib/caddy.sh
. "$GD_LIB_DIR/caddy.sh"

# usage
# Prints the calling script's header comment block: everything from the line
# after the shebang up to the first non-comment line, with the leading `# `
# stripped. `$0` is the CLI that sourced this file, not this file.
usage() {
    local line
    {
        read -r line # shebang
        while IFS= read -r line; do
            [[ $line == '#'* ]] || break
            line=${line#\#}
            printf '%s\n' "${line# }"
        done
    } <"$0"
}
