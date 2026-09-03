#!/usr/bin/env bash
# Inspect the sites on this host.
#
#   scripts/site.sh list           every container this stack manages
#   scripts/site.sh check [DIR]    diagnose one site
#   scripts/site.sh info [DIR]     print the recorded installation metadata
#
# `list` reads Docker's own labels, including stopped containers, so a site
# that is down still appears. There is no registry of installations: a checkout
# whose containers have never been created is not discoverable from here, and
# `list` says so rather than implying the list is complete.
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "$0")/lib/common.sh"

readonly MANAGED_LABEL="org.ghost.docker.managed=true"

site_list() {
    local out
    if ! docker_responsive; then
        printf 'The Docker daemon is not reachable, so no containers can be listed.\n' >&2
        return 1
    fi

    out=$(docker ps -a \
        --filter "label=$MANAGED_LABEL" \
        --format '{{.Label "org.ghost.docker.site"}}	{{.Label "org.ghost.docker.mode"}}	{{.Label "org.ghost.docker.role"}}	{{.Label "org.ghost.docker.lifecycle"}}	{{.Status}}' \
        2>/dev/null | sort)

    if [[ -z $out ]]; then
        printf 'No ghost-docker containers exist on this host.\n'
    else
        printf '%-28s %-11s %-20s %-11s %s\n' SITE MODE SERVICE LIFECYCLE STATUS
        local site mode role lifecycle status
        while IFS=$'\t' read -r site mode role lifecycle status; do
            printf '%-28s %-11s %-20s %-11s %s\n' "$site" "$mode" "$role" "$lifecycle" "$status"
        done <<<"$out"
    fi

    printf '\nOnly sites whose containers exist are listed. A checkout that has never\n'
    printf 'been started has no containers and no host-wide registry to be found in;\n'
    # shellcheck disable=SC2016  # backticks are prose here
    printf 'run `scripts/site.sh check` from inside it instead.\n'
}

# _db_reachable DIR
# A real client connection to the application database, not a running
# container. The password goes through MYSQL_PWD so that it does not appear in
# the container's process list.
_db_reachable() {
    local dir=$1 env=$1/.env user database password
    user=$(env_get "$env" DATABASE_USER 2>/dev/null) || user=ghost
    database=$(env_get "$env" DATABASE_NAME 2>/dev/null) || database=ghost
    password=$(env_get "$env" DATABASE_PASSWORD 2>/dev/null) || return 1
    MYSQL_PWD=$password compose_run "$dir" exec -T \
        -e MYSQL_PWD \
        db mysql -h 127.0.0.1 -u "$user" -e 'SELECT 1' "$database" >/dev/null 2>&1
}

site_check() {
    local dir=$1 rc=0 records mode profiles port http_port domain admin id health

    printf 'Site directory\n  %s\n\n' "$dir"

    if [[ ! -f $dir/$GD_ENV_FILE_NAME ]]; then
        printf 'error: %s/%s does not exist; this directory does not hold a site.\n' \
            "$dir" "$GD_ENV_FILE_NAME" >&2
        return 1
    fi

    profiles=$(env_get "$dir/$GD_ENV_FILE_NAME" COMPOSE_PROFILES 2>/dev/null) || profiles=""
    mode=$(compose_site_mode "$profiles" 2>/dev/null) || mode=""
    port=$(env_get "$dir/$GD_ENV_FILE_NAME" GHOST_PORT 2>/dev/null) || port=2368
    http_port=$(env_get "$dir/$GD_ENV_FILE_NAME" HTTP_PORT 2>/dev/null) || http_port=80
    domain=$(env_get "$dir/$GD_ENV_FILE_NAME" DOMAIN 2>/dev/null) || domain=""
    admin=$(env_get "$dir/$GD_ENV_FILE_NAME" ADMIN_DOMAIN 2>/dev/null) || admin=""

    printf 'Installation\n'
    meta_describe "$dir" | sed 's/^/  /' || rc=1
    printf '\n'

    # Host checks first: they are the ones that still work when Docker is
    # broken, which is when a doctor command matters most. The site's own ports
    # are expected to be in use here, so they are not re-checked as conflicts.
    printf 'Host\n'
    records=$(
        preflight_os
        preflight_commands "${GD_REQUIRED_COMMANDS[@]}"
        preflight_docker
        preflight_disk "$dir"
        preflight_memory
    )
    preflight_render "$records"
    preflight_failed "$records" && rc=1

    printf '\nConfiguration\n'
    if config_validate "$dir" | sed 's/^/  /'; then
        printf '  ok       .env and ghost.env are valid for mode %s\n' "${mode:-unknown}"
    else
        rc=1
    fi

    if ! docker_responsive; then
        printf '\nServices\n  skipped: the Docker daemon is not reachable.\n'
        return 1
    fi

    printf '\nServices\n'
    local service
    for service in db ghost caddy; do
        [[ $service != caddy || $mode == production ]] || continue
        id=$(install_service_id "$dir" "$service" || printf '')
        if [[ -z $id ]]; then
            printf '  ERROR    %-8s no container. Start it with: docker compose up -d\n' "$service" >&2
            rc=1
            continue
        fi
        health=$(docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || printf 'unknown')
        case $health in
            running | running/healthy) printf '  ok       %-8s %s\n' "$service" "$health" ;;
            *)
                printf '  ERROR    %-8s %s\n' "$service" "$health" >&2
                rc=1
                ;;
        esac
    done

    if _db_reachable "$dir"; then
        printf '  ok       database  accepts a client connection to the application database\n'
    else
        printf '  ERROR    database  could not be reached with the configured credentials\n' >&2
        rc=1
    fi

    printf '\nIngress\n'
    install_verify_ingress "$dir" "${mode:-local}" "$port" "$http_port" "$domain" "$admin" |
        sed 's/^/  /' || rc=1

    printf '\n'
    if ((rc == 0)); then
        printf 'This site looks healthy.\n'
    else
        printf 'Problems were reported above.\n' >&2
    fi
    return $rc
}

cmd=${1:-}
(($#)) && shift || true

case "$cmd" in
    list) site_list ;;
    check | doctor) site_check "${1:-$GD_ROOT_DIR}" ;;
    info) meta_describe "${1:-$GD_ROOT_DIR}" ;;
    '' | -h | --help | help) usage ;;
    *)
        printf 'unknown command: %s\n' "$cmd" >&2
        usage >&2
        exit 2
        ;;
esac
