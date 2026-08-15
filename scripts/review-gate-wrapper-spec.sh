#!/usr/bin/env bash
# Written BEFORE the fix, from each wrapper's actual option semantics, not
# from whatever the implementation happens to do. Three rounds running I
# wrote cases from the fix and they all passed while real shapes leaked.
cd /home/user/AuroraPro.App || exit 1
G="gh"; P="pr"; M="merge"; NV="--no-""verify"
pass=0; fail=0
run() { local want="$1" cmd="$2" rc
        printf '%s' "$cmd" | jq -Rs '{tool_name:"Bash",tool_input:{command:.}}' | bash scripts/review-gate.sh >/dev/null 2>&1
        rc=$?
        if [ "$rc" = "$want" ]; then pass=$((pass+1)); printf '  ok   %s\n' "$cmd"
        else fail=$((fail+1)); printf '  FAIL rc=%s want=%s  %s\n' "$rc" "$want" "$cmd"; fi; }

echo "== sudo: -i/-s/-n/-k/-b/-E/-H take NO value; -u/-g/-p/-C/-U/-r/-t do =="
run 2 "sudo -i git push $NV origin main"
run 2 "sudo -s git push $NV origin main"
run 2 "sudo -n git push $NV origin main"
run 2 "sudo -k git push $NV origin main"
run 2 "sudo -E git push $NV origin main"
run 2 "sudo -H git push $NV origin main"
run 2 "sudo -u root git push $NV origin main"
run 2 "sudo -g wheel git push $NV origin main"
run 2 "sudo -i $G $P $M 42"
run 2 "sudo -n $G $P $M 42"
run 2 "sudo -u root $G $P $M 42"

echo "== env: -i/-0/-v take NO value; -u does =="
run 2 "env -i git push $NV origin main"
run 2 "env -u FOO git push $NV origin main"
run 2 "env -i $G $P $M 42"
run 2 "env -u FOO $G $P $M 42"

echo "== timeout: DURATION positional; -s/-k/--signal/--kill-after take values =="
run 2 "timeout 60 git push $NV origin main"
run 2 "timeout -k 5 60 git push $NV origin main"
run 2 "timeout --kill-after 5 60 git push $NV origin main"
run 2 "timeout -s TERM 60 git push $NV origin main"
run 2 "timeout --signal=TERM 60 $G $P $M 42"
run 2 "timeout --kill-after 5 60 $G $P $M 42"
run 2 "timeout 60 $G $P $M 42"

echo "== ionice: -c/-n/-p take values; NO positional command arg =="
run 2 "ionice $G $P $M 42"
run 2 "ionice -c 3 $G $P $M 42"
run 2 "ionice -c3 $G $P $M 42"
run 2 "ionice -c 2 -n 7 git push $NV origin main"

echo "== nice: -n takes a value, no positional =="
run 2 "nice -n 5 $G $P $M 42"
run 2 "nice git push $NV origin main"

echo "== flock: FILE positional; -w/-E take values =="
run 2 "flock /tmp/l $G $P $M 42"
run 2 "flock -w 5 /tmp/l $G $P $M 42"
run 2 "flock -w 5 /tmp/l git push $NV origin main"

echo "== script: -c's VALUE is the command; no positional command =="
run 2 "script -qc \"$G $P $M 42\" /dev/null"
run 2 "script -c \"git push $NV origin main\" /dev/null"

echo "== stdbuf/setsid/chrt =="
run 2 "stdbuf -o0 $G $P $M 42"
run 2 "stdbuf -o 0 $G $P $M 42"
run 2 "setsid $G $P $M 42"
run 2 "chrt 1 $G $P $M 42"

echo "== absolute paths and nesting =="
run 2 "/usr/bin/timeout 60 /usr/bin/$G $P $M 42"
run 2 "sudo -i timeout 60 $G $P $M 42"
run 2 "env -i bash -c \"$G $P $M 42\""

echo "== MUST NOT BLOCK: ordinary wrapped work =="
run 0 "timeout 60 npm run build"
run 0 "timeout --kill-after 5 60 go test ./..."
run 0 "nice -n 5 go test ./..."
run 0 "ionice -c 3 make build"
run 0 "flock -w 5 /tmp/l make build"
run 0 "sudo -u postgres psql -c \"select 1\""
run 0 "sudo -i systemctl status aurora"
run 0 "env -i PATH=/usr/bin make"
run 0 "stdbuf -o0 go test ./..."
run 0 "script -qc \"npm test\" /dev/null"

echo "== MUST NOT BLOCK: mentioning, and git's own options =="
run 0 "git commit -m \"gate: block git push $NV\""
run 0 "git -C . commit -m \"gate: block git push $NV\""
run 0 "git -c user.email=x commit -m \"block git push $NV\""
run 0 "grep -rn \"$G $P $M\" CLAUDE.md"
run 0 "echo \"never run $G $P $M yourself\""
run 0 "git merge origin/main"
run 0 "$G $P create --fill"

printf '\nspec: pass=%s fail=%s\n' "$pass" "$fail"
[ "$fail" = 0 ]
