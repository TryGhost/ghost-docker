#!/bin/sh
set -eu

plan=$(mktemp)
trap 'rm -f "$plan"' EXIT
trap 'exit 1' HUP INT TERM

# --check asks Tinybird to calculate the deployment without applying it.
tb-wrapper --cloud --output json deploy --check --allow-destructive-operations > "$plan"

# Fail closed on missing, malformed, or incompatible CLI output.
if ! jq -e -s '
    length == 1 and (.[0] | type == "object" and
        (.deleted_datasource_names | type == "array" and all(.[]; type == "string")))
' "$plan" > /dev/null; then
    echo 'Refusing to deploy: Tinybird returned an unrecognized deployment plan.' >&2
    exit 1
fi

if jq -e '.deleted_datasource_names | index("analytics_events") != null' "$plan" > /dev/null; then
    echo 'Refusing to deploy: Tinybird plans to delete analytics_events.' >&2
    exit 1
fi

tb-wrapper --cloud deploy --allow-destructive-operations
