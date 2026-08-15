#!/usr/bin/env bash
# Records the verdict of an independent adversarial review for the current
# HEAD, which is what scripts/review-gate.sh checks before allowing a push.
#
#   bash scripts/record-review.sh <verdict> "<reviewer> — <summary>"
#
#   verdict: clean       no actionable defects, or only lows/nits
#            lows-only   same, kept distinct so the record is honest
#            fix-first   high/critical found — records the finding and
#                        keeps the gate CLOSED until re-reviewed
#
# Records are keyed by commit sha and gitignored: a verdict is a statement
# about one exact diff, not about a branch, and it must not travel to
# another machine or survive an amend.

set -euo pipefail

verdict="${1:-}"
summary="${2:-}"

case "$verdict" in
  clean|lows-only|fix-first) ;;
  *)
    echo "usage: bash scripts/record-review.sh <clean|lows-only|fix-first> \"<reviewer> — <summary>\"" >&2
    exit 64
    ;;
esac

if [ -z "$summary" ]; then
  echo "record-review: a summary is required — what did the reviewer actually check, and what did it find?" >&2
  exit 64
fi

repo_root="$(git rev-parse --show-toplevel)"
head_sha="$(git rev-parse HEAD)"
records_dir="$repo_root/.claude/review-records"
mkdir -p "$records_dir"

jq -n \
  --arg sha "$head_sha" \
  --arg verdict "$verdict" \
  --arg summary "$summary" \
  --arg branch "$(git rev-parse --abbrev-ref HEAD)" \
  --arg recorded_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{sha: $sha, verdict: $verdict, summary: $summary, branch: $branch, recorded_at: $recorded_at}' \
  > "$records_dir/$head_sha.json"

echo "record-review: $verdict recorded for $head_sha"
if [ "$verdict" = "fix-first" ]; then
  echo "record-review: gate stays CLOSED — fix the high/critical findings, then re-review the final diff." >&2
fi
