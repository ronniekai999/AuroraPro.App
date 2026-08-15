#!/usr/bin/env bash
# Applies known-bad patches to the review gate and asserts the test suite
# NOTICES each one.
#
#   bash scripts/review-gate-mutation-test.sh
#
# This exists because "the suite passes" told us nothing for five review
# rounds. Twice the suite was green against a gate that was actually broken:
# once because its blocking cases only passed while the checkout happened to
# lack a review record, and once because four decision branches in the CI
# check had no coverage at all — an anonymous verdict, a fix-first verdict, a
# mismatched sha, and a widened path exemption all passed unnoticed. A suite
# that cannot fail is worse than no suite, because it is quoted as evidence.
#
# Every mutation below corresponds to a real defect a reviewer demonstrated.
# Adding a gate behavior means adding a mutation for it here.

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUITE="$ROOT/scripts/review-gate-test.sh"

pass=0; fail=0
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
cp "$ROOT/.githooks/pre-push" "$work/pre-push.orig"
cp "$ROOT/scripts/review-gate-ci.sh" "$work/ci.orig"
cp "$ROOT/scripts/review-gate.sh" "$work/gate.orig"

restore() {
  cp "$work/pre-push.orig" "$ROOT/.githooks/pre-push"
  cp "$work/ci.orig" "$ROOT/scripts/review-gate-ci.sh"
  cp "$work/gate.orig" "$ROOT/scripts/review-gate.sh"
}
trap 'restore; rm -rf "$work"' EXIT

# mutate <name> <file> <sed-expression>
mutate() {
  local name="$1" file="$2" expr="$3" before after
  before="$(md5sum "$ROOT/$file" | cut -d' ' -f1)"
  sed -i "$expr" "$ROOT/$file"
  after="$(md5sum "$ROOT/$file" | cut -d' ' -f1)"
  if [ "$before" = "$after" ]; then
    printf '  SKIP %-52s mutation did not apply (pattern drifted)\n' "$name"
    fail=$((fail+1)); restore; return
  fi
  if bash "$SUITE" >/dev/null 2>&1; then
    printf '  FAIL %-52s suite still GREEN against a broken gate\n' "$name"
    fail=$((fail+1))
  else
    printf '  ok   %-52s suite went red\n' "$name"
    pass=$((pass+1))
  fi
  restore
}

echo "Baseline: the suite must pass unmutated."
if bash "$SUITE" >/dev/null 2>&1; then
  printf '  ok   %-52s\n' "unmutated suite passes"; pass=$((pass+1))
else
  printf '  FAIL %-52s suite is red before any mutation\n' "unmutated suite passes"
  fail=$((fail+1))
fi

echo
echo "pre-push (advisory layer)"
mutate 'pre-push allows everything'        .githooks/pre-push          '0,/^set -uo/s/^set -uo pipefail/set -uo pipefail\nexit 0/'
mutate 'pre-push ignores the reviewer'     .githooks/pre-push          's/if \[ -z "$reviewer" \]; then/if false; then/'
mutate 'pre-push accepts a blocking verdict' .githooks/pre-push        's/      clean|lows-only)/      clean|lows-only|fix-first)/'
mutate 'pre-push ignores the recorded sha' .githooks/pre-push          's/if \[ "$recorded_sha" != "$sha" \]; then/if false; then/'
mutate 'pre-push follows renames'          .githooks/pre-push          's/git diff --no-renames --name-only "$from"/git diff --name-only "$from"/'
# NOT mutation-testable on this layer: widening the record exemption to all of
# .claude/ makes the record-walk step PAST the offending commit to the base,
# which has no record either, so pre-push still refuses — for the wrong
# reason. The mutant is equivalent here. The CI-side version of the same
# widening is caught ('CI exempts all of .claude' below), and that is the
# layer the outcome depends on. The suite pins the behavior directly via
# 'pre-push: .claude/settings.json is NOT exempt'.

echo
echo "review-gate-ci.sh (the reported check)"
mutate 'CI check always passes'            scripts/review-gate-ci.sh   '0,/^set -uo/s/^set -uo pipefail/set -uo pipefail\nexit 0/'
mutate 'CI ignores the reviewer'           scripts/review-gate-ci.sh   's/if \[ -z "$reviewer" \]; then/if false; then/'
mutate 'CI accepts a blocking verdict'     scripts/review-gate-ci.sh   's/  clean|lows-only)/  clean|lows-only|fix-first)/'
mutate 'CI ignores the recorded sha'       scripts/review-gate-ci.sh   's/if \[ "$recorded" != "$effective" \]; then/if false; then/'
mutate 'CI follows renames'                scripts/review-gate-ci.sh   's/git diff --no-renames --name-only "$merge_base"/git diff --name-only "$merge_base"/'
mutate 'CI exempts all of .claude'         scripts/review-gate-ci.sh   "s#RECORD_PATH_RE='\\^\\\\.claude/review-records/\\.\\*\\\\.json\\\$'#RECORD_PATH_RE='^\\\\.claude/'#"
mutate 'CI walks past real code commits'   scripts/review-gate-ci.sh   's/  ! printf .%s\\n. "$changed" | grep -qvE "$RECORD_PATH_RE"/  true/'

echo
echo "review-gate.sh (PreToolUse layer)"
mutate 'PreToolUse allows --no-verify'     scripts/review-gate.sh      's/^  if printf/  if false \&\& printf/'
mutate 'PreToolUse allows MCP writes'      scripts/review-gate.sh      's/^  mcp__github__push_files|/  mcp__github__NEVER|/'

printf '\nmutations caught=%s missed=%s\n' "$pass" "$fail"
[ "$fail" = 0 ]
