#!/usr/bin/env bash
# Real updates between releases, against real containers.
#
#   tests/e2e/self-update.sh
#
# Image mode: three releases of the manager image are built from this
# checkout, tagged as the launcher names releases but never pushed: the first,
# a second that changes two stack files, and a third whose compose.yml does
# not resolve. A local site installed from the first is updated to the
# second with one of those files edited, then refused a downgrade, then
# updated to the third, which fails and is put back.
#
# Clone mode: a copy of this checkout, as a git repository, is installed at
# one commit, refused an update with local changes, and updated to a commit
# whose Ghost never becomes healthy, which is put back.
#
# It pulls images, starts containers and binds a loopback port. Exits non-zero
# at the first check that fails, naming it.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
REGISTRY=ghcr.io/tryghost/ghost-docker
# Versions no real release has, so a published image is never mistaken for these.
R1=v0.0.1-beta.1
R2=v0.0.1-beta.2
R3=v0.0.1-beta.3

if ! docker info >/dev/null 2>&1; then
    printf 'skipped: no Docker daemon answers here\n'
    exit 0
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ghost-docker-update-e2e.XXXXXXXX")
WORK=$(CDPATH='' cd -- "$WORK" && pwd -P)
CURRENT=setup
OUT=""
RC=0
SITES=()

cleanup() {
    local rc=$? site
    set +e
    for site in ${SITES[@]+"${SITES[@]}"}; do
        [[ -f $site/.env ]] && docker compose --project-directory "$site" -f "$site/compose.yml" \
            down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1
    done
    docker run --rm --user 0 --entrypoint rm -v "$WORK:/work" "$REGISTRY:$R1" -rf /work/sites >/dev/null 2>&1
    docker rmi "$REGISTRY:$R1" "$REGISTRY:$R2" "$REGISTRY:$R3" >/dev/null 2>&1
    case $WORK in */ghost-docker-update-e2e.*) rm -rf -- "$WORK" ;; esac
    exit "$rc"
}
trap cleanup EXIT

step() {
    CURRENT=$1
    printf '\n== %s\n' "$1"
}
ok() { printf '   ok    %s\n' "$1"; }
fail() {
    printf '\nFAILED in "%s": %s\n' "$CURRENT" "$1" >&2
    [[ -z ${2:-} ]] || printf -- '--- output ---\n%s\n--------------\n' "$2" >&2
    exit 1
}

run() {
    set +e
    OUT=$("$@" 2>&1 </dev/null)
    RC=$?
    set -e
}
expect_status() { [[ $RC -eq $1 ]] || fail "exited $RC, expected $1" "$OUT"; }
expect_output() { grep -qE -- "$1" <<<"$OUT" || fail "the output does not match: $1" "$OUT"; }

compose_in() {
    local site=$1
    shift
    docker compose --project-directory "$site" -f "$site/compose.yml" "$@"
}
setting() { "$1/ghost-docker" --dir "$1" config get "$2" 2>/dev/null; }
# Does the metadata hold this "key": "value"?
records() { grep -q "\"$2\": \"$3\"" "$1/.ghost-docker.json"; }
pinned() { sed -n 's/^readonly GD_PINNED_IMAGE="\(.*\)"$/\1/p' "$1/ghost-docker"; }
# The pin the manager writes for a local image: its repository digest where
# the image store gives local builds one (containerd's does), else its ID.
image_id() {
    local digest
    digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$1" | grep "^$REGISTRY@" | head -1 || true)
    printf '%s\n' "${digest:-$(docker image inspect --format '{{.Id}}' "$1")}"
}
ghost_container() { compose_in "$1" ps -q ghost; }
http_status() {
    curl --silent --noproxy '*' --max-time 20 --output /dev/null --write-out '%{http_code}' \
        "http://127.0.0.1:$1/ghost/api/admin/site/" || true
}
# Every file under a directory with its checksum, to compare before and after.
fingerprint() {
    (cd "$1" && find . -type f -not -path './data/*' -not -path './.git/*' -print0 | sort -z |
        xargs -0 shasum -a 256)
}

new_site() {
    SITE=$WORK/sites/$1
    mkdir -p "$SITE"
    SITES+=("$SITE")
}

# A copy of this checkout's files, to build a release from or to make a clone of.
copy_tree() {
    mkdir -p "$1"
    (cd "$ROOT" && tar --exclude ./.git --exclude ./data --exclude '*/node_modules' \
        --exclude ./.env --exclude ./ghost.env --exclude ./.ghost-docker.json -cf - .) |
        (cd "$1" && tar -xf -)
}

build_release() {
    local version=$1 tree=$2 commit
    commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf '')
    run docker build --quiet --file "$tree/manager/Dockerfile" --build-arg "GD_VERSION=$version" \
        --build-arg "GD_COMMIT=$commit" --tag "$REGISTRY:$version" "$tree"
    expect_status 0
}

# --- Three releases ----------------------------------------------------------

step "Build three releases of the manager image"
build_release "$R1" "$ROOT"
copy_tree "$WORK/r2"
printf '# changed in %s\n' "$R2" >>"$WORK/r2/compose.ipv6.yml"
printf '# changed in %s\n' "$R2" >>"$WORK/r2/caddy/snippets/Logging"
build_release "$R2" "$WORK/r2"
copy_tree "$WORK/r3"
cp "$WORK/r2/caddy/snippets/Logging" "$WORK/r3/caddy/snippets/Logging"
cp "$WORK/r2/compose.ipv6.yml" "$WORK/r3/compose.ipv6.yml"
# shellcheck disable=SC2016 # for Compose to interpolate
printf 'x-requires: ${GD_E2E_NO_SITE_HAS_THIS:?this release needs a setting no site has}\n' >>"$WORK/r3/compose.yml"
build_release "$R3" "$WORK/r3"
ok "$R1, $R2 (two stack files changed), $R3 (compose.yml does not resolve)"

# --- Image mode ------------------------------------------------------------------

step "A local site, installed from the first"
new_site update-image
S=$SITE
cp "$ROOT/ghost-docker" "$WORK/launcher"
run env GD_IMAGE="$REGISTRY:$R1" "$WORK/launcher" --dir "$S" install --local --no-prompt
expect_status 0
[[ $(pinned "$S") == "$(image_id "$REGISTRY:$R1")" ]] || fail "the launcher is pinned to $(pinned "$S")"
ghost_pin=$(setting "$S" GHOST_IMAGE_REF)
port=$(setting "$S" GHOST_PORT)
ok "$R1, Ghost $ghost_pin on 127.0.0.1:$port"

step "--check says what would change, and changes nothing"
printf '# mine\n' >>"$S/caddy/snippets/Logging"
before=$(fingerprint "$S")
run "$S/ghost-docker" --dir "$S" self-update --check --to "$R2"
expect_status 0
expect_output "This site runs $R1\\. This release is $R2\\."
expect_output 'compose\.ipv6\.yml: replaced'
expect_output 'caddy/snippets/Logging: edited, kept'
[[ $(fingerprint "$S") == "$before" ]] || fail "--check changed files"
ok "an update is available"

step "Updated to the second, keeping the edited file"
ghost_before=$(ghost_container "$S")
run "$S/ghost-docker" --dir "$S" self-update --to "$R2"
expect_status 0
expect_output "Updated from $R1 to $R2"
[[ $(setting "$S" GHOST_IMAGE_REF) == "$ghost_pin" ]] || fail "the Ghost pin changed"
running=$(docker inspect -f '{{.Config.Image}}' "$(ghost_container "$S")")
[[ $running == "$ghost_pin" ]] || fail "Ghost runs $running, not $ghost_pin"
[[ $(pinned "$S") == "$(image_id "$REGISTRY:$R2")" ]] || fail "the launcher was not re-pinned: $(pinned "$S")"
records "$S" version "$R2" || fail "the metadata does not record $R2" "$(cat "$S/.ghost-docker.json")"
cmp -s "$S/compose.ipv6.yml" "$WORK/r2/compose.ipv6.yml" || fail "the untouched compose.ipv6.yml was not replaced"
grep -qx '# mine' "$S/caddy/snippets/Logging" || fail "the edited Logging snippet was replaced"
cmp -s "$S/caddy/snippets/Logging.new" "$WORK/r2/caddy/snippets/Logging" || fail "Logging.new is not the release's"
[[ ! -e $S/.ghost-docker-update && ! -e $S/.ghost-docker.lock ]] || fail "the update left its snapshot or lock"
[[ $(http_status "$port") == 200 ]] || fail "the site does not answer on 127.0.0.1:$port"
[[ -n $ghost_before ]] || fail "Ghost was not running before"
ok "Ghost pin unchanged, launcher re-pinned, Logging kept with Logging.new beside it"

run "$S/ghost-docker" --dir "$S" check
expect_status 0
ok "check passes"

step "A downgrade is refused"
before=$(fingerprint "$S")
run "$S/ghost-docker" --dir "$S" self-update --to "$R1"
expect_status 1
expect_output "runs $R2, which is newer than $R1"
[[ $(fingerprint "$S") == "$before" ]] || fail "a refused downgrade changed files"
ok "and nothing changed"

step "A release whose configuration does not validate is put back before services change"
before=$(fingerprint "$S")
ghost_before=$(ghost_container "$S")
run "$S/ghost-docker" --dir "$S" self-update --to "$R3"
expect_status 1
expect_output 'Compose cannot resolve the project with this release'
expect_output "Restored: the site is back on $R2, with its files as they were\\. Its services were not changed\\."
[[ $(fingerprint "$S") == "$before" ]] || fail "the files were not put back" "$(diff <(printf '%s\n' "$before") <(fingerprint "$S"))"
[[ $(ghost_container "$S") == "$ghost_before" ]] || fail "the Ghost container was replaced"
[[ $(pinned "$S") == "$(image_id "$REGISTRY:$R2")" ]] || fail "the launcher was re-pinned by a failed update"
[[ $(http_status "$port") == 200 ]] || fail "the site does not answer on 127.0.0.1:$port"
ok "the previous files are back, and the same Ghost container still answers"

# --- Clone mode ------------------------------------------------------------------

step "A checkout, installed at one commit"
new_site update-clone
C=$SITE
copy_tree "$C"
git_c() { git -C "$C" -c user.name=e2e -c user.email=e2e@example.com "$@"; }
git_c init --quiet
git_c add --all
git_c commit --quiet --message previous
previous=$(git_c rev-parse HEAD)
run env -u GD_IMAGE "$C/ghost-docker" --dir "$C" install --local --no-prompt
expect_status 0
clone_port=$(setting "$C" GHOST_PORT)
[[ $(http_status "$clone_port") == 200 ]] || fail "the clone does not answer on 127.0.0.1:$clone_port"
ok "at ${previous:0:12}, on 127.0.0.1:$clone_port"

step "Local changes to tracked files are refused"
printf '\n' >>"$C/README.md"
before=$(fingerprint "$C")
run env -u GD_IMAGE "$C/ghost-docker" --dir "$C" self-update
expect_status 1
expect_output 'local changes to tracked files'
[[ $(fingerprint "$C") == "$before" ]] || fail "a refused update changed files"
git_c checkout --quiet README.md
ok "before anything changed"

step "A commit whose Ghost never becomes healthy is put back"
# Ghost's health check fails at once, and gives up after one try.
perl -0pi -e 's/process\.exit\(r\.statusCode < 400 \? 0 : 1\)/process.exit(1)/; s/interval: 30s\n      timeout: 10s\n      start_period: 180s\n      start_interval: 5s\n      retries: 5/interval: 2s\n      timeout: 10s\n      start_period: 0s\n      start_interval: 2s\n      retries: 1/' "$C/compose.yml"
git_c diff --quiet compose.yml && fail "compose.yml was not changed for the broken commit"
git_c commit --quiet --all --message broken
broken=$(git_c rev-parse HEAD)
compose_before=$(git_c show "$previous:compose.yml")
run env -u GD_IMAGE "$C/ghost-docker" --dir "$C" self-update
expect_status 1
expect_output 'did not start and become healthy'
expect_output "Restored: the site is back on commit ${previous:0:12}, with its files as they were, and its services running and healthy\\."
[[ $(git_c rev-parse HEAD) == "$previous" ]] || fail "the checkout is at $(git_c rev-parse HEAD), not $previous"
[[ $(cat "$C/compose.yml") == "$compose_before" ]] || fail "compose.yml is not the previous commit's"
if ! records "$C" commit "$previous" || records "$C" commit "$broken"; then
    fail "the metadata does not record $previous alone" "$(cat "$C/.ghost-docker.json")"
fi
[[ $(http_status "$clone_port") == 200 ]] || fail "the site does not answer on 127.0.0.1:$clone_port"
ok "the checkout is at ${previous:0:12} again, and the site answers"

printf '\nAll checks passed.\n'
