#!/usr/bin/env bash
# Dump the ACTUAL response shape of every endpoint the native clients use.
#
# Why this exists: the macOS client's first three bugs were all the same
# mistake — the client was written against an ASSUMED response shape rather
# than the real one. `poster_path` turned out to need the /api/images proxy,
# and /api/stream/info returns an envelope with the decision nested under
# "stream". Both were invisible until the app was running, because a fixture
# written from an assumption passes against itself.
#
# Run this against a real server and the output is ground truth: top-level
# keys, types, and a trimmed sample for each endpoint. Paste it back to
# whoever is writing a client.
#
# Usage:
#   AURORA_USER=you AURORA_PASS=secret ./scripts/client-api-shapes.sh
#   ./scripts/client-api-shapes.sh https://aurorapro.app        # prompts
#
# Credentials are read from the environment or prompted for. They are never
# echoed and never written to disk; the cookie jar goes to a mode-600 temp
# file that is deleted on exit.

set -euo pipefail

BASE="${1:-${AURORA_BASE:-https://aurorapro.app}}"
BASE="${BASE%/}"

JAR="$(mktemp)"
chmod 600 "$JAR"

user="${AURORA_USER:-${AURORA_TEST_USER:-}}"
pass="${AURORA_PASS:-${AURORA_TEST_PASS:-}}"
if [ -z "$user" ]; then read -r -p "Username: " user; fi
if [ -z "$pass" ]; then read -r -s -p "Password: " pass; echo; fi

# Summarize JSON structurally: keys and types, not values. Keeps the output
# readable and avoids pasting a library's worth of titles into a chat.
#
# The summarizer is written to a temp FILE rather than fed to `python3 -` via
# a heredoc. That was the first version and it silently printed nothing: a
# heredoc IS stdin, so python consumed it as the program and sys.stdin.read()
# returned "" — every endpoint reported "NOT JSON" while returning perfectly
# good JSON.
SUMMARIZER="$(mktemp -t summarize.XXXXXX.py)"
trap 'rm -f "$JAR" "$SUMMARIZER"' EXIT
cat >"$SUMMARIZER" <<'PY'
import json, sys

def kind(v, depth=0):
    if isinstance(v, dict):
        if depth >= 2:
            return "{…}"
        return "{" + ", ".join(f"{k}: {kind(x, depth+1)}" for k, x in list(v.items())[:14]) + "}"
    if isinstance(v, list):
        return "[]" if not v else f"[{kind(v[0], depth+1)} ×{len(v)}]"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, (int, float)):
        return "number"
    if v is None:
        return "null"
    s = str(v)
    return f'"{s[:40]}…"' if len(s) > 40 else f'"{s}"'

raw = sys.stdin.read()
if not raw.strip():
    print("  (empty body)")
    sys.exit()
try:
    data = json.loads(raw)
except Exception:
    print(f"  NOT JSON — {raw[:200]}")
    sys.exit()
if isinstance(data, list):
    print(f"  shape: [{kind(data[0]) if data else ''} ×{len(data)}]")
else:
    print(f"  shape: {kind(data)}")
PY

summarize() { python3 "$SUMMARIZER"; }

req() { # name, path
  local name="$1" path="$2"
  local code
  local body
  body="$(curl -sS -b "$JAR" -c "$JAR" -w $'\n%{http_code}' --max-time 30 "$BASE$path" 2>/dev/null)" || {
    echo "  $name: request failed"; return; }
  code="$(printf '%s' "$body" | tail -n1)"
  body="$(printf '%s' "$body" | sed '$d')"
  echo "── $name"
  echo "  GET $path → HTTP $code"
  [ "$code" = "200" ] && printf '%s' "$body" | summarize
  echo
}

echo "Aurora client API shapes — $BASE"
echo "================================================"
echo

echo "── auth"
login_code="$(curl -sS -o /dev/null -w '%{http_code}' -c "$JAR" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,os,sys; print(json.dumps({"username":sys.argv[1],"password":sys.argv[2]}))' "$user" "$pass")" \
  --max-time 30 "$BASE/api/auth/login")"
echo "  POST /api/auth/login → HTTP $login_code"
if [ "$login_code" != "200" ]; then
  echo "  login failed — cannot continue"; exit 1
fi
# Prove the cookie-auth model the native client depends on.
echo "  cookies set: $(grep -c $'\t' "$JAR" || echo 0)"
echo "  cookie names: $(awk -F'\t' 'NF>=7 {sub(/^#HttpOnly_/, "", $1); printf "%s ", $6}' "$JAR")"
echo

req "me (auth)"        "/api/auth/me"
req "continue"         "/api/progress/continue"
req "recent"           "/api/media/recent?limit=3"
req "libraries"        "/api/libraries"

# Resolve one real media id, then exercise the playback path against it.
ID="$(curl -sS -b "$JAR" --max-time 30 "$BASE/api/media/recent?limit=1" \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
items = d if isinstance(d,list) else d.get("items",[])
print(items[0]["id"] if items else "")' 2>/dev/null || true)"

if [ -n "$ID" ]; then
  echo "using media id $ID"
  echo
  req "media detail"   "/api/media/$ID"
  req "media files"    "/api/media/$ID/files"

  FILE_ID="$(curl -sS -b "$JAR" --max-time 30 "$BASE/api/media/$ID/files" \
    | python3 -c 'import json,sys
d=json.load(sys.stdin)
f = d if isinstance(d,list) else d.get("items",[])
print(f[0]["id"] if f else "")' 2>/dev/null || true)"

  if [ -n "$FILE_ID" ]; then
    # The two capability sets the Mac client can send. Comparing the
    # decisions side by side is the whole point of the Tier 1 work.
    APPLE="aac,ac3,eac3,flac,h264,hevc,hevc_main10,hls_native,mp3,mp4_container"
    VLC="alac,av1,avi_container,aac,ac3,dts,eac3,flac,h264,h264_hi10,hevc,hevc_main10,hls_native,mkv_container,mlp,mp2,mp3,mp4_container,mpeg2video,mpeg4,msmpeg4v3,opus,pcm_bluray,pcm_s16le,pcm_s24le,truehd,ts_container,vc1,vorbis,vp8,vp9,webm_container"

    req "stream info (no caps)"     "/api/stream/info/$FILE_ID?type=media"
    req "stream info (Apple caps)"  "/api/stream/info/$FILE_ID?type=media&caps=$APPLE"
    req "stream info (libVLC caps)" "/api/stream/info/$FILE_ID?type=media&caps=$VLC"

    echo "── decisions side by side (this is Tier 1 working, or not)"
    for label in "Apple:$APPLE" "libVLC:$VLC"; do
      name="${label%%:*}"; caps="${label#*:}"
      curl -sS -b "$JAR" --max-time 30 "$BASE/api/stream/info/$FILE_ID?type=media&caps=$caps" \
        | python3 -c "import json,sys
s = json.load(sys.stdin).get('stream', {})
print('  %-7s → %-14s %s' % ('$name', s.get('decision','?'), s.get('transcode_reason','') or ''))" 2>/dev/null \
        || echo "  $name → failed"
    done
    echo
  fi

  # Artwork: confirm the proxy path the client must use, and that the raw
  # poster_path is NOT directly fetchable (the bug this script would have
  # caught in five seconds).
  POSTER="$(curl -sS -b "$JAR" --max-time 30 "$BASE/api/media/$ID" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("poster_path") or "")' 2>/dev/null || true)"
  if [ -n "$POSTER" ]; then
    echo "── artwork"
    echo "  poster_path = $POSTER"
    clean="${POSTER#/}"
    for p in "/$clean" "/api/images/w500/$clean"; do
      c="$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" --max-time 30 "$BASE$p")"
      echo "  GET $p → HTTP $c"
    done
    echo
  fi
fi

echo "================================================"
echo "Done. Paste this output back to compare against the client's assumptions."
