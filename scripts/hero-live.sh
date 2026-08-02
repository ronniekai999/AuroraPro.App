#!/usr/bin/env bash
#
# hero-live.sh — capture what the hero rail ACTUALLY returned, over HTTPS.
#
# hero-diag.sh reports the inputs; this reports the output. Together they say
# whether a bad hero came from bad candidates or from the LLM stage mishandling
# good ones. Two things only visible here:
#
#   - picks rendering with NO reason. The server discards a blurb whose tone
#     contradicts the pick's genres/rating, or that runs past the length limit
#     (internal/reasonguard). A reason-less pick means the LLM wrote something
#     the guard rejected — a different failure from picking the wrong title.
#   - match percentages. A hero full of low "% for you" means the candidates
#     were far from the taste centroid, i.e. a recall problem.
#
# READ ONLY: every request is a GET. Nothing here writes to the server.
#
# Credentials come from the environment and are never written to the report:
#   AURORA_TEST_USER, AURORA_TEST_PASS, optional AURORA_BASE
#
# Usage:
#   export AURORA_TEST_USER=… AURORA_TEST_PASS=…
#   bash scripts/hero-live.sh

set -euo pipefail

BASE="${AURORA_BASE:-https://aurorapro.app}"
OUT="${AURORA_LIVE_OUT:-/tmp/hero-live-$(date -u +%Y%m%dT%H%M%SZ).json.txt}"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

: "${AURORA_TEST_USER:?set AURORA_TEST_USER (see docs/server-testing.md)}"
: "${AURORA_TEST_PASS:?set AURORA_TEST_PASS (see docs/server-testing.md)}"

command -v curl >/dev/null 2>&1 || die "curl not found"
command -v jq   >/dev/null 2>&1 || die "jq not found (apt-get install -y jq)"

# ── Log in ────────────────────────────────────────────────────────────
# --arg, not string interpolation: a password containing a quote or backslash
# would otherwise produce malformed JSON, and the failure would look like bad
# credentials rather than bad quoting.
login_body=$(jq -n --arg u "$AURORA_TEST_USER" --arg p "$AURORA_TEST_PASS" \
              '{username:$u, password:$p}')

login=$(curl -sS -X POST "$BASE/api/auth/login" \
             -H 'Content-Type: application/json' \
             -d "$login_body") || die "login request failed"

TOKEN=$(printf '%s' "$login" | jq -r '.access_token // .token // empty')
[ -n "$TOKEN" ] || die "login did not return a token (check AURORA_TEST_USER/PASS)"

auth_get() { curl -sS -H "Authorization: Bearer $TOKEN" "$BASE$1"; }

# ── Capture ───────────────────────────────────────────────────────────
{
echo "=============================================================="
echo " Aurora hero — live output"
echo " $BASE   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "=============================================================="

echo
echo "## Hero picks (?refresh=1 forces a rebuild, bypassing the pool cache)"
echo
hero=$(auth_get '/api/me/hero?refresh=1')
printf '%s' "$hero" | jq '.' 2>/dev/null || printf '%s\n' "$hero"

echo
echo "## Summary — the two tells"
echo
echo "reason=null is the reasonguard rejecting the LLM's blurb."
echo "A low match% means the pick sat far from the taste centroid."
printf '%s' "$hero" | jq -r '
  (.items // .picks // .hero // []) as $p
  | if ($p|length) == 0 then "no picks returned — hero is empty or the shape differs; see raw JSON above"
    else ( "picks: \($p|length)",
           "without a reason: \([$p[] | select((.reason // "") == "")] | length)",
           "",
           ($p[] | "  \(.title // .item.title // "?")  [\(.content_rating // .item.content_rating // "?")]  match=\(.match // 0)%  score=\(.score // 0)  reason=\(if (.reason // "") == "" then "(none — guard rejected or not generated)" else .reason end)") )
    end' 2>/dev/null || echo "(could not summarise — see raw JSON above)"

echo
echo "## Anchor rails — pure vector retrieval, NO LLM"
echo
echo "This is the control. Anchor rails skip the LLM entirely, so if these"
echo "look just as wrong, the problem is retrieval, not the model."
auth_get '/api/me/anchor-rails' | jq '[.rails[]? | {anchor: (.anchor_title // .anchor // "?"), items: [.items[]? | {title, content_rating}][0:6]}]' 2>/dev/null \
  || echo "(no anchor rails / different shape)"

echo
echo "## Discover rails — LLM-themed"
echo
auth_get '/api/me/discover' | jq '[.rails[]? | {title: (.rail_title // .title), description: (.rail_description // .description), items: [.items[]? | {title, content_rating}][0:6]}]' 2>/dev/null \
  || echo "(no discover rails / different shape)"

echo
echo "=============================================================="
echo " end"
echo "=============================================================="
} > "$OUT" 2>&1

echo "Captured to: $OUT"
echo
echo "Contains titles and your recommendations, no credentials. Safe to share"
echo "after a read-through."
