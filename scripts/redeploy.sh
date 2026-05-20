#!/usr/bin/env bash
# Aurora Media Server — Manual redeploy helper.
#
# When to use this:
#   - You pulled changes locally and want to rebuild + redeploy from your
#     own clone (not the root-owned /var/lib/aurora/source mirror that
#     the auto-updater runs against).
#   - The auto-updater is wedged or you want to apply changes without
#     waiting for the 5-min timer tick.
#   - You're testing local edits and want a one-command deploy loop.
#
# What it does (in order):
#   1. Builds the V2 React SPA  (npm ci + vite build → static/v2/)
#   2. Builds the Go binary     (CGO_ENABLED=0 go build → ./aurora)
#   3. Installs the binary      (sudo install -m 755 → /usr/local/bin/aurora)
#   4. Atomic-swaps static/     (cp → /opt/aurora/static.new → mv-swap)
#   5. Copies migrations/*.sql  (sudo cp → /opt/aurora/migrations/)
#   6. Restarts aurora.service  (sudo systemctl restart aurora)
#   7. Polls the health endpoint until it answers (or times out)
#
# What it does NOT do:
#   - System-level prereqs (Go, FFmpeg, Postgres, pgvector). For a
#     fresh box, run ./scripts/install.sh first.
#   - User/group/permission setup. install.sh handles that.
#   - Auto-updater setup. install.sh handles that.
#   - Database migration apply — Aurora's migration runner picks them up
#     at startup (step 6 above triggers it).
#
# Usage:
#   ./scripts/redeploy.sh                  # build + deploy, idempotent
#   ./scripts/redeploy.sh --skip-npm       # reuse existing static/v2/ build
#   ./scripts/redeploy.sh --skip-frontend  # alias for --skip-npm
#   ./scripts/redeploy.sh --no-restart     # build + install but don't restart aurora
#   ./scripts/redeploy.sh -h               # this help text
#
# Exit codes:
#   0  success (binary installed, service healthy)
#   1  build failed (npm or go)
#   2  install / file copy failed
#   3  service restart failed or health check timed out
#   4  preflight failure (wrong dir, missing tools, OS, lock held)
# ── END HELP ──────────────────────────────────────────────────────

set -euo pipefail

# ── Constants (must match install.sh) ────────────────────────────
INSTALL_BIN="/usr/local/bin/aurora"
INSTALL_DIR="/opt/aurora"
INSTALL_USER="aurora"
INSTALL_GROUP="aurora"
SPA_SRC_DIR="static/redesign/app"
SPA_OUTPUT_DIR="static/v2"
HEALTH_URL="http://localhost:8484/api/health"
HEALTH_TIMEOUT=30 # seconds to wait for /api/health to answer

# ── Helpers ──────────────────────────────────────────────────────
info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$1"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$1"; }
ok()    { printf '\033[1;32m[ OK ]\033[0m  %s\n' "$1"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$1"; exit "${2:-1}"; }
step()  { printf '\n\033[1;35m▸ %s\033[0m\n\n' "$1"; }

# ── Argument parsing ─────────────────────────────────────────────
SKIP_FRONTEND=false
RESTART=true
for arg in "$@"; do
    case "$arg" in
        --skip-npm|--skip-frontend) SKIP_FRONTEND=true ;;
        --no-restart) RESTART=false ;;
        -h|--help)
            # Print the header comment up to (but not including) the
            # END HELP sentinel. Drift-resistant: adding lines to the
            # header doesn't break --help, and trailing code never
            # leaks in.
            sed -n '2,/^# ── END HELP/{/^# ── END HELP/!p;}' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            error "Unknown option: $arg (try --help)" 4
            ;;
    esac
done

# ── Locate project root ──────────────────────────────────────────
# Resolve to the project root by walking up from the script's own
# location. This lets you invoke as `./scripts/redeploy.sh` from the
# project root OR `bash /var/lib/aurora/source/scripts/redeploy.sh`
# from anywhere.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
PROJECT_DIR=$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)
cd "$PROJECT_DIR"

# ── Preflight ────────────────────────────────────────────────────
echo ""
echo "  ════════════════════════════════════════════════════════════"
echo "    Aurora Media Server — Redeploy"
echo "  ════════════════════════════════════════════════════════════"
echo ""
info "Project root: $PROJECT_DIR"

# OS guard. Aurora is bare-metal Linux only — install.sh:391 refuses
# macOS, redeploy.sh should match. The /opt/aurora layout assumed
# below doesn't exist on macOS / BSDs anyway, but failing fast with
# a clear message beats letting the script create files and stall
# on systemctl.
case "$(uname -s)" in
    Linux) ;;
    *) error "redeploy.sh only supports Linux (this is $(uname -s)). On macOS, build locally with 'go build ./cmd/aurora' and run the binary directly." 4 ;;
esac

# Sanity: this is actually an Aurora checkout.
if [ ! -f "$PROJECT_DIR/go.mod" ] || [ ! -d "$PROJECT_DIR/cmd/aurora" ]; then
    error "Not an Aurora checkout (missing go.mod or cmd/aurora) — run from project root or via ./scripts/redeploy.sh" 4
fi

# Sanity: install dir exists (i.e. install.sh has run at some point).
if [ ! -d "$INSTALL_DIR" ]; then
    error "$INSTALL_DIR does not exist — run ./scripts/install.sh first for a fresh install" 4
fi

# Tools we need.
if ! command -v go &>/dev/null; then
    error "go is not on PATH — install.sh installs /usr/local/go; you may need to: export PATH=/usr/local/go/bin:\$PATH" 4
fi
if ! $SKIP_FRONTEND && ! command -v npm &>/dev/null; then
    error "npm is not on PATH (or use --skip-npm to reuse existing static/v2/)" 4
fi
if $RESTART && ! command -v systemctl &>/dev/null; then
    warn "systemctl not available — service restart will be skipped; pass --no-restart to silence this"
fi

# Systemd unit drift detection.
#
# 2026-05-20 — observed in production: redeploy.sh's previous flow
# replaced the binary + static + migrations but NEVER updated the
# systemd unit at /etc/systemd/system/aurora.service. When the unit
# file in the repo changes (e.g., a new ReadWritePaths= entry for
# /var/lib/aurora to support the .path-activated updater), the
# running service uses the OLD unit definition forever. Symptom in
# production: Aurora 500s on "Update Now" with
#   open /var/lib/aurora/trigger-update: read-only file system
# because ProtectSystem=strict was blocking the write that the new
# unit definition would have allowed.
#
# Fix: detect drift here, BEFORE building anything, and either
# auto-update the unit (recommended for routine deploys) or refuse
# and point the operator at install.sh. We auto-update because
# unit drift is invisible otherwise — the operator only finds out
# when a feature breaks in production.
#
# Files we manage: aurora.service + the auto-updater trio. Sudoers
# is excluded (install.sh's responsibility; safer to require an
# explicit install.sh re-run for privilege changes).
#
# Gated on systemctl availability (audit MED-1) — on hosts without
# systemd (Alpine, containers), drift detection is meaningless and
# auto-update would try to write to /etc/systemd/system/ which
# likely doesn't exist.
UNIT_FILES_DRIFTED=()
UPDATE_UNITS=false
if command -v systemctl &>/dev/null; then
    check_unit_drift() {
        local src="$1" dst="$2"
        # IMPORTANT: every exit path must return 0. The function's
        # "result" is the side-effect on UNIT_FILES_DRIFTED, not the
        # return code. Returning non-zero would trip `set -e` at the
        # call site (top-level statements, not in a conditional) and
        # silently kill the whole script — observed 2026-05-20 when
        # aurora-update.path was missing on the deploy target and
        # the operator saw the script stop after "Project root:" with
        # no error message.
        [ -f "$src" ] || return 0
        if [ ! -f "$dst" ]; then
            UNIT_FILES_DRIFTED+=("$src (not installed at $dst)")
            return 0
        fi
        # install.sh rewrites `postgresql.service` → `postgresql-N.service`
        # in aurora.service depending on the detected PG service name.
        # Normalize that on both sides before comparing so the rewrite
        # doesn't register as drift.
        #
        # No sudo on the dst read — /etc/systemd/system/*.service files
        # are 644 root:root by default (world-readable), so plain sed
        # works and avoids a spurious sudo prompt (audit LOW-1).
        local src_norm dst_norm
        src_norm=$(sed 's/postgresql-[0-9]*\.service/postgresql.service/g' "$src")
        dst_norm=$(sed 's/postgresql-[0-9]*\.service/postgresql.service/g' "$dst")
        if [ "$src_norm" != "$dst_norm" ]; then
            UNIT_FILES_DRIFTED+=("$src")
        fi
        return 0
    }
    check_unit_drift "$PROJECT_DIR/scripts/aurora.service"        /etc/systemd/system/aurora.service
    check_unit_drift "$PROJECT_DIR/scripts/aurora-update.service" /etc/systemd/system/aurora-update.service
    check_unit_drift "$PROJECT_DIR/scripts/aurora-update.timer"   /etc/systemd/system/aurora-update.timer
    check_unit_drift "$PROJECT_DIR/scripts/aurora-update.path"    /etc/systemd/system/aurora-update.path

    if [ "${#UNIT_FILES_DRIFTED[@]}" -gt 0 ]; then
        warn "Systemd unit drift detected (deployed copy at /etc/systemd/system/ doesn't match repo):"
        for u in "${UNIT_FILES_DRIFTED[@]}"; do
            warn "    $u"
        done
        warn "Auto-updating units in step 5 (and re-running daemon-reload before restart)."
        UPDATE_UNITS=true
    fi
fi

# Sudo capability. The build steps don't need root; the install
# + systemctl restart steps do. Prompt for the password up front
# so the script doesn't pause mid-deploy.
if ! sudo -n true 2>/dev/null; then
    info "sudo password needed for install + restart..."
    sudo -v
fi

# Background sudo keepalive. Default sudo timestamp is 5 minutes —
# a cold-cache npm build alone can blow past that and force a mid-
# deploy password prompt. The keepalive refreshes the timestamp
# every 60s so the script never stalls. PID stashed so the EXIT
# trap can reap it cleanly.
sudo -n true 2>/dev/null && (
    while true; do
        sudo -n true 2>/dev/null || exit 0
        sleep 60
    done
) &
SUDO_KEEPALIVE_PID=$!

# ── Single-deploy lock ───────────────────────────────────────────
# aurora-update.timer fires aurora-update.sh every 5 min, running
# essentially the same rebuild + install + restart pipeline.
# Without a lock, a manual redeploy.sh can interleave with the
# auto-updater and corrupt /opt/aurora/static (one script's `mv
# static.new static` can land while the other is mid-cp).
#
# We share /var/lock/aurora-deploy.lock with any future flock'd
# auto-updater. `flock -n` returns non-zero immediately if the lock
# is held, so the operator gets a clear "auto-updater is running,
# wait or stop the timer" message rather than a confusing race.
#
# fd 9 is arbitrary — chosen high enough to avoid clashing with
# stdin/stdout/stderr (0,1,2). The trap releases via EXIT so even
# kill -9 of the script frees the lock (kernel reaps the fd).
LOCK_FILE="/var/lock/aurora-deploy.lock"
# Ensure the lockfile is owned in a way both this user and the
# auto-updater (running as root) can open. /var/lock is typically
# world-writable + sticky on Linux.
if ! sudo touch "$LOCK_FILE" 2>/dev/null; then
    warn "Could not create $LOCK_FILE — running WITHOUT cross-script lock. If aurora-update.timer fires mid-deploy, racy state on /opt/aurora is possible. Consider: sudo systemctl stop aurora-update.timer"
else
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        error "Another deploy (likely aurora-update.service) is running. Wait for it to finish, or 'sudo systemctl stop aurora-update.timer' to suspend the auto-updater." 4
    fi
fi

# Cleanup on exit: release the lock (closing fd 9 drops it; the
# kernel does this on process exit too, but explicit is safer) and
# reap the sudo keepalive. Done in a single trap so the LIFO order
# doesn't matter.
trap '
    [ -n "${SUDO_KEEPALIVE_PID:-}" ] && kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
    exec 9>&- 2>/dev/null || true
' EXIT

# ══════════════════════════════════════════════════════════════════
# Step 1 — Build the V2 React SPA
# ══════════════════════════════════════════════════════════════════
if $SKIP_FRONTEND; then
    step "Step 1/5: Skipping frontend rebuild (--skip-npm)"
    if [ ! -d "$PROJECT_DIR/$SPA_OUTPUT_DIR" ]; then
        error "Skipped npm build but $SPA_OUTPUT_DIR/ doesn't exist — drop --skip-npm" 1
    fi
    ok "Reusing existing $SPA_OUTPUT_DIR/ bundle"
else
    step "Step 1/5: Building the V2 SPA"
    cd "$PROJECT_DIR/$SPA_SRC_DIR"
    # npm ci is faster + more reproducible than npm install (uses
    # package-lock.json, errors on drift). Falls back to npm install
    # if no lockfile (shouldn't happen in CI but defensive).
    if [ -f package-lock.json ]; then
        info "npm ci..."
        if ! npm ci --no-audit --no-fund; then
            error "npm ci failed in $SPA_SRC_DIR" 1
        fi
    else
        warn "No package-lock.json — falling back to npm install"
        if ! npm install --no-audit --no-fund; then
            error "npm install failed in $SPA_SRC_DIR" 1
        fi
    fi
    info "vite build (writes to ../../v2)..."
    if ! npm run build; then
        error "Frontend build failed (tsc or vite) — fix the SPA before redeploying" 1
    fi
    ok "Frontend built → $SPA_OUTPUT_DIR/"
    cd "$PROJECT_DIR"
fi

# ══════════════════════════════════════════════════════════════════
# Step 2 — Build the Go binary
# ══════════════════════════════════════════════════════════════════
step "Step 2/5: Building the Go binary"
VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "dev")
info "Version: $VERSION"
# CGO_ENABLED=0 produces a static binary — no glibc dep, no surprise
# /usr/lib version mismatch between build and runtime hosts.
# -ldflags strips the symbol table + DWARF (smaller binary) and
# stamps the version into main.version (read by /api/health).
if ! CGO_ENABLED=0 go build -ldflags="-s -w -X main.version=${VERSION}" -o aurora ./cmd/aurora; then
    error "go build failed" 1
fi
BIN_SIZE=$(du -h aurora | awk '{print $1}')
ok "Binary built ($BIN_SIZE)"

# ══════════════════════════════════════════════════════════════════
# Step 3 — Stage the binary (rename last, after static + migrations)
# ══════════════════════════════════════════════════════════════════
# Stage as $INSTALL_BIN.new so the FINAL rename-into-place happens
# AFTER the static + migrations swap. Pre-audit, the binary swap
# came first; if the static cp failed (disk full, permission glitch),
# the running aurora kept its old inode but the next systemctl
# restart — including the 5-min auto-update timer's restart — would
# launch the new binary against the old static dir. Mismatch can
# break the SPA bundle path resolution. Stage-and-rename-last
# matches aurora-update.sh's pattern.
step "Step 3/5: Staging the binary (final swap in step 4)"
if ! sudo install -m 755 aurora "$INSTALL_BIN.new"; then
    error "Failed to stage binary at $INSTALL_BIN.new" 2
fi
ok "Binary staged → $INSTALL_BIN.new"

# ══════════════════════════════════════════════════════════════════
# Step 4 — Atomic-swap static/ + copy migrations/, then promote binary
# ══════════════════════════════════════════════════════════════════
step "Step 4/5: Updating static assets + migrations, promoting binary"

# Migrations: small SQL files, just overwrite. Aurora's migration
# runner reads them at startup and applies only those not in the
# schema_migrations table.
#
# `shopt -s nullglob` (in a subshell) makes an empty migrations dir
# expand to zero args instead of the literal `*.sql` pattern, which
# would fail under set -e. install.sh has the same latent issue
# but only runs once; redeploy.sh runs often enough to care.
if ! sudo mkdir -p "$INSTALL_DIR/migrations"; then
    error "Failed to ensure migrations dir" 2
fi
SQL_FILES=()
shopt -s nullglob
for f in "$PROJECT_DIR"/migrations/*.sql; do
    SQL_FILES+=("$f")
done
shopt -u nullglob
if [ "${#SQL_FILES[@]}" -eq 0 ]; then
    warn "No migration files found in $PROJECT_DIR/migrations — proceeding without copy"
else
    if ! sudo cp -f "${SQL_FILES[@]}" "$INSTALL_DIR/migrations/"; then
        error "Failed to copy migrations" 2
    fi
    ok "Copied ${#SQL_FILES[@]} migration files"
fi

# Static assets: atomic swap pattern matching install.sh. Deploy the built
# V2 bundle, not the React source tree or node_modules under static/redesign.
info "Copying built SPA bundle → $INSTALL_DIR/static.new..."
sudo rm -rf "$INSTALL_DIR/static.new" "$INSTALL_DIR/static.old"
if ! sudo mkdir -p "$INSTALL_DIR/static.new"; then
    sudo rm -f "$INSTALL_BIN.new"
    error "Failed to create $INSTALL_DIR/static.new — staged binary rolled back" 2
fi
if [ -d "$PROJECT_DIR/static" ]; then
    find "$PROJECT_DIR/static" -mindepth 1 -maxdepth 1 ! -name redesign ! -name v2 \
        -exec sudo cp -R {} "$INSTALL_DIR/static.new/" \;
fi
if ! sudo cp -R "$PROJECT_DIR/$SPA_OUTPUT_DIR" "$INSTALL_DIR/static.new/v2"; then
    # Roll back the staged binary so a subsequent restart can't
    # accidentally pick up the new code against the old static.
    sudo rm -f "$INSTALL_BIN.new"
    error "Failed to copy built SPA bundle — staged binary rolled back" 2
fi
if [ -d "$INSTALL_DIR/static" ]; then
    sudo mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.old"
fi
sudo mv "$INSTALL_DIR/static.new" "$INSTALL_DIR/static"
sudo rm -rf "$INSTALL_DIR/static.old"
ok "Static assets swapped"

# Match install.sh + aurora-update.sh: deployed dirs are
# aurora:aurora-owned so future write paths (cache reflowing into
# /opt/aurora subdirs, future features) don't trip on root-owned
# files. World-readable defaults work today but this is
# defense-in-depth.
sudo chown -R "$INSTALL_USER:$INSTALL_GROUP" "$INSTALL_DIR/static" "$INSTALL_DIR/migrations" 2>/dev/null || \
    warn "chown to $INSTALL_USER:$INSTALL_GROUP failed — files left root-owned (readable but not writable by aurora)"

# Final binary swap: rename .new into place. This is the
# point-of-no-return — after this line, the next systemctl restart
# picks up the new binary. mv is atomic on a single filesystem.
if ! sudo mv "$INSTALL_BIN.new" "$INSTALL_BIN"; then
    error "Failed to promote $INSTALL_BIN.new → $INSTALL_BIN (deploy is in a half-state; investigate manually)" 2
fi
ok "Binary promoted → $INSTALL_BIN"

# Clean up the build artifact in the project dir so a subsequent
# `git status` is clean. The deployed copy is at $INSTALL_BIN.
rm -f "$PROJECT_DIR/aurora"

# ══════════════════════════════════════════════════════════════════
# Step 5 — Restart aurora + health check
# ══════════════════════════════════════════════════════════════════
if ! $RESTART; then
    step "Step 5/5: Skipping restart (--no-restart)"
    warn "Aurora is still running the OLD binary until you restart it."
    warn "  sudo systemctl restart aurora"
    exit 0
fi

if ! command -v systemctl &>/dev/null; then
    step "Step 5/5: Skipping restart (systemctl not available)"
    warn "Files updated but Aurora not restarted — restart manually."
    exit 0
fi

step "Step 5/5: Restarting aurora.service"

# Apply any drifted systemd units BEFORE restart, then daemon-reload
# so the new ExecStart / ReadWritePaths / etc. take effect on this
# very restart. Without daemon-reload, systemctl restart uses the
# previously-cached unit definition.
#
# install.sh's pg_service rewrite is applied here too so an admin
# on Fedora-17 (postgresql-17.service) doesn't see the After= line
# stomped back to plain postgresql.service.
if $UPDATE_UNITS; then
    info "Applying drifted systemd units..."
    PG_SERVICE_NAME=""
    for svc in postgresql postgresql-{17,16,15,14,13}; do
        if systemctl cat "${svc}.service" &>/dev/null; then
            PG_SERVICE_NAME="$svc"
            break
        fi
    done
    for unit in aurora.service aurora-update.service aurora-update.timer aurora-update.path; do
        src="$PROJECT_DIR/scripts/$unit"
        [ -f "$src" ] || continue
        if ! sudo cp "$src" "/etc/systemd/system/$unit"; then
            error "Failed to copy $unit to /etc/systemd/system/" 3
        fi
        # Apply the PG-service patch on aurora.service only.
        if [ "$unit" = "aurora.service" ] && [ -n "$PG_SERVICE_NAME" ] && [ "$PG_SERVICE_NAME" != "postgresql" ]; then
            sudo sed -i "s/postgresql\.service/${PG_SERVICE_NAME}.service/g" "/etc/systemd/system/$unit"
        fi
    done
    if ! sudo systemctl daemon-reload; then
        error "systemctl daemon-reload failed — units may be syntactically broken; check 'systemd-analyze verify /etc/systemd/system/aurora.service'" 3
    fi
    ok "Systemd units updated + reloaded"
fi

# Ensure /var/lib/aurora + the trigger-update file exist with the
# right ownership / mode for the .path-activated updater.
#
# 2026-05-20 — observed in production after a redeploy: the in-app
# "Update Now" returned `cannot write /var/lib/aurora/trigger-update`
# even though aurora.service's ReadWritePaths was correctly updated.
# Cause: the trigger file simply didn't exist, and aurora (as the
# `aurora` user) couldn't O_CREATE it because /var/lib/aurora is
# root:root 0755 — no group/other write. install.sh creates the
# file root:aurora 0664 so aurora's group-write bit lets it touch.
# redeploy.sh used to skip this step entirely; if the operator
# never re-ran install.sh after the .path commit landed, the file
# was permanently missing.
#
# Idempotent: install -d / install -m on existing files just resets
# perms; the brief touch only fires on missing files. We don't ship
# any data in the trigger file (the actual content is just a
# timestamp written by the Go handler).
if [ -d "$PROJECT_DIR/scripts" ] && [ -f "$PROJECT_DIR/scripts/aurora-update.path" ]; then
    sudo install -d -m 0755 -o root -g root /var/lib/aurora
    if [ ! -f /var/lib/aurora/trigger-update ]; then
        sudo install -m 0664 -o root -g "$INSTALL_GROUP" /dev/null /var/lib/aurora/trigger-update
        ok "Created /var/lib/aurora/trigger-update"
    else
        # Reset ownership + mode every time — cheap idempotency, and
        # it'll heal a server whose file got cloned with wrong perms
        # by some prior buggy script revision.
        sudo chown root:"$INSTALL_GROUP" /var/lib/aurora/trigger-update
        sudo chmod 0664 /var/lib/aurora/trigger-update
    fi
fi

if ! sudo systemctl restart aurora; then
    error "systemctl restart aurora failed — check 'journalctl -u aurora -n 50'" 3
fi
ok "aurora.service restarted"

# Health check: poll /api/health for up to HEALTH_TIMEOUT seconds.
# Aurora needs to apply migrations + bind the port before this
# answers, so we give it a generous window before declaring failure.
info "Waiting for /api/health to respond (max ${HEALTH_TIMEOUT}s)..."
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
        ok "Aurora is healthy"
        echo ""
        echo "  ════════════════════════════════════════════════════════════"
        echo "    Redeploy complete (version: $VERSION)"
        echo "  ════════════════════════════════════════════════════════════"
        echo ""
        echo "    URL:      http://localhost:8484/"
        echo "    Logs:     journalctl -u aurora -f"
        echo "    Status:   systemctl status aurora"
        echo ""
        exit 0
    fi
    sleep 1
done

# Health check timed out. The service may have failed to start, OR
# it may be doing a slow migration — surface the journal tail so the
# operator can decide.
error "Health check timed out after ${HEALTH_TIMEOUT}s — aurora may be down or applying a slow migration. Check: journalctl -u aurora -n 80" 3
