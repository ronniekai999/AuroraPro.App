#!/usr/bin/env bash
# Aurora Media Server — Auto-updater workhorse.
#
# Pulls latest commits from origin/<branch>, rebuilds the binary,
# atomically swaps the static SPA bundle + migrations, and restarts
# the systemd service. Designed to be called by either:
#
#   - aurora-update.timer (every 5 min) — the periodic auto-update
#   - aurora-update.path watching /var/lib/aurora/trigger-update —
#     the admin UI's "Update Now" button, which writes a timestamp
#     to that file. systemd (PID 1) starts this service in response
#     to the PathChanged= event, so no sudo/NOPASSWD grant is
#     required on the aurora user.
#
# Performance contract: when there's nothing new upstream, exits
# in <1 s (just a `git fetch` + HEAD compare + status write). The
# heavy lifting only runs when origin has commits we don't.
#
# Status reporting: every phase writes a JSON document to
# /var/lib/aurora/update-status.json. The admin UI polls
# GET /api/admin/system/update/status, which just reads that file
# and forwards it. State transitions:
#
#   idle → checking → updating → building → installing → restarting
#                                                       → success
#                                                       → failed
#
# Safety:
#   - Refuses to update if the working tree is dirty (would lose work).
#   - Refuses non-fast-forward merges (would require conflict
#     resolution we can't automate).
#   - On build failure, leaves the running binary untouched.
#   - On post-restart health-check failure, restores the previous
#     binary/static snapshot and leaves status=failed for inspection.
#
# Concurrency: systemd's Type=oneshot serializes invocations, so
# even if the timer fires while a manual button-click is running,
# the second invocation is a no-op (or queues, depending on the
# unit's RefuseManualStart setting).

set -Eeuo pipefail

# ── Read updater settings without sourcing application secrets ────
# The application env also contains the database password, JWT signing secret,
# and third-party API tokens. The updater builds fetched code as root, so those
# values must not be exported into npm/go subprocesses. Parse only the five
# updater-specific keys as inert KEY=value data; never source/eval the file.
ENV_FILE="${AURORA_ENV_FILE:-/etc/aurora/aurora.env}"
read_env_key() {
    local key="$1"
    [ -f "$ENV_FILE" ] || return 1
    ENV_KEY="$key" awk '
        BEGIN { prefix = ENVIRON["ENV_KEY"] "=" }
        index($0, prefix) == 1 {
            print substr($0, length(prefix) + 1)
            found = 1
            exit
        }
        END { if (!found) exit 1 }
    ' "$ENV_FILE"
}

AURORA_SOURCE_DIR="${AURORA_SOURCE_DIR:-$(read_env_key AURORA_SOURCE_DIR 2>/dev/null || true)}"
AURORA_UPDATE_BRANCH="${AURORA_UPDATE_BRANCH:-$(read_env_key AURORA_UPDATE_BRANCH 2>/dev/null || true)}"
AURORA_EXPECTED_REMOTE="${AURORA_EXPECTED_REMOTE:-$(read_env_key AURORA_EXPECTED_REMOTE 2>/dev/null || true)}"
AURORA_UPDATE_REQUIRE_SIGNED="${AURORA_UPDATE_REQUIRE_SIGNED:-$(read_env_key AURORA_UPDATE_REQUIRE_SIGNED 2>/dev/null || true)}"
AURORA_UPDATE_ALLOWED_SIGNERS="${AURORA_UPDATE_ALLOWED_SIGNERS:-$(read_env_key AURORA_UPDATE_ALLOWED_SIGNERS 2>/dev/null || true)}"

strip_outer_quotes() {
    local value="$1"
    case "$value" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    printf '%s\n' "$value"
}
AURORA_SOURCE_DIR="$(strip_outer_quotes "$AURORA_SOURCE_DIR")"
AURORA_UPDATE_BRANCH="$(strip_outer_quotes "$AURORA_UPDATE_BRANCH")"
AURORA_EXPECTED_REMOTE="$(strip_outer_quotes "$AURORA_EXPECTED_REMOTE")"
AURORA_UPDATE_REQUIRE_SIGNED="$(strip_outer_quotes "$AURORA_UPDATE_REQUIRE_SIGNED")"
AURORA_UPDATE_ALLOWED_SIGNERS="$(strip_outer_quotes "$AURORA_UPDATE_ALLOWED_SIGNERS")"

SOURCE_DIR="$AURORA_SOURCE_DIR"
BRANCH="${AURORA_UPDATE_BRANCH:-main}"
STATUS_FILE="${AURORA_UPDATE_STATUS_FILE:-/var/lib/aurora/update-status.json}"
DEPLOYED_REV_FILE="${AURORA_DEPLOYED_REV_FILE:-/var/lib/aurora/deployed-revision}"
LOG_FILE="${AURORA_UPDATE_LOG_FILE:-/var/log/aurora-installer/update.log}"
INSTALL_BIN="${AURORA_INSTALL_BIN:-/usr/local/bin/aurora}"
UPDATER_BIN="${AURORA_UPDATER_BIN:-/usr/local/bin/aurora-update}"
INSTALL_DIR="${AURORA_INSTALL_DIR:-/opt/aurora}"
LOCK_FILE="${AURORA_UPDATE_LOCK_FILE:-/run/aurora/deploy.lock}"
DB_RECOVERY_MARKER="${AURORA_DB_RECOVERY_MARKER:-/usr/local/lib/aurora-installer/db-recovery-pending}"
HEALTH_URL="${AURORA_HEALTH_URL:-http://localhost:8484/api/health}"
HEALTH_ATTEMPTS="${AURORA_HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL="${AURORA_HEALTH_INTERVAL:-1}"
HEALTH_MAX_TIME="${AURORA_HEALTH_MAX_TIME:-2}"
ALLOW_LOCAL_REMOTE="${AURORA_UPDATE_ALLOW_LOCAL_REMOTE:-false}"
SPA_SRC_DIR=static/redesign/app
SPA_OUTPUT_DIR=static/v2

# Mutable deployment state used by the ERR/signal/EXIT traps. Keep these
# initialized before any fallible setup so cleanup is safe under `set -u`.
LOCK_HELD=false
WORK_TMP=""
DEPLOYMENT_SWAPPED=false
ROLLBACK_ATTEMPTED=false
STATIC_SWAP_STARTED=false
MIGRATIONS_SWAP_STARTED=false
BIN_SWAP_STARTED=false
HAD_BIN=false
HAD_STATIC=false
HAD_MIGRATIONS=false
OLD_SHA=""
NEW_SHA=""

BIN_SNAPSHOT="${INSTALL_BIN}.prev"
STATIC_SNAPSHOT="${INSTALL_DIR}/static.old"
MIGRATIONS_SNAPSHOT="${INSTALL_DIR}/migrations.old"

mkdir -p "$(dirname "$STATUS_FILE")"
LOG_DIR="$(dirname "$LOG_FILE")"
if [ -L "$LOG_DIR" ]; then
    echo "FATAL: updater log directory is a symlink: $LOG_DIR" >&2
    exit 1
fi
mkdir -p "$LOG_DIR"
chmod 0700 "$LOG_DIR"
if [ "$(id -u)" -eq 0 ]; then
    chown root:root "$LOG_DIR"
fi
if [ -L "$LOG_FILE" ] || { [ -e "$LOG_FILE" ] && [ ! -f "$LOG_FILE" ]; }; then
    echo "FATAL: updater log path is not a regular file: $LOG_FILE" >&2
    exit 1
fi
touch "$LOG_FILE"
chmod 0600 "$LOG_FILE"

# Make Go visible to this systemd-spawned shell. Profile.d isn't
# sourced by systemd-launched processes, so we re-establish the
# PATH here. /usr/local/go/bin is the official Go install location
# (install.sh's install_go function puts the toolchain there).
GO_BIN_DIR="${AURORA_GO_BIN_DIR:-/usr/local/go/bin}"
[ -d "$GO_BIN_DIR" ] && export PATH="$GO_BIN_DIR:$PATH"
# Aurora's pinned Node toolchain intentionally has no global symlinks.
NODE_BIN_DIR="${AURORA_NODE_BIN_DIR:-/usr/local/lib/aurora-node/bin}"
[ -d "$NODE_BIN_DIR" ] && export PATH="$NODE_BIN_DIR:$PATH"

# 2026-05-20 — explicitly set HOME if unset. systemd doesn't
# propagate HOME for system services by default, which breaks two
# things:
#   1. `git credential-store` (configured by install.sh) needs
#      $HOME or the EXPLICIT --file= form. install.sh now uses
#      the explicit form, so this is belt-and-suspenders.
#   2. `go build` falls back to $HOME/go/pkg/mod for GOMODCACHE
#      and errors with "module cache not found: neither GOMODCACHE
#      nor GOPATH is set" when HOME is unset.
#
# Setting HOME here makes the script work regardless of how the
# systemd unit was configured — important because the unit file
# is exactly what the auto-updater would need to be ABLE to
# update, creating a chicken-and-egg loop if it broke.
[ -z "${HOME:-}" ] && export HOME=/root

# Audit H2 — sanity-check the python3 prerequisite up front. The
# write_status function below depends on python3 for JSON-safe
# message encoding; if it's missing, every status write would
# silently fail and the admin UI would never escape "unknown"
# state. Belt-and-suspenders since install.sh now adds it to the
# package-prereq list — this catches custom installs.
if ! command -v python3 >/dev/null 2>&1; then
    echo "FATAL: python3 not found — aurora-update.sh needs it for JSON status encoding." >&2
    echo "Install with your package manager (apt install python3 / dnf install python3) and re-run." >&2
    exit 1
fi

# ── JSON status helpers ───────────────────────────────────────────
# write_status STATE MESSAGE [OLD_SHA] [NEW_SHA]
#
# We use python3 for JSON encoding because message can contain
# quotes / backslashes / newlines (build output, error text) that
# bash heredocs / printf would mangle. jq isn't an install.sh
# prerequisite, so python3 is the safer choice.
#
# Audit H1 — values are passed via environment variables (not
# heredoc interpolation), the heredoc delimiter is single-quoted
# ('PY' rather than PY), and the Python source contains NO shell
# expansions. Bash sees the heredoc as opaque bytes; python sees
# its own source verbatim and reads the values via os.environ.
# This closes the (theoretical) shell-injection sink that the
# previous unquoted heredoc had if a SHA or message ever contained
# `$()` or backticks.
#
# Write to .tmp then rename so concurrent readers (the admin UI
# poll) never see a half-written file.
write_status() {
    local state="$1" message="$2" old="${3:-}" new="${4:-}"
    local ts
    ts="$(date -u +%FT%TZ)"
    STATE="$state" \
    AT="$ts" \
    MESSAGE="$message" \
    OLD_SHA_ENV="$old" \
    NEW_SHA_ENV="$new" \
    python3 <<'PY' > "$STATUS_FILE.tmp"
import json, os
print(json.dumps({
    "state":   os.environ["STATE"],
    "at":      os.environ["AT"],
    "message": os.environ["MESSAGE"],
    # Empty env strings → JSON null. Treating "" and unset the same
    # way avoids "null"-as-a-string footguns in the SPA's TS types.
    "old_sha": os.environ["OLD_SHA_ENV"] or None,
    "new_sha": os.environ["NEW_SHA_ENV"] or None,
}))
PY
    mv "$STATUS_FILE.tmp" "$STATUS_FILE"
    if [ "$(id -u)" -eq 0 ] && getent group aurora >/dev/null 2>&1; then
        chown root:aurora "$STATUS_FILE"
    fi
    chmod 0640 "$STATUS_FILE"
}

log() {
    printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$1" | tee -a "$LOG_FILE"
}

build_frontend_bundle() {
    local out_dir="$1"
    if [ ! -d "$SPA_SRC_DIR" ]; then
        log "WARN: $SPA_SRC_DIR missing; reusing committed $SPA_OUTPUT_DIR"
        if [ ! -d "$SPA_OUTPUT_DIR" ]; then
            log "No SPA source or committed $SPA_OUTPUT_DIR bundle found"
            return 1
        fi
        rm -rf "$out_dir"
        mkdir -p "$(dirname "$out_dir")"
        cp -R "$SPA_OUTPUT_DIR" "$out_dir"
        return 0
    fi
    if ! command -v npm >/dev/null 2>&1; then
        log "npm not found; install Node.js/npm or re-run install.sh"
        return 1
    fi

    rm -rf "$out_dir"
    mkdir -p "$(dirname "$out_dir")"
    if [ -f "$SPA_SRC_DIR/package-lock.json" ]; then
        log "npm ci..."
        (cd "$SPA_SRC_DIR" && npm ci --no-audit --no-fund >>"$LOG_FILE" 2>&1)
    else
        log "npm install..."
        (cd "$SPA_SRC_DIR" && npm install --no-audit --no-fund >>"$LOG_FILE" 2>&1)
    fi
    log "vite build..."
    (cd "$SPA_SRC_DIR" && npm run build -- --outDir "$out_dir" >>"$LOG_FILE" 2>&1)
}

stage_static_bundle() {
    local built_v2_dir="$1"
    rm -rf "$INSTALL_DIR/static.new"
    mkdir -p "$INSTALL_DIR/static.new"
    if [ -d static ]; then
        if ! (
            shopt -s nullglob dotglob
            for entry in static/*; do
                case "${entry##*/}" in
                    redesign|v2) continue ;;
                esac
                cp -R "$entry" "$INSTALL_DIR/static.new/" || exit 1
            done
        ); then
            log "failed to stage committed static assets"
            return 1
        fi
    fi
    if [ ! -f install.sh ] \
        || ! install -m 0644 install.sh "$INSTALL_DIR/static.new/install.sh"; then
        log "failed to stage the public installer endpoint"
        return 1
    fi
    cp -R "$built_v2_dir" "$INSTALL_DIR/static.new/v2"
}

# Refresh the installed updater from a revision that has already been accepted
# as deployed. This runs on both successful deployments and no-op checks so a
# transient write failure does not strand an old updater until the next app
# release.
refresh_updater() {
    local source_path="scripts/aurora-update.sh" source_tmp
    if ! source_tmp="$(mktemp)"; then
        log "WARN: could not create a temporary file for updater refresh"
        return 1
    fi
    if ! git show "${NEW_SHA}:${source_path}" > "$source_tmp" 2>>"$LOG_FILE"; then
        rm -f "$source_tmp"
        log "WARN: $source_path is missing from $NEW_SHA; kept the current updater"
        return 1
    fi
    if ! bash -n "$source_tmp"; then
        rm -f "$source_tmp"
        log "WARN: $source_path has invalid shell syntax at $NEW_SHA; kept the current updater"
        return 1
    fi
    if [ -f "$UPDATER_BIN" ] && cmp -s "$source_tmp" "$UPDATER_BIN"; then
        rm -f "$source_tmp"
        return 0
    fi
    if install -m 0755 "$source_tmp" "${UPDATER_BIN}.new" \
        && mv -f "${UPDATER_BIN}.new" "$UPDATER_BIN"; then
        rm -f "$source_tmp"
        log "auto-updater executable refreshed from ${NEW_SHA:-accepted source revision}"
        return 0
    fi
    rm -f "$source_tmp" "${UPDATER_BIN}.new"
    log "WARN: could not refresh $UPDATER_BIN; the next updater run will retry"
    return 1
}

wait_for_aurora_health() {
    local attempt
    for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
        if systemctl is-active --quiet aurora \
            && strict_aurora_health; then
            return 0
        fi
        if [ "$attempt" -lt "$HEALTH_ATTEMPTS" ]; then
            sleep "$HEALTH_INTERVAL"
        fi
    done
    return 1
}

# A 200 response only proves the HTTP handler ran. Aurora is deployable only
# when the health document says the application is ready and its database
# connection is live.
strict_aurora_health() {
    curl -fsS --connect-timeout "$HEALTH_MAX_TIME" \
        --max-time "$HEALTH_MAX_TIME" "$HEALTH_URL" 2>/dev/null |
        python3 -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)

healthy = (
    isinstance(payload, dict)
    and payload.get("status") == "ok"
    and payload.get("db_connected") is True
)
raise SystemExit(0 if healthy else 1)
' >/dev/null 2>&1
}

acquire_deploy_lock() {
    if ! command -v flock >/dev/null 2>&1; then
        write_status misconfigured "flock is required for safe updater/installer coordination. Install util-linux and retry." "$OLD_SHA"
        log "flock not found — refusing to update without cross-script coordination"
        exit 1
    fi
    if ! python3 - "$LOCK_FILE" >>"$LOG_FILE" 2>&1 <<'PY'
import os
import stat
import sys

path = os.path.abspath(sys.argv[1])
parent = os.path.dirname(path)
expected_uid = os.geteuid()

if os.path.lexists(parent) and os.path.islink(parent):
    raise SystemExit(f"lock directory is a symlink: {parent}")
os.makedirs(parent, mode=0o755, exist_ok=True)
parent_stat = os.stat(parent)
if not stat.S_ISDIR(parent_stat.st_mode):
    raise SystemExit(f"lock parent is not a directory: {parent}")
if parent_stat.st_uid != expected_uid or parent_stat.st_mode & 0o022:
    raise SystemExit(f"lock directory is not exclusively managed: {parent}")

flags = os.O_WRONLY | os.O_CREAT | os.O_CLOEXEC
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
fd = os.open(path, flags, 0o644)
try:
    lock_stat = os.fstat(fd)
    if not stat.S_ISREG(lock_stat.st_mode):
        raise SystemExit(f"lock path is not a regular file: {path}")
    if lock_stat.st_uid != expected_uid:
        raise SystemExit(f"lock file has an unexpected owner: {path}")
    os.fchmod(fd, 0o644)
finally:
    os.close(fd)
PY
    then
        write_status misconfigured "Could not securely prepare deploy lock $LOCK_FILE; refusing an unlocked update." "$OLD_SHA"
        log "could not securely prepare $LOCK_FILE"
        exit 1
    fi
    # The verified parent is not writable by any other local identity, so the
    # path cannot be replaced between secure preparation and opening this FD.
    if ! exec 9>"$LOCK_FILE"; then
        write_status misconfigured "Could not open deploy lock $LOCK_FILE; refusing an unlocked update." "$OLD_SHA"
        log "could not open $LOCK_FILE on fd 9 — refusing unlocked update"
        exit 1
    fi
    if ! flock -n 9; then
        # Do not overwrite the active install/update's status document.
        log "deploy lock $LOCK_FILE held by another process — skipping this run"
        exec 9>&- 2>/dev/null || true
        exit 0
    fi
    LOCK_HELD=true
    log "acquired deploy lock $LOCK_FILE (fd 9)"
}

validate_allowed_signers_file() {
    local validation_error
    validation_error="$(
        python3 - "$AURORA_UPDATE_ALLOWED_SIGNERS" "$SOURCE_DIR" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
source = os.path.realpath(sys.argv[2])
expected_uid = os.geteuid()

def reject(message):
    print(message)
    raise SystemExit(0)

if not os.path.isabs(path):
    reject("allowed-signers path is not absolute")
if os.path.islink(path) or not os.path.isfile(path):
    reject("allowed-signers path is not a regular non-symlink file")

real = os.path.realpath(path)
try:
    if os.path.commonpath([real, source]) == source:
        reject("allowed-signers file is inside managed source")
except ValueError:
    pass

st = os.stat(real)
if st.st_uid != expected_uid or st.st_mode & 0o022:
    reject("allowed-signers file has unsafe owner or write bits")

current = os.path.dirname(real)
while True:
    lst = os.lstat(current)
    if stat.S_ISLNK(lst.st_mode):
        reject("allowed-signers ancestor is a symlink")
    if lst.st_uid not in {0, expected_uid} or lst.st_mode & 0o022:
        reject("allowed-signers ancestor has unsafe owner or write bits")
    parent = os.path.dirname(current)
    if parent == current:
        break
    current = parent
PY
    )"
    [ -z "$validation_error" ]
}

validate_opted_in_local_origin() {
    local url="$1" path validation_error
    case "$ALLOW_LOCAL_REMOTE" in
        true|1) ;;
        *)
            write_status misconfigured "Local/file Git origins are disabled for Aurora's root updater. Use an HTTPS or SSH remote; use scripts/redeploy.sh for local source deployments." "$OLD_SHA"
            log "refused local updater origin without AURORA_UPDATE_ALLOW_LOCAL_REMOTE=true"
            return 1
            ;;
    esac

    case "$url" in
        file:///*) path="${url#file://}" ;;
        file://*)
            write_status misconfigured "file:// updater origins must use a local absolute path with no remote host." "$OLD_SHA"
            log "refused non-local file URL origin"
            return 1
            ;;
        *) path="$url" ;;
    esac

    if ! validation_error="$(
        python3 - "$path" <<'PY'
import os
import stat
import sys

original = os.path.abspath(sys.argv[1])
expected_uid = os.geteuid()

if os.path.islink(original):
    raise SystemExit("origin itself is a symlink")
real = os.path.realpath(original)
if not os.path.isdir(real):
    raise SystemExit("origin is not a directory")

for root, dirs, files in os.walk(real, followlinks=False):
    for name in [".", *dirs, *files]:
        candidate = root if name == "." else os.path.join(root, name)
        st = os.lstat(candidate)
        if stat.S_ISLNK(st.st_mode):
            raise SystemExit(f"symlink found inside origin: {candidate}")
        if st.st_uid != expected_uid:
            raise SystemExit(f"non-owner path inside origin: {candidate}")
        if st.st_mode & 0o022:
            raise SystemExit(f"group/other-writable path inside origin: {candidate}")

current = real
while True:
    st = os.stat(current)
    if st.st_uid not in {0, expected_uid}:
        raise SystemExit(f"untrusted owner on origin ancestor: {current}")
    if st.st_mode & 0o022 and not (st.st_uid == 0 and st.st_mode & stat.S_ISVTX):
        raise SystemExit(f"writable origin ancestor without root sticky protection: {current}")
    parent = os.path.dirname(current)
    if parent == current:
        break
    current = parent
PY
    )"; then
        write_status misconfigured "The opted-in local Git origin is not exclusively trusted by the updater account. Use a root-owned, non-writable repository path." "$OLD_SHA"
        log "unsafe local updater origin: ${validation_error:-validation failed}"
        return 1
    fi
}

is_scp_style_ssh_remote() {
    local value="$1" authority path
    case "$value" in
        *:*)
            authority="${value%%:*}"
            path="${value#*:}"
            ;;
        *) return 1 ;;
    esac
    [ -n "$authority" ] && [ -n "$path" ] || return 1
    case "$authority" in
        */*|*\\*) return 1 ;;
    esac
    [[ "$authority" =~ ^([A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$ ]]
}

cleanup_committed_snapshots() {
    rm -f "$BIN_SNAPSHOT"
    rm -rf "$STATIC_SNAPSHOT" "$MIGRATIONS_SNAPSHOT"
    rm -rf "$INSTALL_DIR/static.failed" "$INSTALL_DIR/migrations.failed"
}

# Restore the last known-good on-disk artifacts. Every fallible operation is
# explicitly tested because this function is called from ERR and signal traps,
# where recursive `set -e` handling would otherwise obscure the real failure.
rollback_deployment() {
    local restore_ok=true restart_ok=false
    # Every caller exits after rollback. Ignore a second INT/TERM while the
    # known-good files are being restored so systemd's timeout signal cannot
    # interrupt the rollback halfway through (SIGKILL remains authoritative).
    trap '' INT TERM
    ROLLBACK_ATTEMPTED=true
    log "restoring last known-good deployment snapshots"

    if $BIN_SWAP_STARTED; then
        if [ -f "$BIN_SNAPSHOT" ]; then
            rm -f "${INSTALL_BIN}.failed"
            if [ -e "$INSTALL_BIN" ] && ! mv "$INSTALL_BIN" "${INSTALL_BIN}.failed"; then
                log "could not preserve failed binary at ${INSTALL_BIN}.failed"
                restore_ok=false
            fi
            if ! mv "$BIN_SNAPSHOT" "$INSTALL_BIN"; then
                log "could not restore binary snapshot $BIN_SNAPSHOT"
                restore_ok=false
            fi
        elif $HAD_BIN; then
            log "no binary snapshot found at $BIN_SNAPSHOT"
            restore_ok=false
        else
            rm -f "$INSTALL_BIN"
        fi
    fi

    if $STATIC_SWAP_STARTED; then
        if [ -d "$STATIC_SNAPSHOT" ]; then
            rm -rf "$INSTALL_DIR/static.failed"
            if [ -e "$INSTALL_DIR/static" ] \
                && ! mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.failed"; then
                log "could not preserve failed static bundle"
                restore_ok=false
            fi
            if ! mv "$STATIC_SNAPSHOT" "$INSTALL_DIR/static"; then
                log "could not restore static snapshot $STATIC_SNAPSHOT"
                restore_ok=false
            else
                rm -rf "$INSTALL_DIR/static.failed"
            fi
        elif $HAD_STATIC; then
            if [ -d "$INSTALL_DIR/static" ]; then
                log "static promotion had not completed; retained existing bundle"
            else
                log "no static snapshot found at $STATIC_SNAPSHOT"
                restore_ok=false
            fi
        else
            rm -rf "$INSTALL_DIR/static"
        fi
    fi

    if $MIGRATIONS_SWAP_STARTED; then
        if [ -d "$MIGRATIONS_SNAPSHOT" ]; then
            rm -rf "$INSTALL_DIR/migrations.failed"
            if [ -e "$INSTALL_DIR/migrations" ] \
                && ! mv "$INSTALL_DIR/migrations" "$INSTALL_DIR/migrations.failed"; then
                log "could not preserve failed migrations directory"
                restore_ok=false
            fi
            if ! mv "$MIGRATIONS_SNAPSHOT" "$INSTALL_DIR/migrations"; then
                log "could not restore migrations snapshot $MIGRATIONS_SNAPSHOT"
                restore_ok=false
            else
                rm -rf "$INSTALL_DIR/migrations.failed"
            fi
        elif $HAD_MIGRATIONS; then
            if [ -d "$INSTALL_DIR/migrations" ]; then
                log "migrations promotion had not completed; retained existing directory"
            else
                log "no migrations snapshot found at $MIGRATIONS_SNAPSHOT"
                restore_ok=false
            fi
        else
            rm -rf "$INSTALL_DIR/migrations"
        fi
    fi

    if systemctl restart aurora; then
        if wait_for_aurora_health; then
            restart_ok=true
        else
            log "restored service did not pass its health check"
        fi
    else
        log "could not restart aurora after restoring snapshots"
    fi

    if $restore_ok && $restart_ok; then
        cleanup_committed_snapshots
        DEPLOYMENT_SWAPPED=false
        STATIC_SWAP_STARTED=false
        MIGRATIONS_SWAP_STARTED=false
        BIN_SWAP_STARTED=false
        return 0
    fi
    return 1
}

# shellcheck disable=SC2329 # invoked by the EXIT trap below
cleanup_on_exit() {
    local rc=$?
    trap - ERR INT TERM EXIT
    set +e
    if [ -n "${WORK_TMP:-}" ]; then
        rm -rf "$WORK_TMP"
    fi
    rm -f "${INSTALL_BIN}.new" "${BIN_SNAPSHOT}.new" \
        "${UPDATER_BIN}.new" "${DEPLOYED_REV_FILE}.tmp"
    rm -rf "$INSTALL_DIR/static.new" "$INSTALL_DIR/migrations.new"
    if [ "${LOCK_HELD:-false}" = true ]; then
        exec 9>&- 2>/dev/null || true
    fi
    exit "$rc"
}

# ERR trap — report unexpected failures and roll back if live artifacts had
# begun changing. Explicitly-handled build/fetch failures retain their tailored
# messages and never reach this path.
# shellcheck disable=SC2329 # invoked by the traps below
on_error() {
    local lineno="$1" rc="${2:-1}" recovery=""
    trap - ERR INT TERM
    set +e
    log "ABORT at line $lineno (exit $rc)"
    if [ "${DEPLOYMENT_SWAPPED:-false}" = true ] \
        && [ "${ROLLBACK_ATTEMPTED:-false}" != true ]; then
        if rollback_deployment; then
            recovery=" Last known-good deployment was restored."
        else
            recovery=" Automatic rollback also failed; manual recovery is required."
        fi
    fi
    write_status failed \
        "Update script aborted at line $lineno — see $LOG_FILE.$recovery" \
        "${OLD_SHA:-}" "${NEW_SHA:-}" || true
    exit "$rc"
}

# shellcheck disable=SC2329 # invoked by the INT/TERM traps below
on_signal() {
    local signal="$1" recovery=""
    trap - ERR INT TERM
    set +e
    log "received $signal while updating"
    if [ "${DEPLOYMENT_SWAPPED:-false}" = true ] \
        && [ "${ROLLBACK_ATTEMPTED:-false}" != true ]; then
        if rollback_deployment; then
            recovery=" Last known-good deployment was restored."
        else
            recovery=" Automatic rollback also failed; manual recovery is required."
        fi
    fi
    write_status failed "Update interrupted by $signal.$recovery" \
        "${OLD_SHA:-}" "${NEW_SHA:-}" || true
    case "$signal" in
        INT) exit 130 ;;
        TERM) exit 143 ;;
        *) exit 1 ;;
    esac
}
trap 'on_error "$LINENO" "$?"' ERR
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap cleanup_on_exit EXIT

# Serialize before inspecting source, Git config, deployed markers, or status.
# This prevents a timer/direct invocation from racing a bootstrap repair or
# another updater on fixed temp/state paths.
acquire_deploy_lock

# The installer may be between PostgreSQL object creation and durable
# credential/OID convergence. Never fetch, build, self-refresh, or restart
# Aurora while that root-only recovery transaction is pending.
if [ -L "$DB_RECOVERY_MARKER" ] \
    || { [ -e "$DB_RECOVERY_MARKER" ] && [ ! -f "$DB_RECOVERY_MARKER" ]; }; then
    write_status misconfigured "PostgreSQL recovery state is malformed. Do not remove it; inspect $DB_RECOVERY_MARKER and rerun the Aurora installer." "$OLD_SHA"
    log "invalid PostgreSQL recovery marker blocks updater before source inspection"
    exit 1
fi
if [ -f "$DB_RECOVERY_MARKER" ]; then
    write_status misconfigured "PostgreSQL recovery is pending. Rerun Aurora's installer to finish database recovery before updating." "$OLD_SHA"
    log "pending PostgreSQL recovery blocks updater before source inspection"
    exit 1
fi

# ── Preflight ─────────────────────────────────────────────────────
#
# Audit H4 — preflight failures use a distinct `misconfigured`
# state, not `failed`. "Failed" means "an update was attempted and
# something went wrong" (panicked binary, broken migration); the
# operator's first instinct on seeing it is to revert. A missing
# source dir or wrong origin URL is a configuration problem with a
# completely different remediation (fix the env file or re-run
# install.sh), so it deserves its own state so the SPA can render
# it without alarm.
for required_tool in git curl systemctl; do
    if ! command -v "$required_tool" >/dev/null 2>&1; then
        write_status misconfigured "$required_tool is required before Aurora can safely fetch, deploy, health-check, and roll back updates."
        log "$required_tool is missing; refusing update before source/live mutation"
        exit 1
    fi
done

case "${AURORA_UPDATE_REQUIRE_SIGNED:-false}" in
    true|1) SIGNED_UPDATES_ENABLED=true ;;
    false|0|"") SIGNED_UPDATES_ENABLED=false ;;
    *)
        write_status misconfigured "AURORA_UPDATE_REQUIRE_SIGNED must be true/1 or false/0; refusing to interpret an invalid signing policy."
        log "invalid AURORA_UPDATE_REQUIRE_SIGNED value"
        exit 1
        ;;
esac

if [ -z "$SOURCE_DIR" ]; then
    write_status misconfigured "AURORA_SOURCE_DIR is unset in /etc/aurora/aurora.env. Run install.sh from the project directory to set it."
    log "AURORA_SOURCE_DIR missing"
    exit 1
fi

if [ ! -d "$SOURCE_DIR/.git" ]; then
    write_status misconfigured "No git repository at $SOURCE_DIR. The source directory may have been deleted or moved — re-run install.sh to rebuild the source mirror."
    log "no git repository at $SOURCE_DIR"
    exit 1
fi

# The updater executes Git hooks/config and build scripts with its own
# privileges (root in production). Validate the managed tree before the first
# Git command so a locally writable checkout cannot become a privilege bridge.
if [ -L "$SOURCE_DIR" ] || [ -L "$SOURCE_DIR/.git" ]; then
    write_status misconfigured "The managed Aurora source or its .git directory is a symlink. Re-run the bootstrap to restore a root-owned checkout."
    log "managed source or .git is a symlink"
    exit 1
fi
SOURCE_VALIDATION_ERROR="$(
    python3 - "$SOURCE_DIR" <<'PY'
import os
import stat
import sys

source = os.path.abspath(sys.argv[1])
expected_uid = os.geteuid()
source_stat = os.stat(source)

def reject(message):
    print(message)
    raise SystemExit(0)

for root, dirs, files in os.walk(source, followlinks=False):
    for name in [".", *dirs, *files]:
        candidate = root if name == "." else os.path.join(root, name)
        st = os.lstat(candidate)
        if st.st_uid != expected_uid:
            reject(f"unexpected owner: {candidate}")
        if not stat.S_ISLNK(st.st_mode) and st.st_mode & 0o022:
            reject(f"group/other-writable path: {candidate}")
        if st.st_dev != source_stat.st_dev:
            reject(f"cross-filesystem path: {candidate}")
PY
)"
if [ -n "$SOURCE_VALIDATION_ERROR" ]; then
    write_status misconfigured "The managed source contains a path not exclusively controlled by the updater account. Re-run the bootstrap before updating."
    log "managed source ownership/permission scan failed"
    exit 1
fi

cd "$SOURCE_DIR"

if $SIGNED_UPDATES_ENABLED \
    && [ -n "${AURORA_UPDATE_ALLOWED_SIGNERS:-}" ] \
    && ! validate_allowed_signers_file; then
    write_status misconfigured "AURORA_UPDATE_ALLOWED_SIGNERS must be an absolute, updater-owned, non-writable regular file outside the managed source tree."
    log "allowed-signers trust root failed ownership/path validation"
    exit 1
fi

if ! git check-ref-format --branch "$BRANCH" >/dev/null 2>&1; then
    write_status misconfigured "Invalid AURORA_UPDATE_BRANCH '$BRANCH' in $ENV_FILE."
    log "invalid update branch: '$BRANCH'"
    exit 1
fi
if ! [[ "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] \
    || ! [[ "$HEALTH_INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]] \
    || ! [[ "$HEALTH_MAX_TIME" =~ ^[1-9][0-9]*([.][0-9]+)?$ ]] \
    || ! [[ "${AURORA_DRAIN_MAX:-300}" =~ ^[0-9]+$ ]]; then
    write_status misconfigured "Invalid updater health-check timing configuration."
    log "invalid health timing: attempts=$HEALTH_ATTEMPTS interval=$HEALTH_INTERVAL max_time=$HEALTH_MAX_TIME"
    exit 1
fi

# Audit C2 — verify git's actual origin URL hasn't been rewritten
# to a malicious mirror. install.sh stashes the expected URL into
# /etc/aurora/aurora.env at install time; we assert it still
# matches before any network operation. This catches both
# accidental drift (operator changed remotes for a one-off) and
# malicious rewrites (a compromise of root or .git/config). When
# AURORA_EXPECTED_REMOTE is empty (e.g. the user wrote their own
# aurora.env), we skip the check rather than fail-closed — but
# log a warning so it's visible.
if [ -n "${AURORA_EXPECTED_REMOTE:-}" ]; then
    ACTUAL_REMOTE="$(git remote get-url origin 2>/dev/null || echo "")"
    if [ "$ACTUAL_REMOTE" != "$AURORA_EXPECTED_REMOTE" ]; then
        write_status misconfigured "git remote.origin.url no longer matches Aurora's pinned expected remote. Refusing to fetch from a potentially-untrusted source; re-run the bootstrap to reconcile it."
        log "origin URL mismatch — refusing fetch without writing either URL to status/logs"
        exit 1
    fi
else
    log "WARN: AURORA_EXPECTED_REMOTE not set in aurora.env — skipping origin verification (re-run install.sh to fix)"
fi

# ── Transport security (deep-debug H12) ───────────────────────────
# The updater builds + installs the fetched code as ROOT, so a plaintext or
# attacker-controllable git transport = unauthenticated root RCE. Use an
# ALLOWLIST: encrypted/authenticated transports (https, ssh, git+ssh) are
# accepted. Local/file origins are disabled by default and require an explicit
# one-shot opt-in plus recursive ownership/permission validation. http:// and
# git:// (cleartext, MITM-able) and remote-helper transports like ext:: (which
# run arbitrary commands) are refused. Scheme matching is CASE-INSENSITIVE —
# git honors HTTP:// the same as http://, so a lowercase denylist is bypassable.
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || echo "")"
case "$ORIGIN_URL" in
    *://*)
        ORIGIN_SCHEME="$(printf '%s' "${ORIGIN_URL%%://*}" | tr '[:upper:]' '[:lower:]')"
        case "$ORIGIN_SCHEME" in
            https)
                ORIGIN_AUTHORITY="${ORIGIN_URL#*://}"
                ORIGIN_AUTHORITY="${ORIGIN_AUTHORITY%%/*}"
                case "$ORIGIN_AUTHORITY" in
                    *@*)
                        write_status misconfigured "The updater's HTTPS origin embeds credentials. Remove userinfo from remote.origin.url and re-run Aurora's bootstrap to install the dedicated credential helper." "$OLD_SHA"
                        log "refused credential-bearing HTTPS origin without writing it to status/logs"
                        exit 1
                        ;;
                esac
                ;;
            ssh|git+ssh)
                : # encrypted/authenticated — OK
                ;;
            file)
                validate_opted_in_local_origin "$ORIGIN_URL" || exit 1
                ;;
            *)
                write_status misconfigured "Refusing to auto-update over an unencrypted or unsupported remote transport: a network attacker could alter code that the updater builds as root. Use HTTPS or SSH."
                log "refused updater remote transport scheme '$ORIGIN_SCHEME'"
                exit 1
                ;;
        esac
        ;;
    *::*)
        # Remote-helper transports (ext::, fd::, ...) can execute arbitrary
        # commands — never acceptable for the root updater.
        write_status misconfigured "Refusing a Git remote-helper transport for the root auto-updater because it can execute arbitrary commands. Use HTTPS or SSH."
        log "refused Git remote-helper transport"
        exit 1
        ;;
    *)
        if ! is_scp_style_ssh_remote "$ORIGIN_URL"; then
            validate_opted_in_local_origin "$ORIGIN_URL" || exit 1
        fi
        ;;
esac

# Track what actually passed the health check separately from the managed
# checkout's HEAD. A failed build/health check may leave the checkout at the
# fetched commit while the prior binary is still running; comparing HEAD alone
# would incorrectly report "Already up to date" forever and never retry.
#
# Never initialize a missing marker from source HEAD. The checkout can be ahead
# of the running binary after an interrupted or failed deployment. Treating that
# HEAD as deployed would permanently suppress the retry needed to repair it.
DEPLOYED_KNOWN=false
if [ -r "$DEPLOYED_REV_FILE" ]; then
    DEPLOYED_SHA="$(tr -d '[:space:]' < "$DEPLOYED_REV_FILE")"
    DEPLOYED_KNOWN=true
else
    DEPLOYED_SHA=""
    log "deployed revision marker missing; forcing a verified deployment"
fi
if $DEPLOYED_KNOWN \
    && ! [[ "$DEPLOYED_SHA" =~ ^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$ ]]; then
    write_status misconfigured "Invalid deployed revision marker at $DEPLOYED_REV_FILE. Re-run install.sh to repair it."
    log "invalid deployed revision marker: '$DEPLOYED_SHA'"
    exit 1
fi
OLD_SHA="$DEPLOYED_SHA"

# ── Fetch + check ─────────────────────────────────────────────────
write_status checking "Checking origin/$BRANCH for new commits"

SOURCE_SHA="$(git rev-parse HEAD)"

# Use an explicit destination refspec. In a single-branch shallow clone, or
# after changing the configured branch, `git fetch origin "$BRANCH"` may update
# FETCH_HEAD without creating/updating origin/$BRANCH.
if ! git fetch --quiet origin \
    "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" 2>>"$LOG_FILE"; then
    write_status failed "git fetch failed — see $LOG_FILE" "$OLD_SHA"
    log "git fetch failed"
    exit 1
fi

NEW_SHA="$(git rev-parse "origin/$BRANCH")"

# Verify the fetched revision before both deployment and the no-op updater
# self-refresh path. Enabling signed updates must never install updater code
# from a previously fetched but unverified revision.
if $SIGNED_UPDATES_ENABLED; then
    VERIFY_OK=1
    if [ -n "${AURORA_UPDATE_ALLOWED_SIGNERS:-}" ]; then
        git -c gpg.format=ssh \
            -c "gpg.ssh.allowedSignersFile=$AURORA_UPDATE_ALLOWED_SIGNERS" \
            verify-commit "origin/$BRANCH" >>"$LOG_FILE" 2>&1 || VERIFY_OK=0
    else
        git verify-commit "origin/$BRANCH" >>"$LOG_FILE" 2>&1 || VERIFY_OK=0
    fi
    if [ "$VERIFY_OK" -ne 1 ]; then
        write_status failed "Commit-signature verification FAILED for origin/$BRANCH ($NEW_SHA) — refusing to install or self-refresh from unverified code." "$OLD_SHA" "$NEW_SHA"
        log "verify-commit FAILED for $NEW_SHA — refusing update"
        exit 1
    fi
fi

if $DEPLOYED_KNOWN \
    && [ "$OLD_SHA" = "$NEW_SHA" ] \
    && [ "$SOURCE_SHA" = "$NEW_SHA" ]; then
    if refresh_updater; then
        write_status idle "Already up to date ($OLD_SHA)" "$OLD_SHA" "$NEW_SHA"
    else
        write_status idle "Application is current at $OLD_SHA, but updater self-refresh failed and will be retried." "$OLD_SHA" "$NEW_SHA"
    fi
    # No log spam for the common no-op case (5-min cadence × idle
    # would fill the log fast). One log line per actual update.
    exit 0
fi

log "Update available: deployed $OLD_SHA, source $SOURCE_SHA → $NEW_SHA on $BRANCH"

# ── Commit-signature verification (deep-debug H12) ────────────────
# When AURORA_UPDATE_REQUIRE_SIGNED=true, the fetched tip MUST carry a valid
# signature from a trusted key before we build + install it as root — the
# control that stops a compromised/hijacked origin or a malicious force-push
# from shipping attacker code to every install. Trust root is either SSH
# signing (AURORA_UPDATE_ALLOWED_SIGNERS -> an allowed_signers file) or GPG
# (import the maintainer's public key into root's keyring). Default (false)
# preserves today's behavior for repos that don't sign yet, but logs a loud
# warning so the trust gap is visible.
if $SIGNED_UPDATES_ENABLED; then
    log "commit signature verified for $NEW_SHA"
else
    log "WARN: AURORA_UPDATE_REQUIRE_SIGNED not enabled — building UNVERIFIED code from origin/$BRANCH ($NEW_SHA); a compromised origin or MITM could run code as root. Set AURORA_UPDATE_REQUIRE_SIGNED=true with a trusted signing key to harden. (deep-debug H12)"
fi

# ── Working-tree cleanliness ──────────────────────────────────────
# If somebody (operator, prior failed build, or compromised service) left
# tracked OR non-ignored untracked files in $SOURCE_DIR, refuse to build them as
# root. Ignored caches such as node_modules remain allowed.
WORKTREE_STATUS="$(git status --porcelain --untracked-files=normal 2>/dev/null || echo "__git_status_failed__")"
if [ -n "$WORKTREE_STATUS" ]; then
    write_status failed "Local or untracked changes detected in $SOURCE_DIR — refusing to build a non-exact checkout. Clean the managed source or re-run install.sh, then retry." "$OLD_SHA" "$NEW_SHA"
    log "dirty working tree; aborting"
    exit 1
fi

# Audit M4 — removed the dead merge-tree probe that used to live
# here. It discarded its output and the `:` no-op silently
# swallowed any conflict signal, so it accomplished nothing. If
# `git merge --ff-only` below detects an untracked-file collision,
# its own error message is clearer than what we'd cobble together
# from a parsed merge-tree.

# ── Pull ──────────────────────────────────────────────────────────
if [ "$SOURCE_SHA" != "$NEW_SHA" ]; then
    write_status updating "Pulling commits from origin/$BRANCH" "$OLD_SHA" "$NEW_SHA"
    # A merge of an ancestor into its descendant exits 0 with "Already up to
    # date". Without this explicit ancestry direction check, a remote rewind
    # would build SOURCE_SHA but later record NEW_SHA as deployed.
    if ! git merge-base --is-ancestor "$SOURCE_SHA" "$NEW_SHA" 2>>"$LOG_FILE"; then
        write_status failed "Cannot fast-forward source checkout to origin/$BRANCH — the branch was rewound or the local checkout diverged. Manual reconciliation is required." "$OLD_SHA" "$NEW_SHA"
        log "origin/$BRANCH is not a descendant of source HEAD; refusing revision mismatch"
        exit 1
    fi
    if ! git merge --ff-only "origin/$BRANCH" >>"$LOG_FILE" 2>&1; then
        write_status failed "Cannot fast-forward to origin/$BRANCH — manual reconciliation needed (the local branch has diverged)." "$OLD_SHA" "$NEW_SHA"
        log "merge --ff-only refused; branch diverged"
        exit 1
    fi
    MERGED_SHA="$(git rev-parse HEAD)"
    if [ "$MERGED_SHA" != "$NEW_SHA" ]; then
        write_status failed "Source checkout did not land on the fetched origin revision; refusing to build the wrong commit." "$OLD_SHA" "$NEW_SHA"
        log "revision mismatch after merge: HEAD=$MERGED_SHA expected=$NEW_SHA"
        exit 1
    fi
    SOURCE_SHA="$MERGED_SHA"
else
    if $DEPLOYED_KNOWN; then
        write_status updating "Retrying deployment of $NEW_SHA" "$OLD_SHA" "$NEW_SHA"
        log "source checkout already at $NEW_SHA; retrying the previously failed deployment"
    else
        write_status updating "Deploying $NEW_SHA because no trusted deployed-revision marker exists" "" "$NEW_SHA"
        log "source checkout is current but deployed revision is unknown; forcing deployment"
    fi
fi

# cleanup_on_exit owns the single EXIT trap and releases this descriptor along
# with staged files and temporary build output.

# ── Build ─────────────────────────────────────────────────────────
write_status building "Building Aurora frontend and binary" "$OLD_SHA" "$NEW_SHA"
WORK_TMP="$(mktemp -d)"
log "frontend build..."
if ! build_frontend_bundle "$WORK_TMP/v2"; then
    write_status failed "frontend build failed — see $LOG_FILE. Old binary/static assets are still running." "$OLD_SHA" "$NEW_SHA"
    log "frontend build failed"
    exit 1
fi

log "go build..."

VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo "dev")"
if ! CGO_ENABLED=0 go build -ldflags="-s -w -X main.version=${VERSION}" \
    -o "$WORK_TMP/aurora" ./cmd/aurora >>"$LOG_FILE" 2>&1; then
    write_status failed "go build failed — see $LOG_FILE. Old binary is still running." "$OLD_SHA" "$NEW_SHA"
    log "go build failed"
    exit 1
fi

# ── Stage ─────────────────────────────────────────────────────────
# Complete every build and potentially-large copy before touching live
# artifacts. A missing migration, disk-full error, or interrupted stream drain
# therefore leaves the running deployment unchanged.
write_status installing "Staging new binary, migrations, and static assets" "$OLD_SHA" "$NEW_SHA"
log "staging deployment..."

SQL_FILES=()
shopt -s nullglob
for f in migrations/*.sql; do
    SQL_FILES+=("$f")
done
shopt -u nullglob
if [ "${#SQL_FILES[@]}" -eq 0 ]; then
    write_status failed "No migration files found in source checkout; refusing to install a partial release." "$OLD_SHA" "$NEW_SHA"
    log "no migration files found"
    exit 1
fi

rm -rf "$INSTALL_DIR/migrations.new"
mkdir -p "$INSTALL_DIR/migrations.new"
if ! cp -f "${SQL_FILES[@]}" "$INSTALL_DIR/migrations.new/" 2>>"$LOG_FILE"; then
    write_status failed "migration staging failed — see $LOG_FILE. The running deployment is unchanged." "$OLD_SHA" "$NEW_SHA"
    log "migration staging failed"
    exit 1
fi

stage_static_bundle "$WORK_TMP/v2"
install -m 0755 "$WORK_TMP/aurora" "${INSTALL_BIN}.new"
chown -R root:root "$INSTALL_DIR/static.new" "$INSTALL_DIR/migrations.new"
chmod -R go-w "$INSTALL_DIR/static.new" "$INSTALL_DIR/migrations.new"
rm -rf "$WORK_TMP"
WORK_TMP=""

# Drain active HLS stream sessions before swapping any live files. The old
# process reads static assets by path, so swapping static before this wait made
# it serve a new SPA against the old backend for as long as five minutes.
# systemctl restart
# sends SIGTERM to the entire cgroup (KillMode=control-group default),
# which kills FFmpeg children immediately and breaks playback for active
# viewers. Wait up to 300 s for streams to finish organically; the
# _DRAIN_LOG_EVERY throttle keeps log noise low.
_DRAIN_MAX="${AURORA_DRAIN_MAX:-300}"
_DRAIN_WAITED=0
_DRAIN_LOG_EVERY=30  # log at most once per 30 s
_DRAIN_NEXT_LOG=0
if ! command -v pgrep >/dev/null 2>&1; then
    log "WARN: pgrep is unavailable; active FFmpeg streams cannot be drained before restart"
elif pgrep -u aurora ffmpeg >/dev/null 2>&1; then
    write_status restarting "Waiting for active stream sessions to finish before restart (up to ${_DRAIN_MAX}s)…" "$OLD_SHA" "$NEW_SHA"
    while pgrep -u aurora ffmpeg >/dev/null 2>&1 && [ "$_DRAIN_WAITED" -lt "$_DRAIN_MAX" ]; do
        if [ "$_DRAIN_WAITED" -ge "$_DRAIN_NEXT_LOG" ]; then
            log "active stream sessions detected — waiting for viewers to finish (${_DRAIN_WAITED}/${_DRAIN_MAX}s)..."
            _DRAIN_NEXT_LOG=$((_DRAIN_NEXT_LOG + _DRAIN_LOG_EVERY))
        fi
        sleep 10
        _DRAIN_WAITED=$((_DRAIN_WAITED + 10))
    done
    if pgrep -u aurora ffmpeg >/dev/null 2>&1; then
        log "WARNING: stream sessions still active after ${_DRAIN_MAX}s, restarting anyway"
    else
        log "stream sessions drained after ${_DRAIN_WAITED}s"
    fi
fi

# ── Transactional swap ────────────────────────────────────────────
# Fixed .prev/.old paths intentionally survive an interrupted updater. If a
# previous attempt left them behind, preserve them rather than snapshotting
# partially-promoted current files over the last known-good deployment.
write_status installing "Promoting staged Aurora artifacts" "$OLD_SHA" "$NEW_SHA"
log "promoting staged deployment..."

if [ -f "$BIN_SNAPSHOT" ]; then
    HAD_BIN=true
    log "preserving existing binary rollback snapshot"
elif [ -f "$INSTALL_BIN" ]; then
    HAD_BIN=true
    cp -p "$INSTALL_BIN" "${BIN_SNAPSHOT}.new"
    mv "${BIN_SNAPSHOT}.new" "$BIN_SNAPSHOT"
fi
if [ -d "$STATIC_SNAPSHOT" ] || [ -d "$INSTALL_DIR/static" ]; then
    HAD_STATIC=true
fi
if [ -d "$MIGRATIONS_SNAPSHOT" ] || [ -d "$INSTALL_DIR/migrations" ]; then
    HAD_MIGRATIONS=true
fi

# From this point until the new service passes health, ERR/INT/TERM invokes
# rollback_deployment. Set the flag before the first rename so a mid-swap
# filesystem failure is covered.
DEPLOYMENT_SWAPPED=true

STATIC_SWAP_STARTED=true
if [ -d "$STATIC_SNAPSHOT" ]; then
    log "preserving existing static rollback snapshot"
    rm -rf "$INSTALL_DIR/static.failed"
    if [ -e "$INSTALL_DIR/static" ]; then
        mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.failed"
    fi
elif [ -e "$INSTALL_DIR/static" ]; then
    mv "$INSTALL_DIR/static" "$STATIC_SNAPSHOT"
fi
mv "$INSTALL_DIR/static.new" "$INSTALL_DIR/static"

MIGRATIONS_SWAP_STARTED=true
if [ -d "$MIGRATIONS_SNAPSHOT" ]; then
    log "preserving existing migrations rollback snapshot"
    rm -rf "$INSTALL_DIR/migrations.failed"
    if [ -e "$INSTALL_DIR/migrations" ]; then
        mv "$INSTALL_DIR/migrations" "$INSTALL_DIR/migrations.failed"
    fi
elif [ -e "$INSTALL_DIR/migrations" ]; then
    mv "$INSTALL_DIR/migrations" "$MIGRATIONS_SNAPSHOT"
fi
mv "$INSTALL_DIR/migrations.new" "$INSTALL_DIR/migrations"

BIN_SWAP_STARTED=true
mv "${INSTALL_BIN}.new" "$INSTALL_BIN"

# ── Restart + health check ────────────────────────────────────────
write_status restarting "Restarting aurora.service" "$OLD_SHA" "$NEW_SHA"
log "restarting service..."

if ! systemctl restart aurora; then
    log "systemctl restart failed — attempting rollback"
    if rollback_deployment; then
        write_status failed "Update to $NEW_SHA could not restart Aurora; restored the previous deployment." "$OLD_SHA" "$NEW_SHA"
    else
        write_status failed "Update to $NEW_SHA could not restart Aurora, and automatic rollback failed. Manual recovery required." "$OLD_SHA" "$NEW_SHA"
    fi
    exit 1
fi

if wait_for_aurora_health; then
    COMMIT_SUBJECT="$(git log -1 --format=%s "$NEW_SHA" 2>/dev/null || echo "$NEW_SHA")"

    # Health is the commit point. Do not roll back a healthy application merely
    # because a later marker, status, updater-copy, or cleanup operation fails.
    DEPLOYMENT_SWAPPED=false
    cleanup_committed_snapshots
    rm -f "${INSTALL_BIN}.failed"
    printf '%s\n' "$NEW_SHA" > "$DEPLOYED_REV_FILE.tmp"
    chmod 0644 "$DEPLOYED_REV_FILE.tmp"
    mv -f "$DEPLOYED_REV_FILE.tmp" "$DEPLOYED_REV_FILE"

    refresh_updater || true

    write_status success "Updated to $NEW_SHA ($COMMIT_SUBJECT)" "$OLD_SHA" "$NEW_SHA"
    log "SUCCESS: now running $NEW_SHA"
    exit 0
fi

# The new service failed health. Restore binary, static, and the on-disk
# migrations directory. Database migrations already applied by the failed
# process cannot be reversed safely; releases with destructive schema changes
# still require an operator-managed database backup.
log "service unhealthy — attempting rollback to ${OLD_SHA:-the prior deployment}"
write_status restarting "New version failed health check — rolling back to previous binary" "$OLD_SHA" "$NEW_SHA"

if rollback_deployment; then
    write_status failed "Update to $NEW_SHA failed its health check — restored the previous healthy deployment. The bad binary is at ${INSTALL_BIN}.failed for post-mortem; inspect 'journalctl -u aurora -n 80'." "$OLD_SHA" "$NEW_SHA"
    log "rolled back successfully to ${OLD_SHA:-the previous deployment}"
else
    write_status failed "Update to $NEW_SHA failed, and automatic rollback did not restore a healthy service. Manual recovery required; inspect 'journalctl -u aurora -n 80'." "$OLD_SHA" "$NEW_SHA"
    log "automatic rollback failed — manual recovery required"
fi
exit 1
