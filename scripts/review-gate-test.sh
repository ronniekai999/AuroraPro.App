#!/usr/bin/env bash
# Tests for scripts/review-gate.sh.
#
#   bash scripts/review-gate-test.sh
#
# Every case runs against a SYNTHETIC repo built in a temp dir, never the
# working checkout. The first version of this suite invoked the gate in the
# live repo, so its "should block" cases passed only while HEAD happened to
# lack a clean record — they would have flipped to failing in exactly the
# state a developer is in when running the suite before pushing. It also
# hardcoded one machine's path and so could not run in a clone or in CI.
#
# Cases assert exit codes AND, where the distinction matters, the reason —
# because "allowed" alone cannot tell "not a push" from "a record exists"
# from "the gate silently broke".

set -uo pipefail

GATE="$(cd "$(dirname "$0")" && pwd)/review-gate.sh"
RECORD="$(cd "$(dirname "$0")" && pwd)/record-review.sh"
[ -f "$GATE" ] || { echo "cannot find review-gate.sh next to this test"; exit 1; }

pass=0; fail=0
section() { printf '\n%s\n' "$1"; }

# run <repo> <payload-json> -> sets RC and OUT
run() {
  OUT="$(cd "$1" && printf '%s' "$2" | bash "$GATE" 2>&1)"
  RC=$?
}
bash_payload() { printf '%s' "$1" | jq -Rs '{tool_name:"Bash", tool_input:{command:.}}'; }

check() { # name want_rc repo payload [want_substring]
  local name="$1" want="$2" repo="$3" payload="$4" want_sub="${5:-}"
  run "$repo" "$payload"
  if [ "$RC" != "$want" ]; then
    printf '  FAIL %-42s exit=%s want=%s\n' "$name" "$RC" "$want"; fail=$((fail+1)); return
  fi
  if [ -n "$want_sub" ] && ! printf '%s' "$OUT" | grep -qF "$want_sub"; then
    printf '  FAIL %-42s exit ok but reason missing: %s\n' "$name" "$want_sub"; fail=$((fail+1)); return
  fi
  printf '  ok   %-42s exit=%s\n' "$name" "$RC"; pass=$((pass+1))
}
cmd() { check "$1" "$2" "$3" "$(bash_payload "$4")" "${5:-}"; }

# --- synthetic repo ---------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
git init -q -b main "$REPO"
git -C "$REPO" config user.email t@t; git -C "$REPO" config user.name t
mkdir -p "$REPO/src"
echo "base" > "$REPO/src/a.go"
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
git -C "$REPO" update-ref refs/remotes/origin/main HEAD   # base == origin/main
echo "code" >> "$REPO/src/a.go"
git -C "$REPO" commit -qam "change code"
CODE_SHA="$(git -C "$REPO" rev-parse HEAD)"

section "detects a push through ordinary shell punctuation (all must BLOCK)"
for c in 'git push -u origin main' 'git push;' 'echo a; git push;' 'git push&&echo done' \
         'git push|cat' 'git push&' '(git push)' 'if true; then git push; fi' \
         'for i in 1; do git push; done' 'git push --tags' 'cd /tmp && git push'; do
  cmd "$c" 2 "$REPO" "$c" "no independent adversarial review"
done

section "detects a push reached indirectly (all must BLOCK)"
cmd 'git -c user.email=x push'  2 "$REPO" 'git -c user.email=x push origin main'
cmd 'git -c a=b -C . push'      2 "$REPO" 'git -c a=b -C . push'
cmd 'git --no-pager push'       2 "$REPO" 'git --no-pager push'
cmd 'env FOO=1 git push'        2 "$REPO" 'env FOO=1 git push'
cmd 'VAR=off git push'          2 "$REPO" 'AURORA_REVIEW_GATE=off git push origin main'
cmd 'time git push'             2 "$REPO" 'time git push'
cmd '/usr/bin/git push'         2 "$REPO" '/usr/bin/git push'
cmd 'bash -c "git push"'        2 "$REPO" 'bash -c "git push"'
cmd 'xargs git push'            2 "$REPO" 'echo x | xargs -I{} git push'
cmd 'gh pr create'              2 "$REPO" 'gh pr create --fill'
cmd 'gh pr merge'               2 "$REPO" 'gh pr merge 12 --squash'

section "non-Bash publish tools (must BLOCK)"
check 'mcp github push_files'      2 "$REPO" '{"tool_name":"mcp__github__push_files","tool_input":{}}'
check 'mcp github create_pr'       2 "$REPO" '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}'
check 'mcp github create_or_update' 2 "$REPO" '{"tool_name":"mcp__github__create_or_update_file","tool_input":{}}'

section "mentions rather than invocations (all must ALLOW)"
cmd 'grep for the string'  0 "$REPO" 'grep -rn "git push" docs/'
cmd 'echo mentioning'      0 "$REPO" 'echo "run git push when ready"'
cmd 'commit -m mentioning' 0 "$REPO" 'git commit -m "document git push flow"'
cmd 'log --grep=push'      0 "$REPO" 'git log --grep=push'
cmd 'pushd'                0 "$REPO" 'pushd /tmp'
cmd 'unrelated'            0 "$REPO" 'ls -la'
cmd 'empty'                0 "$REPO" ''
cmd 'heredoc prose'        0 "$REPO" "$(printf 'git commit -F - <<EOF\nfails `git push` unless reviewed\nEOF')"

section "chained commit+push cannot be verified (must BLOCK with advice)"
cmd 'add && commit && push' 2 "$REPO" 'git add -A && git commit -m wip && git push origin main' \
    "both moves HEAD and pushes"
cmd 'rebase && push'        2 "$REPO" 'git rebase main && git push' "separate calls"

section "unverifiable ref sets (must BLOCK)"
cmd 'push --all'    2 "$REPO" 'git push --all origin' "unknown set of refs"
cmd 'push --mirror' 2 "$REPO" 'git push --mirror origin' "unknown set of refs"

section "verdict handling"
( cd "$REPO" && bash "$RECORD" clean --reviewer test --findings 0 "synthetic" >/dev/null )
cmd 'clean record allows'    0 "$REPO" 'git push origin main'
( cd "$REPO" && bash "$RECORD" lows-only "synthetic" >/dev/null )
cmd 'lows-only allows'       0 "$REPO" 'git push origin main'
( cd "$REPO" && bash "$RECORD" fix-first "synthetic" >/dev/null )
cmd 'fix-first still blocks' 2 "$REPO" 'git push origin main' 'verdict "fix-first"'
( cd "$REPO" && bash "$RECORD" bypass "no reviewer available" >/dev/null )
cmd 'bypass allows, loudly'  0 "$REPO" 'git push origin main' 'INCOMPLETE'

echo '{"verdict":"clean"}' > "$REPO/.claude/review-records/$CODE_SHA.json"
cmd 'record missing its sha blocks' 2 "$REPO" 'git push origin main' 'describes nothing'
echo '{"sha":"deadbeef","verdict":"clean"}' > "$REPO/.claude/review-records/$CODE_SHA.json"
cmd 'record for another sha blocks' 2 "$REPO" 'git push origin main' 'not '"$CODE_SHA"
echo 'not json' > "$REPO/.claude/review-records/$CODE_SHA.json"
cmd 'corrupt record blocks'         2 "$REPO" 'git push origin main'
rm -f "$REPO/.claude/review-records/$CODE_SHA.json"

section "the gate follows the ref being pushed, not the checkout"
git -C "$REPO" checkout -q -b feat/x
echo "more" >> "$REPO/src/a.go"
git -C "$REPO" commit -qam "feature work"
git -C "$REPO" checkout -q main
git -C "$REPO" reset -q --hard refs/remotes/origin/main   # HEAD is now clean vs origin
cmd 'pushing another branch is checked' 2 "$REPO" 'git push origin feat/x'
cmd 'refspec form is checked'           2 "$REPO" 'git push origin feat/x:refs/heads/feat/x'
git -C "$REPO" checkout -q feat/x

section "docs-only exemption"
DOCS="$TMP/docs"; git init -q -b main "$DOCS"
git -C "$DOCS" config user.email t@t; git -C "$DOCS" config user.name t
echo x > "$DOCS/README.md"; git -C "$DOCS" add -A; git -C "$DOCS" commit -qm base
git -C "$DOCS" update-ref refs/remotes/origin/main HEAD
echo more >> "$DOCS/README.md"; git -C "$DOCS" commit -qam docs
cmd 'markdown-only push allowed' 0 "$DOCS" 'git push origin main'
mkdir -p "$DOCS/docs"; echo 'server {}' > "$DOCS/docs/nginx.conf"
git -C "$DOCS" add -A; git -C "$DOCS" commit -qm conf
cmd 'config under docs/ is NOT exempt' 2 "$DOCS" 'git push origin main'
git -C "$DOCS" reset -q --hard HEAD~1
echo 'rule' >> "$DOCS/CLAUDE.md"; git -C "$DOCS" add -A; git -C "$DOCS" commit -qm rules
cmd 'CLAUDE.md is NOT exempt'          2 "$DOCS" 'git push origin main'
git -C "$DOCS" reset -q --hard HEAD~1
echo 'code' > "$DOCS/x.go"; git -C "$DOCS" add -A; git -C "$DOCS" commit -qm ride
cmd 'code riding along with docs'      2 "$DOCS" 'git push origin main'

section "fail-closed states"
NOBASE="$TMP/nobase"; git init -q -b main "$NOBASE"
git -C "$NOBASE" config user.email t@t; git -C "$NOBASE" config user.name t
echo c > "$NOBASE/a.go"; git -C "$NOBASE" add -A; git -C "$NOBASE" commit -qm base
cmd 'no origin/main still blocks' 2 "$NOBASE" 'git push origin main'
cmd 'outside a git repo blocks'   2 "$TMP"    'git push origin main' 'not a git working tree'

printf '\npass=%s fail=%s\n' "$pass" "$fail"
[ "$fail" = 0 ]
