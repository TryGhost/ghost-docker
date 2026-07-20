#!/bin/sh
# ghost-gate is always-running: server.js picks proxy vs setup mode based on whether
# the four TINYBIRD_* env vars are set.
set -e
mkdir -p /home/tinybird
exec node /app/server.js
