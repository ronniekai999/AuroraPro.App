#!/usr/bin/env bash
# Checks that the code in a PR has an adversarial review on record.
#
# READ THIS BEFORE TRUSTING IT. This script is a convenience, not a boundary.
# It lives in the branch it inspects, and so does the workflow that runs it,
# so a branch can neuter either in one line — a reviewer did exactly that and
# got a green check beside unreviewed code. Only repository settings a human
# controls can actually bind:
#
#   - branch protection requiring the `review-record` check, AND
#   - CODEOWNERS review on `.github/**` and `scripts/review-gate*.sh`
#     (see .github/CODEOWNERS), or a ruleset pinning the workflow ref.
#
# Without both, this reports and nothing enforces. See CLAUDE.md.
#
# Usage: review-gate-ci.sh <base-ref> <head-ref>
set -uo pipefail

if [ "$#" -gt 2 ]; then
  echo "review-gate-ci: too many arguments (got $#); usage: review-gate-ci.sh <base-ref> <head-ref>" >&2
  exit 1
fi

BASE="${1:-origin/main}"
HEAD_REF="${2:-HEAD}"
RECORDS_DIR=".claude/review-records"
RECORD_PATH_RE='^\.claude/review-records/.*\.json$'

command -v jq >/dev/null 2>&1 || { echo "review-gate-ci: jq missing"; exit 1; }

merge_base="$(git merge-base "$BASE" "$HEAD_REF" 2>/dev/null)" || {
  echo "review-gate-ci: cannot find merge-base of $BASE and $HEAD_REF"; exit 1; }

head_sha="$(git rev-parse --verify "$HEAD_REF^{commit}" 2>/dev/null)" || {
  echo "review-gate-ci: cannot resolve $HEAD_REF"; exit 1; }

if [ "$merge_base" = "$head_sha" ]; then
  echo "review-gate-ci: nothing to check."
  exit 0
fi

# Does this commit change anything but review records, relative to its PARENT?
# Per-parent, NOT cumulative: a record must be committed to reach CI, which
# moves HEAD, so a cumulative test can never be satisfied — recording a review
# for A creates B whose cumulative diff still contains A's code, needing a
# record for B, and so on. That regress made this gate unsatisfiable for every
# code PR, while three files claimed it was solved.
commit_is_record_only() {
  local sha="$1" parent changed
  parent="$(git rev-parse --verify --quiet "${sha}^" 2>/dev/null)" || return 1
  [ -n "$parent" ] || return 1
  changed="$(git diff --no-renames --name-only "$parent" "$sha" 2>/dev/null)" || return 1
  [ -n "$changed" ] || return 1
  ! printf '%s\n' "$changed" | grep -qvE "$RECORD_PATH_RE"
}

# The commit a review describes: walk back over commits that only add records.
# Terminates at the merge base.
effective="$head_sha"
while [ "$effective" != "$merge_base" ] && commit_is_record_only "$effective"; do
  effective="$(git rev-parse --verify "${effective}^" 2>/dev/null)" || break
done

if [ "$effective" = "$merge_base" ]; then
  echo "review-gate-ci: only review records on this branch; nothing to check."
  exit 0
fi

# Is the reviewed state code, or only documentation? Cumulative, against the
# base — that is the diff a reviewer reads. Rename detection is OFF: with it
# on, `git diff --name-only` prints only the destination, so
# `git mv internal/db/q.go docs/q.md` reads as documentation.
changed="$(git diff --no-renames --name-only "$merge_base" "$effective" 2>/dev/null)"
changed="$(printf '%s\n' "$changed" | grep -vE "$RECORD_PATH_RE")"
if [ -z "$changed" ]; then
  echo "review-gate-ci: no code changes; nothing to check."
  exit 0
fi
if ! printf '%s\n' "$changed" | grep -qvE '\.(md|txt)$' &&
   ! printf '%s\n' "$changed" | grep -qE '(^|/)(CLAUDE|AGENTS)\.md$|^docs/dev-workflow\.md$'; then
  echo "review-gate-ci: documentation only; nothing to check."
  exit 0
fi

subject="$(git log -1 --format=%s "$effective" 2>/dev/null)"
record="$RECORDS_DIR/$effective.json"

if [ ! -f "$record" ]; then
  echo "MISSING  $effective  $subject"
  echo
  echo "The reviewed state of this branch has no adversarial review on record."
  echo "See CLAUDE.md 'Adversarial review gate'."
  exit 1
fi

verdict="$(jq -r '.verdict // ""' "$record" 2>/dev/null)"
reviewer="$(jq -r '.reviewer // ""' "$record" 2>/dev/null)"
recorded="$(jq -r '.sha // ""' "$record" 2>/dev/null)"

if [ "$recorded" != "$effective" ]; then
  echo "MISMATCH $effective  record describes ${recorded:-nothing}"
  exit 1
fi

case "$verdict" in
  clean|lows-only)
    if [ -z "$reviewer" ]; then
      echo "ANON     $effective  verdict '$verdict' names no reviewer"
      exit 1
    fi
    echo "ok       $effective  $verdict (reviewer: $reviewer)  $subject"
    exit 0 ;;
  bypass)
    echo "BYPASS   $effective  NO review happened  $subject"
    echo
    echo "The adversarial review gate is INCOMPLETE for this PR."
    echo "That must be stated on the PR, not glossed."
    exit 0 ;;
  *)
    echo "BLOCKED  $effective  verdict '${verdict:-none}'  $subject"
    exit 1 ;;
esac
