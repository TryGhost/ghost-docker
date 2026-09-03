#!/usr/bin/env bash
# Safe dotenv serialization and parsing for Docker Compose.
#
# This library NEVER sources or evaluates an env file. Env files are data, and
# bash's own parser is not a substitute: it expands `$$` to the process id and
# executes `$(...)`, where Compose treats both as text. A validator that
# disagrees with Compose is worse than none.
#
# The encoding rules this implements are documented in docs/configuration.md
# ("Value encoding"), and verified against real containers in
# tests/env-compose.test.mjs. In short: Compose interpolates dotenv values even
# inside double quotes, so a literal `$` is written `$$`, and double quotes are
# the only form that can represent every value.
#
# Decoding needs a single left-to-right pass so that `\\n` yields a backslash
# followed by `n` rather than a newline; jq's alternation does that in one
# expression. Encoding has no such ordering hazard and is plain substitution.
#
# A value whose quotes span several lines is valid dotenv but is not editable
# through these helpers: it is skipped when listing keys, and reading or
# writing that key fails with a clear message.

# shellcheck disable=SC2034
GD_ENV_LIB_LOADED=1

# _gd_env_scan FILE
# Locates assignments. Emits LINE<TAB>KEY<TAB>TYPE<TAB>BODY, where TYPE is
# `d` for double quoted, `s` for single quoted, `u` for unquoted or `x` for a
# value that runs past the end of the line. BODY is still escaped.
#
# Every consumer shares this one grammar, so reading and rewriting can never
# disagree about where a value starts and ends. The regexes live in variables
# because bash 3.2 treats a quoted `=~` right-hand side as a literal.
_gd_env_scan() {
    [[ -f $1 ]] || return 1
    local line raw key n=0 open=''
    local double='^"((\\.|[^"\\])*)"'
    local single="^'((\\\\'|[^'])*)'"
    local closes_double='^([^"\\]|\\.)*"'
    local valid_key='^[A-Za-z_][A-Za-z0-9_]*$'
    local trailing_comment='^(.*)[[:space:]]#'

    while IFS= read -r line || [[ -n $line ]]; do
        n=$((n + 1))

        # Inside a multi-line value: skip it rather than mistaking one of its
        # lines for an assignment.
        if [[ -n $open ]]; then
            if [[ $open == '"' && $line =~ $closes_double ]]; then
                open=''
            elif [[ $open == "'" && $line == *"'"* ]]; then
                open=''
            fi
            continue
        fi

        line=${line#"${line%%[![:space:]]*}"}
        [[ -z $line || $line == '#'* ]] && continue
        if [[ $line == export[[:space:]]* ]]; then
            line=${line#export}
            line=${line#"${line%%[![:space:]]*}"}
        fi
        [[ $line == *=* ]] || continue

        key=${line%%=*}
        key=${key%"${key##*[![:space:]]}"}
        [[ $key =~ $valid_key ]] || continue
        raw=${line#*=}

        if [[ $raw == '"'* ]]; then
            if [[ $raw =~ $double ]]; then
                printf '%d\t%s\td\t%s\n' "$n" "$key" "${BASH_REMATCH[1]}"
            else
                open='"'
                printf '%d\t%s\tx\t\n' "$n" "$key"
            fi
        elif [[ $raw == "'"* ]]; then
            if [[ $raw =~ $single ]]; then
                printf '%d\t%s\ts\t%s\n' "$n" "$key" "${BASH_REMATCH[1]}"
            else
                open="'"
                printf '%d\t%s\tx\t\n' "$n" "$key"
            fi
        else
            # Unquoted: ` #` starts a comment, trailing whitespace is trimmed.
            [[ $raw =~ $trailing_comment ]] && raw=${BASH_REMATCH[1]}
            raw=${raw%"${raw##*[![:space:]]}"}
            printf '%d\t%s\tu\t%s\n' "$n" "$key" "$raw"
        fi
    done <"$1"
}

# _gd_env_escape VALUE
# Encodes VALUE for the inside of a double-quoted dotenv value. Backslashes
# first: later substitutions introduce their own, which must not be escaped a
# second time.
_gd_env_escape() {
    local v=$1
    v=${v//\\/\\\\}
    v=${v//\"/\\\"}
    v=${v//\$/\$\$}
    v=${v//$'\n'/\\n}
    v=${v//$'\r'/\\r}
    v=${v//$'\t'/\\t}
    printf '%s' "$v"
}

# _gd_env_unescape ENCODED
# One pass over the escapes Compose applies, so `\\n` is a backslash then `n`.
_gd_env_unescape() {
    jq -jn --arg v "$1" '
        $v | gsub("(?<e>\\\\.)|(?<d>[$][$])";
            if .e then
                (.e[1:2]) as $c
                | if $c == "n" then "\n"
                  elif $c == "t" then "\t"
                  elif $c == "r" then "\r"
                  elif $c == "\\" or $c == "\"" or $c == "\u0027" or $c == "$" then $c
                  else .e end
            else "$" end)'
}

# _gd_env_valid_key KEY
_gd_env_valid_key() {
    local valid='^[A-Za-z_][A-Za-z0-9_]*$'
    [[ $1 =~ $valid ]]
}

# _gd_env_serialize KEY VALUE
_gd_env_serialize() {
    _gd_env_valid_key "$1" || return 1
    printf '%s="%s"\n' "$1" "$(_gd_env_escape "$2")"
}

# env_keys FILE
env_keys() {
    local n key type body
    while IFS=$'\t' read -r n key type body; do
        printf '%s\n' "$key"
    done < <(_gd_env_scan "$1")
}

# env_get FILE KEY
# Prints the decoded value followed by a newline. The last assignment wins,
# matching Compose. Returns non-zero when the key is absent or spans lines.
env_get() {
    local n key type body found=0 found_type='' found_body=''
    _gd_env_valid_key "$2" || return 2
    while IFS=$'\t' read -r n key type body; do
        [[ $key == "$2" ]] || continue
        found=1
        found_type=$type
        found_body=$body
    done < <(_gd_env_scan "$1")
    ((found)) || return 1

    case $found_type in
        x)
            printf 'error: %s spans several lines; edit it by hand\n' "$2" >&2
            return 1
            ;;
        # Single quoted: literal, and a backslash before a quote is the only
        # escape. The substitution is done in an unquoted assignment rather than
        # inside the printf's double quotes: bash 3.2 (macOS's system bash) and
        # bash 4+ parse the backslashes in a double-quoted `${v//\\\'/\'}`
        # pattern differently, and only the unquoted form agrees on both.
        s)
            local unescaped=${found_body//\\\'/\'}
            printf '%s\n' "$unescaped"
            ;;
        *)
            _gd_env_unescape "$found_body"
            printf '\n'
            ;;
    esac
}

# _gd_env_locate FILE KEY
# Prints the line number of the last assignment of KEY, `x` when that value
# spans several lines, or nothing when the key is absent.
_gd_env_locate() {
    local n key type body at=''
    while IFS=$'\t' read -r n key type body; do
        [[ $key == "$2" ]] || continue
        if [[ $type == x ]]; then at=x; else at=$n; fi
    done < <(_gd_env_scan "$1")
    [[ -n $at ]] && printf '%s\n' "$at"
    return 0
}

# _gd_env_write FILE LINE [REPLACEMENT] [MODE]
# Replaces LINE with REPLACEMENT, deletes it when REPLACEMENT is empty, or
# appends when LINE is 0. The file is replaced atomically.
_gd_env_write() {
    local file=$1 target=${2:-0} replacement=${3:-} mode=${4:-} line n=0
    {
        while IFS= read -r line || [[ -n $line ]]; do
            n=$((n + 1))
            if ((n == target)); then
                if [[ -n $replacement ]]; then
                    printf '%s\n' "$replacement"
                fi
                continue
            fi
            printf '%s\n' "$line"
        done <"$file"
        if ((target == 0)) && [[ -n $replacement ]]; then
            printf '%s\n' "$replacement"
        fi
    } | fs_atomic_write "$file" "$mode"
}

# env_set FILE KEY VALUE [MODE]
# Replaces an existing assignment in place, keeping its position and the
# comments around it, or appends a new one.
env_set() {
    local file=$1 key=$2 value=$3 mode=${4:-} new at
    _gd_env_valid_key "$key" || return 2
    new=$(_gd_env_serialize "$key" "$value") || return 1

    if [[ ! -f $file ]]; then
        printf '%s\n' "$new" | fs_atomic_write "$file" "${mode:-0600}"
        return
    fi

    at=$(_gd_env_locate "$file" "$key")
    if [[ $at == x ]]; then
        printf 'error: %s spans several lines; edit it by hand\n' "$key" >&2
        return 1
    fi
    _gd_env_write "$file" "${at:-0}" "$new" "$mode"
}

# env_unset FILE KEY
env_unset() {
    local at
    _gd_env_valid_key "$2" || return 2
    [[ -f $1 ]] || return 0
    at=$(_gd_env_locate "$1" "$2")
    [[ -n $at && $at != x ]] || return 0
    _gd_env_write "$1" "$at" ""
}

# env_lint FILE
# Reports entries whose on-disk encoding is interpolated by Compose and so does
# not hold the literal value the operator probably intended. Returns 1 when any
# were found.
env_lint() {
    [[ -f $1 ]] || return 0
    local n key type body probe rc=0
    while IFS=$'\t' read -r n key type body; do
        [[ $type == d || $type == u ]] || continue
        # Remove every escaped or doubled form, in this order. Any `$` still
        # standing is one Compose will interpolate.
        probe=${body//\\\\/}
        probe=${probe//\\\$/}
        probe=${probe//\$\$/}
        if [[ $probe == *'$'* ]]; then
            printf '%s: value is interpolated by Compose (unescaped $); write $$ for a literal dollar sign\n' "$key"
            rc=1
        fi
    done < <(_gd_env_scan "$1")
    return $rc
}
