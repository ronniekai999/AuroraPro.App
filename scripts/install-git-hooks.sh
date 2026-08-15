#!/usr/bin/env bash
# Points this clone's hooks at .githooks/, where the review gate's pre-push
# hook lives, and then VERIFIES the hook actually runs.
#
# Read the honesty note first: this layer is advisory. `core.hooksPath` is
# per-clone local config that the pushing process controls, so
# `git -c core.hooksPath=/dev/null push`, a throwaway `git clone`, or a plain
# `git config` disables it in one token. The binding check is
# scripts/review-gate-ci.sh, which runs on CI where the pusher cannot unset
# it. This script makes the honest path convenient; it does not make the
# dishonest path hard.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
hooks_dir="$repo_root/.githooks"

if [ ! -d "$hooks_dir" ]; then
  # A linked worktree checked out on a commit without .githooks/ (main, a
  # release branch, a tag) inherits the shared --local setting and silently
  # has no hook. Say so on stdout, which is the stream that reaches the agent.
  echo "install-git-hooks: WARNING — $hooks_dir does not exist in this checkout."
  echo "install-git-hooks: the pre-push review gate will NOT run here."
  exit 0
fi

current="$(git -C "$repo_root" config --local --get core.hooksPath 2>/dev/null || true)"

# Absolute, not relative: --local config is SHARED across linked worktrees,
# and a relative path resolves against each worktree's own root, so a
# worktree without .githooks/ inherits the setting and gets no hook.
if [ "$current" != "$hooks_dir" ]; then
  if [ -n "$current" ] && [ "$current" != ".githooks" ]; then
    echo "install-git-hooks: WARNING — core.hooksPath is '$current', not '$hooks_dir'."
    echo "install-git-hooks: leaving it alone; the pre-push review gate will NOT run."
    exit 0
  fi
  git -C "$repo_root" config --local core.hooksPath "$hooks_dir"
fi

if ! chmod +x "$hooks_dir/pre-push" 2>/dev/null; then
  if [ ! -x "$hooks_dir/pre-push" ]; then
    echo "install-git-hooks: WARNING — $hooks_dir/pre-push is not executable."
    echo "install-git-hooks: git skips non-executable hooks SILENTLY; the gate is off."
    exit 0
  fi
fi

# Prove it fires rather than assuming it. A non-executable hook, a bad
# shebang, or a hooksPath that doesn't resolve all fail silently in git —
# the gate's failure mode is indistinguishable from success without this.
probe="$(mktemp -d)"
trap 'rm -rf "$probe"' EXIT
head_sha="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || true)"
git init -q --bare -b main "$probe/r.git" 2>/dev/null || true
probe_rc=0
probe_out="$(git -C "$repo_root" push "$probe/r.git" "HEAD:refs/heads/gate-probe" 2>&1)" || probe_rc=$?
# A FAILED push is only evidence of a working gate if the hook is what refused
# it. This checkout is a shallow clone, and pushing shallow history to a fresh
# bare repo fails with "shallow update not allowed" — so treating any failure
# as success reported a completely disabled hook as "verified", in the default
# environment, on every session start.
if [ "$probe_rc" != 0 ] && printf '%s' "$probe_out" | grep -q 'review-gate: BLOCKED'; then
  echo "install-git-hooks: pre-push review gate active (probe push refused by the hook)."
  exit 0
fi
if [ "$probe_rc" != 0 ]; then
  echo "install-git-hooks: WARNING — could not verify the hook: the probe push failed for an unrelated reason."
  printf 'install-git-hooks: %s\n' "$(printf '%s' "$probe_out" | tail -1)"
  exit 0
fi
if true; then
  # A push that succeeds is only alarming if HEAD had nothing to allow it.
  # Warning on every reviewed HEAD trains people to ignore the message.
  docs_head=0
  if base_ref="$(git -C "$repo_root" rev-parse --verify --quiet origin/main 2>/dev/null)" && [ -n "$base_ref" ]; then
    mb="$(git -C "$repo_root" merge-base "$base_ref" HEAD 2>/dev/null || true)"
    if [ -n "$mb" ]; then
      ch="$(git -C "$repo_root" diff --no-renames --name-only "$mb" HEAD 2>/dev/null || true)"
      if [ -n "$ch" ] && ! printf '%s\n' "$ch" | grep -qvE '\.(md|txt)$'; then docs_head=1; fi
    fi
  fi
  if [ -n "$head_sha" ] && [ -f "$repo_root/.claude/review-records/$head_sha.json" ]; then
    echo "install-git-hooks: pre-push review gate active (HEAD is already recorded, so the probe push was allowed)."
  elif [ "$docs_head" = 1 ]; then
    echo "install-git-hooks: pre-push review gate active (HEAD is documentation-only, which is exempt)."
  else
    echo "install-git-hooks: WARNING — a test push was NOT blocked and HEAD has no review record."
    echo "install-git-hooks: the gate may be off. Check core.hooksPath and that .githooks/pre-push is executable."
  fi
else
  echo "install-git-hooks: pre-push review gate active (verified by test push)."
fi
