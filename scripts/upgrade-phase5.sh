#!/usr/bin/env bash
#
# upgrade-phase5.sh — one-time upgrade for Aurora "Phase 5: Semantic Search +
# Personalized Hero". Targets a bare-metal install (systemd + native Postgres
# + Go binary). Idempotent: safe to re-run if it fails partway through.
#
# Run this from the repo root on the server, as a user with sudo.
#
# What it does, in order:
#   1. Sanity checks (OS, sudo, Go, Postgres, systemd unit, install paths).
#   2. Backs up the database with a timestamped pg_dump.
#   3. Installs the pgvector extension (apt/dnf/yum) and CREATE EXTENSION.
#   4. Installs Ollama as a systemd service if missing, pulls both models.
#   5. Stops aurora.
#   6. Syncs new files into the install dir (binary, static/, migrations/).
#   7. Rebuilds the aurora binary.
#   8. Writes the LLM_* env vars to your existing env file.
#   9. Starts aurora (migration 014 runs automatically on boot).
#  10. Tails logs briefly to confirm backfill kicked off.
#
# Override anything via env vars before invoking:
#   AURORA_INSTALL_DIR=/opt/aurora ./scripts/upgrade-phase5.sh
#

set -euo pipefail

# --------------------------------------------------------------------------
# Configuration — override via environment if your paths differ.
# --------------------------------------------------------------------------

# Where aurora's static/, migrations/, and binary live on the server.
: "${AURORA_INSTALL_DIR:=/opt/aurora}"
# The compiled Go binary.
: "${AURORA_BINARY:=${AURORA_INSTALL_DIR}/aurora}"
# Where the new source has been synced (where you ran git pull / scp).
# Usually the same as INSTALL_DIR for in-place builds; can differ if you
# build separately and copy the binary over.
: "${AURORA_SOURCE_DIR:=$(pwd)}"
# systemd unit name.
: "${AURORA_SERVICE:=aurora}"
# Env file the systemd unit loads (EnvironmentFile=...).
# Find it via: systemctl cat aurora | grep EnvironmentFile
: "${AURORA_ENV_FILE:=/etc/default/aurora}"
# Postgres connection — script uses peer auth via sudo -u postgres by default.
# If your DB requires a password, set DATABASE_URL in the env file already
# and we'll respect it via psql -d <database>.
: "${AURORA_DB_NAME:=aurora}"
: "${AURORA_DB_USER:=aurora}"
# Where to drop the backup. Created if it doesn't exist.
: "${BACKUP_DIR:=/var/backups/aurora}"
# Ollama models. Match what aurora's defaults expect.
: "${LLM_EMBED_MODEL:=nomic-embed-text}"
: "${LLM_CHAT_MODEL:=qwen2.5:3b-instruct}"
# Where Ollama listens. Default is fine for a single-host install.
: "${LLM_OLLAMA_URL:=http://127.0.0.1:11434}"
# Set to 1 to skip the confirmation prompt (e.g. in automation).
: "${ASSUME_YES:=0}"

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

c_red()    { printf '\033[31m%s\033[0m' "$*"; }
c_green()  { printf '\033[32m%s\033[0m' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m' "$*"; }

step() { echo; echo "$(c_blue '==>') $(c_blue "$*")"; }
ok()   { echo "$(c_green '  ✓') $*"; }
warn() { echo "$(c_yellow '  ⚠') $*"; }
die()  { echo "$(c_red '  ✗') $*" >&2; exit 1; }

confirm() {
    if [[ "$ASSUME_YES" == "1" ]]; then return 0; fi
    read -r -p "$1 [y/N] " ans
    [[ "$ans" =~ ^[Yy]$ ]] || die "Aborted."
}

# Detect package manager so we can install pgvector portably.
detect_pkg_mgr() {
    if   command -v apt-get &>/dev/null; then echo apt
    elif command -v dnf     &>/dev/null; then echo dnf
    elif command -v yum     &>/dev/null; then echo yum
    else echo unknown
    fi
}

# Detect Postgres major version (16, 15, 14...).
detect_pg_version() {
    if command -v psql &>/dev/null; then
        psql --version | grep -oE '[0-9]+' | head -1
    else
        echo ""
    fi
}

# --------------------------------------------------------------------------
# 1. Sanity checks
# --------------------------------------------------------------------------

step "Pre-flight checks"

[[ $EUID -eq 0 ]] || command -v sudo &>/dev/null || die "Need root or sudo."

PKG_MGR=$(detect_pkg_mgr)
[[ "$PKG_MGR" != "unknown" ]] || die "Unsupported package manager. Manual install required."
ok "Package manager: $PKG_MGR"

PG_VER=$(detect_pg_version)
[[ -n "$PG_VER" ]] || die "Postgres (psql) not found in PATH."
ok "Postgres version: $PG_VER"

command -v go &>/dev/null || die "Go toolchain not found. Install Go ≥ 1.23 to rebuild the binary."
GO_VER=$(go version | awk '{print $3}')
ok "Go: $GO_VER"

[[ -d "$AURORA_INSTALL_DIR" ]] || die "Install dir not found: $AURORA_INSTALL_DIR"
[[ -d "$AURORA_SOURCE_DIR/migrations" ]] || die "Source dir missing migrations/: $AURORA_SOURCE_DIR"
[[ -f "$AURORA_SOURCE_DIR/migrations/014_semantic_search.up.sql" ]] || die "Migration 014 not present in source. Did you sync the new code?"
ok "Source contains migration 014"

systemctl status "$AURORA_SERVICE" &>/dev/null || warn "systemd unit '$AURORA_SERVICE' not active (will still try to use it)."
ok "systemd unit: $AURORA_SERVICE"

[[ -f "$AURORA_ENV_FILE" ]] || warn "Env file not found: $AURORA_ENV_FILE — will create it."

# Show resolved config and pause for confirmation.
echo
echo "Will deploy with these settings:"
printf "  %-22s %s\n" "Install dir:"   "$AURORA_INSTALL_DIR"
printf "  %-22s %s\n" "Source dir:"    "$AURORA_SOURCE_DIR"
printf "  %-22s %s\n" "Binary path:"   "$AURORA_BINARY"
printf "  %-22s %s\n" "systemd unit:"  "$AURORA_SERVICE"
printf "  %-22s %s\n" "Env file:"      "$AURORA_ENV_FILE"
printf "  %-22s %s\n" "Database:"      "$AURORA_DB_NAME (user $AURORA_DB_USER)"
printf "  %-22s %s\n" "Backup dir:"    "$BACKUP_DIR"
printf "  %-22s %s\n" "Embed model:"   "$LLM_EMBED_MODEL"
printf "  %-22s %s\n" "Chat model:"    "$LLM_CHAT_MODEL"
printf "  %-22s %s\n" "Ollama URL:"    "$LLM_OLLAMA_URL"
echo
confirm "Proceed?"

# --------------------------------------------------------------------------
# 2. Database backup
# --------------------------------------------------------------------------

step "Backing up Postgres database"

sudo mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/aurora-pre-phase5-$(date +%Y%m%d-%H%M%S).sql.gz"
sudo -u postgres pg_dump "$AURORA_DB_NAME" | gzip > /tmp/aurora-backup.sql.gz
sudo mv /tmp/aurora-backup.sql.gz "$BACKUP_FILE"
sudo chmod 600 "$BACKUP_FILE"
ok "Backup written to $BACKUP_FILE"

# --------------------------------------------------------------------------
# 3. Install pgvector extension
# --------------------------------------------------------------------------

step "Installing pgvector for Postgres $PG_VER"

# Check first — skip the install if it's already there.
HAS_VECTOR=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_available_extensions WHERE name='vector'" || true)
if [[ "$HAS_VECTOR" == "1" ]]; then
    ok "pgvector already installed system-wide"
else
    case "$PKG_MGR" in
        apt)
            # Debian/Ubuntu: postgresql-NN-pgvector matches your major version.
            sudo apt-get update
            sudo apt-get install -y "postgresql-${PG_VER}-pgvector"
            ;;
        dnf|yum)
            # RHEL family: package name is pgvector_NN (e.g. pgvector_16).
            sudo "$PKG_MGR" install -y "pgvector_${PG_VER}"
            ;;
    esac
    ok "pgvector package installed"
fi

# Activate inside the database. CREATE EXTENSION IF NOT EXISTS is idempotent.
sudo -u postgres psql -d "$AURORA_DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;"
ok "vector extension enabled in $AURORA_DB_NAME"

# --------------------------------------------------------------------------
# 4. Install Ollama + pull models
# --------------------------------------------------------------------------

step "Installing Ollama"

if command -v ollama &>/dev/null; then
    ok "Ollama already installed: $(ollama --version 2>&1 | head -1)"
else
    # Official installer also creates the systemd unit and ollama user.
    curl -fsSL https://ollama.com/install.sh | sh
    ok "Ollama installed"
fi

# Make sure the service is up before we pull.
sudo systemctl enable --now ollama
sleep 2  # give the API a moment to bind

step "Pulling embedding + chat models (this may take several minutes)"

# `ollama pull` is idempotent — no-ops if the model is already present.
ollama pull "$LLM_EMBED_MODEL"
ok "Embed model: $LLM_EMBED_MODEL"
ollama pull "$LLM_CHAT_MODEL"
ok "Chat model:  $LLM_CHAT_MODEL"

# --------------------------------------------------------------------------
# 5. Stop aurora
# --------------------------------------------------------------------------

step "Stopping aurora"
sudo systemctl stop "$AURORA_SERVICE" || warn "Service was not running"
ok "Service stopped"

# --------------------------------------------------------------------------
# 6. Sync new files (only if source != install)
# --------------------------------------------------------------------------

step "Syncing new files into install dir"

if [[ "$AURORA_SOURCE_DIR" != "$AURORA_INSTALL_DIR" ]]; then
    # Mirror only what aurora reads at runtime: static/ + migrations/.
    # Source code can stay where it is; we'll build below and copy the binary.
    sudo rsync -a --delete "$AURORA_SOURCE_DIR/static/"     "$AURORA_INSTALL_DIR/static/"
    sudo rsync -a --delete "$AURORA_SOURCE_DIR/migrations/" "$AURORA_INSTALL_DIR/migrations/"
    ok "static/ + migrations/ synced"
else
    ok "Source and install dir are the same — no sync needed"
fi

# --------------------------------------------------------------------------
# 7. Rebuild the Go binary
# --------------------------------------------------------------------------

step "Rebuilding aurora binary"

(
    cd "$AURORA_SOURCE_DIR"
    # CGO_ENABLED=0 produces a static binary that's portable across libc versions.
    # Adjust if your build needs CGO (e.g. for sqlite, which aurora doesn't use).
    CGO_ENABLED=0 go build -o /tmp/aurora-new -ldflags "-X main.version=phase5-$(date +%Y%m%d)" ./cmd/aurora
)
sudo mv /tmp/aurora-new "$AURORA_BINARY"
sudo chmod 755 "$AURORA_BINARY"
ok "Binary rebuilt: $AURORA_BINARY ($(du -h "$AURORA_BINARY" | cut -f1))"

# --------------------------------------------------------------------------
# 8. Write LLM_* env vars
# --------------------------------------------------------------------------

step "Updating env file with LLM_* settings"

# Append-or-update each var idempotently. We use a marker block so re-runs
# update in place rather than appending duplicates.
TMP_ENV=$(mktemp)
sudo touch "$AURORA_ENV_FILE"
sudo cp "$AURORA_ENV_FILE" "$TMP_ENV"

# Strip any prior block written by this script.
sed -i '/^# >>> aurora-phase5 >>>/,/^# <<< aurora-phase5 <<</d' "$TMP_ENV"

# Append fresh block.
cat >> "$TMP_ENV" <<EOF
# >>> aurora-phase5 >>>
# Local LLM (Ollama) for semantic search and personalized hero.
# Set LLM_ENABLED=false to fall back to the legacy trigram path.
LLM_ENABLED=true
LLM_OLLAMA_URL=$LLM_OLLAMA_URL
LLM_EMBED_MODEL=$LLM_EMBED_MODEL
LLM_CHAT_MODEL=$LLM_CHAT_MODEL
LLM_EMBED_DIMS=384
LLM_BACKFILL_WORKERS=2
LLM_BACKFILL_BATCH=16
# <<< aurora-phase5 <<<
EOF

sudo mv "$TMP_ENV" "$AURORA_ENV_FILE"
sudo chmod 640 "$AURORA_ENV_FILE"
ok "Env file updated: $AURORA_ENV_FILE"

# --------------------------------------------------------------------------
# 9. Start aurora (migration 014 runs automatically)
# --------------------------------------------------------------------------

step "Starting aurora"

sudo systemctl daemon-reload   # picks up env file changes if unit uses EnvironmentFile
sudo systemctl start "$AURORA_SERVICE"
sleep 3
if ! systemctl is-active --quiet "$AURORA_SERVICE"; then
    warn "Service failed to start. Last 30 log lines:"
    sudo journalctl -u "$AURORA_SERVICE" -n 30 --no-pager
    die "Start failed — investigate, then re-run after fixing."
fi
ok "Service is running"

# --------------------------------------------------------------------------
# 10. Verify
# --------------------------------------------------------------------------

step "Verifying"

# Migration applied?
APPLIED=$(sudo -u postgres psql -d "$AURORA_DB_NAME" -tAc \
    "SELECT 1 FROM information_schema.columns WHERE table_name='media_items' AND column_name='embedding'" || true)
if [[ "$APPLIED" == "1" ]]; then
    ok "Migration 014 applied (media_items.embedding present)"
else
    warn "embedding column not found yet — check aurora logs for migration errors"
fi

# Show current backfill progress.
PENDING=$(sudo -u postgres psql -d "$AURORA_DB_NAME" -tAc \
    "SELECT COUNT(*) FROM media_items WHERE embedding IS NULL" 2>/dev/null || echo "?")
TOTAL=$(sudo -u postgres psql -d "$AURORA_DB_NAME" -tAc \
    "SELECT COUNT(*) FROM media_items" 2>/dev/null || echo "?")
ok "Embedding coverage: $((TOTAL - PENDING)) / $TOTAL (initial)"

echo
echo "$(c_green '✓ Upgrade complete.')"
echo
echo "Next steps:"
echo "  • Tail logs to watch backfill progress:"
echo "      sudo journalctl -u $AURORA_SERVICE -f | grep -iE 'embedding|hero'"
echo "  • Open Admin → Dashboard, look for the 'Semantic Index' card."
echo "  • Once backfill is done, try: 'movies like Severance' in the search bar."
echo
echo "If anything looks wrong, the pre-upgrade backup is at:"
echo "  $BACKUP_FILE"
echo
