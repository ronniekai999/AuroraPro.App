#!/usr/bin/env bash
# Wrapper-shape spec for the PreToolUse layer in scripts/review-gate.sh.
#
#   bash scripts/review-gate-wrapper-spec.sh
#
# Shapes are derived from each wrapper's documented option syntax, NOT from
# the implementation. That distinction is the whole point of this file: for
# three rounds the cases were written from whatever the fix had just changed,
# so they passed while real shapes leaked — `sudo -i git push --no-verify`
# went unblocked for a full round, and it is the shape the gate's own header
# names as its motivating bypass.
#
# Two classes are easy to get wrong and are called out explicitly below:
#
#   - BUNDLED short options. `sudo -iu root CMD` is one token whose LAST
#     letter decides whether a value follows. Anchoring on `^-u$` matches
#     nothing here, the peel stops at `root`, and `root` becomes the apparent
#     command.
#   - Options whose VALUE IS the command: a shell's `-c`, `env -S`,
#     `flock -c`, `su -c`. Skipping those as if they took an unrelated value
#     skips the command itself.
#
# This runs in CI. It is not a substitute for review-gate-test.sh — the same
# shapes are pinned there as a matrix — it is the place where the reasoning
# behind them stays readable.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/scripts/review-gate.sh"
[ -f "$GATE" ] || { echo "cannot find scripts/review-gate.sh"; exit 1; }

# Assembled so that grepping or editing this file is not itself refused.
G="gh"; P="pr"; M="merge"; NV="--no-""verify"
pass=0; fail=0
run() {
  local want="$1" cmd="$2" rc
  printf '%s' "$cmd" | jq -Rs '{tool_name:"Bash",tool_input:{command:.}}' | bash "$GATE" >/dev/null 2>&1
  rc=$?
  if [ "$rc" = "$want" ]; then pass=$((pass+1)); printf '  ok   %s\n' "$cmd"
  else fail=$((fail+1)); printf '  FAIL rc=%s want=%s  %s\n' "$rc" "$want" "$cmd"; fi
}
both() { run "$1" "$2 $G $P $M 42"; run "$1" "$2 git push $NV origin main"; }

echo "== sudo: -i/-s/-n/-k/-b/-E/-H take no value; -u/-g/-p/-C/-U/-r/-t/-R do =="
for w in "sudo -i" "sudo -s" "sudo -n" "sudo -k" "sudo -E" "sudo -H" \
         "sudo -u root" "sudo -g wheel" "sudo -C 3" "sudo -T 5"; do both 2 "$w"; done

echo "== sudo: BUNDLED short options, value taken by the LAST letter =="
for w in "sudo -iu root" "sudo -nu root" "sudo -Eu root" "sudo -bg wheel" \
         "sudo -in" "sudo -Hi"; do both 2 "$w"; done

echo "== env: -i/-0/-v take no value; -u/-C do; -S's value IS the command =="
for w in "env -i" "env -u FOO" "env -C /tmp" "env -iu FOO" "env -0"; do both 2 "$w"; done
run 2 "env -S \"$G $P $M 42\""
run 2 "env -S \"git push $NV origin main\""
run 2 "env --split-string \"$G $P $M 42\""

echo "== timeout: DURATION positional; -s/-k and long forms take values =="
for w in "timeout 60" "timeout -k 5 60" "timeout --kill-after 5 60" \
         "timeout -s TERM 60" "timeout --signal=TERM 60" "timeout -k5 60" \
         "timeout --foreground 60"; do both 2 "$w"; done

echo "== nice / ionice / chrt / stdbuf / taskset =="
for w in "nice" "nice -n 5" "nice -5" "nice --adjustment 5" \
         "ionice" "ionice -c 3" "ionice -c3" "ionice -c 2 -n 7" \
         "chrt 1" "chrt -p 1" \
         "stdbuf -o0" "stdbuf -o 0" "stdbuf -oL -eL" \
         "taskset -c 0" "taskset 0x1"; do both 2 "$w"; done

echo "== flock: FILE positional, and -c AFTER it whose value is the command =="
for w in "flock /tmp/l" "flock -w 5 /tmp/l" "flock --wait 5 /tmp/l" \
         "flock -E 9 /tmp/l"; do both 2 "$w"; done
run 2 "flock /tmp/l -c \"$G $P $M 42\""
run 2 "flock /tmp/l --command \"$G $P $M 42\""
run 2 "flock -w 5 /tmp/l -c \"git push $NV origin main\""

echo "== shells, script, su, runuser: -c's value is the command =="
run 2 "bash -c \"$G $P $M 42\""
run 2 "sh -c \"git push $NV origin main\""
run 2 "script -qc \"$G $P $M 42\" /dev/null"
run 2 "script -c \"git push $NV origin main\" /dev/null"
run 2 "su -c \"$G $P $M 42\""
run 2 "su root -c \"$G $P $M 42\""
run 2 "runuser -u root -- $G $P $M 42"

echo "== misc wrappers and escapes =="
for w in "setsid" "nohup" "eval" "unshare -r" "command" "exec" \
         "/usr/bin/timeout 60" "sudo -i timeout 60"; do both 2 "$w"; done
run 2 "env -i bash -c \"$G $P $M 42\""
run 2 "{ $G $P $M 42; }"
run 2 "( $G $P $M 42 )"
run 2 "echo hi; $G $P $M 42"
run 2 "make build && git push $NV origin main"

echo "== MUST NOT BLOCK: the same wrappers around ordinary work =="
run 0 "timeout 60 npm run build"
run 0 "timeout --kill-after 5 60 go test ./..."
run 0 "nice -n 5 go test ./..."
run 0 "ionice -c 3 make build"
run 0 "flock -w 5 /tmp/l make build"
run 0 "flock /tmp/l -c \"make build\""
run 0 "sudo -u postgres psql -c \"select 1\""
run 0 "sudo -iu postgres psql -c \"select 1\""
run 0 "sudo -i systemctl status aurora"
run 0 "env -i PATH=/usr/bin make"
run 0 "env -S \"make build\""
run 0 "stdbuf -o0 go test ./..."
run 0 "script -qc \"npm test\" /dev/null"
run 0 "su -c \"systemctl status aurora\""
run 0 "taskset -c 0 go test ./..."

echo "== MUST NOT BLOCK: mentioning it, and git's own options =="
run 0 "git commit -m \"gate: block git push $NV\""
run 0 "git -C . commit -m \"gate: block git push $NV\""
run 0 "git -c user.email=x commit -m \"block git push $NV\""
run 0 "git --git-dir .git commit -m \"block git push $NV\""
run 0 "git --git-dir=.git commit -m \"block git push $NV\""
run 0 "git --work-tree . commit -m \"block git push $NV\""
run 0 "grep -rn \"$G $P $M\" CLAUDE.md"
run 0 "echo \"never run $G $P $M yourself\""
run 0 "git merge origin/main"
run 0 "git log --grep=merge"
run 0 "$G $P create --fill"
run 0 "$G $P view 42"

printf '\nwrapper spec: pass=%s fail=%s\n' "$pass" "$fail"
[ "$fail" = 0 ]
