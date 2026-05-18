#!/usr/bin/env bash
# Aurora Media Server - Uninstall Script
# Safely removes all Aurora components from a Linux system.
#
# Removes: binary, install directory, configuration, systemd service,
#          cache/transcode data, PostgreSQL database+user, nginx reverse proxy
#          config, Let's Encrypt certificates, system user/group.
#
# Usage:
#   sudo ./scripts/uninstall.sh            # Interactive (asks before each step)
#   sudo ./scripts/uninstall.sh --force     # Skip confirmations (for automation)
#   sudo ./scripts/uninstall.sh -y          # Same as --force

set -euo pipefail

# ── Constants (must match install.sh exactly) ────────────────────
AURORA_USER="aurora"
AURORA_GROUP="aurora"
INSTALL_BIN="/usr/local/bin/aurora"
INSTALL_DIR="/opt/aurora"
CONFIG_DIR="/etc/aurora"
CACHE_DIR="/var/cache/aurora"
TRANSCODE_FALLBACK="/tmp/aurora-transcode"
SYSTEMD_UNIT="/etc/systemd/system/aurora.service"
DB_NAME="aurora"
DB_USER="aurora"

# ── Helpers (match install.sh formatting) ────────────────────────
info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$1"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$1"; }
ok()    { printf '\033[1;32m[ OK ]\033[0m  %s\n' "$1"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$1"; exit 1; }

confirm() {
    local msg="$1" default="${2:-Y}"
    if $FORCE; then
        return 0
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
for arg in "$@"; do
    case "$arg" in
        --force|-y) FORCE=true ;;
        -h|--help)
            echo "Usage: sudo $0 [--force|-y]"
            echo ""
            echo "Removes Aurora Media Server and all associated data."
            echo ""
            echo "Options:"
            echo "  --force, -y   Skip all confirmation prompts (for automation)"
            echo "  -h, --help    Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Usage: sudo $0 [--force|-y]"
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

if ! $FORCE && [ ! -t 0 ]; then
    error "This script requires an interactive terminal. Use --force to skip prompts."
fi

# ── Detect PostgreSQL service name (same logic as install.sh) ───
detect_pg_service() {
    PG_SERVICE=""
    for svc in postgresql postgresql-{17,16,15,14,13}; do
        if systemctl cat "${svc}.service" &>/dev/null; then
            PG_SERVICE="$svc"
            break
        fi
    done
}

# ── Detect what is installed ────────────────────────────────────
detect_components() {
    HAS_SERVICE=false
    HAS_BINARY=false
    HAS_INSTALL_DIR=false
    HAS_CONFIG_DIR=false
    HAS_CACHE_DIR=false
    HAS_TRANSCODE_FALLBACK=false
    HAS_SYSTEM_USER=false
    HAS_SYSTEM_GROUP=false
    HAS_DB=false
    HAS_DB_USER=false
    SERVICE_ACTIVE=false
    HAS_NGINX_CONFIG=false
    HAS_NGINX_MAP=false
    HAS_CERTBOT_CERT=false
    PROXY_DOMAIN=""

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
    id "$AURORA_USER" &>/dev/null && HAS_SYSTEM_USER=true || true
    getent group "$AURORA_GROUP" &>/dev/null && HAS_SYSTEM_GROUP=true || true

    # Check PostgreSQL database and user if psql is available
    if command -v psql &>/dev/null && sudo -u postgres psql -c "SELECT 1" &>/dev/null; then
        if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null | grep -q 1; then
            HAS_DB=true
        fi
        if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" 2>/dev/null | grep -q 1; then
            HAS_DB_USER=true
        fi
    fi

    # Check for reverse proxy setup (nginx config + Let's Encrypt cert)
    if [ -f "$CONFIG_DIR/.proxy-setup" ]; then
        PROXY_DOMAIN=$(head -1 "$CONFIG_DIR/.proxy-setup" 2>/dev/null || echo "")
        # Sanitize: only allow valid domain characters (defense against edited marker)
        if ! echo "$PROXY_DOMAIN" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$'; then
            PROXY_DOMAIN=""
        fi
    fi
    for _f in /etc/nginx/sites-available/aurora.conf /etc/nginx/conf.d/aurora.conf; do
        if [ -f "$_f" ]; then
            HAS_NGINX_CONFIG=true
            break
        fi
    done
    [ -f /etc/nginx/conf.d/aurora-map.conf ] && HAS_NGINX_MAP=true || true
    if [ -n "$PROXY_DOMAIN" ] && [ -d "/etc/letsencrypt/live/$PROXY_DOMAIN" ]; then
        HAS_CERTBOT_CERT=true
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
if $HAS_CACHE_DIR; then
    printf '    %-42s %s\n' "Cache directory" "$CACHE_DIR"
    FOUND_SOMETHING=true
fi
if $HAS_TRANSCODE_FALLBACK; then
    printf '    %-42s %s\n' "Transcode fallback" "$TRANSCODE_FALLBACK"
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
if $HAS_SYSTEM_USER; then
    printf '    %-42s %s\n' "System user" "$AURORA_USER"
    FOUND_SOMETHING=true
fi
if $HAS_SYSTEM_GROUP; then
    printf '    %-42s %s\n' "System group" "$AURORA_GROUP"
    FOUND_SOMETHING=true
fi
if $HAS_NGINX_CONFIG || $HAS_NGINX_MAP; then
    printf '    %-42s %s\n' "Nginx reverse proxy config" "aurora.conf"
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

# ══════════════════════════════════════════════════════════════════
# Step 1: Stop and disable the systemd service
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 1/7: Stopping Aurora service..."
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
        ok "Service stopped"
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
# Step 2: Remove application files
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 2/7: Removing application files..."
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
# Step 3: Remove configuration
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 3/7: Removing configuration..."
echo ""

if $HAS_CONFIG_DIR; then
    if confirm "Remove configuration directory $CONFIG_DIR (includes aurora.env with secrets)?"; then
        rm -rf "$CONFIG_DIR"
        ok "Removed $CONFIG_DIR"
    else
        warn "Keeping $CONFIG_DIR"
    fi
else
    ok "Configuration directory not found (skipping)"
fi

# ══════════════════════════════════════════════════════════════════
# Step 4: Remove cache and transcode data
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 4/7: Removing cache and transcode data..."
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

# ══════════════════════════════════════════════════════════════════
# Step 5: Remove PostgreSQL database and user
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 5/7: PostgreSQL cleanup..."
echo ""

if $HAS_DB || $HAS_DB_USER; then
    if ! command -v psql &>/dev/null; then
        warn "psql not found. Cannot remove PostgreSQL database/user automatically."
        warn "Remove manually with:"
        warn "  sudo -u postgres dropdb ${DB_NAME}"
        warn "  sudo -u postgres dropuser ${DB_USER}"
    elif ! sudo -u postgres psql -c "SELECT 1" &>/dev/null; then
        warn "Cannot connect to PostgreSQL. Is the service running?"
        if [ -n "$PG_SERVICE" ]; then
            warn "Try: sudo systemctl start $PG_SERVICE"
        fi
        warn "Remove manually with:"
        warn "  sudo -u postgres dropdb ${DB_NAME}"
        warn "  sudo -u postgres dropuser ${DB_USER}"
    else
        DROPPED_DB=false
        DROPPED_USER=false

        if $HAS_DB; then
            if confirm "Drop PostgreSQL database '${DB_NAME}'? (ALL Aurora data will be permanently lost)" "N"; then
                # Terminate active connections before dropping
                info "Terminating active connections to '${DB_NAME}'..."
                sudo -u postgres psql -c "
                    SELECT pg_terminate_backend(pid)
                    FROM pg_stat_activity
                    WHERE datname = '${DB_NAME}'
                      AND pid <> pg_backend_pid();
                " &>/dev/null || true
                sleep 1

                info "Dropping database '${DB_NAME}'..."
                if sudo -u postgres dropdb "$DB_NAME" 2>/dev/null; then
                    ok "Database '${DB_NAME}' dropped"
                    DROPPED_DB=true
                else
                    warn "Failed to drop database '${DB_NAME}'. There may still be active connections."
                    warn "Remove manually: sudo -u postgres dropdb ${DB_NAME}"
                fi
            else
                warn "Keeping database '${DB_NAME}'"
            fi
        else
            ok "Database '${DB_NAME}' not found (skipping)"
        fi

        if $HAS_DB_USER; then
            if confirm "Drop PostgreSQL user '${DB_USER}'?"; then
                if sudo -u postgres dropuser "$DB_USER" 2>/dev/null; then
                    ok "PostgreSQL user '${DB_USER}' dropped"
                    DROPPED_USER=true
                else
                    warn "Failed to drop user '${DB_USER}'. The user may still own objects."
                    warn "Remove manually: sudo -u postgres dropuser ${DB_USER}"
                fi
            else
                warn "Keeping PostgreSQL user '${DB_USER}'"
            fi
        else
            ok "PostgreSQL user '${DB_USER}' not found (skipping)"
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

# ══════════════════════════════════════════════════════════════════
# Step 6: Remove reverse proxy configuration (nginx + Let's Encrypt)
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 6/7: Reverse proxy cleanup..."
echo ""

if $HAS_NGINX_CONFIG || $HAS_NGINX_MAP; then
    if confirm "Remove Aurora nginx configuration?"; then
        # Remove site config from both possible locations
        rm -f /etc/nginx/sites-available/aurora.conf
        rm -f /etc/nginx/sites-enabled/aurora.conf
        rm -f /etc/nginx/conf.d/aurora.conf
        ok "Nginx site config removed"

        # Remove the WebSocket upgrade map if present
        if $HAS_NGINX_MAP; then
            rm -f /etc/nginx/conf.d/aurora-map.conf
            ok "Nginx WebSocket map config removed"
        fi

        # Test and reload nginx if it's still running
        if command -v nginx &>/dev/null; then
            if nginx -t 2>/dev/null; then
                if systemctl is-active nginx &>/dev/null; then
                    systemctl reload nginx 2>/dev/null || true
                    ok "Nginx reloaded"
                fi
            else
                warn "Nginx config test failed after removing Aurora config."
                warn "Check: sudo nginx -t"
            fi
        fi
    else
        warn "Keeping Aurora nginx configuration"
    fi
else
    ok "No Aurora nginx config found (skipping)"
fi

if $HAS_CERTBOT_CERT; then
    if confirm "Delete Let's Encrypt certificate for '${PROXY_DOMAIN}'? (you can always re-issue later)" "N"; then
        if command -v certbot &>/dev/null; then
            if certbot delete --cert-name "$PROXY_DOMAIN" --non-interactive 2>/dev/null; then
                ok "Certificate for '${PROXY_DOMAIN}' deleted"
            else
                warn "Failed to delete certificate. Remove manually:"
                warn "  sudo certbot delete --cert-name ${PROXY_DOMAIN}"
            fi
        else
            warn "Certbot not found. Remove certificate manually:"
            warn "  sudo rm -rf /etc/letsencrypt/live/${PROXY_DOMAIN}"
            warn "  sudo rm -rf /etc/letsencrypt/renewal/${PROXY_DOMAIN}.conf"
            warn "  sudo rm -rf /etc/letsencrypt/archive/${PROXY_DOMAIN}"
        fi
    else
        warn "Keeping Let's Encrypt certificate for '${PROXY_DOMAIN}'"
    fi
elif [ -n "$PROXY_DOMAIN" ]; then
    ok "No Let's Encrypt certificate found for '${PROXY_DOMAIN}' (skipping)"
fi

# ══════════════════════════════════════════════════════════════════
# Step 7: Remove system user and group
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 7/7: Removing system user and group..."
echo ""

if $HAS_SYSTEM_USER; then
    if confirm "Remove system user '${AURORA_USER}'?"; then
        userdel "$AURORA_USER" 2>/dev/null || true
        ok "System user '${AURORA_USER}' removed"
    else
        warn "Keeping system user '${AURORA_USER}'"
    fi
else
    ok "System user '${AURORA_USER}' not found (skipping)"
fi

if $HAS_SYSTEM_GROUP; then
    # Check if the group still exists (userdel may have removed it)
    if getent group "$AURORA_GROUP" &>/dev/null; then
        if confirm "Remove system group '${AURORA_GROUP}'?"; then
            groupdel "$AURORA_GROUP" 2>/dev/null || true
            ok "System group '${AURORA_GROUP}' removed"
        else
            warn "Keeping system group '${AURORA_GROUP}'"
        fi
    else
        ok "System group '${AURORA_GROUP}' already removed with user"
    fi
else
    ok "System group '${AURORA_GROUP}' not found (skipping)"
fi

# ══════════════════════════════════════════════════════════════════
# Done
# ══════════════════════════════════════════════════════════════════

echo ""
echo "  ============================================================"
echo "   Aurora Media Server - Uninstallation Complete"
echo "  ============================================================"
echo ""
echo "  The following were NOT removed (not installed by Aurora):"
echo "    - FFmpeg"
echo "    - PostgreSQL server"
echo "    - Go toolchain"
echo "    - Nginx (web server)"
echo "    - Certbot (certificate manager)"
echo "    - Your media files"
echo ""
echo "  If you also want to remove PostgreSQL entirely:"
echo "    sudo apt remove --purge postgresql    # Debian/Ubuntu"
echo "    sudo dnf remove postgresql-server     # Fedora/RHEL"
echo "    sudo pacman -Rns postgresql           # Arch"
echo ""
