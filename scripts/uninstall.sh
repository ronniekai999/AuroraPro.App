#!/usr/bin/env bash
# Aurora Media Server - Uninstall Script
# Safely removes all Aurora components from a Linux system.
#
# Removes:
#   - aurora.service + aurora-update.{service,timer,path} systemd units
#   - /usr/local/bin/aurora + /usr/local/bin/aurora-update
#   - /etc/sudoers.d/aurora-update (legacy; new installs don't create it)
#   - /opt/aurora (install dir), /etc/aurora (config)
#   - /var/cache/aurora (image+subtitle+transcode caches)
#   - /var/lib/aurora (source mirror + updater state)
#   - /var/log/aurora + /var/log/aurora-installer
#   - /root/.config/aurora/git-credentials
#   - /usr/local/lib/aurora-node (Aurora-owned build toolchain)
#   - PostgreSQL database + role 'aurora'
#   - Nginx reverse proxy config + Let's Encrypt certificate
#   - ACL entries granted to the aurora user on media libraries
#   - System user + group 'aurora'
#
# Leaves alone: shared packages (PostgreSQL, FFmpeg, Go, nginx,
# certbot, build-essential, acl, python3, git, pgvector), your media
# files, the user's source checkout (only /var/lib/aurora/source is
# touched), and chmod-fallback world-permissions (mode bits can't be
# safely reversed without knowing the original).
#
# Usage:
#   sudo ./scripts/uninstall.sh            # Interactive (asks before each step)
#   sudo ./scripts/uninstall.sh --yes       # Non-interactive; keeps protected data
#   sudo ./scripts/uninstall.sh --yes --purge  # Also remove config, DB, cert, logs
#   sudo ./scripts/uninstall.sh --yes --purge --external-db-purged
#                                            # Acknowledge external DB cleanup
#   sudo ./scripts/uninstall.sh --yes --media-path=/srv/media
#                                            # Supply a legacy ACL root

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
if [ ! -f "$LIB_DIR/env-file.sh" ] && [ -f /usr/local/lib/aurora-installer/env-file.sh ]; then
    LIB_DIR="/usr/local/lib/aurora-installer"
fi
if [ -f "$LIB_DIR/env-file.sh" ]; then
    # shellcheck source=lib/env-file.sh
    # shellcheck disable=SC1091
    . "$LIB_DIR/env-file.sh"
fi
if [ -f "$LIB_DIR/install-state.sh" ]; then
    # shellcheck source=lib/install-state.sh
    # shellcheck disable=SC1091
    . "$LIB_DIR/install-state.sh"
fi

# ── Constants (must match install.sh exactly) ────────────────────
AURORA_USER="aurora"
AURORA_GROUP="aurora"
INSTALL_BIN="/usr/local/bin/aurora"
INSTALL_DIR="/opt/aurora"
CONFIG_DIR="/etc/aurora"
CACHE_DIR="/var/cache/aurora"
TRANSCODE_FALLBACK="/tmp/aurora-transcode"
NODE_TOOLCHAIN_DIR="/usr/local/lib/aurora-node"
SYSTEMD_UNIT="/etc/systemd/system/aurora.service"
DB_NAME="aurora"
DB_USER="aurora"

# Auto-updater pipeline (installed by install.sh's updater block,
# which lives in the "if [ -f scripts/aurora-update.sh ] && !
# $SKIP_UPDATER" section). Files: the updater binary at
# /usr/local/bin/aurora-update, three systemd units (service +
# timer + path) under /etc/systemd/system, and historically a
# sudoers grant (removed in the 2026-05-19 .path-activation
# rearchitecture but kept here for upgrade-then-uninstall paths).
UPDATER_BIN="/usr/local/bin/aurora-update"
UPDATER_SERVICE="/etc/systemd/system/aurora-update.service"
UPDATER_TIMER="/etc/systemd/system/aurora-update.timer"
UPDATER_PATH_UNIT="/etc/systemd/system/aurora-update.path"
# Pre-2026-05-19 installs dropped a sudoers grant here. New installs
# don't (path activation replaces it). Uninstall still cleans it up
# for upgrade-then-uninstall paths.
UPDATER_SUDOERS="/etc/sudoers.d/aurora-update"

# State + log dirs (install.sh writes status JSON + log files here).
STATE_DIR="/var/lib/aurora"             # contains source/ mirror + update-status.json
LOG_DIR="/var/log/aurora"
INSTALLER_LOG_DIR="/var/log/aurora-installer"
GIT_CREDENTIAL_DIR="/root/.config/aurora"
GIT_CREDENTIAL_FILE="$GIT_CREDENTIAL_DIR/git-credentials"
STANDALONE_UNINSTALL="/usr/local/sbin/aurora-uninstall"
INSTALLER_LIB_DIR="/usr/local/lib/aurora-installer"
DB_OWNERSHIP_MARKER="$INSTALLER_LIB_DIR/db-ownership"
DB_RECOVERY_MARKER="$INSTALLER_LIB_DIR/db-recovery-pending"
PENDING_MEDIA_PATHS_FILE="$INSTALLER_LIB_DIR/pending-media-paths"
MANAGED_MEDIA_PATHS_FILE="$INSTALLER_LIB_DIR/managed-media-paths"
PROXY_REMOVAL_PROVENANCE_MARKER="$INSTALLER_LIB_DIR/proxy-removal-provenance"
PROXY_CERT_DURABLE_MARKER="$INSTALLER_LIB_DIR/proxy-cert-ownership"
SYSTEM_USER_MARKER="$INSTALLER_LIB_DIR/system-user-ownership"
SYSTEM_GROUP_MARKER="$INSTALLER_LIB_DIR/system-group-ownership"
DEPLOY_LOCK_DIR="/run/aurora"
DEPLOY_LOCK_FILE="$DEPLOY_LOCK_DIR/deploy.lock"
PROXY_ACTIVE_MARKER="$CONFIG_DIR/.proxy-setup"
PROXY_REMOVED_MARKER="$CONFIG_DIR/.proxy-removed"
PROXY_CERT_OWNER_MARKER="$CONFIG_DIR/.proxy-cert-owned"

PURGE_FAILED=false
PURGE_FAILURE_MESSAGES=()
DEFER_CONFIG_PURGE=false
ACL_CLEANUP_FAILED=false
ACL_FAILURE_MESSAGES=()
PROXY_CLEANUP_FAILED=false
PROXY_FAILURE_MESSAGES=()

record_purge_failure() {
    PURGE_FAILED=true
    PURGE_FAILURE_MESSAGES+=("$1")
}

record_acl_failure() {
    ACL_CLEANUP_FAILED=true
    ACL_FAILURE_MESSAGES+=("$1")
    $PURGE && record_purge_failure "$1"
}

record_proxy_failure() {
    PROXY_CLEANUP_FAILED=true
    PROXY_FAILURE_MESSAGES+=("$1")
    $PURGE && record_purge_failure "$1"
}

# Return success and print the first active nginx configuration that would make
# deleting a Certbot lineage unsafe. The input is `nginx -T` output, whose
# `# configuration file /path:` markers identify the active include that owns
# each directive. Certificate-path matching catches vhosts that reuse Aurora's
# retained lineage under another hostname; exact server_name matching catches a
# replacement vhost for the Aurora hostname even when it references the lineage
# indirectly.
aurora_nginx_dump_certificate_consumer() {
    local dump_file="$1" domain="$2" cert_name="$3"
    awk -v domain="$domain" \
        -v cert_prefix="/etc/letsencrypt/live/${cert_name}/" '
        function block(reason) {
            if (current == "") current = "<unknown active nginx config>"
            print current ": " reason
            found = 1
            exit
        }
        function inspect_server_names(text, count, fields, i, token, terminal) {
            count = split(text, fields, /[[:space:]]+/)
            for (i = 1; i <= count; i++) {
                token = fields[i]
                if (token == "") continue
                terminal = (token ~ /;/)
                sub(/;.*/, "", token)
                gsub(/^["'\'']|["'\'']$/, "", token)
                if (token == domain) {
                    block("serves " domain)
                }
                if (terminal) {
                    in_server_name = 0
                    return
                }
            }
        }
        /^# configuration file .*:$/ {
            current = $0
            sub(/^# configuration file /, "", current)
            sub(/:$/, "", current)
            next
        }
        {
            line = $0
            sub(/[[:space:]]*#.*/, "", line)

            if (cert_prefix != "" && index(line, cert_prefix) > 0) {
                block("references Certbot lineage " cert_prefix)
            }

            if (in_server_name) {
                inspect_server_names(line)
            } else if (line ~ /^[[:space:]]*server_name([[:space:]]|$)/) {
                sub(/^[[:space:]]*server_name[[:space:]]*/, "", line)
                in_server_name = 1
                inspect_server_names(line)
            }
        }
        END { exit(found ? 0 : 1) }
    ' "$dump_file"
}

# Inspect nginx's actual active include graph immediately before certificate
# deletion. Inability to inspect is itself a blocker: certificate removal is
# destructive and must fail closed rather than assuming no consumer exists.
aurora_active_nginx_certificate_consumer() {
    local domain="$1" cert_name="$2" dump_file result
    if ! command -v nginx >/dev/null 2>&1; then
        printf '%s\n' "nginx is unavailable, so active certificate consumers cannot be verified"
        return 0
    fi
    dump_file="$(mktemp)" || {
        printf '%s\n' "could not create a secure temporary file for nginx inspection"
        return 0
    }
    chmod 0600 "$dump_file"
    if ! nginx -T > "$dump_file" 2>/dev/null; then
        rm -f "$dump_file"
        printf '%s\n' "nginx -T failed, so active certificate consumers cannot be verified"
        return 0
    fi
    if result="$(
        aurora_nginx_dump_certificate_consumer \
            "$dump_file" "$domain" "$cert_name"
    )"; then
        rm -f "$dump_file"
        printf '%s\n' "$result"
        return 0
    fi
    rm -f "$dump_file"
    return 1
}

# Run destructive PostgreSQL DDL only in the same psql session that proves the
# marker's cluster identity and the database owner. This keeps validation next
# to name resolution and removes the previous sleep/process boundary between a
# guard and dropdb/dropuser.
aurora_psql_drop_owned_database() {
    local marker="$1" expected_db="$2" expected_role="$3"
    local marker_db marker_role expected_data expected_port
    local expected_system_identifier expected_db_oid expected_role_oid line_count
    [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
    line_count="$(awk 'END { print NR }' "$marker" 2>/dev/null)" || return 1
    [ "$line_count" = "7" ] || return 1
    marker_db="$(sed -n '1p' "$marker" 2>/dev/null)" || return 1
    marker_role="$(sed -n '2p' "$marker" 2>/dev/null)" || return 1
    [ "$marker_db" = "$expected_db" ] \
        && [ "$marker_role" = "$expected_role" ] \
        || return 1
    expected_data="$(sed -n '3p' "$marker" 2>/dev/null)" || return 1
    expected_port="$(sed -n '4p' "$marker" 2>/dev/null)" || return 1
    expected_system_identifier="$(sed -n '5p' "$marker" 2>/dev/null)" \
        || return 1
    expected_db_oid="$(sed -n '6p' "$marker" 2>/dev/null)" || return 1
    expected_role_oid="$(sed -n '7p' "$marker" 2>/dev/null)" || return 1
    [ -n "$expected_data" ] && [ -n "$expected_port" ] || return 1
    case "$expected_system_identifier" in
        ""|*[!0-9]*) return 1 ;;
    esac
    case "$expected_db_oid" in
        ""|*[!0-9]*) return 1 ;;
    esac
    case "$expected_role_oid" in
        ""|*[!0-9]*) return 1 ;;
    esac

    sudo -u postgres psql -X -q --dbname=postgres \
        --set=ON_ERROR_STOP=1 \
        --set="expected_data=$expected_data" \
        --set="expected_port=$expected_port" \
        --set="expected_system_identifier=$expected_system_identifier" \
        --set="expected_db_oid=$expected_db_oid" \
        --set="expected_role_oid=$expected_role_oid" \
        --set="expected_db=$expected_db" \
        --set="expected_role=$expected_role" >/dev/null 2>&1 <<'PSQL'
SELECT current_setting('data_directory') = :'expected_data'
   AND current_setting('port') = :'expected_port'
   AND (SELECT system_identifier::text FROM pg_control_system())
       = :'expected_system_identifier'
   AND COALESCE((
       SELECT d.oid::text = :'expected_db_oid'
          AND r.oid::text = :'expected_role_oid'
          AND r.rolname = :'expected_role'
       FROM pg_database AS d
       JOIN pg_roles AS r ON r.oid = d.datdba
       WHERE d.datname = :'expected_db'
   ), false) AS aurora_database_guard \gset
\if :aurora_database_guard
\else
SELECT 1 / 0 AS aurora_database_ownership_guard_failed;
\endif

SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'expected_db'
  AND pid <> pg_backend_pid();

SELECT current_setting('data_directory') = :'expected_data'
   AND current_setting('port') = :'expected_port'
   AND (SELECT system_identifier::text FROM pg_control_system())
       = :'expected_system_identifier'
   AND COALESCE((
       SELECT d.oid::text = :'expected_db_oid'
          AND r.oid::text = :'expected_role_oid'
          AND r.rolname = :'expected_role'
       FROM pg_database AS d
       JOIN pg_roles AS r ON r.oid = d.datdba
       WHERE d.datname = :'expected_db'
   ), false) AS aurora_database_pre_drop_guard \gset
\if :aurora_database_pre_drop_guard
\else
SELECT 1 / 0 AS aurora_database_pre_drop_guard_failed;
\endif

DROP DATABASE :"expected_db";
PSQL
}

aurora_psql_drop_owned_role() {
    local marker="$1" expected_role="$2"
    local marker_role expected_data expected_port expected_system_identifier
    local expected_role_oid line_count
    [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
    line_count="$(awk 'END { print NR }' "$marker" 2>/dev/null)" || return 1
    [ "$line_count" = "7" ] || return 1
    marker_role="$(sed -n '2p' "$marker" 2>/dev/null)" || return 1
    [ "$marker_role" = "$expected_role" ] || return 1
    expected_data="$(sed -n '3p' "$marker" 2>/dev/null)" || return 1
    expected_port="$(sed -n '4p' "$marker" 2>/dev/null)" || return 1
    expected_system_identifier="$(sed -n '5p' "$marker" 2>/dev/null)" \
        || return 1
    expected_role_oid="$(sed -n '7p' "$marker" 2>/dev/null)" || return 1
    [ -n "$expected_data" ] && [ -n "$expected_port" ] || return 1
    case "$expected_system_identifier" in
        ""|*[!0-9]*) return 1 ;;
    esac
    case "$expected_role_oid" in
        ""|*[!0-9]*) return 1 ;;
    esac

    sudo -u postgres psql -X -q --dbname=postgres \
        --set=ON_ERROR_STOP=1 \
        --set="expected_data=$expected_data" \
        --set="expected_port=$expected_port" \
        --set="expected_system_identifier=$expected_system_identifier" \
        --set="expected_role_oid=$expected_role_oid" \
        --set="expected_role=$expected_role" >/dev/null 2>&1 <<'PSQL'
SELECT current_setting('data_directory') = :'expected_data'
   AND current_setting('port') = :'expected_port'
   AND (SELECT system_identifier::text FROM pg_control_system())
       = :'expected_system_identifier'
   AND EXISTS (
       SELECT 1
       FROM pg_roles
       WHERE rolname = :'expected_role'
         AND oid::text = :'expected_role_oid'
   ) AS aurora_role_pre_drop_guard \gset
\if :aurora_role_pre_drop_guard
\else
SELECT 1 / 0 AS aurora_role_ownership_guard_failed;
\endif

DROP ROLE :"expected_role";
PSQL
}

# Focused helper tests source this file without running destructive lifecycle
# actions. Production invocation never sets this test-only marker.
if [ "${AURORA_UNINSTALL_LIBRARY_ONLY:-0}" = "1" ]; then
    if [ "${BASH_SOURCE[0]}" != "$0" ]; then
        return 0
    fi
    exit 0
fi

append_media_path_for_cleanup() {
    local candidate="$1" existing
    [ -n "$candidate" ] || return 0
    for existing in "${MEDIA_PATHS[@]}"; do
        [ "$existing" = "$candidate" ] && return 0
    done
    MEDIA_PATHS+=("$candidate")
}

# ── Helpers (match install.sh formatting) ────────────────────────
info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$1"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$1"; }
ok()    { printf '\033[1;32m[ OK ]\033[0m  %s\n' "$1"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$1"; exit 1; }

confirm() {
    local msg="$1" default="${2:-Y}"
    if $FORCE; then
        if [ "$default" = "Y" ] || $PURGE; then
            return 0
        fi
        return 1
    fi
    if [ "$default" = "Y" ]; then
        printf '\033[1;36m[?]\033[0m %s [Y/n]: ' "$msg"
    else
        printf '\033[1;36m[?]\033[0m %s [y/N]: ' "$msg"
    fi
    read -r REPLY || { echo ""; error "Unexpected end of input (Ctrl+D)."; }
    REPLY="${REPLY:-$default}"
    case "$REPLY" in
        [Yy]*) return 0 ;;
        *) return 1 ;;
    esac
}

# ── Parse arguments ──────────────────────────────────────────────
FORCE=false
PURGE=false
EXTERNAL_DB_PURGED=false
MEDIA_PATH_OVERRIDES=()
for arg in "$@"; do
    case "$arg" in
        --force|--yes|-y) FORCE=true ;;
        --purge) PURGE=true ;;
        --external-db-purged) EXTERNAL_DB_PURGED=true ;;
        --media-path=*)
            _media_override="${arg#*=}"
            [ -n "$_media_override" ] \
                || error "--media-path requires a non-empty absolute directory."
            MEDIA_PATH_OVERRIDES+=("$_media_override")
            ;;
        -h|--help)
            echo "Usage: sudo $0 [--yes|-y] [--purge] [--external-db-purged] [--media-path=PATH]..."
            echo ""
            echo "Removes Aurora Media Server. Protected data is kept by default."
            echo ""
            echo "Options:"
            echo "  --yes, -y     Non-interactive; accept safe/default-yes removals"
            echo "  --force       Legacy alias for --yes"
            echo "  --purge       Also remove protected config, database, cert, and logs"
            echo "  --external-db-purged"
            echo "                With --purge, confirm external DB cleanup was completed"
            echo "  --media-path=PATH"
            echo "                Add a legacy/external media root for verified ACL cleanup"
            echo "  -h, --help    Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Usage: sudo $0 [--yes|-y] [--purge] [--external-db-purged] [--media-path=PATH]..."
            exit 1
            ;;
    esac
done

# ── Preflight checks ────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root (use sudo)."
fi

case "$(uname -s)" in
    Linux) ;;
    *)
        error "This uninstaller only supports Linux systems."
        ;;
esac

# Never let recursive cleanup or ownership hardening traverse managed-path
# symlinks into unrelated operator data.
for managed_dir in \
    "$INSTALL_DIR" "$CONFIG_DIR" "$CACHE_DIR" "$STATE_DIR" "$LOG_DIR" \
    "$INSTALLER_LOG_DIR" "$NODE_TOOLCHAIN_DIR" "$INSTALLER_LIB_DIR"; do
    [ ! -L "$managed_dir" ] \
        || error "$managed_dir is a symlink; move it aside and retry uninstall."
done

if $PURGE && ! $FORCE; then
    error "--purge must be paired with --yes so destructive automation is explicit."
fi
if $EXTERNAL_DB_PURGED && { ! $PURGE || ! $FORCE; }; then
    error "--external-db-purged requires --yes --purge."
fi
if ! $FORCE && [ ! -t 0 ]; then
    error "This script requires an interactive terminal. Use --yes for non-interactive safe removal."
fi

command -v flock >/dev/null 2>&1 \
    || error "flock is required for safe uninstall (install the util-linux package)."
prepare_deploy_lock_file() {
    local owner group mode
    if [ -L "$DEPLOY_LOCK_DIR" ]; then
        error "$DEPLOY_LOCK_DIR is a symlink; refusing unsafe lock acquisition."
    fi
    if [ -e "$DEPLOY_LOCK_DIR" ]; then
        [ -d "$DEPLOY_LOCK_DIR" ] \
            || error "$DEPLOY_LOCK_DIR exists but is not a directory."
        owner="$(stat -c '%u' -- "$DEPLOY_LOCK_DIR")"
        group="$(stat -c '%g' -- "$DEPLOY_LOCK_DIR")"
        mode="$(stat -c '%a' -- "$DEPLOY_LOCK_DIR")"
        [ "$owner" = "0" ] && [ "$group" = "0" ] \
            || error "$DEPLOY_LOCK_DIR must be owned by root:root."
        (( (8#$mode & 0022) == 0 )) \
            || error "$DEPLOY_LOCK_DIR must not be group/other writable."
        chmod 0755 "$DEPLOY_LOCK_DIR"
    else
        install -d -m 0755 -o root -g root "$DEPLOY_LOCK_DIR"
    fi

    [ ! -L "$DEPLOY_LOCK_FILE" ] \
        || error "$DEPLOY_LOCK_FILE is a symlink; refusing unsafe lock acquisition."
    if [ -e "$DEPLOY_LOCK_FILE" ]; then
        [ -f "$DEPLOY_LOCK_FILE" ] \
            || error "$DEPLOY_LOCK_FILE exists but is not a regular file."
        owner="$(stat -c '%u' -- "$DEPLOY_LOCK_FILE")"
        group="$(stat -c '%g' -- "$DEPLOY_LOCK_FILE")"
        mode="$(stat -c '%a' -- "$DEPLOY_LOCK_FILE")"
        [ "$owner" = "0" ] && [ "$group" = "0" ] \
            || error "$DEPLOY_LOCK_FILE must be owned by root:root."
        (( (8#$mode & 0022) == 0 )) \
            || error "$DEPLOY_LOCK_FILE must not be group/other writable."
        chmod 0644 "$DEPLOY_LOCK_FILE"
    else
        install -m 0644 -o root -g root /dev/null "$DEPLOY_LOCK_FILE"
    fi
}
prepare_deploy_lock_file
exec 9<>"$DEPLOY_LOCK_FILE"
flock -n 9 \
    || error "Aurora is currently installing, updating, or redeploying. Wait for it to finish."

cleanup_uninstall_exit() {
    local status=$?
    trap - EXIT
    if ${PG_STARTED_FOR_PURGE:-false}; then
        if systemctl stop "$PG_SERVICE" >/dev/null 2>&1 \
            && ! systemctl is-active "$PG_SERVICE" >/dev/null 2>&1; then
            info "Returned $PG_SERVICE to its pre-uninstall stopped state"
        else
            warn "Could not return $PG_SERVICE to its pre-uninstall stopped state."
            [ "$status" -ne 0 ] || status=1
        fi
    fi
    exec 9>&- 2>/dev/null || true
    exit "$status"
}
trap cleanup_uninstall_exit EXIT

# Make the destructive follow-up independent of the managed source tree before
# any teardown begins. This also upgrades legacy installations whose prior
# installer did not yet stage the recovery copy.
CURRENT_UNINSTALL_SCRIPT="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
install -d -m 0700 -o root -g root "$INSTALLER_LIB_DIR"
for _helper in env-file.sh install-state.sh; do
    if [ -f "$LIB_DIR/$_helper" ] \
        && [ "$(readlink -f "$LIB_DIR/$_helper")" != "$(readlink -f "$INSTALLER_LIB_DIR/$_helper" 2>/dev/null || true)" ]; then
        install -m 0600 -o root -g root "$LIB_DIR/$_helper" "$INSTALLER_LIB_DIR/$_helper"
    fi
done
if [ "$(readlink -f "$CURRENT_UNINSTALL_SCRIPT")" != "$(readlink -f "$STANDALONE_UNINSTALL" 2>/dev/null || true)" ]; then
    install -m 0700 -o root -g root "$CURRENT_UNINSTALL_SCRIPT" "$STANDALONE_UNINSTALL"
else
    chmod 0700 "$STANDALONE_UNINSTALL"
    chown root:root "$STANDALONE_UNINSTALL"
fi

# ── Detect PostgreSQL service name (same logic as install.sh) ───
detect_pg_service() {
    PG_SERVICE=""
    for svc in postgresql postgresql-{19,18,17,16,15,14,13}; do
        if systemctl cat "${svc}.service" &>/dev/null; then
            PG_SERVICE="$svc"
            break
        fi
    done
}

running_db_cluster_marker_status() {
    local current_data current_port current_system_identifier
    local current_db_oid current_role_oid
    declare -F aurora_db_ownership_marker_status >/dev/null 2>&1 \
        || return 1
    current_data="$(
        sudo -u postgres psql -X -qAt -c 'SHOW data_directory' \
            2>/dev/null || true
    )"
    current_port="$(
        sudo -u postgres psql -X -qAt -c 'SHOW port' \
            2>/dev/null || true
    )"
    current_system_identifier="$(
        sudo -u postgres psql -X -qAt \
            -c 'SELECT system_identifier::text FROM pg_control_system()' \
            2>/dev/null || true
    )"
    current_db_oid="$(
        sudo -u postgres psql -X -qAt \
            -c "SELECT oid::text FROM pg_database WHERE datname='${DB_NAME}'" \
            2>/dev/null
    )" || return 1
    current_role_oid="$(
        sudo -u postgres psql -X -qAt \
            -c "SELECT oid::text FROM pg_roles WHERE rolname='${DB_USER}'" \
            2>/dev/null
    )" || return 1
    aurora_db_ownership_marker_status \
        "$DB_OWNERSHIP_MARKER" "$DB_NAME" "$DB_USER" \
        "$current_data" "$current_port" "$current_system_identifier" \
        "$current_db_oid" "$current_role_oid"
}

running_db_cluster_marker_allows_cleanup() {
    local status=0
    running_db_cluster_marker_status || status=$?
    case "$status" in
        0|3) return 0 ;;
        *) return 1 ;;
    esac
}

# ── Detect what is installed ────────────────────────────────────
detect_components() {
    HAS_SERVICE=false
    HAS_BINARY=false
    HAS_INSTALL_DIR=false
    HAS_CONFIG_DIR=false
    HAS_CACHE_DIR=false
    HAS_TRANSCODE_FALLBACK=false
    HAS_NODE_TOOLCHAIN=false
    HAS_SYSTEM_USER=false
    HAS_SYSTEM_GROUP=false
    SYSTEM_USER_DELETE_SAFE=false
    SYSTEM_GROUP_DELETE_SAFE=false
    SYSTEM_USER_OWNED_UID=""
    HAS_DB=false
    HAS_DB_USER=false
    DB_TARGET_LOCAL=false
    DB_TARGET_EXTERNAL=false
    DB_PROVENANCE_MISSING=false
    DB_OWNERSHIP_VALID=false
    DB_MARKER_LEGACY=false
    DB_MARKER_MISMATCH=false
    RETAINED_DATABASE_URL=""
    PG_PROBE_FAILED=false
    PG_STARTED_FOR_PURGE=false
    SERVICE_ACTIVE=false
    HAS_NGINX_MAP=false
    HAS_MANAGED_NGINX_MAP=false
    HAS_CERTBOT_CERT=false
    CERT_NAME=""
    CERT_DOMAINS=""
    CERT_DELETE_SAFE=false
    PROXY_REMOVAL_PROVENANCE=false
    MANAGED_NGINX_CONFIGS=()
    EXTERNAL_NGINX_CONFIGS=()
    PROXY_DOMAIN=""

    # Auto-updater + state/log dirs (gaps closed 2026-05-18).
    HAS_UPDATER_SERVICE=false
    HAS_UPDATER_TIMER=false
    HAS_UPDATER_PATH=false
    TIMER_ACTIVE=false
    PATH_UNIT_ACTIVE=false
    HAS_UPDATER_BIN=false
    HAS_UPDATER_SUDOERS=false
    HAS_STATE_DIR=false
    HAS_LOG_DIR=false
    HAS_INSTALLER_LOG_DIR=false
    HAS_GIT_CREDENTIAL=false
    HAS_STANDALONE_UNINSTALL=false

    # Media library paths captured BEFORE the DB is dropped so we can
    # reverse the ACLs install.sh applied with setfacl. Populated only
    # when the DB is reachable.
    MEDIA_PATHS=()

    if [ -f "$SYSTEMD_UNIT" ]; then
        HAS_SERVICE=true
        if systemctl is-active aurora &>/dev/null; then
            SERVICE_ACTIVE=true
        fi
    fi
    [ -f "$INSTALL_BIN" ] && HAS_BINARY=true || true
    [ -d "$INSTALL_DIR" ] && HAS_INSTALL_DIR=true || true
    [ -d "$CONFIG_DIR" ] && HAS_CONFIG_DIR=true || true
    [ -d "$CACHE_DIR" ] && HAS_CACHE_DIR=true || true
    [ -d "$TRANSCODE_FALLBACK" ] && HAS_TRANSCODE_FALLBACK=true || true
    [ -d "$NODE_TOOLCHAIN_DIR" ] && HAS_NODE_TOOLCHAIN=true || true
    if id "$AURORA_USER" &>/dev/null; then
        HAS_SYSTEM_USER=true
        _current_uid="$(id -u "$AURORA_USER")"
        _owned_uid="$(sed -n '1p' "$SYSTEM_USER_MARKER" 2>/dev/null || true)"
        if [ "$_owned_uid" = "$_current_uid" ]; then
            SYSTEM_USER_DELETE_SAFE=true
            SYSTEM_USER_OWNED_UID="$_current_uid"
        fi
    fi
    if getent group "$AURORA_GROUP" &>/dev/null; then
        HAS_SYSTEM_GROUP=true
        _current_gid="$(getent group "$AURORA_GROUP" | cut -d: -f3)"
        _owned_gid="$(sed -n '1p' "$SYSTEM_GROUP_MARKER" 2>/dev/null || true)"
        [ "$_owned_gid" = "$_current_gid" ] && SYSTEM_GROUP_DELETE_SAFE=true
    fi

    # Auto-updater pipeline.
    [ -f "$UPDATER_SERVICE" ] && HAS_UPDATER_SERVICE=true || true
    if [ -f "$UPDATER_TIMER" ]; then
        HAS_UPDATER_TIMER=true
        if systemctl is-active aurora-update.timer &>/dev/null; then
            TIMER_ACTIVE=true
        fi
    fi
    if [ -f "$UPDATER_PATH_UNIT" ]; then
        HAS_UPDATER_PATH=true
        if systemctl is-active aurora-update.path &>/dev/null; then
            PATH_UNIT_ACTIVE=true
        fi
    fi
    [ -f "$UPDATER_BIN" ]     && HAS_UPDATER_BIN=true     || true
    [ -f "$UPDATER_SUDOERS" ] && HAS_UPDATER_SUDOERS=true || true
    [ -d "$STATE_DIR" ]       && HAS_STATE_DIR=true       || true
    [ -d "$LOG_DIR" ]         && HAS_LOG_DIR=true         || true
    [ -d "$INSTALLER_LOG_DIR" ] && HAS_INSTALLER_LOG_DIR=true || true
    [ -f "$GIT_CREDENTIAL_FILE" ] && HAS_GIT_CREDENTIAL=true || true
    [ -f "$STANDALONE_UNINSTALL" ] && HAS_STANDALONE_UNINSTALL=true || true

    if [ -f "$CONFIG_DIR/aurora.env" ] \
        && declare -F aurora_env_get_unquoted >/dev/null 2>&1; then
        RETAINED_DATABASE_URL="$(
            aurora_env_get_unquoted "$CONFIG_DIR/aurora.env" DATABASE_URL 2>/dev/null || true
        )"
    fi
    if [ -n "$RETAINED_DATABASE_URL" ]; then
        if declare -F aurora_database_url_is_local_database >/dev/null 2>&1 \
            && aurora_database_url_is_local_database "$RETAINED_DATABASE_URL" "$DB_NAME"; then
            DB_TARGET_LOCAL=true
        else
            DB_TARGET_EXTERNAL=true
            if $PURGE && ! $EXTERNAL_DB_PURGED; then
                record_purge_failure \
                    "External DATABASE_URL was retained. Delete its Aurora data/role, then retry with --external-db-purged."
            fi
        fi
    elif [ -f "$DB_OWNERSHIP_MARKER" ]; then
        DB_TARGET_LOCAL=true
    else
        DB_PROVENANCE_MISSING=true
        if $PURGE; then
            record_purge_failure \
                "No durable database ownership marker or retained DATABASE_URL exists; local PostgreSQL was not touched."
        fi
    fi
    if $DB_TARGET_LOCAL && [ ! -f "$DB_OWNERSHIP_MARKER" ]; then
        DB_PROVENANCE_MISSING=true
        DB_TARGET_LOCAL=false
        if $PURGE; then
            record_purge_failure \
                "Local DATABASE_URL lacks Aurora's durable cluster ownership marker; database/role were preserved."
        fi
    fi

    # Check PostgreSQL database and user. Never infer "absent" from a
    # stopped/unreachable server: start a detected local service long enough
    # to capture media paths and protected-object state, then restore its
    # original stopped state.
    if $DB_TARGET_EXTERNAL || $DB_PROVENANCE_MISSING; then
        :
    elif $DB_TARGET_LOCAL && command -v psql &>/dev/null && id postgres &>/dev/null; then
        if ! sudo -u postgres psql -X -qAt -c "SELECT 1" &>/dev/null; then
            if [ -n "$PG_SERVICE" ]; then
                info "PostgreSQL is not reachable; starting $PG_SERVICE for uninstall inspection..."
                if ! systemctl is-active "$PG_SERVICE" >/dev/null 2>&1; then
                    PG_STARTED_FOR_PURGE=true
                    systemctl start "$PG_SERVICE" >/dev/null 2>&1 || true
                fi
                for _ in $(seq 1 30); do
                    if sudo -u postgres psql -X -qAt -c "SELECT 1" &>/dev/null; then
                        break
                    fi
                    sleep 1
                done
            fi
        fi
        if sudo -u postgres psql -X -qAt -c "SELECT 1" &>/dev/null; then
            _marker_status=0
            running_db_cluster_marker_status || _marker_status=$?
            if [ "$_marker_status" = "0" ] || [ "$_marker_status" = "3" ]; then
                DB_OWNERSHIP_VALID=true
                _db_probe="$(
                    sudo -u postgres psql -X -qAt \
                        -c "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" \
                        2>/dev/null
                )" || PG_PROBE_FAILED=true
                if [ "$_db_probe" = "1" ]; then
                    _db_owner="$(
                        sudo -u postgres psql -X -qAt \
                            -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='${DB_NAME}'" \
                            2>/dev/null
                    )" || PG_PROBE_FAILED=true
                    if [ "$_db_owner" != "$DB_USER" ]; then
                        PG_PROBE_FAILED=true
                    else
                        HAS_DB=true
                        # Capture library paths now — they're our only handle
                        # for reversing the ACLs install.sh applied.
                        # libraries.paths is TEXT[] NOT NULL in migration 001;
                        # unnest it, dedupe, and preserve arbitrary characters
                        # with NUL record separators.
                        _libraries_probe="$(
                            sudo -u postgres psql -X -qAt -v ON_ERROR_STOP=1 \
                                -d "$DB_NAME" \
                                -c "SELECT to_regclass('public.libraries') IS NOT NULL;" \
                                2>/dev/null
                        )" || PG_PROBE_FAILED=true
                        if [ "$_libraries_probe" = "t" ]; then
                            _media_tmp="$(mktemp)"
                            chmod 0600 "$_media_tmp"
                            # shellcheck disable=SC2024 # the uninstaller is root; root owns the redirection
                            if sudo -u postgres psql -X -qAt -0 -v ON_ERROR_STOP=1 \
                                -d "$DB_NAME" -c \
                                "SELECT DISTINCT p FROM libraries, unnest(paths) AS u(p) WHERE u.p IS NOT NULL AND u.p <> '';" \
                                > "$_media_tmp" 2>/dev/null; then
                                while IFS= read -r -d '' _path; do
                                    append_media_path_for_cleanup "$_path"
                                done < "$_media_tmp"
                            else
                                PG_PROBE_FAILED=true
                            fi
                            rm -f "$_media_tmp"
                        elif [ "$_libraries_probe" != "f" ]; then
                            PG_PROBE_FAILED=true
                        fi
                    fi
                fi
                _role_probe="$(
                    sudo -u postgres psql -X -qAt \
                        -c "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" \
                        2>/dev/null
                )" || PG_PROBE_FAILED=true
                if [ "$_role_probe" = "1" ]; then
                    HAS_DB_USER=true
                fi
            else
                PG_PROBE_FAILED=true
                if [ "$_marker_status" = "2" ]; then
                    DB_MARKER_LEGACY=true
                    $PURGE && record_purge_failure \
                        "The legacy database marker lacks complete PostgreSQL cluster/object identity; verify ownership and run the full installer once with AURORA_ADOPT_EXISTING_IDENTITIES=true."
                else
                    DB_MARKER_MISMATCH=true
                    $PURGE && record_purge_failure \
                        "The database ownership marker does not match the running PostgreSQL cluster/database/role objects; nothing was removed."
                fi
            fi
        else
            PG_PROBE_FAILED=true
        fi
    elif $DB_TARGET_LOCAL; then
        PG_PROBE_FAILED=true
    fi

    if [ -f "$PENDING_MEDIA_PATHS_FILE" ]; then
        while IFS= read -r -d '' _path; do
            append_media_path_for_cleanup "$_path"
        done < "$PENDING_MEDIA_PATHS_FILE"
    fi
    if [ -f "$MANAGED_MEDIA_PATHS_FILE" ]; then
        while IFS= read -r -d '' _path; do
            append_media_path_for_cleanup "$_path"
        done < "$MANAGED_MEDIA_PATHS_FILE"
    fi

    # Check for reverse proxy setup (nginx config + Let's Encrypt cert)
    if declare -F aurora_read_proxy_domain_state >/dev/null 2>&1; then
        PROXY_DOMAIN="$(
            aurora_read_proxy_domain_state \
                "$PROXY_ACTIVE_MARKER" "$PROXY_REMOVED_MARKER" \
                "$PROXY_CERT_OWNER_MARKER" 2>/dev/null || true
        )"
    fi
    if [ -z "$PROXY_DOMAIN" ] && [ -f "$PROXY_REMOVAL_PROVENANCE_MARKER" ]; then
        _durable_proxy_domain="$(
            sed -n '1p' "$PROXY_REMOVAL_PROVENANCE_MARKER" 2>/dev/null || true
        )"
        if declare -F aurora_proxy_domain_is_valid >/dev/null 2>&1 \
            && aurora_proxy_domain_is_valid "$_durable_proxy_domain"; then
            PROXY_DOMAIN="$_durable_proxy_domain"
        fi
    fi
    if [ -z "$PROXY_DOMAIN" ] && [ -f "$PROXY_CERT_DURABLE_MARKER" ]; then
        _durable_cert_domain="$(
            sed -n '2p' "$PROXY_CERT_DURABLE_MARKER" 2>/dev/null || true
        )"
        if declare -F aurora_proxy_domain_is_valid >/dev/null 2>&1 \
            && aurora_proxy_domain_is_valid "$_durable_cert_domain"; then
            PROXY_DOMAIN="$_durable_cert_domain"
        fi
    fi
    for _f in /etc/nginx/sites-available/aurora.conf /etc/nginx/conf.d/aurora.conf; do
        if [ -f "$_f" ]; then
            if declare -F aurora_proxy_config_is_managed >/dev/null 2>&1 \
                && aurora_proxy_config_is_managed "$_f"; then
                MANAGED_NGINX_CONFIGS+=("$_f")
            else
                EXTERNAL_NGINX_CONFIGS+=("$_f")
            fi
        fi
    done
    if [ "${#MANAGED_NGINX_CONFIGS[@]}" -gt 0 ]; then
        PROXY_REMOVAL_PROVENANCE=true
    fi
    if [ -f "$PROXY_REMOVED_MARKER" ]; then
        _removed_domain="$(sed -n '1p' "$PROXY_REMOVED_MARKER" 2>/dev/null || true)"
        if declare -F aurora_proxy_domain_is_valid >/dev/null 2>&1 \
            && aurora_proxy_domain_is_valid "$_removed_domain" \
            && [ "$_removed_domain" = "$PROXY_DOMAIN" ]; then
            PROXY_REMOVAL_PROVENANCE=true
        fi
    fi
    if [ -f "$PROXY_REMOVAL_PROVENANCE_MARKER" ]; then
        _durable_removed_domain="$(
            sed -n '1p' "$PROXY_REMOVAL_PROVENANCE_MARKER" 2>/dev/null || true
        )"
        if declare -F aurora_proxy_domain_is_valid >/dev/null 2>&1 \
            && aurora_proxy_domain_is_valid "$_durable_removed_domain" \
            && [ "$_durable_removed_domain" = "$PROXY_DOMAIN" ]; then
            PROXY_REMOVAL_PROVENANCE=true
        fi
    fi
    if [ "${#EXTERNAL_NGINX_CONFIGS[@]}" -gt 0 ]; then
        PROXY_REMOVAL_PROVENANCE=false
    fi
    if [ -f /etc/nginx/conf.d/aurora-map.conf ]; then
        HAS_NGINX_MAP=true
        if grep -Fq '# Aurora — WebSocket upgrade map for /ws' \
            /etc/nginx/conf.d/aurora-map.conf 2>/dev/null; then
            HAS_MANAGED_NGINX_MAP=true
        fi
    fi
    if [ -n "$PROXY_DOMAIN" ]; then
        _cert_record=""
        if command -v certbot >/dev/null 2>&1; then
            _cert_record="$(
                certbot certificates 2>/dev/null | awk -v domain="$PROXY_DOMAIN" '
                    $1 == "Certificate" && $2 == "Name:" { name = $3 }
                    $1 == "Domains:" {
                        domains = ""
                        matched = 0
                        for (i = 2; i <= NF; i++) {
                            domains = domains (domains == "" ? "" : " ") $i
                            if ($i == domain) matched = 1
                        }
                        if (matched) {
                            print name "|" domains
                            exit
                        }
                    }
                ' || true
            )"
        fi
        if [ -n "$_cert_record" ]; then
            CERT_NAME="${_cert_record%%|*}"
            CERT_DOMAINS="${_cert_record#*|}"
            HAS_CERTBOT_CERT=true
        elif [ -d "/etc/letsencrypt/live/$PROXY_DOMAIN" ]; then
            # Legacy/common cert-name layout. It is present, but not safe to
            # delete without a successful SAN + ownership probe.
            HAS_CERTBOT_CERT=true
        fi

        _cert_ownership_source=""
        if [ -f "$PROXY_CERT_OWNER_MARKER" ]; then
            _cert_ownership_source="$PROXY_CERT_OWNER_MARKER"
        elif [ -f "$PROXY_CERT_DURABLE_MARKER" ]; then
            _cert_ownership_source="$PROXY_CERT_DURABLE_MARKER"
        fi
        if [ -n "$_cert_ownership_source" ]; then
            _owned_cert_name="$(sed -n '1p' "$_cert_ownership_source" 2>/dev/null || true)"
            _owned_cert_domain="$(sed -n '2p' "$_cert_ownership_source" 2>/dev/null || true)"
            if $PROXY_REMOVAL_PROVENANCE \
                && declare -F aurora_certificate_delete_is_safe >/dev/null 2>&1 \
                && aurora_certificate_delete_is_safe \
                    "$_owned_cert_name" "$_owned_cert_domain" \
                    "$CERT_NAME" "$CERT_DOMAINS" "$PROXY_DOMAIN"; then
                CERT_DELETE_SAFE=true
            fi
        fi
    fi
}

# ══════════════════════════════════════════════════════════════════
# Banner
# ══════════════════════════════════════════════════════════════════

echo ""
echo "  ============================================================"
echo "   Aurora Media Server - Uninstaller"
echo "  ============================================================"
echo ""

detect_pg_service
detect_components
if [ -e "$DB_RECOVERY_MARKER" ] || [ -L "$DB_RECOVERY_MARKER" ]; then
    error "Aurora has an interrupted PostgreSQL creation/recovery in progress.
Rerun the full installer to converge its database credential and object
identity before uninstalling:
  sudo /var/lib/aurora/source/scripts/install.sh"
fi
for _media_override in "${MEDIA_PATH_OVERRIDES[@]}"; do
    case "$_media_override" in
        /*) ;;
        *) error "--media-path must be absolute: $_media_override" ;;
    esac
    _media_override_canonical="$(readlink -m -- "$_media_override" 2>/dev/null || true)"
    [ -n "$_media_override_canonical" ] \
        || error "Could not canonicalize --media-path=$_media_override"
    if ! declare -F aurora_media_root_rejection_reason >/dev/null 2>&1; then
        error "Missing installer safety helper; cannot validate --media-path."
    fi
    if _media_override_rejection="$(
        aurora_media_root_rejection_reason "$_media_override_canonical"
    )"; then
        error "Unsafe --media-path=$_media_override: $_media_override_rejection"
    fi
    append_media_path_for_cleanup "$_media_override_canonical"
done

if $EXTERNAL_DB_PURGED && ! $DB_TARGET_EXTERNAL; then
    error "--external-db-purged was supplied, but retained configuration does not target an external database."
fi
if $PURGE && $DB_MARKER_MISMATCH; then
    error "The retained database marker does not match the current PostgreSQL cluster/database/role identities. Purge aborted before removing files.
Aurora will not recommend or run destructive SQL against replacement objects.
Independently verify the '$DB_USER' role and '$DB_NAME' database before
deciding whether to adopt them."
elif $PURGE && $DB_MARKER_LEGACY; then
    error "The legacy database marker lacks complete PostgreSQL cluster/object identity. Purge aborted before removing files.
After independently verifying the cluster, '$DB_USER' role, and '$DB_NAME'
database belong to Aurora, run the full installer once with
AURORA_ADOPT_EXISTING_IDENTITIES=true, then retry."
elif $PURGE && $PG_PROBE_FAILED; then
    error "Cannot prove ownership of PostgreSQL database/user '${DB_NAME}'. Purge aborted before removing files.
Start PostgreSQL and retry. Do not drop same-named objects manually unless you
have independently verified they belong to Aurora."
elif $PG_PROBE_FAILED; then
    warn "PostgreSQL could not be inspected. Safe uninstall will leave any Aurora database and role untouched."
fi

# ══════════════════════════════════════════════════════════════════
# Summary of what will be removed
# ══════════════════════════════════════════════════════════════════

info "The following Aurora components were detected:"
echo ""

FOUND_SOMETHING=false

if $HAS_SERVICE; then
    if $SERVICE_ACTIVE; then
        printf '    %-42s %s\n' "Systemd service (aurora.service)" "[RUNNING]"
    else
        printf '    %-42s %s\n' "Systemd service (aurora.service)" "[installed]"
    fi
    FOUND_SOMETHING=true
fi
if $HAS_UPDATER_TIMER || $HAS_UPDATER_SERVICE || $HAS_UPDATER_PATH || $HAS_UPDATER_BIN || $HAS_UPDATER_SUDOERS; then
    case "${TIMER_ACTIVE}-${PATH_UNIT_ACTIVE}" in
        true-true)  status="[TIMER + PATH ACTIVE]" ;;
        true-false) status="[TIMER ACTIVE]" ;;
        false-true) status="[PATH ACTIVE]" ;;
        *)          status="[installed]" ;;
    esac
    printf '    %-42s %s\n' "Auto-updater (aurora-update.*)" "$status"
    FOUND_SOMETHING=true
fi
if $HAS_BINARY; then
    printf '    %-42s %s\n' "Binary" "$INSTALL_BIN"
    FOUND_SOMETHING=true
fi
if $HAS_INSTALL_DIR; then
    printf '    %-42s %s\n' "Install directory" "$INSTALL_DIR"
    FOUND_SOMETHING=true
fi
if $HAS_CONFIG_DIR; then
    printf '    %-42s %s\n' "Configuration" "$CONFIG_DIR"
    FOUND_SOMETHING=true
fi
if $HAS_STATE_DIR; then
    printf '    %-42s %s\n' "State directory (source mirror)" "$STATE_DIR"
    FOUND_SOMETHING=true
fi
if $HAS_LOG_DIR; then
    printf '    %-42s %s\n' "Log directory" "$LOG_DIR"
    FOUND_SOMETHING=true
fi
if $HAS_INSTALLER_LOG_DIR; then
    printf '    %-42s %s\n' "Installer/updater logs" "$INSTALLER_LOG_DIR"
    FOUND_SOMETHING=true
fi
if $HAS_GIT_CREDENTIAL; then
    printf '    %-42s %s\n' "Private-repository credential" "$GIT_CREDENTIAL_FILE"
    FOUND_SOMETHING=true
fi
if $HAS_STANDALONE_UNINSTALL; then
    if $PURGE; then
        printf '    %-42s %s\n' "Recovery uninstaller" "$STANDALONE_UNINSTALL"
    else
        printf '    %-42s %s\n' "Recovery uninstaller" "[preserved for later purge]"
    fi
    FOUND_SOMETHING=true
fi
if $HAS_CACHE_DIR; then
    printf '    %-42s %s\n' "Cache directory" "$CACHE_DIR"
    FOUND_SOMETHING=true
fi
if $HAS_TRANSCODE_FALLBACK; then
    printf '    %-42s %s\n' "Transcode fallback" "$TRANSCODE_FALLBACK"
    FOUND_SOMETHING=true
fi
if $HAS_NODE_TOOLCHAIN; then
    printf '    %-42s %s\n' "Aurora Node.js build toolchain" "$NODE_TOOLCHAIN_DIR"
    FOUND_SOMETHING=true
fi
if $HAS_DB; then
    printf '    %-42s %s\n' "PostgreSQL database" "$DB_NAME"
    FOUND_SOMETHING=true
fi
if $HAS_DB_USER; then
    printf '    %-42s %s\n' "PostgreSQL user" "$DB_USER"
    FOUND_SOMETHING=true
fi
if $DB_TARGET_EXTERNAL; then
    printf '    %-42s %s\n' "External PostgreSQL data/role" "[preserved; manual cleanup]"
    FOUND_SOMETHING=true
fi
if [ "${#MEDIA_PATHS[@]}" -gt 0 ]; then
    printf '    %-42s %s\n' "Media-library ACLs (aurora user)" "${#MEDIA_PATHS[@]} path(s)"
    FOUND_SOMETHING=true
fi
if $HAS_SYSTEM_USER; then
    if $SYSTEM_USER_DELETE_SAFE; then
        printf '    %-42s %s\n' "System user" "$AURORA_USER [Aurora-owned]"
    else
        printf '    %-42s %s\n' "System user" "$AURORA_USER [preserved: unowned]"
    fi
    FOUND_SOMETHING=true
fi
if $HAS_SYSTEM_GROUP; then
    if $SYSTEM_GROUP_DELETE_SAFE; then
        printf '    %-42s %s\n' "System group" "$AURORA_GROUP [Aurora-owned]"
    else
        printf '    %-42s %s\n' "System group" "$AURORA_GROUP [preserved: unowned]"
    fi
    FOUND_SOMETHING=true
fi
if [ "${#MANAGED_NGINX_CONFIGS[@]}" -gt 0 ] || $HAS_MANAGED_NGINX_MAP; then
    printf '    %-42s %s\n' "Aurora-managed nginx proxy" "aurora.conf"
    FOUND_SOMETHING=true
fi
if [ "${#EXTERNAL_NGINX_CONFIGS[@]}" -gt 0 ] \
    || { $HAS_NGINX_MAP && ! $HAS_MANAGED_NGINX_MAP; }; then
    printf '    %-42s %s\n' "Operator-managed nginx config" "[preserved]"
    FOUND_SOMETHING=true
fi
if $HAS_CERTBOT_CERT; then
    printf '    %-42s %s\n' "Let's Encrypt certificate" "$PROXY_DOMAIN"
    FOUND_SOMETHING=true
fi

if ! $FOUND_SOMETHING; then
    echo ""
    info "No Aurora components found on this system. Nothing to remove."
    exit 0
fi

echo ""

if ! confirm "Proceed with uninstallation?"; then
    info "Uninstallation cancelled."
    exit 0
fi

if [ "${#MEDIA_PATHS[@]}" -gt 0 ]; then
    : > "$PENDING_MEDIA_PATHS_FILE.tmp"
    chmod 0600 "$PENDING_MEDIA_PATHS_FILE.tmp"
    chown root:root "$PENDING_MEDIA_PATHS_FILE.tmp"
    for _path in "${MEDIA_PATHS[@]}"; do
        printf '%s\0' "$_path" >> "$PENDING_MEDIA_PATHS_FILE.tmp"
    done
    mv -f "$PENDING_MEDIA_PATHS_FILE.tmp" "$PENDING_MEDIA_PATHS_FILE"
fi

# ══════════════════════════════════════════════════════════════════
# Step 1: Stop the auto-updater (timer + service) FIRST
# ══════════════════════════════════════════════════════════════════
# The timer fires aurora-update.service every 5 min. If we tear down
# aurora.service without stopping the timer first, the next tick will
# try to `git pull && go build && systemctl restart aurora` against
# half-removed state. Take the timer offline before anything else.

echo ""
info "Step 1/9: Stopping auto-updater (timer + service)..."
echo ""

if $HAS_UPDATER_TIMER || $HAS_UPDATER_SERVICE || $HAS_UPDATER_PATH; then
    # Stop the .path watcher FIRST so any in-flight trigger file
    # write can't kick off another service start mid-teardown.
    if $PATH_UNIT_ACTIVE; then
        info "Stopping aurora-update.path..."
        systemctl stop aurora-update.path 2>/dev/null || true
    fi
    if $TIMER_ACTIVE; then
        info "Stopping aurora-update.timer..."
        systemctl stop aurora-update.timer 2>/dev/null || true
    fi
    systemctl stop aurora-update.path aurora-update.timer 2>/dev/null || true
    # In case the timer or path unit just fired and the .service is running.
    if systemctl is-active aurora-update.service &>/dev/null; then
        info "Waiting for in-flight aurora-update.service to finish..."
        for _ in $(seq 1 30); do
            if ! systemctl is-active aurora-update.service &>/dev/null; then
                break
            fi
            sleep 1
        done
        if systemctl is-active aurora-update.service &>/dev/null; then
            warn "aurora-update.service did not exit in 30s. Sending SIGKILL..."
            systemctl kill -s SIGKILL aurora-update.service 2>/dev/null || true
            sleep 1
        fi
    fi

    for _unit in aurora-update.path aurora-update.timer aurora-update.service; do
        if systemctl is-active "$_unit" >/dev/null 2>&1; then
            error "$_unit is still active after stop/SIGKILL attempts. Aborting before removing updater units, binaries, source, or application data.
Inspect: sudo systemctl status $_unit && sudo journalctl -u $_unit -n 100"
        fi
    done

    info "Disabling + removing aurora-update units..."
    systemctl disable aurora-update.path     2>/dev/null || true
    systemctl disable aurora-update.timer    2>/dev/null || true
    systemctl disable aurora-update.service  2>/dev/null || true
    rm -f "$UPDATER_PATH_UNIT" "$UPDATER_TIMER" "$UPDATER_SERVICE"
    systemctl daemon-reload 2>/dev/null || true
    systemctl reset-failed aurora-update.path     2>/dev/null || true
    systemctl reset-failed aurora-update.timer    2>/dev/null || true
    systemctl reset-failed aurora-update.service  2>/dev/null || true
    ok "Auto-updater units removed"
else
    ok "No auto-updater units found (skipping)"
fi

# Updater script + sudoers grant. Safe to remove now that the timer
# can't re-invoke them.
if $HAS_UPDATER_BIN; then
    rm -f "$UPDATER_BIN"
    ok "Removed $UPDATER_BIN"
fi
if $HAS_UPDATER_SUDOERS; then
    # Validate the sudoers tree is still parseable AFTER removing our
    # drop-in (defensive — install.sh validated before installing, so
    # this should always pass). If it doesn't, the system can lock
    # itself out of sudo, which is exactly the failure mode our
    # install.sh visudo -cf guard exists to prevent.
    rm -f "$UPDATER_SUDOERS"
    if command -v visudo &>/dev/null && ! visudo -c >/dev/null 2>&1; then
        warn "visudo -c FAILED after removing $UPDATER_SUDOERS — investigate"
        warn "(this should be impossible; the file we removed was syntax-checked at install)"
    fi
    ok "Removed $UPDATER_SUDOERS"
fi

# ══════════════════════════════════════════════════════════════════
# Step 2: Stop and disable the aurora systemd service
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 2/9: Stopping Aurora service..."
echo ""

if $HAS_SERVICE; then
    if $SERVICE_ACTIVE; then
        info "Stopping aurora service..."
        systemctl stop aurora 2>/dev/null || true
        # Wait up to 10 seconds for clean shutdown
        for _ in $(seq 1 10); do
            if ! systemctl is-active aurora &>/dev/null; then
                break
            fi
            sleep 1
        done
        if systemctl is-active aurora &>/dev/null; then
            warn "Service did not stop cleanly. Sending SIGKILL..."
            systemctl kill -s SIGKILL aurora 2>/dev/null || true
            sleep 1
        fi
        if systemctl is-active aurora &>/dev/null; then
            error "Aurora is still active after stop + SIGKILL. Aborting before removing the unit, binary, config, or database.
Inspect: sudo systemctl status aurora && sudo journalctl -u aurora -n 100"
        fi
        ok "Service stop verified"
    else
        ok "Service was not running"
    fi

    info "Disabling and removing systemd unit..."
    systemctl disable aurora 2>/dev/null || true
    rm -f "$SYSTEMD_UNIT"
    systemctl daemon-reload 2>/dev/null || true
    systemctl reset-failed aurora 2>/dev/null || true
    ok "Systemd service removed"
else
    ok "No systemd service found (skipping)"
fi

# ══════════════════════════════════════════════════════════════════
# Step 3: Remove application files
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 3/9: Removing application files..."
echo ""

if $HAS_BINARY; then
    rm -f "$INSTALL_BIN"
    ok "Removed $INSTALL_BIN"
else
    ok "Binary not found (skipping)"
fi

if $HAS_INSTALL_DIR; then
    rm -rf "$INSTALL_DIR"
    ok "Removed $INSTALL_DIR"
else
    ok "Install directory not found (skipping)"
fi

# ══════════════════════════════════════════════════════════════════
# Step 4: Remove configuration
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 4/9: Removing configuration..."
echo ""

if $HAS_CONFIG_DIR; then
    if confirm "Remove configuration directory $CONFIG_DIR (includes aurora.env with secrets)?" "N"; then
        DEFER_CONFIG_PURGE=true
        info "Deferring $CONFIG_DIR removal until database, proxy, ACL, and identity cleanup finishes"
    else
        chown -R root:root "$CONFIG_DIR"
        find "$CONFIG_DIR" -xdev -type d -exec chmod 0700 {} +
        find "$CONFIG_DIR" -xdev -type f -exec chmod 0600 {} +
        warn "Keeping $CONFIG_DIR"
        ok "Retained configuration secured for root-only access"
    fi
else
    ok "Configuration directory not found (skipping)"
fi

# Aurora owns a dedicated credential file. Never edit root's general
# ~/.git-credentials because a github.com entry there may belong to another
# repository or account.
if $HAS_GIT_CREDENTIAL; then
    if confirm "Remove Aurora's private-repository credential?"; then
        rm -f "$GIT_CREDENTIAL_FILE"
        rmdir "$GIT_CREDENTIAL_DIR" 2>/dev/null || true
        ok "Removed Aurora's private-repository credential"
    else
        warn "Keeping $GIT_CREDENTIAL_FILE"
    fi
fi

# ══════════════════════════════════════════════════════════════════
# Step 5: Remove cache and transcode data
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 5/9: Removing cache and transcode data..."
echo ""

if $HAS_CACHE_DIR; then
    rm -rf "$CACHE_DIR"
    ok "Removed $CACHE_DIR (images, subtitles, transcode cache)"
else
    ok "Cache directory not found (skipping)"
fi

if $HAS_TRANSCODE_FALLBACK; then
    rm -rf "$TRANSCODE_FALLBACK"
    ok "Removed $TRANSCODE_FALLBACK"
else
    ok "Transcode fallback directory not found (skipping)"
fi

if $HAS_NODE_TOOLCHAIN; then
    rm -rf "$NODE_TOOLCHAIN_DIR"
    # Earlier Aurora installer revisions created global symlinks. Remove only
    # links that still point into Aurora's owned toolchain.
    for tool in node npm npx corepack; do
        link="/usr/local/bin/$tool"
        if [ -L "$link" ] \
            && [[ "$(readlink "$link")" == "$NODE_TOOLCHAIN_DIR/"* ]]; then
            rm -f "$link"
        fi
    done
    ok "Removed Aurora's Node.js build toolchain"
fi

# ══════════════════════════════════════════════════════════════════
# Step 6: Remove PostgreSQL database and user
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 6/9: PostgreSQL cleanup..."
echo ""

if $DB_TARGET_EXTERNAL; then
    if $EXTERNAL_DB_PURGED; then
        ok "External PostgreSQL cleanup acknowledged; no local database/role was touched"
    else
        warn "Retaining external PostgreSQL data and role; Aurora will not connect as"
        warn "that provider's administrator or touch an unrelated local '$DB_NAME' database."
    fi
    if $PURGE && ! $EXTERNAL_DB_PURGED; then
        warn "Delete the external Aurora database/role with your provider, then rerun"
        warn "with: sudo $STANDALONE_UNINSTALL --yes --purge --external-db-purged"
    fi
elif $DB_PROVENANCE_MISSING || { $DB_TARGET_LOCAL && ! $DB_OWNERSHIP_VALID; }; then
    warn "Local PostgreSQL database/role ownership could not be proven."
    warn "No local database or role was queried, rotated, or dropped."
    if $DB_MARKER_LEGACY; then
        warn "This marker predates Aurora's complete PostgreSQL cluster/object identity."
        warn "After verifying the cluster and identities belong to Aurora, run the"
        warn "full installer once with AURORA_ADOPT_EXISTING_IDENTITIES=true."
    elif $DB_MARKER_MISMATCH; then
        warn "The retained marker identifies a different cluster or same-named objects."
        warn "Do not adopt them unless you have independently verified the current"
        warn "cluster and its '$DB_USER' role/'$DB_NAME' database belong to Aurora."
    else
        warn "Run the full installer with AURORA_ADOPT_EXISTING_IDENTITIES=true"
        warn "after verifying the identities belong to Aurora, then retry uninstall."
    fi
elif $HAS_DB || $HAS_DB_USER; then
    if ! command -v psql &>/dev/null; then
        warn "psql not found. Cannot remove PostgreSQL database/user automatically."
        warn "Install the matching PostgreSQL client and retry so Aurora can"
        warn "revalidate cluster identity and ownership before destructive SQL."
        $PURGE && record_purge_failure \
            "Database/role removal was not attempted because psql is unavailable."
    elif ! sudo -u postgres psql -c "SELECT 1" &>/dev/null; then
        warn "Cannot connect to PostgreSQL. Is the service running?"
        if [ -n "$PG_SERVICE" ]; then
            warn "Try: sudo systemctl start $PG_SERVICE"
        fi
        warn "Retry after restoring access; no unguarded manual drop is recommended."
        $PURGE && record_purge_failure \
            "Database/role removal was not attempted because PostgreSQL became unreachable."
    elif ! running_db_cluster_marker_allows_cleanup; then
        DB_OWNERSHIP_VALID=false
        warn "PostgreSQL cluster/database/role identity changed after uninstall inspection."
        warn "No database or role was dropped."
        $PURGE && record_purge_failure \
            "PostgreSQL cluster/database/role identity changed before destructive cleanup; nothing was removed."
    else
        DROPPED_DB=false
        DROPPED_USER=false
        DROP_DB_REQUESTED=false
        DROP_ROLE_REQUESTED=false

        if $HAS_DB; then
            if confirm "Drop PostgreSQL database '${DB_NAME}'? (ALL Aurora data will be permanently lost)" "N"; then
                DROP_DB_REQUESTED=true
            else
                warn "Keeping database '${DB_NAME}'"
            fi
        else
            ok "Database '${DB_NAME}' not found (skipping)"
        fi

        if $HAS_DB_USER; then
            if confirm "Drop PostgreSQL user '${DB_USER}'?" "N"; then
                DROP_ROLE_REQUESTED=true
            else
                warn "Keeping PostgreSQL user '${DB_USER}'"
            fi
        else
            ok "PostgreSQL user '${DB_USER}' not found (skipping)"
        fi

        if $DROP_DB_REQUESTED; then
            info "Revalidating cluster identity and owner, then dropping database '${DB_NAME}'..."
            if aurora_psql_drop_owned_database \
                "$DB_OWNERSHIP_MARKER" "$DB_NAME" "$DB_USER"; then
                ok "Database '${DB_NAME}' dropped"
                DROPPED_DB=true
            else
                warn "Guarded database removal failed; no role removal will follow."
                warn "Restore PostgreSQL readiness and verify the ownership marker, then retry."
                $PURGE && record_purge_failure \
                    "Guarded removal of database '$DB_NAME' failed; cluster identity/owner must be reverified before retry."
            fi
        fi

        if $DROP_ROLE_REQUESTED; then
            if $HAS_DB && ! $DROPPED_DB; then
                warn "Keeping PostgreSQL role '${DB_USER}' because its owned database was retained or could not be removed."
                $PURGE && record_purge_failure \
                    "PostgreSQL role '$DB_USER' was preserved because database '$DB_NAME' remains."
            else
                info "Revalidating cluster identity, then dropping PostgreSQL role '${DB_USER}'..."
                if aurora_psql_drop_owned_role \
                    "$DB_OWNERSHIP_MARKER" "$DB_USER"; then
                    ok "PostgreSQL role '${DB_USER}' dropped"
                    DROPPED_USER=true
                else
                    warn "Guarded role removal failed; the role was not assumed safe to delete."
                    warn "Verify cluster identity and remaining owned objects, then retry."
                    $PURGE && record_purge_failure \
                        "Guarded removal of PostgreSQL role '$DB_USER' failed."
                fi
            fi
        fi

        # Clean up pg_hba.conf entries only if we actually removed the DB or user.
        # If both were kept, the auth rules are still needed.
        if $DROPPED_DB || $DROPPED_USER; then
            PG_HBA=$(sudo -u postgres psql -tAc "SHOW hba_file" 2>/dev/null || echo "")
            if [ -n "$PG_HBA" ] && [ -f "$PG_HBA" ]; then
                if grep -qE "^\s*(local|host)\s+aurora\s+aurora\s" "$PG_HBA" 2>/dev/null; then
                    info "Removing aurora entries from pg_hba.conf..."
                    sed -i '/^\s*\(local\|host\)\s\+aurora\s\+aurora\s/d' "$PG_HBA"
                    if [ -n "$PG_SERVICE" ]; then
                        systemctl reload "$PG_SERVICE" 2>/dev/null || true
                    fi
                    ok "pg_hba.conf cleaned"
                fi
            fi
        fi
    fi
else
    ok "No Aurora database or user found (skipping)"
fi

if $PG_STARTED_FOR_PURGE && [ -n "$PG_SERVICE" ]; then
    if systemctl stop "$PG_SERVICE" >/dev/null 2>&1 \
        && ! systemctl is-active "$PG_SERVICE" >/dev/null 2>&1; then
        PG_STARTED_FOR_PURGE=false
        info "Returned $PG_SERVICE to its pre-uninstall stopped state"
    else
        error "Could not return $PG_SERVICE to its pre-uninstall stopped state.
The recovery uninstaller and retained configuration were preserved. Stop the
service manually, then rerun: sudo systemctl stop $PG_SERVICE"
    fi
fi

# ══════════════════════════════════════════════════════════════════
# Step 7: Remove reverse proxy configuration (nginx + Let's Encrypt)
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 7/9: Reverse proxy cleanup..."
echo ""

PROXY_CONFIG_REMOVED=false
if [ "${#MANAGED_NGINX_CONFIGS[@]}" -gt 0 ] || $HAS_MANAGED_NGINX_MAP; then
    if confirm "Remove Aurora-managed nginx configuration?"; then
        PROXY_ROLLBACK_DIR="$(umask 077; mktemp -d)" || true
        if [ -z "$PROXY_ROLLBACK_DIR" ] || [ ! -d "$PROXY_ROLLBACK_DIR" ]; then
            record_proxy_failure \
                "Could not create a secure nginx rollback directory; no proxy files were removed."
            warn "Could not create a secure nginx rollback directory; proxy removal was skipped."
        else
            PROXY_SNAPSHOT_PATHS=()
            for _f in "${MANAGED_NGINX_CONFIGS[@]}"; do
                PROXY_SNAPSHOT_PATHS+=("$_f")
                if [ "$_f" = /etc/nginx/sites-available/aurora.conf ] \
                    && { [ -e /etc/nginx/sites-enabled/aurora.conf ] \
                        || [ -L /etc/nginx/sites-enabled/aurora.conf ]; }; then
                    PROXY_SNAPSHOT_PATHS+=(/etc/nginx/sites-enabled/aurora.conf)
                fi
            done
            if $HAS_MANAGED_NGINX_MAP; then
                PROXY_SNAPSHOT_PATHS+=(/etc/nginx/conf.d/aurora-map.conf)
            fi

            PROXY_SNAPSHOT_OK=true
            for _snapshot_path in "${PROXY_SNAPSHOT_PATHS[@]}"; do
                _snapshot_copy="$PROXY_ROLLBACK_DIR$_snapshot_path"
                if ! mkdir -p "$(dirname "$_snapshot_copy")" \
                    || ! cp -a -- "$_snapshot_path" "$_snapshot_copy"; then
                    PROXY_SNAPSHOT_OK=false
                    break
                fi
            done

            if ! $PROXY_SNAPSHOT_OK; then
                rm -rf "$PROXY_ROLLBACK_DIR"
                record_proxy_failure \
                    "Could not snapshot Aurora-managed nginx files; no proxy files were removed."
                warn "Could not snapshot the managed nginx state; proxy removal was skipped."
            else
                NGINX_WAS_ACTIVE=false
                systemctl is-active nginx >/dev/null 2>&1 \
                    && NGINX_WAS_ACTIVE=true
                PROXY_DELETE_OK=true
                for _f in "${MANAGED_NGINX_CONFIGS[@]}"; do
                    if ! rm -f -- "$_f"; then
                        PROXY_DELETE_OK=false
                    fi
                    # Debian's enabled site is normally a symlink to sites-available.
                    if [ "$_f" = /etc/nginx/sites-available/aurora.conf ] \
                        && ! rm -f -- /etc/nginx/sites-enabled/aurora.conf; then
                        PROXY_DELETE_OK=false
                    fi
                done
                if $HAS_MANAGED_NGINX_MAP \
                    && ! rm -f -- /etc/nginx/conf.d/aurora-map.conf; then
                    PROXY_DELETE_OK=false
                fi

                PROXY_COMMIT_OK="$PROXY_DELETE_OK"
                if ! command -v nginx >/dev/null 2>&1 \
                    || ! nginx -t >/dev/null 2>&1; then
                    PROXY_COMMIT_OK=false
                elif $NGINX_WAS_ACTIVE \
                    && ! systemctl reload nginx >/dev/null 2>&1; then
                    PROXY_COMMIT_OK=false
                fi

                if $PROXY_COMMIT_OK; then
                    PROXY_CONFIG_REMOVED=true
                    rm -rf "$PROXY_ROLLBACK_DIR"
                    [ "${#MANAGED_NGINX_CONFIGS[@]}" -eq 0 ] \
                        || ok "Aurora-managed nginx site config removed"
                    $HAS_MANAGED_NGINX_MAP \
                        && ok "Aurora-managed WebSocket map config removed"
                    $NGINX_WAS_ACTIVE && ok "Nginx reload verified"
                else
                    PROXY_RESTORE_OK=true
                    for _snapshot_path in "${PROXY_SNAPSHOT_PATHS[@]}"; do
                        _snapshot_copy="$PROXY_ROLLBACK_DIR$_snapshot_path"
                        if ! rm -rf -- "$_snapshot_path" \
                            || ! mkdir -p "$(dirname "$_snapshot_path")" \
                            || ! cp -a -- "$_snapshot_copy" "$_snapshot_path"; then
                            PROXY_RESTORE_OK=false
                        fi
                    done
                    if ! command -v nginx >/dev/null 2>&1 \
                        || ! nginx -t >/dev/null 2>&1; then
                        PROXY_RESTORE_OK=false
                    elif $NGINX_WAS_ACTIVE \
                        && ! systemctl reload nginx >/dev/null 2>&1; then
                        PROXY_RESTORE_OK=false
                    fi

                    if $PROXY_RESTORE_OK; then
                        rm -rf "$PROXY_ROLLBACK_DIR"
                        warn "Managed nginx removal failed validation/reload; prior proxy files were restored."
                        record_proxy_failure \
                            "Managed nginx removal did not validate/reload; the prior proxy state was restored."
                    else
                        warn "CRITICAL: managed nginx removal failed and automatic restoration was incomplete."
                        warn "Recovery snapshot retained at: $PROXY_ROLLBACK_DIR"
                        record_proxy_failure \
                            "Managed nginx rollback is incomplete; restore files from '$PROXY_ROLLBACK_DIR' and run: sudo nginx -t"
                    fi
                fi
            fi
        fi
    else
        warn "Keeping Aurora-managed nginx configuration"
    fi
else
    ok "No Aurora-managed nginx config found (skipping)"
fi

if [ "${#EXTERNAL_NGINX_CONFIGS[@]}" -gt 0 ] \
    || { $HAS_NGINX_MAP && ! $HAS_MANAGED_NGINX_MAP; }; then
    warn "Preserving operator-managed nginx configuration; Aurora only removes files"
    warn "whose contents carry its exact managed-file header."
fi

# The active marker is written by setup-domain.sh. When that exact managed
# vhost is removed but configuration is retained, convert it to a tombstone
# and disable proxy-only security settings. This makes a later no-domain
# reinstall usable over direct HTTP while preserving unrelated manual proxy
# settings (which never enter this managed-removal branch).
if $PROXY_CONFIG_REMOVED && [ -f "$CONFIG_DIR/aurora.env" ]; then
    if declare -F aurora_env_upsert >/dev/null 2>&1; then
        aurora_env_upsert "$CONFIG_DIR/aurora.env" AURORA_ALLOWED_ORIGINS \
            "http://localhost:*,https://localhost:*"
        aurora_env_upsert "$CONFIG_DIR/aurora.env" AURORA_SECURE_COOKIES "false"
        aurora_env_upsert "$CONFIG_DIR/aurora.env" AURORA_TRUSTED_PROXIES ""
        chown root:root "$CONFIG_DIR/aurora.env"
        chmod 0600 "$CONFIG_DIR/aurora.env"
        ok "Retained config reset for direct HTTP after managed-proxy removal"
    else
        warn "Could not update retained aurora.env automatically."
        warn "Before reinstalling without HTTPS, set AURORA_SECURE_COOKIES=false."
    fi
    if [ -n "$PROXY_DOMAIN" ]; then
        printf '%s\n' "$PROXY_DOMAIN" > "$PROXY_REMOVED_MARKER.tmp"
        chmod 0600 "$PROXY_REMOVED_MARKER.tmp"
        chown root:root "$PROXY_REMOVED_MARKER.tmp"
        mv -f "$PROXY_REMOVED_MARKER.tmp" "$PROXY_REMOVED_MARKER"
        printf '%s\n' "$PROXY_DOMAIN" > "$PROXY_REMOVAL_PROVENANCE_MARKER.tmp"
        chmod 0600 "$PROXY_REMOVAL_PROVENANCE_MARKER.tmp"
        chown root:root "$PROXY_REMOVAL_PROVENANCE_MARKER.tmp"
        mv -f "$PROXY_REMOVAL_PROVENANCE_MARKER.tmp" \
            "$PROXY_REMOVAL_PROVENANCE_MARKER"
        rm -f "$PROXY_ACTIVE_MARKER"
    fi
fi

if $HAS_CERTBOT_CERT; then
    if confirm "Delete Let's Encrypt certificate for '${PROXY_DOMAIN}'? (you can always re-issue later)" "N"; then
        if ! $CERT_DELETE_SAFE; then
            warn "Retaining certificate for '${PROXY_DOMAIN}': Aurora cannot prove it owns"
            warn "an exclusive one-domain lineage. Shared or pre-existing certificates"
            warn "are never deleted automatically."
            if [ -n "$CERT_NAME" ]; then
                warn "  Certbot lineage: $CERT_NAME"
                warn "  SANs: ${CERT_DOMAINS:-unknown}"
            fi
        elif _nginx_certificate_consumer="$(
            aurora_active_nginx_certificate_consumer \
                "$PROXY_DOMAIN" "$CERT_NAME"
        )"; then
            warn "Retaining certificate lineage '${CERT_NAME}':"
            warn "  $_nginx_certificate_consumer"
            warn "Remove or repoint that active nginx vhost, verify 'sudo nginx -T', then retry purge."
            $PURGE && record_purge_failure \
                "Certificate lineage '$CERT_NAME' is still consumed by active nginx configuration: $_nginx_certificate_consumer"
        elif command -v certbot &>/dev/null; then
            if certbot delete --cert-name "$CERT_NAME" --non-interactive 2>/dev/null; then
                ok "Exclusive Aurora-owned certificate '${CERT_NAME}' deleted"
                rm -f "$PROXY_CERT_OWNER_MARKER" "$PROXY_CERT_DURABLE_MARKER"
            else
                warn "Failed to delete exclusive Aurora-owned certificate."
                warn "Remove manually: sudo certbot delete --cert-name ${CERT_NAME}"
                $PURGE && record_purge_failure \
                    "Certificate lineage '$CERT_NAME' remains; run: sudo certbot delete --cert-name '$CERT_NAME'"
            fi
        else
            warn "Certbot not found. Remove certificate manually:"
            warn "  sudo certbot delete --cert-name ${CERT_NAME}"
            $PURGE && record_purge_failure \
                "Certificate lineage '$CERT_NAME' remains because certbot is unavailable."
        fi
    else
        warn "Keeping Let's Encrypt certificate for '${PROXY_DOMAIN}'"
    fi
elif [ -n "$PROXY_DOMAIN" ]; then
    ok "No Let's Encrypt certificate found for '${PROXY_DOMAIN}' (skipping)"
fi

# ══════════════════════════════════════════════════════════════════
# Step 8: Reverse media-library ACLs + remove state/log dirs
# ══════════════════════════════════════════════════════════════════
#
# install.sh applied `setfacl -m u:aurora:rX` recursively on each
# media library plus traversal ACLs on every ancestor up to /. After
# `userdel aurora`, those entries become numeric-UID stragglers (e.g.
# `user:998:rX`) cluttering every `getfacl` on the tree forever.
#
# We reverse them BEFORE the userdel below so the entries resolve to
# the named user `aurora` and `setfacl -x` can match cleanly.
#
# Library paths were captured from the DB in detect_components() —
# they're our only handle since install.sh doesn't persist the list
# anywhere else. If the DB was already dropped or never had any
# libraries added, this step is a no-op with a heads-up message.

echo ""
info "Step 8/9: Reversing media-library ACLs + removing state/log..."
echo ""

acl_tree_is_clean() {
    local path="$1" output
    output="$(mktemp)"
    chmod 0600 "$output"
    if ! getfacl -R -cpn -- "$path" > "$output" 2>/dev/null; then
        rm -f "$output"
        return 2
    fi
    if grep -qE "^(default:)?user:${SYSTEM_USER_OWNED_UID}:" "$output"; then
        rm -f "$output"
        return 1
    fi
    rm -f "$output"
    return 0
}

acl_path_is_clean() {
    local path="$1" output
    output="$(mktemp)"
    chmod 0600 "$output"
    if ! getfacl -cpn -- "$path" > "$output" 2>/dev/null; then
        rm -f "$output"
        return 2
    fi
    if grep -qE "^user:${SYSTEM_USER_OWNED_UID}:" "$output"; then
        rm -f "$output"
        return 1
    fi
    rm -f "$output"
    return 0
}

if [ "${#MEDIA_PATHS[@]}" -gt 0 ]; then
    if ! $SYSTEM_USER_DELETE_SAFE; then
        warn "The existing '$AURORA_USER' account is not proven Aurora-owned."
        warn "Preserving its ACL entries and the account itself."
    elif command -v setfacl &>/dev/null && command -v getfacl &>/dev/null; then
        if confirm "Reverse aurora-user ACLs on ${#MEDIA_PATHS[@]} media path(s)?"; then
            for _media_path in "${MEDIA_PATHS[@]}"; do
                if [ -e "$_media_path" ]; then
                    _resolved_media_path="$(readlink -f -- "$_media_path" 2>/dev/null || true)"
                    if [ -z "$_resolved_media_path" ]; then
                        warn "  Could not canonicalize $_media_path; refusing recursive ACL removal."
                        record_acl_failure \
                            "Media ACL cleanup pending for '$_media_path': canonicalization failed."
                        continue
                    fi
                    if declare -F aurora_media_root_rejection_reason >/dev/null 2>&1 \
                        && _rejection="$(aurora_media_root_rejection_reason "$_resolved_media_path")"; then
                        warn "  Refusing recursive ACL removal for $_media_path: $_rejection."
                        record_acl_failure \
                            "Media ACL cleanup pending for '$_media_path': $_rejection."
                        continue
                    fi
                    _media_path="$_resolved_media_path"
                    _quoted_media_path="$(printf '%q' "$_media_path")"
                    info "  Removing ACL entries from $_media_path..."
                    # Remove access and default entries, then verify the entire
                    # tree rather than trusting best-effort recursive exit codes.
                    setfacl -R -x "u:${SYSTEM_USER_OWNED_UID}" "$_media_path" \
                        2>/dev/null || true
                    find "$_media_path" -type d \
                        -exec setfacl -d -x "u:${SYSTEM_USER_OWNED_UID}" -- {} + \
                        2>/dev/null || true
                    if ! acl_tree_is_clean "$_media_path"; then
                        record_acl_failure \
                            "Media ACL entries remain under '$_media_path'; run: sudo setfacl -R -x u:${AURORA_USER} -- $_quoted_media_path && sudo find $_quoted_media_path -type d -exec setfacl -d -x u:${AURORA_USER} -- {} +"
                    fi

                    # Walk parents up to /, removing traversal ACL where present.
                    _parent="$(dirname "$_media_path")"
                    while [ "$_parent" != "/" ] && [ "$_parent" != "." ] && [ -n "$_parent" ]; do
                        setfacl -x "u:${SYSTEM_USER_OWNED_UID}" "$_parent" \
                            2>/dev/null || true
                        if ! acl_path_is_clean "$_parent"; then
                            record_acl_failure \
                                "Traverse ACL remains on '$_parent'; run: sudo setfacl -x 'u:${AURORA_USER}' '$_parent'"
                        fi
                        _parent="$(dirname "$_parent")"
                    done
                else
                    warn "  $_media_path is unavailable; retaining cleanup state."
                    record_acl_failure \
                        "Media path '$_media_path' is unavailable; mount/restore it and retry ACL cleanup."
                fi
            done
            if ! $ACL_CLEANUP_FAILED; then
                ok "ACL reversal verified complete"
                warn "Note: chmod o+x / o+rX fallbacks from install.sh are NOT reversed —"
                warn "      we can't know your original mode bits. Run 'getfacl <path>' to inspect."
            fi
        else
            record_acl_failure \
                "Media ACL cleanup was declined; the Aurora service user was preserved."
        fi
    else
        record_acl_failure \
            "setfacl/getfacl is unavailable; install the acl package and retry media ACL cleanup."
    fi
else
    if $DB_TARGET_EXTERNAL; then
        warn "External PostgreSQL library paths could not be enumerated as administrator."
        warn "Retry with each root supplied explicitly, for example:"
        warn "  sudo $STANDALONE_UNINSTALL --yes --media-path=/srv/media"
        $SYSTEM_USER_DELETE_SAFE && record_acl_failure \
            "External database library paths were unavailable; retry with --media-path=PATH for every managed root before deleting '$AURORA_USER'."
    elif $DB_PROVENANCE_MISSING || $PG_PROBE_FAILED; then
        warn "Database provenance/readiness prevented media-path enumeration."
        $SYSTEM_USER_DELETE_SAFE && record_acl_failure \
            "Media paths could not be proven clean because the retained database was unavailable."
    elif $HAS_DB; then
        info "No media-library paths recorded in DB (nothing to reverse)"
    else
        info "No retained media-library paths require ACL cleanup"
    fi
fi

# State directory — contains /var/lib/aurora/source (root-owned source
# mirror, can be GBs) and update-status.json written by aurora-update.sh.
if $HAS_STATE_DIR; then
    if confirm "Remove $STATE_DIR (source mirror + updater state)?"; then
        rm -rf "$STATE_DIR"
        ok "Removed $STATE_DIR"
    else
        warn "Keeping $STATE_DIR"
    fi
else
    ok "State directory not found (skipping)"
fi

# Log directory — install.sh creates /var/log/aurora owned by aurora:aurora
# 0750. Removing here so logs survive uninstall ONLY if the user explicitly
# said no above.
if $HAS_LOG_DIR; then
    if confirm "Remove $LOG_DIR (aurora logs)?" "N"; then
        rm -rf "$LOG_DIR"
        ok "Removed $LOG_DIR"
    else
        chown -R root:root "$LOG_DIR"
        find "$LOG_DIR" -xdev -type d -exec chmod 0700 {} +
        find "$LOG_DIR" -xdev -type f -exec chmod 0600 {} +
        warn "Keeping $LOG_DIR"
        ok "Retained logs secured for root-only access"
    fi
else
    ok "Log directory not found (skipping)"
fi

if $HAS_INSTALLER_LOG_DIR; then
    if confirm "Remove $INSTALLER_LOG_DIR (root installer/updater logs)?" "N"; then
        rm -rf "$INSTALLER_LOG_DIR"
        ok "Removed $INSTALLER_LOG_DIR"
    else
        warn "Keeping $INSTALLER_LOG_DIR"
    fi
fi

# ══════════════════════════════════════════════════════════════════
# Step 9: Remove system user and group
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 9/9: Removing system user and group..."
echo ""

if $HAS_SYSTEM_USER; then
    if ! $SYSTEM_USER_DELETE_SAFE; then
        warn "Preserving unowned/mismatched system user '${AURORA_USER}'."
    elif $ACL_CLEANUP_FAILED; then
        warn "Preserving system user '${AURORA_USER}' until all named ACL entries are removed."
    elif confirm "Remove system user '${AURORA_USER}'?"; then
        if userdel "$AURORA_USER" 2>/dev/null && ! id "$AURORA_USER" &>/dev/null; then
            rm -f "$SYSTEM_USER_MARKER" \
                "$PENDING_MEDIA_PATHS_FILE" "$MANAGED_MEDIA_PATHS_FILE"
            ok "System user '${AURORA_USER}' removed"
        else
            record_acl_failure \
                "Aurora-owned system user '$AURORA_USER' could not be removed; run: sudo userdel '$AURORA_USER'"
        fi
    else
        warn "Keeping system user '${AURORA_USER}'"
    fi
else
    ok "System user '${AURORA_USER}' not found (skipping)"
fi

if $HAS_SYSTEM_GROUP; then
    # Check if the group still exists (userdel may have removed it)
    if getent group "$AURORA_GROUP" &>/dev/null; then
        if ! $SYSTEM_GROUP_DELETE_SAFE; then
            warn "Preserving unowned/mismatched system group '${AURORA_GROUP}'."
        elif $ACL_CLEANUP_FAILED; then
            warn "Preserving system group '${AURORA_GROUP}' with the retained service user."
        elif id "$AURORA_USER" >/dev/null 2>&1; then
            warn "Preserving system group '${AURORA_GROUP}' with the retained service user."
        elif confirm "Remove system group '${AURORA_GROUP}'?"; then
            if groupdel "$AURORA_GROUP" 2>/dev/null \
                && ! getent group "$AURORA_GROUP" &>/dev/null; then
                rm -f "$SYSTEM_GROUP_MARKER"
                ok "System group '${AURORA_GROUP}' removed"
            else
                record_acl_failure \
                    "Aurora-owned system group '$AURORA_GROUP' could not be removed; run: sudo groupdel '$AURORA_GROUP'"
            fi
        else
            warn "Keeping system group '${AURORA_GROUP}'"
        fi
    else
        ok "System group '${AURORA_GROUP}' already removed with user"
    fi
else
    ok "System group '${AURORA_GROUP}' not found (skipping)"
fi

if $DEFER_CONFIG_PURGE && ! $PURGE_FAILED \
    && ! $ACL_CLEANUP_FAILED && ! $PROXY_CLEANUP_FAILED; then
    rm -rf "$CONFIG_DIR"
    ok "Removed deferred configuration directory $CONFIG_DIR"
elif $DEFER_CONFIG_PURGE; then
    warn "Keeping $CONFIG_DIR so failed protected-object cleanup can be retried safely"
fi

if $PURGE && ! $PURGE_FAILED; then
    rm -f "$STANDALONE_UNINSTALL"
    rm -rf "$INSTALLER_LIB_DIR"
    ok "Removed standalone Aurora recovery uninstaller"
else
    ok "Kept root-only recovery uninstaller for a later purge:"
    info "  sudo $STANDALONE_UNINSTALL --yes --purge"
fi

if $PURGE_FAILED; then
    echo ""
    echo "  ============================================================"
    echo "   Aurora Media Server - Purge Incomplete"
    echo "  ============================================================"
    echo ""
    warn "The following protected object(s) remain:"
    for _failure in "${PURGE_FAILURE_MESSAGES[@]}"; do
        printf '    - %s\n' "$_failure"
    done
    echo ""
    warn "The recovery uninstaller was preserved. Resolve the items above, then retry:"
    if $DB_TARGET_EXTERNAL && ! $EXTERNAL_DB_PURGED; then
        warn "  sudo $STANDALONE_UNINSTALL --yes --purge --external-db-purged"
    else
        warn "  sudo $STANDALONE_UNINSTALL --yes --purge"
    fi
    exit 1
fi
if $ACL_CLEANUP_FAILED || $PROXY_CLEANUP_FAILED; then
    echo ""
    echo "  ============================================================"
    echo "   Aurora Media Server - Uninstall Incomplete"
    echo "  ============================================================"
    echo ""
    if $PROXY_CLEANUP_FAILED; then
        warn "Managed reverse-proxy cleanup did not commit:"
        for _failure in "${PROXY_FAILURE_MESSAGES[@]}"; do
            printf '    - %s\n' "$_failure"
        done
    fi
    if $ACL_CLEANUP_FAILED; then
        warn "The Aurora service user/group were preserved to prevent orphaned"
        warn "numeric ACLs or unsafe UID reuse:"
        for _failure in "${ACL_FAILURE_MESSAGES[@]}"; do
            printf '    - %s\n' "$_failure"
        done
    fi
    warn "Resolve the items above, then retry:"
    warn "  sudo $STANDALONE_UNINSTALL --yes"
    exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Done
# ══════════════════════════════════════════════════════════════════

echo ""
echo "  ============================================================"
echo "   Aurora Media Server - Uninstallation Complete"
echo "  ============================================================"
echo ""
echo "  The following were NOT removed (shared system packages):"
echo "    - PostgreSQL server"
echo "      (+ postgresql-contrib, postgresql-client, pgvector ext)"
echo "    - FFmpeg / FFprobe"
echo "    - Go toolchain (/usr/local/go + /etc/profile.d/go.sh)"
echo "    - nginx (web server) and certbot (cert manager) —"
echo "      install.sh installs these only when AURORA_DOMAIN was set"
echo "    - build-essential, git, python3, acl (build/dev deps)"
echo "    - Your media files"
echo ""
echo "  Removing chmod-fallback world-permissions on media / home dirs"
echo "  was NOT attempted — we can't know your original mode bits."
echo "  Inspect with: getfacl <path> ; stat -c '%a' <path>"
echo ""
echo "  If you also want to remove PostgreSQL entirely:"
echo "    sudo apt remove --purge postgresql    # Debian/Ubuntu"
echo "    sudo dnf remove postgresql-server     # Fedora/RHEL"
echo "    sudo pacman -Rns postgresql           # Arch"
echo ""
