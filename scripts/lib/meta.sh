#!/usr/bin/env bash
# `.ghost-docker.json`: the installation metadata file.
#
# Records what an operation needs to know about a site that its configuration
# does not say: when it was installed, from which stack release and commit, on
# which release channel, the exact Ghost image identity that was resolved, and
# which migrations have completed. The schema is specified in section 2.2 of
# docs/ghost-cli-replacement.md.
#
# The file is machine generated, gitignored, and written privately: it names a
# site and its provenance, and later steps add operation state to it.
#
# An installation that predates this file is a supported state, not a broken
# site. `meta_present` answers that question; every reader must handle a
# missing file rather than failing on it.

# shellcheck disable=SC2034
GD_META_LIB_LOADED=1

GD_META_FILE_NAME=".ghost-docker.json"

# The schema version this library writes. A reader must refuse a file whose
# version it does not understand rather than guessing at its shape.
readonly GD_META_SCHEMA_VERSION=1

# Keys accepted by meta_init, in `dotted.path` form. Allowlisted so that a
# misspelled key is an error rather than a field nothing ever reads.
readonly GD_META_KEYS=(
    mode
    channel
    installedAt
    stack.version
    stack.commit
    stack.ref
    site.project
    site.dir
    site.url
    site.domain
    site.adminDomain
    ghost.image
    ghost.tag
    ghost.version
    ghost.digest
    profiles
)

# meta_file DIR
meta_file() {
    printf '%s/%s\n' "$1" "$GD_META_FILE_NAME"
}

# meta_present DIR
# True when the site records metadata. False means "installed before metadata
# was recorded", which callers must treat as unknown rather than as an error.
meta_present() {
    [[ -f "$1/$GD_META_FILE_NAME" ]]
}

# meta_read DIR
# Prints the metadata document. Returns 1 when there is none, and 2 when the
# file is present but unreadable or not valid JSON.
meta_read() {
    local file=$1/$GD_META_FILE_NAME
    [[ -f $file ]] || return 1
    jq -e . "$file" >/dev/null 2>&1 || {
        printf 'error: %s is not valid JSON\n' "$file" >&2
        return 2
    }
    cat "$file"
}

# meta_schema_version DIR
# Prints the recorded schema version, or nothing for a pre-metadata install.
meta_schema_version() {
    local file=$1/$GD_META_FILE_NAME
    [[ -f $file ]] || return 1
    jq -r '.schemaVersion // empty' "$file" 2>/dev/null
}

# meta_check_schema DIR
# Fails when the file records a schema this library cannot read. A newer file
# is a stack that was downgraded; say so instead of misreading it.
meta_check_schema() {
    local version
    meta_present "$1" || return 0
    version=$(meta_schema_version "$1") || version=
    if [[ -z $version ]]; then
        printf 'error: %s/%s has no schemaVersion\n' "$1" "$GD_META_FILE_NAME" >&2
        return 1
    fi
    if [[ $version != "$GD_META_SCHEMA_VERSION" ]]; then
        printf 'error: %s/%s uses schema version %s; this stack understands version %s\n' \
            "$1" "$GD_META_FILE_NAME" "$version" "$GD_META_SCHEMA_VERSION" >&2
        return 1
    fi
}

# meta_get DIR FILTER
# Reads one value with a jq filter, for example `.ghost.version`. Returns 1
# when the file is absent or the filter yields null, so a caller can
# distinguish "not recorded" from an empty string.
meta_get() {
    local file=$1/$GD_META_FILE_NAME out
    [[ -f $file ]] || return 1
    out=$(jq -r "$2 // empty" "$file" 2>/dev/null) || return 1
    [[ -n $out ]] || return 1
    printf '%s\n' "$out"
}

# meta_write DIR
# Replaces the metadata with the JSON document on stdin. The document is
# validated and normalised before it is installed, so a failed write can never
# leave an unreadable file in place. Mode 0600: this file names a site and its
# provenance.
meta_write() {
    local dir=$1 file=$1/$GD_META_FILE_NAME body
    body=$(cat)
    if ! printf '%s' "$body" | jq -e . >/dev/null 2>&1; then
        printf 'error: refusing to write invalid JSON to %s\n' "$file" >&2
        return 1
    fi
    if [[ $(printf '%s' "$body" | jq -r '.schemaVersion // empty') != "$GD_META_SCHEMA_VERSION" ]]; then
        printf 'error: refusing to write %s without schemaVersion %s\n' \
            "$file" "$GD_META_SCHEMA_VERSION" >&2
        return 1
    fi
    printf '%s' "$body" | jq -S . | fs_atomic_write "$file" 0600
}

# meta_update DIR FILTER [JQ_ARG...]
# Applies a jq filter to the existing metadata and writes the result back.
meta_update() {
    local dir=$1 filter=$2
    shift 2
    meta_present "$dir" || {
        printf 'error: %s/%s does not exist\n' "$dir" "$GD_META_FILE_NAME" >&2
        return 1
    }
    meta_check_schema "$dir" || return 1
    jq "$@" "$filter" "$dir/$GD_META_FILE_NAME" | meta_write "$dir"
}

# meta_record_migration DIR NAME
# Appends a completed migration, without duplicating one already recorded.
meta_record_migration() {
    # shellcheck disable=SC2016  # $name is a jq variable, bound by --arg below
    meta_update "$1" '.migrations = (.migrations + [$name] | unique)' --arg name "$2"
}

# meta_has_migration DIR NAME
meta_has_migration() {
    meta_present "$1" || return 1
    jq -e --arg name "$2" '.migrations | index($name) != null' \
        "$1/$GD_META_FILE_NAME" >/dev/null 2>&1
}

# _gd_meta_known_key KEY
_gd_meta_known_key() {
    local known
    for known in "${GD_META_KEYS[@]}"; do
        [[ $1 == "$known" ]] && return 0
    done
    return 1
}

# meta_init DIR KEY=VALUE...
# Writes a fresh metadata document. Keys are the dotted paths in GD_META_KEYS;
# `profiles` is a comma separated list and becomes an array. `installedAt`
# defaults to now, in UTC.
meta_init() {
    local dir=$1 pair key value
    shift
    local -a jqargs=()

    for pair in "$@"; do
        [[ $pair == *=* ]] || {
            printf 'error: metadata argument %s is not KEY=VALUE\n' "$pair" >&2
            return 2
        }
        key=${pair%%=*}
        value=${pair#*=}
        _gd_meta_known_key "$key" || {
            printf 'error: unknown metadata key %s\n' "$key" >&2
            return 2
        }
        # jq argument names cannot contain a dot.
        jqargs+=(--arg "${key//./_}" "$value")
    done

    jq -n \
        --argjson schema "$GD_META_SCHEMA_VERSION" \
        --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        ${jqargs[@]+"${jqargs[@]}"} '
        ($ARGS.named) as $a
        | def val($k): ($a[$k] // "") | if . == "" then null else . end;
        {
            schemaVersion: $schema,
            installedAt: (val("installedAt") // $now),
            mode: val("mode"),
            channel: val("channel"),
            stack: {
                version: val("stack_version"),
                commit: val("stack_commit"),
                ref: val("stack_ref"),
            },
            site: {
                project: val("site_project"),
                dir: val("site_dir"),
                url: val("site_url"),
                domain: val("site_domain"),
                adminDomain: val("site_adminDomain"),
            },
            ghost: {
                image: val("ghost_image"),
                tag: val("ghost_tag"),
                version: val("ghost_version"),
                digest: val("ghost_digest"),
            },
            profiles: ((val("profiles") // "") | split(",") | map(select(length > 0))),
            migrations: [],
        }' | meta_write "$dir"
}

# meta_describe DIR
# A human readable summary, including for a site with no metadata at all.
meta_describe() {
    local dir=$1
    if ! meta_present "$dir"; then
        printf 'installation metadata: none (installed before metadata was recorded)\n'
        return 0
    fi
    meta_check_schema "$dir" || return 1
    jq -r '
        "installed:     \(.installedAt // "unknown")",
        "mode:          \(.mode // "unknown")",
        "channel:       \(.channel // "unknown")",
        "stack:         \(.stack.version // "unknown") (\(.stack.commit // "unknown"))",
        "project:       \(.site.project // "unknown")",
        "url:           \(.site.url // "unknown")",
        "ghost:         \(.ghost.tag // "unknown") \(.ghost.digest // "")",
        "profiles:      \(.profiles // [] | join(",") )",
        "migrations:    \(.migrations // [] | join(",") )"
    ' "$dir/$GD_META_FILE_NAME"
}
