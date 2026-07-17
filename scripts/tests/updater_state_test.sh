#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
UPDATER_SCRIPT="$PROJECT_DIR/scripts/aurora-update.sh"
ORIGINAL_PATH="$PATH"
TMP_ROOT="$(mktemp -d)"

cleanup() {
    rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

assert_eq() {
    local want="$1" got="$2" message="$3"
    [ "$want" = "$got" ] || fail "$message (want '$want', got '$got')"
}

assert_file_contains() {
    local file="$1" expected="$2" message="$3"
    [ -f "$file" ] || fail "$message (missing $file)"
    grep -Fq "$expected" "$file" || fail "$message ('$expected' not in $file)"
}

status_state() {
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["state"])' "$1"
}

make_mocks() {
    MOCK_BIN="$TMP_ROOT/mock-bin"
    mkdir -p "$MOCK_BIN"

    cat > "$MOCK_BIN/go" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${MOCK_GO_FAIL:-0}" = "1" ]; then
    exit 1
fi
out=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then
        out="$2"
        shift 2
    else
        shift
    fi
done
[ -n "$out" ] || exit 2
sha="$(git rev-parse HEAD)"
printf 'binary:%s\n' "$sha" > "$out"
chmod 0755 "$out"
printf '%s\n' "$sha" >> "${MOCK_GO_LOG:?}"
EOF

    cat > "$MOCK_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
    restart)
        count=0
        if [ -f "${MOCK_RESTART_STATE:?}" ]; then
            count="$(cat "$MOCK_RESTART_STATE")"
        fi
        count=$((count + 1))
        printf '%s\n' "$count" > "$MOCK_RESTART_STATE"
        if [ "${MOCK_RESTART_FAIL_FIRST:-0}" = "1" ] && [ "$count" -eq 1 ]; then
            exit 1
        fi
        ;;
    is-active)
        exit 0
        ;;
esac
EOF

    cat > "$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f "${MOCK_RESTART_STATE:?}" ]; then
    count="$(cat "$MOCK_RESTART_STATE")"
fi
if [ "${MOCK_HEALTH_FAIL_FIRST_RESTART:-0}" = "1" ] && [ "$count" -lt 2 ]; then
    exit 22
fi
if [ "${MOCK_HEALTH_DEGRADED_FIRST_RESTART:-0}" = "1" ] && [ "$count" -lt 2 ]; then
    printf '%s\n' '{"status":"degraded","db_connected":false}'
    exit 0
fi
printf '%s\n' '{"status":"ok","db_connected":true}'
exit 0
EOF

    cat > "$MOCK_BIN/pgrep" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

    cat > "$MOCK_BIN/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

    cat > "$MOCK_BIN/flock" <<'EOF'
#!/usr/bin/env bash
if [ "${MOCK_LOCK_BUSY:-0}" = "1" ]; then
    exit 1
fi
exit 0
EOF

    chmod +x "$MOCK_BIN/go" "$MOCK_BIN/systemctl" "$MOCK_BIN/curl" \
        "$MOCK_BIN/pgrep" "$MOCK_BIN/chown" "$MOCK_BIN/flock"
}

make_fixture() {
    local name="$1"
    FIXTURE="$TMP_ROOT/$name"
    REMOTE="$FIXTURE/remote.git"
    AUTHOR="$FIXTURE/author"
    SOURCE="$FIXTURE/source"
    INSTALL_DIR="$FIXTURE/opt"
    INSTALL_BIN="$FIXTURE/bin/aurora"
    UPDATER_BIN="$FIXTURE/bin/aurora-update"
    STATUS_FILE="$FIXTURE/state/update-status.json"
    MARKER_FILE="$FIXTURE/state/deployed-revision"
    LOG_FILE="$FIXTURE/log/update.log"
    LOCK_FILE="$FIXTURE/lock/deploy.lock"
    RECOVERY_MARKER="$FIXTURE/state/db-recovery-pending"
    GO_LOG="$FIXTURE/go-builds.log"
    RESTART_STATE="$FIXTURE/restarts"

    mkdir -p "$FIXTURE"
    git init --bare -q "$REMOTE"
    git init -q "$AUTHOR"
    git -C "$AUTHOR" config user.name updater-test
    git -C "$AUTHOR" config user.email updater-test@example.invalid

    mkdir -p "$AUTHOR/scripts" "$AUTHOR/static/v2" \
        "$AUTHOR/migrations" "$AUTHOR/cmd/aurora"
    cp "$UPDATER_SCRIPT" "$AUTHOR/scripts/aurora-update.sh"
    printf '%s\n' '#!/usr/bin/env bash' '# fixture public bootstrap' \
        > "$AUTHOR/install.sh"
    chmod 0755 "$AUTHOR/install.sh"
    printf 'one\n' > "$AUTHOR/release.txt"
    printf 'static-one\n' > "$AUTHOR/static/v2/index.html"
    printf '%s\n' '-- migration one' > "$AUTHOR/migrations/001.up.sql"
    printf 'package main\n' > "$AUTHOR/cmd/aurora/main.go"
    git -C "$AUTHOR" add .
    git -C "$AUTHOR" commit -qm 'release one'
    git -C "$AUTHOR" branch -M main
    git -C "$AUTHOR" remote add origin "file://$REMOTE"
    git -C "$AUTHOR" push -qu origin main
    SHA_ONE="$(git -C "$AUTHOR" rev-parse HEAD)"

    git clone -q --depth 1 --single-branch --branch main \
        "file://$REMOTE" "$SOURCE"

    mkdir -p "$(dirname "$INSTALL_BIN")" "$INSTALL_DIR/static/v2" \
        "$INSTALL_DIR/migrations" "$(dirname "$STATUS_FILE")" \
        "$(dirname "$LOG_FILE")" "$(dirname "$LOCK_FILE")"
    printf 'binary-old\n' > "$INSTALL_BIN"
    chmod 0755 "$INSTALL_BIN"
    printf 'static-old\n' > "$INSTALL_DIR/static/v2/index.html"
    printf '%s\n' '-- migration old' > "$INSTALL_DIR/migrations/001.up.sql"
}

publish_second_release() {
    printf 'two\n' > "$AUTHOR/release.txt"
    printf 'static-two\n' > "$AUTHOR/static/v2/index.html"
    printf '%s\n' '-- migration two' > "$AUTHOR/migrations/001.up.sql"
    git -C "$AUTHOR" add .
    git -C "$AUTHOR" commit -qm 'release two'
    git -C "$AUTHOR" push -q origin main
    SHA_TWO="$(git -C "$AUTHOR" rev-parse HEAD)"
}

run_updater() {
    env \
        PATH="$MOCK_BIN:$ORIGINAL_PATH" \
        AURORA_SOURCE_DIR="$SOURCE" \
        AURORA_UPDATE_BRANCH="${TEST_BRANCH:-main}" \
        AURORA_EXPECTED_REMOTE="file://$REMOTE" \
        AURORA_UPDATE_REQUIRE_SIGNED=false \
        AURORA_UPDATE_ALLOW_LOCAL_REMOTE=true \
        AURORA_ENV_FILE="$FIXTURE/no-env" \
        AURORA_UPDATE_STATUS_FILE="$STATUS_FILE" \
        AURORA_DEPLOYED_REV_FILE="$MARKER_FILE" \
        AURORA_UPDATE_LOG_FILE="$LOG_FILE" \
        AURORA_INSTALL_BIN="$INSTALL_BIN" \
        AURORA_UPDATER_BIN="$UPDATER_BIN" \
        AURORA_INSTALL_DIR="$INSTALL_DIR" \
        AURORA_UPDATE_LOCK_FILE="$LOCK_FILE" \
        AURORA_DB_RECOVERY_MARKER="$RECOVERY_MARKER" \
        AURORA_GO_BIN_DIR="$FIXTURE/no-go-bin" \
        AURORA_NODE_BIN_DIR="$FIXTURE/no-node-bin" \
        AURORA_HEALTH_ATTEMPTS=2 \
        AURORA_HEALTH_INTERVAL=0 \
        AURORA_HEALTH_MAX_TIME=1 \
        AURORA_DRAIN_MAX=0 \
        MOCK_GO_LOG="$GO_LOG" \
        MOCK_RESTART_STATE="$RESTART_STATE" \
        "$@" \
        bash "$UPDATER_SCRIPT"
}

test_pending_database_recovery_blocks_before_source_inspection() {
    make_fixture pending-db-recovery
    publish_second_release
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"
    printf 'stale updater\n' > "$UPDATER_BIN"
    printf '%s\n' 'durable recovery state' > "$RECOVERY_MARKER"
    tracking_before="$(git -C "$SOURCE" rev-parse refs/remotes/origin/main)"

    if run_updater; then
        fail "pending PostgreSQL recovery unexpectedly allowed an update"
    fi
    assert_eq misconfigured "$(status_state "$STATUS_FILE")" \
        "pending PostgreSQL recovery reports a blocked updater"
    assert_eq "$tracking_before" \
        "$(git -C "$SOURCE" rev-parse refs/remotes/origin/main)" \
        "pending recovery blocks before git fetch"
    assert_file_contains "$UPDATER_BIN" "stale updater" \
        "pending recovery blocks updater self-refresh"
    [ ! -e "$GO_LOG" ] || [ ! -s "$GO_LOG" ] \
        || fail "pending recovery reached root build"
}

test_missing_marker_forces_deploy_and_noop_refreshes_updater() {
    make_fixture missing-marker

    run_updater
    assert_eq "$SHA_ONE" "$(tr -d '[:space:]' < "$MARKER_FILE")" \
        "missing marker is written only after deployment health"
    assert_file_contains "$INSTALL_BIN" "binary:$SHA_ONE" \
        "missing marker forces a real binary build"
    assert_file_contains "$INSTALL_DIR/static/install.sh" \
        "fixture public bootstrap" \
        "deployment stages the required public installer endpoint"
    assert_eq success "$(status_state "$STATUS_FILE")" \
        "forced deployment reports success"

    printf 'stale updater\n' > "$UPDATER_BIN"
    : > "$GO_LOG"
    rm -f "$RESTART_STATE"
    run_updater
    [ ! -s "$GO_LOG" ] || fail "no-op updater refresh unexpectedly rebuilt Aurora"
    cmp -s "$UPDATER_BIN" "$SOURCE/scripts/aurora-update.sh" \
        || fail "no-op run did not refresh the installed updater"
    assert_eq idle "$(status_state "$STATUS_FILE")" \
        "current deployment reports idle"
}

test_failed_build_retries_checked_out_revision() {
    make_fixture build-retry
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"
    publish_second_release

    if run_updater MOCK_GO_FAIL=1; then
        fail "failed Go build unexpectedly succeeded"
    fi
    assert_eq "$SHA_TWO" "$(git -C "$SOURCE" rev-parse HEAD)" \
        "failed build leaves source at fetched revision for retry"
    assert_eq "$SHA_ONE" "$(tr -d '[:space:]' < "$MARKER_FILE")" \
        "failed build does not advance deployed marker"
    assert_file_contains "$INSTALL_BIN" "binary-old" \
        "failed build leaves installed binary untouched"

    run_updater
    assert_eq "$SHA_TWO" "$(tr -d '[:space:]' < "$MARKER_FILE")" \
        "retry advances marker after health"
    assert_file_contains "$INSTALL_BIN" "binary:$SHA_TWO" \
        "retry deploys the already-checked-out revision"
}

test_health_failure_rolls_back_then_retries() {
    make_fixture health-rollback
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"
    publish_second_release

    if run_updater MOCK_HEALTH_FAIL_FIRST_RESTART=1; then
        fail "unhealthy release unexpectedly succeeded"
    fi
    assert_eq "$SHA_ONE" "$(tr -d '[:space:]' < "$MARKER_FILE")" \
        "health failure keeps deployed marker on prior release"
    assert_file_contains "$INSTALL_BIN" "binary-old" \
        "health failure restores prior binary"
    assert_file_contains "$INSTALL_DIR/static/v2/index.html" "static-old" \
        "health failure restores prior static bundle"
    assert_file_contains "$INSTALL_DIR/migrations/001.up.sql" "migration old" \
        "health failure restores prior migration files"
    assert_file_contains "${INSTALL_BIN}.failed" "binary:$SHA_TWO" \
        "health failure preserves bad binary for inspection"

    rm -f "$RESTART_STATE"
    run_updater
    assert_eq "$SHA_TWO" "$(tr -d '[:space:]' < "$MARKER_FILE")" \
        "post-rollback retry advances marker"
    assert_file_contains "$INSTALL_BIN" "binary:$SHA_TWO" \
        "post-rollback retry deploys release"
}

test_http_200_degraded_health_rolls_back() {
    make_fixture degraded-health-rollback
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"
    publish_second_release

    if run_updater MOCK_HEALTH_DEGRADED_FIRST_RESTART=1; then
        fail "HTTP-200 degraded release unexpectedly succeeded"
    fi
    assert_eq "$SHA_ONE" "$(tr -d '[:space:]' < "$MARKER_FILE")" \
        "HTTP-200 degraded health does not advance deployed marker"
    assert_file_contains "$INSTALL_BIN" "binary-old" \
        "HTTP-200 degraded health restores prior binary"
    assert_eq 2 "$(tr -d '[:space:]' < "$RESTART_STATE")" \
        "HTTP-200 degraded health triggers a rollback restart"
    assert_eq failed "$(status_state "$STATUS_FILE")" \
        "HTTP-200 degraded health reports failed update"
}

test_remote_rewind_is_refused_without_building() {
    make_fixture rewind
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"
    publish_second_release
    run_updater

    git -C "$AUTHOR" reset -q --hard "$SHA_ONE"
    git -C "$AUTHOR" push -q --force origin main
    : > "$GO_LOG"
    rm -f "$RESTART_STATE"

    if run_updater; then
        fail "remote rewind unexpectedly deployed"
    fi
    [ ! -s "$GO_LOG" ] || fail "remote rewind reached the build step"
    assert_eq "$SHA_TWO" "$(git -C "$SOURCE" rev-parse HEAD)" \
        "remote rewind does not move source checkout"
    assert_eq "$SHA_TWO" "$(tr -d '[:space:]' < "$MARKER_FILE")" \
        "remote rewind does not falsify deployed marker"
    assert_eq failed "$(status_state "$STATUS_FILE")" \
        "remote rewind reports failed reconciliation"
}

test_single_branch_clone_fetches_explicit_tracking_ref() {
    make_fixture branch-switch
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"

    git -C "$AUTHOR" checkout -qb release
    printf 'release-branch\n' > "$AUTHOR/release.txt"
    git -C "$AUTHOR" add release.txt
    git -C "$AUTHOR" commit -qm 'release branch'
    git -C "$AUTHOR" push -qu origin release
    SHA_RELEASE="$(git -C "$AUTHOR" rev-parse HEAD)"

    TEST_BRANCH=release run_updater
    assert_eq "$SHA_RELEASE" "$(git -C "$SOURCE" rev-parse origin/release)" \
        "explicit fetch creates tracking ref absent from single-branch clone"
    assert_eq "$SHA_RELEASE" "$(tr -d '[:space:]' < "$MARKER_FILE")" \
        "branch switch deploys fetched release revision"
}

test_untracked_source_is_never_built_as_root() {
    make_fixture untracked
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"
    publish_second_release
    printf 'package surprise\n' > "$SOURCE/evil.go"

    if run_updater; then
        fail "non-ignored untracked source unexpectedly deployed"
    fi
    [ ! -e "$GO_LOG" ] || [ ! -s "$GO_LOG" ] \
        || fail "untracked source reached the root build step"
    assert_eq "$SHA_ONE" "$(git -C "$SOURCE" rev-parse HEAD)" \
        "untracked source prevents checkout mutation"
    assert_eq "$SHA_ONE" "$(tr -d '[:space:]' < "$MARKER_FILE")" \
        "untracked source does not advance marker"
}

test_writable_managed_source_is_rejected_before_git() {
    make_fixture writable-source
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"
    chmod g+w "$SOURCE/release.txt"

    if run_updater; then
        fail "group-writable managed source unexpectedly reached the updater"
    fi
    assert_eq misconfigured "$(status_state "$STATUS_FILE")" \
        "writable managed source reports misconfigured"
    [ ! -e "$GO_LOG" ] || [ ! -s "$GO_LOG" ] \
        || fail "writable managed source reached root build"
    assert_eq "$SHA_ONE" "$(git -C "$SOURCE" rev-parse HEAD)" \
        "writable managed source is rejected before Git mutation"
}

test_busy_installer_lock_skips_before_fetch_or_self_refresh() {
    make_fixture lock-busy
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"
    publish_second_release
    printf 'do-not-replace\n' > "$UPDATER_BIN"
    printf '%s\n' '{"state":"checking","message":"active deployment"}' \
        > "$STATUS_FILE"
    STATUS_BEFORE="$(cat "$STATUS_FILE")"

    run_updater MOCK_LOCK_BUSY=1
    assert_eq "$SHA_ONE" "$(git -C "$SOURCE" rev-parse origin/main)" \
        "busy deploy lock prevents fetch from mutating tracking refs"
    assert_file_contains "$UPDATER_BIN" "do-not-replace" \
        "busy deploy lock prevents updater self-refresh"
    [ ! -e "$GO_LOG" ] || [ ! -s "$GO_LOG" ] \
        || fail "busy deploy lock reached root build"
    assert_eq "$STATUS_BEFORE" "$(cat "$STATUS_FILE")" \
        "busy deploy lock preserves active deployment status byte-for-byte"
}

test_local_origin_requires_explicit_opt_in() {
    make_fixture local-origin-opt-in
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"

    if run_updater AURORA_UPDATE_ALLOW_LOCAL_REMOTE=false; then
        fail "local updater origin unexpectedly worked without explicit opt-in"
    fi
    assert_eq misconfigured "$(status_state "$STATUS_FILE")" \
        "local updater origin without opt-in reports misconfigured"
    [ ! -e "$GO_LOG" ] || [ ! -s "$GO_LOG" ] \
        || fail "rejected local origin reached root build"
}

test_invalid_signing_policy_is_rejected() {
    make_fixture invalid-signing-policy
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"

    if run_updater AURORA_UPDATE_REQUIRE_SIGNED=tru; then
        fail "invalid signing policy unexpectedly failed open"
    fi
    assert_eq misconfigured "$(status_state "$STATUS_FILE")" \
        "invalid signing policy reports misconfigured"
}

test_signed_noop_does_not_self_refresh_unsigned_updater() {
    make_fixture signed-noop
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"
    printf 'do-not-install-unsigned-updater\n' > "$UPDATER_BIN"

    if run_updater AURORA_UPDATE_REQUIRE_SIGNED=true; then
        fail "unsigned no-op revision unexpectedly passed signed-update policy"
    fi
    assert_file_contains "$UPDATER_BIN" "do-not-install-unsigned-updater" \
        "signed no-op policy blocks updater self-refresh"
    assert_eq failed "$(status_state "$STATUS_FILE")" \
        "unsigned no-op revision reports failed verification"
}

test_signers_file_inside_source_is_rejected() {
    make_fixture signers-inside-source
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"
    printf 'maintainer ssh-ed25519 AAAAinvalid\n' > "$SOURCE/allowed_signers"
    chmod 0600 "$SOURCE/allowed_signers"

    if run_updater \
        AURORA_UPDATE_REQUIRE_SIGNED=true \
        AURORA_UPDATE_ALLOWED_SIGNERS="$SOURCE/allowed_signers"; then
        fail "managed-source allowed-signers file was trusted"
    fi
    assert_eq misconfigured "$(status_state "$STATUS_FILE")" \
        "managed-source trust root reports misconfigured"
}

test_colon_in_local_path_is_not_treated_as_ssh() {
    make_fixture local-colon-origin
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"
    COLON_REMOTE="$FIXTURE/remote:colon.git"
    mv "$REMOTE" "$COLON_REMOTE"
    REMOTE="$COLON_REMOTE"
    git -C "$SOURCE" remote set-url origin "$COLON_REMOTE"

    if run_updater \
        AURORA_EXPECTED_REMOTE="$COLON_REMOTE" \
        AURORA_UPDATE_ALLOW_LOCAL_REMOTE=false; then
        fail "colon-bearing local path bypassed local-origin rejection"
    fi
    assert_eq misconfigured "$(status_state "$STATUS_FILE")" \
        "colon-bearing local path reports misconfigured without opt-in"
    [ ! -e "$GO_LOG" ] || [ ! -s "$GO_LOG" ] \
        || fail "colon-bearing local path reached root build"
}

test_credential_bearing_https_origin_is_rejected_without_leak() {
    make_fixture credential-origin
    printf '%s\n' "$SHA_ONE" > "$MARKER_FILE"
    SECRET_MARKER="github_pat_do_not_log_123"
    SECRET_REMOTE="https://${SECRET_MARKER}@github.com/owner/repo.git"
    git -C "$SOURCE" remote set-url origin "$SECRET_REMOTE"

    if run_updater AURORA_EXPECTED_REMOTE="$SECRET_REMOTE"; then
        fail "credential-bearing HTTPS origin unexpectedly passed validation"
    fi
    assert_eq misconfigured "$(status_state "$STATUS_FILE")" \
        "credential-bearing HTTPS origin reports misconfigured"
    if grep -Fq "$SECRET_MARKER" "$STATUS_FILE" "$LOG_FILE"; then
        fail "credential-bearing HTTPS origin leaked into updater status/log"
    fi
}

make_mocks
test_pending_database_recovery_blocks_before_source_inspection
test_missing_marker_forces_deploy_and_noop_refreshes_updater
test_single_branch_clone_fetches_explicit_tracking_ref
test_untracked_source_is_never_built_as_root
test_writable_managed_source_is_rejected_before_git
test_busy_installer_lock_skips_before_fetch_or_self_refresh
test_local_origin_requires_explicit_opt_in
test_invalid_signing_policy_is_rejected
test_signed_noop_does_not_self_refresh_unsigned_updater
test_signers_file_inside_source_is_rejected
test_colon_in_local_path_is_not_treated_as_ssh
test_credential_bearing_https_origin_is_rejected_without_leak
test_failed_build_retries_checked_out_revision
test_health_failure_rolls_back_then_retries
test_http_200_degraded_health_rolls_back
test_remote_rewind_is_refused_without_building

printf 'updater state tests: PASS\n'
