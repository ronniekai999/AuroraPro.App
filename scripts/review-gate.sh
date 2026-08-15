#!/usr/bin/env bash
# Best-effort layer of the adversarial review gate. Nothing here binds, and
# neither does anything else in this repo — see CLAUDE.md's known-limits list.
# .githooks/pre-push sees pushes more reliably than this does (git resolves
# the refs and repo before calling it), but it is advisory too: core.hooksPath
# is the pusher's to unset.
#
# This hook covers what a git hook structurally cannot see:
#
#   1. `git push --no-verify`, which skips pre-push hooks by design.
#   2. MCP tools that write repository CONTENT over the GitHub API without
#      ever touching a local git repo.
#   3. Merging a PR — over MCP, `gh`, or the REST endpoint — which lands code
#      on main without a push happening at all.
#
# It deliberately no longer tries to decide whether an arbitrary shell string
# is a push. Four review rounds walked through that parser — `git push;`,
# `bash -c 'echo x; git push'`, `pushd other && git push`, `sudo -i git push`,
# `timeout -k 5 60 git push`, `git -C $(pwd) push`, two pushes in one call —
# and each fix left the next shape reachable, because an allowlist of shell
# forms cannot be finished. The record check moved to where the ambiguity
# does not exist. What remains here is best-effort by construction: a missed
# `--no-verify` costs a warning, not the gate.
#
# Contract: payload on stdin; exit 0 to allow, exit 2 to block (Claude Code
# treats ONLY exit 2 as blocking).

set -uo pipefail

fail() { printf '%s\n' "$*" >&2; exit 2; }

payload="$(cat)"

if ! command -v jq >/dev/null 2>&1; then
  # pre-push also fails closed without jq, but it is advisory, so this is a
  # gap rather than a covered case. Nothing here is a boundary.
  echo "review-gate: jq not installed; --no-verify and MCP-write checks are INACTIVE." >&2
  exit 0
fi

jqr() { printf '%s' "$payload" | jq -r "$1" 2>/dev/null || printf ''; }
tool_name="$(jqr '.tool_name // ""')"
command_text="$(jqr '.tool_input.command // ""')"

# ---------------------------------------------------------------------
# 1. MCP tools that write repository content over the API. These never run
#    git locally, so .githooks/pre-push cannot see them. Content has to
#    arrive through git, which is where the gate lives.
#    Opening/updating a PR is NOT blocked: that code already reached the
#    remote through git, and blocking it would make the documented workflow
#    impossible. MERGING is blocked — the outcome the gate exists to prevent
#    is unreviewed code on main, and a self-merge produces exactly that.
# ---------------------------------------------------------------------
case "$tool_name" in
  mcp__github__merge_pull_request|mcp__github__enable_pr_auto_merge)
    fail "review-gate: BLOCKED — merging your own PR (or arming auto-merge) over the API skips the review the gate exists to require, and lands code on main with the review-record check possibly red.
A merge is a maintainer's decision, not the authoring agent's. Ask, or wait for one."
    ;;
  mcp__github__push_files|mcp__github__create_or_update_file|mcp__github__delete_file)
    fail "review-gate: BLOCKED — $tool_name writes repository content over the API, bypassing git and therefore the review gate in .githooks/pre-push.
Commit locally and push instead, so the gate can verify the commit:
  bash scripts/record-review.sh clean --reviewer <id> --findings <n> \"<summary>\"
  git push -u origin <branch>"
    ;;
esac

# ---------------------------------------------------------------------
# 2. --no-verify on a push skips every pre-push hook (NOT -n, which is
#    git's --dry-run and harmless). Detection here is
#    intentionally crude and over-eager: a false positive costs one retry
#    without the flag, and the flag has no legitimate use in this repo.
# ---------------------------------------------------------------------
if [ -n "$command_text" ]; then
  # Heredoc bodies are DATA. A commit message that discusses --no-verify is
  # not a use of it — this check blocked the very commit that introduced it.
  stripped="$(printf '%s\n' "$command_text" | awk '
    BEGIN { inhd = 0; term = "" }
    {
      if (inhd) { if ($0 ~ ("^[ \t]*" term "[ \t]*$")) inhd = 0; next }
      line = $0
      if (match(line, /<<-?[ \t]*[\x27"]?[A-Za-z_][A-Za-z0-9_]*[\x27"]?/)) {
        h = substr(line, RSTART, RLENGTH)
        sub(/^<<-?[ \t]*/, "", h); gsub(/[\x27"]/, "", h)
        term = h; inhd = 1
        sub(/<<-?[ \t]*[\x27"]?[A-Za-z_][A-Za-z0-9_]*[\x27"]?.*$/, "", line)
      }
      print line
    }')"
  norm="$(printf '%s' "$stripped" | tr -d "\"'")"
  # Fire only on a segment that IS a git push carrying the flag — not on any
  # command that happens to contain both words. Mentioning the flag is not
  # using it: this check blocked a `sed -n` probe, a `python3 -c` echo, and
  # the very commit that introduced it. Over-blocking read-only work trains
  # an agent to route around the gate, which costs more than the rare miss
  # (pre-push and CI both still see the push).
  # Anchored at the START of a segment, so `grep -rn "git push --no-verify"`
  # (whose command is grep, not git) does not match.
  # Peel leading parens, VAR=x assignments and wrappers, then require the
  # command to BE git with push among its arguments. The previous single
  # regex allowed `git -flag` but not `git -c k=v` (an option taking a
  # value), allowed `env FOO=1` but not a bare `FOO=1`, and anchored at a
  # segment start that `(` broke — so `git -c user.email=x push
  # --no-verify`, `git -C dir push --no-verify`, `VAR=x git push
  # --no-verify` and `( git push --no-verify )` all passed. Those are the
  # same shapes listed in .githooks/pre-push as having defeated the old
  # parser; repeating them here would be careless.
  # ONE anchored pass for both guarded shapes. The merge check used to be a
  # bare regex over the whole command, so searching for the literal in the
  # docs, echoing it, or naming it in a commit message were all refused — a
  # reviewer's first command of the round was, and CLAUDE.md documents the
  # literal, so an agent could not grep the very limits list it is told to
  # read. Mentioning a command is not running it, and this file argues that
  # over-blocking teaches agents to route around the gate. So: anchored on
  # the command word, with commit-message values ignored, since a message is
  # data.
  hit="$(printf '%s' "$norm" | tr ';&|' '\n\n\n' | awk '
      function basename(p) { sub(/^\\/, "", p); sub(/^.*\//, "", p); return p }
      function is_wrapper(w) {
        return (w ~ /^(sudo|doas|su|runuser|env|time|timeout|nohup|command|exec|eval|xargs|builtin|nice|ionice|chrt|taskset|flock|setsid|stdbuf|script|unshare|bash|sh|zsh|ksh|dash)$/)
      }
      # Options whose VALUE IS the command we still need to read. Skipping
      # these as if they took an unrelated value skips the command itself:
      # adding env -S to the value-taking table did exactly that, and made
      # `env -S "<merge>"` allowed. The letter is matched at the END of the
      # token so bundled forms (script -qc) are covered too.
      function value_is_command(w, opt) {
        if (w ~ /^(bash|sh|zsh|ksh|dash|script|su|runuser)$/) return (opt ~ /^-[A-Za-z]*c$/ || opt == "--command")
        if (w == "env")   return (opt ~ /^-[A-Za-z]*S$/ || opt == "--split-string")
        if (w == "flock") return (opt ~ /^-[A-Za-z]*c$/ || opt == "--command")
        return 0
      }
      # Does `opt` take a SEPARATE value for this wrapper? Short forms are
      # matched with the letter at the END, because bundling is legal and the
      # LAST letter is the one that takes the value: `sudo -iu root` is one
      # token, and anchoring on ^-u$ matched nothing — the peel then stopped
      # on `root` and treated it as the command. Long forms spelled with "="
      # carry their own value and are never listed.
      # NOTE: no value_is_command() guard here. The peel loop consults that
      # first and breaks, so this function is never reached for those options
      # — a guard here was unreachable, and an unreachable guard is exactly
      # the kind of line that reads as protection while pinning nothing.
      # The tables below must therefore not list a letter that names a
      # command-carrying option for the same wrapper.
      function takes_value(w, opt) {
        if (w == "sudo")    return (opt ~ /^-[A-Za-z]*(u|g|p|C|U|r|t|T|R|D)$/ || opt ~ /^--(user|group|prompt|close-from|other-user|role|type|chroot|chdir|command-timeout|host)$/)
        if (w == "doas")    return (opt ~ /^-[A-Za-z]*(u|C)$/)
        if (w == "su")      return (opt ~ /^-[A-Za-z]*(s|g|G)$/ || opt ~ /^--(shell|group|supp-group)$/)
        if (w == "runuser") return (opt ~ /^-[A-Za-z]*(u|s|g|G)$/ || opt ~ /^--(user|shell|group|supp-group)$/)
        if (w == "env")     return (opt ~ /^-[A-Za-z]*(u|C)$/ || opt ~ /^--(unset|chdir)$/)
        if (w == "timeout") return (opt ~ /^-[A-Za-z]*(s|k)$/ || opt ~ /^--(signal|kill-after)$/)
        if (w == "nice")    return (opt ~ /^-[A-Za-z]*(n)$/ || opt == "--adjustment")
        if (w == "ionice")  return (opt ~ /^-[A-Za-z]*(c|n|p|P|u)$/ || opt ~ /^--(class|classdata|pid|pgid|uid)$/)
        if (w == "chrt")    return (opt ~ /^-[A-Za-z]*(p|T|P)$/ || opt ~ /^--(pid|sched-runtime|sched-period|sched-deadline)$/)
        if (w == "taskset") return (opt ~ /^-[A-Za-z]*(c|p)$/ || opt ~ /^--(cpu-list|pid)$/)
        if (w == "flock")   return (opt ~ /^-[A-Za-z]*(w|E)$/ || opt ~ /^--(wait|timeout|conflict-exit-code)$/)
        if (w == "stdbuf")  return (opt ~ /^-[A-Za-z]*(i|o|e)$/ || opt ~ /^--(input|output|error)$/)
        if (w == "xargs")   return (opt ~ /^-[A-Za-z]*(I|L|n|P|s|d|E|a)$/ || opt ~ /^--(max-args|max-procs|delimiter|arg-file|replace|max-lines)$/)
        return 0
      }
      # Wrappers whose first NON-option token is their own argument, not the
      # command. ionice and script take none (`ionice [-c N] CMD`,
      # `script -c CMD FILE`), and listing them ate the command word.
      # su/runuser take an optional user; taskset an optional mask.
      function eats_positional(w) { return (w ~ /^(timeout|flock|chrt|su|runuser|taskset)$/) }
      # Options that supply the wrapper own positional argument, so it is NOT
      # also taken from the argument list. Only these replace it: the chrt
      # policy flags (-f/-r/-o/-b/-i/-a) and taskset --all-tasks take no
      # value and leave the positional in place, so keying on "any option was
      # consumed" dropped the command word instead.
      function supplies_positional(w, opt) {
        if (w == "chrt")    return (opt ~ /^-[A-Za-z]*p$/ || opt == "--pid")
        if (w == "taskset") return (opt ~ /^-[A-Za-z]*(c|p)$/ || opt ~ /^--(cpu-list|pid)$/)
        if (w ~ /^(su|runuser)$/) return (opt ~ /^-[A-Za-z]*u$/ || opt == "--user")
        return 0
      }
      {
        s = $0
        gsub(/^[ \t({]+/, "", s)
        while (match(s, /^[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/)) s = substr(s, RLENGTH + 1)
        n = split(s, t, /[ \t]+/)
        # Wrapper peel, with PER-WRAPPER option semantics. A single flat
        # table of "options that take a value" was wrong in both directions:
        # -i takes one for stdbuf and none for sudo, -n takes one for nice
        # and none for sudo, -k takes one for timeout and none for sudo. So
        # `sudo -i git push --no-verify` had its command word eaten and was
        # allowed — the exact shape this file names as a historical bypass
        # two dozen lines above. Cases written FROM an implementation cannot
        # catch that; these sets come from each wrapper option syntax as
        # documented, not from what this code happens to do.
        while (n > 0 && is_wrapper(basename(t[1]))) {
          w = basename(t[1])
          j = 2
          got_cmd = 0
          got_pos = 0
          while (j <= n && substr(t[j], 1, 1) == "-") {
            if (t[j] == "--") { j++; got_cmd = 1; break }
            if (value_is_command(w, t[j])) { j++; got_cmd = 1; break }
            if (supplies_positional(w, t[j])) got_pos = 1
            if (takes_value(w, t[j])) j++
            j++
          }
          # Only claim the positional if the command has not already started,
          # and only if no option already supplied it. "Any option was
          # consumed" was the wrong proxy: the chrt policy flags take no
          # value and leave the priority positional, so `chrt -f 1 CMD` read
          # `1` as the command.
          if (!got_cmd && !got_pos && eats_positional(w) &&
              j <= n && substr(t[j], 1, 1) != "-") j++
          if (!got_cmd)
            while (j <= n && substr(t[j], 1, 1) == "-") {
              if (t[j] == "--") { j++; break }
              if (value_is_command(w, t[j])) { j++; break }
              if (takes_value(w, t[j])) j++
              j++
            }
          s = ""
          for (i = j; i <= n; i++) s = s (s == "" ? "" : " ") t[i]
          gsub(/^[ \t({]+/, "", s)
          while (match(s, /^[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/)) s = substr(s, RLENGTH + 1)
          n = split(s, t, /[ \t]+/)
          if (n == 0) break
        }
        if (n == 0) next
        cmd = basename(t[1])
        # A commit message is data. Heredoc bodies are stripped upstream;
        # -m/-F values were not, which is how this check blocked the very
        # commit that introduced it.
        if (cmd == "git") {
          gj = 2
          while (gj <= n && substr(t[gj], 1, 1) == "-") {
            if (t[gj] ~ /^-(c|C)$/ ||
                t[gj] ~ /^--(git-dir|work-tree|namespace|exec-path|super-prefix|config-env)$/) gj++
            gj++
          }
          # A commit message is data, whatever git options precede it.
          if (gj <= n && t[gj] == "commit") next
        }
        if (cmd == "git") {
          hasPush = 0; hasFlag = 0
          for (i = 2; i <= n; i++) {
            if (t[i] == "push") hasPush = 1
            if (t[i] == "--no-verify") hasFlag = 1
          }
          if (hasPush && hasFlag) { print "NOVERIFY"; exit }
        }
        if (cmd == "gh") {
          if (n >= 3 && t[2] == "pr" && t[3] == "merge") { print "MERGE"; exit }
          if (n >= 2 && t[2] == "api")
            for (i = 3; i <= n; i++) if (t[i] ~ /pulls\/[0-9]+\/merge/) { print "MERGE"; exit }
        }
        if (cmd == "curl")
          for (i = 2; i <= n; i++) if (t[i] ~ /pulls\/[0-9]+\/merge/) { print "MERGE"; exit }
      }')"
  if [ "$hit" = "MERGE" ]; then
    fail "review-gate: BLOCKED — merging a PR from here skips the review the gate exists to require.
A merge is a maintainer's decision, not the authoring agent's. Ask, or wait for one."
  fi
  if [ "$hit" = "NOVERIFY" ]; then
    fail "review-gate: BLOCKED — --no-verify skips .githooks/pre-push, which is where the adversarial review gate is enforced.
Push without it. If no reviewer was available, record that honestly instead:
  bash scripts/record-review.sh bypass \"<why>\""
  fi
fi

exit 0
