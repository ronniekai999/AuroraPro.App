#!/usr/bin/env bash
# Best-effort layer of the adversarial review gate. Nothing here binds, and
# neither does anything else in this repo — see CLAUDE.md's known-limits list.
# .githooks/pre-push sees pushes more reliably than this does (git resolves
# the refs and repo before calling it), but it is advisory too: core.hooksPath
# is the pusher's to unset.
#
# This hook covers only the two things a git hook structurally cannot see:
#
#   1. `git push --no-verify`, which skips pre-push hooks by design.
#   2. MCP tools that write repository CONTENT over the GitHub API without
#      ever touching a local git repo.
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
# 2. --no-verify / -n on a push skips every pre-push hook. Detection here is
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
  if printf '%s' "$norm" | tr ';&|' '\n\n\n' | awk '
      function basename(p) { sub(/^.*\//, "", p); return p }
      {
        s = $0
        gsub(/^[ \t(]+/, "", s)
        while (match(s, /^[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/)) s = substr(s, RLENGTH + 1)
        n = split(s, t, /[ \t]+/)
        while (n > 0 && (basename(t[1]) ~ /^(sudo|env|time|nohup|command|exec|doas|xargs)$/ ||
                         basename(t[1]) ~ /^(bash|sh|zsh|ksh|dash)$/)) {
          s = ""
          for (i = 2; i <= n; i++) if (t[i] !~ /^-/ || i > 2) s = s (s == "" ? "" : " ") t[i]
          gsub(/^[ \t(]+/, "", s)
          while (match(s, /^[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/)) s = substr(s, RLENGTH + 1)
          n = split(s, t, /[ \t]+/)
          if (n == 0) break
        }
        if (n > 0 && basename(t[1]) == "git") {
          hasPush = 0; hasFlag = 0
          for (i = 2; i <= n; i++) {
            if (t[i] == "push") hasPush = 1
            if (t[i] == "--no-verify") hasFlag = 1
          }
          if (hasPush && hasFlag) { print "HIT"; exit }
        }
      }' | grep -q HIT; then
    fail "review-gate: BLOCKED — --no-verify skips .githooks/pre-push, which is where the adversarial review gate is enforced.
Push without it. If no reviewer was available, record that honestly instead:
  bash scripts/record-review.sh bypass \"<why>\""
  fi
fi

exit 0
