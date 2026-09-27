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
# An idle check fetches the target and verifies the last successful deployment's
# artifact fingerprint. Checkout HEAD alone is NOT proof of a successful deploy.
# Failed builds retry the same revision; failures after installation begins need
# --retry (or a newer upstream revision) to avoid repeated disruptive restarts.
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
#   - On health-check failure, attempts binary/static rollback, NOT DB rollback.
#   - Marks a revision deployed only after restart and health check succeed.
#
# Concurrency: systemd's Type=oneshot serializes invocations, so
# even if the timer fires while a manual button-click is running,
# the second invocation is a no-op (or queues, depending on the
# unit's RefuseManualStart setting).

set -euo pipefail

RETRY=false
case "$#:${1:-}" in
    0:) ;;
    1:--retry) RETRY=true ;;
    1:--help|1:-h)
        echo "Usage: aurora-update [--retry]"
        echo "--retry: explicitly retry an interrupted/failed install or rebuild the current revision."
        exit 0 ;;
    *) echo "Usage: aurora-update [--retry]" >&2; exit 2 ;;
esac

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
INSTALL_UPDATER=/usr/local/bin/aurora-update
# Outside aurora-owned /var/lib/aurora and /opt/aurora: this is root's deploy
# ledger, not UI state. Never infer success from update-status.json or HEAD.
DEPLOY_STATE_DIR=/var/lib/aurora-updater
DEPLOYED_FILE="$DEPLOY_STATE_DIR/deployed"
PENDING_FILE="$DEPLOY_STATE_DIR/pending"
ROLLBACK_DIR="$DEPLOY_STATE_DIR/rollback"
ROLLBACK_BIN="$ROLLBACK_DIR/rollback-binary"
ROLLBACK_STATIC="$ROLLBACK_DIR/rollback-static"
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
        rm -rf "$out_dir" || return 1
        mkdir -p "$(dirname "$out_dir")" || return 1
        cp -R "$SPA_OUTPUT_DIR" "$out_dir" || return 1
        return 0
    fi
    if ! command -v npm >/dev/null 2>&1; then
        log "npm not found; install Node.js/npm or re-run install.sh"
        return 1
    fi

    rm -rf "$out_dir" || return 1
    mkdir -p "$(dirname "$out_dir")" || return 1
    if [ -f "$SPA_SRC_DIR/package-lock.json" ]; then
        log "npm ci..."
        if ! (cd "$SPA_SRC_DIR" && npm ci --no-audit --no-fund >>"$LOG_FILE" 2>&1); then
            log "npm ci failed; refusing to build with incomplete dependencies"
            return 1
        fi
    else
        log "npm install..."
        if ! (cd "$SPA_SRC_DIR" && npm install --no-audit --no-fund >>"$LOG_FILE" 2>&1); then
            log "npm install failed; refusing to build with incomplete dependencies"
            return 1
        fi
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

# Take the shared lock BEFORE status writes, fetch, and merge. A manual
# redeploy may be building this very checkout; merging before the lock can
# change its sources mid-build. A losing contender must not overwrite the
# active deploy's status. Missing locking is a configuration error, not safe
# permission to proceed unprotected.
LOCK_FILE=/var/lock/aurora-deploy.lock
if ! command -v flock >/dev/null 2>&1; then
    echo "FATAL: flock not found; install util-linux before updating Aurora." >&2
    exit 1
fi
if ! exec 9>"$LOCK_FILE"; then
    echo "FATAL: cannot open deploy lock $LOCK_FILE; no update attempted." >&2
    exit 1
fi
if ! flock -n 9; then
    echo "Another deploy holds $LOCK_FILE; skipping without changing its status."
    exit 0
fi
cleanup() {
    if [ -n "${FRONTEND_TMP:-}" ]; then rm -rf -- "$FRONTEND_TMP"; fi
    exec 9>&- || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
install -d -m 700 "$DEPLOY_STATE_DIR"

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

# Presence and execution are separate from the version parser below. An
# unrecognised version string can warn; a missing/broken executable cannot
# build the SPA. Check both tools before HEAD can advance. systemd does not
# source interactive shell profiles or automatically activate nvm.
# AURORA-TOOLCHAIN-GATE-BEGIN
if [ -d "$SPA_SRC_DIR" ]; then
    for tool in node npm; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            write_status misconfigured "$tool not found on the updater PATH. Install a compatible system-wide Node.js/npm toolchain (Node 22.x recommended), or configure the service PATH; then retry Update Now. Source and running assets were not changed. See docs/updater-recovery.md."
            log "$tool not found on updater PATH; refusing update before checkout changes"
            exit 1
        fi
        if ! "$tool" --version >/dev/null 2>>"$LOG_FILE"; then
            write_status misconfigured "$tool exists but '$tool --version' failed in the updater environment. Repair the Node.js/npm installation and retry; source and running assets were not changed. See /var/log/aurora/update.log and docs/updater-recovery.md."
            log "$tool --version failed; refusing update before checkout changes"
            exit 1
        fi
    done
fi
# AURORA-TOOLCHAIN-GATE-END

# ── Node version (deep-debug: the two-week silent stall) ──────────
#
# Vite 7 needs Node ^20.19 || >=22.12 and calls crypto.hash(), which
# does not exist before Node 20.12. On an older Node the build dies
# with "crypto.hash is not a function" — but only AFTER npm ci has
# run, so the failure lands several hundred lines into update.log and
# surfaces to the operator as the generic "frontend build failed —
# old binary/static assets are still running". A production box sat
# 8 updates behind for a fortnight on exactly that: eight identical
# failures whose status message named neither Node nor the version.
#
# Check it here, where the state is `misconfigured` (a configuration
# problem with its own remediation, per the H4 note above) and the
# message can name the version we found and the fix.
#
# node_vite_verdict is duplicated in scripts/install.sh and
# scripts/redeploy.sh — scripts/node-version-test.sh asserts the three
# copies are identical and agree on a table of real version strings.
NODE_ENGINES_TEXT="20.19+ or 22.12+"
NODE_TARGET_MAJOR=22

# node_vite_verdict — how usable is this box's Node for the SPA build?
#   0  meets vite/@vitejs-plugin-react's declared engines (^20.19 || >=22.12)
#   1  CANNOT build: no crypto.hash(), which vite 7 calls unconditionally
#      (added in Node 20.12 and 21.7). This is the provable failure.
#   2  no node, or a version string we could not parse
#   3  has crypto.hash but sits outside the declared engines — vite prints
#      its "please upgrade" notice and carries on, so the build works
#
# 1 and 3 are deliberately distinct. Refusing every Node below the declared
# engines would strand a box on, say, 20.15 whose build succeeds today —
# trading an unattended regression for a tidier rule. Only the provable
# case stops an update; the rest is said out loud and left to the build.
node_vite_verdict() {
    local ver major minor rest
    command -v node &>/dev/null || return 2
    ver="$(node --version 2>/dev/null)" || return 2
    ver="${ver#v}"
    major="${ver%%.*}"
    case "$ver" in
        *.*) rest="${ver#*.}"; minor="${rest%%.*}" ;;
        *)   minor=0 ;;
    esac
    case "$major" in ''|*[!0-9]*) return 2 ;; esac
    case "$minor" in ''|*[!0-9]*) return 2 ;; esac
    if [ "$major" -lt 20 ] \
        || { [ "$major" -eq 20 ] && [ "$minor" -lt 12 ]; } \
        || { [ "$major" -eq 21 ] && [ "$minor" -lt 7 ]; }; then
        return 1
    fi
    if { [ "$major" -eq 20 ] && [ "$minor" -ge 19 ]; } \
        || { [ "$major" -eq 22 ] && [ "$minor" -ge 12 ]; } \
        || [ "$major" -ge 23 ]; then
        return 0
    fi
    return 3
}

# Only when we actually build the SPA from source. build_frontend_bundle
# falls back to the committed static/v2 bundle when the source tree is
# absent, and that path needs no Node at all.
# AURORA-NODE-GATE-BEGIN (extracted by scripts/node-version-test.sh)
if [ -d "$SPA_SRC_DIR" ]; then
    NODE_VERDICT=0
    node_vite_verdict || NODE_VERDICT=$?
    NODE_FOUND="$(node --version 2>/dev/null || echo unknown)"
    case "$NODE_VERDICT" in
        1)
            write_status misconfigured "Node.js $NODE_FOUND is too old to build Aurora's frontend — Vite calls crypto.hash(), which needs Node 20.12+, and the toolchain asks for $NODE_ENGINES_TEXT. Every update will fail at the build step until this is fixed. Install Node.js ${NODE_TARGET_MAJOR}.x — 'curl -fsSL https://deb.nodesource.com/setup_${NODE_TARGET_MAJOR}.x | sudo -E bash - && sudo apt-get install -y nodejs' — or re-run install.sh, then update again."
            log "node $NODE_FOUND cannot build the frontend (no crypto.hash; toolchain wants $NODE_ENGINES_TEXT) — refusing update"
            exit 1
            ;;
        2)
            # Absent or unparseable. NOT fail-closed: unlike the transport
            # checks above, "unknown" is not evidence of a problem, and
            # blocking here would strand a box whose `node` merely prints
            # something we did not anticipate. The build is the real check
            # and will say so plainly if Node is genuinely unusable.
            log "WARN: could not determine the Node.js version (frontend build wants $NODE_ENGINES_TEXT) — continuing; the build will report it if this is a problem"
            ;;
        3)
            log "WARN: node $NODE_FOUND is outside the frontend toolchain's supported range ($NODE_ENGINES_TEXT) — the build should still succeed, but upgrade to Node ${NODE_TARGET_MAJOR}.x before it stops working"
            ;;
        0) ;;
        *)
            # Unreachable from node_vite_verdict, which returns 0-3 — and that
            # is precisely why it needs an arm. 127 is what the shell returns
            # if that function is renamed, deleted, or moved below this call
            # site. Without a default the gate does nothing and logs nothing,
            # and this script runs unattended from a timer, so the box goes
            # back to failing every update on an anonymous npm error with the
            # check still sitting visibly in the file. Do not fail closed:
            # an unknown verdict is not evidence the build is broken.
            log "WARN: the Node version gate returned an unexpected verdict ($NODE_VERDICT) — continuing. This is a bug in this script; the build remains the real check."
            ;;
    esac
fi
# AURORA-NODE-GATE-END

# Atomically replace a root-only ledger entry. The shared deploy lock is held
# for every read/write. A crash before rename leaves the old entry intact.
write_deploy_state() {
    local target="$1" value="$2" tmp
    tmp="$(mktemp "$DEPLOY_STATE_DIR/.state.XXXXXX")" || return 1
    if ! printf '%s\n' "$value" > "$tmp" || ! mv -f -- "$tmp" "$target"; then
        rm -f -- "$tmp"
        return 1
    fi
}

# Publish binary and static snapshots as ONE generation with a single rename.
# A pending install may already have changed live files, so never fill in or
# replace components of an existing generation from the current installation.
# The shared deploy lock also protects cleanup of interrupted private stages.
prepare_rollback_snapshots() {
    local tmp
    rm -rf -- "$DEPLOY_STATE_DIR"/.rollback-stage.* "$DEPLOY_STATE_DIR"/.rollback-retired.* || return 1
    [ ! -L "$ROLLBACK_DIR" ] || return 1
    [ ! -d "$ROLLBACK_DIR" ] || return 0
    [ ! -e "$ROLLBACK_DIR" ] || return 1
    tmp="$(mktemp -d "$DEPLOY_STATE_DIR/.rollback-stage.XXXXXX")" || return 1
    if [ -f "$INSTALL_BIN" ] && ! cp -p -- "$INSTALL_BIN" "$tmp/rollback-binary"; then
        rm -rf -- "$tmp"
        return 1
    fi
    # Copy the directory itself, preserving its root's owner/mode instead of
    # inheriting mktemp's 0700 and making restored assets unreadable to Aurora.
    if [ -d "$INSTALL_DIR/static" ] && ! cp -a -- "$INSTALL_DIR/static" "$tmp/rollback-static"; then
        rm -rf -- "$tmp"
        return 1
    fi
    if ! mv -- "$tmp" "$ROLLBACK_DIR"; then
        rm -rf -- "$tmp"
        return 1
    fi
}

# Detach the entire generation before deleting any component. A kill during
# recursive deletion then leaves only an inactive retired directory; the next
# attempt snapshots the healthy live binary and frontend together.
retire_rollback_snapshots() {
    local tmp
    [ -d "$ROLLBACK_DIR" ] || return 0
    tmp="$(mktemp -d "$DEPLOY_STATE_DIR/.rollback-retired.XXXXXX")" || return 1
    if ! mv -- "$ROLLBACK_DIR" "$tmp/snapshot"; then
        rm -rf -- "$tmp"
        return 1
    fi
    rm -rf -- "$tmp"
}

# Cover the binary, updater, static tree, and migrations. Manual redeploys and
# installer re-runs do not maintain this ledger, so checking the SHA alone would
# make their replaced artifacts invisible. Hash content/paths/modes, not mtimes.
# Never follow symlinks, and fail on unreadable/missing artifacts rather than
# treating an incomplete tree as successfully deployed.
deployment_fingerprint() {
    python3 - "$INSTALL_BIN" "$INSTALL_UPDATER" "$INSTALL_DIR/static" "$INSTALL_DIR/migrations" <<'DEPLOY_PY'
import hashlib
import os
from pathlib import Path
import stat
import sys

h = hashlib.sha256()
def field(value):
    h.update(len(value).to_bytes(8, "big"))
    h.update(value)

def visit(path, relative):
    mode = path.lstat().st_mode
    field(os.fsencode(relative))
    field(str(stat.S_IMODE(mode)).encode())
    if stat.S_ISREG(mode):
        field(b"file")
        content = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                content.update(chunk)
        field(content.digest())
    elif stat.S_ISDIR(mode):
        field(b"directory")
        for child in sorted(path.iterdir(), key=lambda p: os.fsencode(p.name)):
            visit(child, relative + "/" + child.name)
    else:
        # Symlink targets can change without the link changing. Refuse them
        # rather than certify content we did not hash (or follow outside roots).
        raise OSError("unsupported artifact type: " + str(path))

try:
    for i, root in enumerate(sys.argv[1:]):
        visit(Path(root), str(i))
except OSError as exc:
    print("Cannot fingerprint deployment: " + str(exc), file=sys.stderr)
    sys.exit(1)
print(h.hexdigest())
DEPLOY_PY
}

deployment_matches() {
    local sha fingerprint extra actual
    [ -r "$DEPLOYED_FILE" ] || return 1
    IFS=' ' read -r sha fingerprint extra < "$DEPLOYED_FILE" || return 1
    [[ "$sha" = "$1" && "$fingerprint" =~ ^[0-9a-f]{64}$ && -z "$extra" ]] || return 1
    actual="$(deployment_fingerprint 2>>"$LOG_FILE")" || return 1
    [ "$actual" = "$fingerprint" ]
}

# Refresh from the exact verified commit, not a possibly modified worktree.
# Renaming the installed script leaves this process's open script inode alone.
refresh_installed_updater() {
    local tmp
    tmp="$(mktemp "${INSTALL_UPDATER}.XXXXXX")" || return 1
    if ! git show "$NEW_SHA:scripts/aurora-update.sh" > "$tmp" \
        || ! bash -n "$tmp" || ! chmod 755 "$tmp" \
        || ! mv -f -- "$tmp" "$INSTALL_UPDATER"; then
        rm -f -- "$tmp"
        return 1
    fi
}

# ── Fetch + check ─────────────────────────────────────────────────
write_status checking "Checking origin/$BRANCH for new commits"

OLD_SHA="$(git rev-parse HEAD)"

if ! git fetch --quiet origin "$BRANCH" 2>>"$LOG_FILE"; then
    write_status failed "git fetch failed — see /var/log/aurora/update.log" "$OLD_SHA"
    log "git fetch failed"
    exit 1
fi

NEW_SHA="$(git rev-parse "origin/$BRANCH")"

# An install that did not reach success may already have changed live files
# or run migrations. Do not automatically retry it every five minutes. Build
# failures never create this intent record and remain automatically retryable.
PENDING_SHA=""
if [ -f "$PENDING_FILE" ]; then
    IFS= read -r PENDING_SHA < "$PENDING_FILE" || true
    if ! $RETRY && { [ "$PENDING_SHA" = "$NEW_SHA" ] || [[ ! "$PENDING_SHA" =~ ^[0-9a-f]{40}$ ]]; }; then
        write_status failed "An earlier install of $PENDING_SHA did not finish successfully. Automatic retry is paused to prevent restart loops. Inspect update.log and service health, then run 'sudo aurora-update --retry' explicitly. A valid failed-revision record may also be superseded by a newer upstream revision."
        log "incomplete install record blocks automatic retry of $NEW_SHA"
        exit 1
    fi
fi

if ! $RETRY && [ "$OLD_SHA" = "$NEW_SHA" ] && deployment_matches "$NEW_SHA"; then
    write_status idle "Already successfully deployed ($NEW_SHA); installed artifacts match" "$OLD_SHA" "$NEW_SHA"
    exit 0
fi

log "Deployment needed: source $OLD_SHA → $NEW_SHA on $BRANCH (checkout equality is not deployment success)"

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
        git -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$AURORA_UPDATE_ALLOWED_SIGNERS" verify-commit "$NEW_SHA" >>"$LOG_FILE" 2>&1 || VERIFY_OK=0
    else
        git verify-commit "$NEW_SHA" >>"$LOG_FILE" 2>&1 || VERIFY_OK=0
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

# --ff-only alone accepts a target behind local HEAD as "already up to date".
# That would build unverified local commits while labelling them as NEW_SHA.
if ! git merge-base --is-ancestor "$OLD_SHA" "$NEW_SHA"; then
    write_status failed "Source checkout is ahead of or diverged from origin/$BRANCH; refusing to build a different revision from the verified target." "$OLD_SHA" "$NEW_SHA"
    log "source is not an ancestor of the verified target; manual reconciliation needed"
    exit 1
fi
if ! git merge --ff-only "$NEW_SHA" >>"$LOG_FILE" 2>&1; then
    write_status failed "Cannot fast-forward to origin/$BRANCH — manual reconciliation needed (the local branch has diverged)." "$OLD_SHA" "$NEW_SHA"
    log "merge --ff-only refused; branch diverged"
    exit 1
fi

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
if ! CGO_ENABLED=0 go build -ldflags="-s -w -X main.version=${VERSION}" -o "$FRONTEND_TMP/aurora" ./cmd/aurora >>"$LOG_FILE" 2>&1; then
    write_status failed "go build failed — see /var/log/aurora/update.log. Old binary is still running." "$OLD_SHA" "$NEW_SHA"
    log "go build failed"
    rm -rf "$FRONTEND_TMP"
    exit 1
fi

# Record installation intent before the first live-file mutation. Retain it
# after interrupted installs, restart failures, or rollback; only confirmed
# success clears it. Pre-install build failures do not poison future retries.
write_deploy_state "$PENDING_FILE" "$NEW_SHA"

# ── Install ───────────────────────────────────────────────────────
write_status installing "Installing new binary, migrations, and static assets" "$OLD_SHA" "$NEW_SHA"
log "installing..."

# Audit H3 — snapshot the last known-good binary + static dir BEFORE the
# swap so we can roll back if the new build fails its health
# check. Migrations are intentionally NOT snapshotted: forward
# migrations are usually irreversible (DROP COLUMN, type changes),
# and a binary that panics on startup typically does so BEFORE the
# migration runs — so a binary rollback alone restores service.
# Operators with reversible migrations can `pg_dump` separately
# before tagging a release.

# Snapshot publication is atomic.  In particular, a failed copy cannot turn a
# partially prepared tree into a valid snapshot or destroy one retained from a
# prior failed attempt.
if ! prepare_rollback_snapshots; then
    write_status failed "Could not prepare a complete rollback snapshot; live files were not changed. Correct storage/permissions and run 'sudo aurora-update --retry'." "$OLD_SHA" "$NEW_SHA"
    log "rollback snapshot preparation failed"
    rm -rf "$FRONTEND_TMP"
    exit 1
fi

# Binary swap. install + rename = atomic on POSIX — there's never
# a moment when /usr/local/bin/aurora doesn't exist or is
# half-written. (systemd keeps using the OLD inode for the running
# process until we restart; the new binary is what fires on next exec.)
install -m 755 "$FRONTEND_TMP/aurora" "$INSTALL_BIN.new"
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

# Static SPA bundle. The root-owned rollback snapshot above remains untouched
# while any install is pending; static.old is only a transient swap name.
rm -rf "$INSTALL_DIR/static.old"
stage_static_bundle "$FRONTEND_TMP/v2"
if [ -d "$INSTALL_DIR/static" ]; then
    mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.old"
fi
mv "$INSTALL_DIR/static.new" "$INSTALL_DIR/static"
rm -rf "$FRONTEND_TMP"

chown -R aurora:aurora "$INSTALL_DIR"

# ── Ensure LLM models (best-effort) ───────────────────────────────
# A rebuilt binary may default to Ollama models this box has never pulled
# (the Phase E4 swap to qwen3-embedding/qwen3, and any future one). Only
# install.sh used to pull models, so timer-driven updates could strand
# semantic search on a 404ing model until an operator intervened. Pull
# anything missing BEFORE the restart — the old server keeps serving
# during the download — and stay strictly best-effort: no ollama CLI, a
# non-local URL, or a failed pull must never block the update. Admin-UI
# (DB) model overrides aren't visible here (no psql dependency); env +
# binary defaults are the right signal for exactly the installs that are
# at risk (default-followers).
ensure_llm_models() {
    case "${LLM_ENABLED:-true}" in
        false|0|no) return 0 ;;
    esac
    _OLLAMA_URL="${LLM_OLLAMA_URL:-http://localhost:11434}"
    _EMBED_MODEL="${LLM_EMBED_MODEL:-qwen3-embedding:0.6b}"
    _CHAT_MODEL="${LLM_CHAT_MODEL:-qwen3:4b-instruct}"
    case "$_OLLAMA_URL" in
        "http://localhost:"*|"http://127.0.0.1:"*|"http://[::1]:"*|"http://localhost"|"http://127.0.0.1") ;;
        *) log "LLM model check skipped (non-local Ollama URL: $_OLLAMA_URL)"; return 0 ;;
    esac
    command -v ollama >/dev/null 2>&1 || { log "LLM model check skipped (no ollama CLI)"; return 0; }
    _TAGS="$(curl -sf --max-time 5 "$_OLLAMA_URL/api/tags" 2>/dev/null || true)"
    [ -n "$_TAGS" ] || { log "LLM model check skipped (Ollama not reachable at $_OLLAMA_URL)"; return 0; }
    for _m in "$_EMBED_MODEL" "$_CHAT_MODEL"; do
        # Same match rule as install.sh's preflight: exact tag, or the
        # ":latest" form for an untagged name. -F: model names contain
        # dots, which must not act as regex wildcards.
        if printf '%s' "$_TAGS" | grep -qF "\"name\":\"$_m\""; then continue; fi
        case "$_m" in
            *:*) ;;
            *) if printf '%s' "$_TAGS" | grep -qF "\"name\":\"$_m:latest\""; then continue; fi ;;
        esac
        log "LLM model $_m missing — pulling (old server keeps serving during download)..."
        if ollama pull "$_m" >>"$LOG_FILE" 2>&1; then
            log "pulled $_m"
        else
            log "WARNING: ollama pull $_m failed — semantic search may degrade until it is pulled manually"
        fi
    done
}
ensure_llm_models

# ── Restart + health check ────────────────────────────────────────

# Drain active HLS stream sessions before restarting: systemctl restart
# sends SIGTERM to the entire cgroup (KillMode=control-group default), which
# kills FFmpeg children immediately AND destroys the in-memory transcode
# sessions, breaking playback for anyone watching. Wait up to 300 s for
# viewers to finish organically; the _DRAIN_LOG_EVERY throttle keeps log
# noise low.
#
# The gate used to be `pgrep -u aurora ffmpeg`, which measured the wrong
# thing. Aurora reaps the encoder for a PAUSED viewer ("reaped idle transcode
# variant ... resumable") while keeping the session alive, so a paused viewer
# has NO ffmpeg process. pgrep saw an idle box and we restarted out from under
# them; the client then POSTed keepalive against a dead session for the next
# hour. Observed twice in production on 2026-08-02.
#
# The server now publishes the honest count — sessions a client is still
# holding, playing or paused — to $STREAM_STATE_FILE every 30 s.
STREAM_STATE_FILE=/var/lib/aurora/stream-state.json
_STREAM_STATE_MAX_AGE=90   # snapshot older than this is "unknown", not "zero"

# viewers_held echoes the number of sessions a client is still holding, or the
# empty string when the server's snapshot is missing/stale/unparseable — the
# caller then falls back to the pgrep heuristic.
#
# Staleness matters: a wedged or freshly-restarted server leaves a snapshot
# that looks exactly like an idle one, and believing a stale zero is precisely
# the bug being fixed. Old servers that predate this file always fall back,
# which is what makes the script safe to deploy before the binary that writes
# it (the drain reads the OLD, still-running server).
viewers_held() {
    [ -r "$STREAM_STATE_FILE" ] || return 0

    _vh_now=$(date +%s)
    _vh_ts=$(sed -n 's/.*"unix_time"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$STREAM_STATE_FILE")
    _vh_held=$(sed -n 's/.*"held_by_viewer"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$STREAM_STATE_FILE")
    # Validate each field independently. A partially-written or renamed-key
    # file must land on "unknown" (fall back to pgrep), never on a bare 0
    # that would wave a deploy through while someone is watching.
    case "$_vh_ts" in ''|*[!0-9]*) return 0 ;; esac
    case "$_vh_held" in ''|*[!0-9]*) return 0 ;; esac
    [ $((_vh_now - _vh_ts)) -le "$_STREAM_STATE_MAX_AGE" ] || return 0

    printf '%s' "$_vh_held"
}

# streams_busy is the drain predicate: true while a restart would interrupt
# someone.
#
# The UNION of both signals, not a preference between them — each covers a
# gap the other has:
#
#   - The snapshot refreshes every 30s, so a stream started seconds ago still
#     reports held_by_viewer=0. pgrep sees its encoder immediately.
#   - A paused viewer's encoder is reaped, so pgrep sees nothing. The
#     snapshot still counts them, which is the whole point of this change.
#
# Taking either signal alone reintroduces one of the two bugs. The union is
# never less conservative than the pgrep-only gate it replaces, and it still
# converges: an abandoned session's variants are reaped after 75s (ffmpeg
# exits) and it drops out of the 120s viewer window, so both signals go
# quiet and the drain completes.
streams_busy() {
    _sb_held=$(viewers_held)
    if [ -n "$_sb_held" ] && [ "$_sb_held" -gt 0 ]; then
        return 0
    fi
    pgrep -u aurora ffmpeg >/dev/null 2>&1
}

_DRAIN_MAX=300
_DRAIN_WAITED=0
_DRAIN_LOG_EVERY=30  # log at most once per 30 s
_DRAIN_NEXT_LOG=0
if streams_busy; then
    # Say which signals are live, so a deploy that waits (or doesn't) can be
    # explained after the fact from this log alone — the old gate logged
    # "drained" while it was actively breaking someone's stream.
    _DRAIN_HELD=$(viewers_held)
    if [ -z "$_DRAIN_HELD" ]; then
        log "drain gate: ffmpeg-only (no fresh $STREAM_STATE_FILE — old build or stale snapshot)"
    elif [ "$_DRAIN_HELD" -gt 0 ]; then
        log "drain gate: server reports ${_DRAIN_HELD} session(s) held by viewers"
    else
        # Snapshot is fresh and says nobody, yet we are waiting — so ffmpeg is
        # the reason (a stream started inside the publish window). Saying
        # "server reports 0 held" here read as if the snapshot were the cause,
        # which defeats the point of logging why a deploy waits.
        log "drain gate: snapshot reports 0 held, but ffmpeg is still running — waiting on it"
    fi
    write_status restarting "Waiting for active stream sessions to finish before restart (up to ${_DRAIN_MAX}s)…" "$OLD_SHA" "$NEW_SHA"
    while streams_busy && [ "$_DRAIN_WAITED" -lt "$_DRAIN_MAX" ]; do
        if [ "$_DRAIN_WAITED" -ge "$_DRAIN_NEXT_LOG" ]; then
            _DRAIN_HELD=$(viewers_held)
            log "active stream sessions detected — waiting for viewers to finish (${_DRAIN_WAITED}/${_DRAIN_MAX}s${_DRAIN_HELD:+, ${_DRAIN_HELD} held by viewers})..."
            _DRAIN_NEXT_LOG=$((_DRAIN_NEXT_LOG + _DRAIN_LOG_EVERY))
        fi
        sleep 10
        _DRAIN_WAITED=$((_DRAIN_WAITED + 10))
    done
    if streams_busy; then
        # Deliberately still restarting: a viewer who fell asleep mid-movie
        # must not block deploys forever. Clients recover — VideoPlayer
        # rebuilds the session at the current position when keepalive 404s.
        log "WARNING: stream sessions still active after ${_DRAIN_MAX}s, restarting anyway"
    else
        log "stream sessions drained after ${_DRAIN_WAITED}s"
    fi
fi

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
    if ! refresh_installed_updater; then
        write_status failed "Aurora passed its health check, but installing the updated updater script failed. See update.log; correct permissions/storage and run 'sudo aurora-update --retry'." "$OLD_SHA" "$NEW_SHA"
        log "updater refresh failed after healthy application restart"
        exit 1
    fi
    DEPLOYED_FINGERPRINT="$(deployment_fingerprint)"
    write_deploy_state "$DEPLOYED_FILE" "$NEW_SHA $DEPLOYED_FINGERPRINT"
    if ! retire_rollback_snapshots; then
        write_status failed "Aurora passed its health check, but rollback snapshot cleanup failed. Pending state is retained; correct storage/permissions and run 'sudo aurora-update --retry'." "$OLD_SHA" "$NEW_SHA"
        log "rollback snapshot retirement failed after healthy deployment"
        exit 1
    fi
    rm -rf -- "$INSTALL_DIR/static.old"
    rm -f -- "$PENDING_FILE"
    COMMIT_SUBJECT="$(git log -1 --format=%s "$NEW_SHA" 2>/dev/null || echo "$NEW_SHA")"
    write_status success "Updated to $NEW_SHA ($COMMIT_SUBJECT)" "$OLD_SHA" "$NEW_SHA"
    log "SUCCESS: now running $NEW_SHA"
    exit 0
fi

# Audit H3 — health check failed. Attempt automatic rollback to
# the prior binary + static dir snapshots. Migrations stay in
# place (see snapshot rationale above). If rollback also fails,
# we leave the box in the broken state but report it loudly so
# the operator knows what they're walking into.
log "service unhealthy — attempting rollback to the previous installed snapshot (not inferred from checkout HEAD)"
write_status restarting "New version failed health check — rolling back to previous binary" "$OLD_SHA" "$NEW_SHA"

ROLLBACK_OK=true
if [ -f "$ROLLBACK_BIN" ]; then
    # The failing binary stays as /usr/local/bin/aurora.failed for
    # post-mortem; the retained snapshot becomes the live binary again.
    mv "$INSTALL_BIN" "$INSTALL_BIN.failed"
    cp -p -- "$ROLLBACK_BIN" "$INSTALL_BIN"
else
    log "no $ROLLBACK_BIN snapshot found — cannot rollback binary"
    ROLLBACK_OK=false
fi
if [ -d "$ROLLBACK_STATIC" ]; then
    # Move the broken static dir aside (for inspection) and
    # restore the snapshot.
    mv "$INSTALL_DIR/static" "$INSTALL_DIR/static.failed"
    cp -a -- "$ROLLBACK_STATIC/." "$INSTALL_DIR/static/"
    rm -rf "$INSTALL_DIR/static.failed"
else
    log "no $ROLLBACK_STATIC snapshot found — cannot rollback static"
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
    write_status failed "Update to $NEW_SHA failed its health check — restored the previous installed snapshot. Automatic retry of this revision is paused; inspect the failure before using --retry. The bad binary is at $INSTALL_BIN.failed for post-mortem; check 'journalctl -u aurora -n 80' to see why it crashed." "$OLD_SHA" "$NEW_SHA"
    log "rollback health check passed; failed revision $NEW_SHA remains pending manual retry"
elif $ROLLBACK_OK; then
    write_status failed "Update FAILED and rollback ALSO failed health check. Manual recovery required: ssh in, inspect 'journalctl -u aurora -n 80', and restore service." "$OLD_SHA" "$NEW_SHA"
    log "rollback restart also unhealthy — manual recovery required"
else
    write_status failed "Update FAILED and no rollback snapshot was available. /usr/local/bin/aurora is the broken build; restore from a known-good backup." "$OLD_SHA" "$NEW_SHA"
    log "no rollback snapshot — manual recovery required"
fi
exit 1
