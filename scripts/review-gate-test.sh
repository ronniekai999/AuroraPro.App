#!/usr/bin/env bash
# Test cases for scripts/review-gate.sh push detection.
#
# Run: bash scripts/review-gate-test.sh
#
# The cases live in a FILE rather than inline in a shell command on purpose:
# a case string containing a line-initial `git push` would trip the gate on
# the test command itself. That happened while writing these.
cd /home/user/AuroraPro.App || exit 1

pass=0; fail=0
check() {
  local name="$1" want="$2" cmd="$3" got
  printf '%s' "$cmd" | jq -Rs '{tool_input:{command:.}}' | bash scripts/review-gate.sh >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    printf '  ok   %-34s exit=%s\n' "$name" "$got"; pass=$((pass+1))
  else
    printf '  FAIL %-34s exit=%s want=%s\n' "$name" "$got" "$want"; fail=$((fail+1))
  fi
}

P=2  # blocked
A=0  # allowed

echo "should BLOCK (real invocations):"
check "plain"            $P 'git push -u origin feat/x'
check "chained with &&"  $P 'git add -A && git push'
check "semicolon"        $P 'echo hi; git push'
check "git -C <path>"    $P 'git -C /repo push origin main'
check "second line"      $P "$(printf 'git commit -m x\ngit push origin main')"
check "force-with-lease" $P 'git push --force-with-lease origin main'

echo "should ALLOW (mentions, not invocations):"
check "prose in heredoc" $A "$(printf 'git commit -F - <<EOF\nfails `git push` unless reviewed\nEOF')"
check "grep for string"  $A 'grep -rn "git push" docs/'
check "echo mentioning"  $A 'echo "run git push when ready"'
check "log --grep"       $A 'git log --grep=push'
check "pushd"            $A 'pushd /tmp'
check "unrelated"        $A 'ls -la'
check "empty"            $A ''

echo
echo "pass=$pass fail=$fail"
[ "$fail" = 0 ]
