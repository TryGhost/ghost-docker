#!/usr/bin/env bash
# Real updates between releases, against real containers.
#
#   tests/e2e/self-update.sh
#
# Four releases of the manager image are built from this checkout, tagged as
# the launcher names releases but never pushed: the first, a second that
# changes two stack files, a third whose compose.yml does not resolve, and a
# fourth that migrates the database and the content, then never becomes
# healthy. A local site installed from the first is updated to the second
# with one of those files edited, then refused a downgrade, then updated to
# the third and the fourth, each of which fails and is put back.
#
# Through the fourth, a client keeps writing posts: every post Ghost accepts
# is still there once the site is put back. Then the backup that update took
# is restored, with its records, content, configuration and images.
#
# A checkout: a copy of this checkout, as a git repository, is refused
# self-update, which is git's and Compose's there. Its backup records the
# commit checked out when it was taken, and restores only at that commit.
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
R4=v0.0.1-beta.4

# What this host cannot run fails the run, unless GD_E2E_ALLOW_SKIP=1.
# shellcheck source=/dev/null
source "$ROOT/tests/e2e/skip.sh"
require_docker
for tool in jq curl; do
    command -v "$tool" >/dev/null || {
        printf 'self-update.sh needs %s\n' "$tool" >&2
        exit 1
    }
done

OWNER_EMAIL=owner@example.com
OWNER_PASSWORD='Kept-through-an-update-2026!'
SETTING_KEY=updateE2e__marker
SETTING='kept through the update'

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ghost-docker-update-e2e.XXXXXXXX")
WORK=$(CDPATH='' cd -- "$WORK" && pwd -P)
CURRENT=setup
OUT=""
RC=0
SITES=()
WRITER=""

cleanup() {
    local rc=$? site
    set +e
    [[ -z $WRITER ]] || kill "$WRITER" 2>/dev/null
    for site in ${SITES[@]+"${SITES[@]}"}; do
        [[ -f $site/.env ]] && docker compose --project-directory "$site" -f "$site/compose.yml" \
            down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1
    done
    docker run --rm --user 0 --entrypoint rm -v "$WORK:/work" "$REGISTRY:$R1" -rf /work/sites >/dev/null 2>&1
    docker rmi "$REGISTRY:$R1" "$REGISTRY:$R2" "$REGISTRY:$R3" "$REGISTRY:$R4" >/dev/null 2>&1
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
# root_sql SITE SQL -- as MySQL's root, in the site's database container.
root_sql() {
    local database
    database=$(setting "$1" DATABASE_NAME || true)
    compose_in "$1" exec -T -e MYSQL_PWD="$(setting "$1" DATABASE_ROOT_PASSWORD)" db \
        mysql -uroot -N -B "${database:-ghost}" -e "$2"
}
base_of() { printf 'http://localhost:%s' "$(setting "$1" GHOST_PORT)"; }
# api SITE METHOD PATH [curl options] -- the Admin API, signed in.
api() {
    local site=$1 method=$2 path=$3 base
    shift 3
    base=$(base_of "$site")
    curl --disable --silent --noproxy '*' --max-time 30 --cookie "$site.cookies" \
        --header "Origin: $base" --request "$method" "$@" "$base/ghost/api/admin/$path"
}
# sign_in SITE -- with the owner's password; the session goes in SITE.cookies.
sign_in() {
    local base status
    base=$(base_of "$1")
    status=$(curl --disable --silent --noproxy '*' --max-time 30 --output "$1.session" --write-out '%{http_code}' \
        --cookie-jar "$1.cookies" --request POST --header 'Content-Type: application/json' \
        --header "Origin: $base" \
        --data "$(jq -cn --arg u "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" '{username: $u, password: $p}')" \
        "$base/ghost/api/admin/session/")
    [[ $status == 201 ]] || fail "signing in at $base answered $status" "$(cat "$1.session")"
}
# post_titles SITE -- every post's title, one per line, sorted.
post_titles() {
    api "$1" GET 'posts/?limit=all&fields=title' |
        jq -r '.posts[].title' | sort
}
# write_posts SITE FILE -- a client posting until killed: each title Ghost
# accepted (201) is appended to FILE.
write_posts() {
    local site=$1 accepted=$2 n=0 title status
    while :; do
        n=$((n + 1))
        title="written during the update $n"
        status=$(api "$site" POST posts/ --output /dev/null --write-out '%{http_code}' --max-time 5 \
            --header 'Content-Type: application/json' \
            --data "$(jq -cn --arg t "$title" '{posts: [{title: $t}]}')" 2>/dev/null || true)
        [[ $status != 201 ]] || printf '%s\n' "$title" >>"$accepted"
        sleep 0.5
    done
}
http_status() {
    curl --silent --noproxy '*' --max-time 20 --output /dev/null --write-out '%{http_code}' \
        "http://127.0.0.1:$1/ghost/api/admin/site/" || true
}
# Every file under a directory with its checksum, to compare before and after:
# not the data, nor the backups each update takes.
fingerprint() {
    (cd "$1" && find . -type f -not -path './data/*' -not -path './backups/*' -not -path './.git/*' -print0 | sort -z |
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

step "Build four releases of the manager image"
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
copy_tree "$WORK/r4"
cp "$WORK/r2/caddy/snippets/Logging" "$WORK/r4/caddy/snippets/Logging"
cp "$WORK/r2/compose.ipv6.yml" "$WORK/r4/compose.ipv6.yml"
# Ghost's health check fails at once, and gives up after one try.
perl -0pi -e 's/process\.exit\(r\.statusCode < 400 \? 0 : 1\)/process.exit(1)/; s/interval: 30s\n      timeout: 10s\n      start_period: 180s\n      start_interval: 5s\n      retries: 5/interval: 2s\n      timeout: 10s\n      start_period: 0s\n      start_interval: 2s\n      retries: 1/' "$WORK/r4/compose.yml"
# Before Ghost starts, a one-shot job migrates the database and the content,
# as a release's own migrations would.
db_image=$(sed -n '/^  db:$/,/^    image:/s/^    image: //p' "$ROOT/compose.yml")
[[ -n $db_image ]] || fail "compose.yml names no db image"
cat >"$WORK/r4-migrate.yml" <<EOF
  e2e-migrate:
    image: $db_image
    restart: "no"
    profiles: [local, production]
    labels:
      <<: *site-labels
      org.ghost.docker.role: e2e-migrate
      org.ghost.docker.lifecycle: one-shot
    environment:
      MYSQL_PWD: \${DATABASE_ROOT_PASSWORD:?DATABASE_ROOT_PASSWORD is required}
    volumes:
      - \${UPLOAD_LOCATION:-./data/ghost}:/content
    entrypoint: [sh, -c]
    command:
      - >-
        mysql -h db -uroot \${DATABASE_NAME:-ghost}
        -e "UPDATE posts SET title = 'migrated by $R4'; CREATE TABLE e2e_migrated_by_r4 (id int)" &&
        printf 'migrated by $R4' >/content/images/migrated-by-r4.txt
    depends_on:
      db:
        condition: service_healthy
    networks:
      - ghost_network

EOF
MIGRATE=$WORK/r4-migrate.yml perl -0pi -e '
    s/(    depends_on:\n      db:\n        condition: service_healthy\n)/$1      e2e-migrate:\n        condition: service_completed_successfully\n/;
    open my $f, "<", $ENV{MIGRATE} or die; my $job = do { local $/; <$f> };
    s/(\n  db:\n)/\n$job  db:\n/;
' "$WORK/r4/compose.yml"
grep -q '^  e2e-migrate:$' "$WORK/r4/compose.yml" || fail "the migration job was not added for $R4"
cmp -s "$ROOT/compose.yml" "$WORK/r4/compose.yml" && fail "compose.yml was not changed for $R4"
build_release "$R4" "$WORK/r4"
ok "$R1, $R2 (two stack files changed), $R3 (compose.yml does not resolve), $R4 (migrates, then Ghost never healthy)"

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
expect_output "Restored: the site is back on $R2, with its files as they were\\. Its services were not changed; ghost, stopped for the update, is running again\\."
[[ $(fingerprint "$S") == "$before" ]] || fail "the files were not put back" "$(diff <(printf '%s\n' "$before") <(fingerprint "$S"))"
[[ $(ghost_container "$S") == "$ghost_before" ]] || fail "the Ghost container was replaced"
[[ $(pinned "$S") == "$(image_id "$REGISTRY:$R2")" ]] || fail "the launcher was re-pinned by a failed update"
[[ $(http_status "$port") == 200 ]] || fail "the site does not answer on 127.0.0.1:$port"
ok "the previous files are back, and the same Ghost container still answers"

step "Give the site an owner, a post, an image and a setting"
BASE=$(base_of "$S")
body=$(curl --disable --silent --noproxy '*' --max-time 60 --request POST \
    --header 'Content-Type: application/json' --header "Origin: $BASE" \
    --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" \
        '{setup: [{name: "Update Tester", email: $e, password: $p, blogTitle: "Update e2e"}]}')" \
    "$BASE/ghost/api/admin/authentication/setup/")
jq -e '.users[0].id' <<<"$body" >/dev/null 2>&1 || fail "setting up the owner failed" "$body"
run "$S/ghost-docker" --dir "$S" config set ghost.env "$SETTING_KEY" "$SETTING"
expect_status 0
# Signing in from a new session would otherwise ask for a code by email.
run "$S/ghost-docker" --dir "$S" config set ghost.env security__staffDeviceVerification false
expect_status 0
compose_in "$S" up --detach --wait ghost >/dev/null 2>&1 || fail "Ghost did not start again"
sign_in "$S"
body=$(api "$S" POST posts/ --header 'Content-Type: application/json' \
    --data '{"posts": [{"title": "Kept through the update", "status": "published"}]}')
jq -e '.posts[0].id' <<<"$body" >/dev/null 2>&1 || fail "creating a post failed" "$body"
# shellcheck disable=SC2016 # expanded by the container's shell
compose_in "$S" exec -T --user ghost ghost sh -c \
    'mkdir -p "$GHOST_CONTENT/images/2026/10" && printf "kept image" >"$GHOST_CONTENT/images/2026/10/marker.png"' ||
    fail "writing the image failed"
seeded=$(post_titles "$S")
grep -qx 'Kept through the update' <<<"$seeded" || fail "the post does not read back" "$seeded"
ok "an owner, $(wc -l <<<"$seeded" | tr -d ' ') posts, images/2026/10/marker.png and $SETTING_KEY"

step "A release that migrates, then never becomes healthy, is stopped for the operator, who restores the backup"
before=$(fingerprint "$S")
backups_before=$(find "$S/backups" -mindepth 1 -maxdepth 1 -type d -not -name '.*' | sort)
accepted=$WORK/accepted
: >"$accepted"
write_posts "$S" "$accepted" &
WRITER=$!
run "$S/ghost-docker" --dir "$S" self-update --to "$R4"
kill "$WRITER" 2>/dev/null
wait "$WRITER" 2>/dev/null || true
WRITER=""
expect_status 1
expect_output 'images +pulled, while the site kept running'
expect_output 'did not start and become healthy'
expect_output 'The site needs you\.'
expect_output 'Ghost may have accepted writes, since the backup'
expect_output "The files are $R2's again\\."
expect_output 'restore --yes backups/'
[[ $(pinned "$S") == "$(image_id "$REGISTRY:$R2")" ]] || fail "the launcher was re-pinned by a failed update"
records "$S" version "$R2" || fail "the metadata does not record $R2" "$(cat "$S/.ghost-docker.json")"
[[ -z $(compose_in "$S" ps -q ghost) ]] || fail "the release's Ghost is still running"
[[ -e $S/.ghost-docker-update/files/.env && ! -e $S/.ghost-docker.lock ]] || fail "the update did not keep its snapshot, or left its lock"
# Nothing was loaded over the data: what the release migrated, and every
# post it accepted, is still there for the operator to keep or discard.
compose_in "$S" up --detach --wait db >/dev/null 2>&1 || fail "the database did not start for a look"
[[ -n $(root_sql "$S" "SHOW TABLES LIKE 'e2e_migrated_by_r4'") ]] || fail "the release's migration was undone without the operator"
left=$(root_sql "$S" "SELECT title FROM posts")
ok "$R2's files and launcher again, the services stopped, and the data as the release left it"

# The operator's choice: the backup the update named, discarding what the release did.
backup=$(sed -n 's/^ *\.\/ghost-docker restore --yes \(backups\/[^ ]*\)$/\1/p' <<<"$OUT" | head -1)
[[ -n $backup ]] || fail "the update did not name the backup to restore" "$OUT"
run "$S/ghost-docker" --dir "$S" restore --yes "$backup"
expect_status 0
rm -rf "$S/.ghost-docker-update"
[[ $(fingerprint "$S") == "$before" ]] || fail "the files are not as before the update" "$(diff <(printf '%s\n' "$before") <(fingerprint "$S"))"
[[ $(http_status "$port") == 200 ]] || fail "the site does not answer on 127.0.0.1:$port"
ok "restored from $backup, and the site answers"

sign_in "$S"
titles=$(post_titles "$S")
grep -q 'migrated by' <<<"$titles" && fail "the migration's change to the posts was kept" "$titles"
[[ -z $(root_sql "$S" "SHOW TABLES LIKE 'e2e_migrated_by_r4'") ]] || fail "the migration's table was kept"
[[ ! -e $S/data/ghost/images/migrated-by-r4.txt ]] || fail "the migration's content was kept"
[[ $(curl --disable --silent --noproxy '*' --max-time 30 "$BASE/content/images/2026/10/marker.png") == 'kept image' ]] ||
    fail "the image is not served as it was"
ok "the migration's records, table and content are gone; the image is served"

# Each post Ghost accepted is in the backup the operator restored, or, accepted
# by the release after it started, was in the data the update left for them.
missing=$(comm -23 <(sort -u "$accepted") <(printf '%s\n%s\n' "$titles" "$left" | sort -u))
[[ -z $missing ]] || fail "posts Ghost accepted during the update were lost before the operator chose" "$missing"
grep -qx 'Kept through the update' <<<"$titles" || fail "the seeded post was lost" "$titles"
ok "each of the $(wc -l <"$accepted" | tr -d ' ') posts Ghost accepted during the update was kept until the operator chose"

step "The backup that update took restores the site, its records, configuration and images"
backup=$(comm -13 <(printf '%s\n' "$backups_before") \
    <(find "$S/backups" -mindepth 1 -maxdepth 1 -type d -not -name '.*' | sort) | tail -1)
[[ -n $backup ]] || fail "the update left no backup"
# Changed after the backup, for the restore to put back.
run "$S/ghost-docker" --dir "$S" config set ghost.env "$SETTING_KEY" 'changed after the backup'
expect_status 0
api "$S" POST posts/ --header 'Content-Type: application/json' \
    --data '{"posts": [{"title": "Written after the backup"}]}' >/dev/null
run "$S/ghost-docker" --dir "$S" restore --yes "$backup"
expect_status 0
[[ $(setting "$S" GHOST_IMAGE_REF) == "$ghost_pin" ]] || fail "the Ghost pin is not $ghost_pin"
running=$(docker inspect -f '{{.Config.Image}}' "$(ghost_container "$S")")
[[ $running == "$ghost_pin" ]] || fail "Ghost runs $running, not $ghost_pin"
[[ $(pinned "$S") == "$(image_id "$REGISTRY:$R2")" ]] || fail "the launcher is not pinned to $R2"
records "$S" version "$R2" || fail "the metadata does not record $R2" "$(cat "$S/.ghost-docker.json")"
[[ $("$S/ghost-docker" --dir "$S" config get ghost.env "$SETTING_KEY" 2>/dev/null) == "$SETTING" ]] ||
    fail "ghost.env does not hold $SETTING_KEY as backed up"
[[ $(compose_in "$S" exec -T ghost printenv "$SETTING_KEY") == "$SETTING" ]] ||
    fail "Ghost does not run with $SETTING_KEY as backed up"
sign_in "$S"
restored=$(post_titles "$S")
grep -qx 'Kept through the update' <<<"$restored" || fail "the seeded post was not restored" "$restored"
grep -q 'Written after the backup' <<<"$restored" && fail "a post written after the backup is there" "$restored"
grep -q 'migrated by' <<<"$restored" && fail "the migration's change is there" "$restored"
[[ $(curl --disable --silent --noproxy '*' --max-time 30 "$BASE/content/images/2026/10/marker.png") == 'kept image' ]] ||
    fail "the image is not served as backed up"
[[ $(http_status "$port") == 200 ]] || fail "the site does not answer on 127.0.0.1:$port"
ok "Ghost $ghost_pin, the launcher on $R2, $SETTING_KEY and the posts and image as backed up"

# --- A checkout ------------------------------------------------------------------

step "A checkout is refused self-update"
new_site update-clone
C=$SITE
copy_tree "$C"
# With none of this machine's git configuration: a person's commit signing
# would otherwise fail the fixture's commits.
git_c() {
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
        git -C "$C" -c user.name=e2e -c user.email=e2e@example.com "$@"
}
git_c init --quiet
git_c add --all
git_c commit --quiet --message installed
installed=$(git_c rev-parse HEAD)
run env -u GD_IMAGE "$C/ghost-docker" --dir "$C" install --local --no-prompt
expect_status 0
clone_port=$(setting "$C" GHOST_PORT)
grep -q '"commit"' "$C/.ghost-docker.json" && fail "the metadata records a commit" "$(cat "$C/.ghost-docker.json")"
before=$(fingerprint "$C")
run env -u GD_IMAGE "$C/ghost-docker" --dir "$C" self-update
expect_status 1
expect_output 'self-update updates only a site installed'
expect_output 'docker compose up -d --wait'
[[ $(fingerprint "$C") == "$before" ]] || fail "a refused update changed files"
[[ $(git_c rev-parse HEAD) == "$installed" ]] || fail "a refused update moved the checkout"
ok "with the git and Compose steps, before anything changed"

step "A checkout's backup records the commit it was taken at"
printf '\n' >>"$C/README.md"
git_c commit --quiet --all --message later
later=$(git_c rev-parse HEAD)
run env -u GD_IMAGE "$C/ghost-docker" --dir "$C" backup
expect_status 0
backup=$(find "$C/backups" -mindepth 1 -maxdepth 1 -type d -not -name '.*' | sort | tail -1)
grep -q "\"commit\": \"$later\"" "$backup/manifest.json" || fail "the manifest does not record $later" "$(cat "$backup/manifest.json")"
ok "at ${later:0:12}, not the ${installed:0:12} it was installed at"

step "A compose.yml whose MySQL bump is not applied is refused a backup"
sed -i.bak 's/image: mysql:8\.0\.[0-9]*@sha256:[0-9a-f]*/image: mysql:8.0.43/' "$C/compose.yml"
rm -f "$C/compose.yml.bak"
grep -q 'image: mysql:8.0.43$' "$C/compose.yml" || fail "compose.yml's MySQL was not changed"
before=$(find "$C/backups" -mindepth 1 -maxdepth 1 | sort)
run env -u GD_IMAGE "$C/ghost-docker" --dir "$C" backup
expect_status 1
expect_output 'the site runs other images than its configuration names'
expect_output 'db runs mysql:8\.0\.[0-9]+@sha256:[0-9a-f]+, and the configuration names mysql:8\.0\.43'
[[ $(find "$C/backups" -mindepth 1 -maxdepth 1 | sort) == "$before" ]] || fail "a refused backup left something in backups/"
git_c checkout --quiet compose.yml
ok "before anything was captured, naming what runs and what is configured"

step "It restores over its site only at that commit"
git_c checkout --quiet --detach "$installed"
run env -u GD_IMAGE "$C/ghost-docker" --dir "$C" restore --yes "$backup"
expect_status 1
expect_output "Check that commit out first: git checkout $later"
git_c checkout --quiet --detach "$later"
run env -u GD_IMAGE "$C/ghost-docker" --dir "$C" restore --yes "$backup"
expect_status 0
[[ $(http_status "$clone_port") == 200 ]] || fail "the restored site does not answer on 127.0.0.1:$clone_port"
ok "refused at ${installed:0:12}, restored at ${later:0:12}"

passed 'All checks passed.'
