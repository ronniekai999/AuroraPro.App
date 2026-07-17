#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export AURORA_BOOTSTRAP_LIBRARY_ONLY=1
# shellcheck source=../../install.sh
# shellcheck disable=SC1091
. "$PROJECT_ROOT/install.sh"
trap - ERR EXIT

PASS_COUNT=0

pass() {
    PASS_COUNT=$((PASS_COUNT + 1))
    printf 'ok %d - %s\n' "$PASS_COUNT" "$1"
}

fail() {
    printf 'not ok - %s\n' "$1" >&2
    exit 1
}

assert_eq() {
    local want="$1" got="$2" label="$3"
    [ "$got" = "$want" ] || fail "$label: got '$got', want '$want'"
    pass "$label"
}

assert_eq "amd64" "$(normalize_arch x86_64)" "normalizes x86_64"
assert_eq "amd64" "$(normalize_arch amd64)" "accepts amd64"
assert_eq "arm64" "$(normalize_arch aarch64)" "normalizes aarch64"
assert_eq "arm64" "$(normalize_arch arm64)" "accepts arm64"
if normalize_arch riscv64 >/dev/null 2>&1; then
    fail "rejects unsupported architecture"
fi
pass "rejects unsupported architecture"

assert_eq \
    "https://github.com/owner/repo" \
    "$(normalize_repo_url 'https://github.com/owner/repo.git/')" \
    "normalizes HTTPS repository URL"
assert_eq \
    "https://github.com/owner/repo" \
    "$(normalize_repo_url 'git@github.com:owner/repo.git')" \
    "normalizes SSH repository URL"

REPO_URL="/tmp/repo:colon"
if (validate_repo_url >/dev/null 2>&1); then
    fail "bootstrap accepted a colon-bearing local repository path"
fi
pass "rejects colon-bearing local repository path"

REPO_URL="https://github_pat_secret@github.com/owner/repo.git"
if (validate_repo_url >/dev/null 2>&1); then
    fail "bootstrap accepted HTTPS credentials in repository URL"
fi
pass "rejects HTTPS credentials in repository URL"

REPO_URL="https://github.com/owner/repo.git?token=secret"
if (validate_repo_url >/dev/null 2>&1); then
    fail "bootstrap accepted a repository URL with query credentials"
fi
pass "rejects non-canonical GitHub repository URL"

REPO_URL="git@github.com:owner/repo.git"
# shellcheck disable=SC2034 # consumed by sourced validate_repo_url
AURORA_GIT_TOKEN="token-must-not-be-used-as-ssh-askpass"
if (validate_repo_url >/dev/null 2>&1); then
    fail "bootstrap accepted AURORA_GIT_TOKEN with an SSH repository"
fi
unset AURORA_GIT_TOKEN
pass "rejects HTTPS token with SSH repository"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
INSTALLED_ENV_FILE="$TMP_ROOT/installed.env"
cat > "$INSTALLED_ENV_FILE" <<'EOF'
AURORA_EXPECTED_REMOTE="https://github.com/owner/fork.git"
AURORA_UPDATE_BRANCH=stable
EOF
assert_eq \
    "https://github.com/owner/fork.git" \
    "$(read_installed_setting AURORA_EXPECTED_REMOTE)" \
    "reads quoted installed repository"
assert_eq \
    "stable" \
    "$(read_installed_setting AURORA_UPDATE_BRANCH)" \
    "reads installed branch"

# shellcheck disable=SC2329 # invoked indirectly by sourced git_with_auth
git() {
    printf '%s\n' "$*"
}
GIT_CREDENTIAL_HELPER=""
assert_eq \
    "-c credential.helper= status" \
    "$(git_with_auth status)" \
    "clears inherited Git credential helpers"
GIT_CREDENTIAL_HELPER="store --file=/root/.config/aurora/git-credentials"
assert_eq \
    "-c credential.helper= -c credential.helper=store --file=/root/.config/aurora/git-credentials fetch" \
    "$(git_with_auth fetch)" \
    "uses only the Aurora credential helper"
unset -f git
# shellcheck disable=SC2034 # reset for subsequent sourced helper calls
GIT_CREDENTIAL_HELPER=""

REMOTE="$TMP_ROOT/remote.git"
SEED="$TMP_ROOT/seed"
# These globals are consumed by functions sourced from install.sh.
# shellcheck disable=SC2034
SOURCE_DIR="$TMP_ROOT/managed/source"
# shellcheck disable=SC2034
REPO_URL="file://$REMOTE"
# shellcheck disable=SC2034
INSTALL_BRANCH="main"

git init --quiet --bare "$REMOTE"
git init --quiet "$SEED"
git -C "$SEED" config user.name "Aurora Installer Test"
git -C "$SEED" config user.email "installer-test@aurorapro.invalid"
mkdir -p "$SEED/scripts"
printf '#!/usr/bin/env bash\n' > "$SEED/scripts/install.sh"
printf 'first\n' > "$SEED/version.txt"
git -C "$SEED" add scripts/install.sh version.txt
git -C "$SEED" commit --quiet -m "first"
git -C "$SEED" branch -M main
git -C "$SEED" remote add origin "$REMOTE"
git -C "$SEED" push --quiet -u origin main

sync_managed_source >/dev/null
assert_eq "first" "$(tr -d '\n' < "$SOURCE_DIR/version.txt")" "clones managed source"

printf 'second\n' > "$SEED/version.txt"
git -C "$SEED" add version.txt
git -C "$SEED" commit --quiet -m "second"
git -C "$SEED" push --quiet
sync_managed_source >/dev/null
assert_eq "second" "$(tr -d '\n' < "$SOURCE_DIR/version.txt")" "fast-forwards managed source"

printf 'dirty\n' >> "$SOURCE_DIR/version.txt"
if (sync_managed_source >/dev/null 2>&1); then
    fail "refuses tracked changes in managed source"
fi
pass "refuses tracked changes in managed source"

git -C "$SOURCE_DIR" checkout --quiet -- version.txt
printf 'package injected\n' > "$SOURCE_DIR/injected.go"
if (sync_managed_source >/dev/null 2>&1); then
    fail "refuses untracked files in managed source"
fi
pass "refuses untracked files in managed source"

printf '1..%d\n' "$PASS_COUNT"
