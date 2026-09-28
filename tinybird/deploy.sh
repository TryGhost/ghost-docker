#!/bin/sh
set -eu

# Never deploy a project that would remove Ghost's raw analytics datasource.
if [ ! -f datasources/analytics_events.datasource ] || [ ! -s datasources/analytics_events.datasource ]; then
    echo 'Refusing to deploy: datasources/analytics_events.datasource is missing or empty.' >&2
    exit 1
fi

tb-wrapper --cloud deploy --allow-destructive-operations
