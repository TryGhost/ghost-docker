#!/usr/bin/env bash
# Install a Ghost site into this checkout. One checkout is one site.
#
#   install.sh [--local | --domain example.com [--admin-domain admin.example.com]]
#              [--dir PATH] [--port 2368] [--version 6.3.1]
#              [--channel stable|beta] [--ref vX.Y.Z]
#              [--with analytics,activitypub]
#              [--no-prompt] [--no-start]
#
#   --local            Ghost and MySQL, published on 127.0.0.1:PORT.
#   --domain DOMAIN    Production: Ghost, MySQL and Caddy with HTTPS.
#   --admin-domain D   Serve Ghost Admin on a separate domain.
#   --dir PATH         The site directory. Must be this checkout; use
#                      bootstrap.sh to install into a new one.
#   --port PORT        The loopback port Ghost is published on. A free one is
#                      chosen when this is omitted; a busy one is an error.
#   --version VERSION  Ghost version or image tag. Resolved to an exact pin.
#   --channel CHANNEL  Release channel to record: stable (default) or beta.
#   --ref REF          The stack release this checkout is at.
#   --with LIST        Optional per-site services: analytics, activitypub.
#   --no-prompt        Never ask. Every required input must then be supplied.
#   --no-start         Configure the site but start no application services.
#
# Installation never stops or reconfigures anything already running on this
# host. A port that is in use is reported as an error, with what holds it.
set -euo pipefail

# Everything written here may hold a credential until it is explicitly made
# public.
umask 077

# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "$0")/scripts/lib/common.sh"

readonly EXIT_USAGE=2
readonly EXIT_UNIMPLEMENTED=3

mode=""
domain=""
admin_domain=""
dir=""
port=""
ghost_version=""
channel=""
ref=""
with=""
no_start=0

die() {
    printf 'error: %s\n' "$1" >&2
    exit "${2:-1}"
}

# Flags that belong to steps which have not landed. They fail with what they
# will be rather than as an unknown option, so that a script written against
# the documented interface gets a useful answer.
unimplemented() {
    printf 'error: %s is not implemented yet (%s).\n' "$1" "$2" >&2
    exit "$EXIT_UNIMPLEMENTED"
}

while (($#)); do
    case $1 in
        --local)
            mode=local
            ;;
        --domain)
            [[ ${2:-} ]] || die "--domain needs a value" "$EXIT_USAGE"
            mode=production
            domain=$2
            shift
            ;;
        --domain=*) mode=production domain=${1#*=} ;;
        --admin-domain)
            [[ ${2:-} ]] || die "--admin-domain needs a value" "$EXIT_USAGE"
            admin_domain=$2
            shift
            ;;
        --admin-domain=*) admin_domain=${1#*=} ;;
        --dir)
            [[ ${2:-} ]] || die "--dir needs a value" "$EXIT_USAGE"
            dir=$2
            shift
            ;;
        --dir=*) dir=${1#*=} ;;
        --port)
            [[ ${2:-} ]] || die "--port needs a value" "$EXIT_USAGE"
            port=$2
            shift
            ;;
        --port=*) port=${1#*=} ;;
        --version)
            [[ ${2:-} ]] || die "--version needs a value" "$EXIT_USAGE"
            ghost_version=$2
            shift
            ;;
        --version=*) ghost_version=${1#*=} ;;
        --channel)
            [[ ${2:-} ]] || die "--channel needs a value" "$EXIT_USAGE"
            channel=$2
            shift
            ;;
        --channel=*) channel=${1#*=} ;;
        --ref)
            [[ ${2:-} ]] || die "--ref needs a value" "$EXIT_USAGE"
            ref=$2
            shift
            ;;
        --ref=*) ref=${1#*=} ;;
        --with)
            [[ ${2:-} ]] || die "--with needs a value" "$EXIT_USAGE"
            with=$2
            shift
            ;;
        --with=*) with=${1#*=} ;;
        --no-prompt) GD_NO_PROMPT=1 ;;
        --no-start) no_start=1 ;;
        --import | --import=*)
            unimplemented "--import" "bundle import lands in S5; scripts/migrate.sh is the supported migration path today"
            ;;
        --image-registry | --image-registry=* | --ghost-channel | --ghost-channel=* | --without | --without=*)
            unimplemented "${1%%=*}" "service image registries, the Ghost nightly channel and Redis land in S14-S16"
            ;;
        -h | --help | help)
            usage
            exit 0
            ;;
        *)
            printf 'error: unknown option: %s\n' "$1" >&2
            usage >&2
            exit "$EXIT_USAGE"
            ;;
    esac
    shift
done

# --- The site directory ----------------------------------------------------
#
# Installation logic is owned by the checkout it runs from, so the site is
# installed here. Selecting a release and putting it somewhere else is
# bootstrap.sh's job, and it re-executes this script from the new checkout.

abspath() { (CDPATH='' cd -- "$1" >/dev/null 2>&1 && pwd -P); }

checkout=$(abspath "$GD_ROOT_DIR") || die "cannot resolve this checkout's path"
if [[ -n $dir ]]; then
    resolved=$(abspath "$dir" 2>/dev/null || printf '%s' "$dir")
    if [[ $resolved != "$checkout" ]]; then
        die "--dir is $resolved but this installer belongs to $checkout.
  One checkout is one site. To install into another directory, use bootstrap.sh,
  which selects a release, clones it there, and runs its installer." "$EXIT_USAGE"
    fi
fi
dir=$checkout

# --- Refuse to install over an existing site -------------------------------

for existing in "$GD_ENV_FILE_NAME" "$GD_META_FILE_NAME"; do
    [[ -e $dir/$existing ]] || continue
    die "$dir/$existing already exists, so this checkout already holds a site.
  Move it aside, or install into a new directory with bootstrap.sh. Nothing has
  been changed."
done

# --- Mode ------------------------------------------------------------------

if [[ -z $mode ]]; then
    if answer=$(install_ask "Install a [local] development site or a [production] site on a domain?" local); then
        case $answer in
            local | l | 1) mode=local ;;
            production | prod | p | 2) mode=production ;;
            *) die "unrecognised answer: $answer" "$EXIT_USAGE" ;;
        esac
    else
        die "choose a site mode with --local or --domain example.com" "$EXIT_USAGE"
    fi
fi

if [[ $mode == production && -z $domain ]]; then
    domain=$(install_require "" "Public domain for this site (example.com)" "--domain") ||
        exit "$EXIT_USAGE"
fi

if [[ $mode == local && -n $admin_domain ]]; then
    die "--admin-domain applies to production sites only" "$EXIT_USAGE"
fi

case $domain in
    '' | *[!a-zA-Z0-9.-]*)
        [[ $mode == local ]] || die "--domain must be a hostname, not a URL: got '$domain'" "$EXIT_USAGE"
        ;;
esac

# --- Optional per-site services --------------------------------------------

profiles=$mode
IFS=, read -ra selected <<<"$with"
for choice in ${selected[@]+"${selected[@]}"}; do
    choice=${choice#"${choice%%[![:space:]]*}"}
    choice=${choice%"${choice##*[![:space:]]}"}
    [[ -n $choice ]] || continue
    case $choice in
        analytics | activitypub) profiles="$profiles,$choice" ;;
        supervisor)
            unimplemented "--with supervisor" "the upgrade supervisor lands in S8; the profile is reserved and defines no service yet"
            ;;
        local | production) die "--with selects optional services; the site mode comes from --local or --domain" "$EXIT_USAGE" ;;
        *) die "unknown optional service: $choice (analytics, activitypub)" "$EXIT_USAGE" ;;
    esac
done
case ",$profiles," in *,analytics,*) want_analytics=1 ;; *) want_analytics=0 ;; esac
case ",$profiles," in *,activitypub,*) want_activitypub=1 ;; *) want_activitypub=0 ;; esac

# --- Release identity ------------------------------------------------------

case ${channel:=stable} in
    stable | beta) ;;
    *) die "--channel must be stable or beta" "$EXIT_USAGE" ;;
esac

stack_ref=""
stack_commit=""
tags_here=""
if command -v git >/dev/null 2>&1 && git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
    stack_commit=$(git -C "$dir" rev-parse HEAD 2>/dev/null || printf '')
    tags_here=$(git -C "$dir" tag --points-at HEAD 2>/dev/null || printf '')
    stack_ref=$(git -C "$dir" describe --tags --exact-match HEAD 2>/dev/null ||
        git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || printf '')
fi
# When --ref names a tag that points at this commit, it is authoritative even
# if `git describe` reported a different tag on the same commit — a release and
# its prerelease can share a commit. Only a --ref that is nowhere near this
# checkout is a real disagreement.
if [[ -n $ref ]]; then
    if [[ -n $tags_here ]] && printf '%s\n' "$tags_here" | grep -qxF "$ref"; then
        stack_ref=$ref
    elif [[ -n $stack_ref && $ref != "$stack_ref" ]]; then
        die "--ref is $ref but this checkout is at $stack_ref.
  install.sh installs the release it belongs to. Use bootstrap.sh --ref $ref to
  select a different one." "$EXIT_USAGE"
    fi
fi
[[ -n $ref ]] || ref=$stack_ref

# --- Ports -----------------------------------------------------------------

http_port=80
https_port=443

if [[ -n $port ]]; then
    if [[ ! $port =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
        die "--port must be a port number: got '$port'" "$EXIT_USAGE"
    fi
else
    port=$(free_port 2368) || die "no free port was found at or above 2368"
fi

# --- Preflight -------------------------------------------------------------

printf 'Checking this host\n'
records=$(preflight_site "$dir" "$mode" "$port" "$http_port" "$https_port")
preflight_render "$records"
if preflight_failed "$records"; then
    printf '\nerror: preflight failed. Nothing has been changed on this host.\n' >&2
    exit 1
fi

# --- Identity and secrets --------------------------------------------------

project=$(install_project_name "$mode" "$domain" "$dir") ||
    die "could not derive a project name from '$domain'"

if [[ $mode == production ]]; then
    url="https://$domain"
    node_env=production
    restart_policy=unless-stopped
else
    url="http://localhost:$port"
    node_env=development
    restart_policy=no
fi
admin_url=""
[[ -n $admin_domain ]] && admin_url="https://$admin_domain"

db_password=$(install_secret 24) || die "could not generate a database password"
db_root_password=$(install_secret 24) || die "could not generate a database root password"

# --- Tinybird credentials for the analytics profile ------------------------
#
# Read from the environment first so an unattended install can supply them
# without putting a token in a command line, where it would reach the process
# table and the shell history.

tinybird_tracker_token=${TINYBIRD_TRACKER_TOKEN:-}
tinybird_admin_token=${TINYBIRD_ADMIN_TOKEN:-}
tinybird_workspace_id=${TINYBIRD_WORKSPACE_ID:-}
tinybird_api_url=${TINYBIRD_API_URL:-https://api.tinybird.co}

if ((want_analytics)); then
    if [[ -z $tinybird_tracker_token ]]; then
        tinybird_tracker_token=$(install_ask_secret "Tinybird tracker token" || printf '')
    fi
    if [[ -z $tinybird_admin_token ]]; then
        tinybird_admin_token=$(install_ask_secret "Tinybird admin token" || printf '')
    fi
    if [[ -z $tinybird_workspace_id ]]; then
        tinybird_workspace_id=$(install_ask "Tinybird workspace id" || printf '')
    fi
    if [[ -z $tinybird_tracker_token || -z $tinybird_admin_token || -z $tinybird_workspace_id ]]; then
        die "the analytics profile needs TINYBIRD_TRACKER_TOKEN, TINYBIRD_ADMIN_TOKEN and
  TINYBIRD_WORKSPACE_ID. Export them, or drop analytics from --with. See TINYBIRD.md." "$EXIT_USAGE"
    fi
fi

# --- Resolve the exact Ghost image -----------------------------------------

printf '\nResolving the Ghost image\n'
resolved_ghost=$(install_resolve_ghost "$GD_DEFAULT_GHOST_IMAGE" "$ghost_version") || exit 1
IFS=$'\t' read -r ghost_tag ghost_exact_version ghost_digest ghost_content_path ghost_tinybird_path \
    <<<"$resolved_ghost"
printf '  ok       ghost                  %s (%s) %s\n' \
    "$GD_DEFAULT_GHOST_IMAGE:$ghost_tag" "$ghost_exact_version" "${ghost_digest:-no digest recorded}"

# --- Write the configuration -----------------------------------------------

printf '\nWriting configuration\n'

env_file="$dir/$GD_ENV_FILE_NAME"
ghost_env_file="$dir/$GD_GHOST_ENV_FILE_NAME"

# Start from the tracked example so its comments — the ones that explain value
# encoding and the optional settings — survive into the installed file.
cp "$dir/$GD_ENV_FILE_NAME.example" "$env_file"
chmod 0600 "$env_file"

set_env() { env_set "$env_file" "$1" "$2" 0600; }

set_env COMPOSE_PROFILES "$profiles"
set_env SITE_MODE "$mode"
set_env COMPOSE_PROJECT_NAME "$project"
set_env PROJECT_DIR "$dir"
set_env NODE_ENV "$node_env"
set_env URL "$url"
set_env GHOST_IMAGE "$GD_DEFAULT_GHOST_IMAGE"
set_env GHOST_VERSION "$ghost_tag"
set_env GHOST_CONTENT_PATH "$ghost_content_path"
set_env GHOST_TINYBIRD_PATH "$ghost_tinybird_path"
set_env GHOST_PORT "$port"
set_env RESTART_POLICY "$restart_policy"
set_env DATABASE_HOST db
set_env DATABASE_PORT 3306
set_env DATABASE_NAME ghost
set_env DATABASE_USER ghost
set_env DATABASE_PASSWORD "$db_password"
set_env DATABASE_ROOT_PASSWORD "$db_root_password"

if [[ $mode == production ]]; then
    set_env DOMAIN "$domain"
    set_env HTTP_PORT "$http_port"
    set_env HTTPS_PORT "$https_port"
    if [[ -n $admin_domain ]]; then
        set_env ADMIN_DOMAIN "$admin_domain"
        set_env ADMIN_URL "$admin_url"
    fi
else
    # A local site has no Caddy ingress, so leaving the example's DOMAIN in
    # place would describe a domain nothing serves.
    env_unset "$env_file" DOMAIN
fi

if ((want_analytics)); then
    set_env TINYBIRD_API_URL "$tinybird_api_url"
    set_env TINYBIRD_TRACKER_TOKEN "$tinybird_tracker_token"
    set_env TINYBIRD_ADMIN_TOKEN "$tinybird_admin_token"
    set_env TINYBIRD_WORKSPACE_ID "$tinybird_workspace_id"
fi

printf '  ok       %s\n' "$GD_ENV_FILE_NAME"

# ghost.env is written fresh rather than copied from the example, whose SMTP
# block is a placeholder: a site that ships with smtp.example.com configured
# fails to send mail in a way that looks like a Ghost bug.
{
    printf '# Ghost application settings for %s.\n' "$project"
    printf '#\n'
    printf '# This is the only env_file of the ghost service. See ghost.env.example\n'
    printf '# and docs/configuration.md. Write values with:\n'
    printf '#\n'
    printf '#   scripts/config.sh set ghost.env KEY VALUE\n'
    printf '#\n'
    # shellcheck disable=SC2016  # the backticked `$` is literal prose, not an expansion
    printf '# which encodes them for Compose. Do not hand-edit a value containing `$`.\n'
    printf '\n'
    printf '# Transactional email is required for staff logins, invites and password\n'
    printf '# resets, separately from newsletters. Configure it before inviting anyone:\n'
    printf '#\n'
    printf '#   scripts/config.sh set ghost.env mail__transport SMTP\n'
    printf '#   scripts/config.sh set ghost.env mail__options__host smtp.example.com\n'
    printf '#   scripts/config.sh set ghost.env mail__options__port 465\n'
    printf '#   scripts/config.sh set ghost.env mail__options__secure true\n'
    printf '#   scripts/config.sh set ghost.env mail__options__auth__user USER\n'
    printf '#   scripts/config.sh set ghost.env mail__options__auth__pass PASSWORD\n'
    printf "#   scripts/config.sh set ghost.env mail__from \"'Site' <noreply@example.com>\"\n"
    printf '\n'
} >"$ghost_env_file"
chmod 0600 "$ghost_env_file"

if ((want_analytics || want_activitypub)); then
    env_set "$ghost_env_file" labs__publicAPI true 0600
fi
printf '  ok       %s\n' "$GD_GHOST_ENV_FILE_NAME"

# Bind mount sources must exist before the daemon resolves them. Ownership
# inside the containers is the images' own business: Ghost's entrypoint takes
# its content directory, and assuming a host uid here would be wrong under
# rootless Docker and userns remapping.
mkdir -p "$dir/data/ghost" "$dir/data/mysql"
chmod 0755 "$dir/data" "$dir/data/ghost" "$dir/data/mysql"
printf '  ok       data directories\n'

if ! config_validate "$dir"; then
    die "the generated configuration did not validate. Please report this."
fi
printf '  ok       configuration validates\n'

# --- Routing ---------------------------------------------------------------

if [[ $mode == production ]]; then
    printf '\nRendering routes\n'
    if ! caddy_apply "$dir"; then
        die "the generated Caddy configuration could not be applied"
    fi
    printf '  ok       caddy/sites/site.caddy\n'
fi

# --- Metadata --------------------------------------------------------------

meta_init "$dir" \
    "mode=$mode" \
    "channel=$channel" \
    "stack.version=${ref:-unknown}" \
    "stack.commit=${stack_commit:-unknown}" \
    "stack.ref=${ref:-unknown}" \
    "site.project=$project" \
    "site.dir=$dir" \
    "site.url=$url" \
    "site.domain=$domain" \
    "site.adminDomain=$admin_domain" \
    "ghost.image=$GD_DEFAULT_GHOST_IMAGE" \
    "ghost.tag=$ghost_tag" \
    "ghost.version=$ghost_exact_version" \
    "ghost.digest=$ghost_digest" \
    "profiles=$profiles"
printf '  ok       %s\n' "$GD_META_FILE_NAME"

# --- Start and verify ------------------------------------------------------

started=0
if ((no_start)); then
    printf '\nNot starting: --no-start was given.\n'
else
    printf '\nStarting services\n'
    compose_run "$dir" up -d
    started=1

    install_wait_healthy "$dir" db "$GD_READY_TIMEOUT_DB" ||
        die "the database did not become ready. See: docker compose logs db"
    printf '  ok       database is ready\n'

    install_wait_healthy "$dir" ghost "$GD_READY_TIMEOUT_GHOST" ||
        die "Ghost did not become ready. See: docker compose logs ghost"
    printf '  ok       Ghost is ready\n'

    printf '\nVerifying ingress\n'
    if ! install_verify_ingress "$dir" "$mode" "$port" "$http_port" "$domain" "$admin_domain"; then
        die "the site started but is not reachable through its own ingress"
    fi
fi

# --- Summary ---------------------------------------------------------------

admin_link=${admin_url:-$url}
cat <<SUMMARY

Ghost is installed.

  Site           $url
  Ghost Admin    $admin_link/ghost/
  Mode           $mode
  Project        $project
  Directory      $dir
  Ghost          $GD_DEFAULT_GHOST_IMAGE:$ghost_tag ($ghost_exact_version)
  Loopback       127.0.0.1:$port
  Profiles       $profiles
  Content        $dir/data/ghost
  Database       $dir/data/mysql

Configuration
  .env           Compose and operator settings, including the MySQL passwords.
  ghost.env      Ghost application settings.
  Both are mode 0600 and are not tracked by Git. Back them up.
SUMMARY

if ((started)); then
    if [[ $mode == production ]]; then
        cat <<'SUMMARY'

Next
  1. Point this domain's A/AAAA records at this host, if you have not already.
     Caddy requests a certificate on the first request for the name.
  2. Configure transactional email, or staff invites and password resets will
     not arrive:
       scripts/config.sh set ghost.env mail__transport SMTP
       ... see ghost.env for the full list, then: docker compose up -d
  3. Open Ghost Admin and create the owner account.
SUMMARY
    else
        cat <<'SUMMARY'

Next
  1. Open Ghost Admin and create the owner account.
  2. Configure transactional email when you need staff invites or password
     resets: see ghost.env.
SUMMARY
    fi
else
    cat <<'SUMMARY'

Next
  Nothing is running. Start the site with:
    docker compose up -d
SUMMARY
fi

if ((want_analytics)); then
    cat <<'SUMMARY'

Analytics
  Finish the Tinybird setup, which needs an interactive login:
    docker compose run --rm tinybird-login
    docker compose --profile=analytics up tinybird-sync tinybird-deploy
  See TINYBIRD.md.
SUMMARY
fi

cat <<'SUMMARY'

Day to day
  docker compose ps
  docker compose logs -f ghost
  scripts/site.sh check
  ./help
SUMMARY
