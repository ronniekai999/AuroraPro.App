#!/usr/bin/env bash
# Points this clone's hooks at .githooks/, which is where the review gate's
# pre-push hook lives. Idempotent, and safe to run on every session start.
#
# core.hooksPath is per-clone local config, so a fresh clone has no gate until
# this runs — that is the one real cost of enforcing at the git layer, and it
# is why .claude/settings.json runs this from a SessionStart hook.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
current="$(git -C "$repo_root" config --local --get core.hooksPath 2>/dev/null || true)"

if [ "$current" != ".githooks" ]; then
  # Don't silently stomp a deliberate custom hooks dir.
  if [ -n "$current" ] && [ "$current" != ".githooks" ]; then
    echo "install-git-hooks: core.hooksPath is '$current', not .githooks — leaving it alone." >&2
    echo "install-git-hooks: the review gate's pre-push hook will NOT run until this is resolved." >&2
    exit 0
  fi
  git -C "$repo_root" config --local core.hooksPath .githooks
  echo "install-git-hooks: core.hooksPath -> .githooks (review gate pre-push hook active)"
fi

chmod +x "$repo_root/.githooks/pre-push" 2>/dev/null || true
