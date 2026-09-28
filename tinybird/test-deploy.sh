#!/bin/sh
# Exercise the deployment guard without contacting Tinybird.
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
cd "$temporary"
mkdir datasources bin
cat > bin/tb-wrapper <<'EOF'
#!/bin/sh
echo "$*" > called
exit 42
EOF
chmod +x bin/tb-wrapper
export PATH="$temporary/bin:$PATH"

# Both missing and empty raw datasource files must prevent CLI invocation.
for state in missing empty; do
    if [ "$state" = empty ]; then touch datasources/analytics_events.datasource; fi
    if sh "$script_dir/deploy.sh" > output 2>&1; then
        echo "FAIL: accepted $state analytics_events.datasource" >&2
        exit 1
    fi
    test ! -e called
    grep -q 'missing or empty' output
done

# No materialized views or endpoints are required. CLI errors must propagate.
printf 'SCHEMA >\n timestamp DateTime\n' > datasources/analytics_events.datasource
status=0
sh "$script_dir/deploy.sh" || status=$?
test "$status" -eq 42
test "$(cat called)" = '--cloud deploy --allow-destructive-operations'
echo 'Deployment guard tests passed.'
