#!/usr/bin/env bash
# Filesystem helpers: private temporary files and atomic replacement.
#
# Every helper that writes a credential-bearing file goes through
# fs_atomic_write so that:
#   * the file is created with a restrictive mode before any content is written
#   * readers never observe a partially written file
#   * an existing file's mode and ownership are preserved

# shellcheck disable=SC2034
GD_FS_LIB_LOADED=1

# fs_stat_mode PATH -> octal mode, or non-zero when the path does not exist
fs_stat_mode() {
    [[ -e $1 ]] || return 1
    stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null
}

# _gd_stat_owner PATH -> uid:gid
_gd_stat_owner() {
    [[ -e $1 ]] || return 1
    stat -f '%u:%g' "$1" 2>/dev/null || stat -c '%u:%g' "$1" 2>/dev/null
}

# fs_mktemp_dir [PREFIX] -> path to a new private directory
fs_mktemp_dir() {
    local prefix=${1:-ghost-docker}
    (umask 077 && mktemp -d "${TMPDIR:-/tmp}/${prefix}.XXXXXXXX")
}

# fs_atomic_write PATH [MODE]
#
# Reads the new content from stdin and replaces PATH atomically. MODE defaults
# to the existing file's mode, or 0600 for a new file: credential-bearing files
# are the common case, so pass 0644 explicitly for public ones.
fs_atomic_write() {
    local path=$1 mode=${2:-}
    local dir existing_mode existing_owner tmp

    dir=$(dirname "$path")
    [[ -d $dir ]] || return 1

    existing_mode=$(fs_stat_mode "$path" 2>/dev/null) || existing_mode=
    existing_owner=$(_gd_stat_owner "$path" 2>/dev/null) || existing_owner=
    [[ -n $mode ]] || mode=${existing_mode:-0600}

    tmp="$path.tmp.$$"
    # Create the temporary file privately before any content reaches it.
    (umask 077 && : >"$tmp") || return 1

    if ! cat >"$tmp"; then
        rm -f "$tmp"
        return 1
    fi
    if ! chmod "$mode" "$tmp"; then
        rm -f "$tmp"
        return 1
    fi
    # Best effort: only meaningful when running with sufficient privileges.
    [[ -n $existing_owner ]] && chown "$existing_owner" "$tmp" 2>/dev/null

    if ! mv -f "$tmp" "$path"; then
        rm -f "$tmp"
        return 1
    fi
}
