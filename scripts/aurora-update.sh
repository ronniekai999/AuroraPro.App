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
#   - On post-restart health-check failure, leaves status=failed
#     but does NOT auto-rollback (rollback is risky to automate;
#     operator decides).
#
# Concurrency: systemd's Type=oneshot serializes invocations, so
# even if the timer fires while a manual button-click is running,
# the second invocation is a no-op (or queues, depending on the
# unit's RefuseManualStart setting).

set -euo pipefail

# ── Load installer-written env ────────────────────────────────────
# install.sh writes AURORA_SOURCE_DIR=<the path you cloned to> to
# /etc/aurora/aurora.env. Without it the updater has no idea where
# to pull from.
if [ -f /etc/aurora/aurora.env ]; then
    set -a; . /etc/aurora/aurora.env; set +a
fi

SOURCE_DIR="${AURORA_SOURCE_DIR:-}"
BRANCH="${AURORA_UPDATE_BRANCH:-main}"
STATUS_FILE=/var/lib/aurora/update-status.json
LOG_FILE=/var/log/aurora/update.log
INSTALL_BIN=/usr/local/bin/aurora
INSTALL_DIR=/opt/aurora
SPA_SRC_DIR=static/redesign/app
SPA_OUTPUT_DIR=static/v2

mkdir -p "$(dirname "$STATUS_FILE")"
mkdir -p "$(dirname "$LOG_FILE")"

# Make Go visible to this systemd-spawned shell. Profile.d isn't
# sourced by systemd-launched processes, so we re-establish the
# PATH here. /usr/local/go/bin is the official Go install location
# (install.sh's install_go function puts the toolchain there).
[ -d /usr/local/go/bin ] && export PATH="/usr/local/go/bin:$PATH"

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
    chmod 644 "$STATUS_FILE"
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
        find static -mindepth 1 -maxdepth 1 ! -name redesign ! -name v2 \
            -exec cp -R {} "$INSTALL_DIR/static.new/" \;
    fi
    cp -R "$built_v2_dir" "$INSTALL_DIR/static.new/v2"
}

# ERR trap — when set -e trips, capture the line and report.
on_error() {
    local lineno="$1"
    log "ABORT at line $lineno (set -e tripped)"
    write_status failed "Update script aborted at line $lineno — see /var/log/aurora/update.log"
    exit 1
}
trap 'on_error $LINENO' ERR

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

cd "$SOURCE_DIR"

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
        write_status misconfigured "git remote.origin.url has changed from the expected value. Expected '$AURORA_EXPECTED_REMOTE', got '$ACTUAL_REMOTE'. Refusing to fetch from a potentially-untrusted remote."
        log "origin URL mismatch — expected '$AURORA_EXPECTED_REMOTE', got '$ACTUAL_REMOTE'"
        exit 1
    fi
else
    log "WARN: AURORA_EXPECTED_REMOTE not set in aurora.env — skipping origin verification (re-run install.sh to fix)"
fi

# ── Transport security (deep-debug H12) ───────────────────────────
# The updater builds + installs the fetched code as ROOT, so a plaintext or
# attacker-controllable git transport = unauthenticated root RCE. Use an
# ALLOWLIST: only encrypted/authenticated transports (https, ssh, git+ssh) or a
# local path / file:// are permitted. http:// and git:// (cleartext, MITM-able)
# and remote-helper transports like ext:: (which run arbitrary commands) are
# refused. Scheme matching is CASE-INSENSITIVE — git honors HTTP:// the same as
# http://, so a denylist of literal lowercase schemes would be bypassable
# (deep-debug H12 review).
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || echo "")"
case "$ORIGIN_URL" in
    *://*)
        ORIGIN_SCHEME="$(printf '%s' "${ORIGIN_URL%%://*}" | tr 'A-Z' 'a-z')"
        case "$ORIGIN_SCHEME" in
            https|ssh|git+ssh|file)
                : # encrypted/authenticated, or local — OK
                ;;
            *)
                write_status misconfigured "Refusing to auto-update over an unencrypted/unsupported remote transport ('$ORIGIN_URL'): a network attacker could MITM the update and run code as root. Use an https:// or ssh remote: git -C $SOURCE_DIR remote set-url origin https://..."
                log "refused remote transport scheme '$ORIGIN_SCHEME' ('$ORIGIN_URL')"
                exit 1
                ;;
        esac
        ;;
    *::*)
        # Remote-helper transports (ext::, fd::, ...) can execute arbitrary
        # commands — never acceptable for the root updater.
        write_status misconfigured "Refusing remote-helper transport ('$ORIGIN_URL') for the root auto-updater — it can execute arbitrary commands. Use an https:// or ssh remote."
        log "refused remote-helper transport '$ORIGIN_URL'"
        exit 1
        ;;
esac

# ── Fetch + check ─────────────────────────────────────────────────
write_status checking "Checking origin/$BRANCH for new commits"

OLD_SHA="$(git rev-parse HEAD)"

if ! git fetch --quiet origin "$BRANCH" 2>>"$LOG_FILE"; then
    write_status failed "git fetch failed — see /var/log/aurora/update.log" "$OLD_SHA"
    log "git fetch failed"
    exit 1
fi

NEW_SHA="$(git rev-parse "origin/$BRANCH")"

if [ "$OLD_SHA" = "$NEW_SHA" ]; then
    write_status idle "Already up to date ($OLD_SHA)" "$OLD_SHA" "$NEW_SHA"
    # No log spam for the common no-op case (5-min cadence × idle
    # would fill the log fast). One log line per actual update.
    exit 0
fi

log "Update available: $OLD_SHA → $NEW_SHA on $BRANCH"

# ── Commit-signature verification (deep-debug H12) ────────────────
# When AURORA_UPDATE_REQUIRE_SIGNED=true, the fetched tip MUST carry a valid
# signature from a trusted key before we build + install it as root — the
# control that stops a compromised/hijacked origin or a malicious force-push
# from shipping attacker code to every install. Trust root is either SSH
# signing (AURORA_UPDATE_ALLOWED_SIGNERS -> an allowed_signers file) or GPG
# (import the maintainer's public key into root's keyring). Default (false)
# preserves today's behavior for repos that don't sign yet, but logs a loud
# warning so the trust gap is visible.
if [ "${AURORA_UPDATE_REQUIRE_SIGNED:-false}" = "true" ] || [ "${AURORA_UPDATE_REQUIRE_SIGNED:-false}" = "1" ]; then
    VERIFY_OK=1
    if [ -n "${AURORA_UPDATE_ALLOWED_SIGNERS:-}" ]; then
        if [ ! -r "$AURORA_UPDATE_ALLOWED_SIGNERS" ]; then
            write_status failed "AURORA_UPDATE_REQUIRE_SIGNED is on but AURORA_UPDATE_ALLOWED_SIGNERS ('$AURORA_UPDATE_ALLOWED_SIGNERS') is missing or unreadable — refusing to build unverified code." "$OLD_SHA" "$NEW_SHA"
            log "allowed-signers file unreadable: $AURORA_UPDATE_ALLOWED_SIGNERS"
            exit 1
        fi
        git -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$AURORA_UPDATE_ALLOWED_SIGNERS" verify-commit "origin/$BRANCH" >>"$LOG_FILE" 2>&1 || VERIFY_OK=0
    else
        git verify-commit "origin/$BRANCH" >>"$LOG_FILE" 2>&1 || VERIFY_OK=0
    fi
    if [ "$VERIFY_OK" -ne 1 ]; then
        write_status failed "Commit-signature verification FAILED for origin/$BRANCH ($NEW_SHA) — refusing to build + install unverified code as root. Check the maintainer's signing key / AURORA_UPDATE_ALLOWED_SIGNERS." "$OLD_SHA" "$NEW_SHA"
        log "verify-commit FAILED for $NEW_SHA — refusing update"
        exit 1
    fi
    log "commit signature verified for $NEW_SHA"
else
    log "WARN: AURORA_UPDATE_REQUIRE_SIGNED not enabled — building UNVERIFIED code from origin/$BRANCH ($NEW_SHA); a compromised origin or MITM could run code as root. Set AURORA_UPDATE_REQUIRE_SIGNED=true with a trusted signing key to harden. (deep-debug H12)"
fi

# ── Working-tree cleanliness ──────────────────────────────────────
# If somebody (operator, prior failed merge) left dirty files in
# $SOURCE_DIR, a `git merge --ff-only` would refuse — but we want
# to fail FAST and explicit, not midway.
if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    write_status failed "Local changes detected in $SOURCE_DIR — refusing to overwrite. Run 'git -C $SOURCE_DIR stash' (or 'git -C $SOURCE_DIR reset --hard origin/$BRANCH' if you don't need them) then retry." "$OLD_SHA" "$NEW_SHA"
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
write_status updating "Pulling commits from origin/$BRANCH" "$OLD_SHA" "$NEW_SHA"

if ! git merge --ff-only "origin/$BRANCH" >>"$LOG_FILE" 2>&1; then
    write_status failed "Cannot fast-forward to origin/$BRANCH — manual reconciliation needed (the local branch has diverged)." "$OLD_SHA" "$NEW_SHA"
    log "merge --ff-only refused; branch diverged"
    exit 1
fi

# ── Cross-script deploy lock (audit MED) ─────────────────────────
# redeploy.sh (the manual deploy helper) takes a NON-blocking flock
# on /var/lock/aurora-deploy.lock to serialize its rebuild+install
# +atomic-swap against US. Until now this updater never acquired
# that lock, so a root auto-update could interleave with a manual
# redeploy and corrupt /opt/aurora/static (one script's
# `mv static.new static` landing mid-`cp` of the other). Acquire the
# SAME lock here, around the mutating build → install → atomic-swap
# → restart window. We take it just before the build (the read-only
# fetch/idle path above stays lock-free so the <1 s no-op case never
# contends) and hold it until process exit (released by the EXIT
# trap below + the kernel on fd close), matching redeploy.sh's hold
# duration so neither script can swap static while the other is
# restarting/rolling back.
#
# Non-blocking by design: if redeploy.sh (or a queued sibling) holds
# the lock, we DON'T fail the update — we log + write a benign status
# and skip THIS run cleanly. The timer fires again in 5 min, by which
# point the other deploy has almost certainly finished. fd 9 matches
# redeploy.sh's choice (high enough to avoid stdin/out/err 0,1,2).
#
# set -euo pipefail safety: every fallible command below is tested by
# `if`/`!`, which both exempts it from `set -e` AND prevents the ERR
# trap from firing a spurious `failed` status on a lock we chose to
# skip. We run as root, so a plain `touch` suffices (redeploy.sh
# needs sudo); /var/lock is world-writable + sticky on Linux.
LOCK_FILE=/var/lock/aurora-deploy.lock
LOCK_HELD=false
if ! command -v flock >/dev/null 2>&1; then
    # No flock (non-Linux / minimal image). redeploy.sh already
    # assumes flock on the Linux target, so this is belt-and-
    # suspenders: warn that the cross-script guard is unavailable and
    # proceed (systemd's Type=oneshot still serializes the updater
    # against itself; only a concurrent manual redeploy.sh is unguarded).
    log "WARN: flock not found — proceeding WITHOUT the cross-script deploy lock; a concurrent ./scripts/redeploy.sh could race /opt/aurora/static. (audit MED)"
elif ! touch "$LOCK_FILE" 2>>"$LOG_FILE"; then
    log "WARN: could not create/open $LOCK_FILE — proceeding WITHOUT the cross-script deploy lock; a concurrent ./scripts/redeploy.sh could race /opt/aurora/static. (audit MED)"
# `exec 9>` is tested by `if !` so a redirection failure (e.g. fd in
# use, FS gone read-only between the touch and here) is caught HERE —
# it does not trip `set -e`/the ERR trap into a spurious `failed`.
# On success the open fd persists for the rest of the script.
elif ! exec 9>"$LOCK_FILE"; then
    log "WARN: could not open $LOCK_FILE on fd 9 — proceeding WITHOUT the cross-script deploy lock; a concurrent ./scripts/redeploy.sh could race /opt/aurora/static. (audit MED)"
else
    if ! flock -n 9; then
        # Another deploy (redeploy.sh, or a queued aurora-update) holds
        # the lock. Skip cleanly — NOT a failure. Use `idle` so the
        # admin UI doesn't flash an alarming "failed" for a transient,
        # self-healing condition; the next timer tick retries.
        write_status idle "Skipped this update: another deploy holds $LOCK_FILE (likely a manual redeploy.sh). Will retry on the next timer tick." "$OLD_SHA" "$NEW_SHA"
        log "deploy lock $LOCK_FILE held by another process — skipping this run"
        exec 9>&- 2>/dev/null || true
        exit 0
    fi
    LOCK_HELD=true
    log "acquired deploy lock $LOCK_FILE (fd 9)"
fi

# Release the deploy lock on ANY exit. Closing fd 9 drops the flock;
# the kernel also does this on process exit, but explicit is safer
# (matches redeploy.sh). The ERR trap only reports+exits, so this
# single EXIT trap for cleanup is sufficient and runs after it (e.g.
# on a `set -e` abort, on_error's `exit 1` fires this). Guarded on
# LOCK_HELD so we never touch fd 9 when we didn't open it, and the
# body always succeeds so it can't perturb the script's exit code.
trap 'if [ "${LOCK_HELD:-false}" = true ]; then exec 9>&- 2>/dev/null || true; fi' EXIT

# ── Build ─────────────────────────────────────────────────────────
write_status building "Building Aurora frontend and binary" "$OLD_SHA" "$NEW_SHA"
FRONTEND_TMP="$(mktemp -d)"
log "frontend build..."
if ! build_frontend_bundle "$FRONTEND_TMP/v2"; then
    write_status failed "frontend build failed — see /var/log/aurora/update.log. Old binary/static assets are still running." "$OLD_SHA" "$NEW_SHA"
    log "frontend build failed"
    rm -rf "$FRONTEND_TMP"
    exit 1
fi

log "go build..."

VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo "dev")"
if ! CGO_ENABLED=0 go build -ldflags="-s -w -X main.version=${VERSION}" -o aurora.new ./cmd/aurora >>"$LOG_FILE" 2>&1; then
    write_status failed "go build failed — see /var/log/aurora/update.log. Old binary is still running." "$OLD_SHA" "$NEW_SHA"
    log "go build failed"
    rm -f aurora.new
    rm -rf "$FRONTEND_TMP"
    exit 1
fi

# ── Install ───────────────────────────────────────────────────────
write_status installing "Installing new binary, migrations, and static assets" "$OLD_SHA" "$NEW_SHA"
log "installing..."

# Audit H3 — snapshot the CURRENT binary + static dir BEFORE the
# swap so we can roll back if the new build fails its health
# check. Migrations are intentionally NOT snapshotted: forward
# migrations are usually irreversible (DROP COLUMN, type changes),
# and a binary that panics on startup typically does so BEFORE the
# migration runs — so a binary rollback alone restores service.
# Operators with reversible migrations can `pg_dump` separately
# before tagging a release.

# Snapshot binary. install -p preserves mode + mtime; .prev is
# overwritten on each update so it always reflects the immediately-
# prior version (not some weeks-old build).
if [ -f "$INSTALL_BIN" ]; then
    cp -p "$INSTALL_BIN" "$INSTALL_BIN.prev"
fi

# Binary swap. install + rename = atomic on POSIX — there's never
# a moment when /usr/local/bin/aurora doesn't exist or is
# half-written. (systemd keeps using the OLD inode for the running
# process until we restart; the new binary is what fires on next exec.)
install -m 755 aurora.new "$INSTALL_BIN.new"
rm aurora.new
mv "$INSTALL_BIN.new" "$INSTALL_BIN"

# Migrations
mkdir -p "$INSTALL_DIR/migrations"
SQL_FILES=()
shopt -s nullglob
for f in migrations/*.sql; do
    SQL_FILES+=("$f")
done
shopt -u nullglob
if [ "${#SQL_FILES[@]}" -eq 0 ]; then
    write_status failed "No migration files found in source checkout; refusing to install a partial release." "$OLD_SHA" "$NEW_SHA"
    log "no migration files found"
    rm -rf "$FRONTEND_TMP"
    exit 1
fi
if ! cp -f "${SQL_FILES[@]}" "$INSTALL_DIR/migrations/" 2>>"$LOG_FILE"; then
    write_status failed "migration copy failed — see /var/log/aurora/update.log. New binary was installed but service was not restarted." "$OLD_SHA" "$NEW_SHA"
    log "migration copy failed"
    rm -rf "$FRONTEND_TMP"
    exit 1
fi

# Static SPA bundle. Atomic-swap pattern; we now KEEP static.old
# around as our rollback snapshot until after the health check.
# The install.sh C1 fix (clear stale .old before rename) still
# applies — we only clear .old AFTER success or rollback.
rm -rf "$INSTALL_DIR/static.old"   # clear any pre-existing crash leftover
stage_static_bundle "$FRONTEND_TMP/v2"
if [ -d "$INSTALL_DIR/static" ]; then
    mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.old"
fi
mv "$INSTALL_DIR/static.new" "$INSTALL_DIR/static"
rm -rf "$FRONTEND_TMP"

chown -R aurora:aurora "$INSTALL_DIR"

# ── Restart + health check ────────────────────────────────────────
write_status restarting "Restarting aurora.service" "$OLD_SHA" "$NEW_SHA"
log "restarting service..."

# Wait for active HLS stream sessions (FFmpeg child processes) to
# drain before restarting so viewers aren't interrupted mid-playback.
# Timeout after 300 s to avoid blocking indefinitely.
_DRAIN_MAX=300
_DRAIN_WAITED=0
while pgrep -u aurora -x ffmpeg >/dev/null 2>&1 && [ "$_DRAIN_WAITED" -lt "$_DRAIN_MAX" ]; do
    log "active stream sessions detected — waiting for viewers to finish (${_DRAIN_WAITED}/${_DRAIN_MAX}s)..."
    sleep 10
    _DRAIN_WAITED=$((_DRAIN_WAITED + 10))
done
if [ "$_DRAIN_WAITED" -ge "$_DRAIN_MAX" ] && pgrep -u aurora -x ffmpeg >/dev/null 2>&1; then
    log "WARNING: stream sessions still active after ${_DRAIN_MAX}s, restarting anyway"
fi

systemctl restart aurora

# Health-check loop: wait up to 30s for /api/health to respond. If
# the new binary fails to migrate / fails to bind / panics on
# startup, this is where we catch it.
SVC_OK=false
for _ in $(seq 1 30); do
    if curl -sf http://localhost:8484/api/health &>/dev/null; then
        SVC_OK=true
        break
    fi
    sleep 1
done

if $SVC_OK; then
    COMMIT_SUBJECT="$(git log -1 --format=%s "$NEW_SHA" 2>/dev/null || echo "$NEW_SHA")"
    write_status success "Updated to $NEW_SHA ($COMMIT_SUBJECT)" "$OLD_SHA" "$NEW_SHA"
    log "SUCCESS: now running $NEW_SHA"
    # Clean up rollback snapshots only after the new version proved
    # healthy. The .prev / .old now reflect the LAST GOOD version
    # if there were any updates in flight; we keep them around so
    # the next update has a known-good rollback target.
    # Actually — we COULD keep them for cross-update rollback, but
    # that grows disk forever and the dual-step rollback semantics
    # are confusing. Wipe on success.
    rm -f "$INSTALL_BIN.prev"
    rm -rf "$INSTALL_DIR/static.old"
    exit 0
fi

# Audit H3 — health check failed. Attempt automatic rollback to
# the prior binary + static dir snapshots. Migrations stay in
# place (see snapshot rationale above). If rollback also fails,
# we leave the box in the broken state but report it loudly so
# the operator knows what they're walking into.
log "service unhealthy — attempting rollback to $OLD_SHA"
write_status restarting "New version failed health check — rolling back to previous binary" "$OLD_SHA" "$NEW_SHA"

ROLLBACK_OK=true
if [ -f "$INSTALL_BIN.prev" ]; then
    # The failing binary stays as /usr/local/bin/aurora.failed for
    # post-mortem; .prev becomes the live binary again.
    mv "$INSTALL_BIN" "$INSTALL_BIN.failed"
    mv "$INSTALL_BIN.prev" "$INSTALL_BIN"
else
    log "no $INSTALL_BIN.prev snapshot found — cannot rollback binary"
    ROLLBACK_OK=false
fi
if [ -d "$INSTALL_DIR/static.old" ]; then
    # Move the broken static dir aside (for inspection) and
    # restore the snapshot.
    mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.failed"
    mv "$INSTALL_DIR/static.old" "$INSTALL_DIR/static"
    rm -rf "$INSTALL_DIR/static.failed"
else
    log "no $INSTALL_DIR/static.old snapshot found — cannot rollback static"
fi

systemctl restart aurora

# Health-check the rolled-back binary. If even the rollback can't
# come up, something else is wrong (port conflict, DB down) and
# the operator needs to intervene.
ROLLBACK_HEALTHY=false
for _ in $(seq 1 30); do
    if curl -sf http://localhost:8484/api/health &>/dev/null; then
        ROLLBACK_HEALTHY=true
        break
    fi
    sleep 1
done

if $ROLLBACK_HEALTHY; then
    write_status failed "Update to $NEW_SHA failed its health check — rolled back to $OLD_SHA. The bad binary is at $INSTALL_BIN.failed for post-mortem; check 'journalctl -u aurora -n 80' to see why it crashed." "$OLD_SHA" "$NEW_SHA"
    log "rolled back successfully — now running $OLD_SHA"
elif $ROLLBACK_OK; then
    write_status failed "Update FAILED and rollback ALSO failed health check. Manual recovery required: ssh in, inspect 'journalctl -u aurora -n 80', and restore service." "$OLD_SHA" "$NEW_SHA"
    log "rollback restart also unhealthy — manual recovery required"
else
    write_status failed "Update FAILED and no rollback snapshot was available. /usr/local/bin/aurora is the broken build; restore from a known-good backup." "$OLD_SHA" "$NEW_SHA"
    log "no rollback snapshot — manual recovery required"
fi
exit 1
