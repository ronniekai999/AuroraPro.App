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
# Detection is deliberately over-eager, and every relaxation below was paid
# for by a review that got a push through:
#   - v1 substring-matched "git push": beaten by `git push;`, `git push&&x`,
#     `git -c k=v push`, `env FOO=1 git push`, `bash -c "git push"`.
#   - v2 normalized the command but resolved the repo from the HOOK's cwd,
#     so `cd ../other && git push` and `git -C ../other push` pushed
#     unreviewed commits while the gate inspected a different checkout.
# Quoted spans are now encoded rather than flattened, so separators inside a
# string cannot fabricate a segment (and a commit message that discusses
# pushing stays inert), while a shell wrapper's -c argument is decoded and
# re-read so `bash -c "git push"` is still seen.

set -uo pipefail

fail() { printf '%s\n' "$*" >&2; exit 2; }

payload="$(cat)"

# ---------------------------------------------------------------------
# jq is a hard dependency. v1 swallowed its absence, leaving the command
# text empty so every push was allowed with no output at all. Degrade to a
# raw-text check instead of going quiet: still usable, still closed for
# anything that looks like it publishes.
# ---------------------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  if printf '%s' "$payload" |
     grep -qE 'push|pull_request|mcp__github__|\bgh\b|create_branch|create_or_update|delete_file|merge'; then
    fail "review-gate: jq is not installed, so this call cannot be inspected — and it looks like it publishes. Failing closed. Install jq to restore the gate."
  fi
  echo "review-gate: jq not installed; the review gate is NOT enforcing anything on this machine." >&2
  exit 0
fi

jqr() { printf '%s' "$payload" | jq -r "$1" 2>/dev/null || printf ''; }
tool_name="$(jqr '.tool_name // ""')"
command_text="$(jqr '.tool_input.command // ""')"
hook_cwd="$(jqr '.cwd // ""')"
[ -n "$hook_cwd" ] || hook_cwd="$PWD"

is_push=0
push_args=""
head_moves=0
repo_hint=""

# ---------------------------------------------------------------------
# Non-Bash publish paths. An agent blocked at `git push` and casting about
# for the next thing to try lands on these immediately — they publish
# without ever touching a shell. DEFAULT-DENY: everything under the
# github namespace is treated as publishing unless it is a known read.
# An allowlist of writes went stale the moment `delete_file` existed.
# ---------------------------------------------------------------------
case "$tool_name" in
  mcp__github__*)
    case "$tool_name" in
      mcp__github__get_*|mcp__github__list_*|mcp__github__search_*|\
      mcp__github__issue_read|mcp__github__pull_request_read|\
      mcp__github__actions_get|mcp__github__actions_list|\
      mcp__github__list_issue_fields|mcp__github__list_issue_types) ;;
      *) is_push=1 ;;
    esac
    ;;
esac

# ---------------------------------------------------------------------
# Command analysis
# ---------------------------------------------------------------------
if [ "$is_push" = 0 ] && [ -n "$command_text" ]; then
  analysis="$(printf '%s\n' "$command_text" | awk '
    function ch(n) { return sprintf("%c", n) }
    function protect(c) {
      if (c == " ")  return ch(1);  if (c == "\t") return ch(2)
      if (c == ";")  return ch(3);  if (c == "&")  return ch(4)
      if (c == "|")  return ch(5);  if (c == "(")  return ch(6)
      if (c == ")")  return ch(7);  if (c == "`")  return ch(11)
      if (c == "{")  return ch(14); if (c == "}")  return ch(15)
      return c
    }
    function unprotect(s) {
      gsub(ch(1), " ", s);  gsub(ch(2), "\t", s); gsub(ch(3), ";", s)
      gsub(ch(4), "\\&", s); gsub(ch(5), "|", s);  gsub(ch(6), "(", s)
      gsub(ch(7), ")", s);  gsub(ch(11), "`", s); gsub(ch(14), "{", s)
      gsub(ch(15), "}", s)
      return s
    }
    # Quoted spans keep their contents but lose their power to punctuate:
    # `echo "build && git push"` must not read as two commands, and
    # `VAR="ssh -i k" git push` must not lose its command token.
    function encode_quotes(str,   out, i, c, q) {
      out = ""; q = ""
      for (i = 1; i <= length(str); i++) {
        c = substr(str, i, 1)
        if (q == "") { if (c == "\x27" || c == "\"") { q = c; continue } out = out c }
        else         { if (c == q) { q = ""; continue } out = out protect(c) }
      }
      return out
    }
    function basename(p) { sub(/^.*\//, "", p); return p }
    function is_shell(t) {
      return (t=="bash"||t=="sh"||t=="zsh"||t=="ksh"||t=="dash")
    }
    function is_wrapper(t) {
      return (is_shell(t)||t=="env"||t=="time"||t=="sudo"||t=="nohup"||t=="command"||
              t=="exec"||t=="xargs"||t=="builtin"||t=="then"||t=="do"||t=="else"||
              t=="elif"||t=="if"||t=="while"||t=="until"||t=="!"||t=="timeout"||
              t=="nice"||t=="flock"||t=="setsid"||t=="stdbuf"||t=="ionice"||
              t=="chrt"||t=="ssh"||t=="doas")
    }
    # Wrappers whose FIRST non-option argument is theirs, not the command:
    # `timeout 60 git push`, `flock /tmp/l git push`, `ssh host git push`.
    function eats_one(t) { return (t=="timeout"||t=="flock"||t=="ssh"||t=="ionice"||t=="chrt") }
    function opt_takes_value(t) { return (t=="-n"||t=="-o"||t=="-i"||t=="-e"||t=="-c"||t=="-u"||t=="-p") }
    function git_opt_takes_value(t) {
      return (t=="-c"||t=="-C"||t=="--git-dir"||t=="--work-tree"||t=="--exec-path"||
              t=="--namespace"||t=="--config-env")
    }
    BEGIN { inheredoc = 0; term = ""; buf = "" }
    {
      line = $0
      # Heredoc BODIES are data, not commands.
      if (inheredoc) { if (line ~ ("^[ \t]*" term "[ \t]*$")) inheredoc = 0; next }
      if (match(line, /<<-?[ \t]*[\x27"]?[A-Za-z_][A-Za-z0-9_]*[\x27"]?/)) {
        h = substr(line, RSTART, RLENGTH)
        sub(/^<<-?[ \t]*/, "", h); gsub(/[\x27"]/, "", h)
        term = h; inheredoc = 1
        sub(/<<-?[ \t]*[\x27"]?[A-Za-z_][A-Za-z0-9_]*[\x27"]?.*$/, "", line)
      }
      buf = buf line "\n"
    }
    END {
      buf = encode_quotes(buf)
      gsub(/[;&|()`{}\n]/, "\n", buf)
      n = split(buf, seg, "\n")
      for (i = 1; i <= n; i++) {
        s = seg[i]
        gsub(/^[ \t]+|[ \t]+$/, "", s)
        if (s == "") continue
        # Leading VAR=value assignments. GIT_DIR / GIT_WORK_TREE name the
        # repo the command will act on, so they are captured, not discarded.
        while (match(s, /^[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/)) {
          asn = substr(s, RSTART, RLENGTH)
          sub(/[ \t]+$/, "", asn)
          if (asn ~ /^GIT_DIR=/)       { v = asn; sub(/^GIT_DIR=/, "", v);       sub(/\/\.git$/, "", v); print "HINT\t" unprotect(v) }
          if (asn ~ /^GIT_WORK_TREE=/) { v = asn; sub(/^GIT_WORK_TREE=/, "", v); print "HINT\t" unprotect(v) }
          s = substr(s, RLENGTH + 1)
        }
        changed = 1
        while (changed) {
          changed = 0
          ntok = split(s, tk, /[ \t]+/)
          if (ntok >= 1 && is_wrapper(basename(tk[1]))) {
            w = basename(tk[1])
            j = 2
            # `-c` is a value-taking option everywhere EXCEPT on a shell,
            # where its value IS the command we need to keep reading.
            while (j <= ntok && substr(tk[j], 1, 1) == "-") {
              if (opt_takes_value(tk[j]) && !(is_shell(w) && tk[j] == "-c")) j++
              j++
            }
            if (eats_one(w) && j <= ntok) j++
            rest = ""
            for (k = j; k <= ntok; k++) rest = rest (rest == "" ? "" : " ") tk[k]
            # A shell wrapper was handed a command as a STRING; decode it so
            # `bash -c "git push"` is read, while ordinary quoted prose (whose
            # command is echo/grep/git-commit) stays protected above.
            if (is_shell(w)) rest = unprotect(rest)
            s = rest; changed = 1
            while (match(s, /^[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/)) s = substr(s, RLENGTH + 1)
          }
        }
        ntok = split(s, tk, /[ \t]+/)
        if (ntok == 0) continue
        cmd = basename(tk[1])
        if (cmd == "cd" && ntok >= 2) { print "HINT\t" unprotect(tk[2]); continue }
        if (cmd == "git") {
          j = 2
          while (j <= ntok && substr(tk[j], 1, 1) == "-") {
            if (tk[j] == "-C" && j + 1 <= ntok) print "HINT\t" unprotect(tk[j+1])
            if (tk[j] ~ /^--git-dir=/)   { v = tk[j]; sub(/^--git-dir=/, "", v);   sub(/\/\.git$/, "", v); print "HINT\t" unprotect(v) }
            if (tk[j] ~ /^--work-tree=/) { v = tk[j]; sub(/^--work-tree=/, "", v); print "HINT\t" unprotect(v) }
            if (git_opt_takes_value(tk[j])) j++
            j++
          }
          sub_ = (j <= ntok ? tk[j] : "")
          if (sub_ == "push" || sub_ == "subtree" || sub_ == "svn") {
            args = ""
            for (k = j + 1; k <= ntok; k++) args = args (args == "" ? "" : " ") unprotect(tk[k])
            if (sub_ == "push") print "PUSH\t" args
            else if (args ~ /(^| )(push|dcommit)( |$)/) print "PUSH\t"
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
  repo_hint="$(printf '%s' "$analysis" | grep '^HINT' | tail -1 | cut -f2-)"
fi

[ "$is_push" = 1 ] || exit 0

# =====================================================================
# Everything below runs ONLY for a push, and every exit is 2 (blocking).
# =====================================================================

# A PreToolUse hook runs BEFORE the command. If the same call creates the
# commit and pushes it, the sha we can see is the PRE-commit one, and a
# record for it says nothing about what lands on the remote.
if [ "${head_moves:-0}" -gt 0 ]; then
  fail "review-gate: BLOCKED — this call both moves HEAD and pushes.
A PreToolUse hook runs before the command, so the sha available here is the
one BEFORE your commit/merge/rebase — reviewing it would say nothing about
what reaches the remote.
Run them as separate calls: commit first, then review, then push."
fi

# Resolve WHICH repo. The hook's cwd is not authoritative: `cd ../other &&
# git push`, `git -C ../other push`, and `GIT_DIR=…` all act on a different
# tree, and v2 inspected the hook's checkout while those pushed unreviewed
# commits from elsewhere.
work_dir="$hook_cwd"
if [ -n "$repo_hint" ]; then
  case "$repo_hint" in
    /*) work_dir="$repo_hint" ;;
    *)  work_dir="$hook_cwd/$repo_hint" ;;
  esac
fi
[ -d "$work_dir" ] ||
  fail "review-gate: BLOCKED — a push was requested against '$work_dir', which does not exist, so the gate cannot verify it."

REPO_ROOT="$(git -C "$work_dir" rev-parse --show-toplevel 2>/dev/null)" ||
  fail "review-gate: BLOCKED — a push was requested but '$work_dir' is not a git working tree, so the gate cannot verify it."
RECORDS_DIR="$REPO_ROOT/.claude/review-records"

case " $push_args " in
  *" --all "*|*" --mirror "*|*" --branches "*)
    fail "review-gate: BLOCKED — --all/--branches/--mirror pushes an unknown set of refs, which the gate cannot verify one commit at a time. Push a single branch."
    ;;
esac

# Resolve WHAT is being pushed. v1 always checked HEAD, so standing on an
# up-to-date main and running `git push origin feat/x` sailed through.
target_ref="HEAD"
remote_seen=""
skip_next=0
set -f                                  # no globbing against the hook's cwd
for a in $push_args; do
  if [ "$skip_next" = 1 ]; then skip_next=0; continue; fi
  case "$a" in
    -o|--push-option|--receive-pack|--exec) skip_next=1; continue ;;
    -*) continue ;;
  esac
  if [ -z "$remote_seen" ]; then remote_seen="$a"; continue; fi
  target_ref="${a%%:*}"                 # local side of a src:dst refspec
  break
done
set +f

target_sha="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${target_ref}^{commit}" 2>/dev/null)"
[ -n "$target_sha" ] ||
  target_sha="$(git -C "$REPO_ROOT" rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null)"
[ -n "$target_sha" ] ||
  fail "review-gate: BLOCKED — cannot resolve the commit being pushed (${target_ref}) in $REPO_ROOT."

# --- docs-only exemption ---------------------------------------------
# Exempt by EXTENSION, never by directory: v1 exempted all of ^docs/, which
# in this repo silently covered nginx.conf, a Caddyfile, a .mjs generator and
# every .html mockup. Files that GOVERN agent behavior are excluded from the
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
    if [ -z "$changed" ]; then
      exit 0                            # nothing to review; a no-op push
    fi
    if ! printf '%s\n' "$changed" | grep -qvE '\.(md|txt)$' &&
       ! printf '%s\n' "$changed" | grep -qE '(^|/)(CLAUDE|AGENTS)\.md$|^docs/dev-workflow\.md$'; then
      exit 0
    fi
  fi
fi

# --- the gate ---------------------------------------------------------
record="$RECORDS_DIR/$target_sha.json"
if [ -f "$record" ]; then
  verdict="$(jq -r '.verdict // ""' "$record" 2>/dev/null)" || verdict=""
  recorded_sha="$(jq -r '.sha // ""' "$record" 2>/dev/null)" || recorded_sha=""
  reviewer="$(jq -r '.reviewer // ""' "$record" 2>/dev/null)" || reviewer=""
  # A record names the sha it describes, and that must match the file it is
  # stored under — otherwise a copied or renamed record is honored.
  if [ "$recorded_sha" != "$target_sha" ]; then
    fail "review-gate: BLOCKED — the record at $record describes ${recorded_sha:-nothing}, not $target_sha. Re-record the review."
  fi
  case "$verdict" in
    clean|lows-only)
      # A verdict with no reviewer named is not a review. This is a floor,
      # not a proof — anyone with write access can author a record — but an
      # anonymous pass should not be the cheapest way through.
      [ -n "$reviewer" ] ||
        fail "review-gate: BLOCKED — the record for $target_sha names no reviewer. Re-record with --reviewer <id>."
      exit 0
      ;;
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

fail "review-gate: BLOCKED — no independent adversarial review on record for $target_sha (${target_ref} in $REPO_ROOT).

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