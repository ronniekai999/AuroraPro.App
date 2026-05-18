#!/usr/bin/env bash
# Aurora Media Server — One-and-Done Installer
#
# Auto-installs every prerequisite (Go, FFmpeg, PostgreSQL, build
# tools) and configures Aurora as a systemd service on Linux. The
# only thing you supply is your TMDB API key (free from
# https://www.themoviedb.org/settings/api). Everything else — Go
# tarball download, package install, database creation, JWT secret
# generation, build, service startup — runs without confirmation
# prompts. Re-runs are idempotent: existing JWT/DB/config are
# preserved.
#
# Usage:
#   sudo ./scripts/install.sh
#
# Unattended (no prompts at all):
#   sudo TMDB_API_KEY=xxx ./scripts/install.sh
#
# Opt-in extras (set env vars before invocation):
#   AURORA_DOMAIN=media.example.com         — set up nginx + Let's Encrypt HTTPS
#   AURORA_CERTBOT_EMAIL=you@example.com    — required if AURORA_DOMAIN is set
#   AURORA_RADARR_URL=http://...            — enable Requests via Radarr
#   AURORA_RADARR_API_KEY=...
#   AURORA_SONARR_URL=http://...            — enable Requests via Sonarr
#   AURORA_SONARR_API_KEY=...
#   AURORA_TVDB_API_KEY=... + AURORA_TVDB_PIN=...
#   AURORA_MEDIA_DIR=/path                  — grant read access to a media dir
#
# Re-running this script after editing source code rebuilds + restarts
# the service while keeping the existing JWT secret and database.

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────
# GO_VERSION must be ≥ the `go` directive in go.mod. Bumping go.mod's
# minor version requires bumping this string too.
GO_VERSION="1.25.0"
AURORA_USER="aurora"
AURORA_GROUP="aurora"
INSTALL_BIN="/usr/local/bin/aurora"
INSTALL_DIR="/opt/aurora"
CONFIG_DIR="/etc/aurora"
CACHE_DIR="/var/cache/aurora"
TRANSCODE_DIR="/var/cache/aurora/transcode"
LOG_DIR="/var/log/aurora"

# ── Output helpers ─────────────────────────────────────────────────
info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$1"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$1"; }
ok()    { printf '\033[1;32m[ OK ]\033[0m  %s\n' "$1"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$1"; exit 1; }
step()  { printf '\n\033[1;35m▸ %s\033[0m\n\n' "$1"; }

cleanup_on_interrupt() {
    echo ""
    warn "Installation interrupted. Re-run this script to resume — partial state is safe."
}
trap cleanup_on_interrupt INT TERM

# Yes/no helper with a default. Used for the FEW remaining yes/no
# choices that genuinely matter (mostly: "the DB already exists, do
# you want to reset it?"). Most "would you like X?" prompts have been
# removed in favor of opt-in env vars.
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

# Random alphanumeric string (defaults to 64 chars).
rand_string() {
    local raw
    raw=$(head -c 96 /dev/urandom | base64 | tr -d '\n+/=') || true
    printf '%s' "${raw:0:${1:-64}}"
}

# Portable version compare: version_gte "1.25.0" "1.23" → true.
version_gte() {
    local IFS=.
    local -a v1=($1) v2=($2)
    if [ "${v1[0]}" -gt "${v2[0]}" ] 2>/dev/null; then return 0; fi
    if [ "${v1[0]}" -lt "${v2[0]}" ] 2>/dev/null; then return 1; fi
    if [ "${v1[1]:-0}" -ge "${v2[1]:-0}" ] 2>/dev/null; then return 0; fi
    return 1
}

# URL-encode a password for use in postgres:// URLs. Falls back to a
# pure-bash implementation when python3 isn't installed yet (we
# generate the DB password BEFORE installing python).
urlencode_password() {
    local input="$1"
    if command -v python3 &>/dev/null; then
        printf '%s' "$input" | python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.stdin.read(), safe=''), end='')"
    else
        local s="$input"
        s="${s//%/%25}"; s="${s// /%20}"; s="${s//#/%23}"; s="${s//@/%40}"
        s="${s//:/%3A}"; s="${s//\//%2F}"; s="${s//\?/%3F}"; s="${s//&/%26}"
        s="${s//=/%3D}"; s="${s//+/%2B}"; s="${s//\\/%5C}"; s="${s//\'/%27}"
        s="${s//\"/%22}"; s="${s//\!/%21}"; s="${s//\[/%5B}"; s="${s//\]/%5D}"
        printf '%s' "$s"
    fi
}

# ── Package manager detection + install ───────────────────────────
PKG_MGR=""
APT_UPDATED=false

detect_pkg_manager() {
    if command -v apt-get &>/dev/null;   then PKG_MGR="apt"
    elif command -v dnf &>/dev/null;     then PKG_MGR="dnf"
    elif command -v yum &>/dev/null;     then PKG_MGR="yum"
    elif command -v pacman &>/dev/null;  then PKG_MGR="pacman"
    elif command -v zypper &>/dev/null;  then PKG_MGR="zypper"
    else PKG_MGR=""
    fi
}

# pkg_install <package> — installs without prompting. Errors if no
# supported package manager is on the system.
pkg_install() {
    local pkg="$1"
    case "$PKG_MGR" in
        apt)
            if ! $APT_UPDATED; then
                DEBIAN_FRONTEND=noninteractive apt-get update -qq
                APT_UPDATED=true
            fi
            DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$pkg"
            ;;
        dnf)    dnf install -y -q "$pkg" ;;
        yum)    yum install -y -q "$pkg" ;;
        pacman) pacman -S --noconfirm "$pkg" > /dev/null ;;
        zypper) zypper --quiet --non-interactive install --no-recommends "$pkg" > /dev/null ;;
        *)      error "No supported package manager (apt/dnf/yum/pacman/zypper). Install '$pkg' manually and re-run." ;;
    esac
}

# Names of common system packages vary by distro. This map keeps the
# per-package list inline so the caller just says "ensure_pkg
# postgresql-server" and we route to the right distro name.
ensure_pkg() {
    local generic="$1"
    case "$PKG_MGR/$generic" in
        apt/postgresql-server)   pkg_install postgresql ;;
        dnf/postgresql-server|yum/postgresql-server)  pkg_install postgresql-server; pkg_install postgresql ;;
        pacman/postgresql-server) pkg_install postgresql ;;
        zypper/postgresql-server) pkg_install postgresql-server; pkg_install postgresql ;;
        apt/build-essential)     pkg_install build-essential ;;
        dnf/build-essential|yum/build-essential) pkg_install gcc; pkg_install make ;;
        pacman/build-essential)  pkg_install base-devel ;;
        zypper/build-essential)  pkg_install gcc; pkg_install make ;;
        *)                       pkg_install "$generic" ;;
    esac
}

# ── Go bootstrap (the headline fix) ───────────────────────────────
# Downloads + installs the official Go tarball from go.dev/dl when
# Go is missing OR present but older than GO_VERSION. Installs into
# /usr/local/go (the official recommended location) and prepends
# /usr/local/go/bin to PATH for THIS shell. Subsequent shells will
# pick it up from /etc/profile.d/go.sh which we drop alongside.
install_go() {
    local arch
    arch="$(uname -m)"
    local go_arch
    case "$arch" in
        x86_64|amd64)         go_arch="amd64" ;;
        aarch64|arm64)        go_arch="arm64" ;;
        armv6l|armv7l)        go_arch="armv6l" ;;
        i686|i386)            go_arch="386" ;;
        ppc64le)              go_arch="ppc64le" ;;
        s390x)                go_arch="s390x" ;;
        *) error "Unsupported CPU architecture for Go install: $arch" ;;
    esac

    local tarball="go${GO_VERSION}.linux-${go_arch}.tar.gz"
    local url="https://go.dev/dl/${tarball}"
    local tmp
    tmp="$(mktemp -d)"
    trap "rm -rf '$tmp'" RETURN

    info "Downloading Go ${GO_VERSION} (${go_arch})..."
    if command -v curl &>/dev/null; then
        fetch() { curl -fsSL "$1" -o "$2"; }
    elif command -v wget &>/dev/null; then
        fetch() { wget -q "$1" -O "$2"; }
    else
        error "Neither curl nor wget is available. Install one and re-run."
    fi

    if ! fetch "$url" "$tmp/$tarball"; then
        error "Failed to download Go from $url. Check your network."
    fi

    # Audit H1 — verify the SHA256 published by Google before we
    # extract a system-wide binary. HTTPS protects in transit, but
    # a compromise of dl.google.com or a poisoned local CA store on
    # a minimal image would otherwise let an attacker substitute
    # the toolchain that builds Aurora. The .sha256 file is a tiny
    # text file (64 hex chars + filename) published alongside every
    # release tarball.
    info "Verifying SHA256..."
    if ! fetch "${url}.sha256" "$tmp/${tarball}.sha256"; then
        error "Failed to download SHA256 checksum from ${url}.sha256."
    fi
    local expected actual
    expected="$(tr -d '[:space:]' < "$tmp/${tarball}.sha256")"
    if command -v sha256sum &>/dev/null; then
        actual="$(sha256sum "$tmp/$tarball" | awk '{print $1}')"
    elif command -v shasum &>/dev/null; then
        actual="$(shasum -a 256 "$tmp/$tarball" | awk '{print $1}')"
    else
        error "Neither sha256sum nor shasum is available — cannot verify Go tarball."
    fi
    if [ "$expected" != "$actual" ]; then
        error "Go tarball SHA256 mismatch! Expected $expected, got $actual. Aborting — possible tampering."
    fi
    ok "SHA256 verified"

    info "Extracting Go to /usr/local/go..."
    rm -rf /usr/local/go
    if ! tar -C /usr/local -xzf "$tmp/$tarball"; then
        error "Failed to extract Go tarball."
    fi

    # Make Go visible to interactive shells. We use a profile.d
    # snippet (POSIX shells / login sessions) so it survives
    # reboots and applies to the aurora service user too. The
    # current script also exports it inline below.
    cat > /etc/profile.d/go.sh <<'PROFILE'
# Aurora installer — make /usr/local/go binaries available system-wide.
if [ -d /usr/local/go/bin ] && ! echo ":$PATH:" | grep -q ":/usr/local/go/bin:"; then
    export PATH="/usr/local/go/bin:$PATH"
fi
PROFILE
    chmod 644 /etc/profile.d/go.sh

    export PATH="/usr/local/go/bin:$PATH"

    if ! command -v go &>/dev/null; then
        error "Go installation succeeded but 'go' is still not on PATH."
    fi
    ok "Go $(go version | awk '{print $3}' | sed 's/^go//') installed"
}

# Detect the PostgreSQL systemd service name. Across distros: just
# "postgresql" on Debian/Ubuntu/Arch; "postgresql-NN" on RHEL/Fedora.
detect_pg_service() {
    PG_SERVICE=""
    for svc in postgresql postgresql-{17,16,15,14,13}; do
        if systemctl cat "${svc}.service" &>/dev/null; then
            PG_SERVICE="$svc"
            break
        fi
    done
}

# ── Preflight ─────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root (use sudo)."
fi

case "$(uname -s)" in
    Linux) ;;
    Darwin) error "macOS is not supported by this installer. On macOS, run 'go build ./cmd/aurora' and start the binary directly." ;;
    *) error "Unsupported operating system: $(uname -s). This installer requires Linux with systemd." ;;
esac

if ! command -v systemctl &>/dev/null; then
    error "systemd not found. This installer targets systemd-based Linux."
fi

# Interactive TTY is only strictly required when TMDB_API_KEY isn't
# pre-supplied via env. Validate later, not here.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ ! -f "$PROJECT_DIR/cmd/aurora/main.go" ]; then
    error "Aurora source not found at $PROJECT_DIR. Run this script from the project's scripts/ folder."
fi

echo ""
echo "  ============================================================"
echo "   Aurora Media Server — One-and-Done Installer"
echo "  ============================================================"
echo ""

detect_pkg_manager
if [ -z "$PKG_MGR" ]; then
    error "No supported package manager (apt/dnf/yum/pacman/zypper). Install one or use the Docker compose flow."
fi
info "Package manager: $PKG_MGR"

# ══════════════════════════════════════════════════════════════════
# STEP 1: System prerequisites — install everything we need
# ══════════════════════════════════════════════════════════════════
step "Step 1/5: Installing system prerequisites"

# Tools we need for the rest of the script itself + the Go download.
# Installed first so the Go bootstrap works on minimal base images.
for tool in curl tar ca-certificates; do
    if ! command -v "$tool" &>/dev/null && [ "$tool" != "ca-certificates" ]; then
        info "Installing $tool..."
        pkg_install "$tool"
    fi
done
# ca-certificates has no single binary to test for; install it
# unconditionally on first run. apt/dnf/etc. are idempotent when
# the package is already installed.
#
# Audit C2 — do NOT silence stderr here. Earlier draft used
# `2>/dev/null || true` which silently masked real apt failures
# (broken sources.list, unreachable mirrors). Letting stderr
# surface means the user sees a clear apt error instead of a
# confusing curl failure several lines later when the Go download
# can't validate Google's certificate.
pkg_install ca-certificates

# Build toolchain (some go modules need cgo for build even with
# CGO_ENABLED=0, since go build still wants 'cc' to be present on some
# distros; safer to ensure it's there).
info "Ensuring build toolchain (gcc + make)..."
ensure_pkg build-essential

# FFmpeg — Aurora's transcoder backend. No prompt: it's required.
if command -v ffmpeg &>/dev/null; then
    ok "FFmpeg: $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
else
    info "Installing FFmpeg..."
    pkg_install ffmpeg
    ok "FFmpeg installed"
fi

# PostgreSQL — Aurora's database. Server + client.
detect_pg_service
PG_INSTALLED=false
if [ -n "$PG_SERVICE" ]; then
    PG_INSTALLED=true
fi

if ! $PG_INSTALLED; then
    info "Installing PostgreSQL..."
    ensure_pkg postgresql-server
    # RHEL/Fedora needs explicit initdb on a fresh install.
    # Audit M4 — only initdb if the data directory looks empty.
    # On a half-initialized run (e.g. an earlier installer crash),
    # postgresql-setup would fail loudly here; the previous
    # `|| true` suppressed that and let us proceed into a broken
    # state. Better to surface the error so the operator can fix
    # the data dir.
    if command -v postgresql-setup &>/dev/null && [ ! -d /var/lib/pgsql/data/base ]; then
        postgresql-setup --initdb 2>/dev/null || postgresql-setup initdb
    fi
    # Arch needs explicit initdb too.
    if [ "$PKG_MGR" = "pacman" ] && [ ! -d /var/lib/postgres/data/base ]; then
        sudo -u postgres initdb -D /var/lib/postgres/data
    fi
    detect_pg_service
fi

if [ -z "$PG_SERVICE" ]; then
    error "PostgreSQL installed but no systemd unit detected. Check journalctl and re-run."
fi

# Start PostgreSQL if it isn't already accepting connections.
if ! pg_isready &>/dev/null; then
    info "Starting PostgreSQL (service: $PG_SERVICE)..."
    systemctl enable "$PG_SERVICE" &>/dev/null || true
    systemctl start "$PG_SERVICE" || true
    # Wait up to 15s for the listener to come up.
    for _ in $(seq 1 15); do
        if pg_isready &>/dev/null; then break; fi
        sleep 1
    done
fi
if pg_isready &>/dev/null; then
    ok "PostgreSQL is running (service: $PG_SERVICE)"
else
    error "PostgreSQL failed to start. Debug with: journalctl -u $PG_SERVICE -n 50"
fi

# Go — the headline fix. Install if missing or older than GO_VERSION.
# Also probe a couple of common install locations sudo's PATH may
# strip (snap, /usr/local/go).
if ! command -v go &>/dev/null; then
    for gobin in /usr/local/go/bin /snap/bin; do
        if [ -x "$gobin/go" ]; then
            export PATH="$gobin:$PATH"
            break
        fi
    done
fi
NEED_GO_INSTALL=false
if command -v go &>/dev/null; then
    CURRENT_GO=$(go version | sed 's/.*go\([0-9]*\.[0-9]*\(\.[0-9]*\)\?\).*/\1/')
    if version_gte "$CURRENT_GO" "$GO_VERSION"; then
        ok "Go $CURRENT_GO already installed"
    else
        info "Go $CURRENT_GO is older than required $GO_VERSION — upgrading"
        NEED_GO_INSTALL=true
    fi
else
    info "Go is not installed — downloading from go.dev/dl"
    NEED_GO_INSTALL=true
fi
if $NEED_GO_INSTALL; then
    install_go
fi

# Create the aurora system user. Idempotent.
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
# STEP 2: Database — auto-create or reuse
# ══════════════════════════════════════════════════════════════════
step "Step 2/5: Configuring the Aurora database"

DB_USER="aurora"
DB_NAME="aurora"
DB_PASSWORD=""

# If a previous install wrote an env file, reuse its DATABASE_URL so
# we don't break existing data on re-runs. Otherwise create fresh
# user + DB with a random password.
EXISTING_DB_URL=""
if [ -f "$CONFIG_DIR/aurora.env" ]; then
    EXISTING_DB_URL=$(grep '^DATABASE_URL=' "$CONFIG_DIR/aurora.env" 2>/dev/null | head -1 | cut -d= -f2- || echo "")
    # Audit H2 — strip surrounding quotes if the operator edited
    # aurora.env and wrapped the value in single or double quotes
    # (a normal shell-env habit). Without this strip, re-runs would
    # rewrite the file with the quotes BAKED IN, accumulating
    # nested quoting on each subsequent run.
    EXISTING_DB_URL="${EXISTING_DB_URL#\"}"; EXISTING_DB_URL="${EXISTING_DB_URL%\"}"
    EXISTING_DB_URL="${EXISTING_DB_URL#\'}"; EXISTING_DB_URL="${EXISTING_DB_URL%\'}"
fi

if [ -n "$EXISTING_DB_URL" ]; then
    DB_URL="$EXISTING_DB_URL"
    ok "Reusing existing DATABASE_URL from $CONFIG_DIR/aurora.env"
else
    DB_PASSWORD="$(rand_string 32)"

    # Create or update the aurora role.
    #
    # Audit H3 — this branch runs only when no existing
    # `aurora.env` was found. If a prior install ran `uninstall.sh`
    # (which deletes aurora.env) but the DB tables were preserved,
    # we land here with the OLD database intact and a NEW
    # randomly-generated password. The `ALTER USER ... WITH
    # PASSWORD` below atomically rewrites the scram-sha-256 hash
    # in pg_authid, so the next Aurora boot connects fine — the
    # old hash is gone, the new one matches the env file we're
    # about to write. Looks like a foot-gun at a glance; isn't.
    if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" 2>/dev/null | grep -q 1; then
        info "Role '${DB_USER}' exists — rotating password"
        sudo -u postgres psql -c "ALTER USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';" &>/dev/null
    else
        info "Creating role '${DB_USER}'..."
        sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';" &>/dev/null
    fi
    # Audit H4 — `psql -c` with the password literal can appear in
    # postgres server logs IF the operator has configured
    # `log_statement = 'all'` (or `log_min_duration_statement = 0`).
    # Default postgres configs use `log_statement = 'none'` so a
    # vanilla install is safe; on a server with verbose logging,
    # rotate the password manually after install or set
    # `log_statement = 'ddl'`/`none` before re-running.

    # Create the database if it doesn't already exist. We DELIBERATELY
    # do not drop+recreate when re-running — that would nuke a user's
    # library. The destructive path stays out of the default flow.
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null | grep -q 1; then
        info "Creating database '${DB_NAME}'..."
        sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
    else
        ok "Database '${DB_NAME}' already exists — keeping data"
    fi

    # Ensure pg_hba.conf permits scram-sha-256 for the aurora user.
    PG_HBA=$(sudo -u postgres psql -tAc "SHOW hba_file" 2>/dev/null || echo "")
    if [ -n "$PG_HBA" ] && [ -f "$PG_HBA" ]; then
        if ! grep -qE "^\s*(local|host)\s+${DB_NAME}\s+${DB_USER}\s" "$PG_HBA" 2>/dev/null; then
            info "Adding scram-sha-256 auth rules for aurora user..."
            if grep -q "^# TYPE" "$PG_HBA" 2>/dev/null; then
                sed -i "/^# TYPE/a host    ${DB_NAME}    ${DB_USER}    ::1/128         scram-sha-256" "$PG_HBA"
                sed -i "/^# TYPE/a host    ${DB_NAME}    ${DB_USER}    127.0.0.1/32    scram-sha-256" "$PG_HBA"
                sed -i "/^# TYPE/a local   ${DB_NAME}    ${DB_USER}                    scram-sha-256" "$PG_HBA"
            else
                {
                    echo "local   ${DB_NAME}    ${DB_USER}                    scram-sha-256"
                    echo "host    ${DB_NAME}    ${DB_USER}    127.0.0.1/32    scram-sha-256"
                    echo "host    ${DB_NAME}    ${DB_USER}    ::1/128         scram-sha-256"
                } >> "$PG_HBA"
            fi
            systemctl reload "$PG_SERVICE" &>/dev/null || true
            ok "pg_hba.conf updated"
        fi
    fi

    ENCODED_PW="$(urlencode_password "$DB_PASSWORD")"
    DB_URL="postgres://${DB_USER}:${ENCODED_PW}@localhost:5432/${DB_NAME}?sslmode=disable"
    ok "Database configured"
fi

# ══════════════════════════════════════════════════════════════════
# STEP 3: API keys — TMDB only (everything else is opt-in)
# ══════════════════════════════════════════════════════════════════
step "Step 3/5: TMDB API key"

# If a previous install already wrote a TMDB key, reuse it. Saves a
# prompt on every re-run.
EXISTING_TMDB=""
if [ -f "$CONFIG_DIR/aurora.env" ]; then
    EXISTING_TMDB=$(grep '^TMDB_API_KEY=' "$CONFIG_DIR/aurora.env" 2>/dev/null | head -1 | cut -d= -f2- || echo "")
    # Audit H2 — strip surrounding quotes (see DATABASE_URL above).
    EXISTING_TMDB="${EXISTING_TMDB#\"}"; EXISTING_TMDB="${EXISTING_TMDB%\"}"
    EXISTING_TMDB="${EXISTING_TMDB#\'}"; EXISTING_TMDB="${EXISTING_TMDB%\'}"
fi

TMDB_KEY="${TMDB_API_KEY:-$EXISTING_TMDB}"
if [ -z "$TMDB_KEY" ]; then
    if [ ! -t 0 ]; then
        error "TMDB_API_KEY is not set and stdin is not a terminal. Pass TMDB_API_KEY=... in the environment for unattended runs."
    fi
    echo "  Aurora uses TheMovieDB for movie/TV metadata and artwork."
    echo "  Get a free key: https://www.themoviedb.org/settings/api"
    echo ""
    while [ -z "$TMDB_KEY" ]; do
        printf '\033[1;36m[?]\033[0m TMDB API Key: '
        read -r TMDB_KEY
        if [ -z "$TMDB_KEY" ]; then
            warn "TMDB API key is required. Press Ctrl+C to abort."
        fi
    done
fi
ok "TMDB API key set"

# ══════════════════════════════════════════════════════════════════
# STEP 4: Build + install + configure + start
# ══════════════════════════════════════════════════════════════════
step "Step 4/5: Building Aurora and installing the service"

cd "$PROJECT_DIR"
VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "dev")
info "Building (version: $VERSION)..."
CGO_ENABLED=0 go build -ldflags="-s -w -X main.version=${VERSION}" -o aurora ./cmd/aurora
ok "Build complete"

install -m 755 aurora "$INSTALL_BIN"
rm -f aurora
ok "Binary installed at $INSTALL_BIN"

# Layout directories.
mkdir -p "$INSTALL_DIR/migrations"
mkdir -p "$CONFIG_DIR"
mkdir -p "$CACHE_DIR/images" "$CACHE_DIR/subtitles" "$TRANSCODE_DIR"
install -d -m 0750 -o "$AURORA_USER" -g "$AURORA_GROUP" "$LOG_DIR"

# Migrations + static files (atomic swap for the bundle).
cp -f "$PROJECT_DIR"/migrations/*.sql "$INSTALL_DIR/migrations/"
cp -r "$PROJECT_DIR/static" "$INSTALL_DIR/static.new"
# Audit C1 — clear any leftover static.old from a previously-crashed
# run BEFORE the rename. GNU `mv` refuses to overwrite a non-empty
# directory, so without this an interrupted earlier run would brick
# every subsequent install attempt (the rename below would fail and
# `set -e` would abort). BSD mv on macOS hides this — Linux exposes
# it on the first re-run.
rm -rf "$INSTALL_DIR/static.old"
if [ -d "$INSTALL_DIR/static" ]; then
    mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.old"
fi
mv "$INSTALL_DIR/static.new" "$INSTALL_DIR/static"
rm -rf "$INSTALL_DIR/static.old"
ok "Static assets + migrations copied"

# systemd unit. Patch the After= line to the actual detected PG
# service name (it's "postgresql-17" on Fedora-17 etc).
if [ ! -f "$PROJECT_DIR/scripts/aurora.service" ]; then
    error "Missing scripts/aurora.service — repository checkout is incomplete."
fi
cp "$PROJECT_DIR/scripts/aurora.service" /etc/systemd/system/aurora.service
if [ "$PG_SERVICE" != "postgresql" ]; then
    sed -i "s/postgresql\.service/${PG_SERVICE}.service/" /etc/systemd/system/aurora.service
fi
ok "systemd unit installed"

# Env file. Preserve JWT_SECRET across re-runs so existing user
# sessions don't get invalidated.
EXISTING_JWT=""
if [ -f "$CONFIG_DIR/aurora.env" ]; then
    EXISTING_JWT=$(grep '^JWT_SECRET=' "$CONFIG_DIR/aurora.env" 2>/dev/null | head -1 | cut -d= -f2- || echo "")
    EXISTING_JWT="${EXISTING_JWT#\"}"; EXISTING_JWT="${EXISTING_JWT%\"}"
    EXISTING_JWT="${EXISTING_JWT#\'}"; EXISTING_JWT="${EXISTING_JWT%\'}"
    # Back up the previous env file in case the user customized it.
    cp "$CONFIG_DIR/aurora.env" "$CONFIG_DIR/aurora.env.bak"
fi
JWT_SECRET="${EXISTING_JWT:-$(rand_string 64)}"

info "Writing $CONFIG_DIR/aurora.env..."
{
    printf '# Aurora Media Server — auto-generated %s\n' "$(date -u +"%Y-%m-%d %H:%M:%S UTC")"
    printf '# Edit and run "systemctl restart aurora" to apply changes.\n\n'
    printf '# PostgreSQL connection string\n'
    printf 'DATABASE_URL=%s\n\n' "$DB_URL"
    printf '# JWT signing secret (do not share)\n'
    printf 'JWT_SECRET=%s\n\n' "$JWT_SECRET"
    printf '# TheMovieDB API key\n'
    printf 'TMDB_API_KEY=%s\n' "$TMDB_KEY"
    # Optional TVDB via env override.
    if [ -n "${AURORA_TVDB_API_KEY:-}" ]; then
        printf '\n# TheTVDB credentials\n'
        printf 'TVDB_API_KEY=%s\n' "$AURORA_TVDB_API_KEY"
        printf 'TVDB_PIN=%s\n' "${AURORA_TVDB_PIN:-}"
    fi
    printf '\n# Cache directories\n'
    printf 'CACHE_IMAGE_DIR=%s\n' "$CACHE_DIR/images"
    printf 'CACHE_TRANSCODE_DIR=%s\n' "$TRANSCODE_DIR"
    printf 'CACHE_SUBTITLE_DIR=%s\n' "$CACHE_DIR/subtitles"
    printf '\n# CORS / WebSocket allowed origins (auth is still JWT-enforced)\n'
    printf 'AURORA_ALLOWED_ORIGINS=*\n'
    printf '\n# Logging\n'
    printf 'LOG_DIR=%s\n' "$LOG_DIR"
    printf 'LOG_LEVEL=info\n'
    # Optional Requests integration via env override.
    if [ -n "${AURORA_RADARR_URL:-}" ] || [ -n "${AURORA_SONARR_URL:-}" ]; then
        printf '\n# Requests integration (Radarr / Sonarr)\n'
        printf 'REQUESTS_ENABLED=true\n'
        [ -n "${AURORA_RADARR_URL:-}" ]      && printf 'RADARR_URL=%s\n' "$AURORA_RADARR_URL"
        [ -n "${AURORA_RADARR_API_KEY:-}" ]  && printf 'RADARR_API_KEY=%s\n' "$AURORA_RADARR_API_KEY"
        [ -n "${AURORA_SONARR_URL:-}" ]      && printf 'SONARR_URL=%s\n' "$AURORA_SONARR_URL"
        [ -n "${AURORA_SONARR_API_KEY:-}" ]  && printf 'SONARR_API_KEY=%s\n' "$AURORA_SONARR_API_KEY"
    fi
} > "$CONFIG_DIR/aurora.env"
chmod 640 "$CONFIG_DIR/aurora.env"
chown root:"$AURORA_GROUP" "$CONFIG_DIR/aurora.env"
ok "Configuration written"

# Optional media directory grant.
if [ -n "${AURORA_MEDIA_DIR:-}" ] && [ -d "$AURORA_MEDIA_DIR" ]; then
    info "Granting aurora read access to $AURORA_MEDIA_DIR..."
    if setfacl -R -m "u:${AURORA_USER}:rX" "$AURORA_MEDIA_DIR" 2>/dev/null || chmod -R o+rX "$AURORA_MEDIA_DIR" 2>/dev/null; then
        ok "Permissions set on $AURORA_MEDIA_DIR"
    else
        warn "Could not set permissions on $AURORA_MEDIA_DIR — fix manually if scans fail."
    fi
fi

# Ownership of the installed tree.
chown -R "$AURORA_USER:$AURORA_GROUP" "$INSTALL_DIR" "$CACHE_DIR"
ok "File ownership set"

systemctl daemon-reload
systemctl enable aurora &>/dev/null

# Port-conflict pre-check (best effort).
if command -v ss &>/dev/null && ! systemctl is-active aurora &>/dev/null; then
    if ss -tlnp 2>/dev/null | grep -q ":8484 "; then
        warn "Port 8484 already in use. Aurora may fail to bind. Check: ss -tlnp | grep 8484"
    fi
fi

# Restart (handles re-runs cleanly) — falls back to start.
if systemctl is-active aurora &>/dev/null; then
    systemctl restart aurora
else
    systemctl start aurora
fi
sleep 2

SERVICE_OK=false
if systemctl is-active aurora &>/dev/null; then
    ok "Aurora service is active"

    # Wait for /api/health to respond. 30s grace period for first-run
    # migrations.
    HEALTHY=false
    for _ in $(seq 1 30); do
        if curl -sf http://localhost:8484/api/health &>/dev/null; then
            HEALTHY=true
            break
        fi
        sleep 1
    done
    if $HEALTHY; then
        ok "Health endpoint responding"
        SERVICE_OK=true
    else
        warn "Service is active but /api/health didn't respond within 30s. Tail logs: journalctl -u aurora -f"
        SERVICE_OK=true   # service is running; health may catch up on next refresh
    fi
else
    warn "Service failed to start. Check: journalctl -u aurora -n 80"
fi

# ══════════════════════════════════════════════════════════════════
# STEP 5: Optional reverse proxy (HTTPS) — only if AURORA_DOMAIN is set
# ══════════════════════════════════════════════════════════════════
PROXY_DOMAIN="${AURORA_DOMAIN:-}"
PROXY_SETUP_OK=false

if $SERVICE_OK && [ -n "$PROXY_DOMAIN" ]; then
    step "Step 5/5: Configuring HTTPS reverse proxy for $PROXY_DOMAIN"

    CERTBOT_EMAIL="${AURORA_CERTBOT_EMAIL:-}"
    if [ -z "$CERTBOT_EMAIL" ]; then
        warn "AURORA_DOMAIN is set but AURORA_CERTBOT_EMAIL is not — skipping HTTPS setup."
    else
        if ! command -v nginx &>/dev/null;   then pkg_install nginx; fi
        if ! command -v certbot &>/dev/null; then
            case "$PKG_MGR" in
                apt)        pkg_install certbot; pkg_install python3-certbot-nginx ;;
                dnf|yum)    pkg_install certbot; pkg_install python3-certbot-nginx ;;
                pacman)     pkg_install certbot; pkg_install certbot-nginx ;;
                zypper)     pkg_install python3-certbot; pkg_install python3-certbot-nginx ;;
            esac
        fi

        # Nginx config layout differs by distro.
        if [ -d /etc/nginx/sites-available ]; then
            NGINX_CONF_PATH="/etc/nginx/sites-available/aurora.conf"
            NGINX_SITES_STYLE=true
        else
            NGINX_CONF_PATH="/etc/nginx/conf.d/aurora.conf"
            NGINX_SITES_STYLE=false
        fi

        # Shared map block — required for WebSocket upgrade. Lives in
        # http{} context, so it goes in conf.d/ regardless of layout.
        if ! grep -rq 'map.*\$http_upgrade.*\$connection_upgrade' /etc/nginx/conf.d/ /etc/nginx/sites-available/ /etc/nginx/sites-enabled/ 2>/dev/null; then
            cat > /etc/nginx/conf.d/aurora-map.conf <<'MAP'
# Aurora — WebSocket upgrade map for /ws
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
MAP
        fi

        cat > "$NGINX_CONF_PATH" <<CONF
# Aurora — managed by install.sh
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
CONF

        if $NGINX_SITES_STYLE; then
            ln -sf "$NGINX_CONF_PATH" /etc/nginx/sites-enabled/aurora.conf
            rm -f /etc/nginx/sites-enabled/default
        fi

        if nginx -t &>/dev/null; then
            systemctl enable nginx &>/dev/null || true
            systemctl reload nginx 2>/dev/null || systemctl start nginx
            ok "Nginx serving HTTP on :80 for $PROXY_DOMAIN"

            info "Requesting Let's Encrypt certificate..."
            if certbot --nginx -d "$PROXY_DOMAIN" --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect 2>&1; then
                ok "HTTPS active at https://${PROXY_DOMAIN}/"
                systemctl enable certbot.timer &>/dev/null || systemctl enable certbot-renew.timer &>/dev/null || true
                PROXY_SETUP_OK=true

                # Tighten CORS to the actual domain instead of '*'.
                ENV_FILE="$CONFIG_DIR/aurora.env"
                CURRENT_ORIGINS=$(grep '^AURORA_ALLOWED_ORIGINS=' "$ENV_FILE" | cut -d= -f2- || echo "")
                if [ "$CURRENT_ORIGINS" = "*" ]; then
                    grep -v '^AURORA_ALLOWED_ORIGINS=' "$ENV_FILE" > "$ENV_FILE.tmp"
                    printf 'AURORA_ALLOWED_ORIGINS=https://%s\n' "$PROXY_DOMAIN" >> "$ENV_FILE.tmp"
                    mv "$ENV_FILE.tmp" "$ENV_FILE"
                    chmod 640 "$ENV_FILE"
                    chown root:"$AURORA_GROUP" "$ENV_FILE"
                    systemctl restart aurora &>/dev/null || true
                fi
                printf '%s\n' "$PROXY_DOMAIN" > "$CONFIG_DIR/.proxy-setup"
            else
                warn "Certbot failed. Aurora is still up on HTTP; retry manually: certbot --nginx -d $PROXY_DOMAIN"
            fi
        else
            warn "nginx config test failed — rolling back."
            rm -f "$NGINX_CONF_PATH" /etc/nginx/conf.d/aurora-map.conf
            [ "$NGINX_SITES_STYLE" = "true" ] && rm -f /etc/nginx/sites-enabled/aurora.conf
        fi
    fi
fi

trap - INT TERM

# ══════════════════════════════════════════════════════════════════
# Done
# ══════════════════════════════════════════════════════════════════
echo ""
echo "  ============================================================"
if $SERVICE_OK; then
    echo "   Aurora Media Server — Ready"
else
    echo "   Aurora Media Server — Installed (service not running)"
fi
echo "  ============================================================"
echo ""

if $SERVICE_OK; then
    echo "  Open your browser to:"
    echo ""
    if $PROXY_SETUP_OK; then
        echo "    https://${PROXY_DOMAIN}/"
    else
        # Use localhost (not 0.0.0.0) — Chrome blocks 0.0.0.0 as a
        # destination under the Private Network Access mitigations,
        # so always print a navigable URL.
        echo "    http://localhost:8484/"
    fi
    echo ""
    echo "  Next steps:"
    echo "    1. Register your first account (becomes the admin)"
    echo "    2. Admin → Libraries: add your media folders"
    echo "    3. Aurora scans, matches, and fetches metadata"
    echo ""
    if [ -n "$DB_PASSWORD" ]; then
        echo "  Database (auto-generated):"
        echo "    User:      ${DB_USER}"
        echo "    Database:  ${DB_NAME}"
        echo "    Password:  stored in $CONFIG_DIR/aurora.env"
        echo ""
    fi
else
    echo "  Files installed but the service didn't reach a healthy state."
    echo "  Debug:  journalctl -u aurora -n 80"
    echo ""
fi
echo "  Useful commands:"
echo "    systemctl status aurora      # status"
echo "    journalctl -u aurora -f      # follow logs"
echo "    systemctl restart aurora     # restart"
echo "    \$EDITOR $CONFIG_DIR/aurora.env  # edit config"
echo ""
