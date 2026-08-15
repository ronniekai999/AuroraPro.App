#!/usr/bin/env bash
# Blocks `git push` until the current HEAD has an independent adversarial
# review on record. Wired as a PreToolUse/Bash hook in .claude/settings.json.
#
# Why a hook and not a line in CLAUDE.md: the review gate has been written
# down three times — AGENTS.md, docs/dev-workflow.md, and a pointer in
# CLAUDE.md — and was still skipped on PR #487, because only CLAUDE.md is
# auto-loaded into an agent's context and its mention was a parenthetical.
# Prose can be missed. The harness runs this whether or not anything was
# read.
#
# Contract: reads the hook payload on stdin, exits 0 to allow, exits 2 to
# block with the stderr text fed back to the agent.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
RECORDS_DIR="$REPO_ROOT/.claude/review-records"

payload="$(cat)"
command_text="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null)"

# Self-guard rather than relying on the hook's `if` matcher: an `if` that
# silently fails to match turns the gate off with no signal, which is the
# exact failure mode this script exists to prevent. Cheap to run on every
# Bash call; only a real `git push` proceeds past here.
#
# Match an INVOCATION, not the substring. A plain *"git push"* test blocked
# the very commit that added this file, because the commit message talks
# about `git push` in prose — and every false positive is a reason for
# someone to reach for the bypass, which is how a gate stops meaning
# anything. So: anchor at a line start or a shell separator (grep is
# line-based, so ^ is per-line), and require `push` to be git's subcommand.
#
# Deliberately biased toward false positives over false negatives. A false
# positive is a confusing block on an unrelated command; a false negative
# is an unreviewed push, which is the whole thing we are preventing. Known
# residual risk in the safe direction: a heredoc line that literally BEGINS
# with `git push` (prose indented or backticked, as above, does not match),
# and exotic invocations beyond `git push` / `git -C <path> push` — a
# wrapper script or an alias is not detected.
push_re='(^|[;&|(])[[:space:]]*git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?push([[:space:]]|$)'
if ! printf '%s' "$command_text" | grep -qE "$push_re"; then
  exit 0
fi

# --- escape hatch -----------------------------------------------------
# Deliberately env-var-only and loud. dev-workflow.md's rule is that an
# unavailable reviewer means the gate is INCOMPLETE, not satisfied — so
# using this obliges the agent to say it was used.
if [ "${AURORA_REVIEW_GATE:-}" = "off" ]; then
  echo "review-gate: BYPASSED via AURORA_REVIEW_GATE=off. The adversarial review gate is INCOMPLETE for this push and must be reported as such." >&2
  exit 0
fi

head_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)" || exit 0

# --- docs-only exemption ---------------------------------------------
# The gate covers behavior-changing code. A README typo does not need an
# adversarial reviewer. Compare against the upstream default branch;
# if we cannot resolve a base, fall through and require the review
# (fail closed — an unknown diff is not an empty one).
base=""
for candidate in origin/main origin/master; do
  if git -C "$REPO_ROOT" rev-parse --verify --quiet "$candidate" >/dev/null; then
    base="$candidate"
    break
  fi
done

if [ -n "$base" ]; then
  merge_base="$(git -C "$REPO_ROOT" merge-base "$base" HEAD 2>/dev/null)"
  if [ -n "$merge_base" ]; then
    changed="$(git -C "$REPO_ROOT" diff --name-only "$merge_base" HEAD 2>/dev/null)"
    if [ -z "$changed" ]; then
      exit 0
    fi
    # Anything that is not documentation counts as code. Listing what IS
    # exempt (rather than what is not) keeps a new language or config
    # format from silently landing on the exempt side.
    if ! printf '%s\n' "$changed" | grep -qvE '(\.(md|txt)$|^docs/|^LICENSE$)'; then
      exit 0
    fi
  fi
fi

# --- the gate ---------------------------------------------------------
record="$RECORDS_DIR/$head_sha.json"
if [ -f "$record" ]; then
  verdict="$(jq -r '.verdict // ""' "$record" 2>/dev/null)"
  case "$verdict" in
    clean|lows-only)
      exit 0
      ;;
    "")
      echo "review-gate: $record exists but has no \"verdict\" field. Re-record the review." >&2
      exit 2
      ;;
    *)
      echo "review-gate: BLOCKED — the review on record for HEAD ($head_sha) has verdict \"$verdict\"." >&2
      echo "Per docs/dev-workflow.md, resolve every high/critical finding, then re-review the FINAL diff and re-record." >&2
      exit 2
      ;;
  esac
fi

cat >&2 <<EOF
review-gate: BLOCKED — no independent adversarial review on record for HEAD ($head_sha).

This repo requires one before a code change is pushed or called complete
(AGENTS.md "Mandatory independent adversarial review"; docs/dev-workflow.md
stage 5). A self-review by the implementing agent does NOT satisfy it.

To clear the gate:
  1. Dispatch a SEPARATE, fresh-context, read-only reviewer over the full
     diff (git diff <base>...HEAD). Do not prime it with your own
     conclusions about whether the change is correct.
  2. Resolve every high/critical finding. Any substantive code change
     invalidates the verdict and needs a fresh review of the final diff.
  3. Record it:  bash scripts/record-review.sh clean "<reviewer> — <summary>"

The record is keyed to the current HEAD sha, so amending or adding a commit
correctly invalidates it.

If no independent reviewer is available, the gate is INCOMPLETE — say so
plainly instead of self-certifying. AURORA_REVIEW_GATE=off bypasses this
check and obliges you to report the gate as incomplete.
EOF
exit 2
