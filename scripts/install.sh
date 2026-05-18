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

# pgvector — required by migration 014 (semantic_search) and every
# migration after it. Without it installed at the OS level, Aurora's
# first-run migrations halt at 014, the binary exits 1, and the
# admin UI is unreachable. The fresh-install ran into this gap on
# 2026-05-18 — production audit response.
#
# The package name differs by distro AND postgres major version:
#   Debian/Ubuntu: postgresql-${PG_MAJOR}-pgvector
#   RHEL/Fedora:   pgvector_${PG_MAJOR}
#   Arch:          pgvector  (single-version package)
#   openSUSE:      pgvector
#
# Idempotent: bails early if the extension is already visible in
# `pg_available_extensions`. Non-fatal: if the package can't be
# installed (exotic distro, repo gaps), we warn and continue — the
# user will see migration 014 fail explicitly and can hand-install
# from https://github.com/pgvector/pgvector#installation-notes.
install_pgvector() {
    if ! pg_isready &>/dev/null; then
        warn "pgvector install requires a running Postgres — skipping."
        return
    fi

    # Already available system-wide? Skip the package install.
    local has_vector
    has_vector="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_available_extensions WHERE name='vector'" 2>/dev/null || echo "")"
    if [ "$has_vector" = "1" ]; then
        ok "pgvector already installed (extension available)"
        return
    fi

    # Detect PG major version. server_version_num is like "160001"
    # for PG 16.1 — divide by 10000 to get the major.
    local pg_major
    pg_major="$(sudo -u postgres psql -tAc 'SHOW server_version_num' 2>/dev/null | awk '{print int($1/10000)}')"
    if [ -z "$pg_major" ] || [ "$pg_major" = "0" ]; then
        warn "Could not detect Postgres major version — pgvector NOT installed. Aurora's semantic search migration will fail."
        warn "Install manually after fixing: https://github.com/pgvector/pgvector#installation-notes"
        return
    fi
    info "Installing pgvector for Postgres $pg_major..."

    case "$PKG_MGR" in
        apt)
            # Debian/Ubuntu: postgresql-NN-pgvector matches the
            # major version of the installed server. The package is
            # in the main repos for Ubuntu 24.04+ / Debian 12+.
            pkg_install "postgresql-${pg_major}-pgvector"
            ;;
        dnf|yum)
            # RHEL family: pgvector_NN, from the PostgreSQL community
            # repository (postgresql.org/yum). Operators with only
            # the base AppStream repo may not have this — warn rather
            # than error.
            if ! pkg_install "pgvector_${pg_major}" 2>&1; then
                warn "pgvector_${pg_major} not in your $PKG_MGR repos. Enable PGDG: https://www.postgresql.org/download/linux/redhat/"
                return
            fi
            ;;
        pacman)
            # Arch's pgvector is built against the system-default PG.
            # The version-coupling Debian/RHEL have isn't a thing here.
            pkg_install pgvector
            ;;
        zypper)
            # openSUSE's pgvector is in the OBS server:database
            # repository — may need explicit enablement.
            if ! pkg_install "pgvector" 2>&1; then
                warn "pgvector not available via zypper. Enable OBS server:database repo or build from source."
                return
            fi
            ;;
        *)
            warn "Unknown pgvector package name for $PKG_MGR. Install manually."
            return
            ;;
    esac

    # Verify the install actually surfaced the extension to PG.
    # On apt-based systems no Postgres restart is needed (the
    # extension files are read at CREATE EXTENSION time). RHEL
    # behaves identically. Skip the restart unless the next probe
    # fails.
    has_vector="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_available_extensions WHERE name='vector'" 2>/dev/null || echo "")"
    if [ "$has_vector" != "1" ]; then
        warn "pgvector package installed but Postgres can't see it yet. Trying a service restart..."
        if [ -n "$PG_SERVICE" ]; then
            systemctl restart "$PG_SERVICE" 2>/dev/null || true
            # Wait briefly for PG to be ready again
            for _ in $(seq 1 10); do
                if pg_isready &>/dev/null; then break; fi
                sleep 1
            done
        fi
        has_vector="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_available_extensions WHERE name='vector'" 2>/dev/null || echo "")"
    fi

    if [ "$has_vector" != "1" ]; then
        warn "pgvector install incomplete — Aurora migration 014 will fail. Check 'pg_config --pkglibdir' for the vector.so file."
        return
    fi

    # Audit M3 (deep-debug 2026-05-18) — `pg_available_extensions`
    # showing `vector` only means the control file is on disk. The
    # .so library could still be ABI-incompatible with this PG
    # version (e.g. installed a pg16 build against pg15). Catch
    # that NOW by smoke-testing CREATE EXTENSION in a throwaway DB
    # rather than letting the user discover it when migration 014
    # tries the same against the aurora DB and crashes the binary.
    if sudo -u postgres psql -d postgres -c "CREATE EXTENSION vector; DROP EXTENSION vector;" &>/dev/null; then
        ok "pgvector available and load-tested"
    else
        warn "pgvector control file is present but CREATE EXTENSION failed — likely an ABI mismatch with this Postgres version. Migration 014 will fail."
        warn "Inspect: sudo -u postgres psql -d postgres -c 'CREATE EXTENSION vector;'"
    fi
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
#
# Audit H2 — python3 + git are required by the auto-updater
# (aurora-update.sh uses python3 for JSON-safe status writes, git
# for the source mirror). Installing them up front means a minimal
# base image (Alpine, RHEL-minimal) won't surface the missing
# dependency only when the timer first fires 5 minutes after boot.
for tool in curl tar git python3; do
    if ! command -v "$tool" &>/dev/null; then
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
    # Audit (production install 2026-05-18) — explicitly install
    # postgresql-contrib (RHEL family ships it separately; Debian
    # bundles pg_trgm into the main package but contrib provides
    # other extensions Aurora may grow into) and postgresql-client
    # so pg_dump / psql are always available (Aurora's admin backup
    # endpoint shells out to pg_dump; install.sh's own SQL uses psql).
    # Both are no-ops if already pulled in transitively.
    #
    # Audit H3 (deep-debug 2026-05-18) — DON'T silence stderr or
    # `|| true` these. apt/dnf treat "already installed" as success
    # (exit 0), so the only way these fail is a REAL error (broken
    # sources.list, repo down, dependency conflict). Letting them
    # surface beats the "looks-OK then explodes 30 min later" mode.
    case "$PKG_MGR" in
        apt)
            # On modern Debian/Ubuntu the "postgresql" meta-package
            # pulls postgresql-NN + postgresql-client-NN + contrib
            # automatically. The explicit install here is defensive
            # against minimal Debian images where only postgresql-NN
            # is brought in.
            pkg_install postgresql-contrib
            pkg_install postgresql-client
            ;;
        dnf|yum)
            # RHEL/Fedora: postgresql-contrib is a real separate
            # package and is NOT pulled in by postgresql-server.
            pkg_install postgresql-contrib
            ;;
        pacman)
            # Arch's postgresql package bundles contrib + client.
            :
            ;;
        zypper)
            pkg_install postgresql-contrib
            ;;
    esac
    # RHEL/Fedora needs explicit initdb on a fresh install.
    # Audit M4 — only initdb if the data directory looks empty.
    # On a half-initialized run (e.g. an earlier installer crash),
    # postgresql-setup would fail loudly here; the previous
    # `|| true` suppressed that and let us proceed into a broken
    # state. Better to surface the error so the operator can fix
    # the data dir.
    # Audit M-3 (deep-debug 2026-05-18) — try the modern flag form
    # first; only fall back to the legacy subcommand if the binary
    # rejects the flag (e.g. RHEL 7-era postgresql-setup). Don't
    # silence stderr on either path — the same anti-pattern H3
    # removed elsewhere.
    if command -v postgresql-setup &>/dev/null && [ ! -d /var/lib/pgsql/data/base ]; then
        if ! postgresql-setup --initdb; then
            postgresql-setup initdb
        fi
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

# pgvector — Aurora's migration 014 (semantic_search) requires it.
# Installed AFTER Postgres is running so we can probe pg_available_extensions.
# Idempotent; safe to call on re-runs.
install_pgvector

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

# ── Pre-create required PostgreSQL extensions ─────────────────────
# Audit C1 (2026-05-18) + production-install bug 2026-05-18:
# the extension pre-create MUST run unconditionally — on fresh
# create AND on existing-DB reuse paths. Migration 014's
# `CREATE EXTENSION vector` fails for the unprivileged aurora role
# because vector is not TRUSTED; pre-creating it as the postgres
# superuser turns the migration line into a clean no-op.
#
# Idempotent (CREATE EXTENSION IF NOT EXISTS), so safe on every
# run regardless of DB state. Only skipped when Aurora is pointed
# at an EXTERNAL Postgres that this script can't `sudo -u postgres`
# into (the local Postgres isn't running or isn't on this host).
if pg_isready &>/dev/null && sudo -u postgres psql -tAc "SELECT 1" &>/dev/null; then
    info "Ensuring required PostgreSQL extensions in '${DB_NAME}'..."

    # pg_trgm — used by migration 001 for fast LIKE/ILIKE/fuzzy
    # matching. TRUSTED in PG ≥ 13, so technically aurora could
    # create it — but pre-creating as superuser keeps the model
    # uniform and survives any future un-trust.
    if sudo -u postgres psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" &>/dev/null; then
        ok "pg_trgm enabled in '${DB_NAME}'"
    else
        warn "Failed to enable pg_trgm in '${DB_NAME}'. Migration 001 will fail. Check that postgresql-contrib is installed."
    fi

    # vector — used by migration 014 for semantic search.
    # NOT trusted in pgvector 0.7+, so aurora cannot CREATE this
    # without the pre-create. The biggest single cause of fresh-
    # install failures before this block became unconditional.
    if sudo -u postgres psql -d "$DB_NAME" -tAc "SELECT 1 FROM pg_available_extensions WHERE name='vector'" 2>/dev/null | grep -q 1; then
        if sudo -u postgres psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" &>/dev/null; then
            ok "pgvector (vector) enabled in '${DB_NAME}'"
        else
            warn "pgvector is available system-wide but CREATE EXTENSION failed in '${DB_NAME}'. Migration 014 will fail."
        fi
    else
        warn "pgvector NOT available — Aurora's semantic search migration (014) will fail. See the install_pgvector step output above."
    fi
else
    warn "Cannot pre-create extensions — local Postgres isn't reachable as superuser. If using an external Postgres, ensure pg_trgm + vector are pre-created in the database manually:"
    warn "  CREATE EXTENSION IF NOT EXISTS pg_trgm;"
    warn "  CREATE EXTENSION IF NOT EXISTS vector;"
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

# ── Auto-updater: script + service + timer + sudoers grant ────────
# Installs the "pull origin → rebuild → restart" pipeline. The
# timer fires every 5 min and is a fast no-op when origin has no
# new commits. The sudoers fragment lets the aurora user trigger
# the same pipeline from the in-app "Update Now" admin button
# without requiring the binary itself to run as root.
#
# AUDIT C1 + C2 — privilege isolation of the build source.
#
# The updater runs as root via systemd, and it does `git fetch +
# git merge + go build` against whatever `AURORA_SOURCE_DIR` points
# at. If that directory is owned by an unprivileged user, ANY user
# with write access to it (the aurora process itself if compromised,
# or any other local user) gets to inject code that root will then
# compile and install as /usr/local/bin/aurora. That's a root
# escalation primitive, and "the dev cloned to their home directory"
# is the common case.
#
# Defense: install.sh maintains a SEPARATE root-owned clone at
# /var/lib/aurora/source — created by `git clone <origin>` here on
# first run, and refreshed each install. The user's $PROJECT_DIR
# clone (often /home/foo/aurora-codebase-2) is never touched by the
# updater. We also stash the origin URL in aurora.env as
# AURORA_EXPECTED_REMOTE so the updater can verify nothing has
# rewritten .git/config behind its back.
UPDATER_SOURCE_DIR="/var/lib/aurora/source"
UPDATER_ORIGIN_URL=""
SKIP_UPDATER=false

if [ -f "$PROJECT_DIR/scripts/aurora-update.sh" ]; then
    # Determine origin URL from the user's clone. We need it both
    # to set up the root-owned mirror and to write AURORA_EXPECTED_REMOTE.
    if UPDATER_ORIGIN_URL="$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null)" && [ -n "$UPDATER_ORIGIN_URL" ]; then
        :
    else
        warn "No 'origin' remote configured in $PROJECT_DIR — auto-updater requires a git remote to pull from. Skipping updater install."
        SKIP_UPDATER=true
    fi
fi

if [ -f "$PROJECT_DIR/scripts/aurora-update.sh" ] && ! $SKIP_UPDATER; then
    info "Installing auto-updater..."

    # Set up the root-owned source mirror. Clone fresh if absent;
    # otherwise refresh `git fetch` so the updater starts from a
    # current state. We also force-set the origin URL in case a
    # prior install pointed it elsewhere.
    if [ ! -d "$UPDATER_SOURCE_DIR/.git" ]; then
        info "Cloning $UPDATER_ORIGIN_URL to $UPDATER_SOURCE_DIR (root-owned)..."
        # Clone shallowly to keep disk use modest; `git fetch` later
        # will deepen if needed for tag-describe.
        if ! git clone --quiet "$UPDATER_ORIGIN_URL" "$UPDATER_SOURCE_DIR"; then
            warn "git clone of $UPDATER_ORIGIN_URL into $UPDATER_SOURCE_DIR failed. Auto-updater disabled — fix the remote and re-run."
            SKIP_UPDATER=true
        fi
    else
        info "Refreshing existing source mirror at $UPDATER_SOURCE_DIR..."
        git -C "$UPDATER_SOURCE_DIR" remote set-url origin "$UPDATER_ORIGIN_URL"
        git -C "$UPDATER_SOURCE_DIR" fetch --quiet origin || warn "git fetch in $UPDATER_SOURCE_DIR failed — updater will retry on next tick."
    fi

    if ! $SKIP_UPDATER; then
        # Lock down ownership and permissions. root:root + 0755
        # means the aurora user can READ the tree (useful for
        # debugging) but cannot write to it, which is exactly the
        # privilege boundary we need.
        chown -R root:root "$UPDATER_SOURCE_DIR"
        chmod -R go-w "$UPDATER_SOURCE_DIR"

        install -m 755 "$PROJECT_DIR/scripts/aurora-update.sh" /usr/local/bin/aurora-update
        cp "$PROJECT_DIR/scripts/aurora-update.service" /etc/systemd/system/aurora-update.service
        cp "$PROJECT_DIR/scripts/aurora-update.timer"   /etc/systemd/system/aurora-update.timer

        # Validate the sudoers fragment BEFORE installing it. A broken
        # /etc/sudoers.d/ file locks every sudo invocation on the box
        # (including the one you'd need to fix it), so we use
        # `visudo -cf` to syntax-check the snippet against the live
        # sudoers grammar first.
        if visudo -cf "$PROJECT_DIR/scripts/aurora-update.sudoers" >/dev/null 2>&1; then
            install -m 440 "$PROJECT_DIR/scripts/aurora-update.sudoers" /etc/sudoers.d/aurora-update
            ok "Sudoers grant installed (aurora user can trigger updates)"
        else
            warn "═══════════════════════════════════════════════════════"
            warn "Sudoers fragment FAILED visudo -cf check — NOT installed."
            warn "The 5-min auto-update timer will still run as root via"
            warn "systemd, but the in-app 'Update Now' button will be"
            warn "INERT (the Go process can't call systemctl without it)."
            warn "Fix scripts/aurora-update.sudoers and re-run install.sh."
            warn "═══════════════════════════════════════════════════════"
        fi

        # Status JSON lives here. World-readable so the aurora-user
        # Go process can read it; root-writable so only the updater
        # (which runs as root via systemd) can mutate it.
        install -d -m 0755 -o root -g root /var/lib/aurora
        ok "Auto-updater installed: root-owned source at $UPDATER_SOURCE_DIR"
    fi
elif [ ! -f "$PROJECT_DIR/scripts/aurora-update.sh" ]; then
    warn "aurora-update.sh not found in scripts/ — skipping auto-updater install."
fi

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
    # Auto-updater source dir — where the cloned repo lives. The
    # 5-min timer + admin "Update Now" button both `cd` here and
    # `git pull` before rebuilding. We point at the root-owned
    # mirror at /var/lib/aurora/source (set up above) rather than
    # the user's $PROJECT_DIR — see Audit C1 in the install block.
    # If the updater was skipped, this still gets written so a
    # later install.sh run can complete the setup.
    printf '\n# Auto-updater source directory (root-owned)\n'
    printf 'AURORA_SOURCE_DIR=%s\n' "$UPDATER_SOURCE_DIR"
    printf 'AURORA_UPDATE_BRANCH=%s\n' "${AURORA_UPDATE_BRANCH:-main}"
    # Audit C2 — pin the expected origin URL. The updater asserts
    # this matches `git config remote.origin.url` before fetching,
    # so a tampered .git/config can't redirect the pull to a
    # malicious mirror. Empty when there was no origin to detect
    # (skipped-updater path); the updater treats empty as "no
    # verification" but also won't run because AURORA_SOURCE_DIR
    # won't exist.
    if [ -n "$UPDATER_ORIGIN_URL" ]; then
        printf 'AURORA_EXPECTED_REMOTE=%s\n' "$UPDATER_ORIGIN_URL"
    fi
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

# Enable + start the auto-update timer. The timer is what fires
# the update service every 5 minutes; enabling alone would have it
# fire only on next boot. `systemctl start` arms it immediately.
if [ -f /etc/systemd/system/aurora-update.timer ]; then
    systemctl enable aurora-update.timer &>/dev/null
    systemctl start aurora-update.timer &>/dev/null || warn "Failed to start aurora-update.timer — check 'systemctl status aurora-update.timer'"
    ok "Auto-update timer armed (next check in ~2 min, every 5 min after)"
fi

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

# Health-check loop with crash detection. Critical for production
# diagnostics: a failed migration causes aurora.service to exit 1
# during the migration phase, but the old loop just waited 30s for
# /api/health and reported an ambiguous "didn't respond yet."
# Production audit on 2026-05-18 — that ambiguity hid a hard
# migration failure (pgvector missing) and made the install look
# successful when the service was actually crashed.
#
# New flow: every second, check BOTH the systemd state AND
# /api/health. Break early on either (a) service entered failed/
# inactive state — fetch journalctl and show the operator WHY, or
# (b) health endpoint responds — success.
SERVICE_OK=false
SERVICE_FAILED=false
HEALTHY=false

# Capture the unit's NRestarts at loop start. Aurora's systemd unit
# has `Restart=on-failure` + `RestartSec=5`, so a crash-loop
# bounces between activating → failed → activating in <1 s — too
# fast for `is-failed` to catch reliably during our 1 s polling.
# NRestarts is a monotonic counter that increments on every
# restart; if it grows during our window, the service is in a
# crash loop. That's a more robust signal than the instantaneous
# state.
INITIAL_RESTARTS="$(systemctl show aurora -p NRestarts --value 2>/dev/null || echo 0)"
INITIAL_RESTARTS="${INITIAL_RESTARTS:-0}"

for _ in $(seq 1 30); do
    # is-failed catches the steady-state "exited 1" state.
    if systemctl is-failed aurora &>/dev/null; then
        SERVICE_FAILED=true
        break
    fi
    # NRestarts incremented = the unit crashed at least once since
    # we started this loop. Treat that as failed even if systemd
    # is currently mid-restart.
    CURRENT_RESTARTS="$(systemctl show aurora -p NRestarts --value 2>/dev/null || echo 0)"
    CURRENT_RESTARTS="${CURRENT_RESTARTS:-0}"
    if [ "$CURRENT_RESTARTS" -gt "$INITIAL_RESTARTS" ] 2>/dev/null; then
        SERVICE_FAILED=true
        break
    fi
    if curl -sf http://localhost:8484/api/health &>/dev/null; then
        HEALTHY=true
        break
    fi
    sleep 1
done

if $SERVICE_FAILED; then
    echo ""
    warn "═══════════════════════════════════════════════════════════════════"
    warn " AURORA SERVICE FAILED TO START. Last 40 log lines below."
    warn "═══════════════════════════════════════════════════════════════════"
    # --no-pager: don't open less; -n 40 plenty of context for
    # migration errors (single line) or panics (~10 line trace).
    journalctl -u aurora -n 40 --no-pager 2>/dev/null | sed 's/^/  /'
    warn "═══════════════════════════════════════════════════════════════════"
    warn ""
    warn "Most common causes:"
    warn "  • Migration error: a Postgres extension is missing (pg_trgm, vector)."
    warn "    Fix: re-run this installer; it now installs pgvector and"
    warn "    pre-creates the required extensions in the aurora database."
    warn "    If a partial migration left a stale row, delete just that"
    warn "    filename and aurora will replay it on restart:"
    warn "      sudo -u postgres psql aurora -c \\"
    warn "        \"DELETE FROM schema_migrations WHERE version='014_semantic_search.up.sql';\""
    warn "  • Port 8484 in use by another process: sudo ss -tlnp | grep 8484"
    warn "  • DATABASE_URL is wrong / DB role lacks login: check $CONFIG_DIR/aurora.env"
    warn ""
    warn "Full log: sudo journalctl -u aurora --since '5 minutes ago'"
elif $HEALTHY; then
    ok "Aurora service is healthy (responding at /api/health)"
    SERVICE_OK=true

    # Verify the schema is fully migrated. Aurora uses a custom
    # migration runner (NOT golang-migrate), so the schema_migrations
    # table is `(version VARCHAR PRIMARY KEY, applied_at TIMESTAMPTZ)`
    # — one row per applied migration filename. The "dirty" column
    # that golang-migrate uses does NOT exist here; Aurora's runner
    # uses a per-migration transaction so half-applied state is
    # impossible.
    #
    # Audit C2 (deep-debug 2026-05-18) — count comparison is the
    # right shape: applied row count should equal the number of
    # .up.sql files in the migrations directory. The prior version
    # of this block queried golang-migrate columns and produced
    # false-positive warnings on every install.
    # Audit M-1 (deep-debug 2026-05-18) — compare against the
    # migration directory the BINARY actually loaded from
    # ($INSTALL_DIR/migrations), not the source repo. Project dirs
    # are user-mutable; the installed migrations directory is the
    # source of truth for what aurora.service ran.
    # Audit M-2 — explicit `-d` flag for psql DB selection.
    APPLIED_COUNT="$(sudo -u postgres psql -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM schema_migrations" 2>/dev/null | tr -d '[:space:]' || echo "")"
    EXPECTED_COUNT="$(ls -1 "$INSTALL_DIR/migrations"/*.up.sql 2>/dev/null | wc -l | tr -d '[:space:]')"
    if [ -z "$APPLIED_COUNT" ]; then
        warn "schema_migrations table not found — Aurora hasn't run its first-boot migrations yet. This is OK if the service just started; check 'sudo systemctl status aurora'."
    elif [ "$APPLIED_COUNT" -eq "$EXPECTED_COUNT" ] 2>/dev/null; then
        ok "All $EXPECTED_COUNT migrations applied successfully"
    else
        warn "Applied $APPLIED_COUNT of $EXPECTED_COUNT migrations — schema is incomplete."
        warn "Tail the log to see which migration failed: sudo journalctl -u aurora -n 50"
    fi
elif systemctl is-active aurora &>/dev/null; then
    # Service is still running, just slow to come up. Show the user
    # the last journal output so they can see whether migrations are
    # progressing or something's hung.
    warn "Service is active but /api/health didn't respond within 30s."
    warn "Showing last 20 journal lines for context:"
    journalctl -u aurora -n 20 --no-pager 2>/dev/null | sed 's/^/  /'
    warn ""
    warn "Likely just a slow first boot (large migrations on a big DB)."
    warn "Tail with: sudo journalctl -u aurora -f"
    SERVICE_OK=true   # don't block install — service IS running
else
    warn "Aurora service unexpectedly stopped during start. journalctl:"
    journalctl -u aurora -n 40 --no-pager 2>/dev/null | sed 's/^/  /'
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

# Audit M2 (deep-debug 2026-05-18) — exit non-zero when the service
# never came up. Previously the script always exit 0, so CI / Ansible
# / a curl-pipe-bash install couldn't detect a failed install. The
# install IS partially complete (files on disk, env file written) —
# but "the server isn't reachable" is the user's actual concern.
if ! $SERVICE_OK; then
    exit 1
fi
