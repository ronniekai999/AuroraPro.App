#!/usr/bin/env bash
# Aurora live-server test loop.
#
# Logs in to the running server, optionally triggers the in-app
# auto-updater ("Update Now"), waits for the rebuild to land, then runs
# the API smoke test. Runs entirely over HTTPS — no SSH to the box.
#
# Credentials come from the environment (configure them as secrets in
# the Claude Code web environment — never commit them):
#
#   AURORA_TEST_USER   test-account username   (required)
#   AURORA_TEST_PASS   test-account password   (required)
#   AURORA_BASE        server base URL          (default https://aurorapro.app)
#   POLL_TIMEOUT       max seconds to wait for an update (default 300)
#
# The update path is ADMIN-ONLY and the server builds origin/main
# (AURORA_UPDATE_BRANCH, default main). Triggering only deploys commits
# already on main — so push/merge to main BEFORE --trigger-update.
#
# Usage:
#   bash scripts/server-test-loop.sh                   # login + smoke test
#   bash scripts/server-test-loop.sh --trigger-update  # + remote update first
#
# See docs/server-testing.md for the full runbook.

set -uo pipefail

BASE="${AURORA_BASE:-https://aurorapro.app}"
POLL_TIMEOUT="${POLL_TIMEOUT:-300}"
TRIGGER=0
[ "${1:-}" = "--trigger-update" ] && TRIGGER=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '→ %s\n' "$*"; }

[ -n "${AURORA_TEST_USER:-}" ] || die "AURORA_TEST_USER not set (configure it as an environment secret)."
[ -n "${AURORA_TEST_PASS:-}" ] || die "AURORA_TEST_PASS not set (configure it as an environment secret)."

# Build the login JSON body without risking quoting bugs in the
# credentials. Prefer jq, fall back to python3.
login_body() {
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg u "$AURORA_TEST_USER" --arg p "$AURORA_TEST_PASS" '{username:$u,password:$p}'
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,os;print(json.dumps({"username":os.environ["AURORA_TEST_USER"],"password":os.environ["AURORA_TEST_PASS"]}))'
  else
    die "need jq or python3 to build the login request safely."
  fi
}

# Log in; capture the httpOnly aurora_access JWT from the cookie jar.
# Sets global TOKEN.
login() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -c "$JAR" \
      -X POST "$BASE/api/auth/login" \
      -H 'Content-Type: application/json' \
      --data "$(login_body)")" \
    || die "could not reach $BASE/api/auth/login (network policy may block egress)."
  [ "$code" = "200" ] || die "login failed (HTTP $code) — check AURORA_TEST_USER/PASS and AURORA_BASE=$BASE."
  # Netscape cookie jar: field 6 = cookie name, field 7 = value. The JWT
  # is the value of the httpOnly 'aurora_access' cookie; the API accepts
  # it as a Bearer token.
  TOKEN="$(awk '$6=="aurora_access"{print $7}' "$JAR")"
  [ -n "${TOKEN:-}" ] || die "logged in (HTTP 200) but no aurora_access cookie found — auth shape may have changed."
}

# Read the "state" field out of the status JSON without requiring jq.
status_state() {
  printf '%s' "$1" | sed -n 's/.*"state"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}
status_message() {
  printf '%s' "$1" | sed -n 's/.*"message"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

trigger_and_wait() {
  info "Triggering remote update (POST /api/admin/system/update)"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' \
      -X POST "$BASE/api/admin/system/update" \
      -H "Authorization: Bearer $TOKEN")"
  case "$code" in
    200|202) ;;
    401|403) die "update trigger unauthorized (HTTP $code) — the test account must be an ADMIN." ;;
    *)       die "update trigger failed (HTTP $code)." ;;
  esac

  info "Update triggered; polling status (timeout ${POLL_TIMEOUT}s)"
  local waited=0 body state last=""
  while [ "$waited" -lt "$POLL_TIMEOUT" ]; do
    # The box restarts mid-update, so a curl blip here is expected; just
    # keep polling.
    body="$(curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/system/update/status" 2>/dev/null || true)"
    state="$(status_state "$body")"
    if [ -n "$state" ] && [ "$state" != "$last" ]; then
      printf '   state: %s\n' "$state"
      last="$state"
    fi
    case "$state" in
      success) info "Update complete."; return 0 ;;
      failed)  die "update FAILED on server: $(status_message "$body")" ;;
    esac
    sleep 3
    waited=$((waited + 3))
  done
  die "update did not finish within ${POLL_TIMEOUT}s (last state: ${last:-unknown})."
}

# ── run ──────────────────────────────────────────────────────────────
info "Server: $BASE"
login
info "Logged in as $AURORA_TEST_USER."

if [ "$TRIGGER" = "1" ]; then
  trigger_and_wait
  # Re-login for a fresh token: the access token may have aged out during
  # a long build, and the service just restarted.
  login
fi

info "Running API smoke test"
AURORA_TOKEN="$TOKEN" AURORA_BASE="$BASE" bash "$SCRIPT_DIR/aurora_smoke_test.sh"
