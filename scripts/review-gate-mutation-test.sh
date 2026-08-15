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

pass=0; fail=0
# Work on a COPY of the repo, never on the tracked files. An earlier version
# mutated them in place with only an EXIT trap: kill -9 the run and the
# working tree was left holding a pre-push hook that no longer checked the
# recorded sha, one `git add -A` away from being committed.
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT INT TERM HUP
REPO="$work/repo"
mkdir -p "$REPO"
tar -C "$ROOT" -cf - \
  .githooks scripts .claude .github .gitignore CLAUDE.md AGENTS.md 2>/dev/null |
  tar -C "$REPO" -xf - 2>/dev/null
git -C "$REPO" init -q 2>/dev/null || true
SUITE="$REPO/scripts/review-gate-test.sh"
[ -f "$SUITE" ] || { echo "mutation-test: could not stage a copy of the repo"; exit 1; }

GATE_FILES='.githooks/pre-push
scripts/review-gate-ci.sh
scripts/review-gate.sh
scripts/install-git-hooks.sh
scripts/record-review.sh'
printf '%s\n' "$GATE_FILES" | while read -r f; do
  [ -n "$f" ] && cp "$REPO/$f" "$work/$(basename "$f").orig"
done
restore() {
  printf '%s\n' "$GATE_FILES" | while read -r f; do
    [ -n "$f" ] && cp "$work/$(basename "$f").orig" "$REPO/$f"
  done
}

# mutate <name> <file> <sed-expression>
mutate() {
  local name="$1" file="$2" expr="$3" before after
  before="$(md5sum "$REPO/$file" | cut -d' ' -f1)"
  sed -i "$expr" "$REPO/$file"
  after="$(md5sum "$REPO/$file" | cut -d' ' -f1)"
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

# A red baseline is FATAL, not one line in a wall of green. mutate() can only
# see that the suite went red, not why — so with a globally broken suite every
# mutation reports "caught" and the harness certifies a gate it never tested.
# That is the exact failure this file exists to prevent, one level up.
echo "Baseline: the suite must pass unmutated."
if bash "$SUITE" >/dev/null 2>&1; then
  printf '  ok   %-52s\n' "unmutated suite passes"; pass=$((pass+1))
else
  printf '  FAIL %-52s suite is red BEFORE any mutation\n' "unmutated suite passes"
  echo
  echo "Aborting: every mutation below would report a false 'caught'."
  echo "Fix the suite first — run: bash scripts/review-gate-test.sh"
  exit 1
fi

echo
echo "pre-push (advisory layer)"
mutate 'pre-push allows everything'        .githooks/pre-push          '0,/^set -uo/s/^set -uo pipefail/set -uo pipefail\nexit 0/'
mutate 'pre-push ignores the reviewer'     .githooks/pre-push          's/if \[ -z "$reviewer" \]; then/if false; then/'
mutate 'pre-push accepts a blocking verdict' .githooks/pre-push        's/      clean|lows-only)/      clean|lows-only|fix-first)/'
mutate 'pre-push ignores the recorded sha' .githooks/pre-push          's/if \[ "$recorded_sha" != "$sha" \]; then/if false; then/'
mutate 'pre-push follows renames'          .githooks/pre-push          's/git diff --no-renames --name-only "$from"/git diff --name-only "$from"/'
mutate 'pre-push fails OPEN in a bare repo' .githooks/pre-push         's#^REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"$#REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0#'
# This WAS annotated as an equivalent mutant. It is not — a later reviewer
# showed the widening is a real bypass whenever a reviewed commit precedes the
# offending one, because then the walk has somewhere to step back to and
# resolves to a commit that IS recorded. The old reasoning generalized from a
# suite case with no such predecessor, where pre-push refused for the wrong
# reason. Both sites are mutated now, and the suite carries the shape that
# distinguishes them. Documenting a mutant as equivalent tells the next
# maintainer not to write the missing case, so it has to be earned.
mutate 'pre-push widens the DOCS exemption'  .githooks/pre-push        "s#grep -v '\\^\\\\.claude/review-records/\\.\\*\\\\.json\\$'#grep -v '^\\\\.claude/'#"
mutate 'pre-push widens the WALK exemption'  .githooks/pre-push        "s#grep -qvE '\\^\\\\.claude/review-records/\\.\\*\\\\.json\\$'#grep -qvE '^\\\\.claude/'#"

echo
echo "review-gate-ci.sh (the reported check)"
mutate 'CI check always passes'            scripts/review-gate-ci.sh   '0,/^set -uo/s/^set -uo pipefail/set -uo pipefail\nexit 0/'
mutate 'CI ignores the reviewer'           scripts/review-gate-ci.sh   's/if \[ -z "$reviewer" \]; then/if false; then/'
mutate 'CI accepts a blocking verdict'     scripts/review-gate-ci.sh   's/  clean|lows-only)/  clean|lows-only|fix-first)/'
mutate 'CI ignores the recorded sha'       scripts/review-gate-ci.sh   's/if \[ "$recorded" != "$effective" \]; then/if false; then/'
mutate 'CI follows renames'                scripts/review-gate-ci.sh   's/git diff --no-renames --name-only "$merge_base"/git diff --name-only "$merge_base"/'
mutate 'CI exempts all of .claude'         scripts/review-gate-ci.sh   "s#RECORD_PATH_RE='\\^\\\\.claude/review-records/\\.\\*\\\\.json\\\$'#RECORD_PATH_RE='^\\\\.claude/'#"
mutate 'CI walks past real code commits'   scripts/review-gate-ci.sh   's/  ! printf .%s\\n. "$changed" | grep -qvE "$RECORD_PATH_RE"/  true/'
mutate 'CI exempts the agent instructions'  scripts/review-gate-ci.sh   "s#(\\^|/)(CLAUDE|AGENTS)\\\\.md\\\$|\\^docs/dev-workflow\\\\.md\\\$#^NEVERMATCH\\\$#" 

mutate 'CI accepts lows-only as clean only' scripts/review-gate-ci.sh "s/  clean|lows-only)/  clean)/"
# NOT mutation-testable: dropping the merge-base stop only changes behavior
# when the BASE branch's own tip is record-only, which no realistic history
# produces — the walk halts at the first code commit either way. The property
# (a record-only branch resolves to "nothing to check" rather than walking
# into main's history) is pinned directly by 'CI: a record-only branch'.
mutate 'CI drops the argument guard'       scripts/review-gate-ci.sh   's/^if \[ "$#" -gt 2 \]; then/if false; then/'

echo
echo "install-git-hooks.sh (never mutated before this round)"
mutate 'installer never sets hooksPath'    scripts/install-git-hooks.sh 's/  git -C "$repo_root" config --local core.hooksPath "$hooks_dir"/  true/'
mutate 'installer writes a relative path'  scripts/install-git-hooks.sh 's#^hooks_dir="$repo_root/.githooks"#hooks_dir=".githooks"#'
mutate 'installer skips chmod +x'          scripts/install-git-hooks.sh 's/^if ! chmod +x "$hooks_dir\/pre-push" 2>\/dev\/null; then/if false; then/'

mutate 'installer drops the refusal check'  scripts/install-git-hooks.sh 's/if \[ "$probe_rc" -ne 0 \] && grep -qE/if [ "$probe_rc" -ne 0 ] || grep -qE/'
mutate 'installer reads --local hooksPath'  scripts/install-git-hooks.sh '70s/config --get core.hooksPath/config --local --get core.hooksPath/'
mutate 'installer calls a dead hook active'  scripts/install-git-hooks.sh 's/^if \[ "$probe_rc" -ne 0 \] \&\& grep -qE .*$/if true; then/'
mutate 'installer skips the wiring check'   scripts/install-git-hooks.sh 's/^if \[ "$hooks_path" != "$hooks_dir" \]; then/if false; then/'
mutate 'pre-push goes quiet on a bypass'    .githooks/pre-push          's/BYPASSED for/QUIETLY ALLOWED for/'
mutate 'CI drops the bypass annotation'     scripts/review-gate-ci.sh   's/^    echo "::warning title=.*$/    true/'
mutate 'pre-push fails OPEN without jq'     .githooks/pre-push          's/^  echo "review-gate: jq is not installed/  exit 0; echo "review-gate: jq is not installed/'
mutate 'CI fails OPEN without jq'           scripts/review-gate-ci.sh   's/{ echo "review-gate-ci: jq missing"; exit 1; }/{ exit 0; }/'
mutate 'PreToolUse allows a PR merge'      scripts/review-gate.sh      's/if \[ "$hit" = "MERGE" \]; then/if false; then/'
mutate 'PreToolUse stops splitting segments' scripts/review-gate.sh     "s/tr ';&|' '\\\\n\\\\n\\\\n'/cat/"
mutate 'PreToolUse drops the commit skip'  scripts/review-gate.sh      's/if (cmd == "git" \&\& n > 1 \&\& t\[2\] == "commit") next/if (0) next/'
mutate 'PreToolUse forgets wrappers'       scripts/review-gate.sh      's/sudo|doas|env|time|timeout|nohup/sudo|doas|env|time|nohup/'
mutate 'PreToolUse mis-peels wrapper args' scripts/review-gate.sh      's/if (w ~ \/\^(timeout|flock|ionice|chrt|script)\$\/ \&\& j <= n) j++/if (0) j++/'

echo
echo "record-review.sh (never mutated before this round)"
mutate 'record always writes clean'        scripts/record-review.sh    's/^verdict="\${1:-}"; shift || true/verdict=clean; shift || true/'
mutate 'record drops the reviewer rule'    scripts/record-review.sh    '73s/if \[ -z /if [ -n /'

echo
echo "review-gate.sh (PreToolUse layer)"
mutate 'PreToolUse allows --no-verify'     scripts/review-gate.sh      's/if (hasPush \&\& hasFlag)/if (0)/'
mutate 'PreToolUse allows MCP writes'      scripts/review-gate.sh      's/^  mcp__github__push_files|/  mcp__github__NEVER|/'
mutate 'PreToolUse allows self-merge'      scripts/review-gate.sh      's/^  mcp__github__merge_pull_request|/  mcp__github__NEVERMERGE|/'

printf '\nmutations caught=%s missed=%s\n' "$pass" "$fail"
[ "$fail" = 0 ]
