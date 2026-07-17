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
#   4. Atomic-swaps static/ and migrations/ from complete staged directories
#   5. Restarts aurora.service  (sudo systemctl restart aurora)
#   6. Polls the health endpoint until Aurora reports status=ok and
#      db_connected=true (or times out)
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
#   ./scripts/redeploy.sh --no-restart     # build + stage .new artifacts only
#   ./scripts/redeploy.sh --allow-stale    # deploy even if HEAD is behind origin
#                                           # (skips the safety check — rarely needed)
#   ./scripts/redeploy.sh -h               # this help text
#
# Exit codes:
#   0  success (service healthy, or artifacts staged with --no-restart)
#   1  build failed (npm or go)
#   2  install / file copy failed
#   3  service restart failed or health check timed out
#   4  preflight failure (wrong dir, missing tools, OS, lock held)
# ── END HELP ──────────────────────────────────────────────────────

set -Eeuo pipefail

# ── Constants (must match install.sh) ────────────────────────────
INSTALL_BIN="/usr/local/bin/aurora"
INSTALL_DIR="/opt/aurora"
INSTALL_GROUP="aurora"
SPA_SRC_DIR="static/redesign/app"
SPA_OUTPUT_DIR="static/v2"
HEALTH_URL="http://localhost:8484/api/health"
HEALTH_TIMEOUT=30 # seconds to wait for strict /api/health readiness
BIN_SNAPSHOT="${INSTALL_BIN}.prev"
STATIC_SNAPSHOT="${INSTALL_DIR}/static.old"
MIGRATIONS_SNAPSHOT="${INSTALL_DIR}/migrations.old"
DB_RECOVERY_MARKER="${AURORA_DB_RECOVERY_MARKER:-/usr/local/lib/aurora-installer/db-recovery-pending}"
DEPLOYMENT_SWAPPED=false
ROLLBACK_ATTEMPTED=false
HAD_BIN=false
HAD_STATIC=false
HAD_MIGRATIONS=false
BIN_SWAP_STARTED=false
STATIC_SWAP_STARTED=false
MIGRATIONS_SWAP_STARTED=false

# ── Helpers ──────────────────────────────────────────────────────
info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$1"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$1"; }
ok()    { printf '\033[1;32m[ OK ]\033[0m  %s\n' "$1"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$1"; exit "${2:-1}"; }
step()  { printf '\n\033[1;35m▸ %s\033[0m\n\n' "$1"; }

strict_aurora_health() {
    curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null |
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

wait_for_strict_health() {
    local deadline
    deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if systemctl is-active --quiet aurora && strict_aurora_health; then
            return 0
        fi
        sleep 1
    done
    return 1
}

rollback_redeploy() {
    local restore_ok=true

    trap '' INT TERM
    ROLLBACK_ATTEMPTED=true
    warn "Restoring the previous binary, static bundle, and migration set..."

    if $BIN_SWAP_STARTED; then
        sudo rm -f "${INSTALL_BIN}.failed"
        if [ -e "$INSTALL_BIN" ]; then
            sudo mv "$INSTALL_BIN" "${INSTALL_BIN}.failed" || restore_ok=false
        fi
        if $HAD_BIN; then
            if [ -f "$BIN_SNAPSHOT" ]; then
                sudo mv "$BIN_SNAPSHOT" "$INSTALL_BIN" || restore_ok=false
            else
                restore_ok=false
            fi
        else
            sudo rm -f "$INSTALL_BIN"
        fi
    fi

    if $STATIC_SWAP_STARTED; then
        if [ -e "$STATIC_SNAPSHOT" ]; then
            sudo rm -rf "$INSTALL_DIR/static.failed"
            if [ -e "$INSTALL_DIR/static" ]; then
                sudo mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.failed" \
                    || restore_ok=false
            fi
            sudo mv "$STATIC_SNAPSHOT" "$INSTALL_DIR/static" \
                || restore_ok=false
        elif $HAD_STATIC; then
            [ -e "$INSTALL_DIR/static" ] || restore_ok=false
        else
            sudo rm -rf "$INSTALL_DIR/static"
        fi
    fi

    if $MIGRATIONS_SWAP_STARTED; then
        if [ -e "$MIGRATIONS_SNAPSHOT" ]; then
            sudo rm -rf "$INSTALL_DIR/migrations.failed"
            if [ -e "$INSTALL_DIR/migrations" ]; then
                sudo mv "$INSTALL_DIR/migrations" \
                    "$INSTALL_DIR/migrations.failed" || restore_ok=false
            fi
            sudo mv "$MIGRATIONS_SNAPSHOT" "$INSTALL_DIR/migrations" \
                || restore_ok=false
        elif $HAD_MIGRATIONS; then
            [ -e "$INSTALL_DIR/migrations" ] || restore_ok=false
        else
            sudo rm -rf "$INSTALL_DIR/migrations"
        fi
    fi

    if $restore_ok \
        && sudo systemctl restart aurora \
        && wait_for_strict_health; then
        sudo rm -rf "$INSTALL_DIR/static.failed" \
            "$INSTALL_DIR/migrations.failed"
        DEPLOYMENT_SWAPPED=false
        return 0
    fi
    return 1
}

recover_interrupted_redeploy() {
    local restore_ok=true

    if [ ! -e "$BIN_SNAPSHOT" ] \
        && [ ! -e "$STATIC_SNAPSHOT" ] \
        && [ ! -e "$MIGRATIONS_SNAPSHOT" ]; then
        return 0
    fi
    $RESTART || return 2

    warn "Found rollback snapshots from an interrupted/unverified redeploy; restoring them before building."
    if [ -e "$BIN_SNAPSHOT" ]; then
        sudo rm -f "${INSTALL_BIN}.failed" || restore_ok=false
        [ ! -e "$INSTALL_BIN" ] \
            || sudo mv "$INSTALL_BIN" "${INSTALL_BIN}.failed" \
            || restore_ok=false
        sudo mv "$BIN_SNAPSHOT" "$INSTALL_BIN" || restore_ok=false
    fi
    if [ -e "$STATIC_SNAPSHOT" ]; then
        sudo rm -rf "$INSTALL_DIR/static.failed" || restore_ok=false
        [ ! -e "$INSTALL_DIR/static" ] \
            || sudo mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.failed" \
            || restore_ok=false
        sudo mv "$STATIC_SNAPSHOT" "$INSTALL_DIR/static" || restore_ok=false
    fi
    if [ -e "$MIGRATIONS_SNAPSHOT" ]; then
        sudo rm -rf "$INSTALL_DIR/migrations.failed" || restore_ok=false
        [ ! -e "$INSTALL_DIR/migrations" ] \
            || sudo mv "$INSTALL_DIR/migrations" \
                "$INSTALL_DIR/migrations.failed" || restore_ok=false
        sudo mv "$MIGRATIONS_SNAPSHOT" "$INSTALL_DIR/migrations" \
            || restore_ok=false
    fi
    if $restore_ok \
        && [ ! -e "$BIN_SNAPSHOT" ] \
        && [ ! -e "$STATIC_SNAPSHOT" ] \
        && [ ! -e "$MIGRATIONS_SNAPSHOT" ] \
        && sudo systemctl restart aurora \
        && wait_for_strict_health; then
        sudo rm -f "${INSTALL_BIN}.failed"
        sudo rm -rf "$INSTALL_DIR/static.failed" \
            "$INSTALL_DIR/migrations.failed"
        ok "Interrupted redeploy rolled back to a healthy baseline"
        return 0
    fi
    return 1
}

# shellcheck disable=SC2329 # invoked by ERR trap after promotion
on_redeploy_error() {
    local line="$1" rc="$2"
    trap - ERR INT TERM
    set +e
    warn "Redeploy aborted near line $line (exit $rc)."
    if $DEPLOYMENT_SWAPPED && ! $ROLLBACK_ATTEMPTED; then
        if rollback_redeploy; then
            warn "Previous healthy deployment restored."
        else
            warn "Automatic rollback failed; manual recovery is required."
        fi
    fi
    exit "$rc"
}

# shellcheck disable=SC2329 # invoked by INT/TERM traps after promotion
on_redeploy_signal() {
    local signal="$1" rc=1
    trap - ERR INT TERM
    set +e
    warn "Redeploy interrupted by $signal."
    if $DEPLOYMENT_SWAPPED && ! $ROLLBACK_ATTEMPTED; then
        if rollback_redeploy; then
            warn "Previous healthy deployment restored."
        else
            warn "Automatic rollback failed; manual recovery is required."
        fi
    fi
    [ "$signal" = INT ] && rc=130
    [ "$signal" = TERM ] && rc=143
    exit "$rc"
}

# ── Argument parsing ─────────────────────────────────────────────
SKIP_FRONTEND=false
RESTART=true
ALLOW_STALE=false
for arg in "$@"; do
    case "$arg" in
        --skip-npm|--skip-frontend) SKIP_FRONTEND=true ;;
        --no-restart) RESTART=false ;;
        --allow-stale) ALLOW_STALE=true ;;
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

# ── Staleness guard ──────────────────────────────────────────────
# 2026-05-26 — added after a real-world regression: operator ran
# redeploy.sh from a clone that was MANY commits behind origin/main,
# which silently rebuilt + deployed an OLD SPA bundle on top of what
# the auto-updater had just installed (auto-updater ran from
# /var/lib/aurora/source which DOES stay current). The result was a
# missing-glow / missing-watch-party-modal regression in production
# even though every Go build and npm build "succeeded."
#
# The fix: refuse to deploy if HEAD is behind origin/<remote-tracking
# branch>. The operator gets a clear error pointing them at `git
# pull`. `--allow-stale` is the escape hatch for the (rare) case
# where you genuinely need to deploy old code (e.g., rolling back
# a bad commit via a stale checkout, or testing a pre-merge branch).
#
# Skipped when:
#   - The repo has no upstream branch configured (e.g., a fresh
#     clone via tarball — no origin to compare against).
#   - `git fetch` fails (offline laptop, GitHub down). We log a
#     warning rather than failing; the operator made an informed
#     choice to deploy without checking origin.
#
# Done EARLY (before build) so a stale operator wastes zero time
# rebuilding the wrong source.
if $ALLOW_STALE; then
    warn "Skipping staleness check (--allow-stale)"
elif ! git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    warn "Not a git repo — can't check staleness against origin"
else
    UPSTREAM=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || echo "")
    if [ -z "$UPSTREAM" ]; then
        warn "No upstream tracking branch — skipping staleness check (consider 'git branch --set-upstream-to=origin/main')"
    else
        info "Checking $UPSTREAM for upstream commits..."
        if ! git -C "$PROJECT_DIR" fetch --quiet "$(echo "$UPSTREAM" | cut -d/ -f1)" "$(echo "$UPSTREAM" | cut -d/ -f2-)" 2>/dev/null; then
            warn "git fetch failed (offline?) — skipping staleness check"
        else
            BEHIND=$(git -C "$PROJECT_DIR" rev-list --count "HEAD..$UPSTREAM" 2>/dev/null || echo 0)
            if [ "$BEHIND" -gt 0 ]; then
                error "Your local checkout is $BEHIND commit(s) behind $UPSTREAM. Deploying now would build OLD code on top of whatever the auto-updater has already shipped — exactly the regression this guard was added to prevent.

To fix:
  git -C $PROJECT_DIR pull            # bring local up to date, then re-run
  # or, if you genuinely need to deploy old code (rare):
  $0 --allow-stale ${*:+\"$*\"}" 4
            fi
            ok "Local HEAD matches $UPSTREAM"
        fi
    fi
fi

# ── Preflight ────────────────────────────────────────────────────
echo ""
echo "  ════════════════════════════════════════════════════════════"
echo "    Aurora Media Server — Redeploy"
echo "  ════════════════════════════════════════════════════════════"
echo ""
info "Project root: $PROJECT_DIR"

# Aurora keeps source-build toolchains out of root's general Node command
# namespace. Re-establish their paths before dependency checks.
[ -d /usr/local/lib/aurora-node/bin ] \
    && export PATH="/usr/local/lib/aurora-node/bin:$PATH"
[ -d /usr/local/go/bin ] \
    && export PATH="/usr/local/go/bin:$PATH"

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
if [ ! -f "$PROJECT_DIR/install.sh" ]; then
    error "Aurora checkout is incomplete (missing repository-root install.sh for the public installer endpoint)" 4
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
if $RESTART && ! command -v curl &>/dev/null; then
    error "curl is required for the post-restart Aurora health check — install it or re-run scripts/install.sh" 4
fi
if ! command -v python3 &>/dev/null; then
    error "python3 is required for secure deploy locking and health validation — install it or re-run scripts/install.sh" 4
fi
if $RESTART && ! command -v systemctl &>/dev/null; then
    error "systemctl is required for verified activation and rollback (or pass --no-restart to stage without verification)" 4
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
# Detect drift before building anything and send system-policy changes through
# the full installer, which owns unit validation, dependencies, and rollback
# state. Manual redeploy remains an application-artifact workflow.
#
# Files we manage: aurora.service + the auto-updater trio. Sudoers
# is excluded (install.sh's responsibility; safer to require an
# explicit install.sh re-run for privilege changes).
#
# Gated on systemctl availability for --no-restart developer staging.
UNIT_FILES_DRIFTED=()
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
        error "Systemd policy changes require the full repair installer. Run:
  sudo -i
  /var/lib/aurora/source/install.sh
Then rerun this developer redeploy." 4
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
# We share /run/aurora/deploy.lock with the installer and auto-updater.
# `flock -n` returns non-zero immediately if the lock
# is held, so the operator gets a clear "auto-updater is running,
# wait or stop the timer" message rather than a confusing race.
#
# fd 9 is arbitrary — chosen high enough to avoid clashing with
# stdin/stdout/stderr (0,1,2). The trap releases via EXIT so even
# kill -9 of the script frees the lock (kernel reaps the fd).
LOCK_FILE="/run/aurora/deploy.lock"
command -v flock >/dev/null 2>&1 \
    || error "flock is required for safe deploy coordination (install util-linux)." 4

# Create/open the root-owned lock without following a malicious symlink. A
# developer only needs a readable descriptor for Linux flock(2), so the shell
# opens the verified file read-only after root prepares it.
if ! sudo python3 - "$LOCK_FILE" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
parent = os.path.dirname(path)
if os.path.lexists(parent) and os.path.islink(parent):
    raise OSError(f"{parent} is a symlink")
os.makedirs(parent, mode=0o755, exist_ok=True)
parent_stat = os.stat(parent)
if not stat.S_ISDIR(parent_stat.st_mode):
    raise OSError(f"{parent} is not a directory")
if parent_stat.st_uid != 0 or parent_stat.st_mode & 0o022:
    raise OSError(f"{parent} is not exclusively root-managed")
flags = os.O_WRONLY | os.O_CREAT | os.O_CLOEXEC
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
fd = os.open(path, flags, 0o644)
try:
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        raise OSError(f"{path} is not a regular file")
    os.fchown(fd, 0, 0)
    os.fchmod(fd, 0o644)
finally:
    os.close(fd)
PY
then
    error "Could not safely create/open $LOCK_FILE; refusing an unlocked deploy." 4
fi
exec 9<"$LOCK_FILE" \
    || error "Could not open $LOCK_FILE after secure creation." 4
if ! flock -n 9; then
    error "Another deploy (likely aurora-update.service) is running. Wait for it to finish, or 'sudo systemctl stop aurora-update.timer' to suspend the auto-updater." 4
fi

# A pending installer-owned PostgreSQL recovery keeps the application stopped
# until its credential and immutable object identities are durably converged.
# Check with sudo because the recovery directory is intentionally root-only.
if sudo test -L "$DB_RECOVERY_MARKER"; then
    error "PostgreSQL recovery state is malformed at $DB_RECOVERY_MARKER. Do not remove it; rerun the full installer." 4
fi
if sudo test -e "$DB_RECOVERY_MARKER"; then
    error "PostgreSQL recovery is pending. Rerun the full installer before any manual redeploy." 4
fi

# Cleanup on exit: release the lock (closing fd 9 drops it; the
# kernel does this on process exit too, but explicit is safer) and
# reap the sudo keepalive. Done in a single trap so the LIFO order
# doesn't matter.
trap '
    [ -n "${SUDO_KEEPALIVE_PID:-}" ] && kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
    exec 9>&- 2>/dev/null || true
' EXIT

if ! recover_interrupted_redeploy; then
    error "Could not restore a healthy baseline from prior redeploy snapshots. Do not delete $BIN_SNAPSHOT, $STATIC_SNAPSHOT, or $MIGRATIONS_SNAPSHOT; inspect the service and recover manually." 3
fi

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
# Step 4 — Stage and atomic-swap static/ + migrations/, then promote binary
# ══════════════════════════════════════════════════════════════════
step "Step 4/5: Updating static assets + migrations, promoting binary"

# Stage the exact migration set. Overlay-copying into the live directory leaves
# deleted or renamed, not-yet-applied SQL behind and can execute stale code on
# the next restart.
SQL_FILES=()
shopt -s nullglob
for f in "$PROJECT_DIR"/migrations/*.sql; do
    SQL_FILES+=("$f")
done
shopt -u nullglob
if [ "${#SQL_FILES[@]}" -eq 0 ]; then
    sudo rm -f "$INSTALL_BIN.new"
    error "No migration files found in $PROJECT_DIR/migrations — refusing a partial deploy" 2
fi
sudo rm -rf "$INSTALL_DIR/migrations.new"
if ! sudo mkdir -p "$INSTALL_DIR/migrations.new" \
    || ! sudo cp -f "${SQL_FILES[@]}" "$INSTALL_DIR/migrations.new/"; then
    sudo rm -f "$INSTALL_BIN.new"
    sudo rm -rf "$INSTALL_DIR/migrations.new"
    error "Failed to stage migrations — staged binary rolled back" 2
fi
ok "Staged ${#SQL_FILES[@]} migration files"

# Static assets: atomic swap pattern matching install.sh. Deploy the built
# V2 bundle, not the React source tree or node_modules under static/redesign.
info "Copying built SPA bundle → $INSTALL_DIR/static.new..."
sudo rm -rf "$INSTALL_DIR/static.new"
if ! sudo mkdir -p "$INSTALL_DIR/static.new"; then
    sudo rm -f "$INSTALL_BIN.new"
    error "Failed to create $INSTALL_DIR/static.new — staged binary rolled back" 2
fi
if [ -d "$PROJECT_DIR/static" ]; then
    while IFS= read -r -d '' entry; do
        if ! sudo cp -R "$entry" "$INSTALL_DIR/static.new/"; then
            sudo rm -f "$INSTALL_BIN.new"
            sudo rm -rf "$INSTALL_DIR/static.new" "$INSTALL_DIR/migrations.new"
            error "Failed to stage committed static asset '$entry'" 2
        fi
    done < <(
        find "$PROJECT_DIR/static" -mindepth 1 -maxdepth 1 \
            ! -name redesign ! -name v2 -print0
    )
fi
if ! sudo install -m 0644 "$PROJECT_DIR/install.sh" \
    "$INSTALL_DIR/static.new/install.sh"; then
    sudo rm -f "$INSTALL_BIN.new"
    sudo rm -rf "$INSTALL_DIR/static.new" "$INSTALL_DIR/migrations.new"
    error "Failed to stage the public installer endpoint" 2
fi
if ! sudo cp -R "$PROJECT_DIR/$SPA_OUTPUT_DIR" "$INSTALL_DIR/static.new/v2"; then
    # Roll back the staged binary so a subsequent restart can't
    # accidentally pick up the new code against the old static.
    sudo rm -f "$INSTALL_BIN.new"
    sudo rm -rf "$INSTALL_DIR/static.new" "$INSTALL_DIR/migrations.new"
    error "Failed to copy built SPA bundle — staged binary rolled back" 2
fi

# Match install.sh + aurora-update.sh: deployed artifacts stay root-owned and
# non-writable by the service account. Runtime writes belong under
# /var/cache/aurora, /var/log/aurora, or /var/lib/aurora.
sudo chown -R root:root "$INSTALL_DIR/static.new" "$INSTALL_DIR/migrations.new"
sudo chmod -R go-w "$INSTALL_DIR/static.new" "$INSTALL_DIR/migrations.new"

if ! $RESTART; then
    step "Step 5/5: Staged only (--no-restart)"
    rm -f "$PROJECT_DIR/aurora"
    warn "No live artifacts were changed. Staged files remain at:"
    warn "  $INSTALL_BIN.new"
    warn "  $INSTALL_DIR/static.new"
    warn "  $INSTALL_DIR/migrations.new"
    warn "Rerun without --no-restart to rebuild, activate, and health-check them."
    exit 0
fi

# Snapshot every live component before the first mutation. The binary copy is
# staged and renamed so a signal/disk error cannot leave a partial executable
# masquerading as rollback state.
[ -f "$INSTALL_BIN" ] && HAD_BIN=true
[ -e "$INSTALL_DIR/static" ] && HAD_STATIC=true
[ -e "$INSTALL_DIR/migrations" ] && HAD_MIGRATIONS=true
if $HAD_BIN; then
    if ! sudo cp -p "$INSTALL_BIN" "${BIN_SNAPSHOT}.new" \
        || ! sudo mv "${BIN_SNAPSHOT}.new" "$BIN_SNAPSHOT"; then
        sudo rm -f "${BIN_SNAPSHOT}.new"
        error "Failed to create an atomic binary rollback snapshot; live deployment unchanged" 2
    fi
fi

# From the first rename until strict health commits the deployment, every
# unexpected error or signal triggers rollback.
trap 'on_redeploy_error "$LINENO" "$?"' ERR
trap 'on_redeploy_signal INT' INT
trap 'on_redeploy_signal TERM' TERM
DEPLOYMENT_SWAPPED=true

STATIC_SWAP_STARTED=true
$HAD_STATIC && sudo mv "$INSTALL_DIR/static" "$STATIC_SNAPSHOT"
sudo mv "$INSTALL_DIR/static.new" "$INSTALL_DIR/static"

MIGRATIONS_SWAP_STARTED=true
$HAD_MIGRATIONS && sudo mv "$INSTALL_DIR/migrations" "$MIGRATIONS_SNAPSHOT"
sudo mv "$INSTALL_DIR/migrations.new" "$INSTALL_DIR/migrations"

BIN_SWAP_STARTED=true
sudo mv "$INSTALL_BIN.new" "$INSTALL_BIN"
ok "Binary, static assets, and exact migration set promoted"

# Clean up the build artifact in the project dir so a subsequent
# `git status` is clean. The deployed copy is at $INSTALL_BIN.
rm -f "$PROJECT_DIR/aurora"

# ══════════════════════════════════════════════════════════════════
# Step 5 — Restart aurora + health check
# ══════════════════════════════════════════════════════════════════
step "Step 5/5: Restarting aurora.service"

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
    if ! {
        sudo install -d -m 0755 -o root -g root /var/lib/aurora
        if [ ! -f /var/lib/aurora/trigger-update ]; then
            sudo install -m 0664 -o root -g "$INSTALL_GROUP" \
                /dev/null /var/lib/aurora/trigger-update
        else
            sudo chown root:"$INSTALL_GROUP" /var/lib/aurora/trigger-update
            sudo chmod 0664 /var/lib/aurora/trigger-update
        fi
    }; then
        if rollback_redeploy; then
            error "Could not prepare the update trigger; previous deployment restored" 2
        fi
        error "Could not prepare the update trigger and rollback failed; manual recovery required" 2
    fi
fi

if ! sudo systemctl restart aurora; then
    if rollback_redeploy; then
        error "New deployment could not restart; previous healthy deployment restored. Database migrations, if any ran, were not reversed." 3
    fi
    error "New deployment could not restart and rollback failed; inspect 'journalctl -u aurora -n 80'" 3
fi
ok "aurora.service restarted"

# Health check: poll /api/health for up to HEALTH_TIMEOUT seconds. A 200 alone
# is insufficient: migrations can finish far enough for the handler to respond
# while the database is still disconnected.
info "Waiting for /api/health status=ok and db_connected=true (max ${HEALTH_TIMEOUT}s)..."
if ! wait_for_strict_health; then
    if rollback_redeploy; then
        error "New deployment failed strict health; previous healthy deployment restored. Database migrations already applied were not reversed." 3
    fi
    error "Strict health failed and rollback did not restore a healthy service; inspect 'journalctl -u aurora -n 80'" 3
fi

# Strict health is the transaction commit point. Cleanup failures must not roll
# back a healthy service.
DEPLOYMENT_SWAPPED=false
trap - ERR INT TERM
if ! sudo rm -f "$BIN_SNAPSHOT" "${INSTALL_BIN}.failed" \
    || ! sudo rm -rf "$STATIC_SNAPSHOT" "$MIGRATIONS_SNAPSHOT" \
        "$INSTALL_DIR/static.failed" "$INSTALL_DIR/migrations.failed"; then
    warn "Deployment is healthy, but rollback-snapshot cleanup failed; remove the stale snapshot files manually."
fi
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
