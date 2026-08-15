#!/usr/bin/env bash
# Blocks pushes until the commit being pushed has an independent adversarial
# review on record. Wired as a PreToolUse hook in .claude/settings.json.
#
# Why a hook and not a line in CLAUDE.md: the review gate was written down
# three times — AGENTS.md, docs/dev-workflow.md, and a pointer in CLAUDE.md —
# and was still skipped on PR #487, because only CLAUDE.md is auto-loaded
# into an agent's context and its mention was a parenthetical. Prose can be
# missed. The harness runs this whether or not anything was read.
#
# Contract: reads the hook payload on stdin, exits 0 to allow, exits 2 to
# block with the stderr text fed back to the agent. Claude Code treats ONLY
# exit 2 as blocking — every other nonzero is a non-blocking error — so once
# this script has decided a call is a push, every subsequent failure path
# must end at exit 2, never at exit 1 or an unguarded command.
#
# Detection is deliberately over-eager. v1 pattern-matched the substring
# "git push" and was picked apart: a trailing semicolon, a spaceless `&&`,
# `git -c user.email=… push`, `env FOO=1 git push`, `bash -c "git push"`,
# and `AURORA_REVIEW_GATE=off git push` all sailed through, the last one
# silently. Those are not evasion techniques, they are how shell gets typed.
# So the command is now normalized (heredoc bodies dropped, quote characters
# removed, shell punctuation turned into segment breaks, wrappers and env
# assignments peeled off) and each segment is examined for git-as-the-command
# with push-as-the-subcommand.

set -uo pipefail

fail() { printf '%s\n' "$*" >&2; exit 2; }

payload="$(cat)"

# ---------------------------------------------------------------------
# jq is a hard dependency. v1 swallowed its absence (`2>/dev/null`, no
# `set -e`), leaving command_text empty so every push was allowed with no
# output at all. Degrade to a crude raw-text check instead of going quiet:
# still usable on a box without jq, still closed for anything push-shaped.
# ---------------------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  if printf '%s' "$payload" | grep -qE 'push|pull_request'; then
    fail "review-gate: jq is not installed, so this call cannot be inspected — and it mentions a push. Failing closed. Install jq to restore the gate."
  fi
  echo "review-gate: jq not installed; the review gate is NOT enforcing anything on this machine." >&2
  exit 0
fi

tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // ""' 2>/dev/null)" || tool_name=""
command_text="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null)" || command_text=""

# ---------------------------------------------------------------------
# Non-Bash publish paths. An agent blocked at `git push` and casting about
# for the next thing to try lands on these immediately — they are live tools
# in this environment and they push without ever touching a shell.
# ---------------------------------------------------------------------
case "$tool_name" in
  mcp__github__push_files|mcp__github__create_pull_request|mcp__github__create_or_update_file|\
  mcp__github__merge_pull_request|mcp__github__update_pull_request|mcp__github__create_branch)
    is_push=1
    push_args=""
    head_moves=0
    ;;
  *)
    is_push=0
    ;;
esac

# ---------------------------------------------------------------------
# Command analysis
# ---------------------------------------------------------------------
if [ "$is_push" = 0 ] && [ -n "$command_text" ]; then
  analysis="$(printf '%s\n' "$command_text" | awk '
    function basename(p) { sub(/^.*\//, "", p); return p }
    function is_wrapper(t) {
      return (t == "env" || t == "time" || t == "sudo" || t == "nohup" || t == "command" ||
              t == "exec" || t == "xargs" || t == "builtin" || t == "bash" || t == "sh" ||
              t == "zsh" || t == "ksh" || t == "dash" || t == "then" || t == "do" ||
              t == "else" || t == "elif" || t == "if" || t == "while" || t == "until" || t == "!")
    }
    # git global options that consume the FOLLOWING token as their value.
    function takes_value(t) {
      return (t == "-c" || t == "-C" || t == "--git-dir" || t == "--work-tree" ||
              t == "--exec-path" || t == "--namespace" || t == "--config-env")
    }
    BEGIN { inheredoc = 0; term = "" }
    {
      line = $0
      # Heredoc BODIES are data, not commands. Dropping them is what keeps a
      # commit message that discusses pushing from tripping the gate — the
      # false positive that blocked the commit which introduced this file.
      if (inheredoc) {
        if (line ~ ("^[ \t]*" term "[ \t]*$")) inheredoc = 0
        next
      }
      if (match(line, /<<-?[ \t]*[\x27"]?[A-Za-z_][A-Za-z0-9_]*[\x27"]?/)) {
        h = substr(line, RSTART, RLENGTH)
        sub(/^<<-?[ \t]*/, "", h); gsub(/[\x27"]/, "", h)
        term = h; inheredoc = 1
        sub(/<<-?[ \t]*[\x27"]?[A-Za-z_][A-Za-z0-9_]*[\x27"]?.*$/, "", line)
      }
      buf = buf line "\n"
    }
    END {
      # Quote CHARACTERS go, contents stay: dropping the contents would hide
      # `bash -c "git push"`, while keeping the quotes would leave the shell
      # splitting wrong. Contents are safe to keep because a match still
      # requires git to be the command at a segment boundary, so prose like
      # `echo "git push later"` stays inert (its command is echo).
      gsub(/[\x27"]/, "", buf)
      gsub(/[;&|()`{}]/, "\n", buf)
      n = split(buf, seg, "\n")
      for (i = 1; i <= n; i++) {
        s = seg[i]
        gsub(/^[ \t]+|[ \t]+$/, "", s)
        if (s == "") continue
        # Peel leading VAR=value assignments (env FOO=1 git push, and the
        # `AURORA_REVIEW_GATE=off git push` form that v1 let through silently).
        while (match(s, /^[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/)) s = substr(s, RLENGTH + 1)
        # Peel wrappers and their options: bash -c …, xargs -I{} …, time …
        changed = 1
        while (changed) {
          changed = 0
          ntok = split(s, tk, /[ \t]+/)
          if (ntok >= 1 && is_wrapper(basename(tk[1]))) {
            j = 2
            while (j <= ntok && substr(tk[j], 1, 1) == "-") j++
            rest = ""
            for (k = j; k <= ntok; k++) rest = rest (rest == "" ? "" : " ") tk[k]
            s = rest; changed = 1
            while (match(s, /^[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/)) s = substr(s, RLENGTH + 1)
          }
        }
        ntok = split(s, tk, /[ \t]+/)
        if (ntok == 0) continue
        cmd = basename(tk[1])
        if (cmd == "git") {
          j = 2
          while (j <= ntok && substr(tk[j], 1, 1) == "-") { if (takes_value(tk[j])) j++; j++ }
          sub_ = (j <= ntok ? tk[j] : "")
          if (sub_ == "push") {
            args = ""
            for (k = j + 1; k <= ntok; k++) args = args (args == "" ? "" : " ") tk[k]
            print "PUSH\t" args
          } else if (sub_ == "commit" || sub_ == "merge" || sub_ == "rebase" || sub_ == "reset" ||
                     sub_ == "cherry-pick" || sub_ == "revert" || sub_ == "am" || sub_ == "pull" ||
                     sub_ == "checkout" || sub_ == "switch" || sub_ == "stash" || sub_ == "apply") {
            print "HEADMOVE\t" sub_
          }
        } else if (cmd == "gh" && ntok >= 3) {
          if ((tk[2] == "pr" && (tk[3] == "create" || tk[3] == "merge")) ||
              (tk[2] == "release" && tk[3] == "create")) print "PUSH\t"
        }
      }
    }
  ')" || fail "review-gate: failed to analyze the command. Failing closed."

  if printf '%s' "$analysis" | grep -q '^PUSH'; then
    is_push=1
    push_args="$(printf '%s' "$analysis" | grep '^PUSH' | head -1 | cut -f2-)"
    head_moves=$(printf '%s' "$analysis" | grep -c '^HEADMOVE' || true)
  fi
fi

[ "$is_push" = 1 ] || exit 0

# =====================================================================
# Everything below runs ONLY for a push, and every exit is 2 (blocking).
# =====================================================================

# A PreToolUse hook runs BEFORE the command. If the same call creates the
# commit and pushes it, the sha we can see is the PRE-commit one, and a
# record for it says nothing about what actually lands on the remote —
# v1 allowed exactly this. We cannot review a commit that does not exist
# yet, so refuse to guess and make the agent split the call.
if [ "${head_moves:-0}" -gt 0 ]; then
  fail "review-gate: BLOCKED — this call both moves HEAD and pushes.
A PreToolUse hook runs before the command, so the sha available here is the
one BEFORE your commit/merge/rebase — reviewing it would say nothing about
what reaches the remote.
Run them as separate calls: commit first, then review, then push."
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  fail "review-gate: BLOCKED — a push was requested but this is not a git working tree, so the gate cannot verify it."
RECORDS_DIR="$REPO_ROOT/.claude/review-records"

case " $push_args " in
  *" --all "*|*" --mirror "*)
    fail "review-gate: BLOCKED — --all/--mirror pushes an unknown set of refs, which the gate cannot verify one commit at a time. Push a single branch."
    ;;
esac

# Resolve WHAT is being pushed. v1 always checked HEAD, so standing on an
# up-to-date main and running `git push origin feat/x` sailed through: the
# gate reasoned about the working checkout while the command reasoned about
# refs.
target_ref="HEAD"
remote_seen=""
skip_next=0
for a in $push_args; do
  if [ "$skip_next" = 1 ]; then skip_next=0; continue; fi
  case "$a" in
    -o|--push-option|--receive-pack|--exec) skip_next=1; continue ;;
    -*) continue ;;
  esac
  if [ -z "$remote_seen" ]; then remote_seen="$a"; continue; fi
  target_ref="${a%%:*}"   # local side of a src:dst refspec
  break
done

target_sha="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${target_ref}^{commit}" 2>/dev/null)"
if [ -z "$target_sha" ]; then
  target_sha="$(git -C "$REPO_ROOT" rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null)"
fi
[ -n "$target_sha" ] ||
  fail "review-gate: BLOCKED — cannot resolve the commit being pushed (${target_ref}), so the gate cannot verify it."

# --- docs-only exemption ---------------------------------------------
# Exempt by EXTENSION, never by directory: v1 exempted all of ^docs/, which
# in this repo silently covered nginx.conf, a Caddyfile, a .mjs generator and
# every .html mockup. The files that GOVERN the gate are excluded from the
# exemption — the rules an agent follows are not a place for unreviewed edits.
base=""
for candidate in origin/main origin/master; do
  if git -C "$REPO_ROOT" rev-parse --verify --quiet "$candidate" >/dev/null; then
    base="$candidate"; break
  fi
done
if [ -n "$base" ]; then
  merge_base="$(git -C "$REPO_ROOT" merge-base "$base" "$target_sha" 2>/dev/null)"
  if [ -n "$merge_base" ]; then
    changed="$(git -C "$REPO_ROOT" diff --name-only "$merge_base" "$target_sha" 2>/dev/null)"
    if [ -n "$changed" ] &&
       ! printf '%s\n' "$changed" | grep -qvE '\.(md|txt)$' &&
       ! printf '%s\n' "$changed" | grep -qxE 'CLAUDE\.md|AGENTS\.md|docs/dev-workflow\.md'; then
      exit 0
    fi
  fi
fi

# --- the gate ---------------------------------------------------------
record="$RECORDS_DIR/$target_sha.json"
if [ -f "$record" ]; then
  verdict="$(jq -r '.verdict // ""' "$record" 2>/dev/null)" || verdict=""
  recorded_sha="$(jq -r '.sha // ""' "$record" 2>/dev/null)" || recorded_sha=""
  # A record names the sha it describes, and that must match the file it is
  # stored under — otherwise a copied or renamed record is honored.
  if [ "$recorded_sha" != "$target_sha" ]; then
    fail "review-gate: BLOCKED — the record at $record describes ${recorded_sha:-nothing}, not $target_sha. Re-record the review."
  fi
  case "$verdict" in
    clean|lows-only) exit 0 ;;
    bypass)
      echo "review-gate: BYPASSED for $target_sha. The adversarial review gate is INCOMPLETE for this push and MUST be reported as such, not presented as reviewed." >&2
      exit 0
      ;;
    "") fail "review-gate: BLOCKED — $record has no \"verdict\" field. Re-record the review." ;;
    *)
      fail "review-gate: BLOCKED — the review on record for $target_sha has verdict \"$verdict\".
Per docs/dev-workflow.md, resolve every high/critical finding, then re-review the FINAL diff and re-record."
      ;;
  esac
fi

fail "review-gate: BLOCKED — no independent adversarial review on record for $target_sha (${target_ref}).

This repo requires one before a code change is pushed or called complete
(AGENTS.md \"Mandatory independent adversarial review\"; docs/dev-workflow.md
stage 5). A self-review by the implementing agent does NOT satisfy it.

To clear the gate:
  1. Dispatch a SEPARATE, fresh-context, read-only reviewer over the full
     diff (git diff <base>...${target_ref}). Do not prime it with your own
     conclusions about whether the change is correct.
  2. Resolve every high/critical finding. Any substantive code change
     invalidates the verdict and needs a fresh review of the final diff.
  3. Record it, naming the reviewer and what it found:
       bash scripts/record-review.sh clean --reviewer <id> --findings <n> \"<summary>\"

The record is keyed to the exact commit, so amending or adding one correctly
invalidates it.

If no independent reviewer is available the gate is INCOMPLETE — say so
plainly instead of self-certifying. \`record-review.sh bypass\` records that
honestly and lets the push through; there is no silent way past this."