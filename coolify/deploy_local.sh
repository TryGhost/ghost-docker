#!/usr/bin/env bash

COOLIFY_DIR=$(dirname $0)

docker compose --project-directory $COOLIFY_DIR/.. -f $COOLIFY_DIR/docker-compose.6.yml -f $COOLIFY_DIR/docker-compose.6.local.yml up $@
