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
#   AURORA_GIT_TOKEN=<PAT>                  — for private repos: writes an
#                                              Aurora-only root credential file
#                                              so updates can fetch unattended
#
# Re-running this script after editing source code rebuilds + restarts
# the service while keeping the existing JWT secret and database.

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────
# GO_VERSION must be ≥ the `go` directive in go.mod. Bumping go.mod's
# minor version requires bumping this string and both pinned checksums.
GO_VERSION="1.26.5"
GO_SHA256_AMD64="5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053"
GO_SHA256_ARM64="fe4789e92b1f33358680864bbe8704289e7bb5fc207d80623c308935bd696d49"
NODE_VERSION="22.23.1"
NODE_SHA256_X64="9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578"
NODE_SHA256_ARM64="0294e8b915ab75f92c7513d2fcb830ae06e10684e6c603e99a87dbf8835389c1"
# Latest upstream pgvector release as of 2026-07-16. The tag resolves to
# commit 159b79aaad5983fb7459c1e3df2897fbb2d11788. The SHA256 below was
# independently verified against both the official GitHub archive URL and
# its codeload.github.com redirect.
PGVECTOR_VERSION="0.8.5"
PGVECTOR_SHA256="6f88a5cbdde31666f4b6c1a6b75c51dcbeffe58f9a7d2b26e502d5a6e5e14d44"
AURORA_USER="aurora"
AURORA_GROUP="aurora"
INSTALL_BIN="/usr/local/bin/aurora"
INSTALL_DIR="/opt/aurora"
CONFIG_DIR="/etc/aurora"
CACHE_DIR="/var/cache/aurora"
TRANSCODE_DIR="/var/cache/aurora/transcode"
LOG_DIR="/var/log/aurora"
SPA_SRC_DIR="static/redesign/app"
SPA_OUTPUT_DIR="static/v2"
GIT_CREDENTIAL_DIR="/root/.config/aurora"
GIT_CREDENTIAL_FILE="$GIT_CREDENTIAL_DIR/git-credentials"
STANDALONE_UNINSTALL="/usr/local/sbin/aurora-uninstall"
INSTALLER_LIB_DIR="/usr/local/lib/aurora-installer"
DB_OWNERSHIP_MARKER="$INSTALLER_LIB_DIR/db-ownership"
DB_RECOVERY_MARKER="$INSTALLER_LIB_DIR/db-recovery-pending"
MANAGED_MEDIA_PATHS_FILE="$INSTALLER_LIB_DIR/managed-media-paths"
PROXY_REMOVAL_PROVENANCE_MARKER="$INSTALLER_LIB_DIR/proxy-removal-provenance"
SYSTEM_USER_MARKER="$INSTALLER_LIB_DIR/system-user-ownership"
SYSTEM_GROUP_MARKER="$INSTALLER_LIB_DIR/system-group-ownership"
DEPLOY_LOCK_DIR="/run/aurora"
DEPLOY_LOCK_FILE="$DEPLOY_LOCK_DIR/deploy.lock"
DEPLOY_LOCK_FD=""

# ── Output helpers ─────────────────────────────────────────────────
info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$1"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$1"; }
ok()    { printf '\033[1;32m[ OK ]\033[0m  %s\n' "$1"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$1"; exit 1; }
step()  { printf '\n\033[1;35m▸ %s\033[0m\n\n' "$1"; }

# Aurora deliberately returns HTTP 200 for both healthy and degraded states so
# load balancers can distinguish application liveness from dependency
# readiness. Deployment gates must inspect the public JSON body instead of
# treating any 200 response as success.
aurora_health_ready() {
    local url="${1:-http://localhost:8484/api/health}"
    local max_time="${2:-2}"
    curl -fsS --connect-timeout "$max_time" --max-time "$max_time" "$url" 2>/dev/null \
        | python3 -c '
import json
import sys

try:
    health = json.load(sys.stdin)
except (json.JSONDecodeError, TypeError, ValueError):
    raise SystemExit(1)

raise SystemExit(
    0
    if health.get("status") == "ok" and health.get("db_connected") is True
    else 1
)
' 2>/dev/null
}

cleanup_on_interrupt() {
    echo ""
    warn "Installation interrupted. Re-run this script to resume — partial state is safe."
    # 2026-05-20 audit (MED-1) — clean up partial atomic-write
    # tempfiles that we'd otherwise leave behind with secrets
    # (JWT_SECRET + DB password in aurora.env.tmp, PAT in the
    # Aurora-only credential tempfile). Both at mode 600/640 so not
    # world-readable, but still dead state worth removing.
    rm -f /etc/aurora/aurora.env.tmp \
        /var/lib/aurora/deployed-revision.tmp \
        "$GIT_CREDENTIAL_FILE.tmp" 2>/dev/null || true
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

# Best-effort address for opening Aurora from another machine on the same
# reachable network. Prefer the source address selected by the kernel's IPv4
# route, then fall back to the first non-loopback address from hostname.
detect_server_ipv4() {
    local candidate
    if command -v ip >/dev/null 2>&1; then
        candidate="$(
            ip -4 route get 1.1.1.1 2>/dev/null \
                | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }'
        )"
        case "$candidate" in
            ""|127.*|169.254.*) ;;
            *) printf '%s\n' "$candidate"; return 0 ;;
        esac
    fi
    if command -v hostname >/dev/null 2>&1; then
        while IFS= read -r candidate; do
            case "$candidate" in
                ""|127.*|169.254.*|*:* ) continue ;;
                *) printf '%s\n' "$candidate"; return 0 ;;
            esac
        done < <(hostname -I 2>/dev/null | tr ' ' '\n')
    fi
    return 1
}

# Portable numeric compare across major, minor, and patch components.
# version_gte "1.26.3" "1.26.2" → true; "1.26.2" "1.26.3" → false.
version_gte() {
    local -a v1 v2
    local i left right
    IFS=. read -r -a v1 <<< "$1"
    IFS=. read -r -a v2 <<< "$2"
    for i in 0 1 2; do
        left="${v1[$i]:-0}"
        right="${v2[$i]:-0}"
        if [ "$left" -gt "$right" ] 2>/dev/null; then return 0; fi
        if [ "$left" -lt "$right" ] 2>/dev/null; then return 1; fi
    done
    return 0
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

build_frontend_bundle() {
    local out_dir="$1"
    if [ ! -d "$PROJECT_DIR/$SPA_SRC_DIR" ]; then
        warn "SPA source directory $SPA_SRC_DIR not found; reusing committed $SPA_OUTPUT_DIR"
        if [ ! -d "$PROJECT_DIR/$SPA_OUTPUT_DIR" ]; then
            error "No built SPA bundle found at $SPA_OUTPUT_DIR"
        fi
        rm -rf "$out_dir"
        mkdir -p "$(dirname "$out_dir")"
        cp -R "$PROJECT_DIR/$SPA_OUTPUT_DIR" "$out_dir"
        return
    fi

    info "Installing frontend dependencies..."
    if [ -f "$PROJECT_DIR/$SPA_SRC_DIR/package-lock.json" ]; then
        (cd "$PROJECT_DIR/$SPA_SRC_DIR" && npm ci --no-audit --no-fund)
    else
        warn "No package-lock.json — falling back to npm install"
        (cd "$PROJECT_DIR/$SPA_SRC_DIR" && npm install --no-audit --no-fund)
    fi

    info "Building V2 SPA..."
    rm -rf "$out_dir"
    mkdir -p "$(dirname "$out_dir")"
    (cd "$PROJECT_DIR/$SPA_SRC_DIR" && npm run build -- --outDir "$out_dir")
}

stage_static_bundle() {
    local built_v2_dir="$1"
    rm -rf "$INSTALL_DIR/static.new"
    mkdir -p "$INSTALL_DIR/static.new"
    if [ -d "$PROJECT_DIR/static" ]; then
        if ! (
            shopt -s nullglob dotglob
            for entry in "$PROJECT_DIR"/static/*; do
                case "${entry##*/}" in
                    redesign|v2) continue ;;
                esac
                cp -R "$entry" "$INSTALL_DIR/static.new/" || exit 1
            done
        ); then
            error "Failed to stage committed static assets"
        fi
    fi
    # The public /install.sh endpoint serves the same bootstrap that is
    # tracked at the repository root. Copy it into the deployed static tree
    # so aurorapro.app can be the stable, Swizzin-style bootstrap URL without
    # duplicating a second script that could drift.
    [ -f "$PROJECT_DIR/install.sh" ] \
        || error "Missing repository-root install.sh — cannot stage the public installer endpoint."
    install -m 0644 "$PROJECT_DIR/install.sh" \
        "$INSTALL_DIR/static.new/install.sh" \
        || error "Failed to stage the public installer endpoint"
    cp -R "$built_v2_dir" "$INSTALL_DIR/static.new/v2"
}

# ── Package manager detection + install ───────────────────────────
PKG_MGR=""
APT_UPDATED=false
PACMAN_UPDATED=false

detect_pkg_manager() {
    if command -v apt-get &>/dev/null;   then PKG_MGR="apt"
    elif command -v dnf &>/dev/null;     then PKG_MGR="dnf"
    elif command -v yum &>/dev/null;     then PKG_MGR="yum"
    elif command -v pacman &>/dev/null;  then PKG_MGR="pacman"
    elif command -v zypper &>/dev/null;  then PKG_MGR="zypper"
    else PKG_MGR=""
    fi
}

apt_update_once() {
    if ! $APT_UPDATED; then
        DEBIAN_FRONTEND=noninteractive apt-get update -qq
        APT_UPDATED=true
    fi
}

apt_package_available() {
    local package="$1"
    apt_update_once
    LC_ALL=C apt-cache policy "$package" 2>/dev/null \
        | awk '$1 == "Candidate:" && $2 != "(none)" { found=1 } END { exit !found }'
}

# pkg_install <package> — installs without prompting. Errors if no
# supported package manager is on the system.
pkg_install() {
    local pkg="$1"
    case "$PKG_MGR" in
        apt)
            apt_update_once
            DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$pkg"
            ;;
        dnf)    dnf install -y -q "$pkg" ;;
        yum)    yum install -y -q "$pkg" ;;
        pacman)
            # Arch does not support partial upgrades. Refresh package metadata
            # only as part of a one-time full system upgrade, then install
            # subsequent prerequisites from that synchronized package set.
            if ! $PACMAN_UPDATED; then
                pacman -Syu --noconfirm > /dev/null
                PACMAN_UPDATED=true
            fi
            pacman -S --noconfirm --needed "$pkg" > /dev/null
            ;;
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
        apt/xz)                  pkg_install xz-utils ;;
        dnf/xz|yum/xz|pacman/xz|zypper/xz) pkg_install xz ;;
        pacman/python3)          pkg_install python ;;
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
    local arch go_arch expected actual
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64)
            go_arch="amd64"
            expected="$GO_SHA256_AMD64"
            ;;
        aarch64|arm64)
            go_arch="arm64"
            expected="$GO_SHA256_ARM64"
            ;;
        *) error "Unsupported CPU architecture for Go install: $arch" ;;
    esac

    local tarball="go${GO_VERSION}.linux-${go_arch}.tar.gz"
    local url="https://go.dev/dl/${tarball}"
    local tmp
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' RETURN

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

    # Verify against SHA256 values pinned from Go's official release
    # metadata. go.dev does not publish a working <archive>.sha256
    # endpoint, so fetching that path would return HTML.
    info "Verifying SHA256..."
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

# Vite 7 requires Node ^20.19 or >=22.12. Distribution `nodejs` packages on
# otherwise-supported LTS systems can be much older, so install a verified
# official Node LTS tarball instead of accepting a build that will fail later
# during `npm ci`.
node_version_supported() {
    local version="$1" major minor
    version="${version#v}"
    major="${version%%.*}"
    version="${version#*.}"
    minor="${version%%.*}"
    if [ "$major" -eq 20 ] 2>/dev/null && [ "$minor" -ge 19 ] 2>/dev/null; then
        return 0
    fi
    if [ "$major" -eq 22 ] 2>/dev/null && [ "$minor" -ge 12 ] 2>/dev/null; then
        return 0
    fi
    [ "$major" -gt 22 ] 2>/dev/null
}

install_node() {
    local machine node_arch tarball base_url tmp expected actual
    machine="$(uname -m)"
    case "$machine" in
        x86_64|amd64)
            node_arch="x64"
            expected="$NODE_SHA256_X64"
            ;;
        aarch64|arm64)
            node_arch="arm64"
            expected="$NODE_SHA256_ARM64"
            ;;
        *) error "Unsupported CPU architecture for Node install: $machine" ;;
    esac

    ensure_pkg xz
    tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
    base_url="https://nodejs.org/dist/v${NODE_VERSION}"
    tmp="$(mktemp -d)"

    info "Downloading Node.js ${NODE_VERSION} (${node_arch})..."
    curl -fsSL "$base_url/$tarball" -o "$tmp/$tarball"
    if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$tmp/$tarball" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
        actual="$(shasum -a 256 "$tmp/$tarball" | awk '{print $1}')"
    else
        rm -rf "$tmp"
        error "Neither sha256sum nor shasum is available — cannot verify Node.js"
    fi
    [ "$actual" = "$expected" ] || {
        rm -rf "$tmp"
        error "Node.js SHA256 mismatch (expected $expected, got $actual)"
    }

    rm -rf /usr/local/lib/aurora-node
    mkdir -p /usr/local/lib/aurora-node
    tar -C /usr/local/lib/aurora-node --strip-components=1 -xJf "$tmp/$tarball"
    # Keep Aurora's build toolchain private instead of replacing a server
    # administrator's system-wide node/npm commands.
    export PATH="/usr/local/lib/aurora-node/bin:$PATH"
    rm -rf "$tmp"
    hash -r
    ok "Node.js $(node --version) installed (npm $(npm --version))"
}

# Detect the PostgreSQL systemd service name. Across distros: just
# "postgresql" on Debian/Ubuntu/Arch; "postgresql-NN" on RHEL/Fedora.
detect_pg_service() {
    PG_SERVICE=""
    for svc in postgresql postgresql-{19,18,17,16,15,14,13}; do
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
# Debian 12 / PostgreSQL 15 and Ubuntu 22.04 / PostgreSQL 14 do not
# ship matching pgvector binaries in their release repositories.
# On apt systems, prefer a distro/PGDG package when apt exposes one;
# otherwise compile a checksum-pinned upstream release against the
# exact running server's PGXS headers.
#
# Idempotent: bails early when the extension is already visible and
# passes a transactional load test.
install_pgvector_from_source() {
    local pg_major="$1"
    local dev_package="postgresql-server-dev-${pg_major}"
    local pg_config="/usr/lib/postgresql/${pg_major}/bin/pg_config"
    local archive_url="https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz"
    local tmp archive source_dir actual configured_major

    info "No trusted apt pgvector package candidate found; building pgvector v${PGVECTOR_VERSION} from source..."
    info "Installing PostgreSQL ${pg_major} development headers..."
    if ! apt_package_available "$dev_package"; then
        error "$dev_package is unavailable. On Ubuntu, enable the official universe component; otherwise enable the repository that supplied PostgreSQL ${pg_major}, then re-run."
    fi
    pkg_install "$dev_package"
    ensure_pkg build-essential

    if [ ! -x "$pg_config" ]; then
        error "$dev_package installed but $pg_config is missing; refusing to build pgvector against a different PostgreSQL version."
    fi
    configured_major="$("$pg_config" --version | awk '{print $2}' | cut -d. -f1)"
    if [ "$configured_major" != "$pg_major" ]; then
        error "$pg_config reports PostgreSQL ${configured_major}, expected ${pg_major}; refusing an ABI-mismatched pgvector build."
    fi
    if ! command -v sha256sum &>/dev/null; then
        error "sha256sum is required to verify the pgvector source archive."
    fi

    tmp="$(mktemp -d)"
    archive="$tmp/pgvector-v${PGVECTOR_VERSION}.tar.gz"
    source_dir="$tmp/source"
    mkdir -p "$source_dir"

    info "Downloading pgvector v${PGVECTOR_VERSION} from the official upstream tag..."
    if ! curl --proto '=https' --tlsv1.2 -fsSL "$archive_url" -o "$archive"; then
        rm -rf "$tmp"
        error "Failed to download pgvector from $archive_url"
    fi
    actual="$(sha256sum "$archive" | awk '{print $1}')"
    if [ "$actual" != "$PGVECTOR_SHA256" ]; then
        rm -rf "$tmp"
        error "pgvector source SHA256 mismatch (expected $PGVECTOR_SHA256, got $actual)."
    fi
    ok "pgvector source SHA256 verified"

    if ! tar -C "$source_dir" --strip-components=1 -xzf "$archive"; then
        rm -rf "$tmp"
        error "Failed to extract the verified pgvector source archive."
    fi
    if [ ! -f "$source_dir/Makefile" ] || [ ! -f "$source_dir/vector.control" ]; then
        rm -rf "$tmp"
        error "Verified pgvector archive is missing expected build files."
    fi

    info "Compiling pgvector v${PGVECTOR_VERSION} for PostgreSQL ${pg_major}..."
    if ! make -C "$source_dir" PG_CONFIG="$pg_config"; then
        rm -rf "$tmp"
        error "pgvector compilation failed for PostgreSQL ${pg_major}."
    fi
    if ! make -C "$source_dir" PG_CONFIG="$pg_config" install; then
        rm -rf "$tmp"
        error "pgvector installation failed for PostgreSQL ${pg_major}."
    fi
    rm -rf "$tmp"
    ok "pgvector v${PGVECTOR_VERSION} installed from verified source"
}

pgvector_load_test() {
    sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres -c \
        "BEGIN; CREATE EXTENSION IF NOT EXISTS vector; SELECT '[1,2,3]'::vector; ROLLBACK;" \
        &>/dev/null
}

install_pgvector() {
    if ! pg_isready &>/dev/null; then
        error "pgvector installation requires a running PostgreSQL server."
    fi

    # Already available system-wide? Skip the package install.
    local has_vector
    has_vector="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_available_extensions WHERE name='vector'" 2>/dev/null || echo "")"
    if [ "$has_vector" = "1" ]; then
        if pgvector_load_test; then
            ok "pgvector already installed (extension available and load-tested)"
            return
        fi
        warn "pgvector files are visible but failed a load test; attempting a matching reinstall."
    fi

    # Detect PG major version. server_version_num is like "160001"
    # for PG 16.1 — divide by 10000 to get the major.
    local pg_major
    pg_major="$(sudo -u postgres psql -tAc 'SHOW server_version_num' 2>/dev/null | awk '{print int($1/10000)}')"
    if [ -z "$pg_major" ] || [ "$pg_major" = "0" ]; then
        error "Could not detect the running PostgreSQL major version; refusing to continue without required pgvector support."
    fi
    info "Installing pgvector for Postgres $pg_major..."

    case "$PKG_MGR" in
        apt)
            # Prefer the matching distro or PGDG package. Stable
            # Debian 12 and Ubuntu 22.04 do not provide one, so use
            # the verified source fallback only when apt has no
            # installable candidate. A real apt install failure
            # remains fatal instead of being mistaken for absence.
            local apt_pgvector_package="postgresql-${pg_major}-pgvector"
            if apt_package_available "$apt_pgvector_package"; then
                pkg_install "$apt_pgvector_package"
            else
                install_pgvector_from_source "$pg_major"
            fi
            ;;
        dnf|yum)
            # RHEL family: pgvector_NN, from the PostgreSQL community
            # repository (postgresql.org/yum). Operators with only
            # the base AppStream repo may need to enable PGDG first.
            if ! pkg_install "pgvector_${pg_major}" 2>&1; then
                error "pgvector_${pg_major} is unavailable. Enable PGDG and re-run: https://www.postgresql.org/download/linux/redhat/"
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
                error "pgvector is unavailable via zypper. Enable the OBS server:database repository and re-run."
            fi
            ;;
        *)
            error "No pgvector installation method is defined for package manager '$PKG_MGR'."
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
        error "pgvector installation completed but PostgreSQL cannot see the extension. Check 'pg_config --pkglibdir' for vector.so."
    fi

    # `pg_available_extensions` only proves the control file exists.
    # Exercise the vector type inside a transaction so an ABI mismatch
    # fails now without permanently adding or dropping anything in
    # the postgres maintenance database.
    if pgvector_load_test; then
        ok "pgvector available and load-tested"
    else
        error "pgvector is present but failed to load for PostgreSQL ${pg_major}. Inspect: sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres -c \"CREATE EXTENSION vector;\""
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

# Recursive ownership, mode, and staging operations below assume Aurora's
# managed directories are real directories, never redirects into unrelated
# operator data.
for managed_dir in \
    "$INSTALL_DIR" "$CONFIG_DIR" "$CACHE_DIR" "$LOG_DIR" \
    /var/lib/aurora /var/lib/aurora/source \
    "$INSTALLER_LIB_DIR" /usr/local/lib/aurora-node; do
    [ ! -L "$managed_dir" ] \
        || error "$managed_dir is a symlink; move it aside before installing Aurora."
done

# Serialize direct installer runs with the updater and redeploy helper. The
# public bootstrap already holds this lock and marks it in the environment so
# the child installer does not deadlock on its parent's inherited lock.
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

if [ "${AURORA_DEPLOY_LOCK_HELD:-0}" != "1" ]; then
    if ! command -v flock >/dev/null 2>&1; then
        detect_pkg_manager
        [ -n "$PKG_MGR" ] \
            || error "flock is required. Install util-linux, then re-run the installer."
        info "Installing util-linux for safe installer/update coordination..."
        pkg_install util-linux
    fi
    command -v flock >/dev/null 2>&1 \
        || error "flock installation failed. Install util-linux, then re-run the installer."
    prepare_deploy_lock_file
    exec {DEPLOY_LOCK_FD}<>"$DEPLOY_LOCK_FILE"
    flock -n "$DEPLOY_LOCK_FD" \
        || error "Aurora is currently installing, updating, or redeploying. Wait for it to finish."
    export AURORA_DEPLOY_LOCK_HELD=1
fi

# Capture installer-only credentials and integration settings into new,
# non-exported shell variables, then scrub the inherited environment before
# any fetched npm lifecycle scripts or Go build subprocesses run. ARR URLs are
# included because they may embed HTTP basic-auth credentials.
AURORA_GIT_TOKEN_VALUE="${AURORA_GIT_TOKEN:-}"
TMDB_API_KEY_VALUE="${TMDB_API_KEY:-}"
AURORA_DOMAIN_VALUE="${AURORA_DOMAIN:-}"
AURORA_CERTBOT_EMAIL_VALUE="${AURORA_CERTBOT_EMAIL:-}"
AURORA_MEDIA_DIR_VALUE="${AURORA_MEDIA_DIR:-}"
AURORA_TVDB_API_KEY_VALUE="${AURORA_TVDB_API_KEY:-}"
AURORA_TVDB_PIN_VALUE="${AURORA_TVDB_PIN:-}"
AURORA_RADARR_URL_VALUE="${AURORA_RADARR_URL:-}"
AURORA_RADARR_API_KEY_VALUE="${AURORA_RADARR_API_KEY:-}"
AURORA_RADARR_4K_URL_VALUE="${AURORA_RADARR_4K_URL:-}"
AURORA_RADARR_4K_API_KEY_VALUE="${AURORA_RADARR_4K_API_KEY:-}"
AURORA_SONARR_URL_VALUE="${AURORA_SONARR_URL:-}"
AURORA_SONARR_API_KEY_VALUE="${AURORA_SONARR_API_KEY:-}"
AURORA_SONARR_4K_URL_VALUE="${AURORA_SONARR_4K_URL:-}"
AURORA_SONARR_4K_API_KEY_VALUE="${AURORA_SONARR_4K_API_KEY:-}"
AURORA_ADOPT_EXISTING_IDENTITIES_VALUE="${AURORA_ADOPT_EXISTING_IDENTITIES:-false}"
case "$AURORA_GIT_TOKEN_VALUE" in
    *$'\n'*|*$'\r'*) error "AURORA_GIT_TOKEN contains an invalid newline." ;;
esac
case "$AURORA_DOMAIN_VALUE" in
    *$'\n'*|*$'\r'*) error "AURORA_DOMAIN contains an invalid newline." ;;
esac
case "$AURORA_CERTBOT_EMAIL_VALUE" in
    *$'\n'*|*$'\r'*) error "AURORA_CERTBOT_EMAIL contains an invalid newline." ;;
esac
unset AURORA_GIT_TOKEN TMDB_API_KEY AURORA_DOMAIN AURORA_CERTBOT_EMAIL \
    AURORA_MEDIA_DIR AURORA_TVDB_API_KEY AURORA_TVDB_PIN \
    AURORA_RADARR_URL AURORA_RADARR_API_KEY \
    AURORA_RADARR_4K_URL AURORA_RADARR_4K_API_KEY \
    AURORA_SONARR_URL AURORA_SONARR_API_KEY \
    AURORA_SONARR_4K_URL AURORA_SONARR_4K_API_KEY \
    AURORA_ADOPT_EXISTING_IDENTITIES \
    GIT_ASKPASS GIT_TERMINAL_PROMPT

# Quiesce scheduled/manual update triggers while this installer owns the
# shared deploy lock. Existing units are re-enabled only after /api/health
# succeeds, so a failed repair cannot immediately launch another root build.
systemctl stop aurora-update.timer aurora-update.path 2>/dev/null || true

# Interactive TTY is only strictly required when TMDB_API_KEY isn't
# pre-supplied via env. Validate later, not here.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ ! -f "$PROJECT_DIR/cmd/aurora/main.go" ]; then
    error "Aurora source not found at $PROJECT_DIR. Run this script from the project's scripts/ folder."
fi
if [ ! -f "$PROJECT_DIR/scripts/lib/env-file.sh" ]; then
    error "Missing scripts/lib/env-file.sh — repository checkout is incomplete."
fi
if [ ! -f "$PROJECT_DIR/scripts/lib/install-state.sh" ]; then
    error "Missing scripts/lib/install-state.sh — repository checkout is incomplete."
fi
if [ ! -f "$PROJECT_DIR/scripts/uninstall.sh" ]; then
    error "Missing scripts/uninstall.sh — repository checkout is incomplete."
fi
if [ ! -f "$PROJECT_DIR/install.sh" ]; then
    error "Missing repository-root install.sh — repository checkout is incomplete."
fi
# shellcheck source=lib/env-file.sh
# shellcheck disable=SC1091
. "$PROJECT_DIR/scripts/lib/env-file.sh"
# shellcheck source=lib/install-state.sh
# shellcheck disable=SC1091
. "$PROJECT_DIR/scripts/lib/install-state.sh"

case "$AURORA_ADOPT_EXISTING_IDENTITIES_VALUE" in
    true|false) ;;
    *) error "AURORA_ADOPT_EXISTING_IDENTITIES must be true or false." ;;
esac

# Ownership/provenance state and recovery tooling must survive both a failed
# install and safe removal of the managed source.
install -d -m 0700 -o root -g root "$INSTALLER_LIB_DIR"
install -d -m 0700 -o root -g root "$CONFIG_DIR"
install -m 0600 -o root -g root \
    "$PROJECT_DIR/scripts/lib/env-file.sh" \
    "$PROJECT_DIR/scripts/lib/install-state.sh" \
    "$INSTALLER_LIB_DIR/"
install -m 0700 -o root -g root \
    "$PROJECT_DIR/scripts/uninstall.sh" "$STANDALONE_UNINSTALL"
ok "Root-only recovery uninstaller staged at $STANDALONE_UNINSTALL"

EARLY_DATABASE_URL="$(
    aurora_env_get_unquoted "$CONFIG_DIR/aurora.env" DATABASE_URL 2>/dev/null || true
)"
EXTERNAL_DB_CONFIGURED=false
if [ -n "$EARLY_DATABASE_URL" ] \
    && ! aurora_database_url_is_local_database "$EARLY_DATABASE_URL" "aurora"; then
    EXTERNAL_DB_CONFIGURED=true
fi
LEGACY_AURORA_INSTALL=false
if [ -f /etc/systemd/system/aurora.service ] \
    && [ -f "$CONFIG_DIR/aurora.env" ] \
    && { [ -x "$INSTALL_BIN" ] || [ -d "$INSTALL_DIR" ]; }; then
    LEGACY_AURORA_INSTALL=true
fi
ALLOW_IDENTITY_ADOPTION=false
if [ "$AURORA_ADOPT_EXISTING_IDENTITIES_VALUE" = "true" ] \
    || $LEGACY_AURORA_INSTALL; then
    ALLOW_IDENTITY_ADOPTION=true
fi

echo ""
echo "  ============================================================"
echo "   Aurora Media Server — One-and-Done Installer"
echo "  ============================================================"
echo ""

detect_pkg_manager
if [ -z "$PKG_MGR" ]; then
    error "No supported package manager (apt/dnf/yum/pacman/zypper) — Aurora only supports Linux distributions with one of these."
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
for tool in curl tar git python3 sudo; do
    if ! command -v "$tool" &>/dev/null; then
        info "Installing $tool..."
        ensure_pkg "$tool"
    fi
done
# The fsync helpers use Python, so durability starts immediately after the
# minimal-image prerequisite loop has made it available and still before any
# Aurora identity or PostgreSQL mutation.
for durable_file in \
    "$INSTALLER_LIB_DIR/env-file.sh" \
    "$INSTALLER_LIB_DIR/install-state.sh" \
    "$STANDALONE_UNINSTALL"; do
    aurora_fsync_file_and_parent "$durable_file" \
        || error "Could not durably stage recovery helper $durable_file."
done
# A file fsync plus its immediate directory does not commit a newly-created
# directory's own entry. Sync the parent chain now so a power loss cannot erase
# the entire installer-state/config directory after recovery DDL has begun.
for durable_directory in \
    "$INSTALLER_LIB_DIR" /usr/local/lib /usr/local /usr \
    "$CONFIG_DIR" /etc; do
    aurora_fsync_directory "$durable_directory" \
        || error "Could not durably prepare recovery directory $durable_directory."
done
# Reuse Aurora's private Node toolchain on repair/update runs without placing
# symlinks in /usr/local/bin.
if [ -x /usr/local/lib/aurora-node/bin/node ]; then
    export PATH="/usr/local/lib/aurora-node/bin:$PATH"
    for tool in node npm npx corepack; do
        link="/usr/local/bin/$tool"
        if [ -L "$link" ] \
            && [[ "$(readlink "$link")" == /usr/local/lib/aurora-node/* ]]; then
            rm -f "$link"
        fi
    done
fi
if command -v node >/dev/null 2>&1 \
    && command -v npm >/dev/null 2>&1 \
    && node_version_supported "$(node --version 2>/dev/null)"; then
    ok "Node.js $(node --version) already installed (npm $(npm --version))"
else
    if command -v node >/dev/null 2>&1; then
        info "Node.js $(node --version 2>/dev/null || echo unknown) does not satisfy Vite's requirement — upgrading"
    else
        info "Node.js is not installed — downloading the supported LTS build"
    fi
    install_node
fi

# setfacl — used by the media-dir setup below to grant aurora user
# read access without resorting to chmod o+rX (which exposes media
# to every other system user). Bundled on most distros but not
# always on minimal images.
if ! command -v setfacl &>/dev/null; then
    info "Installing acl (setfacl)..."
    pkg_install acl 2>/dev/null || warn "Could not install acl package; media-dir setup will fall back to chmod o+rX"
fi
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

# PostgreSQL — Aurora's database. Do not provision or administer an unrelated
# local cluster when retained configuration points to an external/provider DB.
if $EXTERNAL_DB_CONFIGURED; then
    PG_SERVICE="postgresql"
    info "External DATABASE_URL detected; skipping local PostgreSQL provisioning."
    warn "Ensure the provider database already has pg_trgm and pgvector enabled."
else
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

# Create/adopt Aurora's OS identities with durable UID/GID provenance.
write_identity_marker() {
    local file="$1" numeric_id="$2"
    printf '%s\n' "$numeric_id" > "$file.tmp"
    chmod 0600 "$file.tmp"
    chown root:root "$file.tmp"
    mv -f "$file.tmp" "$file"
}

group_exists=false
getent group "$AURORA_GROUP" >/dev/null 2>&1 && group_exists=true
if $group_exists; then
    current_gid="$(getent group "$AURORA_GROUP" | cut -d: -f3)"
    recorded_gid="$(sed -n '1p' "$SYSTEM_GROUP_MARKER" 2>/dev/null || true)"
    if [ "$recorded_gid" != "$current_gid" ]; then
        if ! $ALLOW_IDENTITY_ADOPTION; then
            error "System group '$AURORA_GROUP' already exists without matching Aurora ownership.
Refusing to adopt/delete it implicitly. Verify it is dedicated to Aurora, then rerun with AURORA_ADOPT_EXISTING_IDENTITIES=true."
        fi
        write_identity_marker "$SYSTEM_GROUP_MARKER" "$current_gid"
        if $LEGACY_AURORA_INSTALL; then
            warn "Adopted legacy Aurora group '$AURORA_GROUP' from verified unit+env+binary artifacts (gid $current_gid)"
        else
            warn "Explicitly adopted existing group '$AURORA_GROUP' (gid $current_gid)"
        fi
    fi
else
    info "Creating system group '$AURORA_GROUP'..."
    groupadd --system "$AURORA_GROUP"
    current_gid="$(getent group "$AURORA_GROUP" | cut -d: -f3)"
    write_identity_marker "$SYSTEM_GROUP_MARKER" "$current_gid"
    ok "System group created"
fi

if id "$AURORA_USER" &>/dev/null; then
    if [ "$(id -gn "$AURORA_USER")" != "$AURORA_GROUP" ]; then
        error "Existing user '$AURORA_USER' does not use group '$AURORA_GROUP'; refusing unsafe adoption."
    fi
    current_uid="$(id -u "$AURORA_USER")"
    recorded_uid="$(sed -n '1p' "$SYSTEM_USER_MARKER" 2>/dev/null || true)"
    if [ "$recorded_uid" != "$current_uid" ]; then
        if ! $ALLOW_IDENTITY_ADOPTION; then
            error "System user '$AURORA_USER' already exists without matching Aurora ownership.
Refusing to adopt/delete it implicitly. Verify it is dedicated to Aurora, then rerun with AURORA_ADOPT_EXISTING_IDENTITIES=true."
        fi
        write_identity_marker "$SYSTEM_USER_MARKER" "$current_uid"
        if $LEGACY_AURORA_INSTALL; then
            warn "Adopted legacy Aurora user '$AURORA_USER' from verified unit+env+binary artifacts (uid $current_uid)"
        else
            warn "Explicitly adopted existing user '$AURORA_USER' (uid $current_uid)"
        fi
    else
        ok "System user '$AURORA_USER' ownership verified"
    fi
else
    info "Creating system user '$AURORA_USER'..."
    useradd --system --gid "$AURORA_GROUP" --shell /usr/sbin/nologin \
        --home-dir "$INSTALL_DIR" --no-create-home "$AURORA_USER"
    current_uid="$(id -u "$AURORA_USER")"
    write_identity_marker "$SYSTEM_USER_MARKER" "$current_uid"
    ok "System user created"
fi

# ══════════════════════════════════════════════════════════════════
# STEP 2: Database — auto-create or reuse
# ══════════════════════════════════════════════════════════════════
step "Step 2/5: Configuring the Aurora database"

DB_USER="aurora"
DB_NAME="aurora"
DB_PASSWORD=""
DB_TARGET_LOCAL=false
DB_OWNERSHIP_VALID=false
DB_OWNERSHIP_MARKER_NEEDS_REFRESH=false

current_db_cluster_data_dir() {
    sudo -u postgres psql -X -qAt -c 'SHOW data_directory' 2>/dev/null
}

current_db_cluster_port() {
    sudo -u postgres psql -X -qAt -c 'SHOW port' 2>/dev/null
}

current_db_cluster_system_identifier() {
    sudo -u postgres psql -X -qAt \
        -c 'SELECT system_identifier::text FROM pg_control_system()' \
        2>/dev/null
}

current_db_object_oid() {
    sudo -u postgres psql -X -qAt \
        -c "SELECT oid::text FROM pg_database WHERE datname='${DB_NAME}'" \
        2>/dev/null
}

current_db_role_oid() {
    sudo -u postgres psql -X -qAt \
        -c "SELECT oid::text FROM pg_roles WHERE rolname='${DB_USER}'" \
        2>/dev/null
}

db_ownership_marker_status() {
    local data_dir port system_identifier database_oid role_oid
    data_dir="$(current_db_cluster_data_dir || true)"
    port="$(current_db_cluster_port || true)"
    system_identifier="$(current_db_cluster_system_identifier || true)"
    database_oid="$(current_db_object_oid)" || return 1
    role_oid="$(current_db_role_oid)" || return 1
    aurora_db_ownership_marker_status \
        "$DB_OWNERSHIP_MARKER" "$DB_NAME" "$DB_USER" \
        "$data_dir" "$port" "$system_identifier" "$database_oid" "$role_oid"
}

write_db_ownership_marker() {
    local expected_database_oid="${1:-}" expected_role_oid="${2:-}"
    local expected_data_dir="${3:-}" expected_port="${4:-}"
    local expected_system_identifier="${5:-}"
    local data_dir port system_identifier database_oid role_oid database_owner_oid
    local final_data_dir final_port final_system_identifier
    local final_database_oid final_role_oid final_database_owner_oid
    [ ! -L "$DB_OWNERSHIP_MARKER" ] \
        || error "$DB_OWNERSHIP_MARKER is a symlink; refusing unsafe ownership write."
    data_dir="$(current_db_cluster_data_dir || true)"
    port="$(current_db_cluster_port || true)"
    system_identifier="$(current_db_cluster_system_identifier || true)"
    database_oid="$(current_db_object_oid || true)"
    role_oid="$(current_db_role_oid || true)"
    database_owner_oid="$(db_database_owner_oid "$DB_NAME" || true)"
    [ -n "$data_dir" ] \
        && [ -n "$port" ] \
        && [[ "$system_identifier" =~ ^[0-9]+$ ]] \
        && [[ "$database_oid" =~ ^[0-9]+$ ]] \
        && [[ "$role_oid" =~ ^[0-9]+$ ]] \
        && [ "$database_owner_oid" = "$role_oid" ] \
        || error "Could not fingerprint the local PostgreSQL cluster/database/role for ownership."
    [ -z "$expected_database_oid" ] \
        || [ "$database_oid" = "$expected_database_oid" ] \
        || error "PostgreSQL database identity changed before ownership-marker commit."
    [ -z "$expected_role_oid" ] \
        || [ "$role_oid" = "$expected_role_oid" ] \
        || error "PostgreSQL role identity changed before ownership-marker commit."
    [ -z "$expected_data_dir" ] \
        || [ "$data_dir" = "$expected_data_dir" ] \
        || error "PostgreSQL data directory changed before ownership-marker commit."
    [ -z "$expected_port" ] \
        || [ "$port" = "$expected_port" ] \
        || error "PostgreSQL port changed before ownership-marker commit."
    [ -z "$expected_system_identifier" ] \
        || [ "$system_identifier" = "$expected_system_identifier" ] \
        || error "PostgreSQL cluster changed before ownership-marker commit."
    {
        printf '%s\n' "$DB_NAME"
        printf '%s\n' "$DB_USER"
        printf '%s\n' "$data_dir"
        printf '%s\n' "$port"
        printf '%s\n' "$system_identifier"
        printf '%s\n' "$database_oid"
        printf '%s\n' "$role_oid"
    } > "$DB_OWNERSHIP_MARKER.tmp"
    chmod 0600 "$DB_OWNERSHIP_MARKER.tmp"
    chown root:root "$DB_OWNERSHIP_MARKER.tmp"
    final_data_dir="$(current_db_cluster_data_dir || true)"
    final_port="$(current_db_cluster_port || true)"
    final_system_identifier="$(current_db_cluster_system_identifier || true)"
    final_database_oid="$(current_db_object_oid || true)"
    final_role_oid="$(current_db_role_oid || true)"
    final_database_owner_oid="$(db_database_owner_oid "$DB_NAME" || true)"
    if [ "$final_data_dir" != "$data_dir" ] \
        || [ "$final_port" != "$port" ] \
        || [ "$final_system_identifier" != "$system_identifier" ] \
        || [ "$final_database_oid" != "$database_oid" ] \
        || [ "$final_role_oid" != "$role_oid" ] \
        || [ "$final_database_owner_oid" != "$role_oid" ]; then
        rm -f "$DB_OWNERSHIP_MARKER.tmp"
        error "PostgreSQL object identity changed during ownership-marker commit."
    fi
    mv -f "$DB_OWNERSHIP_MARKER.tmp" "$DB_OWNERSHIP_MARKER"
    aurora_fsync_file_and_parent "$DB_OWNERSHIP_MARKER" \
        || error "Could not durably commit PostgreSQL ownership state."
}

db_role_comment() {
    local role="$1"
    sudo -u postgres psql -X -qAt \
        -c "SELECT COALESCE(shobj_description(oid, 'pg_authid'), '') FROM pg_roles WHERE rolname='${role}'" \
        2>/dev/null
}

db_database_owner_oid() {
    local database="$1"
    sudo -u postgres psql -X -qAt \
        -c "SELECT datdba::text FROM pg_database WHERE datname='${database}'" \
        2>/dev/null
}

db_database_oid() {
    local database="$1"
    sudo -u postgres psql -X -qAt \
        -c "SELECT oid::text FROM pg_database WHERE datname='${database}'" \
        2>/dev/null
}

db_database_comment() {
    local database="$1"
    sudo -u postgres psql -X -qAt \
        -c "SELECT COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname='${database}'" \
        2>/dev/null
}

# Prefix a psql script with a secret variable over stdin. Shell functions do
# not create a child argv for their parameters, so the generated password never
# appears in ps(1) or /proc/<pid>/cmdline; only nonsecret psql options do.
psql_with_stdin_password() {
    local password="$1"
    shift
    [[ "$password" =~ ^[A-Za-z0-9]{32}$ ]] || return 1
    {
        printf '%s %s\n' '\set recovery_password' "$password"
        cat
    } | sudo -u postgres psql "$@"
}

load_db_recovery_marker() {
    local owner group mode line_count expected_database_url
    [ -f "$DB_RECOVERY_MARKER" ] && [ ! -L "$DB_RECOVERY_MARKER" ] \
        || error "Invalid PostgreSQL recovery marker at $DB_RECOVERY_MARKER."
    owner="$(stat -c '%u' -- "$DB_RECOVERY_MARKER")"
    group="$(stat -c '%g' -- "$DB_RECOVERY_MARKER")"
    mode="$(stat -c '%a' -- "$DB_RECOVERY_MARKER")"
    [ "$owner" = "0" ] && [ "$group" = "0" ] && [ "$mode" = "600" ] \
        || error "$DB_RECOVERY_MARKER must be root:root mode 0600."
    line_count="$(awk 'END { print NR }' "$DB_RECOVERY_MARKER")"
    [ "$line_count" = "13" ] \
        || error "$DB_RECOVERY_MARKER has an invalid recovery-state format."

    RECOVERY_VERSION="$(sed -n '1p' "$DB_RECOVERY_MARKER")"
    RECOVERY_NONCE="$(sed -n '2p' "$DB_RECOVERY_MARKER")"
    RECOVERY_DATA_DIR="$(sed -n '3p' "$DB_RECOVERY_MARKER")"
    RECOVERY_PORT="$(sed -n '4p' "$DB_RECOVERY_MARKER")"
    RECOVERY_SYSTEM_IDENTIFIER="$(sed -n '5p' "$DB_RECOVERY_MARKER")"
    RECOVERY_ROLE_ACTION="$(sed -n '6p' "$DB_RECOVERY_MARKER")"
    RECOVERY_SOURCE_ROLE_OID="$(sed -n '7p' "$DB_RECOVERY_MARKER")"
    RECOVERY_TEMP_DATABASE="$(sed -n '8p' "$DB_RECOVERY_MARKER")"
    RECOVERY_PASSWORD="$(sed -n '9p' "$DB_RECOVERY_MARKER")"
    RECOVERY_DB_URL="$(sed -n '10p' "$DB_RECOVERY_MARKER")"
    RECOVERY_ROLE_OID="$(sed -n '11p' "$DB_RECOVERY_MARKER")"
    RECOVERY_DATABASE_OID="$(sed -n '12p' "$DB_RECOVERY_MARKER")"
    RECOVERY_PHASE="$(sed -n '13p' "$DB_RECOVERY_MARKER")"

    [ "$RECOVERY_VERSION" = "2" ] \
        || error "Unsupported PostgreSQL recovery marker version."
    [[ "$RECOVERY_NONCE" =~ ^[A-Za-z0-9]{20}$ ]] \
        || error "Invalid PostgreSQL recovery nonce."
    [ "$RECOVERY_TEMP_DATABASE" = "aurora_recovery_${RECOVERY_NONCE}" ] \
        || error "Invalid PostgreSQL recovery database name."
    [ -n "$RECOVERY_DATA_DIR" ] \
        && [[ "$RECOVERY_PORT" =~ ^[0-9]+$ ]] \
        && [[ "$RECOVERY_SYSTEM_IDENTIFIER" =~ ^[0-9]+$ ]] \
        || error "Invalid PostgreSQL recovery cluster identity."
    case "$RECOVERY_ROLE_ACTION" in
        retain)
            [[ "$RECOVERY_SOURCE_ROLE_OID" =~ ^[0-9]+$ ]] \
                && [ "$RECOVERY_PASSWORD" = "-" ] \
                || error "Invalid retained-role PostgreSQL recovery state."
            ;;
        rotate)
            [[ "$RECOVERY_SOURCE_ROLE_OID" =~ ^[0-9]+$ ]] \
                && [[ "$RECOVERY_PASSWORD" =~ ^[A-Za-z0-9]{32}$ ]] \
                || error "Invalid rotated-role PostgreSQL recovery state."
            ;;
        create)
            [ "$RECOVERY_SOURCE_ROLE_OID" = "-" ] \
                && [[ "$RECOVERY_PASSWORD" =~ ^[A-Za-z0-9]{32}$ ]] \
                || error "Invalid recreated-role PostgreSQL recovery state."
            ;;
        *) error "Invalid PostgreSQL recovery role state." ;;
    esac
    case "$RECOVERY_PHASE" in
        intent)
            [ "$RECOVERY_ROLE_ACTION" = "create" ] \
                && [ "$RECOVERY_ROLE_OID" = "-" ] \
                && [ "$RECOVERY_DATABASE_OID" = "-" ] \
                || error "Invalid PostgreSQL recovery intent checkpoint."
            ;;
        role-ready)
            [[ "$RECOVERY_ROLE_OID" =~ ^[0-9]+$ ]] \
                && [ "$RECOVERY_DATABASE_OID" = "-" ] \
                || error "Invalid PostgreSQL role-ready recovery checkpoint."
            ;;
        temp-ready|promoted)
            [[ "$RECOVERY_ROLE_OID" =~ ^[0-9]+$ ]] \
                && [[ "$RECOVERY_DATABASE_OID" =~ ^[0-9]+$ ]] \
                || error "Invalid PostgreSQL database recovery checkpoint."
            ;;
        *) error "Invalid PostgreSQL recovery phase." ;;
    esac
    if [ "$RECOVERY_ROLE_ACTION" = "retain" ] \
        || [ "$RECOVERY_ROLE_ACTION" = "rotate" ]; then
        [ "$RECOVERY_ROLE_OID" = "$RECOVERY_SOURCE_ROLE_OID" ] \
            && [ "$RECOVERY_PHASE" != "intent" ] \
            || error "Retained PostgreSQL role identity changed in recovery state."
    fi
    aurora_database_url_is_local_database "$RECOVERY_DB_URL" "$DB_NAME" \
        || error "PostgreSQL recovery DATABASE_URL is not Aurora's managed local DSN."
    if [ "$RECOVERY_ROLE_ACTION" = "rotate" ] \
        || [ "$RECOVERY_ROLE_ACTION" = "create" ]; then
        expected_database_url="postgres://${DB_USER}:$(urlencode_password "$RECOVERY_PASSWORD")@localhost:5432/${DB_NAME}?sslmode=disable"
        [ "$RECOVERY_DB_URL" = "$expected_database_url" ] \
            || error "PostgreSQL recovery password and DATABASE_URL do not match."
    fi
}

persist_db_recovery_marker() {
    local marker_tmp="${DB_RECOVERY_MARKER}.tmp.$$"
    [ -d "$INSTALLER_LIB_DIR" ] && [ ! -L "$INSTALLER_LIB_DIR" ] \
        || error "Invalid PostgreSQL recovery-state directory."
    [ ! -L "$DB_RECOVERY_MARKER" ] \
        || error "$DB_RECOVERY_MARKER is a symlink; refusing unsafe recovery-state write."
    [ ! -e "$marker_tmp" ] && [ ! -L "$marker_tmp" ] \
        || error "Refusing to replace an unexpected PostgreSQL recovery temporary file."
    if ! {
        umask 077
        {
            printf '%s\n' "$RECOVERY_VERSION"
            printf '%s\n' "$RECOVERY_NONCE"
            printf '%s\n' "$RECOVERY_DATA_DIR"
            printf '%s\n' "$RECOVERY_PORT"
            printf '%s\n' "$RECOVERY_SYSTEM_IDENTIFIER"
            printf '%s\n' "$RECOVERY_ROLE_ACTION"
            printf '%s\n' "$RECOVERY_SOURCE_ROLE_OID"
            printf '%s\n' "$RECOVERY_TEMP_DATABASE"
            printf '%s\n' "$RECOVERY_PASSWORD"
            printf '%s\n' "$RECOVERY_DB_URL"
            printf '%s\n' "$RECOVERY_ROLE_OID"
            printf '%s\n' "$RECOVERY_DATABASE_OID"
            printf '%s\n' "$RECOVERY_PHASE"
        } > "$marker_tmp"
    }; then
        rm -f "$marker_tmp"
        error "Could not stage PostgreSQL recovery state."
    fi
    chmod 0600 "$marker_tmp"
    chown root:root "$marker_tmp"
    mv -f "$marker_tmp" "$DB_RECOVERY_MARKER"
    aurora_fsync_file_and_parent "$DB_RECOVERY_MARKER" \
        || error "Could not durably commit PostgreSQL recovery state."
}

update_db_recovery_marker() {
    local role_oid="$1" database_oid="$2" phase="$3"
    load_db_recovery_marker
    case "${RECOVERY_PHASE}:${phase}" in
        intent:role-ready|role-ready:temp-ready|temp-ready:promoted) ;;
        *)
            error "Refusing a non-monotonic PostgreSQL recovery checkpoint transition."
            ;;
    esac
    case "$phase" in
        role-ready)
            [[ "$role_oid" =~ ^[0-9]+$ ]] \
                && [ "$database_oid" = "-" ] \
                || error "Refusing an invalid PostgreSQL role checkpoint."
            ;;
        temp-ready|promoted)
            [[ "$role_oid" =~ ^[0-9]+$ ]] \
                && [[ "$database_oid" =~ ^[0-9]+$ ]] \
                || error "Refusing an invalid PostgreSQL database checkpoint."
            ;;
        *) error "Refusing an unknown PostgreSQL recovery checkpoint." ;;
    esac
    if [ "$RECOVERY_ROLE_ACTION" = "retain" ] \
        || [ "$RECOVERY_ROLE_ACTION" = "rotate" ]; then
        [ "$role_oid" = "$RECOVERY_SOURCE_ROLE_OID" ] \
            || error "Refusing to checkpoint a replacement PostgreSQL role."
    fi
    RECOVERY_ROLE_OID="$role_oid"
    RECOVERY_DATABASE_OID="$database_oid"
    RECOVERY_PHASE="$phase"
    persist_db_recovery_marker
    load_db_recovery_marker
}

write_db_recovery_marker() {
    local role_action="$1" source_role_oid="$2"
    local password="$3" database_url="$4"
    local nonce temp_database data_dir port system_identifier

    [ ! -e "$DB_RECOVERY_MARKER" ] && [ ! -L "$DB_RECOVERY_MARKER" ] \
        || error "A PostgreSQL recovery marker already exists; resume it before starting another repair."
    data_dir="$(current_db_cluster_data_dir || true)"
    port="$(current_db_cluster_port || true)"
    system_identifier="$(current_db_cluster_system_identifier || true)"
    [ -n "$data_dir" ] \
        && [[ "$port" =~ ^[0-9]+$ ]] \
        && [[ "$system_identifier" =~ ^[0-9]+$ ]] \
        || error "Could not fingerprint PostgreSQL before durable database recovery."

    nonce=""
    for _ in $(seq 1 10); do
        nonce="$(rand_string 20)"
        if [[ ! "$nonce" =~ ^[A-Za-z0-9]{20}$ ]]; then
            nonce=""
            continue
        fi
        temp_database="aurora_recovery_${nonce}"
        _temp_probe="$(
            sudo -u postgres psql -X -qAt \
                -c "SELECT oid::text FROM pg_database WHERE datname='${temp_database}'" \
                2>/dev/null
        )" || error "Could not inspect PostgreSQL recovery-name availability."
        [ -z "$_temp_probe" ] && break
        nonce=""
    done
    [ -n "$nonce" ] \
        || error "Could not allocate a unique PostgreSQL recovery identity."

    RECOVERY_VERSION="2"
    RECOVERY_NONCE="$nonce"
    RECOVERY_DATA_DIR="$data_dir"
    RECOVERY_PORT="$port"
    RECOVERY_SYSTEM_IDENTIFIER="$system_identifier"
    RECOVERY_ROLE_ACTION="$role_action"
    RECOVERY_SOURCE_ROLE_OID="$source_role_oid"
    RECOVERY_TEMP_DATABASE="$temp_database"
    RECOVERY_PASSWORD="$password"
    RECOVERY_DB_URL="$database_url"
    RECOVERY_DATABASE_OID="-"
    if [ "$source_role_oid" = "-" ]; then
        RECOVERY_ROLE_OID="-"
        RECOVERY_PHASE="intent"
    else
        RECOVERY_ROLE_OID="$source_role_oid"
        RECOVERY_PHASE="role-ready"
    fi
    # Persist the installer-state directory's own entry before the first DDL.
    aurora_fsync_directory "$(dirname "$INSTALLER_LIB_DIR")" \
        || error "Could not durably prepare PostgreSQL recovery-state storage."
    persist_db_recovery_marker
    ok "Durable PostgreSQL recovery intent recorded"
}

begin_db_recovery() {
    local role_exists="$1" existing_database_url="$2"
    local role_oid password database_url encoded_password
    if $role_exists; then
        role_oid="$(current_db_role_oid)" \
            || error "Could not capture Aurora's retained PostgreSQL role OID."
        [[ "$role_oid" =~ ^[0-9]+$ ]] \
            || error "Aurora's retained PostgreSQL role disappeared before recovery."
        if [ -n "$existing_database_url" ]; then
            password="-"
            database_url="$existing_database_url"
            write_db_recovery_marker retain "$role_oid" "$password" "$database_url"
        else
            password="$(rand_string 32)"
            [[ "$password" =~ ^[A-Za-z0-9]{32}$ ]] \
                || error "Could not generate a PostgreSQL recovery password."
            encoded_password="$(urlencode_password "$password")"
            database_url="postgres://${DB_USER}:${encoded_password}@localhost:5432/${DB_NAME}?sslmode=disable"
            write_db_recovery_marker rotate "$role_oid" "$password" "$database_url"
        fi
    else
        password="$(rand_string 32)"
        [[ "$password" =~ ^[A-Za-z0-9]{32}$ ]] \
            || error "Could not generate a PostgreSQL recovery password."
        encoded_password="$(urlencode_password "$password")"
        database_url="postgres://${DB_USER}:${encoded_password}@localhost:5432/${DB_NAME}?sslmode=disable"
        write_db_recovery_marker create "-" "$password" "$database_url"
    fi
}

install_db_recovery_start_guards() {
    local unit dropin_dir dropin guard_parent
    for unit in \
        aurora.service aurora-update.service \
        aurora-update.path aurora-update.timer; do
        dropin_dir="/etc/systemd/system/${unit}.d"
        dropin="$dropin_dir/50-aurora-db-recovery.conf"
        install -d -m 0755 -o root -g root "$dropin_dir"
        {
            printf '%s\n' '[Unit]'
            printf '%s\n' 'ConditionPathExists=!/usr/local/lib/aurora-installer/db-recovery-pending'
        } > "$dropin.tmp"
        chmod 0644 "$dropin.tmp"
        chown root:root "$dropin.tmp"
        mv -f "$dropin.tmp" "$dropin"
        aurora_fsync_file_and_parent "$dropin" \
            || error "Could not durably install PostgreSQL recovery guard for $unit."
        # Persist the newly-created unit.d entry itself, not only its contents.
        for guard_parent in /etc/systemd/system /etc/systemd /etc; do
            aurora_fsync_directory "$guard_parent" \
                || error "Could not durably commit PostgreSQL recovery guard directory for $unit."
        done
    done
    systemctl daemon-reload \
        || error "Could not reload systemd PostgreSQL recovery guards."
}

quiesce_aurora_for_db_recovery() {
    local active_state load_state
    install_db_recovery_start_guards
    load_state="$(
        systemctl show aurora.service --property=LoadState --value \
            2>/dev/null
    )" || error "Could not inspect Aurora's systemd load state before PostgreSQL recovery."
    [ "$load_state" != "not-found" ] || return 0
    active_state="$(
        systemctl show aurora.service --property=ActiveState --value \
            2>/dev/null
    )" || error "Could not inspect Aurora's systemd state before PostgreSQL recovery."
    case "$active_state" in
        inactive|failed) return 0 ;;
    esac

    # is-active intentionally reports false for some transitional states such
    # as activating. Stop every nonterminal state, then inspect ActiveState
    # directly so an auto-restart cannot overlap recovery DDL.
    info "Stopping Aurora before PostgreSQL object recovery..."
    systemctl stop aurora.service \
        || error "Could not stop Aurora before PostgreSQL recovery."
    for _ in $(seq 1 30); do
        active_state="$(
            systemctl show aurora.service --property=ActiveState --value \
                2>/dev/null || true
        )"
        case "$active_state" in
            inactive|failed)
                warn "Aurora will remain stopped if this repair is interrupted; rerun the installer to finish."
                return 0
                ;;
        esac
        sleep 1
    done
    error "Aurora remained in systemd state '${active_state:-unknown}'; refusing concurrent PostgreSQL recovery."
}

resume_db_recovery() {
    local current_data current_port current_system_identifier recovery_label
    local role_oid role_comment database_oid database_owner_oid database_comment
    local temp_database_oid temp_database_owner_oid temp_database_comment

    load_db_recovery_marker
    current_data="$(current_db_cluster_data_dir || true)"
    current_port="$(current_db_cluster_port || true)"
    current_system_identifier="$(current_db_cluster_system_identifier || true)"
    [ "$current_data" = "$RECOVERY_DATA_DIR" ] \
        && [ "$current_port" = "$RECOVERY_PORT" ] \
        && [ "$current_system_identifier" = "$RECOVERY_SYSTEM_IDENTIFIER" ] \
        || error "PostgreSQL recovery state belongs to a different running cluster."
    recovery_label="aurora-installer-recovery:${RECOVERY_NONCE}"

    role_oid="$(current_db_role_oid)" \
        || error "Could not inspect PostgreSQL role identity during recovery."
    if [ "$RECOVERY_ROLE_ACTION" = "retain" ] \
        || [ "$RECOVERY_ROLE_ACTION" = "rotate" ]; then
        [ "$role_oid" = "$RECOVERY_SOURCE_ROLE_OID" ] \
            || error "The retained Aurora role changed during PostgreSQL recovery; refusing to continue."
        if [ "$RECOVERY_ROLE_ACTION" = "rotate" ]; then
            info "Converging Aurora's recovered PostgreSQL role credential..."
            if ! psql_with_stdin_password "$RECOVERY_PASSWORD" \
                -X -q --dbname=postgres \
                --set=ON_ERROR_STOP=1 \
                --set="expected_data=$RECOVERY_DATA_DIR" \
                --set="expected_port=$RECOVERY_PORT" \
                --set="expected_system_identifier=$RECOVERY_SYSTEM_IDENTIFIER" \
                --set="expected_role=$DB_USER" \
                --set="expected_role_oid=$RECOVERY_SOURCE_ROLE_OID" \
                >/dev/null 2>&1 <<'PSQL'
SELECT current_setting('data_directory') = :'expected_data'
   AND current_setting('port') = :'expected_port'
   AND (SELECT system_identifier::text FROM pg_control_system())
       = :'expected_system_identifier'
   AND EXISTS (
       SELECT 1
       FROM pg_roles
       WHERE rolname = :'expected_role'
         AND oid::text = :'expected_role_oid'
   ) AS aurora_role_rotation_guard \gset
\if :aurora_role_rotation_guard
\else
SELECT 1 / 0 AS aurora_role_rotation_guard_failed;
\endif
ALTER ROLE :"expected_role" PASSWORD :'recovery_password';
PSQL
            then
                error "Could not converge Aurora's PostgreSQL role credential; durable recovery state was preserved."
            fi
        fi
    else
        if [ -z "$role_oid" ]; then
            [ "$RECOVERY_PHASE" = "intent" ] \
                && [ "$RECOVERY_ROLE_OID" = "-" ] \
                || error "The checkpointed PostgreSQL recovery role disappeared."
            info "Creating the proven-missing Aurora role transactionally..."
            if ! psql_with_stdin_password "$RECOVERY_PASSWORD" \
                -X -q --dbname=postgres \
                --set=ON_ERROR_STOP=1 \
                --set="expected_data=$RECOVERY_DATA_DIR" \
                --set="expected_port=$RECOVERY_PORT" \
                --set="expected_system_identifier=$RECOVERY_SYSTEM_IDENTIFIER" \
                --set="expected_role=$DB_USER" \
                --set="recovery_label=$recovery_label" >/dev/null 2>&1 <<'PSQL'
BEGIN;
SELECT current_setting('data_directory') = :'expected_data'
   AND current_setting('port') = :'expected_port'
   AND (SELECT system_identifier::text FROM pg_control_system())
       = :'expected_system_identifier'
   AND NOT EXISTS (
       SELECT 1 FROM pg_roles WHERE rolname = :'expected_role'
   ) AS aurora_role_recovery_guard \gset
\if :aurora_role_recovery_guard
\else
SELECT 1 / 0 AS aurora_role_recovery_guard_failed;
\endif
CREATE ROLE :"expected_role" LOGIN PASSWORD :'recovery_password';
COMMENT ON ROLE :"expected_role" IS :'recovery_label';
COMMIT;
PSQL
            then
                error "Could not transactionally recreate Aurora's PostgreSQL role; durable recovery state was preserved."
            fi
            role_oid="$(current_db_role_oid)" \
                || error "Could not inspect the recreated PostgreSQL role."
        fi
        role_comment="$(db_role_comment "$DB_USER")" \
            || error "Could not verify the recreated PostgreSQL role comment."
        [ -n "$role_oid" ] && [ "$role_comment" = "$recovery_label" ] \
            || error "A same-named PostgreSQL role exists without Aurora's recovery provenance."
    fi

    [[ "$role_oid" =~ ^[0-9]+$ ]] \
        || error "Aurora's recovered PostgreSQL role is missing."
    if [ "$RECOVERY_ROLE_OID" = "-" ]; then
        # A crash after CREATE ROLE COMMIT but before this write is recovered
        # by the nonce comment above. Persist its immutable OID before any
        # database DDL can reference or claim the role.
        update_db_recovery_marker "$role_oid" "-" role-ready
    else
        [ "$role_oid" = "$RECOVERY_ROLE_OID" ] \
            || error "Aurora's checkpointed PostgreSQL role identity changed."
    fi

    database_oid="$(current_db_object_oid)" \
        || error "Could not inspect PostgreSQL database identity during recovery."
    temp_database_oid="$(db_database_oid "$RECOVERY_TEMP_DATABASE")" \
        || error "Could not inspect Aurora's temporary recovery database."
    if [ -n "$database_oid" ]; then
        [ -z "$temp_database_oid" ] \
            || error "Both final and temporary Aurora recovery databases exist; refusing ambiguous recovery."
        case "$RECOVERY_PHASE" in
            temp-ready|promoted) ;;
            *)
                error "Aurora's final database appeared before its identity was durably checkpointed."
                ;;
        esac
        [ "$database_oid" = "$RECOVERY_DATABASE_OID" ] \
            || error "Aurora's final database OID differs from its durable recovery checkpoint."
        database_owner_oid="$(db_database_owner_oid "$DB_NAME")" \
            || error "Could not inspect the recovered database owner."
        database_comment="$(db_database_comment "$DB_NAME")" \
            || error "Could not inspect the recovered database comment."
        [ "$database_owner_oid" = "$role_oid" ] \
            && [ "$database_comment" = "$recovery_label" ] \
            || error "A same-named PostgreSQL database exists without Aurora's recovery provenance."
        if [ "$RECOVERY_PHASE" = "temp-ready" ]; then
            # ALTER DATABASE RENAME preserves the OID. A crash after rename
            # therefore resumes by binding the same proven OID to this phase.
            update_db_recovery_marker "$role_oid" "$database_oid" promoted
        fi
    else
        [ "$RECOVERY_PHASE" != "promoted" ] \
            || error "Aurora's promoted PostgreSQL database disappeared."
        if [ -z "$temp_database_oid" ]; then
            [ "$RECOVERY_PHASE" = "role-ready" ] \
                && [ "$RECOVERY_DATABASE_OID" = "-" ] \
                || error "Aurora's checkpointed temporary PostgreSQL database disappeared."
            info "Creating a temporary Aurora recovery database..."
            # CREATE DATABASE cannot run inside a transaction. Keep the
            # fingerprint, role-OID, and collision guards in the same psql
            # session as CREATE/COMMENT; the random name in the fsynced intent
            # safely identifies the only empty-comment object a retry may claim
            # if power is lost between those two statements.
            if ! sudo -u postgres psql -X -q --dbname=postgres \
                --set=ON_ERROR_STOP=1 \
                --set="expected_data=$RECOVERY_DATA_DIR" \
                --set="expected_port=$RECOVERY_PORT" \
                --set="expected_system_identifier=$RECOVERY_SYSTEM_IDENTIFIER" \
                --set="expected_role=$DB_USER" \
                --set="expected_role_oid=$role_oid" \
                --set="temp_database=$RECOVERY_TEMP_DATABASE" \
                --set="expected_database=$DB_NAME" \
                --set="recovery_label=$recovery_label" >/dev/null 2>&1 <<'PSQL'
SELECT current_setting('data_directory') = :'expected_data'
   AND current_setting('port') = :'expected_port'
   AND (SELECT system_identifier::text FROM pg_control_system())
       = :'expected_system_identifier'
   AND EXISTS (
       SELECT 1
       FROM pg_roles
       WHERE rolname = :'expected_role'
         AND oid::text = :'expected_role_oid'
   )
   AND NOT EXISTS (
       SELECT 1
       FROM pg_database
       WHERE datname IN (:'expected_database', :'temp_database')
   ) AS aurora_database_creation_guard \gset
\if :aurora_database_creation_guard
\else
SELECT 1 / 0 AS aurora_database_creation_guard_failed;
\endif
CREATE DATABASE :"temp_database" OWNER :"expected_role";
COMMENT ON DATABASE :"temp_database" IS :'recovery_label';
PSQL
            then
                error "Could not create Aurora's guarded temporary recovery database; durable state was preserved."
            fi
            temp_database_oid="$(db_database_oid "$RECOVERY_TEMP_DATABASE")" \
                || error "Could not inspect the temporary recovery database after creation."
        fi
        [[ "$temp_database_oid" =~ ^[0-9]+$ ]] \
            || error "Aurora's temporary recovery database is missing."
        temp_database_owner_oid="$(db_database_owner_oid "$RECOVERY_TEMP_DATABASE")" \
            || error "Could not inspect the temporary recovery database owner."
        temp_database_comment="$(db_database_comment "$RECOVERY_TEMP_DATABASE")" \
            || error "Could not inspect the temporary recovery database comment."
        [ "$temp_database_owner_oid" = "$role_oid" ] \
            || error "The temporary PostgreSQL recovery database has an unexpected owner."

        if [ "$RECOVERY_PHASE" = "role-ready" ] \
            && [ "$RECOVERY_DATABASE_OID" = "-" ] \
            && [ -z "$temp_database_comment" ]; then
            # Recover the narrow CREATE-success/COMMENT-not-yet-run window.
            # The name is a 20-character random nonce committed before DDL;
            # bind the comment only while the final name is absent and every
            # cluster, role, name, owner, and OID guard still matches.
            if ! sudo -u postgres psql -X -q --dbname=postgres \
                --set=ON_ERROR_STOP=1 \
                --set="expected_data=$RECOVERY_DATA_DIR" \
                --set="expected_port=$RECOVERY_PORT" \
                --set="expected_system_identifier=$RECOVERY_SYSTEM_IDENTIFIER" \
                --set="expected_role=$DB_USER" \
                --set="expected_role_oid=$role_oid" \
                --set="expected_temp_oid=$temp_database_oid" \
                --set="temp_database=$RECOVERY_TEMP_DATABASE" \
                --set="expected_database=$DB_NAME" \
                --set="recovery_label=$recovery_label" >/dev/null 2>&1 <<'PSQL'
SELECT current_setting('data_directory') = :'expected_data'
   AND current_setting('port') = :'expected_port'
   AND (SELECT system_identifier::text FROM pg_control_system())
       = :'expected_system_identifier'
   AND EXISTS (
       SELECT 1
       FROM pg_roles
       WHERE rolname = :'expected_role'
         AND oid::text = :'expected_role_oid'
   )
   AND NOT EXISTS (
       SELECT 1 FROM pg_database WHERE datname = :'expected_database'
   )
   AND EXISTS (
       SELECT 1
       FROM pg_database
       WHERE datname = :'temp_database'
         AND oid::text = :'expected_temp_oid'
         AND datdba::text = :'expected_role_oid'
         AND COALESCE(shobj_description(oid, 'pg_database'), '') = ''
   ) AS aurora_database_comment_guard \gset
\if :aurora_database_comment_guard
\else
SELECT 1 / 0 AS aurora_database_comment_guard_failed;
\endif
COMMENT ON DATABASE :"temp_database" IS :'recovery_label';
PSQL
            then
                error "Could not bind Aurora's temporary recovery database provenance."
            fi
            temp_database_comment="$(db_database_comment "$RECOVERY_TEMP_DATABASE")" \
                || error "Could not verify the temporary recovery database comment."
        fi
        if [ "$temp_database_comment" != "$recovery_label" ]; then
            error "The temporary PostgreSQL recovery database failed provenance checks."
        fi

        if [ "$RECOVERY_PHASE" = "role-ready" ]; then
            # No promotion is allowed until this OID checkpoint and its parent
            # directory are on stable storage.
            update_db_recovery_marker "$role_oid" "$temp_database_oid" temp-ready
        else
            [ "$RECOVERY_PHASE" = "temp-ready" ] \
                && [ "$temp_database_oid" = "$RECOVERY_DATABASE_OID" ] \
                || error "The temporary PostgreSQL database differs from its durable recovery checkpoint."
        fi

        info "Promoting Aurora's temporary recovery database..."
        if ! sudo -u postgres psql -X -q --dbname=postgres \
            --set=ON_ERROR_STOP=1 \
            --set="expected_data=$RECOVERY_DATA_DIR" \
            --set="expected_port=$RECOVERY_PORT" \
            --set="expected_system_identifier=$RECOVERY_SYSTEM_IDENTIFIER" \
            --set="expected_role_oid=$role_oid" \
            --set="expected_temp_oid=$temp_database_oid" \
            --set="temp_database=$RECOVERY_TEMP_DATABASE" \
            --set="expected_database=$DB_NAME" \
            --set="recovery_label=$recovery_label" >/dev/null 2>&1 <<'PSQL'
SELECT current_setting('data_directory') = :'expected_data'
   AND current_setting('port') = :'expected_port'
   AND (SELECT system_identifier::text FROM pg_control_system())
       = :'expected_system_identifier'
   AND NOT EXISTS (
       SELECT 1 FROM pg_database WHERE datname = :'expected_database'
   )
   AND EXISTS (
       SELECT 1
       FROM pg_database
       WHERE datname = :'temp_database'
         AND oid::text = :'expected_temp_oid'
         AND datdba::text = :'expected_role_oid'
         AND COALESCE(shobj_description(oid, 'pg_database'), '')
             = :'recovery_label'
   ) AS aurora_database_recovery_guard \gset
\if :aurora_database_recovery_guard
\else
SELECT 1 / 0 AS aurora_database_recovery_guard_failed;
\endif
COMMENT ON DATABASE :"temp_database" IS :'recovery_label';
ALTER DATABASE :"temp_database" RENAME TO :"expected_database";
PSQL
        then
            error "Could not promote Aurora's recovery database; durable recovery state was preserved."
        fi
        database_oid="$(current_db_object_oid)" \
            || error "Could not inspect Aurora's promoted recovery database."
        [ "$database_oid" = "$temp_database_oid" ] \
            || error "Aurora's promoted database did not retain its checkpointed OID."
        update_db_recovery_marker "$role_oid" "$database_oid" promoted
    fi

    database_oid="$(current_db_object_oid)" \
        || error "Could not inspect Aurora's recovered database."
    database_owner_oid="$(db_database_owner_oid "$DB_NAME")" \
        || error "Could not verify Aurora's recovered database owner."
    database_comment="$(db_database_comment "$DB_NAME")" \
        || error "Could not verify Aurora's recovered database provenance."
    [ -n "$database_oid" ] \
        && [ "$RECOVERY_PHASE" = "promoted" ] \
        && [ "$database_oid" = "$RECOVERY_DATABASE_OID" ] \
        && [ "$role_oid" = "$RECOVERY_ROLE_OID" ] \
        && [ "$database_owner_oid" = "$role_oid" ] \
        && [ "$database_comment" = "$recovery_label" ] \
        || error "Aurora's recovered database failed final provenance checks."

    # Bind the final nonce-verified OIDs immediately, then commit the matching
    # credential. The durable recovery marker remains until both writes
    # succeed, so every interruption point resumes here.
    aurora_env_upsert "$CONFIG_DIR/aurora.env" DATABASE_URL "$RECOVERY_DB_URL" \
        || error "Could not persist the recovered DATABASE_URL."
    chown root:"$AURORA_GROUP" "$CONFIG_DIR/aurora.env"
    chmod 0640 "$CONFIG_DIR/aurora.env"
    aurora_fsync_file_and_parent "$CONFIG_DIR/aurora.env" \
        || error "Could not durably commit recovered DATABASE_URL metadata."
    DB_URL="$RECOVERY_DB_URL"
    EXISTING_DB_URL="$RECOVERY_DB_URL"
    write_db_ownership_marker \
        "$database_oid" "$role_oid" \
        "$RECOVERY_DATA_DIR" "$RECOVERY_PORT" "$RECOVERY_SYSTEM_IDENTIFIER"
    rm -f "$DB_RECOVERY_MARKER"
    aurora_fsync_directory "$INSTALLER_LIB_DIR" \
        || error "Could not durably finalize PostgreSQL recovery state."
    ROLE_EXISTS=true
    DATABASE_EXISTS=true
    DATABASE_OWNER="$DB_USER"
    DB_OWNERSHIP_VALID=true
    DB_OWNERSHIP_MARKER_NEEDS_REFRESH=false
    ok "PostgreSQL recovery state converged and new object identities were recorded"
}

# If a previous install wrote an env file, reuse its DATABASE_URL so
# we don't break existing data on re-runs. Otherwise create fresh
# user + DB with a random password.
EXISTING_DB_URL=""
if [ -f "$CONFIG_DIR/aurora.env" ]; then
    EXISTING_DB_URL="$(
        aurora_env_get_unquoted "$CONFIG_DIR/aurora.env" DATABASE_URL \
            2>/dev/null || true
    )"
fi

if [ -n "$EXISTING_DB_URL" ]; then
    DB_URL="$EXISTING_DB_URL"
    ok "Reusing existing DATABASE_URL from $CONFIG_DIR/aurora.env"
    if aurora_database_url_is_local_database "$DB_URL" "$DB_NAME"; then
        DB_TARGET_LOCAL=true
    else
        info "External/non-default DATABASE_URL retained; local PostgreSQL will not be administered."
        warn "Ensure pg_trgm and pgvector are enabled by the database provider."
    fi
else
    DB_TARGET_LOCAL=true
    DB_PASSWORD="$(rand_string 32)"
fi

if { [ -e "$DB_RECOVERY_MARKER" ] || [ -L "$DB_RECOVERY_MARKER" ]; } \
    && ! $DB_TARGET_LOCAL; then
    error "A local PostgreSQL recovery is pending, but retained configuration now targets an external database.
Restore the local Aurora DATABASE_URL and rerun the installer to finish recovery before changing providers."
fi

if $DB_TARGET_LOCAL; then
    ROLE_EXISTS=false
    DATABASE_EXISTS=false
    DATABASE_OWNER=""
    _role_exists_probe="$(
        sudo -u postgres psql -X -qAt \
            -c "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" \
            2>/dev/null
    )" || error "Could not inspect the local PostgreSQL role catalog safely."
    _database_exists_probe="$(
        sudo -u postgres psql -X -qAt \
            -c "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" \
            2>/dev/null
    )" || error "Could not inspect the local PostgreSQL database catalog safely."
    case "$_role_exists_probe" in
        "") ;;
        1) ROLE_EXISTS=true ;;
        *) error "Unexpected result while inspecting PostgreSQL role '$DB_USER'." ;;
    esac
    case "$_database_exists_probe" in
        "") ;;
        1) DATABASE_EXISTS=true ;;
        *) error "Unexpected result while inspecting PostgreSQL database '$DB_NAME'." ;;
    esac
    if $DATABASE_EXISTS; then
        DATABASE_OWNER="$(
            sudo -u postgres psql -X -qAt \
                -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='${DB_NAME}'" \
                2>/dev/null || true
        )"
        [ "$DATABASE_OWNER" = "$DB_USER" ] \
            || error "Local database '$DB_NAME' is owned by '$DATABASE_OWNER', not '$DB_USER'. Refusing to claim or administer it."
    fi

    # A prior attempt may have been interrupted after durable recovery intent
    # but before the credential and seven-field ownership marker converged.
    # Resume before ordinary marker validation so installer-created OIDs are
    # verified by their nonce instead of mistaken for unrelated collisions.
    if [ -e "$DB_RECOVERY_MARKER" ] || [ -L "$DB_RECOVERY_MARKER" ]; then
        quiesce_aurora_for_db_recovery
        resume_db_recovery
    fi

    if [ -f "$DB_OWNERSHIP_MARKER" ]; then
        _db_marker_status=0
        db_ownership_marker_status || _db_marker_status=$?
        case "$_db_marker_status" in
            0)
                DB_OWNERSHIP_VALID=true
                ;;
            2)
                if [ "$AURORA_ADOPT_EXISTING_IDENTITIES_VALUE" != "true" ]; then
                    error "Aurora's legacy database ownership marker lacks complete PostgreSQL cluster/object identity.
Verify the running cluster and '$DB_USER'/'$DB_NAME' objects belong to Aurora, then rerun once with AURORA_ADOPT_EXISTING_IDENTITIES=true."
                fi
                DB_OWNERSHIP_VALID=true
                DB_OWNERSHIP_MARKER_NEEDS_REFRESH=true
                warn "Explicitly approved migration of Aurora's legacy database ownership marker."
                ;;
            3)
                DB_OWNERSHIP_VALID=true
                DB_OWNERSHIP_MARKER_NEEDS_REFRESH=true
                warn "An Aurora-owned PostgreSQL object is missing; its identity marker will be refreshed only after safe recreation."
                ;;
            *)
                error "Aurora's database ownership marker does not match the running PostgreSQL cluster/database/role identities. Refusing local superuser changes."
                ;;
        esac
    elif $ROLE_EXISTS || $DATABASE_EXISTS; then
        if ! $ALLOW_IDENTITY_ADOPTION; then
            error "Local PostgreSQL role/database '$DB_USER'/'$DB_NAME' already exists without Aurora ownership provenance.
Refusing password rotation or schema administration. Verify both belong to Aurora, then rerun with AURORA_ADOPT_EXISTING_IDENTITIES=true."
        fi
        DB_OWNERSHIP_VALID=true
        if $LEGACY_AURORA_INSTALL; then
            warn "Adopted legacy Aurora PostgreSQL role/database from verified unit+env+binary artifacts."
        else
            warn "Explicitly adopted existing local PostgreSQL role/database on this cluster."
        fi
    fi

    # Once existing/adopted objects are proven, persist their complete identity
    # before rotating any credential. A later failure then resumes from a
    # seven-field marker instead of requiring another adoption decision.
    if $ROLE_EXISTS && $DATABASE_EXISTS \
        && { [ ! -f "$DB_OWNERSHIP_MARKER" ] \
            || $DB_OWNERSHIP_MARKER_NEEDS_REFRESH; }; then
        write_db_ownership_marker
        DB_OWNERSHIP_VALID=true
        DB_OWNERSHIP_MARKER_NEEDS_REFRESH=false
    fi

    if ! $DATABASE_EXISTS; then
        # Every database creation, including a first install, goes through
        # durable recovery intent. The temporary nonce-bound database and
        # optional idempotent role rotation make power loss retry-safe.
        # Install the future-start guard, then fsync the recovery intent before
        # stopping the currently running unit. This closes the stop→marker race:
        # no queued/manual start can reactivate Aurora after quiescence.
        install_db_recovery_start_guards
        begin_db_recovery "$ROLE_EXISTS" "$EXISTING_DB_URL"
        quiesce_aurora_for_db_recovery
        resume_db_recovery
        warn "Aurora created a fresh empty local database."
    elif ! $ROLE_EXISTS; then
        error "Local PostgreSQL database '$DB_NAME' exists without its recorded owner role; refusing unsafe repair."
    elif [ -n "$EXISTING_DB_URL" ]; then
        :
    else
        [[ "$DB_PASSWORD" =~ ^[A-Za-z0-9]{32}$ ]] \
            || error "Could not generate a PostgreSQL role password."
        info "Rotating password for explicitly owned/adopted role '${DB_USER}'"
        if ! psql_with_stdin_password "$DB_PASSWORD" \
            -X -q --dbname=postgres --set=ON_ERROR_STOP=1 \
            --set="expected_role=$DB_USER" >/dev/null 2>&1 <<'PSQL'
ALTER ROLE :"expected_role" PASSWORD :'recovery_password';
PSQL
        then
            error "Could not rotate Aurora's PostgreSQL role password."
        fi
        ENCODED_PW="$(urlencode_password "$DB_PASSWORD")"
        DB_URL="postgres://${DB_USER}:${ENCODED_PW}@localhost:5432/${DB_NAME}?sslmode=disable"
    fi

    if [ ! -f "$DB_OWNERSHIP_MARKER" ] \
        || $DB_OWNERSHIP_MARKER_NEEDS_REFRESH; then
        write_db_ownership_marker
        DB_OWNERSHIP_VALID=true
        DB_OWNERSHIP_MARKER_NEEDS_REFRESH=false
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

    # Install/load-test pgvector only after the target DSN and cluster
    # ownership are proven.
    install_pgvector
    ok "Local database ownership and prerequisites verified"
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
if $DB_TARGET_LOCAL && $DB_OWNERSHIP_VALID \
    && pg_isready &>/dev/null \
    && sudo -u postgres psql -tAc "SELECT 1" &>/dev/null; then
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
    warn "Local extension pre-creation skipped. For an external/non-default PostgreSQL target, have the provider enable:"
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

TMDB_KEY="${TMDB_API_KEY_VALUE:-$EXISTING_TMDB}"
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
FRONTEND_TMP="$(mktemp -d)"
build_frontend_bundle "$FRONTEND_TMP/v2"
ok "Frontend bundle built"

info "Building (version: $VERSION)..."
CGO_ENABLED=0 go build -ldflags="-s -w -X main.version=${VERSION}" -o aurora ./cmd/aurora
ok "Build complete"

install -m 0755 aurora "$INSTALL_BIN.new"
rm -f aurora
ok "Binary staged at $INSTALL_BIN.new"

# Layout directories.
mkdir -p "$CONFIG_DIR"
install -d -m 0750 -o "$AURORA_USER" -g "$AURORA_GROUP" \
    "$CACHE_DIR" "$CACHE_DIR/images" "$CACHE_DIR/subtitles" "$TRANSCODE_DIR"
# Repair permissive modes left by older installers. Subtitles, artwork, and
# transcode fragments can expose viewing activity or media to local accounts.
chmod -R o-rwx "$CACHE_DIR"
install -d -m 0750 -o "$AURORA_USER" -g "$AURORA_GROUP" "$LOG_DIR"
# Safe uninstall retains logs as root-only data. Restore ownership on repair
# so Aurora's rotating file logger can append to existing files again.
chown -R "$AURORA_USER:$AURORA_GROUP" "$LOG_DIR"
# /var/lib/aurora must exist BEFORE aurora.service starts because
# the unit's ReadWritePaths= references it (without the `-` prefix,
# systemd refuses to start the unit if the path is missing). The
# updater install block further down also writes here, but creating
# the dir unconditionally up front means a SKIP_UPDATER install
# (no git remote, or aurora-update.sh missing) still leaves
# aurora.service startable.
install -d -m 0755 -o root -g root /var/lib/aurora

# Stage the exact migration set. Overlay-copying into the live directory leaves
# removed/renamed, not-yet-applied SQL behind and can execute stale migrations.
SQL_FILES=()
shopt -s nullglob
for migration_file in "$PROJECT_DIR"/migrations/*.sql; do
    SQL_FILES+=("$migration_file")
done
shopt -u nullglob
if [ "${#SQL_FILES[@]}" -eq 0 ]; then
    rm -f "$INSTALL_BIN.new"
    error "No migration files found in $PROJECT_DIR/migrations; refusing a partial install."
fi
rm -rf "$INSTALL_DIR/migrations.new"
mkdir -p "$INSTALL_DIR/migrations.new"
if ! cp -f "${SQL_FILES[@]}" "$INSTALL_DIR/migrations.new/"; then
    rm -f "$INSTALL_BIN.new"
    rm -rf "$INSTALL_DIR/migrations.new"
    error "Failed to stage migrations; the installed binary was not changed."
fi
stage_static_bundle "$FRONTEND_TMP/v2"
chown -R root:root "$INSTALL_DIR/static.new" "$INSTALL_DIR/migrations.new"
chmod -R go-w "$INSTALL_DIR/static.new" "$INSTALL_DIR/migrations.new"

# Recover a last-known-good directory if a prior install was interrupted after
# snapshotting it but before promoting the replacement.
if [ ! -e "$INSTALL_DIR/static" ] && [ -e "$INSTALL_DIR/static.old" ]; then
    mv "$INSTALL_DIR/static.old" "$INSTALL_DIR/static"
fi
if [ ! -e "$INSTALL_DIR/migrations" ] \
    && [ -e "$INSTALL_DIR/migrations.old" ]; then
    mv "$INSTALL_DIR/migrations.old" "$INSTALL_DIR/migrations"
fi
rm -rf "$INSTALL_DIR/static.old" "$INSTALL_DIR/migrations.old"
HAD_STATIC=false
HAD_MIGRATIONS=false
if [ -e "$INSTALL_DIR/static" ]; then
    mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.old"
    HAD_STATIC=true
fi
if [ -e "$INSTALL_DIR/migrations" ]; then
    mv "$INSTALL_DIR/migrations" "$INSTALL_DIR/migrations.old"
    HAD_MIGRATIONS=true
fi
if ! mv "$INSTALL_DIR/static.new" "$INSTALL_DIR/static"; then
    $HAD_STATIC && mv "$INSTALL_DIR/static.old" "$INSTALL_DIR/static"
    $HAD_MIGRATIONS && mv "$INSTALL_DIR/migrations.old" "$INSTALL_DIR/migrations"
    rm -f "$INSTALL_BIN.new"
    rm -rf "$INSTALL_DIR/migrations.new"
    error "Failed to promote static assets; previous deployment restored."
fi
if ! mv "$INSTALL_DIR/migrations.new" "$INSTALL_DIR/migrations"; then
    rm -rf "$INSTALL_DIR/static"
    $HAD_STATIC && mv "$INSTALL_DIR/static.old" "$INSTALL_DIR/static"
    $HAD_MIGRATIONS && mv "$INSTALL_DIR/migrations.old" "$INSTALL_DIR/migrations"
    rm -f "$INSTALL_BIN.new"
    error "Failed to promote migrations; previous deployment restored."
fi
if ! mv "$INSTALL_BIN.new" "$INSTALL_BIN"; then
    rm -rf "$INSTALL_DIR/static.failed" "$INSTALL_DIR/migrations.failed"
    mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.failed"
    mv "$INSTALL_DIR/migrations" "$INSTALL_DIR/migrations.failed"
    $HAD_STATIC && mv "$INSTALL_DIR/static.old" "$INSTALL_DIR/static"
    $HAD_MIGRATIONS && mv "$INSTALL_DIR/migrations.old" "$INSTALL_DIR/migrations"
    rm -rf "$INSTALL_DIR/static.failed" "$INSTALL_DIR/migrations.failed"
    error "Failed to promote the Aurora binary; previous deployment restored."
fi
rm -rf "$INSTALL_DIR/static.old" "$INSTALL_DIR/migrations.old"
rm -rf "$FRONTEND_TMP"
ok "Binary, static assets, and exact migration set installed"

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

# ── Auto-updater: script + service + timer + path trigger ─────────
# Installs the "pull origin → rebuild → restart" pipeline. The
# timer fires every 5 min and is a fast no-op when origin has no
# new commits. The in-app "Update Now" action touches a narrowly
# writable trigger file; aurora-update.path then asks systemd to
# start the root updater without granting the service account sudo.
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
UPDATE_BRANCH="${AURORA_UPDATE_BRANCH:-}"
if [ -z "$UPDATE_BRANCH" ]; then
    UPDATE_BRANCH="$(
        aurora_env_get_unquoted "$CONFIG_DIR/aurora.env" AURORA_UPDATE_BRANCH 2>/dev/null || true
    )"
fi
UPDATE_BRANCH="${UPDATE_BRANCH:-main}"
git check-ref-format --branch "$UPDATE_BRANCH" >/dev/null 2>&1 \
    || error "Invalid Aurora update branch: $UPDATE_BRANCH"

UPDATER_SOURCE_DIR="/var/lib/aurora/source"
UPDATER_ORIGIN_URL=""
SKIP_UPDATER=false

validate_managed_updater_source() {
    local unsafe worktree_status

    [ ! -L "$UPDATER_SOURCE_DIR" ] \
        || error "$UPDATER_SOURCE_DIR is a symlink; refusing root Git operations."
    [ ! -L "$UPDATER_SOURCE_DIR/.git" ] \
        || error "$UPDATER_SOURCE_DIR/.git is a symlink; refusing root Git operations."

    unsafe="$(
        find "$UPDATER_SOURCE_DIR" -xdev \
            \( -type f -o -type d \) \
            \( ! -user root -o -perm /022 \) \
            -print -quit 2>/dev/null
    )" || error "Could not verify ownership and permissions under $UPDATER_SOURCE_DIR."
    [ -z "$unsafe" ] \
        || error "Managed updater source contains a non-root-owned or writable path: $unsafe"

    worktree_status="$(
        git -C "$UPDATER_SOURCE_DIR" status --porcelain --untracked-files=normal
    )" || error "Could not inspect the managed updater source."
    [ -z "$worktree_status" ] \
        || error "$UPDATER_SOURCE_DIR has local or untracked changes. Clean it before running the root installer."
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

validate_updater_origin_url() {
    local url="$1" authority scheme
    case "$url" in
        *$'\n'*|*$'\r'*)
            error "The Git origin URL contains an invalid newline."
            ;;
        *://*)
            scheme="$(printf '%s' "${url%%://*}" | tr '[:upper:]' '[:lower:]')"
            case "$scheme" in
                https)
                    authority="${url#*://}"
                    authority="${authority%%/*}"
                    case "$authority" in
                        *@*)
                            error "The Git origin embeds credentials in its HTTPS URL. Remove userinfo from remote.origin.url, export AURORA_GIT_TOKEN, and re-run; Aurora never persists token-bearing remotes."
                            ;;
                    esac
                    ;;
                ssh|git+ssh) ;;
                file)
                    error "Local/file Git origins are not supported by Aurora's root auto-updater. Use an HTTPS or SSH remote; use scripts/redeploy.sh for local source deployments."
                    ;;
                http|git)
                    error "The Git origin uses an unencrypted transport. Use HTTPS or SSH."
                    ;;
                *)
                    error "The Git origin uses an unsupported transport. Use HTTPS or SSH."
                    ;;
            esac
            ;;
        *::*)
            error "Git remote-helper origins are not allowed for Aurora's root updater."
            ;;
        *)
            if ! is_scp_style_ssh_remote "$url"; then
                error "Local Git origins are not supported by Aurora's root auto-updater. Use an HTTPS or SSH remote; use scripts/redeploy.sh for local source deployments."
            fi
            ;;
    esac
}

if [ -f "$PROJECT_DIR/scripts/aurora-update.sh" ]; then
    # Determine origin URL from the user's clone. We need it both
    # to set up the root-owned mirror and to write AURORA_EXPECTED_REMOTE.
    if UPDATER_ORIGIN_URL="$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null)" && [ -n "$UPDATER_ORIGIN_URL" ]; then
        validate_updater_origin_url "$UPDATER_ORIGIN_URL"
    else
        warn "No 'origin' remote configured in $PROJECT_DIR — auto-updater requires a git remote to pull from. Skipping updater install."
        SKIP_UPDATER=true
    fi
fi

if [ -f "$PROJECT_DIR/scripts/aurora-update.sh" ] && ! $SKIP_UPDATER; then
    info "Installing auto-updater..."

    # Private-repo auth (2026-05-20). For public repos, the auto-
    # updater's `git fetch` works without credentials. For private
    # repos, systemd's non-interactive context can't prompt — the
    # symptom is `fatal: could not read Username for 'https://github.com'`
    # spamming /var/log/aurora-installer/update.log every 5 min.
    #
    # If the operator sets AURORA_GIT_TOKEN=<PAT> before running
    # install.sh, we install a root-owned credential file and
    # configure credential.helper=store on the mirror only. The
    # token never lands in .git/config or process args (which
    # would leak to ps + journal). Use `x-access-token` as the
    # username so the same flow works for both classic and
    # fine-grained PATs without surfacing the actual username.
    if [ -n "$AURORA_GIT_TOKEN_VALUE" ]; then
        info "Configuring git credential store for private-repo auth..."
        install -d -m 0700 -o root -g root "$GIT_CREDENTIAL_DIR"
        rm -f "$GIT_CREDENTIAL_FILE.tmp"
        (
            umask 077
            printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=%s\n\n' \
                "$AURORA_GIT_TOKEN_VALUE" \
                | git credential-store --file="$GIT_CREDENTIAL_FILE.tmp" store
        )
        chmod 0600 "$GIT_CREDENTIAL_FILE.tmp"
        chown root:root "$GIT_CREDENTIAL_FILE.tmp"
        mv -f "$GIT_CREDENTIAL_FILE.tmp" "$GIT_CREDENTIAL_FILE"
        ok "Updated Aurora's private Git credential file"
        # Note: credential.helper is configured on the source
        # mirror itself (below, after the clone/fetch step) — that
        # way we don't pollute git's global config.
    fi

    # Older Aurora revisions used root's global credential store. Never edit
    # it automatically because a github.com entry may belong to another repo,
    # but make the migration residue visible so an operator can rotate/remove
    # a legacy Aurora token deliberately.
    if [ -f /root/.git-credentials ] \
        && grep -qE '(^|@)github\.com(/|$)' /root/.git-credentials 2>/dev/null; then
        warn "Legacy GitHub credentials exist in /root/.git-credentials."
        warn "Aurora now uses $GIT_CREDENTIAL_FILE; review the global file manually and remove only obsolete entries."
    fi

    # Set up the root-owned source mirror. Clone fresh if absent;
    # otherwise verify its ownership/cleanliness before any root Git
    # operation, then refresh `git fetch`. We also force-set the
    # origin URL in case a prior install intentionally changed forks.
    #
    # If AURORA_GIT_TOKEN is set, we tell the clone/fetch to use
    # the credential store via -c credential.helper=store. After
    # the clone, we persist that config in the mirror's .git/config
    # so the auto-updater's fetches also use it without needing
    # any env var.
    # Use the explicit Aurora-only credential file so updater fetches are
    # HOME-independent and root's general Git credentials are untouched.
    # Clear inherited/system/global helpers first so a legacy token-bearing
    # /root/.git-credentials entry can never be consulted by Aurora.
    GIT_CRED_ARGS=(-c credential.helper=)
    if [ -f "$GIT_CREDENTIAL_FILE" ]; then
        GIT_CRED_ARGS+=(-c "credential.helper=store --file=$GIT_CREDENTIAL_FILE")
    fi

    if [ ! -d "$UPDATER_SOURCE_DIR/.git" ]; then
        if [ -e "$UPDATER_SOURCE_DIR" ]; then
            error "$UPDATER_SOURCE_DIR exists but is not a Git checkout. Move it aside and re-run."
        fi
        info "Cloning $UPDATER_ORIGIN_URL to $UPDATER_SOURCE_DIR (root-owned)..."
        if ! (
            umask 027
            git "${GIT_CRED_ARGS[@]}" clone --quiet --depth 1 --single-branch \
                --branch "$UPDATE_BRANCH" "$UPDATER_ORIGIN_URL" "$UPDATER_SOURCE_DIR"
        ); then
            warn "git clone of $UPDATER_ORIGIN_URL into $UPDATER_SOURCE_DIR failed."
            if [ -z "$AURORA_GIT_TOKEN_VALUE" ]; then
                warn "  If this is a private repo, set AURORA_GIT_TOKEN=<PAT> and re-run install.sh."
            fi
            warn "  Auto-updater disabled — fix the remote and re-run."
            SKIP_UPDATER=true
        fi
    else
        validate_managed_updater_source
        info "Refreshing existing source mirror at $UPDATER_SOURCE_DIR..."
        git -C "$UPDATER_SOURCE_DIR" remote set-url origin "$UPDATER_ORIGIN_URL"
        # Bootstrap clones start as single-branch checkouts. Expand the mirror's
        # fetch refspec so a later AURORA_UPDATE_BRANCH change creates and
        # refreshes the matching origin/<branch> tracking ref.
        git -C "$UPDATER_SOURCE_DIR" config --replace-all remote.origin.fetch \
            '+refs/heads/*:refs/remotes/origin/*'
        git "${GIT_CRED_ARGS[@]}" -C "$UPDATER_SOURCE_DIR" fetch --quiet --prune origin \
            "+refs/heads/$UPDATE_BRANCH:refs/remotes/origin/$UPDATE_BRANCH" \
            || warn "git fetch in $UPDATER_SOURCE_DIR failed — updater will retry on next tick."
    fi

    # Persist credential.helper=store in the mirror's .git/config
    # so aurora-update.sh's non-interactive fetches just-work. Set
    # at repo scope (not --global) to keep the auth contract
    # narrow: only this one clone uses Aurora's credential file.
    if [ -d "$UPDATER_SOURCE_DIR/.git" ]; then
        # An empty repo-scoped helper resets any inherited system/global
        # helpers. Add Aurora's explicit-file helper only when it exists.
        git -C "$UPDATER_SOURCE_DIR" config --unset-all credential.helper \
            >/dev/null 2>&1 || true
        git -C "$UPDATER_SOURCE_DIR" config --add credential.helper ""
        if [ -f "$GIT_CREDENTIAL_FILE" ]; then
            # Explicit-file form (see comment above) — survives systemd's
            # unset-HOME environment when aurora-update.service fires.
            git -C "$UPDATER_SOURCE_DIR" config --add credential.helper \
                "store --file=$GIT_CREDENTIAL_FILE"
        fi
    fi

    if ! $SKIP_UPDATER; then
        # The private managed source is exclusively for root-run install/update
        # jobs. The public bootstrap is copied into deployed static assets, so
        # the network service never needs read access to this repository.
        chown -R root:root "$UPDATER_SOURCE_DIR"
        chmod -R go-rwx "$UPDATER_SOURCE_DIR"

        install -m 755 "$PROJECT_DIR/scripts/aurora-update.sh" /usr/local/bin/aurora-update
        cp "$PROJECT_DIR/scripts/aurora-update.service" /etc/systemd/system/aurora-update.service
        cp "$PROJECT_DIR/scripts/aurora-update.timer"   /etc/systemd/system/aurora-update.timer
        # 2026-05-19 — aurora-update.path replaces the previous
        # sudoers grant. The aurora user can no longer sudo (its
        # systemd unit has NoNewPrivileges=yes), so the in-app
        # "Update Now" button now writes a trigger file and lets
        # systemd's PathChanged= start the service as root.
        cp "$PROJECT_DIR/scripts/aurora-update.path"    /etc/systemd/system/aurora-update.path

        # Migration cleanup — if a previous install dropped the old
        # sudoers grant in /etc/sudoers.d/, remove it. With the .path
        # unit it's dead weight; leaving it broadens the sudoers
        # surface for nothing.
        #
        # Safety: only remove if the file looks like OUR known fragment
        # (single `aurora ALL=(root) NOPASSWD: ...` lines). If an admin
        # appended unrelated sudoers entries to the same file, leave it
        # alone and warn — destroying their custom rules during an
        # upgrade is worse than the dead-weight cost.
        if [ -f /etc/sudoers.d/aurora-update ]; then
            # Strip CR (defense against a CRLF-saved file), then drop
            # blank lines + comments, then require every remaining
            # line to be one of our known-installed forms. If any
            # line falls outside the whitelist, an admin appended
            # custom rules — leave the file alone and warn.
            if tr -d '\r' < /etc/sudoers.d/aurora-update \
                | awk '!/^[[:space:]]*(#|$)/' \
                | grep -qvE '^aurora ALL=\(root\) NOPASSWD: (/bin|/usr/bin)/systemctl (start|is-active) aurora-update\.service$' \
                2>/dev/null; then
                warn "Legacy /etc/sudoers.d/aurora-update has custom rules — leaving in place."
                warn "  Aurora no longer uses this file; remove the aurora-update lines manually if you want to clean up."
            else
                rm -f /etc/sudoers.d/aurora-update
                ok "Removed legacy sudoers grant (replaced by aurora-update.path)"
            fi
        fi

        # Trigger file used by aurora-update.path. Owned root:aurora
        # 0664 — aurora's group write lets the in-app "Update Now"
        # handler touch it; only root can replace it entirely.
        # systemd's PathChanged= picks up each modification as a
        # fresh trigger event.
        #
        # The /var/lib/aurora directory itself was created up at the
        # "Layout directories" section so aurora.service can start
        # even when the updater is skipped.
        if [ ! -f /var/lib/aurora/trigger-update ]; then
            : > /var/lib/aurora/trigger-update
        fi
        chown root:"$AURORA_GROUP" /var/lib/aurora/trigger-update
        chmod 0664 /var/lib/aurora/trigger-update
        ok "Auto-updater installed: root-owned source at $UPDATER_SOURCE_DIR"
    fi
elif [ ! -f "$PROJECT_DIR/scripts/aurora-update.sh" ]; then
    SKIP_UPDATER=true
    warn "aurora-update.sh not found in scripts/ — skipping auto-updater install."
fi

# Env file. Reinstalls and repairs MERGE installer-managed values into the
# existing file instead of regenerating it. This preserves every operator
# setting (including future keys the installer does not yet know about) while
# still refreshing the DB/source metadata that Aurora owns.
ENV_FILE="$CONFIG_DIR/aurora.env"
ENV_TMP="$CONFIG_DIR/aurora.env.tmp"
EXISTING_JWT="$(aurora_env_get_unquoted "$ENV_FILE" JWT_SECRET 2>/dev/null || true)"
JWT_SECRET="${EXISTING_JWT:-$(rand_string 64)}"

# Normalize the optional public hostname once and reuse the exact value for
# CORS, the HTTPS helper, and the completion summary.
PROXY_DOMAIN="$AURORA_DOMAIN_VALUE"
PROXY_DOMAIN="${PROXY_DOMAIN#*://}"
PROXY_DOMAIN="${PROXY_DOMAIN%%/*}"
if [ -n "$PROXY_DOMAIN" ] \
    && ! printf '%s\n' "$PROXY_DOMAIN" \
        | grep -qE '^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$'; then
    error "AURORA_DOMAIN '$PROXY_DOMAIN' is malformed."
fi

# A repair of an already-working same-domain vhost may keep Secure cookies
# enabled while the installer rebuilds Aurora. A new domain (or a stale/broken
# old HTTPS setup) must start false so a failed certbot attempt cannot leave
# logins unusable on the still-HTTP service.
PRESERVE_EXISTING_HTTPS=false
MANAGED_PROXY_WAS_REMOVED=false
CONSUME_PROXY_REMOVAL_STATE=false
EXISTING_SECURE_COOKIES="$(aurora_env_get_unquoted "$ENV_FILE" AURORA_SECURE_COOKIES 2>/dev/null || true)"
RECORDED_PROXY_DOMAIN=""
if [ -f "$CONFIG_DIR/.proxy-setup" ]; then
    RECORDED_PROXY_DOMAIN="$(head -n 1 "$CONFIG_DIR/.proxy-setup" 2>/dev/null | tr -d '\r' || true)"
    RECORDED_PROXY_DOMAIN="${RECORDED_PROXY_DOMAIN#*://}"
    RECORDED_PROXY_DOMAIN="${RECORDED_PROXY_DOMAIN%%/*}"
    if ! aurora_proxy_domain_is_valid "$RECORDED_PROXY_DOMAIN"; then
        warn "Ignoring malformed proxy marker in $CONFIG_DIR/.proxy-setup"
        RECORDED_PROXY_DOMAIN=""
    fi
fi
ACTIVE_MANAGED_PROXY_CONF=""
ACTIVE_OPERATOR_PROXY_CONF=""
for proxy_candidate in \
    /etc/nginx/sites-available/aurora.conf \
    /etc/nginx/conf.d/aurora.conf; do
    if [ -f "$proxy_candidate" ]; then
        if aurora_proxy_config_is_managed "$proxy_candidate"; then
            ACTIVE_MANAGED_PROXY_CONF="$proxy_candidate"
        else
            ACTIVE_OPERATOR_PROXY_CONF="$proxy_candidate"
        fi
    fi
done
if [ -n "$PROXY_DOMAIN" ] && [ -n "$ACTIVE_OPERATOR_PROXY_CONF" ]; then
    error "$ACTIVE_OPERATOR_PROXY_CONF is operator-managed; refusing to mutate aurora.env for managed AURORA_DOMAIN setup. Use the manual proxy instructions or move/rename that vhost first."
fi
if [ -n "$PROXY_DOMAIN" ] && [ -n "$ACTIVE_MANAGED_PROXY_CONF" ]; then
    if [ -n "$RECORDED_PROXY_DOMAIN" ] \
        && [ "$PROXY_DOMAIN" != "$RECORDED_PROXY_DOMAIN" ]; then
        error "Managed HTTPS is recorded for '$RECORDED_PROXY_DOMAIN'; refusing domain change to '$PROXY_DOMAIN' before configuration mutation. Remove the managed proxy first, then retry."
    fi
    while IFS= read -r configured_domain; do
        [ -z "$configured_domain" ] && continue
        [ "$configured_domain" = "$PROXY_DOMAIN" ] \
            || error "Managed nginx already owns '$configured_domain'; refusing domain change to '$PROXY_DOMAIN'."
    done < <(
        awk '
            /^[[:space:]]*server_name[[:space:]]+/ {
                for (i = 2; i <= NF; i++) {
                    token = $i
                    terminal = (token ~ /;/)
                    sub(/;.*/, "", token)
                    if (token != "" && token != "_") print token
                    if (terminal) break
                }
            }
        ' "$ACTIVE_MANAGED_PROXY_CONF" | sort -u
    )
fi
REMOVED_PROXY_DOMAIN=""
if [ -f "$CONFIG_DIR/.proxy-removed" ]; then
    REMOVED_PROXY_DOMAIN="$(head -n 1 "$CONFIG_DIR/.proxy-removed" 2>/dev/null | tr -d '\r' || true)"
    if aurora_proxy_domain_is_valid "$REMOVED_PROXY_DOMAIN"; then
        CONSUME_PROXY_REMOVAL_STATE=true
        OPERATOR_PROXY_REPLACEMENT=false
        for proxy_candidate in \
            /etc/nginx/sites-available/aurora.conf \
            /etc/nginx/conf.d/aurora.conf; do
            if [ -f "$proxy_candidate" ] \
                && ! aurora_proxy_config_is_managed "$proxy_candidate"; then
                OPERATOR_PROXY_REPLACEMENT=true
                break
            fi
        done
        if $OPERATOR_PROXY_REPLACEMENT \
            || curl -fsS -m 10 --resolve "$REMOVED_PROXY_DOMAIN:443:127.0.0.1" \
                "https://$REMOVED_PROXY_DOMAIN/api/health" >/dev/null 2>&1; then
            info "Detected a replacement operator-managed proxy for $REMOVED_PROXY_DOMAIN; preserving its env settings."
        else
            MANAGED_PROXY_WAS_REMOVED=true
        fi
    else
        warn "Ignoring malformed proxy-removal marker in $CONFIG_DIR/.proxy-removed"
        REMOVED_PROXY_DOMAIN=""
    fi
elif [ -n "$RECORDED_PROXY_DOMAIN" ] \
    && [ ! -f /etc/nginx/sites-available/aurora.conf ] \
    && [ ! -f /etc/nginx/conf.d/aurora.conf ]; then
    # Upgrade bridge for safe uninstalls from older revisions: they retained
    # .proxy-setup + Secure cookies but removed the managed nginx vhost.
    MANAGED_PROXY_WAS_REMOVED=true
    REMOVED_PROXY_DOMAIN="$RECORDED_PROXY_DOMAIN"
fi
PRESERVE_RECORDED_MANAGED_HTTPS=false
if [ -z "$PROXY_DOMAIN" ] \
    && [ -n "$RECORDED_PROXY_DOMAIN" ] \
    && [ -n "$ACTIVE_MANAGED_PROXY_CONF" ] \
    && curl -fsS -m 10 --resolve "$RECORDED_PROXY_DOMAIN:443:127.0.0.1" \
        "https://$RECORDED_PROXY_DOMAIN/api/health" >/dev/null 2>&1; then
    PRESERVE_RECORDED_MANAGED_HTTPS=true
    info "Verified retained managed HTTPS for $RECORDED_PROXY_DOMAIN; preserving proxy policy and backfilling trusted loopback proxies."
fi
if [ -n "$PROXY_DOMAIN" ] \
    && [ "$PROXY_DOMAIN" = "$RECORDED_PROXY_DOMAIN" ] \
    && [ "$EXISTING_SECURE_COOKIES" = "true" ] \
    && curl -fsS -m 10 --resolve "$PROXY_DOMAIN:443:127.0.0.1" \
        "https://$PROXY_DOMAIN/api/health" >/dev/null 2>&1; then
    PRESERVE_EXISTING_HTTPS=true
    info "Verified existing HTTPS for $PROXY_DOMAIN; preserving Secure-cookie mode during repair"
fi

info "Merging configuration into $ENV_FILE..."
HAD_EXISTING_ENV=false
if [ -f "$ENV_FILE" ]; then
    HAD_EXISTING_ENV=true
    cp -p "$ENV_FILE" "$CONFIG_DIR/aurora.env.bak"
    cp "$ENV_FILE" "$ENV_TMP"
else
    (
        umask 077
        cat > "$ENV_TMP" <<EOF
# Aurora Media Server — created $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# Edit values and run "systemctl restart aurora" to apply changes.
# Re-running the installer preserves existing and unknown keys.

DATABASE_URL=
JWT_SECRET=
TMDB_API_KEY=
AURORA_SOURCE_DIR=
AURORA_UPDATE_BRANCH=main
AURORA_UPDATE_REQUIRE_SIGNED=false
AURORA_UPDATE_ALLOWED_SIGNERS=
CACHE_IMAGE_DIR=$CACHE_DIR/images
CACHE_TRANSCODE_DIR=$TRANSCODE_DIR
CACHE_SUBTITLE_DIR=$CACHE_DIR/subtitles
AURORA_ALLOWED_ORIGINS=http://localhost:*,https://localhost:*
AURORA_SECURE_COOKIES=false
AURORA_TRUSTED_PROXIES=
LOG_DIR=$LOG_DIR
LOG_LEVEL=info
EOF
    )
fi

# Required installer-owned values.
aurora_env_upsert "$ENV_TMP" DATABASE_URL "$DB_URL"
aurora_env_upsert "$ENV_TMP" JWT_SECRET "$JWT_SECRET"
aurora_env_upsert "$ENV_TMP" TMDB_API_KEY "$TMDB_KEY"
aurora_env_upsert "$ENV_TMP" AURORA_SOURCE_DIR "$UPDATER_SOURCE_DIR"
aurora_env_upsert "$ENV_TMP" AURORA_UPDATE_BRANCH "$UPDATE_BRANCH"
if [ -n "$UPDATER_ORIGIN_URL" ]; then
    aurora_env_upsert "$ENV_TMP" AURORA_EXPECTED_REMOTE "$UPDATER_ORIGIN_URL"
fi

# Preserve security/update policy unless the operator explicitly supplied a
# replacement for this run.
if [ "${AURORA_UPDATE_REQUIRE_SIGNED+x}" = x ]; then
    aurora_env_upsert "$ENV_TMP" AURORA_UPDATE_REQUIRE_SIGNED "$AURORA_UPDATE_REQUIRE_SIGNED"
else
    aurora_env_ensure "$ENV_TMP" AURORA_UPDATE_REQUIRE_SIGNED "false"
fi
if [ "${AURORA_UPDATE_ALLOWED_SIGNERS+x}" = x ]; then
    aurora_env_upsert "$ENV_TMP" AURORA_UPDATE_ALLOWED_SIGNERS "$AURORA_UPDATE_ALLOWED_SIGNERS"
else
    aurora_env_ensure "$ENV_TMP" AURORA_UPDATE_ALLOWED_SIGNERS ""
fi

# Defaults are only added when missing; customized paths and logging survive.
aurora_env_ensure "$ENV_TMP" CACHE_IMAGE_DIR "$CACHE_DIR/images"
aurora_env_ensure "$ENV_TMP" CACHE_TRANSCODE_DIR "$TRANSCODE_DIR"
aurora_env_ensure "$ENV_TMP" CACHE_SUBTITLE_DIR "$CACHE_DIR/subtitles"
aurora_env_ensure "$ENV_TMP" LOG_DIR "$LOG_DIR"
aurora_env_ensure "$ENV_TMP" LOG_LEVEL "info"

# Pin CORS as soon as a domain is requested. Secure cookies are enabled only
# after setup-domain.sh verifies TLS, except for a verified same-domain repair.
if [ -n "$PROXY_DOMAIN" ]; then
    aurora_env_upsert "$ENV_TMP" AURORA_ALLOWED_ORIGINS "https://$PROXY_DOMAIN"
    aurora_env_upsert "$ENV_TMP" AURORA_TRUSTED_PROXIES "127.0.0.1/32,::1/128"
    if $PRESERVE_EXISTING_HTTPS; then
        aurora_env_upsert "$ENV_TMP" AURORA_SECURE_COOKIES "true"
    else
        aurora_env_upsert "$ENV_TMP" AURORA_SECURE_COOKIES "false"
    fi
else
    if $PRESERVE_RECORDED_MANAGED_HTTPS; then
        aurora_env_ensure "$ENV_TMP" AURORA_ALLOWED_ORIGINS \
            "https://$RECORDED_PROXY_DOMAIN"
        aurora_env_ensure "$ENV_TMP" AURORA_SECURE_COOKIES "true"
        aurora_env_upsert "$ENV_TMP" AURORA_TRUSTED_PROXIES \
            "127.0.0.1/32,::1/128"
    elif $MANAGED_PROXY_WAS_REMOVED; then
        # A safe uninstall removes only an Aurora-managed nginx vhost while
        # retaining aurora.env and its certificate. Force the retained config
        # back to usable direct-HTTP settings; merely "ensuring" these keys
        # would preserve Secure=true and make login cookies disappear.
        aurora_env_upsert "$ENV_TMP" AURORA_ALLOWED_ORIGINS "http://localhost:*,https://localhost:*"
        aurora_env_upsert "$ENV_TMP" AURORA_SECURE_COOKIES "false"
        aurora_env_upsert "$ENV_TMP" AURORA_TRUSTED_PROXIES ""
        warn "The managed HTTPS proxy for $REMOVED_PROXY_DOMAIN was removed during uninstall."
        warn "This repair will use direct HTTP. Pass AURORA_DOMAIN + AURORA_CERTBOT_EMAIL to restore HTTPS."
    else
        # No Aurora-managed proxy transition occurred. Preserve intentional
        # manual/external reverse-proxy settings already in the env file.
        aurora_env_ensure "$ENV_TMP" AURORA_ALLOWED_ORIGINS "http://localhost:*,https://localhost:*"
        aurora_env_ensure "$ENV_TMP" AURORA_SECURE_COOKIES "false"
        aurora_env_ensure "$ENV_TMP" AURORA_TRUSTED_PROXIES ""
    fi
fi

# Optional metadata and ARR integration only change when supplied. Existing
# LLM, OAuth, TURN, bug-report, transcoding, and other custom keys remain.
if [ -n "$AURORA_TVDB_API_KEY_VALUE" ]; then
    aurora_env_upsert "$ENV_TMP" TVDB_API_KEY "$AURORA_TVDB_API_KEY_VALUE"
    aurora_env_upsert "$ENV_TMP" TVDB_PIN "$AURORA_TVDB_PIN_VALUE"
    aurora_env_upsert "$ENV_TMP" TVDB_ENABLED "true"
fi
if [ -n "$AURORA_RADARR_URL_VALUE" ] || [ -n "$AURORA_SONARR_URL_VALUE" ] \
    || [ -n "$AURORA_RADARR_4K_URL_VALUE" ] || [ -n "$AURORA_SONARR_4K_URL_VALUE" ]; then
    aurora_env_upsert "$ENV_TMP" REQUESTS_ENABLED "true"
    [ -n "$AURORA_RADARR_URL_VALUE" ] && aurora_env_upsert "$ENV_TMP" RADARR_URL "$AURORA_RADARR_URL_VALUE"
    [ -n "$AURORA_RADARR_API_KEY_VALUE" ] && aurora_env_upsert "$ENV_TMP" RADARR_API_KEY "$AURORA_RADARR_API_KEY_VALUE"
    [ -n "$AURORA_RADARR_4K_URL_VALUE" ] && aurora_env_upsert "$ENV_TMP" RADARR_4K_URL "$AURORA_RADARR_4K_URL_VALUE"
    [ -n "$AURORA_RADARR_4K_API_KEY_VALUE" ] && aurora_env_upsert "$ENV_TMP" RADARR_4K_API_KEY "$AURORA_RADARR_4K_API_KEY_VALUE"
    [ -n "$AURORA_SONARR_URL_VALUE" ] && aurora_env_upsert "$ENV_TMP" SONARR_URL "$AURORA_SONARR_URL_VALUE"
    [ -n "$AURORA_SONARR_API_KEY_VALUE" ] && aurora_env_upsert "$ENV_TMP" SONARR_API_KEY "$AURORA_SONARR_API_KEY_VALUE"
    [ -n "$AURORA_SONARR_4K_URL_VALUE" ] && aurora_env_upsert "$ENV_TMP" SONARR_4K_URL "$AURORA_SONARR_4K_URL_VALUE"
    [ -n "$AURORA_SONARR_4K_API_KEY_VALUE" ] && aurora_env_upsert "$ENV_TMP" SONARR_4K_API_KEY "$AURORA_SONARR_4K_API_KEY_VALUE"
fi

chmod 0640 "$ENV_TMP"
chown root:"$AURORA_GROUP" "$ENV_TMP"
# Atomic rename: concurrent readers see either the complete old file or the
# complete merged file, never a partially-written configuration.
mv -f "$ENV_TMP" "$ENV_FILE"
if $HAD_EXISTING_ENV; then
    ok "Configuration merged (backup: $CONFIG_DIR/aurora.env.bak)"
else
    ok "Configuration created"
fi
if [ -z "$PROXY_DOMAIN" ] \
    && { $MANAGED_PROXY_WAS_REMOVED || $CONSUME_PROXY_REMOVAL_STATE; }; then
    rm -f "$CONFIG_DIR/.proxy-removed" "$CONFIG_DIR/.proxy-setup"
    if ! $MANAGED_PROXY_WAS_REMOVED; then
        rm -f "$PROXY_REMOVAL_PROVENANCE_MARKER"
    fi
    ok "Consumed managed-proxy removal state after resetting direct-HTTP settings"
fi

# ── Media directory access ────────────────────────────────────────
# Aurora runs as the unprivileged `aurora` system user. When the
# operator's media lives under their home dir (e.g.
# /home/ronnie/medialibrary), the default mode-0700 on /home/ronnie
# blocks aurora from even traversing INTO that directory, let alone
# reading files. The library-create API then returns "path does not
# exist" because EvalSymlinks fails with permission-denied.
#
# This block walks the directory chain from the media root up to /,
# granting aurora a `u:aurora:x` ACL on every ancestor it can't
# currently traverse, then `u:aurora:rX` (read+traverse, no exec
# bit on regular files) recursively on the media tree itself. The
# `-d` (default) ACL ensures new files dropped in later inherit
# aurora access without re-running the installer.
#
# We verify the result with `sudo -u aurora test -r/-x` rather than
# just trusting the setfacl exit code — that catches edge cases
# where setfacl "succeeds" but the underlying filesystem ignores
# the ACL (e.g. some older NFS mounts, certain CIFS configurations).

# Walk from $1 up to /, granting aurora traversal where missing.
ensure_aurora_traversal() {
    local current="$1"
    while [ "$current" != "/" ] && [ -n "$current" ] && [ "$current" != "." ]; do
        # If aurora already has execute (= traverse) bit, skip.
        if sudo -u "$AURORA_USER" test -x "$current" 2>/dev/null; then
            current="$(dirname "$current")"
            continue
        fi
        if command -v setfacl &>/dev/null; then
            if setfacl -m "u:${AURORA_USER}:x" "$current" 2>/dev/null; then
                info "  Granted traverse on $current"
            else
                warn "  setfacl failed on $current — fallback to chmod o+x (broader access)"
                # Audit H4 — chmod o+x grants traversal to EVERY
                # local user on the system. On /home/* this means
                # every user can `cd` into someone else's home dir
                # (read-protected files are still safe, but they
                # can see filenames in the path). Acceptable on a
                # single-user self-hosted box, but call it out so
                # operators on shared systems can make an informed
                # choice.
                case "$current" in
                    /home/*)
                        warn "    ⚠ NOTE: $current is now traversable by all local users."
                        warn "    On a multi-user system, consider moving media to /srv/media instead."
                        ;;
                esac
                chmod o+x "$current" 2>/dev/null || warn "  chmod o+x also failed on $current"
            fi
        else
            # No ACL support — only option is world-traversable, which
            # is a privacy loss but unblocks the install.
            case "$current" in
                /home/*) warn "  chmod o+x on $current — traversable by all local users (no ACL support detected)." ;;
            esac
            chmod o+x "$current" 2>/dev/null || warn "  chmod o+x failed on $current"
        fi
        current="$(dirname "$current")"
    done
}

setup_media_access() {
    local requested_path="$1" media_path rejection
    media_path="$requested_path"
    [ -z "$media_path" ] && return
    if [ ! -d "$media_path" ]; then
        warn "Media directory '$media_path' does not exist — skipping ACL setup. Create it and re-run install.sh, or use the in-app library form once aurora is running."
        return
    fi

    media_path="$(readlink -f -- "$media_path" 2>/dev/null || true)"
    if [ -z "$media_path" ]; then
        warn "Could not canonicalize media directory '$requested_path' — refusing ACL changes."
        return 1
    fi
    if rejection="$(aurora_media_root_rejection_reason "$media_path")"; then
        warn "Refusing media ACL changes for '$requested_path': $rejection."
        warn "Choose a dedicated directory such as /srv/media, /mnt/nas/media, or /home/<user>/media."
        return 1
    fi
    # Keep a durable root-owned target list so uninstall can reverse ACLs even
    # when an external database cannot be queried, or after a library was
    # removed from the DB. Record it before the first mutation so an interrupt
    # during a recursive ACL operation still leaves an exact cleanup root.
    persist_managed_media_path "$media_path" || return 1

    info "Granting aurora read access to $media_path..."

    # Step 1: traverse ACLs on all parent directories. Critical for
    # any path under /home/<user>/ where the home dir is mode 0700.
    ensure_aurora_traversal "$(dirname "$media_path")"

    # Step 2: read+traverse on the media tree itself. `X` (uppercase)
    # is the smart variant — adds execute to dirs but NOT to regular
    # files. Without it, every video file would get the +x bit.
    #
    # `acl_supported` tracks whether the filesystem actually accepts
    # ACL ops. We probe it by reading setfacl's exit code on the
    # recursive set. If the filesystem rejects ACLs ("Operation not
    # supported" on NFS without `acl` mount option, ntfs-3g, etc),
    # we skip the subsequent default-ACL call entirely instead of
    # re-spamming stderr with the same errors. The chmod fallback
    # is what actually grants access in that case.
    local acl_supported=true
    if command -v setfacl &>/dev/null; then
        if ! setfacl -R -m "u:${AURORA_USER}:rX" "$media_path" 2>/dev/null; then
            warn "  setfacl -R on $media_path failed (filesystem may not support ACLs) — falling back to chmod o+rX"
            chmod -R o+rX "$media_path" 2>/dev/null || warn "  chmod -R also failed"
            acl_supported=false
        fi
        # Default ACL — new files inherit aurora access automatically.
        # Without this, every newly-added video would need a fresh
        # setfacl pass. SKIPPED when the filesystem already rejected
        # the recursive ACL (would just re-emit the same error for
        # every path).
        if $acl_supported; then
            setfacl -dR -m "u:${AURORA_USER}:rX" "$media_path" 2>/dev/null \
                || warn "  default ACL set failed (filesystem may not support default ACLs)"
        else
            warn "  Skipping default-ACL inheritance (filesystem doesn't support ACLs)."
            warn "  New media added to $media_path after install will need 'chmod o+rX' re-applied."
            warn "  Tip: add a cron job, or remount with the 'acl' option if your filesystem supports it."
        fi
    else
        warn "  setfacl not installed — using chmod o+rX (broader access). Install the 'acl' package for tighter perms."
        chmod -R o+rX "$media_path" 2>/dev/null || warn "  chmod -R failed"
    fi

    # Step 3: verify aurora can actually see it. catches NFS / CIFS
    # ACL-ignoring edge cases that setfacl returns 0 on but don't
    # actually grant access. Audit H1 — verify the DEEPEST visible
    # subdirectory, not just the top-level. The Library form's
    # Go-side EvalSymlinks runs against the full library path the
    # user types (typically a subdirectory like .../medialibrary/movies),
    # so a partial setfacl -R failure mid-walk would leave the top-
    # level test passing while EvalSymlinks still permission-denies
    # the descendant.
    local deepest="$media_path"
    # Find the first subdirectory under $media_path (depth 1) to
    # exercise traversal + read on a descendant. If $media_path has
    # no subdirs (empty library), the top-level test alone is fine.
    local sub
    sub="$(find "$media_path" -mindepth 1 -maxdepth 2 -type d 2>/dev/null | head -1 || true)"
    [ -n "$sub" ] && deepest="$sub"
    if sudo -u "$AURORA_USER" test -r "$media_path" \
        && sudo -u "$AURORA_USER" test -x "$media_path" \
        && sudo -u "$AURORA_USER" test -r "$deepest" \
        && sudo -u "$AURORA_USER" test -x "$deepest"; then
        if [ "$deepest" != "$media_path" ]; then
            ok "Aurora can read $media_path (verified down to $deepest)"
        else
            ok "Aurora can read $media_path"
        fi
    else
        warn "═══════════════════════════════════════════════════════════════════"
        warn " Aurora STILL cannot read $media_path after ACL setup."
        warn " The Library form in the admin UI will fail with 'path does not"
        warn " exist'. Possible causes:"
        warn "  • Filesystem doesn't support POSIX ACLs (NFS noacl, ntfs-3g)"
        warn "  • SELinux is enforcing and blocking aurora's access"
        warn "  • A parent directory's mode is more restrictive than 0700"
        warn ""
        warn " Workarounds:"
        warn "  • Move media to /srv/media (aurora-friendly, no ACL gymnastics)"
        warn "  • chmod -R o+rX $media_path (less secure but always works)"
        warn "  • Run aurora as a different user (edit /etc/systemd/system/aurora.service)"
        warn "═══════════════════════════════════════════════════════════════════"
    fi
}

# Resolve media directories from explicit input and the retained database.
#
# Multi-path support — Aurora's library model supports multiple paths
# per library (typical use: local disk + NFS mount). The prompt and
# env var both accept comma-separated input; we loop setup_media_access
# over each. Whitespace around the commas is stripped so users can
# paste from a comma+space list (the input field placeholder in the
# admin UI hints at this format).
MEDIA_DIR="$AURORA_MEDIA_DIR_VALUE"
if [ -z "$MEDIA_DIR" ] && [ -t 0 ]; then
    echo ""
    info "Optional: configure read access for media directories now."
    # Audit H2 — $SUDO_USER is set unconditionally by sudo and is the
    # reliable way to get the invoking user. `logname` is unreliable
    # under sudo on systems where /dev/tty isn't owned by the
    # invoker; it can return "no login name" → fallback printed
    # `/home/you/media` which was misleading.
    EXAMPLE_USER="${SUDO_USER:-$(logname 2>/dev/null || echo you)}"
    echo "  Examples:"
    echo "    /srv/media"
    echo "    /home/${EXAMPLE_USER}/media"
    echo "    /home/${EXAMPLE_USER}/media, /nfs/${EXAMPLE_USER}/media   (comma-separated for multiple)"
    echo "  Leave empty to skip (you can configure libraries from the admin UI later)."
    printf '\033[1;36m[?]\033[0m Media directory path(s) (or empty to skip): '
    read -r MEDIA_DIR || true
fi

# Keep an exact, deduplicated path list. Database paths are separate TEXT[]
# values and therefore are not comma-split; explicit input retains the
# documented comma-separated format.
MEDIA_PATHS_TO_CONFIGURE=()
MEDIA_PATH_SOURCES=()

append_media_path() {
    local candidate="$1" source="$2" existing
    [ -n "$candidate" ] || return 0
    for existing in "${MEDIA_PATHS_TO_CONFIGURE[@]}"; do
        [ "$existing" = "$candidate" ] && return 0
    done
    MEDIA_PATHS_TO_CONFIGURE+=("$candidate")
    MEDIA_PATH_SOURCES+=("$source")
}

if [ -n "$MEDIA_DIR" ]; then
    remaining_media="$MEDIA_DIR"
    while :; do
        case "$remaining_media" in
            *,*)
                raw_path="${remaining_media%%,*}"
                remaining_media="${remaining_media#*,}"
                ;;
            *)
                raw_path="$remaining_media"
                remaining_media=""
                ;;
        esac
        trimmed_path="$(aurora_trim_horizontal_whitespace "$raw_path")"
        append_media_path "$trimmed_path" "AURORA_MEDIA_DIR"
        [ -n "$remaining_media" ] || break
    done
fi

# Safe uninstall deliberately removes the old service user's named ACL entries
# before deleting that account. When the database is retained, replay every
# persisted library root for the newly-created service identity. Query as the
# local postgres administrator, read-only, only when DATABASE_URL points to the
# installer-managed local Aurora database; never guess against an external DB.
load_retained_library_paths() {
    local table_exists output_file retained_path retained_count
    retained_count=0

    if ! $DB_TARGET_LOCAL || ! $DB_OWNERSHIP_VALID \
        || ! aurora_database_url_is_local_database "$DB_URL" "$DB_NAME"; then
        info "External PostgreSQL detected; automatic media-ACL replay is skipped."
        warn "Pass AURORA_MEDIA_DIR with the external database's library roots when repairing this host."
        return 0
    fi
    if ! command -v psql >/dev/null 2>&1 \
        || ! sudo -u postgres psql -X -qAt -v ON_ERROR_STOP=1 \
            -d "$DB_NAME" -c 'SELECT 1' >/dev/null 2>&1; then
        warn "Could not read the retained Aurora database; automatic media-ACL replay is skipped."
        return 0
    fi

    table_exists="$(
        sudo -u postgres psql -X -qAt -v ON_ERROR_STOP=1 -d "$DB_NAME" \
            -c "SELECT to_regclass('public.libraries') IS NOT NULL;" \
            2>/dev/null || true
    )"
    [ "$table_exists" = "t" ] || return 0

    output_file="$(mktemp)"
    chmod 0600 "$output_file"
    # shellcheck disable=SC2024 # the installer itself is already root; root owns the redirection
    if ! sudo -u postgres psql -X -qAt -0 -v ON_ERROR_STOP=1 -d "$DB_NAME" \
        -c "SELECT DISTINCT p
              FROM libraries
              CROSS JOIN LATERAL unnest(paths) AS u(p)
             WHERE p IS NOT NULL AND p <> ''
             ORDER BY p;" > "$output_file" 2>/dev/null; then
        rm -f "$output_file"
        warn "Could not enumerate retained library paths; automatic media-ACL replay is skipped."
        return 0
    fi
    while IFS= read -r -d '' retained_path; do
        append_media_path "$retained_path" "retained database"
        retained_count=$((retained_count + 1))
    done < "$output_file"
    rm -f "$output_file"

    if [ "$retained_count" -gt 0 ]; then
        info "Found $retained_count persisted media path(s); replaying least-privilege access for the aurora user."
    fi
}

load_retained_library_paths

persist_managed_media_path() {
    local canonical_path="$1" existing temp_file
    local -a recorded_paths=()
    [ -n "$canonical_path" ] || return 0
    [ ! -L "$MANAGED_MEDIA_PATHS_FILE" ] \
        || error "$MANAGED_MEDIA_PATHS_FILE is a symlink; refusing unsafe ACL-state write."
    if [ -f "$MANAGED_MEDIA_PATHS_FILE" ]; then
        while IFS= read -r -d '' existing; do
            [ "$existing" = "$canonical_path" ] && return 0
            recorded_paths+=("$existing")
        done < "$MANAGED_MEDIA_PATHS_FILE"
    fi
    recorded_paths+=("$canonical_path")
    temp_file="$MANAGED_MEDIA_PATHS_FILE.tmp"
    : > "$temp_file"
    chmod 0600 "$temp_file"
    chown root:root "$temp_file"
    for existing in "${recorded_paths[@]}"; do
        printf '%s\0' "$existing" >> "$temp_file"
    done
    mv -f "$temp_file" "$MANAGED_MEDIA_PATHS_FILE"
}

MEDIA_ACCESS_FAILED=false
for media_index in "${!MEDIA_PATHS_TO_CONFIGURE[@]}"; do
    info "Media path source: ${MEDIA_PATH_SOURCES[$media_index]}"
    if ! setup_media_access "${MEDIA_PATHS_TO_CONFIGURE[$media_index]}"; then
        MEDIA_ACCESS_FAILED=true
    fi
done
if $MEDIA_ACCESS_FAILED; then
    error "One or more media paths were unsafe. No ACLs were applied to those roots; correct the paths and re-run the installer."
fi

# Deployed code/static/migrations are root-owned and immutable to the service
# account. A compromised Aurora process may write cache/log/state, but cannot
# replace assets that root will serve or execute on the next restart.
chown -R root:root "$INSTALL_DIR"
chmod -R go-w "$INSTALL_DIR"
chown -R "$AURORA_USER:$AURORA_GROUP" "$CACHE_DIR"
ok "Installed files locked to root; runtime cache owned by aurora"

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
    if aurora_health_ready http://localhost:8484/api/health 2; then
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
    ok "Aurora service is healthy (/api/health reports status=ok and database connected)"

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
    EXPECTED_COUNT="$(find "$INSTALL_DIR/migrations" -maxdepth 1 -type f -name '*.up.sql' -print 2>/dev/null | wc -l | tr -d '[:space:]')"
    if $DB_TARGET_LOCAL && $DB_OWNERSHIP_VALID; then
        APPLIED_COUNT="$(sudo -u postgres psql -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM schema_migrations" 2>/dev/null | tr -d '[:space:]' || echo "")"
        if [ -z "$APPLIED_COUNT" ]; then
            warn "schema_migrations table not found — Aurora hasn't run its first-boot migrations yet. This is OK if the service just started; check 'sudo systemctl status aurora'."
        elif [ "$APPLIED_COUNT" -eq "$EXPECTED_COUNT" ] 2>/dev/null; then
            ok "All $EXPECTED_COUNT migrations applied successfully"
        else
            warn "Applied $APPLIED_COUNT of $EXPECTED_COUNT migrations — schema is incomplete."
            warn "Tail the log to see which migration failed: sudo journalctl -u aurora -n 50"
        fi
    else
        info "External/non-default PostgreSQL target: skipping local superuser migration-count query."
    fi
elif systemctl is-active aurora &>/dev/null; then
    # Service is still running, just slow to come up. Show the user
    # the last journal output so they can see whether migrations are
    # progressing or something's hung.
    warn "Service is active but /api/health did not report a ready database within 30s."
    warn "Showing last 20 journal lines for context:"
    journalctl -u aurora -n 20 --no-pager 2>/dev/null | sed 's/^/  /'
    warn ""
    warn "The process is running, but installation is not complete until /api/health reports status=ok and db_connected=true."
    warn "Tail with: sudo journalctl -u aurora -f"
else
    warn "Aurora service unexpectedly stopped during start. journalctl:"
    journalctl -u aurora -n 40 --no-pager 2>/dev/null | sed 's/^/  /'
fi

# Record the commit that actually reached a healthy service. The updater uses
# this marker instead of source-checkout HEAD so a failed future deployment is
# retried even when its fetched commit is already checked out.
if $HEALTHY && DEPLOYED_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null)"; then
    printf '%s\n' "$DEPLOYED_SHA" > /var/lib/aurora/deployed-revision.tmp
    chmod 0644 /var/lib/aurora/deployed-revision.tmp
    chown root:root /var/lib/aurora/deployed-revision.tmp
    mv -f /var/lib/aurora/deployed-revision.tmp /var/lib/aurora/deployed-revision
    ok "Recorded deployed revision $DEPLOYED_SHA"
fi

# Arm automated updates only after the installed revision has passed the
# health check and its marker is durable. This prevents a timer race from
# treating an unverified first install as deployed.
UPDATER_ACTIVATION_FAILED=false
if $HEALTHY && $SKIP_UPDATER; then
    UPDATER_ACTIVATION_FAILED=true
    systemctl disable --now aurora-update.timer aurora-update.path 2>/dev/null || true
    warn "Updater setup was skipped or failed, so installation is incomplete."
    warn "Repair the Git origin/source mirror, then rerun the full installer."
elif $HEALTHY; then
    if [ -f /etc/systemd/system/aurora-update.timer ]; then
        if systemctl enable --now aurora-update.timer >/dev/null 2>&1 \
            && systemctl is-active aurora-update.timer >/dev/null 2>&1; then
            ok "Auto-update timer armed (next check in ~2 min, every 5 min after)"
        else
            UPDATER_ACTIVATION_FAILED=true
            warn "Failed to enable/start aurora-update.timer."
        fi
    else
        UPDATER_ACTIVATION_FAILED=true
        warn "aurora-update.timer is missing."
    fi
    if [ -f /etc/systemd/system/aurora-update.path ]; then
        if systemctl enable --now aurora-update.path >/dev/null 2>&1 \
            && systemctl is-active aurora-update.path >/dev/null 2>&1; then
            ok "Update-trigger watcher armed (aurora-update.path)"
        else
            UPDATER_ACTIVATION_FAILED=true
            warn "Failed to enable/start aurora-update.path."
        fi
    else
        UPDATER_ACTIVATION_FAILED=true
        warn "aurora-update.path is missing."
    fi
    if $UPDATER_ACTIVATION_FAILED; then
        systemctl disable --now aurora-update.timer aurora-update.path 2>/dev/null || true
        warn "Automatic/manual update triggers were disabled as a set."
        warn "Inspect systemctl status, then rerun the full installer."
    fi
elif [ -f /etc/systemd/system/aurora-update.timer ] \
    || [ -f /etc/systemd/system/aurora-update.path ]; then
    systemctl disable --now aurora-update.timer aurora-update.path 2>/dev/null || true
    if $SKIP_UPDATER; then
        warn "Existing auto-update triggers were disabled because updater setup was skipped or failed."
        warn "Repair the Git origin/source mirror, then re-run the installer."
    else
        warn "Auto-updater installed but disabled because /api/health did not pass."
        warn "Re-run the installer after Aurora is healthy."
    fi
fi

# ══════════════════════════════════════════════════════════════════
# STEP 5: Optional reverse proxy (HTTPS) — only if AURORA_DOMAIN is set
# ══════════════════════════════════════════════════════════════════
PROXY_SETUP_OK=false
HTTPS_SETUP_FAILED=false

if $HEALTHY && [ -n "$PROXY_DOMAIN" ]; then
    step "Step 5/5: Configuring HTTPS reverse proxy for $PROXY_DOMAIN"

    CERTBOT_EMAIL="$AURORA_CERTBOT_EMAIL_VALUE"
    if [ -z "$CERTBOT_EMAIL" ]; then
        HTTPS_SETUP_FAILED=true
        warn "AURORA_DOMAIN is set but AURORA_CERTBOT_EMAIL is not — HTTPS setup is incomplete."
    else
        if DOMAIN="$PROXY_DOMAIN" EMAIL="$CERTBOT_EMAIL" \
            "$PROJECT_DIR/scripts/setup-domain.sh"; then
            PROXY_SETUP_OK=true
            rm -f "$CONFIG_DIR/.proxy-removed"
        else
            HTTPS_SETUP_FAILED=true
            warn "HTTPS setup did not complete. Aurora is installed, but the requested proxy state needs attention."
            warn "Retry with: sudo DOMAIN=$PROXY_DOMAIN EMAIL=$CERTBOT_EMAIL $PROJECT_DIR/scripts/setup-domain.sh"
        fi
    fi
fi

if $HTTPS_SETUP_FAILED; then
    systemctl disable --now aurora-update.timer aurora-update.path 2>/dev/null || true
    warn "Auto-updates were disabled because the explicitly requested HTTPS setup is incomplete."
    warn "Repair HTTPS, then rerun the full installer to re-arm updates."

    if ! $PRESERVE_EXISTING_HTTPS; then
        warn "Restoring direct-HTTP application settings after HTTPS setup failure..."
        aurora_env_upsert "$ENV_FILE" AURORA_ALLOWED_ORIGINS \
            "http://localhost:*,https://localhost:*"
        aurora_env_upsert "$ENV_FILE" AURORA_SECURE_COOKIES "false"
        aurora_env_upsert "$ENV_FILE" AURORA_TRUSTED_PROXIES ""
        chmod 0640 "$ENV_FILE"
        chown root:"$AURORA_GROUP" "$ENV_FILE"
        if ! systemctl restart aurora >/dev/null 2>&1; then
            HEALTHY=false
            warn "Aurora failed to restart after restoring direct-HTTP settings."
        else
            DIRECT_HTTP_HEALTHY=false
            for _ in $(seq 1 15); do
                if aurora_health_ready http://localhost:8484/api/health 2; then
                    DIRECT_HTTP_HEALTHY=true
                    break
                fi
                sleep 1
            done
            if ! $DIRECT_HTTP_HEALTHY; then
                HEALTHY=false
                warn "Aurora did not become healthy after restoring direct-HTTP settings."
            else
                ok "Direct-HTTP settings restored; HTTPS still requires repair"
            fi
        fi
    fi
fi

# setup-domain may restart Aurora while applying Secure-cookie settings. Do not
# report a successful installation from the earlier health result if that
# final transition (or its rollback) left the service unavailable.
if $HEALTHY; then
    POST_SETUP_HEALTHY=false
    for _ in $(seq 1 10); do
        if aurora_health_ready http://localhost:8484/api/health 2; then
            POST_SETUP_HEALTHY=true
            break
        fi
        sleep 1
    done
    if ! $POST_SETUP_HEALTHY; then
        HEALTHY=false
        PROXY_SETUP_OK=false
        systemctl disable --now aurora-update.timer aurora-update.path 2>/dev/null || true
        warn "Aurora did not pass its final health check after proxy configuration."
        warn "Auto-updates were disabled; inspect 'journalctl -u aurora -n 80' and re-run the installer."
    fi
fi

trap - INT TERM

# ══════════════════════════════════════════════════════════════════
# Done
# ══════════════════════════════════════════════════════════════════
echo ""
echo "  ============================================================"
if $HEALTHY && ! $HTTPS_SETUP_FAILED && ! $UPDATER_ACTIVATION_FAILED; then
    echo "   Aurora Media Server — Ready"
elif $HEALTHY && $UPDATER_ACTIVATION_FAILED; then
    echo "   Aurora Media Server — Installed (update activation incomplete)"
elif $HEALTHY; then
    echo "   Aurora Media Server — Installed (HTTPS setup incomplete)"
else
    echo "   Aurora Media Server — Installed (health check failed)"
fi
echo "  ============================================================"
echo ""

if $HEALTHY; then
    SERVER_IPV4="$(detect_server_ipv4 || true)"
    DISPLAY_HTTPS_DOMAIN=""
    if $PROXY_SETUP_OK; then
        DISPLAY_HTTPS_DOMAIN="$PROXY_DOMAIN"
    elif [ -n "$RECORDED_PROXY_DOMAIN" ] \
        && { [ -z "$PROXY_DOMAIN" ] || [ "$PROXY_DOMAIN" = "$RECORDED_PROXY_DOMAIN" ]; } \
        && curl -fsS -m 10 --resolve "$RECORDED_PROXY_DOMAIN:443:127.0.0.1" \
            "https://$RECORDED_PROXY_DOMAIN/api/health" >/dev/null 2>&1; then
        DISPLAY_HTTPS_DOMAIN="$RECORDED_PROXY_DOMAIN"
    fi
    echo "  Open Aurora:"
    echo ""
    if [ -n "$DISPLAY_HTTPS_DOMAIN" ]; then
        echo "    HTTPS:       https://${DISPLAY_HTTPS_DOMAIN}/"
    elif [ -n "$SERVER_IPV4" ]; then
        echo "    Server/LAN:  http://${SERVER_IPV4}:8484/"
    fi
    # Use localhost (not 0.0.0.0) — Chrome blocks 0.0.0.0 as a
    # destination under the Private Network Access mitigations.
    echo "    This server: http://localhost:8484/"
    echo ""
    warn "═══════════════════════════════════════════════════════════════════"
    warn " SECURITY: The first account registered becomes Aurora admin."
    EXPOSURE_DOMAIN="${PROXY_DOMAIN:-$DISPLAY_HTTPS_DOMAIN}"
    if [ -n "$EXPOSURE_DOMAIN" ]; then
        warn " Keep TCP 8484 and the hostname ${EXPOSURE_DOMAIN} (HTTP/HTTPS)"
        warn " restricted to trusted users/networks until you register and claim"
        warn " the admin account."
    else
        warn " Keep TCP 8484 restricted to trusted users/networks until you"
        warn " register and claim the admin account."
    fi
    warn "═══════════════════════════════════════════════════════════════════"
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
if ! $HEALTHY || $HTTPS_SETUP_FAILED || $UPDATER_ACTIVATION_FAILED; then
    exit 1
fi
