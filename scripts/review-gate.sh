#!/usr/bin/env bash
# Second layer of the adversarial review gate. The FIRST layer — and the
# actual enforcement boundary — is .githooks/pre-push, which git runs with
# the refs and shas already resolved, in the right repo, whatever the shell
# command looked like.
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
  # The pre-push hook fails closed on its own when jq is missing, so this
  # layer going quiet does not open the gate.
  echo "review-gate: jq not installed; --no-verify and MCP-write checks are inactive (pre-push hook still enforces)." >&2
  exit 0
fi

jqr() { printf '%s' "$payload" | jq -r "$1" 2>/dev/null || printf ''; }
tool_name="$(jqr '.tool_name // ""')"
command_text="$(jqr '.tool_input.command // ""')"

# ---------------------------------------------------------------------
# 1. MCP tools that write repository content over the API. These never run
#    git locally, so .githooks/pre-push cannot see them. Content has to
#    arrive through git, which is where the gate lives.
#    PR-management tools are NOT blocked: the code they reference already
#    reached the remote through git, and blocking them would make the PR
#    step of the documented workflow impossible.
# ---------------------------------------------------------------------
case "$tool_name" in
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
  # Searching or printing the flag is not using it. A missed --no-verify
  # costs a warning here (pre-push is the boundary), so this stays a short
  # list of obviously-read-only leading commands rather than real parsing.
  first="$(printf '%s' "$norm" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]].*//' -e 's#.*/##')"
  case "$first" in
    grep|rg|ag|ack|echo|printf|cat|less|more|head|tail|awk|sed|find|jq|man|comm|diff) exit 0 ;;
  esac
  # Only the long flag. `git push -n` is --dry-run, which is harmless, and
  # matching a bare -n flagged every `sed -n`, `grep -n` and `tail -n` that
  # happened to mention a push — this hook blocked its own test run that way.
  if printf '%s' "$norm" | grep -qE '(^|[^-[:alnum:]])push([^[:alnum:]]|$)' &&
     printf '%s' "$norm" | grep -q -- '--no-verify'; then
    fail "review-gate: BLOCKED — --no-verify skips .githooks/pre-push, which is where the adversarial review gate is enforced.
Push without it. If no reviewer was available, record that honestly instead:
  bash scripts/record-review.sh bypass \"<why>\""
  fi
fi

exit 0
