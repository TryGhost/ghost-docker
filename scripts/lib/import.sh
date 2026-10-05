#!/usr/bin/env bash
# Migration bundle import: staging, configuration, content and the database.
#
# The policy lives in install.sh; this file holds the steps. The contract is
# docs/bundle-v1.md, and the sequence is §2.4 of docs/ghost-cli-replacement.md.
#
# A bundle is a file somebody else produced. It is only ever read by
# scripts/lib/import-helper.mjs, inside a pinned image with no network and a
# read-only root filesystem; everything after that works from the validated
# copy in the staging directory. The database is loaded as the site's own
# database user, never as root, so a dump can touch nothing but that database.

# shellcheck disable=SC2034
GD_IMPORT_LIB_LOADED=1

# The image the bundle helper runs in. It supplies Node and nothing else; the
# helper is mounted from this checkout.
GD_IMPORT_HELPER_IMAGE="node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402"

# While an import is in progress `.env` carries this instead of the real
# profiles. It selects no service, so `docker compose up` in a checkout whose
# import was interrupted starts nothing; the import's own Compose calls pass
# the real mode through the environment.
readonly GD_IMPORT_INCOMPLETE_PROFILE="import-incomplete"

# Present from the first change an import makes until it has been verified.
GD_IMPORT_MARKER_NAME=".ghost-docker-import"

# Resolved here rather than from common.sh's GD_LIB_DIR so that this file can
# be sourced on its own.
GD_IMPORT_HELPER="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/import-helper.mjs"
GD_IMPORT_STAGING_NAME=".import"

# Ghost configuration the container owns. docs/bundle-v1.md lists these; the
# exact keys Compose sets are added to them at run time from compose.yml
# itself, so the two cannot drift apart.
readonly GD_IMPORT_OWNED_KEYS=(url admin__url process NODE_ENV)
readonly GD_IMPORT_OWNED_PREFIXES=(database__ server__ paths__ logging__)

# import_marker DIR
import_marker() { printf '%s/%s\n' "$1" "$GD_IMPORT_MARKER_NAME"; }

# The staging directory of the import this process is running, set by
# import_stage. Each attempt gets a new one: a path that is removed and then
# recreated can still show its old contents through a container bind mount on
# Docker Desktop style file sharing, and a fresh name cannot.
GD_IMPORT_STAGE=""

# import_staging_root DIR
# Holds every attempt's staging directory, so cleaning up is one removal.
import_staging_root() { printf '%s/%s\n' "$1" "$GD_IMPORT_STAGING_NAME"; }

# import_staging DIR
import_staging() {
    [[ -n $GD_IMPORT_STAGE ]] || return 1
    printf '%s\n' "$GD_IMPORT_STAGE"
}

# import_incomplete DIR
# True when an earlier import into this checkout did not finish.
import_incomplete() { [[ -e $(import_marker "$1") ]]; }

# _gd_import_rootless
# True when the daemon is rootless, where uid 0 in a container is the invoking
# user and any other uid is a subordinate one the user cannot read back.
_gd_import_rootless() {
    docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' 2>/dev/null | grep -q rootless
}

# _gd_import_user
# The container user whose files this user owns on the host.
_gd_import_user() {
    if _gd_import_rootless; then
        printf '0:0\n'
    else
        printf '%s:%s\n' "$(id -u)" "$(id -g)"
    fi
}

# import_dir_empty PATH
# True when PATH does not exist or holds nothing.
import_dir_empty() {
    [[ -e $1 ]] || return 0
    [[ -d $1 ]] || return 1
    [[ -z $(ls -A "$1" 2>/dev/null) ]]
}

# import_stage DIR BUNDLE
# Validates BUNDLE and copies it into a new staging directory, recorded in
# GD_IMPORT_STAGE; call it directly, not in a subshell. Prints nothing; the
# validated manifest is then available to import_manifest. Returns non-zero,
# having left nothing behind, when the bundle is refused.
import_stage() {
    local dir=$1 bundle=$2 root staging helper parent name
    root=$(import_staging_root "$dir")
    helper=$GD_IMPORT_HELPER

    [[ -e $bundle ]] || {
        printf 'error: there is no bundle at %s\n' "$bundle" >&2
        return 1
    }
    parent=$(CDPATH='' cd -- "$(dirname -- "$bundle")" && pwd -P) || return 1
    name=$(basename -- "$bundle")
    # `docker run --volume` splits its argument on colons.
    case "$parent$dir" in
        *:*)
            printf 'error: a bundle or site directory whose path contains a colon cannot be mounted into the\n' >&2
            printf '  container that reads the bundle. Move it to a path without one.\n' >&2
            return 1
            ;;
    esac

    rm -rf "$root"
    (umask 077 && mkdir "$root") || return 1
    staging=$(umask 077 && mktemp -d "$root/stage.XXXXXXXX") || return 1

    # Pinned by digest, so a copy that is already here is the right one.
    if ! docker image inspect "$GD_IMPORT_HELPER_IMAGE" >/dev/null 2>&1 &&
        ! docker pull --quiet "$GD_IMPORT_HELPER_IMAGE" >/dev/null 2>&1; then
        printf 'error: could not pull %s, which reads the bundle. Check that this host can reach the registry.\n' \
            "$GD_IMPORT_HELPER_IMAGE" >&2
        rm -rf "$root"
        return 1
    fi

    # The bundle's parent is mounted rather than the bundle, so one invocation
    # serves a directory and an archive alike. Read-only, with no network, no
    # capabilities and nothing writable but staging.
    if ! docker run --rm \
        --network none \
        --read-only \
        --cap-drop ALL \
        --security-opt no-new-privileges \
        --user "$(_gd_import_user)" \
        --env "GD_IMPORT_BUNDLE_NAME=$bundle" \
        ${GD_IMPORT_MAX_BYTES:+--env "GD_IMPORT_MAX_BYTES=$GD_IMPORT_MAX_BYTES"} \
        --volume "$parent:/source:ro" \
        --volume "$staging:/staging" \
        --volume "$helper:/helper/import-helper.mjs:ro" \
        "$GD_IMPORT_HELPER_IMAGE" \
        node /helper/import-helper.mjs stage "/source/$name" /staging >/dev/null; then
        rm -rf "$root"
        return 1
    fi

    [[ -f $staging/manifest.json ]] || {
        printf 'error: the bundle was read but no manifest was staged. Please report this.\n' >&2
        rm -rf "$root"
        return 1
    }
    GD_IMPORT_STAGE=$staging
}

# import_resolve_ghost IMAGE VERSION
# As install_resolve_ghost, for the exact version a bundle was exported from.
# An import happens at the source version, so an image that reports any other
# version is refused. Older releases were only published in the image's
# previous layout, so that tag is tried when the default variant has none.
import_resolve_ghost() {
    local image=$1 version=$2 tag resolved reported
    local -a tags=()
    tags+=("$(install_ghost_tag "$version")")
    [[ ${tags[0]} == "$version-alpine" ]] || tags+=("$version-alpine")

    for tag in "${tags[@]}"; do
        resolved=$(install_resolve_ghost "$image" "$tag" 2>/dev/null) || continue
        reported=$(printf '%s' "$resolved" | cut -f2)
        if [[ $reported != "$version" ]]; then
            printf 'error: %s:%s is Ghost %s, but the bundle was exported from %s\n' \
                "$image" "$tag" "$reported" "$version" >&2
            return 1
        fi
        printf '%s\n' "$resolved"
        return 0
    done

    printf 'error: no %s image for Ghost %s could be pulled (tried: %s).\n' "$image" "$version" "${tags[*]}" >&2
    printf '  An import runs at the exact version of the source site. Check that this host can\n' >&2
    # shellcheck disable=SC2016  # the backticks are prose
    printf '  reach the registry; if that version has no image, run `ghost update` in the source\n' >&2
    printf '  installation and export it again.\n' >&2
    return 1
}

# import_manifest DIR FILTER
# One value from the validated manifest, as raw text.
import_manifest() {
    jq -r "$2 // empty" "$(import_staging "$1")/manifest.json"
}

# _gd_import_owned KEY CONTAINER_KEYS
# True when KEY is configuration the container owns. CONTAINER_KEYS is a
# newline separated list of what compose.yml sets on the ghost service.
_gd_import_owned() {
    local key=$1 owned prefix
    for owned in "${GD_IMPORT_OWNED_KEYS[@]}"; do
        [[ $key == "$owned" ]] && return 0
    done
    for prefix in "${GD_IMPORT_OWNED_PREFIXES[@]}"; do
        [[ $key == "$prefix"* ]] && return 0
    done
    [[ $'\n'"$2"$'\n' == *$'\n'"$key"$'\n'* ]]
}

# import_apply_config DIR
# Writes the bundle's Ghost configuration into ghost.env, encoded for Compose.
# Container-owned keys are dropped, as are keys that cannot be an environment
# variable name. Reports key names only: values may be credentials.
import_apply_config() {
    local dir=$1 file=$1/$GD_GHOST_ENV_FILE_NAME manifest key value container
    local -a operator_vars=()
    local written=0
    manifest=$(import_staging "$dir")/manifest.json

    # What Compose sets on the ghost service before any bundle key is added.
    container=$(config_ghost_environment "$dir" | cut -f1)
    while read -r key; do
        operator_vars+=("$key")
    done < <(config_operator_variables "$dir")

    while IFS= read -r key; do
        [[ -n $key ]] || continue
        if ! _gd_env_valid_key "$key"; then
            printf '  skipped  %s (not a valid setting name)\n' "$key"
            continue
        fi
        if _gd_import_owned "$key" "$container"; then
            printf '  skipped  %s (set by the container)\n' "$key"
            continue
        fi
        if _gd_is_operator_key "$key" "$dir" ${operator_vars[@]+"${operator_vars[@]}"}; then
            printf '  skipped  %s (an operator setting, not Ghost configuration)\n' "$key"
            continue
        fi
        # jq -j writes the raw string with no trailing newline; the sentinel
        # keeps a value's own trailing newlines through command substitution.
        value=$(jq -j --arg key "$key" '.config[$key]' "$manifest" && printf x) || return 1
        value=${value%x}
        env_set "$file" "$key" "$value" 0600 || return 1
        printf '  ok       %s\n' "$key"
        written=$((written + 1))
    done < <(jq -r '.config | keys_unsorted[]' "$manifest")

    printf '  ok       %s settings carried over from the source site\n' "$written"
}

# import_place_content DIR
# Moves the staged content tree into the site's content directory. The target
# was verified empty, and this runs before any container has mounted it, so it
# is still owned by this user; the Ghost image takes ownership when it starts.
import_place_content() {
    local dir=$1 source target entry
    source=$(import_staging "$dir")/bundle/content
    target=$dir/data/ghost

    [[ -d $source ]] || return 1
    import_dir_empty "$target" || {
        printf 'error: %s is not empty; refusing to merge imported content into it\n' "$target" >&2
        return 1
    }
    mkdir -p "$target" || return 1

    # Staging is inside the site directory, so this is a rename rather than a
    # second copy. Dotfiles travel too.
    for entry in "$source"/* "$source"/.[!.]* "$source"/..?*; do
        [[ -e $entry ]] || continue
        mv -- "$entry" "$target/" || return 1
    done
}

# _gd_import_compose DIR ARGS...
# Compose for an import in progress: the real mode comes from the environment
# because `.env` holds the incomplete marker.
_gd_import_compose() {
    local dir=$1
    shift
    COMPOSE_PROFILES=${GD_IMPORT_PROFILES:?} compose_run "$dir" "$@"
}

# _gd_import_mysql DIR [MYSQL_ARGS...]
# The mysql client inside the db container, as the site's database user and
# against the site's database only. SQL is read from stdin. The password
# reaches the client through the container's own environment, not an argument.
_gd_import_mysql() {
    local dir=$1
    shift
    # shellcheck disable=SC2016  # expanded by the container's shell
    _gd_import_compose "$dir" exec -T db sh -c \
        'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql --default-character-set=utf8mb4 -h 127.0.0.1 -u"$MYSQL_USER" "$@" "$MYSQL_DATABASE"' \
        mysql "$@"
}

# import_database_start DIR
import_database_start() {
    _gd_import_compose "$1" up --detach --wait --wait-timeout "$GD_READY_TIMEOUT" db
}

# import_schema_boot DIR
# Starts Ghost once against the empty database so that it creates its own
# schema and fixtures, then stops it. A mysql-data bundle carries rows only.
import_schema_boot() {
    local dir=$1
    _gd_import_compose "$dir" up --detach --wait --wait-timeout "$GD_READY_TIMEOUT" ghost || return 1
    _gd_import_compose "$dir" stop ghost >/dev/null 2>&1 || return 1
    # A stopped container would be restarted by the next `up` with its old
    # process state; removing it makes the next start a clean one.
    _gd_import_compose "$dir" rm --force ghost >/dev/null 2>&1 || true
}

# import_database_load DIR KIND
# Loads the bundle's database.sql. Fails when the client reports any error.
#
# mysqldump records who defined each view and trigger, and MySQL only lets an
# account with SET_USER_ID create an object on another account's behalf. The
# load runs as the site's own user precisely so that it has no such privilege,
# so for a mysql-dump those clauses are dropped and the objects belong to the
# site's user, which is the account Ghost connects as. Only mysqldump's own
# version-comment lines are rewritten; row data never starts a line that way.
import_database_load() {
    local dir=$1 kind=$2 sql
    sql=$(import_staging "$dir")/bundle/database.sql
    [[ -f $sql ]] || return 1

    if [[ $kind != mysql-dump ]]; then
        _gd_import_mysql "$dir" <"$sql"
        return
    fi

    # shellcheck disable=SC2016  # expanded by the container's shell
    _gd_import_compose "$dir" exec -T db bash -c '
        set -o pipefail
        sed -E \
            -e "s/^(\/\*![0-9]{5}) DEFINER=\`[^\`]*\`@\`[^\`]*\`/\1/" \
            -e "/^\/\*![0-9]{5} CREATE\*\//s/\/\*![0-9]{5} DEFINER=\`[^\`]*\`@\`[^\`]*\`\*\/ ?//" |
            MYSQL_PWD="$MYSQL_PASSWORD" mysql --default-character-set=utf8mb4 -h 127.0.0.1 -u"$MYSQL_USER" "$MYSQL_DATABASE"
    ' <"$sql"
}

# import_database_tables DIR
# The number of tables in the site's database.
import_database_tables() {
    printf 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE();\n' |
        _gd_import_mysql "$1" --batch --skip-column-names
}

# import_verify_rows DIR
# Compares the row count of every table in the manifest's `database.rows` with
# the loaded database. Prints one line per mismatch and returns 1 if any.
import_verify_rows() {
    local dir=$1 manifest query actual
    manifest=$(import_staging "$dir")/manifest.json

    # Table names were validated as [A-Za-z0-9_] by the helper. The filter is
    # held in a variable because bash misparses a backtick inside a quoted string
    # inside a command substitution.
    # shellcheck disable=SC2016
    local build='.database.rows | keys
        | map("SELECT \u0027\(.)\u0027, COUNT(*) FROM `\(.)`")
        | join(" UNION ALL ") + ";"'
    query=$(jq -r "$build" "$manifest") || return 1

    actual=$(printf '%s\n' "$query" | _gd_import_mysql "$dir" --batch --skip-column-names) || return 1

    local mismatches
    # shellcheck disable=SC2016  # a jq program, not shell
    local compare='
        ([inputs | select(length > 0) | split("\t") | {key: .[0], value: (.[1] | tonumber)}] | from_entries) as $actual
        | $manifest[0].database.rows | to_entries[]
        | select($actual[.key] != .value)
        | "\(.key): the bundle records \(.value) rows, the database has \($actual[.key] // "none")"'
    mismatches=$(printf '%s\n' "$actual" | jq -Rrn --slurpfile manifest "$manifest" "$compare") || return 1
    [[ -z $mismatches ]] && return 0
    printf '%s\n' "$mismatches"
    return 1
}

# import_verify_ghost_database DIR
# A loaded mysql-dump has no row counts to compare, so this checks that it is
# a Ghost database at all: it has a migration history.
import_verify_ghost_database() {
    local count
    # shellcheck disable=SC2016  # SQL identifier quoting
    count=$(printf 'SELECT COUNT(*) FROM `migrations`;\n' |
        _gd_import_mysql "$1" --batch --skip-column-names 2>/dev/null) || return 1
    [[ $count =~ ^[0-9]+$ ]] && ((count > 0))
}

# import_discard DIR
# Returns a checkout to how it was before a failed import: containers and
# network removed, data directories emptied, configuration and staging
# deleted. Only ever called for a checkout whose data directories this import
# verified empty before writing to them.
import_discard() {
    local dir=$1

    if [[ -f $dir/$GD_ENV_FILE_NAME ]]; then
        COMPOSE_PROFILES=local compose_run "$dir" down --volumes --remove-orphans >/dev/null 2>&1 || true
    fi

    # The database and content files belong to the containers' own users, so
    # they are removed from inside a container rather than with host
    # privileges this user may not have.
    if [[ -d $dir/data ]]; then
        docker run --rm --network none --volume "$dir/data:/data" "$GD_IMPORT_HELPER_IMAGE" \
            sh -c 'rm -rf /data/ghost /data/mysql' >/dev/null 2>&1 || true
        if import_dir_empty "$dir/data"; then rm -rf "$dir/data"; fi
    fi

    rm -rf "$(import_staging_root "$dir")"
    GD_IMPORT_STAGE=""
    rm -f "$dir/$GD_ENV_FILE_NAME" "$dir/$GD_GHOST_ENV_FILE_NAME" "$dir/$GD_META_FILE_NAME"
    rm -f "$(import_marker "$dir")"
}
