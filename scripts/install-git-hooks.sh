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

# Prove it fires rather than assuming it, in two parts — because every
# weaker probe tried here reported a dead gate as working:
#
#   v1 treated ANY probe-push failure as proof the hook refused it. This
#   checkout is a shallow clone, where pushing to a fresh bare repo fails with
#   "shallow update not allowed" regardless, so a hook replaced by `exit 0`
#   reported "verified" in the default environment on every session start.
#   v2 fixed that side and left the other: an ALLOWED push was still read as
#   "active" whenever HEAD was recorded or docs-only. An allowed push is not
#   evidence of anything.
#
# So: check the wiring directly, and exercise the hook against a synthetic
# unreviewed commit it must refuse. Neither step pushes this repo's history
# anywhere, which also keeps the SessionStart cost flat.
hooks_path="$(git -C "$repo_root" config --local --get core.hooksPath 2>/dev/null || true)"
if [ "$hooks_path" != "$hooks_dir" ]; then
  echo "install-git-hooks: WARNING — core.hooksPath is '${hooks_path:-unset}', not '$hooks_dir'. The gate will NOT run."
  exit 0
fi
if [ ! -x "$hooks_dir/pre-push" ]; then
  echo "install-git-hooks: WARNING — $hooks_dir/pre-push is not executable. git skips such hooks SILENTLY."
  exit 0
fi

probe="$(mktemp -d)"
trap 'rm -rf "$probe"' EXIT INT TERM HUP
(
  set -e
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  export GIT_AUTHOR_NAME=probe GIT_AUTHOR_EMAIL=probe@invalid
  export GIT_COMMITTER_NAME=probe GIT_COMMITTER_EMAIL=probe@invalid
  git init -q --bare -b main "$probe/r.git"
  git init -q -b main "$probe/w"
  cd "$probe/w"
  git remote add origin "$probe/r.git"
  echo probe > probe.go
  git add -A
  git commit -qm "probe: an unreviewed code commit"
  git config core.hooksPath "$hooks_dir"
  git push -q origin main
) >"$probe/out" 2>&1 || probe_rc=$?
probe_rc="${probe_rc:-0}"
# Explicit capture, because `set -e` aborts on the failing subshell before a
# bare `$?` test can run — the refusal we are looking for IS a failure.
if [ "$probe_rc" -ne 0 ] && grep -q 'review-gate: BLOCKED' "$probe/out"; then
  echo "install-git-hooks: pre-push review gate active (it refused a synthetic unreviewed commit)."
else
  echo "install-git-hooks: WARNING — the gate did NOT refuse a synthetic unreviewed commit."
  echo "install-git-hooks: the review gate is not working. Inspect $hooks_dir/pre-push."
  printf 'install-git-hooks: %s\n' "$(tail -1 "$probe/out" 2>/dev/null)"
fi
