#!/usr/bin/env bash
# Aurora Media Server - Interactive Install Script
# Installs Aurora as a systemd service on Linux.
#
# Handles: prerequisites, build, PostgreSQL setup, configuration,
#          service installation, and startup -- all interactively.
#
# Usage:
#   sudo ./scripts/install.sh

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────
AURORA_USER="aurora"
AURORA_GROUP="aurora"
INSTALL_BIN="/usr/local/bin/aurora"
INSTALL_DIR="/opt/aurora"
CONFIG_DIR="/etc/aurora"
CACHE_DIR="/var/cache/aurora"
TRANSCODE_DIR="/var/cache/aurora/transcode"
REQUIRED_GO="1.23"

# ── Helpers ────────────────────────────────────────────────────────
info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$1"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$1"; }
ok()    { printf '\033[1;32m[ OK ]\033[0m  %s\n' "$1"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$1"; exit 1; }

cleanup() {
    echo ""
    warn "Installation interrupted. The system may be in a partial state."
    warn "Re-run this script to complete the installation."
}
trap cleanup INT TERM

# Prompt with a default value: prompt "Question" "default"
prompt() {
    local msg="$1" default="${2:-}"
    if [ -n "$default" ]; then
        printf '\033[1;36m[?]\033[0m %s [%s]: ' "$msg" "$default"
    else
        printf '\033[1;36m[?]\033[0m %s: ' "$msg"
    fi
    read -r REPLY || { echo ""; error "Unexpected end of input (Ctrl+D)."; }
    REPLY="${REPLY:-$default}"
}

# Yes/no prompt: confirm "Question" "Y" => default yes
confirm() {
    local msg="$1" default="${2:-Y}"
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

# Generate a random alphanumeric string of given length
rand_string() {
    local raw
    raw=$(head -c 96 /dev/urandom | base64 | tr -d '\n+/=') || true
    printf '%s' "${raw:0:${1:-64}}"
}

# Portable version comparison: version_gte "1.23" "1.23" => true
version_gte() {
    local IFS=.
    local -a v1=($1) v2=($2)
    if [ "${v1[0]}" -gt "${v2[0]}" ] 2>/dev/null; then return 0; fi
    if [ "${v1[0]}" -lt "${v2[0]}" ] 2>/dev/null; then return 1; fi
    if [ "${v1[1]:-0}" -ge "${v2[1]:-0}" ] 2>/dev/null; then return 0; fi
    return 1
}

# URL-encode a password for use in postgres:// URLs
urlencode_password() {
    local input="$1"
    if command -v python3 &>/dev/null; then
        printf '%s' "$input" | python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.stdin.read(), safe=''), end='')"
    else
        # Bash fallback for URL-unsafe characters
        local s="$input"
        s="${s//%/%25}"
        s="${s// /%20}"
        s="${s//#/%23}"
        s="${s//@/%40}"
        s="${s//:/%3A}"
        s="${s//\//%2F}"
        s="${s//\?/%3F}"
        s="${s//&/%26}"
        s="${s//=/%3D}"
        s="${s//+/%2B}"
        s="${s//\\/%5C}"
        s="${s//\'/%27}"
        s="${s//\"/%22}"
        s="${s//\!/%21}"
        s="${s//\[/%5B}"
        s="${s//\]/%5D}"
        printf '%s' "$s"
    fi
}

# ── Detect package manager ────────────────────────────────────────
PKG_MGR=""
APT_UPDATED=false

detect_pkg_manager() {
    if command -v apt-get &>/dev/null; then
        PKG_MGR="apt"
    elif command -v dnf &>/dev/null; then
        PKG_MGR="dnf"
    elif command -v yum &>/dev/null; then
        PKG_MGR="yum"
    elif command -v pacman &>/dev/null; then
        PKG_MGR="pacman"
    else
        PKG_MGR=""
    fi
}

pkg_install() {
    local pkg="$1"
    case "$PKG_MGR" in
        apt)
            if ! $APT_UPDATED; then
                apt-get update -qq
                APT_UPDATED=true
            fi
            apt-get install -y -qq "$pkg"
            ;;
        dnf)    dnf install -y -q "$pkg" ;;
        yum)    yum install -y -q "$pkg" ;;
        pacman) pacman -S --noconfirm "$pkg" > /dev/null ;;
        *)      error "No supported package manager found. Install '$pkg' manually and re-run." ;;
    esac
}

# Detect the PostgreSQL systemd service name (varies across distros).
# Sets PG_SERVICE to the found service name, or empty string if none found.
detect_pg_service() {
    PG_SERVICE=""
    for svc in postgresql postgresql-{17,16,15,14,13}; do
        if systemctl cat "${svc}.service" &>/dev/null; then
            PG_SERVICE="$svc"
            break
        fi
    done
    # Do NOT default to "postgresql" -- an empty value signals no service was found,
    # which lets callers distinguish "installed" from "not installed".
}

# Determine the correct PostgreSQL server package name for the detected pkg manager.
pg_server_package() {
    case "$PKG_MGR" in
        apt)    echo "postgresql" ;;
        dnf|yum) echo "postgresql-server" ;;
        pacman) echo "postgresql" ;;
        *)      echo "" ;;
    esac
}

# ── Preflight checks ──────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root (use sudo)."
fi

# This script only supports Linux with systemd
case "$(uname -s)" in
    Linux) ;;
    Darwin)
        error "macOS is not supported by this installer. Aurora requires systemd (Linux only). Use 'go build' and run manually on macOS."
        ;;
    *)
        error "Unsupported operating system: $(uname -s). This installer requires Linux with systemd."
        ;;
esac

if ! command -v systemctl &>/dev/null; then
    error "systemd is required but not found. This installer only supports systemd-based Linux distributions."
fi

if [ ! -t 0 ]; then
    error "This script requires an interactive terminal. Do not pipe or redirect stdin."
fi

echo ""
echo "  ============================================================"
echo "   Aurora Media Server - Interactive Installer"
echo "  ============================================================"
echo ""

detect_pkg_manager
if [ -n "$PKG_MGR" ]; then
    info "Detected package manager: $PKG_MGR"
else
    warn "Could not detect package manager. You may need to install packages manually."
fi

# Validate project directory early
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ ! -f "$PROJECT_DIR/cmd/aurora/main.go" ]; then
    error "Cannot find Aurora source code in $PROJECT_DIR. Run this script from the project directory."
fi

# ══════════════════════════════════════════════════════════════════
# STEP 1: Prerequisites and system user
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 1/7: Checking prerequisites..."
echo ""

# ── Go ─────────────────────────────────────────────────────────────
# Check common Go install locations that sudo may strip from PATH
if ! command -v go &>/dev/null; then
    for gobin in /usr/local/go/bin /snap/bin; do
        if [ -x "$gobin/go" ]; then
            export PATH="$gobin:$PATH"
            break
        fi
    done
fi

if command -v go &>/dev/null; then
    GO_VERSION=$(go version | sed 's/.*go\([0-9]*\.[0-9]*\).*/\1/')
    if version_gte "$GO_VERSION" "$REQUIRED_GO"; then
        ok "Go $GO_VERSION"
    else
        error "Go ${REQUIRED_GO}+ is required, found Go ${GO_VERSION}. Upgrade at https://go.dev/dl/"
    fi
else
    error "Go is required but not installed. Install Go ${REQUIRED_GO}+ from https://go.dev/dl/"
fi

# ── FFmpeg ─────────────────────────────────────────────────────────
if command -v ffmpeg &>/dev/null; then
    ok "FFmpeg found: $(command -v ffmpeg)"
else
    warn "FFmpeg is not installed (required for media transcoding)."
    if [ -n "$PKG_MGR" ] && confirm "Install FFmpeg now?"; then
        info "Installing FFmpeg..."
        pkg_install ffmpeg
        ok "FFmpeg installed"
    else
        error "FFmpeg is required. Install it manually and re-run."
    fi
fi

# ── PostgreSQL ─────────────────────────────────────────────────────
PG_INSTALLED=false      # true when server package is present (service unit exists)
PG_WAS_RUNNING=false    # true when the server was already accepting connections
PG_HAS_CLIENT=false     # true when psql / pg_isready binary is on PATH

detect_pg_service

# Determine what we have: client tools, a service unit, a running server?
if command -v pg_isready &>/dev/null || command -v psql &>/dev/null; then
    PG_HAS_CLIENT=true
fi

if pg_isready &>/dev/null; then
    # Server is accepting connections (regardless of how it was started)
    ok "PostgreSQL server is running"
    PG_INSTALLED=true
    PG_WAS_RUNNING=true
elif [ -n "$PG_SERVICE" ]; then
    # A systemd service unit exists -- the server package IS installed
    PG_INSTALLED=true
    if systemctl is-active "$PG_SERVICE" &>/dev/null; then
        ok "PostgreSQL server is running (service: $PG_SERVICE)"
        PG_WAS_RUNNING=true
    else
        warn "PostgreSQL server is installed but not running (service: $PG_SERVICE)."
    fi
elif $PG_HAS_CLIENT; then
    # Client tools (psql/pg_isready) exist, but no systemd service unit found.
    # This typically means only the client package is installed, not the server.
    warn "PostgreSQL client tools found, but the server package does not appear to be installed."
else
    warn "PostgreSQL is not installed."
fi

# ── Install PostgreSQL server if needed ──────────────────────────
install_pg_server() {
    info "Installing PostgreSQL server..."
    case "$PKG_MGR" in
        apt)
            pkg_install postgresql
            ;;
        dnf|yum)
            pkg_install postgresql-server
            if ! $PG_HAS_CLIENT; then
                pkg_install postgresql
            fi
            # Initialize DB on RHEL/Fedora (flag format varies by version)
            if command -v postgresql-setup &>/dev/null; then
                postgresql-setup --initdb 2>/dev/null || postgresql-setup initdb 2>/dev/null || true
            fi
            ;;
        pacman)
            pkg_install postgresql
            # Initialize DB on Arch
            if [ ! -d "/var/lib/postgres/data/base" ]; then
                sudo -u postgres initdb -D /var/lib/postgres/data 2>/dev/null || true
            fi
            ;;
    esac
    PG_INSTALLED=true
    PG_HAS_CLIENT=true
    # Re-detect service name after install
    detect_pg_service
    ok "PostgreSQL server installed"
}

if ! $PG_INSTALLED; then
    if [ -n "$PKG_MGR" ]; then
        local_pkg="$(pg_server_package)"
        if [ -n "$local_pkg" ] && confirm "Install PostgreSQL server now?"; then
            install_pg_server
        fi
    fi
fi

# If still not installed, the user will need to provide an external DB URL later
if ! $PG_INSTALLED; then
    warn "PostgreSQL server is not available locally. You will need to provide an external database URL."
fi

# ── Start PostgreSQL if installed but not running ────────────────
if $PG_INSTALLED && ! $PG_WAS_RUNNING; then
    if [ -z "$PG_SERVICE" ]; then
        # Edge case: installed but detect_pg_service found nothing (shouldn't happen
        # after a fresh install, but handle defensively).
        warn "Could not detect PostgreSQL service name. Attempting common names..."
        for svc in postgresql postgresql-{17,16,15,14,13}; do
            if systemctl start "${svc}.service" &>/dev/null; then
                PG_SERVICE="$svc"
                info "Started service: $svc"
                break
            fi
        done
    fi

    if [ -n "$PG_SERVICE" ]; then
        info "Starting PostgreSQL (service: $PG_SERVICE)..."
        systemctl enable "$PG_SERVICE" &>/dev/null || true
        if ! systemctl start "$PG_SERVICE" 2>/dev/null; then
            warn "systemctl start $PG_SERVICE failed."
            warn "Check: journalctl -u $PG_SERVICE"
        fi
    fi

    # Wait up to 10 seconds for the server to become ready
    for i in $(seq 1 10); do
        if pg_isready &>/dev/null; then
            break
        fi
        sleep 1
    done

    if pg_isready &>/dev/null; then
        ok "PostgreSQL started"
        PG_WAS_RUNNING=true
    else
        warn "PostgreSQL is not responding after start attempt."
        if [ -n "$PG_SERVICE" ]; then
            warn "Debug with: journalctl -u $PG_SERVICE -n 50"
        fi
        warn "You can still proceed and provide an external database URL."
    fi
fi

# ── Create system user early (needed for media dir permission check) ──
if id "$AURORA_USER" &>/dev/null; then
    ok "System user '$AURORA_USER' already exists"
else
    info "Creating system user '$AURORA_USER'..."
    groupadd --system "$AURORA_GROUP" 2>/dev/null || true
    useradd --system --gid "$AURORA_GROUP" --shell /usr/sbin/nologin \
        --home-dir "$INSTALL_DIR" --no-create-home "$AURORA_USER"
    ok "System user created"
fi

# ══════════════════════════════════════════════════════════════════
# STEP 2: PostgreSQL database setup
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 2/7: Database setup..."
echo ""

SETUP_LOCAL_DB=false
DB_URL=""

if $PG_INSTALLED && pg_isready &>/dev/null; then
    if confirm "Set up a local PostgreSQL database for Aurora?"; then
        SETUP_LOCAL_DB=true
    fi
fi

if $SETUP_LOCAL_DB; then
    DB_PASSWORD="$(rand_string 32)"

    # Create user (ignore if exists)
    if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='aurora'" 2>/dev/null | grep -q 1; then
        info "PostgreSQL user 'aurora' already exists."
        if confirm "Reset the aurora user's password?"; then
            sudo -u postgres psql -c "ALTER USER aurora WITH PASSWORD '${DB_PASSWORD}';" &>/dev/null
            ok "Password updated"
        else
            prompt "Enter the existing aurora user's password" ""
            DB_PASSWORD="$REPLY"
        fi
    else
        info "Creating PostgreSQL user 'aurora'..."
        sudo -u postgres psql -c "CREATE USER aurora WITH PASSWORD '${DB_PASSWORD}';" &>/dev/null
        ok "PostgreSQL user 'aurora' created"
    fi

    # Create database (or reset if exists)
    if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='aurora'" 2>/dev/null | grep -q 1; then
        warn "Database 'aurora' already exists"
        if confirm "Reset the database? (This will DELETE all Aurora data — media items, users, settings)"; then
            # Stop Aurora service first so its connection pool doesn't block dropdb
            if systemctl is-active aurora &>/dev/null; then
                info "Stopping Aurora service before database reset..."
                systemctl stop aurora 2>/dev/null || true
                sleep 1
            fi
            # Terminate any remaining connections to the database
            sudo -u postgres psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='aurora' AND pid <> pg_backend_pid();" &>/dev/null || true
            info "Dropping and recreating database 'aurora'..."
            sudo -u postgres dropdb aurora
            sudo -u postgres createdb -O aurora aurora
            ok "Database 'aurora' reset (fresh)"
        else
            ok "Keeping existing database"
        fi
    else
        info "Creating database 'aurora'..."
        sudo -u postgres createdb -O aurora aurora
        ok "Database 'aurora' created"
    fi

    # Ensure pg_hba.conf allows password auth for the aurora user
    PG_HBA=$(sudo -u postgres psql -tAc "SHOW hba_file" 2>/dev/null || echo "")
    if [ -n "$PG_HBA" ] && [ -f "$PG_HBA" ]; then
        if ! grep -qE "^\s*(local|host)\s+aurora\s+aurora\s" "$PG_HBA" 2>/dev/null; then
            info "Adding password auth rules for aurora user..."
            if grep -q "^# TYPE" "$PG_HBA" 2>/dev/null; then
                # Insert after the header comment
                sed -i "/^# TYPE/a host    aurora          aurora          ::1/128                 scram-sha-256" "$PG_HBA"
                sed -i "/^# TYPE/a host    aurora          aurora          127.0.0.1/32            scram-sha-256" "$PG_HBA"
                sed -i "/^# TYPE/a local   aurora          aurora                                  scram-sha-256" "$PG_HBA"
            else
                # No header found, append to end of file
                echo "local   aurora          aurora                                  scram-sha-256" >> "$PG_HBA"
                echo "host    aurora          aurora          127.0.0.1/32            scram-sha-256" >> "$PG_HBA"
                echo "host    aurora          aurora          ::1/128                 scram-sha-256" >> "$PG_HBA"
            fi
            if [ -n "$PG_SERVICE" ]; then
                systemctl reload "$PG_SERVICE" &>/dev/null || true
            fi
            ok "pg_hba.conf updated (scram-sha-256 auth for aurora)"
        fi
    fi

    # URL-encode the password in case it contains special chars (user-entered)
    ENCODED_PW="$(urlencode_password "$DB_PASSWORD")"
    DB_URL="postgres://aurora:${ENCODED_PW}@localhost:5432/aurora?sslmode=disable"
    ok "Database URL configured"
else
    echo ""
    info "Enter your PostgreSQL connection string."
    echo "  Format: postgres://user:password@host:5432/dbname?sslmode=disable"
    prompt "DATABASE_URL" "postgres://aurora:aurora@localhost:5432/aurora?sslmode=disable"
    DB_URL="$REPLY"
fi

# ══════════════════════════════════════════════════════════════════
# STEP 3: API keys
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 3/7: API keys..."
echo ""

info "Aurora uses TheMovieDB (TMDB) for movie/TV metadata and artwork."
echo "  Get a free API key at: https://www.themoviedb.org/settings/api"
echo ""

TMDB_KEY=""
while [ -z "$TMDB_KEY" ]; do
    prompt "TMDB API Key (required)" ""
    TMDB_KEY="$REPLY"
    if [ -z "$TMDB_KEY" ]; then
        warn "TMDB API key is required for metadata/artwork. Cannot skip."
    fi
done
ok "TMDB API key set"

TVDB_KEY=""
TVDB_PIN=""
echo ""
if confirm "Do you have a TheTVDB API key? (optional, for TV show fallback)" "N"; then
    prompt "TVDB API Key" ""
    TVDB_KEY="$REPLY"
    prompt "TVDB PIN" ""
    TVDB_PIN="$REPLY"
    ok "TVDB credentials set"
else
    info "Skipping TVDB (can be added later in /etc/aurora/aurora.env)"
fi

# ══════════════════════════════════════════════════════════════════
# STEP 4: Media directory
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 4/7: Media directory..."
echo ""

info "You can add media libraries later via the web UI."
info "If you know your media directory now, we'll verify permissions."
echo ""

MEDIA_DIR=""
if confirm "Specify a media directory now?" "N"; then
    prompt "Media directory path (e.g. /mnt/media, /home/user/Movies)" ""
    MEDIA_DIR="$REPLY"
    if [ -n "$MEDIA_DIR" ]; then
        if [ -d "$MEDIA_DIR" ]; then
            # Ensure aurora user can read it (user was created in Step 1)
            if sudo -u "$AURORA_USER" test -r "$MEDIA_DIR" 2>/dev/null; then
                ok "Aurora user can read $MEDIA_DIR"
            else
                info "Granting read access to $MEDIA_DIR for aurora user..."
                if setfacl -R -m "u:${AURORA_USER}:rX" "$MEDIA_DIR" 2>/dev/null || \
                   chmod -R o+rX "$MEDIA_DIR" 2>/dev/null; then
                    ok "Permissions updated"
                else
                    warn "Could not set permissions on $MEDIA_DIR. You may need to do this manually."
                fi
            fi
        else
            warn "Directory '$MEDIA_DIR' does not exist. Create it before adding a library."
        fi
    fi
else
    info "Skipping. Add libraries at http://localhost:8484 after starting Aurora."
fi

# ══════════════════════════════════════════════════════════════════
# STEP 5: Build
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 5/7: Building Aurora..."
echo ""

info "Building from source in $PROJECT_DIR..."
cd "$PROJECT_DIR"
VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "dev")
CGO_ENABLED=0 go build -ldflags="-s -w -X main.version=${VERSION}" -o aurora ./cmd/aurora
ok "Build complete (version: $VERSION)"

info "Installing binary to $INSTALL_BIN..."
install -m 755 aurora "$INSTALL_BIN"
rm -f aurora
ok "Binary installed"

# ══════════════════════════════════════════════════════════════════
# STEP 6: Install files and write config
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 6/7: Installing files and writing configuration..."
echo ""

# Create directories
mkdir -p "$INSTALL_DIR/migrations"
mkdir -p "$CONFIG_DIR"
mkdir -p "$CACHE_DIR/images"
mkdir -p "$CACHE_DIR/subtitles"
mkdir -p "$TRANSCODE_DIR"
install -d -m 0750 -o "$AURORA_USER" -g "$AURORA_GROUP" /var/log/aurora
ok "Directories created"

# Copy migrations (overwrite for upgrades)
cp -f "$PROJECT_DIR"/migrations/*.sql "$INSTALL_DIR/migrations/"
ok "Migrations copied"

# Copy static files (atomic swap to avoid outage during upgrades)
cp -r "$PROJECT_DIR/static" "$INSTALL_DIR/static.new"
if [ -d "$INSTALL_DIR/static" ]; then
    mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.old"
fi
mv "$INSTALL_DIR/static.new" "$INSTALL_DIR/static"
rm -rf "$INSTALL_DIR/static.old"
ok "Static files copied (frontend)"

# Install systemd service
if [ ! -f "$PROJECT_DIR/scripts/aurora.service" ]; then
    error "Missing aurora.service in $PROJECT_DIR/scripts/. Is the repository complete?"
fi
cp "$PROJECT_DIR/scripts/aurora.service" /etc/systemd/system/aurora.service
# Patch the After= line to use the actual detected PG service name (varies by distro)
if [ -n "$PG_SERVICE" ] && [ "$PG_SERVICE" != "postgresql" ]; then
    sed -i "s/After=network-online.target postgresql.service/After=network-online.target ${PG_SERVICE}.service/" \
        /etc/systemd/system/aurora.service
fi
ok "Systemd service installed"

# Handle existing configuration (preserve JWT_SECRET, backup before overwrite)
SKIP_CONFIG=false
EXISTING_JWT=""
if [ -f "$CONFIG_DIR/aurora.env" ]; then
    info "Existing configuration found at $CONFIG_DIR/aurora.env"
    EXISTING_JWT=$(grep '^JWT_SECRET=' "$CONFIG_DIR/aurora.env" 2>/dev/null | head -1 | cut -d= -f2- || echo "")
    # Strip surrounding quotes in case the file was manually edited with quotes
    EXISTING_JWT="${EXISTING_JWT#\"}"
    EXISTING_JWT="${EXISTING_JWT%\"}"
    EXISTING_JWT="${EXISTING_JWT#\'}"
    EXISTING_JWT="${EXISTING_JWT%\'}"
    if confirm "Overwrite existing configuration? (a backup will be saved)"; then
        cp "$CONFIG_DIR/aurora.env" "$CONFIG_DIR/aurora.env.bak"
        ok "Backup saved to $CONFIG_DIR/aurora.env.bak"
    else
        info "Keeping existing configuration."
        SKIP_CONFIG=true
    fi
fi

if ! $SKIP_CONFIG; then
    # Preserve existing JWT_SECRET to avoid invalidating user sessions on re-run
    if [ -n "$EXISTING_JWT" ]; then
        JWT_SECRET="$EXISTING_JWT"
        info "Preserving existing JWT_SECRET (user sessions remain valid)"
    else
        JWT_SECRET="$(rand_string 64)"
    fi

    # Write environment file using printf for dynamic values to prevent shell
    # expansion of special characters ($, `, \) in user-entered passwords/keys.
    # Values are unquoted -- systemd double-quotes process C-style escapes
    # which would corrupt backslashes in passwords/URLs.
    info "Writing configuration to $CONFIG_DIR/aurora.env..."
    {
        printf '# Aurora Media Server - Configuration\n'
        printf '# Generated by install.sh on %s\n' "$(date -u +"%Y-%m-%d %H:%M:%S UTC")"
        printf '\n'
        printf '# PostgreSQL connection string\n'
        printf 'DATABASE_URL=%s\n' "$DB_URL"
        printf '\n'
        printf '# JWT signing secret (auto-generated, do not share)\n'
        printf 'JWT_SECRET=%s\n' "$JWT_SECRET"
        printf '\n'
        printf '# TheMovieDB API key\n'
        printf 'TMDB_API_KEY=%s\n' "$TMDB_KEY"
    } > "$CONFIG_DIR/aurora.env"

    # Add optional TVDB config
    if [ -n "$TVDB_KEY" ]; then
        {
            printf '\n'
            printf '# TheTVDB credentials\n'
            printf 'TVDB_API_KEY=%s\n' "$TVDB_KEY"
            printf 'TVDB_PIN=%s\n' "$TVDB_PIN"
        } >> "$CONFIG_DIR/aurora.env"
    fi

    # Add cache/transcode config (these are script constants, safe for heredoc)
    cat >> "$CONFIG_DIR/aurora.env" <<'ENVFILE'

# Cache directories
ENVFILE
    printf 'CACHE_IMAGE_DIR=%s\n' "$CACHE_DIR/images" >> "$CONFIG_DIR/aurora.env"
    printf 'CACHE_TRANSCODE_DIR=%s\n' "$TRANSCODE_DIR" >> "$CONFIG_DIR/aurora.env"
    printf 'CACHE_SUBTITLE_DIR=%s\n' "$CACHE_DIR/subtitles" >> "$CONFIG_DIR/aurora.env"
    cat >> "$CONFIG_DIR/aurora.env" <<'ENVFILE'

# CORS & WebSocket allowed origins (comma-separated, * = allow all)
# Set to * by default so Aurora works when accessed via IP, hostname, or domain.
# Authentication is enforced by JWT token validation regardless of this setting.
AURORA_ALLOWED_ORIGINS=*

# Logging
LOG_DIR=/var/log/aurora
LOG_LEVEL=info

# Transcoding (optional -- uncomment to customize)
# TRANSCODE_HW_ACCEL=auto
# TRANSCODE_MAX_SESSIONS=0
# TRANSCODE_PROFILES=1080p,720p,480p
ENVFILE

    chmod 640 "$CONFIG_DIR/aurora.env"
    chown root:"$AURORA_GROUP" "$CONFIG_DIR/aurora.env"
    ok "Configuration written"
fi

# Set ownership
chown -R "$AURORA_USER:$AURORA_GROUP" "$INSTALL_DIR"
chown -R "$AURORA_USER:$AURORA_GROUP" "$CACHE_DIR"
ok "File ownership set"

systemctl daemon-reload

# ══════════════════════════════════════════════════════════════════
# STEP 7: Start service
# ══════════════════════════════════════════════════════════════════

echo ""
info "Step 7/7: Starting Aurora..."
echo ""

# Check for port conflicts before starting (skip if Aurora itself is already running)
if command -v ss &>/dev/null; then
    if ! systemctl is-active aurora &>/dev/null && ss -tlnp 2>/dev/null | grep -q ":8484 "; then
        warn "Port 8484 is already in use by another process."
        warn "Check what is using it: sudo ss -tlnp | grep 8484"
    fi
fi

systemctl enable aurora &>/dev/null
ok "Service enabled (starts on boot)"

# Use restart (not start) so re-runs pick up new config
if systemctl is-active aurora &>/dev/null; then
    systemctl restart aurora
else
    systemctl start aurora
fi
sleep 2

SERVICE_OK=false
if systemctl is-active aurora &>/dev/null; then
    ok "Aurora is running!"

    # Health check with curl or wget fallback
    sleep 1
    HEALTH=""
    for i in $(seq 1 5); do
        if command -v curl &>/dev/null; then
            HEALTH=$(curl -sf http://localhost:8484/api/health 2>/dev/null || echo "")
        elif command -v wget &>/dev/null; then
            HEALTH=$(wget -qO- http://localhost:8484/api/health 2>/dev/null || echo "")
        fi
        if echo "$HEALTH" | grep -qi "ok\|healthy\|status" 2>/dev/null; then
            break
        fi
        HEALTH=""
        sleep 1
    done

    if [ -n "$HEALTH" ]; then
        ok "Health check passed"
        SERVICE_OK=true
    else
        warn "Service is running but health endpoint not responding yet. It may still be starting up."
        warn "Check logs: journalctl -u aurora -f"
        SERVICE_OK=true
    fi
else
    warn "Service failed to start. Check logs with: journalctl -u aurora -n 50"
fi

# Clear the trap so it does not fire on normal exit
trap - INT TERM

# ══════════════════════════════════════════════════════════════════
# Optional: Requests Integration (Radarr / Sonarr)
# ══════════════════════════════════════════════════════════════════

echo ""
if $SERVICE_OK && confirm "Would you like to enable media Requests via Radarr and Sonarr?" "N"; then

    info "Requests integration setup"
    echo ""
    echo "  Aurora can forward media requests to Radarr (movies) and Sonarr (TV shows)."
    echo "  You will need the URL and API key for each service."
    echo "  Find API keys in Radarr/Sonarr under Settings > General > Security."
    echo ""

    HAS_4K=false
    if confirm "Do you have separate 4K instances of Radarr and Sonarr?" "N"; then
        HAS_4K=true
    fi

    # ── Radarr ────────────────────────────────────────────────
    RADARR_URL=""
    RADARR_API_KEY=""
    prompt "Radarr URL" "http://localhost:7878"
    RADARR_URL="$REPLY"
    prompt "Radarr API Key" ""
    RADARR_API_KEY="$REPLY"

    RADARR_4K_URL=""
    RADARR_4K_API_KEY=""
    if $HAS_4K; then
        prompt "Radarr 4K URL" "http://localhost:7879"
        RADARR_4K_URL="$REPLY"
        prompt "Radarr 4K API Key" ""
        RADARR_4K_API_KEY="$REPLY"
    fi

    # ── Sonarr ────────────────────────────────────────────────
    SONARR_URL=""
    SONARR_API_KEY=""
    prompt "Sonarr URL" "http://localhost:8989"
    SONARR_URL="$REPLY"
    prompt "Sonarr API Key" ""
    SONARR_API_KEY="$REPLY"

    SONARR_4K_URL=""
    SONARR_4K_API_KEY=""
    if $HAS_4K; then
        prompt "Sonarr 4K URL" "http://localhost:8990"
        SONARR_4K_URL="$REPLY"
        prompt "Sonarr 4K API Key" ""
        SONARR_4K_API_KEY="$REPLY"
    fi

    # ── Write to aurora.env ───────────────────────────────────
    ENV_FILE="$CONFIG_DIR/aurora.env"
    if [ -f "$ENV_FILE" ]; then
        {
            printf '\n'
            printf '# Requests integration (Radarr / Sonarr)\n'
            printf 'REQUESTS_ENABLED=true\n'
            printf 'RADARR_URL=%s\n' "$RADARR_URL"
            printf 'RADARR_API_KEY=%s\n' "$RADARR_API_KEY"
            if [ -n "$RADARR_4K_URL" ]; then
                printf 'RADARR_4K_URL=%s\n' "$RADARR_4K_URL"
                printf 'RADARR_4K_API_KEY=%s\n' "$RADARR_4K_API_KEY"
            fi
            printf 'SONARR_URL=%s\n' "$SONARR_URL"
            printf 'SONARR_API_KEY=%s\n' "$SONARR_API_KEY"
            if [ -n "$SONARR_4K_URL" ]; then
                printf 'SONARR_4K_URL=%s\n' "$SONARR_4K_URL"
                printf 'SONARR_4K_API_KEY=%s\n' "$SONARR_4K_API_KEY"
            fi
        } >> "$ENV_FILE"

        chmod 640 "$ENV_FILE"
        chown root:"$AURORA_GROUP" "$ENV_FILE"
        ok "Requests configuration written to $ENV_FILE"

        # Restart Aurora to pick up new config
        systemctl restart aurora &>/dev/null || true
        ok "Aurora restarted with Requests enabled"
    else
        warn "Configuration file $ENV_FILE not found. Add REQUESTS_ENABLED=true and ARR keys manually."
    fi
fi

# ══════════════════════════════════════════════════════════════════
# Optional: Reverse Proxy with HTTPS (Nginx + Let's Encrypt)
# ══════════════════════════════════════════════════════════════════

PROXY_DOMAIN=""
PROXY_SETUP_OK=false

echo ""
if $SERVICE_OK && confirm "Would you like to set up a reverse proxy with HTTPS? (requires a domain pointed at this server)" "N"; then

    info "Reverse proxy setup (Nginx + Let's Encrypt)"
    echo ""

    # ── Prompt for domain ────────────────────────────────────────
    while true; do
        prompt "Enter your domain name (e.g., media.example.com)" ""
        PROXY_DOMAIN="$REPLY"
        # Strip protocol prefix if accidentally included
        PROXY_DOMAIN="${PROXY_DOMAIN#http://}"
        PROXY_DOMAIN="${PROXY_DOMAIN#https://}"
        PROXY_DOMAIN="${PROXY_DOMAIN%%/*}"  # Strip trailing path
        if [ -z "$PROXY_DOMAIN" ]; then
            warn "Domain name cannot be empty."
        elif ! echo "$PROXY_DOMAIN" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$'; then
            warn "Invalid domain name. Only letters, digits, dots, and hyphens are allowed."
        elif [ "${#PROXY_DOMAIN}" -gt 253 ]; then
            warn "Domain name too long (max 253 characters)."
        else
            break
        fi
    done

    # ── Prompt for email ─────────────────────────────────────────
    while true; do
        prompt "Email for Let's Encrypt certificate notices" ""
        CERTBOT_EMAIL="$REPLY"
        if echo "$CERTBOT_EMAIL" | grep -qE '^[^@]+@[^@]+\.[^@]+$'; then
            break
        else
            warn "Please enter a valid email address (e.g., user@example.com)."
        fi
    done

    # ── Install nginx if needed ──────────────────────────────────
    PROXY_ABORT=false
    if command -v nginx &>/dev/null; then
        ok "Nginx is already installed"
    else
        info "Nginx is not installed."
        if confirm "Install nginx?" "Y"; then
            detect_pkg_manager
            case "$PKG_MGR" in
                apt)
                    if ! $APT_UPDATED; then apt-get update -qq || true; APT_UPDATED=true; fi
                    apt-get install -y -qq nginx || true
                    ;;
                dnf)    dnf install -y -q nginx || true ;;
                yum)    yum install -y -q nginx || true ;;
                pacman) pacman -S --noconfirm nginx > /dev/null || true ;;
                *)      warn "No supported package manager. Install nginx manually and re-run."; PROXY_ABORT=true ;;
            esac
            if ! $PROXY_ABORT && command -v nginx &>/dev/null; then
                ok "Nginx installed"
            elif ! $PROXY_ABORT; then
                warn "Nginx installation failed."
                PROXY_ABORT=true
            fi
        else
            warn "Skipping reverse proxy setup (nginx required)."
            PROXY_ABORT=true
        fi
    fi

    # ── Install certbot if needed ────────────────────────────────
    if ! $PROXY_ABORT; then
        if command -v certbot &>/dev/null; then
            ok "Certbot is already installed"
        else
            info "Certbot is not installed."
            if confirm "Install certbot with nginx plugin?" "Y"; then
                detect_pkg_manager
                case "$PKG_MGR" in
                    apt)
                        if ! $APT_UPDATED; then apt-get update -qq || true; APT_UPDATED=true; fi
                        apt-get install -y -qq certbot python3-certbot-nginx || true
                        ;;
                    dnf)    dnf install -y -q certbot python3-certbot-nginx || true ;;
                    yum)    yum install -y -q certbot python3-certbot-nginx || true ;;
                    pacman) pacman -S --noconfirm certbot certbot-nginx > /dev/null || true ;;
                    *)      warn "No supported package manager. Install certbot manually and re-run."; PROXY_ABORT=true ;;
                esac
                if ! $PROXY_ABORT && command -v certbot &>/dev/null; then
                    ok "Certbot installed"
                elif ! $PROXY_ABORT; then
                    warn "Certbot installation failed."
                    PROXY_ABORT=true
                fi
            else
                warn "Skipping reverse proxy setup (certbot required)."
                PROXY_ABORT=true
            fi
        fi
    fi

    # ── Detect nginx config layout ───────────────────────────────
    # Debian/Ubuntu: sites-available + sites-enabled
    # RHEL/Fedora/Arch: conf.d only
    NGINX_CONF_PATH=""
    NGINX_SITES_STYLE=false
    if ! $PROXY_ABORT; then
        if [ -d /etc/nginx/sites-available ]; then
            NGINX_SITES_STYLE=true
            NGINX_CONF_PATH="/etc/nginx/sites-available/aurora.conf"
        else
            NGINX_CONF_PATH="/etc/nginx/conf.d/aurora.conf"
        fi
    fi

    # ── Generate nginx config ────────────────────────────────────
    if ! $PROXY_ABORT; then
        info "Writing nginx configuration..."

        # Map block must be in http{} context — use a separate conf.d file.
        # Check if a map block already exists (from a previous run or manual setup).
        if ! grep -rq 'map.*\$http_upgrade.*\$connection_upgrade' /etc/nginx/conf.d/ /etc/nginx/sites-available/ /etc/nginx/sites-enabled/ 2>/dev/null; then
            cat > /etc/nginx/conf.d/aurora-map.conf <<'MAPEOF'
# Aurora: WebSocket upgrade map (required for /ws endpoint)
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
MAPEOF
            ok "WebSocket upgrade map written to /etc/nginx/conf.d/aurora-map.conf"
        else
            ok "WebSocket upgrade map already exists (skipping)"
        fi

        # Main server config (HTTP only — certbot will add HTTPS)
        cat > "$NGINX_CONF_PATH" <<CONFEOF
# Aurora Media Server — managed by install.sh
# Do not edit manually if using certbot (it modifies this file for SSL).

upstream aurora_backend {
    server 127.0.0.1:8484;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${PROXY_DOMAIN};

    client_max_body_size 0;

    location / {
        proxy_pass http://aurora_backend;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout  86400s;
        proxy_send_timeout  86400s;
    }

    location /api/stream/ {
        proxy_pass http://aurora_backend;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_http_version 1.1;
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
    }
}
CONFEOF
        ok "Nginx config written to $NGINX_CONF_PATH"

        # Enable site (Debian/Ubuntu style)
        if $NGINX_SITES_STYLE; then
            ln -sf "$NGINX_CONF_PATH" /etc/nginx/sites-enabled/aurora.conf
            ok "Symlinked to sites-enabled"
        fi

        # Remove default site if it would conflict on port 80
        if [ -f /etc/nginx/sites-enabled/default ]; then
            if confirm "Disable the default nginx site? (it may conflict on port 80)" "Y"; then
                rm -f /etc/nginx/sites-enabled/default
                ok "Default site disabled"
            fi
        fi
    fi

    # ── Test nginx config ────────────────────────────────────────
    if ! $PROXY_ABORT; then
        if nginx -t 2>/dev/null; then
            ok "Nginx configuration test passed"
        else
            warn "Nginx configuration test failed:"
            nginx -t 2>&1 || true
            warn "Removing Aurora nginx config and aborting proxy setup."
            rm -f "$NGINX_CONF_PATH" /etc/nginx/conf.d/aurora-map.conf
            if $NGINX_SITES_STYLE; then
                rm -f /etc/nginx/sites-enabled/aurora.conf
            fi
            PROXY_ABORT=true
        fi
    fi

    # ── Start nginx if not running ───────────────────────────────
    if ! $PROXY_ABORT; then
        systemctl enable nginx &>/dev/null || true
        if systemctl is-active nginx &>/dev/null; then
            if systemctl reload nginx 2>/dev/null; then
                ok "Nginx reloaded"
            else
                warn "Nginx reload failed. Check: sudo nginx -t && sudo systemctl reload nginx"
                PROXY_ABORT=true
            fi
        else
            if systemctl start nginx 2>/dev/null; then
                ok "Nginx started"
            else
                warn "Nginx failed to start. Check: journalctl -u nginx -n 20"
                PROXY_ABORT=true
            fi
        fi
    fi

    # ── Run certbot ──────────────────────────────────────────────
    if ! $PROXY_ABORT; then
        info "Obtaining SSL certificate from Let's Encrypt..."
        echo ""
        if certbot --nginx \
                -d "$PROXY_DOMAIN" \
                --non-interactive \
                --agree-tos \
                -m "$CERTBOT_EMAIL" \
                --redirect 2>&1; then
            echo ""
            ok "SSL certificate obtained and nginx configured for HTTPS"

            # Ensure certbot auto-renewal timer is active
            if systemctl list-unit-files certbot.timer 2>/dev/null | grep -q 'certbot.timer'; then
                systemctl enable certbot.timer &>/dev/null || true
                systemctl start certbot.timer &>/dev/null || true
                ok "Certbot auto-renewal timer enabled"
            elif systemctl list-unit-files certbot-renew.timer 2>/dev/null | grep -q 'certbot-renew.timer'; then
                systemctl enable certbot-renew.timer &>/dev/null || true
                systemctl start certbot-renew.timer &>/dev/null || true
                ok "Certbot auto-renewal timer enabled"
            else
                warn "No certbot timer found. Ensure a cron job exists for 'certbot renew'."
            fi

            PROXY_SETUP_OK=true
        else
            echo ""
            warn "Certbot failed to obtain a certificate."
            warn "Common causes: domain DNS not pointed at this server, port 80 blocked by firewall."
            warn "You can retry manually:  sudo certbot --nginx -d $PROXY_DOMAIN"
            warn "Aurora is still accessible at http://localhost:8484/"
        fi
    fi

    # ── Update AURORA_ALLOWED_ORIGINS ────────────────────────────
    if $PROXY_SETUP_OK; then
        ENV_FILE="$CONFIG_DIR/aurora.env"
        if [ -f "$ENV_FILE" ]; then
            CURRENT_ORIGINS=$(grep '^AURORA_ALLOWED_ORIGINS=' "$ENV_FILE" | cut -d= -f2- || echo "")
            if [ "$CURRENT_ORIGINS" = "*" ]; then
                ok "AURORA_ALLOWED_ORIGINS already set to * (all origins allowed)"
            elif echo "$CURRENT_ORIGINS" | grep -qF "$PROXY_DOMAIN"; then
                ok "Domain already in AURORA_ALLOWED_ORIGINS"
            else
                # Append the new domain (use grep+printf to avoid sed metachar issues with &)
                NEW_ORIGINS="${CURRENT_ORIGINS:+${CURRENT_ORIGINS},}https://${PROXY_DOMAIN}"
                grep -v '^AURORA_ALLOWED_ORIGINS=' "$ENV_FILE" > "$ENV_FILE.tmp"
                printf 'AURORA_ALLOWED_ORIGINS=%s\n' "$NEW_ORIGINS" >> "$ENV_FILE.tmp"
                mv "$ENV_FILE.tmp" "$ENV_FILE"
                chmod 640 "$ENV_FILE"
                chown root:"$AURORA_GROUP" "$ENV_FILE"
                ok "Added https://${PROXY_DOMAIN} to AURORA_ALLOWED_ORIGINS"
                systemctl restart aurora &>/dev/null || true
                ok "Aurora restarted to pick up new allowed origin"
            fi
        fi
    fi

    # ── Write marker file for uninstall ──────────────────────────
    if ! $PROXY_ABORT; then
        printf '%s\n' "$PROXY_DOMAIN" > "$CONFIG_DIR/.proxy-setup"
        chmod 640 "$CONFIG_DIR/.proxy-setup"
        chown root:"$AURORA_GROUP" "$CONFIG_DIR/.proxy-setup"
    fi

    if $PROXY_ABORT; then
        warn "Reverse proxy setup was skipped or aborted. Aurora is still running on HTTP."
        PROXY_DOMAIN=""
    fi
fi

# ══════════════════════════════════════════════════════════════════
# Done
# ══════════════════════════════════════════════════════════════════

echo ""
if $SERVICE_OK; then
    echo "  ============================================================"
    echo "   Aurora Media Server - Installation Complete!"
    echo "  ============================================================"
    echo ""
    echo "  Your server is ready at:"
    echo ""
    echo "    Local:        http://localhost:8484/"
    if $PROXY_SETUP_OK; then
    echo "    Public:       https://${PROXY_DOMAIN}/"
    fi
    echo "    API Health:   http://localhost:8484/api/health"
    echo ""
    echo "  Next steps:"
    echo ""
    if $PROXY_SETUP_OK; then
    echo "    1. Open https://${PROXY_DOMAIN}/ in your browser"
    else
    echo "    1. Open http://localhost:8484/ in your browser"
    fi
    echo "    2. Register your first account (it becomes the admin)"
    echo "    3. Go to Admin > Libraries and add your media folders"
    echo "    4. Aurora will scan, match, and fetch metadata automatically"
    echo ""
    if $SETUP_LOCAL_DB; then
    echo "  Database credentials saved in $CONFIG_DIR/aurora.env"
    echo "    User:     aurora"
    echo "    Database: aurora"
    echo ""
    fi
    if $PROXY_SETUP_OK; then
    echo "  SSL certificate will auto-renew via certbot."
    echo "    Manual renewal: sudo certbot renew"
    echo "    Check cert:     sudo certbot certificates"
    echo ""
    fi
else
    echo "  ============================================================"
    echo "   Aurora Media Server - Installed (service not running)"
    echo "  ============================================================"
    echo ""
    echo "  Files are installed but the service failed to start."
    echo "  Debug with: journalctl -u aurora -n 50"
    echo ""
fi
echo "  Useful commands:"
echo "    sudo systemctl status aurora      # Check status"
echo "    journalctl -u aurora -f           # Follow logs"
echo "    sudo systemctl restart aurora     # Restart"
echo "    sudo nano $CONFIG_DIR/aurora.env  # Edit config"
echo ""
if ! $PROXY_SETUP_OK && [ -z "$PROXY_DOMAIN" ]; then
echo "  For reverse proxy setup (nginx/caddy/traefik):"
echo "    See docs/reverse-proxy/"
echo ""
fi
