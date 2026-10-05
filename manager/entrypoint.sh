#!/bin/sh
# Entrypoint of the manager image: become the caller, then run the CLI.
#
# The launcher starts this container as root and says who ran it (GD_UID,
# GD_GID). Everything the CLI writes into the site directory has to belong to
# that user, and the CLI also has to reach the Docker socket, which belongs to
# root or to a docker group. So: read the socket's group, then drop to the
# caller's uid and gid with that group added. Nothing is chowned afterwards.
#
# The cases in which there is nothing to drop (plan §2.10):
#   - the container was started with --user: it is already someone else
#   - rootless Docker: root in here already is the caller on the host
#   - no identity was given: the host has no uid to match (Windows)
#   - the caller is root
set -eu

manager() {
    exec node /opt/ghost-docker/manager/src/main.ts "$@"
}

[ "$(id -u)" = 0 ] || manager "$@"
[ "${GD_ROOTLESS:-0}" != 1 ] || manager "$@"

uid=${GD_UID:-}
gid=${GD_GID:-}
case $uid in '' | *[!0-9]*) manager "$@" ;; esac
case $gid in '' | *[!0-9]*) manager "$@" ;; esac
[ "$uid" != 0 ] || manager "$@"

groups=$gid
socket=${GD_DOCKER_SOCKET:-/var/run/docker.sock}
if [ -S "$socket" ]; then
    socket_gid=$(stat -c %g "$socket")
    [ "$socket_gid" = "$gid" ] || groups="$gid,$socket_gid"
fi

# The Docker client keeps its configuration under HOME, and an arbitrary uid
# has no home directory in this image.
HOME=/tmp/ghost-docker-home
export HOME
mkdir -p "$HOME"
chown "$uid:$gid" "$HOME"

exec setpriv --reuid "$uid" --regid "$gid" --groups "$groups" \
    node /opt/ghost-docker/manager/src/main.ts "$@"
