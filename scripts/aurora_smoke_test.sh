#!/usr/bin/env bash
# Aurora API smoke test — exercise every read-only endpoint with a
# bearer token, validate status code + key JSON shape fields.
#
# Usage:
#   AURORA_TOKEN=eyJ...   ./aurora_smoke_test.sh           # default base = https://aurorapro.app
#   AURORA_TOKEN=eyJ...   AURORA_BASE=https://other.app ./aurora_smoke_test.sh
#
# Get your token from your browser:
#   1. Open Aurora in Chrome/Firefox (signed in)
#   2. DevTools → Application → Local Storage → https://aurorapro.app
#   3. Copy the value of `aurora_token`
#   4. Run:  AURORA_TOKEN='<paste>' bash scripts/aurora_smoke_test.sh
#
# For full admin-path coverage use an admin user's token; non-admin
# tokens will fail the admin checks (script reports + continues).
#
# Optional: `jq` enables JSON-shape validation. Without jq, only HTTP
# status codes are checked. Install with: brew install jq / apt install jq.

set -uo pipefail

BASE="${AURORA_BASE:-https://aurorapro.app}"
TOKEN="${AURORA_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  sed -n '3,17p' "$0" >&2
  echo >&2
  echo "ERROR: AURORA_TOKEN not set." >&2
  exit 2
fi

# ANSI colors — disabled when stdout isn't a terminal.
if [ -t 1 ]; then
  G='\033[1;32m'; R='\033[1;31m'; Y='\033[1;33m'; B='\033[1;36m'; D='\033[0;90m'; N='\033[0m'
else
  G=''; R=''; Y=''; B=''; D=''; N=''
fi

HAS_JQ=0
command -v jq >/dev/null 2>&1 && HAS_JQ=1

PASS=0; FAIL=0; WARN=0; SKIP=0
FAILED_LIST=()
RESP_FILE="/tmp/aurora_smoke_$$.body"
trap 'rm -f "$RESP_FILE"' EXIT

pass()    { printf "  ${G}✓${N} %s ${D}%s${N}\n" "$1" "${2:-}"; PASS=$((PASS+1)); }
fail()    { printf "  ${R}✗${N} %s ${D}%s${N}\n    ${R}└─${N} %s\n" "$1" "${2:-}" "$3"; FAIL=$((FAIL+1)); FAILED_LIST+=("$1"); }
warn()    { printf "  ${Y}!${N} %s ${D}%s${N}\n    ${Y}└─${N} %s\n" "$1" "${2:-}" "$3"; WARN=$((WARN+1)); }
skip()    { printf "  ${D}-${N} %s ${D}(skipped — %s)${N}\n" "$1" "$2"; SKIP=$((SKIP+1)); }
section() { printf "\n${B}═══ %s${N}\n" "$*"; }

# check_get NAME PATH EXPECTED_STATUS [auth=yes|no] [jq_filter]
# - Makes a GET request, asserts status code matches EXPECTED_STATUS.
# - If jq is present AND jq_filter is non-empty, runs the filter against
#   the body; expects a non-empty, non-"null" result.
check_get() {
  local name="$1" path="$2" expect="$3" auth="${4:-yes}" jq_check="${5:-}"
  local h=() status body t0 t1 elapsed excerpt

  [ "$auth" = "yes" ] && h=(-H "Authorization: Bearer $TOKEN")

  t0=$(date +%s 2>/dev/null)
  status=$(curl -sS -o "$RESP_FILE" -w '%{http_code}' --max-time 30 "${h[@]}" "$BASE$path" 2>/dev/null || echo "000")
  t1=$(date +%s 2>/dev/null)
  elapsed="$((t1 - t0))s"

  if [ "$status" = "000" ]; then
    fail "$name" "$elapsed" "Network error / unreachable"
    return
  fi

  if [ "$status" != "$expect" ]; then
    excerpt="$(head -c 180 "$RESP_FILE" 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
    fail "$name" "[$status, $elapsed]" "expected $expect — body: $excerpt"
    return
  fi

  if [ -n "$jq_check" ] && [ "$HAS_JQ" = "1" ]; then
    local result
    result=$(jq -er "$jq_check" < "$RESP_FILE" 2>/dev/null || true)
    if [ -z "$result" ] || [ "$result" = "null" ]; then
      excerpt="$(head -c 180 "$RESP_FILE" 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
      fail "$name" "[$status, $elapsed]" "JSON shape check failed: '$jq_check' — body: $excerpt"
      return
    fi
    pass "$name" "[$status, $elapsed] → $result"
  else
    pass "$name" "[$status, $elapsed]"
  fi
}

echo
echo "Aurora API smoke test"
echo "  Base:     $BASE"
echo "  Token:    ${TOKEN:0:12}…${TOKEN: -8}"
echo "  jq:       $([ "$HAS_JQ" = "1" ] && echo "yes" || echo "no — install for shape checks")"

section "1. Public — no auth required"
check_get "GET /api/health"             /api/health             200 no  '.status // "ok"'
check_get "GET /api/auth/setup-status"  /api/auth/setup-status  200 no  '.has_users | tostring'

section "2. Auth — token validity"
check_get "GET /api/auth/me"   /api/auth/me   200 yes '.username'

# Determine admin role for later admin-section gating.
IS_ADMIN=0
if [ "$HAS_JQ" = "1" ]; then
  role=$(curl -sS -H "Authorization: Bearer $TOKEN" --max-time 10 "$BASE/api/auth/me" 2>/dev/null | jq -r '.role // ""' || echo "")
  echo "    Role: $role"
  [ "$role" = "admin" ] && IS_ADMIN=1
fi

section "3. Hero + personalization (recent feature)"
check_get "GET /api/me/hero"  /api/me/hero  200 yes '.picks | length | tostring'
check_get "  → personalization.cold_start present"   /api/me/hero  200 yes '.personalization.cold_start | tostring'
check_get "  → personalization.history_count"        /api/me/hero  200 yes '.personalization.history_count | tostring'
check_get "  → personalization.threshold"            /api/me/hero  200 yes '.personalization.threshold | tostring'
check_get "GET /api/me/discover"          /api/me/discover          200 yes '.rails // [] | length | tostring'
check_get "GET /api/me/recommendations"   /api/me/recommendations   200 yes '.items | length | tostring'
check_get "GET /api/me/anchor-rails"      /api/me/anchor-rails      200 yes '.rails | length | tostring'

section "4. Media browse"
check_get "GET /api/media (page 1)"          /api/media           200 yes '.data | length | tostring'
check_get "GET /api/media/recent"            /api/media/recent    200 yes 'if type == "array" then length | tostring else .data | length | tostring end'
check_get "GET /api/media/search?q=test"     '/api/media/search?q=test'  200 yes '.items | length | tostring'

# Pick a real media ID to test detail endpoints.
if [ "$HAS_JQ" = "1" ]; then
  MEDIA_ID=$(curl -sS -H "Authorization: Bearer $TOKEN" --max-time 10 "$BASE/api/media?per_page=1" 2>/dev/null | jq -r '.data[0].id // empty' || echo "")
  if [ -n "$MEDIA_ID" ]; then
    echo "    Sampling media_id=$MEDIA_ID"
    check_get "GET /api/media/$MEDIA_ID"             "/api/media/$MEDIA_ID"             200 yes '.id | tostring'
    check_get "GET /api/media/$MEDIA_ID/files"       "/api/media/$MEDIA_ID/files"       200 yes ''
    check_get "GET /api/media/$MEDIA_ID/artwork"     "/api/media/$MEDIA_ID/artwork"     200 yes ''
    check_get "GET /api/media/$MEDIA_ID/cast"        "/api/media/$MEDIA_ID/cast"        200 yes ''
  else
    skip "media detail endpoints" "no media to sample"
  fi
fi

section "5. Libraries"
check_get "GET /api/libraries"             /api/libraries              200 yes 'length | tostring'
if [ "$HAS_JQ" = "1" ]; then
  LIB_ID=$(curl -sS -H "Authorization: Bearer $TOKEN" --max-time 10 "$BASE/api/libraries" 2>/dev/null | jq -r '.[0].id // empty' || echo "")
  [ -n "$LIB_ID" ] && check_get "GET /api/libraries/$LIB_ID/scan/status" "/api/libraries/$LIB_ID/scan/status" 200 yes '.scanning | tostring'
fi

section "6. Profiles"
check_get "GET /api/profiles"   /api/profiles   200 yes '.[0].id | tostring'

section "7. Progress + Continue Watching"
check_get "GET /api/progress/continue"  /api/progress/continue  200 yes 'if .items then .items | length | tostring else "0" end'
check_get "GET /api/progress/recent"    /api/progress/recent    200 yes 'if .items then .items | length | tostring else "0" end'
check_get "GET /api/progress/history"   /api/progress/history   200 yes ''

section "8. Collections, Calendar, Gamification"
check_get "GET /api/collections"          /api/collections          200 yes ''
check_get "GET /api/calendar"             /api/calendar             200 yes ''
check_get "GET /api/me/gamification"      /api/me/gamification      200 yes ''

section "9. Requests"
check_get "GET /api/requests"          /api/requests          200 yes ''
check_get "GET /api/requests/config"   /api/requests/config   200 yes ''
check_get "GET /api/requests/status"   /api/requests/status   200 yes ''

section "10. Watch parties"
check_get "GET /api/parties/active"   /api/parties/active   200 yes ''
check_get "GET /api/voice/ice-servers" /api/voice/ice-servers 200 yes ''

section "11. Admin (requires admin role)"
if [ "$IS_ADMIN" = "1" ] || [ "$HAS_JQ" = "0" ]; then
  check_get "GET /api/admin/dashboard"               /api/admin/dashboard               200 yes ''
  check_get "GET /api/admin/sessions"                /api/admin/sessions                200 yes ''
  check_get "GET /api/admin/activity"                /api/admin/activity                200 yes ''
  check_get "GET /api/admin/settings"                /api/admin/settings                200 yes ''
  check_get "GET /api/admin/llm"                     /api/admin/llm                     200 yes '.provider // "none"'
  check_get "  → provider configured (ollama_cloud or local)" /api/admin/llm  200 yes 'select(.provider == "ollama_cloud" or .provider == "local") | "ok"'
  check_get "  → has_api_key (sanity for cloud setup)"        /api/admin/llm  200 yes '.has_api_key | tostring'
  check_get "GET /api/admin/oauth"                   /api/admin/oauth                   200 yes ''
  check_get "GET /api/admin/embedding-status"        /api/admin/embedding-status        200 yes ''
  # Referral attribution (migration 046). Shaped-empty on an instance where
  # nobody was ever eligible, so this asserts the SHAPE, not a nonzero count.
  check_get "GET /api/admin/referrals/summary"       /api/admin/referrals/summary       200 yes '.total | tostring'
  check_get "  → by_source is an array"              /api/admin/referrals/summary       200 yes '.by_source | type | select(. == "array")'
  check_get "  → windowed (?days=30)"                '/api/admin/referrals/summary?days=30' 200 yes '.window_days | tostring'
  check_get "  → rejects an out-of-range window"     '/api/admin/referrals/summary?days=99999' 400 yes ''
  check_get "GET /api/admin/flagged"                 /api/admin/flagged                 200 yes ''
  check_get "GET /api/admin/logs"                    /api/admin/logs                    200 yes ''
  check_get "GET /api/admin/users"                   /api/admin/users                   200 yes '.[0].username // "none"'
  check_get "GET /api/admin/system/update/status"    /api/admin/system/update/status    200 yes '.state'
  check_get "GET /api/tmdb/search?q=matrix"          '/api/tmdb/search?q=matrix'        200 yes ''
else
  skip "all admin endpoints" "token is not admin"
fi

section "12. 401 / 403 negatives — auth enforcement"
# These should reject anonymous access.
# The referral prompt: the standing test user signed up long before migration
# 046, so the server must report NOT pending — and must disclose neither the
# question nor the option list to an ineligible caller.
check_get "GET /api/me/referral-prompt"              /api/me/referral-prompt  200 yes '.pending | tostring'
check_get "  → not pending for an ineligible user"   /api/me/referral-prompt  200 yes '.pending | select(. == false) | "ok"'
check_get "  → withholds the question"               /api/me/referral-prompt  200 yes '.question // "absent" | select(. == "absent")'

check_get "GET /api/me/referral-prompt w/o token (expect 401)" /api/me/referral-prompt 401 no ''
check_get "GET /api/admin/referrals/summary w/o token (expect 401)" /api/admin/referrals/summary 401 no ''
check_get "GET /api/me/hero w/o token (expect 401)"  /api/me/hero   401 no ''
check_get "GET /api/media w/o token (expect 401)"    /api/media     401 no ''

echo
echo "════════════════════════════════════════════════════════════════"
printf "  ${G}Pass:${N} %d   ${R}Fail:${N} %d   ${Y}Warn:${N} %d   ${D}Skip:${N} %d\n" "$PASS" "$FAIL" "$WARN" "$SKIP"
if [ ${#FAILED_LIST[@]} -gt 0 ]; then
  echo
  printf "${R}Failed checks:${N}\n"
  for f in "${FAILED_LIST[@]}"; do
    printf "  - %s\n" "$f"
  done
  echo
  echo "Paste the full output above (including red lines) to debug."
  exit 1
fi
echo
echo "All checks passed."
