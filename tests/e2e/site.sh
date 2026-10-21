# shellcheck shell=bash
# Sourced by lib.sh: what the end-to-end scripts do to a site the manager
# made. Each takes the site's directory first; a script with one site passes
# its own. A script redefines what differs for it: backup.sh reaches its site
# through Caddy over HTTPS, production-import.sh's new sites carry a test CA,
# and the released main layout has no launcher for `setting` to run. Written
# for bash 3.2, which launcher.sh runs on.

# new_site NAME -- SITE, an empty directory under WORK/sites that the script's
# teardown takes down. Not a command substitution: SITES has to grow in this
# shell, not a subshell.
new_site() {
    # shellcheck disable=SC2034 # read by the script that called it
    SITE=$WORK/sites/$1
    mkdir -p "$SITE"
    SITES+=("$SITE")
}

# compose_in SITE ARGS... -- Compose as an operator runs it, from the host.
compose_in() {
    local site=$1
    shift
    docker compose --project-directory "$site" -f "$site/compose.yml" "$@"
}

# setting SITE [FILE] KEY -- one decoded value, through the site's own launcher.
setting() { "$1/ghost-docker" --dir "$1" config get "${@:2}" 2>/dev/null; }

# records SITE KEY VALUE -- whether the site's metadata holds "KEY": "VALUE".
records() { grep -q "\"$2\": \"$3\"" "$1/.ghost-docker.json"; }

# fingerprint SITE -- every file with its checksum, to compare before and
# after: not the data, the backups, git's own files or an update's snapshot.
fingerprint() {
    (cd "$1" && find . -type f -not -path './data/*' -not -path './backups/*' -not -path './.git/*' \
        -not -path './.ghost-docker-update/*' -print0 | sort -z | xargs -0 shasum -a 256)
}

# root_sql SITE SQL -- as MySQL's root, in the site's database container.
root_sql() {
    local database
    database=$(setting "$1" DATABASE_NAME || true)
    compose_in "$1" exec -T -e MYSQL_PWD="$(setting "$1" DATABASE_ROOT_PASSWORD)" db \
        mysql -uroot -N -B "${database:-ghost}" -e "$2"
}

# http_status PORT [HOST] -- what the Admin API answers on the host's own
# loopback port.
http_status() {
    curl --silent --noproxy '*' --max-time 20 --output /dev/null --write-out '%{http_code}' \
        --header "Host: ${2:-localhost}" "http://127.0.0.1:$1/ghost/api/admin/site/" || true
}

# base_of SITE -- the site's URL, as this host reaches it.
base_of() { printf 'http://localhost:%s' "$(setting "$1" GHOST_PORT)"; }

# site_curl ARGS... -- curl, as the checks ask a site.
site_curl() { curl --disable --silent --noproxy '*' "$@"; }

# make_owner SITE NAME TITLE -- the owner account: OWNER_EMAIL, with
# OWNER_PASSWORD.
make_owner() {
    local base body
    base=$(base_of "$1")
    body=$(site_curl --max-time 60 --request POST \
        --header 'Content-Type: application/json' --header "Origin: $base" \
        --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg n "$2" --arg t "$3" \
            '{setup: [{name: $n, email: $e, password: $p, blogTitle: $t}]}')" \
        "$base/ghost/api/admin/authentication/setup/")
    jq -e '.users[0].id' <<<"$body" >/dev/null 2>&1 || fail "setting up the owner failed" "$body"
}

# sign_in SITE -- with the owner's password; the session goes in SITE.cookies.
sign_in() {
    local base status
    base=$(base_of "$1")
    status=$(site_curl --max-time 30 --output "$1.session" --write-out '%{http_code}' \
        --cookie-jar "$1.cookies" --request POST --header 'Content-Type: application/json' \
        --header "Origin: $base" \
        --data "$(jq -cn --arg u "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" '{username: $u, password: $p}')" \
        "$base/ghost/api/admin/session/")
    [[ $status == 201 ]] || fail "signing in at $base answered $status" "$(cat "$1.session")"
}

# api SITE METHOD PATH [curl options] -- the Admin API, signed in.
api() {
    local site=$1 method=$2 path=$3 base
    shift 3
    base=$(base_of "$site")
    site_curl --max-time 60 --cookie "$site.cookies" \
        --header "Origin: $base" --request "$method" "$@" "$base/ghost/api/admin/$path"
}

# post_titles SITE -- every post's title, one per line, sorted.
post_titles() {
    api "$1" GET 'posts/?limit=all&fields=title' | jq -r '.posts[].title' | sort
}
