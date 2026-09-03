#!/usr/bin/env bash
# Installation primitives: identity, secrets, Ghost image resolution, prompts,
# and readiness verification.
#
# The policy lives in install.sh; this file holds the pieces that have to be
# testable on their own. Nothing here writes outside the site directory.

# shellcheck disable=SC2034
GD_INSTALL_LIB_LOADED=1

# The image and tag a new site gets when none is requested. The `next` variants
# install Ghost directly under /home/ghost; the exact tag is resolved from the
# image itself, so this is a starting point, not the pin that is written.
GD_DEFAULT_GHOST_IMAGE="ghost"
GD_DEFAULT_GHOST_TAG="6-next-alpine"

# How long to wait for each service to report ready. Ghost's own health check
# allows a 180s start period on a cold boot with migrations to run.
GD_READY_TIMEOUT_DB=${GD_READY_TIMEOUT_DB:-300}
GD_READY_TIMEOUT_GHOST=${GD_READY_TIMEOUT_GHOST:-600}

# install_slug STRING
# A lowercase, dash separated token safe for a Compose project name.
install_slug() {
    printf '%s' "$1" |
        LC_ALL=C tr '[:upper:]' '[:lower:]' |
        LC_ALL=C sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-\{1,\}//' -e 's/-\{1,\}$//'
}

# install_project_name MODE DOMAIN DIR
# The site's stable identity, and the suffix of every service network alias. It
# is derived once and then persisted in `.env`: it must not change when the
# directory is renamed or the site is moved.
#
# Two local sites on one host must not collide, so a local name is derived from
# the site directory rather than being a constant.
install_project_name() {
    local mode=$1 domain=$2 dir=$3 slug
    if [[ $mode == production ]]; then
        slug=$(install_slug "$domain")
        [[ -n $slug ]] || return 1
        printf 'ghost-%s\n' "$slug"
        return 0
    fi
    slug=$(install_slug "$(basename "$dir")")
    [[ -n $slug ]] || slug=site
    printf 'ghost-local-%s\n' "$slug"
}

# install_secret [BYTES]
# A generated credential. Hex so that the value has no dotenv, shell or MySQL
# metacharacters in it, at 2 characters per byte; 16 bytes is 128 bits.
#
# `head -c` reads from /dev/urandom directly rather than through a pipe, so
# there is no upstream process to be killed by SIGPIPE under `set -o pipefail`.
install_secret() {
    local bytes=${1:-16} out
    out=$(head -c "$bytes" /dev/urandom | od -An -v -tx1 | LC_ALL=C tr -d ' \n')
    [[ -n $out ]] || return 1
    printf '%s\n' "$out"
}

# install_ghost_tag REQUESTED
# Turns what the operator asked for into a tag to pull. A bare version selects
# the default variant; anything else is already a tag and is used as given.
install_ghost_tag() {
    local requested=$1
    [[ -n $requested ]] || {
        printf '%s\n' "$GD_DEFAULT_GHOST_TAG"
        return 0
    }
    requested=${requested#v}
    if [[ $requested =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
        local variant=${GD_DEFAULT_GHOST_TAG#*-}
        printf '%s-%s\n' "$requested" "$variant"
        return 0
    fi
    printf '%s\n' "$requested"
}

# _gd_tag_variant TAG
# The part of a tag that is not the version: `6-next-alpine` -> `next-alpine`,
# `6.3.1-alpine` -> `alpine`, `next-alpine` -> `next-alpine`, `6` -> ``.
_gd_tag_variant() {
    local tag=$1
    if [[ $tag =~ ^[0-9]+(\.[0-9]+)*(-(.*))?$ ]]; then
        printf '%s\n' "${BASH_REMATCH[3]}"
        return 0
    fi
    printf '%s\n' "$tag"
}

# _gd_image_env IMAGE_REF NAME
# One environment variable declared by an image, without running it.
_gd_image_env() {
    local line
    while IFS= read -r line; do
        if [[ $line == "$2="* ]]; then
            printf '%s\n' "${line#"$2"=}"
            return 0
        fi
    done < <(docker image inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null)
    return 1
}

# _gd_image_digest IMAGE_REF REPOSITORY
_gd_image_digest() {
    local line
    while IFS= read -r line; do
        [[ $line == "$2@"* ]] || continue
        printf '%s\n' "${line#*@}"
        return 0
    done < <(docker image inspect "$1" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null)
    return 1
}

# _gd_image_tinybird_path IMAGE_REF INSTALL_PATH
# Where the image keeps the Tinybird datafiles. The two published layouts put
# them in different places, so the image is asked rather than the tag name
# being mapped to a layout — a mapping would drift the next time the layout
# changes. The environment-based fallback keeps this working if the probe
# cannot run.
_gd_image_tinybird_path() {
    local image=$1 install=$2 out
    out=$(docker run --rm --entrypoint sh "$image" -c '
        for p in "$GHOST_INSTALL/core/server/data/tinybird" \
                 "$GHOST_INSTALL/current/core/server/data/tinybird"; do
            [ -d "$p" ] && { printf "%s" "$p"; exit 0; }
        done
        exit 1' 2>/dev/null) && [[ -n $out ]] && {
        printf '%s\n' "$out"
        return 0
    }

    if _gd_image_env "$image" GHOST_CLI_INSTALL >/dev/null 2>&1; then
        printf '%s/current/core/server/data/tinybird\n' "$install"
    else
        printf '%s/core/server/data/tinybird\n' "$install"
    fi
}

# install_resolve_ghost IMAGE REQUESTED
# Resolves the requested version to one exact image and prints, tab separated:
#
#   TAG  VERSION  DIGEST  CONTENT_PATH  TINYBIRD_PATH
#
# TAG is the exact pin written to `.env`; a moving tag is never persisted.
# DIGEST is the immutable identity, recorded in `.ghost-docker.json` so the
# image can be identified again during recovery. The paths come from the
# image's own GHOST_CONTENT and GHOST_INSTALL, so the mounted content directory
# and the image layout cannot disagree.
install_resolve_ghost() {
    local image=$1 requested=$2
    local tag version content install digest variant exact ref exact_ref tinybird

    tag=$(install_ghost_tag "$requested")
    ref="$image:$tag"

    if ! docker pull --quiet "$ref" >/dev/null 2>&1; then
        printf 'error: could not pull %s. Check the version and that this host can reach the registry.\n' "$ref" >&2
        return 1
    fi

    version=$(_gd_image_env "$ref" GHOST_VERSION) || {
        printf 'error: %s does not declare GHOST_VERSION; it does not look like a Ghost image\n' "$ref" >&2
        return 1
    }
    content=$(_gd_image_env "$ref" GHOST_CONTENT) || content=/home/ghost/content
    install=$(_gd_image_env "$ref" GHOST_INSTALL) || install=/home/ghost

    # Prefer the immutable tag for that exact version, so the pin does not move
    # under the site the next time the registry updates a rolling tag. It is
    # accepted only when it is the same image.
    variant=$(_gd_tag_variant "$tag")
    if [[ -n $variant ]]; then
        exact="$version-$variant"
    else
        exact=$version
    fi
    exact_ref="$image:$exact"
    if [[ $exact != "$tag" ]] && docker pull --quiet "$exact_ref" >/dev/null 2>&1; then
        if [[ $(docker image inspect "$exact_ref" --format '{{.Id}}' 2>/dev/null) == \
            $(docker image inspect "$ref" --format '{{.Id}}' 2>/dev/null) ]]; then
            tag=$exact
            ref=$exact_ref
        fi
    fi

    digest=$(_gd_image_digest "$ref" "$image") || digest=""
    tinybird=$(_gd_image_tinybird_path "$ref" "$install")

    printf '%s\t%s\t%s\t%s\t%s\n' "$tag" "$version" "$digest" "$content" "$tinybird"
}

# --- Prompting -------------------------------------------------------------
#
# Prompts read from /dev/tty rather than stdin, so that an installer piped from
# curl can still ask a question. Where there is no terminal, or --no-prompt was
# given, a required answer is an error naming the flag that supplies it: no
# prompt has a silent default.

GD_NO_PROMPT=${GD_NO_PROMPT:-0}

# install_can_prompt
install_can_prompt() {
    ((GD_NO_PROMPT)) && return 1
    [[ -r /dev/tty && -w /dev/tty ]]
}

# install_ask PROMPT [DEFAULT]
# Prints the answer. Returns 1 when there is no way to ask.
install_ask() {
    local prompt=$1 default=${2:-} answer
    install_can_prompt || return 1
    if [[ -n $default ]]; then
        printf '%s [%s]: ' "$prompt" "$default" >/dev/tty
    else
        printf '%s: ' "$prompt" >/dev/tty
    fi
    IFS= read -r answer </dev/tty || return 1
    [[ -n $answer ]] || answer=$default
    printf '%s\n' "$answer"
}

# install_ask_secret PROMPT
# As install_ask, without echoing the answer.
install_ask_secret() {
    local prompt=$1 answer
    install_can_prompt || return 1
    printf '%s: ' "$prompt" >/dev/tty
    IFS= read -r -s answer </dev/tty || return 1
    printf '\n' >/dev/tty
    printf '%s\n' "$answer"
}

# install_require VALUE PROMPT FLAG
# A required input: the value if it was supplied, otherwise a prompt, otherwise
# an error naming the flag or variable that provides it non-interactively.
install_require() {
    local value=$1 prompt=$2 flag=$3
    if [[ -n $value ]]; then
        printf '%s\n' "$value"
        return 0
    fi
    if value=$(install_ask "$prompt"); then
        [[ -n $value ]] && {
            printf '%s\n' "$value"
            return 0
        }
    fi
    printf 'error: %s is required; supply it with %s\n' "$prompt" "$flag" >&2
    return 1
}

# --- Readiness -------------------------------------------------------------

# install_service_id DIR SERVICE
install_service_id() {
    compose_run "$1" ps -q "$2" 2>/dev/null | head -1
}

# install_wait_healthy DIR SERVICE TIMEOUT
# Waits for a service's own health check, not for a running container. Fails
# early when the container has exited: waiting out a timeout on a container
# that is already gone tells the operator nothing.
install_wait_healthy() {
    local dir=$1 service=$2 timeout=$3 waited=0 id state health
    while ((waited < timeout)); do
        id=$(install_service_id "$dir" "$service")
        if [[ -n $id ]]; then
            state=$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || printf '')
            health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || printf '')
            case $state in
                exited | dead)
                    printf 'error: the %s container exited before it became ready\n' "$service" >&2
                    return 1
                    ;;
            esac
            [[ $health == healthy ]] && return 0
            # A service with no health check is ready when it is running.
            [[ $health == none && $state == running ]] && return 0
        fi
        sleep 3
        waited=$((waited + 3))
    done
    printf 'error: %s did not become ready within %ss\n' "$service" "$timeout" >&2
    return 1
}

# install_http_head HOST PORT PATH [HOST_HEADER]
# The status line and headers of one HTTP response, using bash's own /dev/tcp
# so that neither curl nor wget has to be installed on the host.
install_http_head() {
    local host=$1 port=$2 path=$3 host_header=${4:-$1} line

    exec 3<>"/dev/tcp/$host/$port" 2>/dev/null || return 1
    printf 'GET %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\nUser-Agent: ghost-docker-install\r\nAccept: */*\r\n\r\n' \
        "$path" "$host_header" >&3 || {
        exec 3<&-
        exec 3>&-
        return 1
    }
    while IFS= read -r -t 20 line <&3; do
        line=${line%$'\r'}
        [[ -z $line ]] && break
        printf '%s\n' "$line"
    done
    exec 3<&-
    exec 3>&-
}

# install_http_status HOST PORT PATH [HOST_HEADER]
install_http_status() {
    local head status
    head=$(install_http_head "$@") || return 1
    status=$(printf '%s\n' "$head" | head -1)
    [[ $status =~ ^HTTP/[0-9.]+[[:space:]]+([0-9]{3}) ]] || return 1
    printf '%s\n' "${BASH_REMATCH[1]}"
}

# install_https_status DIR DOMAIN
# The status of an Admin API request through Caddy's HTTPS listener, made from
# inside the site network with the right SNI and Host. It runs in the Ghost
# container because TLS is beyond what bash's /dev/tcp can do, and neither curl
# nor openssl is a host requirement — while a Ghost image always has node.
install_https_status() {
    local dir=$1 domain=$2 out path script

    path=$(env_get "$dir/.env" GHOST_HEALTHCHECK_PATH 2>/dev/null) || path=/ghost/api/admin/site/
    [[ -n $path ]] || path=/ghost/api/admin/site/

    script=$(
        cat <<'NODE'
const https = require('https');
const [domain, path] = process.argv.slice(1);
const req = https.request({
    host: 'caddy', port: 443, servername: domain, path,
    headers: { Host: domain }, rejectUnauthorized: false, timeout: 20000,
}, (res) => { res.resume(); process.stdout.write(String(res.statusCode)); });
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
req.end();
NODE
    )

    out=$(compose_run "$dir" exec -T ghost node -e "$script" "$domain" "$path" 2>/dev/null) || return 1
    [[ $out =~ ^[0-9]{3}$ ]] || return 1
    printf '%s\n' "$out"
}

# install_verify_ingress DIR MODE GHOST_PORT HTTP_PORT DOMAIN [ADMIN_DOMAIN]
# Confirms the Admin API answers through the ingress the site actually uses:
# the published loopback port in local mode, and Caddy in production.
#
# The HTTPS leg is a warning rather than a failure, deliberately. Caddy orders a
# certificate on the first request for a name, so a site installed before its
# DNS is pointed has no certificate yet and cannot have one. That is an expected
# state on a fresh production install, not a broken site — the routing checks
# above are the ones that prove the configuration is right.
install_verify_ingress() {
    local dir=$1 mode=$2 ghost_port=$3 http_port=$4 domain=$5 admin=${6:-}
    local status rc=0 path

    path=$(env_get "$dir/.env" GHOST_HEALTHCHECK_PATH 2>/dev/null) || path=/ghost/api/admin/site/
    [[ -n $path ]] || path=/ghost/api/admin/site/

    if status=$(install_http_status 127.0.0.1 "$ghost_port" "$path" localhost); then
        if [[ $status == 200 ]]; then
            printf 'ok       Ghost answers on 127.0.0.1:%s%s\n' "$ghost_port" "$path"
        else
            printf 'ERROR    Ghost answered %s on 127.0.0.1:%s%s\n' "$status" "$ghost_port" "$path" >&2
            rc=1
        fi
    else
        printf 'ERROR    nothing answered on 127.0.0.1:%s\n' "$ghost_port" >&2
        rc=1
    fi

    [[ $mode == production ]] || return $rc

    if ! caddy_verify "$dir" "$domain" "$admin"; then
        rc=1
    else
        printf 'ok       Caddy routes %s\n' "$domain"
    fi

    if status=$(install_http_status 127.0.0.1 "$http_port" / "$domain"); then
        if [[ $status =~ ^3 ]]; then
            printf 'ok       Caddy redirects http://%s to HTTPS\n' "$domain"
        else
            printf 'ERROR    Caddy answered %s for http://%s instead of a redirect to HTTPS\n' "$status" "$domain" >&2
            rc=1
        fi
    else
        printf 'ERROR    Caddy did not answer on 127.0.0.1:%s\n' "$http_port" >&2
        rc=1
    fi

    if status=$(install_https_status "$dir" "$domain") && [[ $status == 200 ]]; then
        printf 'ok       Ghost Admin answers over HTTPS at %s\n' "$domain"
    else
        printf 'warning  HTTPS for %s is not serving yet. Caddy orders a certificate on the\n' "$domain" >&2
        printf '         first request for the name, so point this domain at this host if you\n' >&2
        printf '         have not already. Routing itself is configured correctly.\n' >&2
    fi

    return $rc
}
