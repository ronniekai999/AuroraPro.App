#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/env-file.sh
# shellcheck disable=SC1091
. "$PROJECT_ROOT/scripts/lib/env-file.sh"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
ENV_FILE="$TMP_ROOT/aurora.env"

cat > "$ENV_FILE" <<'EOF'
# operator comment
DATABASE_URL=postgres://old
LOG_LEVEL=debug
CUSTOM_FUTURE_SETTING=keep-me
DUPLICATE=first
DUPLICATE=second
QUOTED_VALUE="quoted"
EOF

aurora_env_upsert "$ENV_FILE" DATABASE_URL "postgres://new"
aurora_env_upsert "$ENV_FILE" NEW_SETTING "new-value"
aurora_env_upsert "$ENV_FILE" DUPLICATE "only"
aurora_env_ensure "$ENV_FILE" LOG_LEVEL "info"
aurora_env_ensure "$ENV_FILE" DEFAULTED "yes"

[ "$(aurora_env_get "$ENV_FILE" DATABASE_URL)" = "postgres://new" ]
[ "$(aurora_env_get "$ENV_FILE" LOG_LEVEL)" = "debug" ]
[ "$(aurora_env_get "$ENV_FILE" CUSTOM_FUTURE_SETTING)" = "keep-me" ]
[ "$(aurora_env_get "$ENV_FILE" NEW_SETTING)" = "new-value" ]
[ "$(aurora_env_get "$ENV_FILE" DEFAULTED)" = "yes" ]
[ "$(aurora_env_get "$ENV_FILE" DUPLICATE)" = "only" ]
[ "$(grep -c '^DUPLICATE=' "$ENV_FILE")" -eq 1 ]
[ "$(aurora_env_get_unquoted "$ENV_FILE" QUOTED_VALUE)" = "quoted" ]
grep -q '^# operator comment$' "$ENV_FILE"

if aurora_env_upsert "$ENV_FILE" "INVALID-KEY" "value" >/dev/null 2>&1; then
    echo "invalid key was accepted" >&2
    exit 1
fi
if aurora_env_upsert "$ENV_FILE" "VALID_KEY" $'line one\nline two' >/dev/null 2>&1; then
    echo "multiline value was accepted" >&2
    exit 1
fi

echo "env-file tests passed"
