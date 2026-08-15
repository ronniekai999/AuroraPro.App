#!/usr/bin/env bash
# Verifies that every commit a PR adds carries an adversarial-review record.
#
# THIS is the enforcement boundary. The client-side layers (.githooks/pre-push
# and the PreToolUse hook) are advisory: `core.hooksPath` is per-clone config
# the pushing agent controls, so `git -c core.hooksPath=/dev/null push`, a
# throwaway `git clone`, or a plain `git config` turns them off in one token.
# Five review rounds of tightening the client side produced a sixth bypass
# every time. A check that runs on the server, on a branch the pusher does not
# control, does not have that property.
#
# It is only actually binding once it is a REQUIRED status check in branch
# protection — a repo-settings change a human must make. Until then this job
# reports honestly and blocks nothing.
#
# Usage: review-gate-ci.sh <base-ref> <head-ref>
set -uo pipefail

BASE="${1:-origin/main}"
HEAD_REF="${2:-HEAD}"
RECORDS_DIR=".claude/review-records"

command -v jq >/dev/null 2>&1 || { echo "review-gate-ci: jq missing"; exit 1; }

merge_base="$(git merge-base "$BASE" "$HEAD_REF" 2>/dev/null)" || {
  echo "review-gate-ci: cannot find merge-base of $BASE and $HEAD_REF"; exit 1; }

# The HEAD commit only. A review covers the cumulative diff (base...head),
# which is exactly what the record for the head commit describes; demanding
# one per intermediate commit would require reviews nobody performs. A new
# head — including one produced by amending or by adding a commit — needs a
# new record, which is the property that matters.
head_sha="$(git rev-parse --verify "$HEAD_REF^{commit}" 2>/dev/null)" || {
  echo "review-gate-ci: cannot resolve $HEAD_REF"; exit 1; }
commits=("$head_sha")
if [ "$merge_base" = "$head_sha" ]; then
  echo "review-gate-ci: no commits to check."
  exit 0
fi

# Only the commits that touch something other than documentation need a
# record. Rename detection is OFF: with it on, `git mv code.go docs/x.md`
# reports only the destination and reads as a docs-only change — that is how
# a reviewer deleted this repo's own gate through the exemption.
needs_review() {
  local sha="$1" changed
  # Against the MERGE BASE, matching the diff the reviewer actually read.
  changed="$(git diff --no-renames --name-only "$merge_base" "$sha" 2>/dev/null)" ||
    changed="$(git diff --no-renames --name-only "$(git hash-object -t tree /dev/null)" "$sha" 2>/dev/null)"
  [ -n "$changed" ] || return 1
  # Adding a review record is not a code change. Records must be TRACKED for
  # this check to see them on a CI checkout, so without this exemption
  # recording a review for X would create commit Y that itself needed a
  # record, and so on forever.
  changed="$(printf '%s\n' "$changed" | grep -v '^\.claude/review-records/.*\.json$')"
  [ -n "$changed" ] || return 1
  printf '%s\n' "$changed" | grep -qvE '\.(md|txt)$' && return 0
  printf '%s\n' "$changed" | grep -qE '(^|/)(CLAUDE|AGENTS)\.md$|^docs/dev-workflow\.md$' && return 0
  return 1
}

missing=0 bypassed=0 checked=0
for sha in "${commits[@]}"; do
  needs_review "$sha" || continue
  checked=$((checked+1))
  subject="$(git log -1 --format=%s "$sha")"
  record="$RECORDS_DIR/$sha.json"
  if [ ! -f "$record" ]; then
    echo "MISSING  $sha  $subject"; missing=$((missing+1)); continue
  fi
  verdict="$(jq -r '.verdict // ""' "$record" 2>/dev/null)"
  reviewer="$(jq -r '.reviewer // ""' "$record" 2>/dev/null)"
  recorded="$(jq -r '.sha // ""' "$record" 2>/dev/null)"
  if [ "$recorded" != "$sha" ]; then
    echo "MISMATCH $sha  record describes ${recorded:-nothing}"; missing=$((missing+1)); continue
  fi
  case "$verdict" in
    clean|lows-only)
      if [ -z "$reviewer" ]; then
        echo "ANON     $sha  verdict '$verdict' names no reviewer"; missing=$((missing+1))
      else
        echo "ok       $sha  $verdict (reviewer: $reviewer)"
      fi ;;
    bypass)
      echo "BYPASS   $sha  NO review happened — $subject"; bypassed=$((bypassed+1)) ;;
    *)
      echo "BLOCKED  $sha  verdict '${verdict:-none}'"; missing=$((missing+1)) ;;
  esac
done

echo
echo "review-gate-ci: $checked code commit(s) checked, $missing unreviewed, $bypassed bypassed."
if [ "$bypassed" -gt 0 ]; then
  echo "NOTE: bypass records mean the adversarial review gate is INCOMPLETE for those commits."
  echo "That must be stated on the PR, not glossed."
fi
[ "$missing" -eq 0 ] || {
  echo
  echo "Every code commit needs an independent adversarial review on record."
  echo "See CLAUDE.md 'Adversarial review gate'."
  exit 1
}
exit 0
