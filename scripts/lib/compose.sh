#!/usr/bin/env bash
# Docker Compose invocation contract and profile rules.
#
# Helpers run Compose from outside the site directory, so they go through
# compose_run: `--project-directory` (never `-C`), an explicit file list, and
# no inherited `COMPOSE_FILE`, which would change override auto-loading.
# Operators running `docker compose` from the site directory get the same
# result.

# shellcheck disable=SC2034
GD_COMPOSE_LIB_LOADED=1

# Declared minimum supported versions, verified in tests against this exact
# minimum and the current release. install.sh checks them during preflight.
#   - `depends_on: required` needs Compose >= 2.20.0
#   - `env_file: [{path, required}]` needs Compose >= 2.24.0
#   - `healthcheck.start_interval` needs Docker Engine >= 25.0.0
readonly GD_MIN_COMPOSE_VERSION="2.24.0"
readonly GD_MIN_DOCKER_VERSION="25.0.0"

readonly GD_SITE_MODES=(local production)
readonly GD_OPTIONAL_PROFILES=(analytics activitypub supervisor)

# Services whose lifecycle is one-shot. They keep `restart: "no"`.
readonly GD_ONE_SHOT_SERVICES=(activitypub-migrate tinybird-login tinybird-sync tinybird-deploy)

# compose_run DIR ARGS...
# Set GD_COMPOSE_OVERRIDES to a comma separated list of extra files, for
# example `compose.ipv6.yml`.
compose_run() {
    local dir=$1
    shift
    local -a files=(-f "$dir/compose.yml")

    if [[ -n ${GD_COMPOSE_OVERRIDES:-} ]]; then
        local override
        local -a overrides
        IFS=, read -ra overrides <<<"$GD_COMPOSE_OVERRIDES"
        for override in "${overrides[@]}"; do
            [[ -n $override ]] || continue
            if [[ $override == /* ]]; then
                files+=(-f "$override")
            else
                files+=(-f "$dir/$override")
            fi
        done
    fi

    (
        unset COMPOSE_FILE
        exec docker compose --project-directory "$dir" "${files[@]}" "$@"
    )
}

# _gd_split_profiles PROFILES -> one trimmed, non-empty profile per line
_gd_split_profiles() {
    local -a parts
    local part
    IFS=, read -ra parts <<<"$1"
    for part in "${parts[@]}"; do
        # Trim surrounding whitespace without relying on GNU-only behaviour.
        part=${part#"${part%%[![:space:]]*}"}
        part=${part%"${part##*[![:space:]]}"}
        [[ -n $part ]] && printf '%s\n' "$part"
    done
}

# compose_site_mode PROFILES
# Prints the single site mode named in a COMPOSE_PROFILES value, or fails when
# zero or more than one is present. Profiles are additive: optional profiles
# never select a mode and never combine as a condition.
compose_site_mode() {
    local profile mode found="" count=0
    while read -r profile; do
        for mode in "${GD_SITE_MODES[@]}"; do
            if [[ $profile == "$mode" ]]; then
                found=$profile
                count=$((count + 1))
            fi
        done
    done < <(_gd_split_profiles "$1")

    ((count == 1)) || return 1
    printf '%s\n' "$found"
}

# compose_unknown_profiles PROFILES
# Prints any profile that is neither a site mode nor a known optional profile.
compose_unknown_profiles() {
    local profile known
    while read -r profile; do
        for known in "${GD_SITE_MODES[@]}" "${GD_OPTIONAL_PROFILES[@]}"; do
            [[ $profile == "$known" ]] && continue 2
        done
        printf '%s\n' "$profile"
    done < <(_gd_split_profiles "$1")
}
