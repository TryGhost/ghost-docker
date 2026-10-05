#!/usr/bin/env bash
# Migration bundle import: staging, configuration, content and the database.
#
# The policy lives in install.sh; this file holds the steps. The contract is
# docs/bundle-v1.md, and the sequence is §2.4 of docs/ghost-cli-replacement.md.
#
# Importing a bundle means trusting it: its SQL becomes the site's database and
# its themes become the site. What is defended here is everything else. A
# bundle is unpacked into a private staging directory inside the site
# directory, anything in it that is not a plain file or directory is refused,
# and the database is loaded as the site's own database user, never as root,
# so a dump can touch nothing but that database.

# shellcheck disable=SC2034
GD_IMPORT_LIB_LOADED=1

# While an import is in progress `.env` carries this instead of the real
# profiles. It selects no service, so `docker compose up` in a checkout whose
# import was interrupted starts nothing; the import's own Compose calls pass
# the real mode through the environment.
readonly GD_IMPORT_INCOMPLETE_PROFILE="import-incomplete"

# Present from the first change an import makes until it has been verified.
GD_IMPORT_MARKER_NAME=".ghost-docker-import"
GD_IMPORT_STAGING_NAME=".import"

# Kept free on the site's filesystem after a bundle is unpacked, for the
# database load that follows.
readonly GD_IMPORT_RESERVE_KB=262144

# Ghost configuration the container owns. docs/bundle-v1.md lists these; the
# exact keys Compose sets are added to them at run time from compose.yml
# itself, so the two cannot drift apart.
readonly GD_IMPORT_OWNED_KEYS=(url admin__url process NODE_ENV)
readonly GD_IMPORT_OWNED_PREFIXES=(database__ server__ paths__ logging__)

# import_marker DIR
import_marker() { printf '%s/%s\n' "$1" "$GD_IMPORT_MARKER_NAME"; }

# import_staging DIR
import_staging() { printf '%s/%s\n' "$1" "$GD_IMPORT_STAGING_NAME"; }

# import_incomplete DIR
# True when an earlier import into this checkout did not finish.
import_incomplete() { [[ -e $(import_marker "$1") ]]; }

# import_dir_empty PATH
# True when PATH does not exist or holds nothing.
import_dir_empty() {
    [[ -e $1 ]] || return 0
    [[ -d $1 ]] || return 1
    [[ -z $(ls -A "$1" 2>/dev/null) ]]
}

# _gd_import_remove PATH...
# Removes paths this import created. Each must be a non-empty absolute path
# below a site directory; anything else is a bug and is left alone.
_gd_import_remove() {
    local path
    for path in "$@"; do
        case $path in
            /*/*) rm -rf -- "$path" ;;
            *) printf 'error: refusing to remove %s\n' "${path:-<empty path>}" >&2 ;;
        esac
    done
}

# _gd_import_free_kb PATH
_gd_import_free_kb() {
    df -Pk "$1" 2>/dev/null | awk 'NR==2 {print $4}'
}

# _gd_import_refuse MESSAGE...
_gd_import_refuse() {
    printf 'error: %s\n' "$*" >&2
    return 1
}

# _gd_import_archive_type FILE -> tar | zip
# By content, not by name. tar recognises its own compression, so every
# archive that is not a zip is handed to it and it has the last word.
_gd_import_archive_type() {
    local magic
    magic=$(head -c 2 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')
    if [[ $magic == 504b ]]; then
        printf 'zip\n'
    else
        printf 'tar\n'
    fi
}

# _gd_import_unpack BUNDLE TARGET
# Copies a bundle directory, or unpacks an archive, into the empty TARGET.
_gd_import_unpack() {
    local bundle=$1 target=$2 need_kb free_kb name names

    free_kb=$(_gd_import_free_kb "$target")
    [[ $free_kb =~ ^[0-9]+$ ]] || free_kb=""

    if [[ -d $bundle ]]; then
        need_kb=$(du -sk "$bundle" 2>/dev/null | awk '{print $1}')
        if [[ -n $free_kb && $need_kb =~ ^[0-9]+$ ]] && ((need_kb + GD_IMPORT_RESERVE_KB > free_kb)); then
            _gd_import_refuse "the bundle is $((need_kb / 1024)) MB and the site directory's filesystem has $((free_kb / 1024)) MB free"
            return 1
        fi
        # `/.` copies the directory's contents, dotfiles included. A link is
        # copied as a link, not followed, and refused by the check afterwards.
        cp -R "$bundle/." "$target/" 2>/dev/null || {
            _gd_import_refuse "the bundle directory could not be copied"
            return 1
        }
        return 0
    fi

    [[ -f $bundle ]] || {
        _gd_import_refuse "the bundle is neither a directory nor an archive"
        return 1
    }

    # An archive expands; twice its size is the least that must be free
    # before starting. What is actually left is checked after unpacking.
    need_kb=$(du -sk "$bundle" 2>/dev/null | awk '{print $1}')
    if [[ -n $free_kb && $need_kb =~ ^[0-9]+$ ]] && ((need_kb * 2 + GD_IMPORT_RESERVE_KB > free_kb)); then
        _gd_import_refuse "the site directory's filesystem has $((free_kb / 1024)) MB free, too little to unpack a $((need_kb / 1024)) MB bundle"
        return 1
    fi

    if [[ $(_gd_import_archive_type "$bundle") == zip ]]; then
        command -v unzip >/dev/null 2>&1 || {
            _gd_import_refuse "this bundle is a zip archive and there is no unzip on this host. Install unzip," \
                "extract the archive yourself and pass the directory, or export again with --archive tgz."
            return 1
        }
        unzip -q "$bundle" -d "$target" >/dev/null 2>&1 || {
            _gd_import_refuse "the zip archive could not be extracted; it is corrupt or not a bundle"
            return 1
        }
        return 0
    fi

    # Names are checked before anything is written. tar refuses these by
    # default too; this does not depend on which tar is installed.
    names=$(tar -tf "$bundle" 2>/dev/null) || {
        # shellcheck disable=SC2016  # the backticks are prose
        _gd_import_refuse 'the bundle is not an archive made by `ghost migrate-export`, or it is corrupt'
        return 1
    }
    while IFS= read -r name; do
        case "/$name/" in
            //* | */../*)
                _gd_import_refuse "the archive holds a path that leaves the bundle: $name"
                return 1
                ;;
        esac
    done <<<"$names"

    tar -xf "$bundle" -C "$target" --no-same-owner 2>/dev/null || {
        _gd_import_refuse "the archive could not be extracted; it is corrupt or truncated"
        return 1
    }
}

# _gd_import_lift_single_root TARGET
# An archive made with `tar -C parent name` keeps the bundle under one top
# level directory. That is the same bundle, so it is lifted to the root.
# macOS tar adds `._name` metadata files, which do not count as contents.
_gd_import_lift_single_root() {
    local target=$1 entry inner="" count=0
    [[ -e $target/manifest.json ]] && return 0
    for entry in "$target"/* "$target"/.[!.]*; do
        [[ -e $entry || -L $entry ]] || continue
        [[ -f $entry && $(basename "$entry") == ._* ]] && continue
        count=$((count + 1))
        inner=$entry
    done
    [[ $count -eq 1 && -d $inner && ! -L $inner && -f $inner/manifest.json ]] || return 0
    mv "$inner" "$target.lift" && _gd_import_remove "$target" && mv "$target.lift" "$target"
}

# The manifest rules of docs/bundle-v1.md. Prints the first problem found, or
# nothing for a valid manifest.
# shellcheck disable=SC2016  # a jq program, not shell
readonly GD_IMPORT_MANIFEST_RULES='
def re_export: " Export the site again with Ghost-CLI 1.33.0 or later.";
def url_ok: type == "string" and test("^https?://[^/[:space:]]+");
def relative_ok: type == "string" and length > 0 and (startswith("/") | not)
    and (split("/") | index("..") | not);
if type != "object" then "manifest.json is not a JSON object" else
first(
  (select(.bundleVersion != 1)
     | "this is not a version 1 bundle (bundleVersion is \(.bundleVersion | tojson))." + re_export),
  (("ghostVersion", "sourceEnvironment", "configValues") as $alias | select(has($alias))
     | "manifest.json uses the unsupported draft field \($alias)." + re_export),
  (select((.bundleCreatedAt | type) != "string"
          or (.bundleCreatedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$") | not))
     | "manifest.json has no valid bundleCreatedAt (an RFC 3339 timestamp in UTC)"),
  (select(.sourceInstallType != "local" and .sourceInstallType != "production")
     | "manifest.json sourceInstallType must be \"local\" or \"production\", not \(.sourceInstallType | tojson)"),
  (select([.kind] | inside(["mysql-dump", "mysql-data", "portable"]) | not)
     | "manifest.json kind must be one of mysql-dump, mysql-data, portable, not \(.kind | tojson)"),
  (select((.ghost | type) != "object" or (.ghost.version | type) != "string"
          or (.ghost.version | test("^[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z.-]+)?$") | not))
     | "manifest.json has no exact ghost.version"),
  (select(.ghost.version | startswith("6.") | not)
     | "the source site runs Ghost \(.ghost.version); only Ghost 6.x can be imported. Run `ghost update` in the source installation, then export it again."),
  (select(.url | url_ok | not) | "manifest.json url is not an http(s) URL"),
  (select(.adminUrl != null and (.adminUrl | url_ok | not)) | "manifest.json adminUrl is not an http(s) URL"),
  (select(.content != "content/") | "manifest.json content must be \"content/\""),
  (select((.database | type) != "object") | "manifest.json has no database object"),
  (select(.database | has("kind"))
     | "manifest.json uses the unsupported draft field database.kind." + re_export),
  (select(.kind != "portable" and .database.path != "database.sql")
     | "manifest.json database.path must be \"database.sql\" for a \(.kind) bundle"),
  (select(.kind == "portable" and (.database.path | relative_ok | not))
     | "manifest.json database.path is not a path inside the bundle"),
  (select(.kind == "portable" and (.database.members | relative_ok | not))
     | "manifest.json database.members is not a path inside the bundle"),
  (select(.kind == "mysql-data" and ((.database.rows | type) != "object" or (.database.rows | length) == 0))
     | "manifest.json database.rows is required for a mysql-data bundle"),
  (select(.kind == "mysql-data") | .database.rows | to_entries[]
     | select(.key | test("^[A-Za-z0-9_]{1,64}$") | not)
     | "manifest.json database.rows names an invalid table: \(.key | tojson)"),
  (select(.kind == "mysql-data") | .database.rows | to_entries[]
     | select((.value | type) != "number" or .value < 0 or .value != (.value | floor))
     | "manifest.json database.rows.\(.key) is not a row count"),
  (select((.config | type) != "object") | "manifest.json has no config object"),
  (.config | to_entries[] | select((.value | type) != "string")
     | "manifest.json config.\(.key) is not a string; bundle v1 config values are raw strings"),
  empty
) end'

# _gd_import_validate TARGET
# Checks an unpacked bundle: nothing but files and directories, a manifest
# that meets the contract, and the files that manifest names.
_gd_import_validate() {
    local target=$1 manifest=$1/manifest.json odd problem path

    odd=$(find "$target" ! -type f ! -type d 2>/dev/null | head -1)
    if [[ -n $odd ]]; then
        if [[ -L $odd ]]; then
            _gd_import_refuse "the bundle contains a symbolic link: ${odd#"$target"/}. Bundles hold only regular files and directories."
        else
            _gd_import_refuse "the bundle contains a special file: ${odd#"$target"/}. Bundles hold only regular files and directories."
        fi
        return 1
    fi

    [[ -f $manifest ]] || {
        # shellcheck disable=SC2016  # the backticks are prose
        _gd_import_refuse 'the bundle has no manifest.json; it was not made by `ghost migrate-export`'
        return 1
    }
    (($(wc -c <"$manifest") <= 1048576)) || {
        _gd_import_refuse "manifest.json is implausibly large"
        return 1
    }

    problem=$(jq -r "$GD_IMPORT_MANIFEST_RULES" "$manifest" 2>/dev/null) || {
        _gd_import_refuse "manifest.json is not valid JSON"
        return 1
    }
    [[ -z $problem ]] || {
        _gd_import_refuse "$problem"
        return 1
    }

    [[ -d $target/content ]] || {
        _gd_import_refuse "the bundle has no content/ directory"
        return 1
    }
    while IFS= read -r path; do
        [[ -n $path ]] || continue
        [[ -f $target/$path ]] || {
            _gd_import_refuse "manifest.json names $path, which is not a file in the bundle"
            return 1
        }
    done < <(jq -r '.database | .path, (.members // empty)' "$manifest")
}

# import_stage DIR BUNDLE
# Unpacks BUNDLE into the site's staging directory and validates it. Prints
# nothing; the validated manifest is then available to import_manifest.
# Returns non-zero, having left nothing behind, when the bundle is refused.
import_stage() {
    local dir=$1 bundle=$2 staging free_kb
    staging=$(import_staging "$dir")

    [[ -e $bundle ]] || {
        _gd_import_refuse "there is no bundle at $bundle"
        return 1
    }

    _gd_import_remove "$staging"
    (umask 077 && mkdir "$staging" "$staging/bundle") || return 1

    if ! _gd_import_unpack "$bundle" "$staging/bundle"; then
        chmod -R u+rwX "$staging" 2>/dev/null
        _gd_import_remove "$staging"
        return 1
    fi
    # An archive records its own modes; whatever they were, this user must be
    # able to read, move and remove what was unpacked.
    chmod -R u+rwX "$staging/bundle" 2>/dev/null

    _gd_import_lift_single_root "$staging/bundle"

    if ! _gd_import_validate "$staging/bundle"; then
        _gd_import_remove "$staging"
        return 1
    fi

    free_kb=$(_gd_import_free_kb "$staging")
    if [[ $free_kb =~ ^[0-9]+$ ]] && ((free_kb < GD_IMPORT_RESERVE_KB)); then
        _gd_import_refuse "unpacking the bundle left $((free_kb / 1024)) MB free on the site directory's filesystem, too little to load its database"
        _gd_import_remove "$staging"
        return 1
    fi

    # Content is served by Ghost and read by theme developers, like the
    # content of a fresh install; the database dump and manifest stay private
    # inside staging.
    chmod -R go+rX "$staging/bundle/content" 2>/dev/null
    jq -c . "$staging/bundle/manifest.json" >"$staging/manifest.json" || {
        _gd_import_remove "$staging"
        return 1
    }
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
    [[ $dir == /*/* ]] || {
        printf 'error: refusing to discard an import in %s\n' "${dir:-<empty path>}" >&2
        return 1
    }

    if [[ -f $dir/$GD_ENV_FILE_NAME ]]; then
        COMPOSE_PROFILES=local compose_run "$dir" stop >/dev/null 2>&1 || true
    fi

    _gd_import_remove "$dir/data/ghost" "$dir/data/mysql" 2>/dev/null || true

    # Once a container has run, the database and content files belong to that
    # container's user, which this user may not be able to remove. The database
    # image is already here, so it does it. Nothing ran if there is no `.env`.
    if [[ -f $dir/$GD_ENV_FILE_NAME ]] && { [[ -e $dir/data/ghost ]] || [[ -e $dir/data/mysql ]]; }; then
        COMPOSE_PROFILES=local compose_run "$dir" run --rm --no-deps --user 0:0 \
            --volume "$dir/data:/import-data" --entrypoint sh db \
            -c 'cd /import-data && rm -rf ghost mysql' >/dev/null 2>&1 || true
    fi

    if [[ -f $dir/$GD_ENV_FILE_NAME ]]; then
        COMPOSE_PROFILES=local compose_run "$dir" down --volumes --remove-orphans >/dev/null 2>&1 || true
    fi
    if import_dir_empty "$dir/data"; then _gd_import_remove "$dir/data"; fi

    _gd_import_remove "$(import_staging "$dir")" \
        "$dir/$GD_ENV_FILE_NAME" "$dir/$GD_GHOST_ENV_FILE_NAME" "$dir/$GD_META_FILE_NAME" \
        "$(import_marker "$dir")"
}
