#!/usr/bin/env bash
# Aurora Media Server — Auto-updater workhorse.
#
# Pulls latest commits from origin/<branch>, rebuilds the binary,
# atomically swaps the static SPA bundle + migrations, and restarts
# the systemd service. Designed to be called by either:
#
#   - aurora-update.timer (every 5 min) — the periodic auto-update
#   - systemctl start aurora-update.service — the admin UI's
#     "Update Now" button, which routes through a sudoers grant
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

mkdir -p "$(dirname "$STATUS_FILE")"
mkdir -p "$(dirname "$LOG_FILE")"

# Make Go visible to this systemd-spawned shell. Profile.d isn't
# sourced by systemd-launched processes, so we re-establish the
# PATH here. /usr/local/go/bin is the official Go install location
# (install.sh's install_go function puts the toolchain there).
[ -d /usr/local/go/bin ] && export PATH="/usr/local/go/bin:$PATH"

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

# ── Build ─────────────────────────────────────────────────────────
write_status building "Building Aurora binary" "$OLD_SHA" "$NEW_SHA"
log "go build..."

VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo "dev")"
if ! CGO_ENABLED=0 go build -ldflags="-s -w -X main.version=${VERSION}" -o aurora.new ./cmd/aurora >>"$LOG_FILE" 2>&1; then
    write_status failed "go build failed — see /var/log/aurora/update.log. Old binary is still running." "$OLD_SHA" "$NEW_SHA"
    log "go build failed"
    rm -f aurora.new
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
cp -f migrations/*.sql "$INSTALL_DIR/migrations/" 2>>"$LOG_FILE" || true

# Static SPA bundle. Atomic-swap pattern; we now KEEP static.old
# around as our rollback snapshot until after the health check.
# The install.sh C1 fix (clear stale .old before rename) still
# applies — we only clear .old AFTER success or rollback.
rm -rf "$INSTALL_DIR/static.old"   # clear any pre-existing crash leftover
cp -r static "$INSTALL_DIR/static.new"
if [ -d "$INSTALL_DIR/static" ]; then
    mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.old"
fi
mv "$INSTALL_DIR/static.new" "$INSTALL_DIR/static"

chown -R aurora:aurora "$INSTALL_DIR"

# ── Restart + health check ────────────────────────────────────────
write_status restarting "Restarting aurora.service" "$OLD_SHA" "$NEW_SHA"
log "restarting service..."

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
