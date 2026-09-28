#!/bin/sh
# Exercise the deployment guard without contacting Tinybird.
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
cd "$temporary"
mkdir bin
cat > bin/tb-wrapper <<'MOCK'
#!/bin/sh
set -eu
echo "$*" >> calls
case "$*" in
    '--cloud --output json deploy --check --allow-destructive-operations')
        cat plan.json
        exit "${CHECK_EXIT:-0}"
        ;;
    '--cloud deploy --allow-destructive-operations')
        touch deployed
        exit "${DEPLOY_EXIT:-0}"
        ;;
    *) exit 99 ;;
esac
MOCK
chmod +x bin/tb-wrapper
export PATH="$temporary/bin:$PATH"

assert_blocked() {
    rm -f calls deployed
    if sh "$script_dir/deploy.sh" > output 2>&1; then
        echo 'FAIL: unsafe or invalid plan was accepted' >&2
        exit 1
    fi
    test ! -e deployed
    test "$(wc -l < calls | tr -d ' ')" -eq 1
}

# Block deletion even when the same resource is also being created.
for plan in \
    '{"deleted_datasource_names":["analytics_events"]}' \
    '{"deleted_datasource_names":["analytics_events"],"new_datasource_names":["analytics_events"]}' \
    '{}' \
    '{"deleted_datasource_names":null}' \
    '{"deleted_datasource_names":"analytics_events"}' \
    '{"deleted_datasource_names":[null]}' \
    '{"deleted_datasource_names":[]} {"deleted_datasource_names":[]}' \
    'not JSON' \
    ''; do
    printf '%s' "$plan" > plan.json
    assert_blocked
done

# A failed check must stop deployment even if it emitted a valid, safe plan.
echo '{"deleted_datasource_names":[]}' > plan.json
export CHECK_EXIT=1
assert_blocked
unset CHECK_EXIT

# Accept no changes, first deployment, and materialized-view removal, without
# requiring any local datafiles. Preserve the exit status of the real deploy.
for plan in \
    '{"deleted_datasource_names":[]}' \
    '{"deleted_datasource_names":[],"new_datasource_names":["analytics_events"]}' \
    '{"deleted_datasource_names":["_mv_hits"],"deleted_pipe_names":["mv_hits"]}'; do
    printf '%s' "$plan" > plan.json
    rm -f calls deployed
    export DEPLOY_EXIT=42
    status=0
    sh "$script_dir/deploy.sh" || status=$?
    test "$status" -eq 42
    test -e deployed
    test "$(wc -l < calls | tr -d ' ')" -eq 2
    test "$(tail -n 1 calls)" = '--cloud deploy --allow-destructive-operations'
done

echo 'Deployment plan guard tests passed.'
