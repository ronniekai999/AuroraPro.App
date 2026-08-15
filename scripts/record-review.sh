#!/usr/bin/env bash
# Records the verdict of an independent adversarial review for the commit
# being pushed, which is what scripts/review-gate.sh checks.
#
#   bash scripts/record-review.sh <verdict> [--reviewer ID] [--findings N] "<summary>"
#
#   clean       no actionable defects, or only lows/nits
#   lows-only   same, kept distinct so the record stays honest
#   fix-first   high/critical found — records it and keeps the gate CLOSED
#   bypass      NO independent review happened. Opens the gate and obliges
#               you to report the gate as incomplete. This is the only way
#               past, on purpose: the previous escape hatch was an env var
#               that could not reach the hook process when exported, and
#               silently skipped its own warning when used as a command
#               prefix. A bypass that hides itself is worse than none.
#
# Records are keyed by commit sha and gitignored: a verdict is a statement
# about one exact diff, not about a branch, and it must not travel to
# another machine or survive an amend.
#
# The record also captures a digest of the reviewed diff. It cannot prove a
# review happened — nothing here can; anyone with write access can author a
# record by hand — but it makes a hollow one visible rather than plausible.

set -euo pipefail

verdict="${1:-}"; shift || true
reviewer=""
findings=""
summary=""

while [ $# -gt 0 ]; do
  case "$1" in
    --reviewer) reviewer="${2:-}"; shift 2 ;;
    --findings) findings="${2:-}"; shift 2 ;;
    -*) echo "record-review: unknown flag $1" >&2; exit 64 ;;
    *)
      if [ -n "$summary" ]; then
        echo "record-review: unexpected extra argument \"$1\" — quote the summary as ONE argument." >&2
        exit 64
      fi
      summary="$1"; shift ;;
  esac
done

case "$verdict" in
  clean|lows-only|fix-first|bypass) ;;
  *)
    echo "usage: bash scripts/record-review.sh <clean|lows-only|fix-first|bypass> [--reviewer ID] [--findings N] \"<summary>\"" >&2
    exit 64
    ;;
esac

# A summary of "   " is not a summary.
if [ -z "$(printf '%s' "$summary" | tr -d '[:space:]')" ]; then
  echo "record-review: a summary is required — what did the reviewer check, and what did it find?" >&2
  exit 64
fi

if [ -n "$findings" ] && ! printf '%s' "$findings" | grep -qE '^[0-9]+$'; then
  echo "record-review: --findings takes a number." >&2
  exit 64
fi

repo_root="$(git rev-parse --show-toplevel)"
head_sha="$(git rev-parse HEAD)"
records_dir="$repo_root/.claude/review-records"
mkdir -p "$records_dir"

# Digest of the diff the verdict describes, against the same base the gate
# uses. Empty when no upstream base resolves — recorded as such rather than
# silently omitted.
base=""
for candidate in origin/main origin/master; do
  if git -C "$repo_root" rev-parse --verify --quiet "$candidate" >/dev/null; then
    base="$candidate"; break
  fi
done
diff_digest=""
if [ -n "$base" ]; then
  mb="$(git -C "$repo_root" merge-base "$base" HEAD 2>/dev/null || true)"
  if [ -n "$mb" ]; then
    diff_digest="$(git -C "$repo_root" diff "$mb" HEAD | sha256sum | cut -d' ' -f1)"
  fi
fi

jq -n \
  --arg sha "$head_sha" \
  --arg verdict "$verdict" \
  --arg summary "$summary" \
  --arg reviewer "$reviewer" \
  --arg findings "$findings" \
  --arg digest "$diff_digest" \
  --arg branch "$(git rev-parse --abbrev-ref HEAD)" \
  --arg recorded_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{sha: $sha, verdict: $verdict, summary: $summary, reviewer: $reviewer,
    findings: $findings, diff_digest: $digest, branch: $branch, recorded_at: $recorded_at}' \
  > "$records_dir/$head_sha.json"

echo "record-review: $verdict recorded for $head_sha"
case "$verdict" in
  fix-first)
    echo "record-review: gate stays CLOSED — fix the high/critical findings, then re-review the final diff." >&2 ;;
  bypass)
    echo "record-review: gate will OPEN, but no review happened. Report the gate as INCOMPLETE in your handoff and on the PR." >&2 ;;
esac
