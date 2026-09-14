#!/usr/bin/env bash
# The application/operator configuration split.
#
#   .env        Compose and operator settings: project identity, mode, ports,
#               data locations, restart policy, and INFRASTRUCTURE credentials
#               such as DATABASE_ROOT_PASSWORD. Read by Compose for `${...}`
#               interpolation. It is never passed into the Ghost container.
#
#   ghost.env   Ghost application settings only, in Ghost's `section__key`
#               form. It is the only `env_file` of the ghost service. Keys that
#               the container owns are set as explicit Compose `environment`
#               entries, which override `env_file`, and must not appear here.
#
# Requirements are validated by mode, not by putting `:?` guards on
# optional-service variables. Compose interpolates inactive services too, so a
# `:?` guard on a production-only variable would break local mode.

# shellcheck disable=SC2034
GD_CONFIG_LIB_LOADED=1

GD_ENV_FILE_NAME=".env"
GD_GHOST_ENV_FILE_NAME="ghost.env"

# Keys required in .env that nothing else would catch. URL, DATABASE_PASSWORD
# and DATABASE_ROOT_PASSWORD are deliberately absent: compose.yml guards those
# with `:?`, so Compose reports them itself, at the point of use.
readonly GD_REQUIRED_KEYS_COMMON=(
    COMPOSE_PROFILES
    COMPOSE_PROJECT_NAME
    SITE_MODE
    PROJECT_DIR
    GHOST_VERSION
)

readonly GD_REQUIRED_KEYS_PRODUCTION=(DOMAIN)

# config_ghost_environment DIR
# The environment Compose actually gives the ghost container, as KEY<TAB>VALUE.
# `docker compose config` is pure parsing and needs no daemon, so this works
# before anything is started. Its output re-escapes `$` as `$$`, which is undone
# here so values compare against decoded ones.
config_ghost_environment() {
    compose_run "$1" config --format json 2>/dev/null |
        jq -r '.services.ghost.environment // {}
               | to_entries[]
               | [.key, (.value // "" | tostring | gsub("[$][$]"; "$"))]
               | @tsv'
}

# config_operator_variables DIR
# The variables Compose interpolates from `.env`. Derived from compose.yml
# itself rather than listed, so it cannot drift when a service gains a setting.
config_operator_variables() {
    local ref
    while read -r ref; do
        printf '%s\n' "${ref#\$\{}"
    done < <(grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' "$1/compose.yml" 2>/dev/null | sort -u)
}

# config_image_content_path IMAGE
# The content path the Ghost image itself declares, via its GHOST_CONTENT
# environment variable. Returns 1 when the image is not available locally, so
# callers treat this as a best-effort check rather than a requirement.
config_image_content_path() {
    local line
    while IFS= read -r line; do
        if [[ $line == GHOST_CONTENT=* ]]; then
            printf '%s\n' "${line#GHOST_CONTENT=}"
            return 0
        fi
    done < <(docker image inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null)
    return 1
}

# config_validate_env DIR
# Validates .env for the mode it declares. Prints findings; returns 1 on error.
#
# Only checks what nothing else catches. A missing URL or DATABASE_PASSWORD, a
# bad restart policy and a bad port are left to Compose and Docker, which
# reject them with clear errors of their own.
config_validate_env() {
    local dir=$1 file=$1/$GD_ENV_FILE_NAME rc=0
    local profiles mode declared_mode unknown key value url domain ap_db extra lint mode_bits

    if [[ ! -f $file ]]; then
        printf 'error: %s is missing\n' "$file"
        return 1
    fi

    profiles=$(env_get "$file" COMPOSE_PROFILES 2>/dev/null) || profiles=
    if [[ -z $profiles ]]; then
        printf 'error: COMPOSE_PROFILES is not set; it must name exactly one site mode (%s)\n' \
            "${GD_SITE_MODES[*]}"
        return 1
    fi

    if ! mode=$(compose_site_mode "$profiles"); then
        printf 'error: COMPOSE_PROFILES=%s must name exactly one site mode (%s)\n' \
            "$profiles" "${GD_SITE_MODES[*]}"
        mode=
        rc=1
    fi

    unknown=$(compose_unknown_profiles "$profiles")
    if [[ -n $unknown ]]; then
        printf 'error: unknown profile(s) in COMPOSE_PROFILES: %s\n' "${unknown//$'\n'/ }"
        rc=1
    fi

    declared_mode=$(env_get "$file" SITE_MODE 2>/dev/null) || declared_mode=
    if [[ -n $mode && -n $declared_mode && $mode != "$declared_mode" ]]; then
        printf 'error: SITE_MODE=%s does not match the site mode in COMPOSE_PROFILES (%s)\n' \
            "$declared_mode" "$mode"
        rc=1
    fi

    local -a required=("${GD_REQUIRED_KEYS_COMMON[@]}")
    [[ $mode == production ]] && required+=("${GD_REQUIRED_KEYS_PRODUCTION[@]}")

    for key in "${required[@]}"; do
        if ! value=$(env_get "$file" "$key" 2>/dev/null); then
            printf 'error: %s is required for mode %s\n' "$key" "${mode:-unknown}"
            rc=1
            continue
        fi
        if [[ -z $value ]]; then
            printf 'error: %s is empty\n' "$key"
            rc=1
        fi
    done

    # Caddy serves a certificate for DOMAIN while Ghost is configured for URL,
    # so a mismatch produces a working server that serves the wrong site.
    if [[ $mode == production ]]; then
        url=$(env_get "$file" URL 2>/dev/null) || url=
        domain=$(env_get "$file" DOMAIN 2>/dev/null) || domain=
        if [[ $url != "https://$domain" && $url != "https://$domain/"* ]]; then
            printf 'error: URL (%s) and DOMAIN (%s) disagree\n' "$url" "$domain"
            rc=1
        fi
    fi

    # The extra databases are created once, on first initialisation. A custom
    # ActivityPub database name that is not in that list would never exist.
    ap_db=$(env_get "$file" ACTIVITYPUB_DATABASE_NAME 2>/dev/null) || ap_db=
    if [[ -n $ap_db ]]; then
        extra=$(env_get "$file" DATABASE_EXTRA_DATABASES 2>/dev/null) || extra=activitypub
        if [[ ,$extra, != *",$ap_db,"* ]]; then
            printf 'error: ACTIVITYPUB_DATABASE_NAME=%s is not listed in DATABASE_EXTRA_DATABASES (%s)\n' \
                "$ap_db" "$extra"
            rc=1
        fi
    fi

    # The image layout moved between variants: `next` installs Ghost under
    # /home/ghost, older tags under /var/lib/ghost. Ask the image what it
    # expects rather than mapping tag names, which would drift. Best effort:
    # skipped when the image has not been pulled.
    local image version declared expected
    image=$(env_get "$file" GHOST_IMAGE 2>/dev/null) || image=
    version=$(env_get "$file" GHOST_VERSION 2>/dev/null) || version=
    declared=$(env_get "$file" GHOST_CONTENT_PATH 2>/dev/null) || declared=/home/ghost/content
    if [[ -n $version ]] && expected=$(config_image_content_path "${image:-ghost}:$version"); then
        if [[ $declared != "$expected" ]]; then
            printf 'error: GHOST_CONTENT_PATH is %s but %s expects %s; set GHOST_CONTENT_PATH and GHOST_TINYBIRD_PATH to match the image\n' \
                "$declared" "${image:-ghost}:$version" "$expected"
            rc=1
        fi
    fi

    if ! lint=$(env_lint "$file"); then
        printf '%s\n' "$lint"
        rc=1
    fi

    mode_bits=$(fs_stat_mode "$file" 2>/dev/null) || mode_bits=
    case $mode_bits in
        600 | 400 | 640 | '') ;;
        *) printf 'warning: %s mode is %s; it holds credentials and should be 0600\n' "$file" "$mode_bits" ;;
    esac

    return $rc
}

# config_validate_ghost_env DIR
# ghost.env holds Ghost application settings only. Two mistakes matter, and
# both are detected rather than listed:
#
#   * a key the container owns. Compose `environment` overrides `env_file`, so
#     setting it here looks effective and is silently ignored. Detected by
#     asking Compose what the container actually receives.
#   * an operator setting in the wrong file. Detected from the variables
#     compose.yml interpolates, plus anything already set in `.env`.
config_validate_ghost_env() {
    local dir=$1 file=$1/$GD_GHOST_ENV_FILE_NAME rc=0
    local key value resolved lint mode_bits
    local -a operator_vars=()

    # ghost.env is optional: a site can run entirely on container-owned config.
    [[ -f $file ]] || return 0

    # KEY<TAB>VALUE of what the container really gets. Empty when compose.yml
    # cannot be resolved, in which case the override check is skipped rather
    # than reporting nonsense.
    local container
    container=$(config_ghost_environment "$dir")
    if [[ -z $container ]]; then
        printf 'warning: could not resolve the Compose configuration; skipping the container-owned key check\n'
    fi

    while read -r key; do
        operator_vars+=("$key")
    done < <(config_operator_variables "$dir")

    while read -r key; do
        value=$(env_get "$file" "$key" 2>/dev/null) || continue

        # Compose merges env_file into the service environment, so every
        # ghost.env key appears here. A different value means an explicit
        # `environment` entry took precedence.
        if [[ -n $container ]] && resolved=$(_gd_container_value "$container" "$key"); then
            if [[ $resolved != "$value" ]]; then
                printf 'error: %s is set by the container (%s) and is ignored in %s\n' \
                    "$key" "${resolved:-<empty>}" "$GD_GHOST_ENV_FILE_NAME"
                rc=1
                continue
            fi
        fi

        if _gd_is_operator_key "$key" "$dir" "${operator_vars[@]}"; then
            printf 'error: %s is an operator setting and belongs in %s\n' "$key" "$GD_ENV_FILE_NAME"
            rc=1
        fi
    done < <(env_keys "$file")

    if ! lint=$(env_lint "$file"); then
        printf '%s\n' "$lint"
        rc=1
    fi

    mode_bits=$(fs_stat_mode "$file" 2>/dev/null) || mode_bits=
    case $mode_bits in
        600 | 400 | 640 | '') ;;
        *) printf 'warning: %s mode is %s; it holds credentials and should be 0600\n' "$file" "$mode_bits" ;;
    esac

    return $rc
}

# _gd_container_value TSV KEY
# Prints the container's value for KEY, or returns 1 when it has none.
_gd_container_value() {
    local k v
    while IFS=$'\t' read -r k v; do
        if [[ $k == "$2" ]]; then
            printf '%s' "$v"
            return 0
        fi
    done <<<"$1"
    return 1
}

# _gd_is_operator_key KEY DIR OPERATOR_VAR...
# True when KEY belongs in .env: Compose interpolates it, it is one of
# Compose's own settings, or .env already defines it.
_gd_is_operator_key() {
    local key=$1 dir=$2 var
    shift 2
    [[ $key == COMPOSE_* ]] && return 0
    for var in "$@"; do
        [[ $key == "$var" ]] && return 0
    done
    env_get "$dir/$GD_ENV_FILE_NAME" "$key" >/dev/null 2>&1
}

# config_validate DIR
config_validate() {
    local rc=0
    config_validate_env "$1" || rc=1
    config_validate_ghost_env "$1" || rc=1
    return $rc
}
