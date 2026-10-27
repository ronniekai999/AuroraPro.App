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
#   - Refuses to update if the working tree has tracked changes (would lose work).
#   - Refuses non-fast-forward merges (would require conflict
#     resolution we can't automate).
#   - Builds the frontend AND the binary from an export of the exact target
#     commit, never from the working tree, so untracked or ignored files in the
#     checkout cannot reach an installed artifact; a target without the SPA
#     source is refused rather than paired with some other build's bundle.
#   - On build failure, leaves the running binary untouched.
#   - After the restart, the deploy counts only when aurora.service's main
#     process is running exactly the binary just installed, /api/health reports
#     status ok with the database connected, and /v2/ serves the index.html just
#     installed, and the same process still does a few seconds later.
#   - ANY failure once installation has begun (a failed copy, a failed
#     `systemctl restart`, failed verification, an unexpected abort or a
#     signal) restores the snapshot of the previous binary, static tree and
#     migration files and verifies the restored service the same way. The
#     database is NOT rolled back.
#   - Marks a revision deployed only after that verification succeeds.
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
ROLLBACK_MIGRATIONS="$ROLLBACK_DIR/rollback-migrations"
# The target commit is exported here and built in place. A stable path, not
# mktemp: Go's build cache keys main-module packages by directory, so a fresh
# path each run would recompile the whole module on every update.
BUILD_TREE="$DEPLOY_STATE_DIR/build"
VERIFY_INDEX="$DEPLOY_STATE_DIR/.verify-index.html"
SPA_SRC_DIR=static/redesign/app
SPA_OUTPUT_DIR=static/v2
# Written by the server once it has bound its listener (cmd/aurora/
# serving_record.go): which pid listens where, over which scheme. It lives in
# the aurora user's cache dir (the server cannot write /var/lib/aurora), so it
# is read as untrusted input; see service_endpoint.
SERVING_FILE=/var/cache/aurora/serving.json
PROC_ROOT=/proc
# A restarted service gets VERIFY_TIMEOUT seconds (and at most that many probe
# rounds; rounds bound the stubbed tests, where sleep returns at once) to pass
# verification, then must pass again VERIFY_SETTLE seconds later as the same
# process. RestartSec=5, so a crash in that window shows as a changed pid.
VERIFY_TIMEOUT=60
VERIFY_SETTLE=10
# none → files (live files are being replaced) → restarted → verified, or
# rolling_back. The EXIT trap rolls back whenever the script leaves in `files`
# or `restarted`, whatever the reason.
INSTALL_PHASE=none
ABORT_LINE=""

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
    python3 -I <<'PY' > "$STATUS_FILE.tmp"
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

# build_frontend_bundle SRC OUT — build the SPA in SRC (inside the exported
# target tree) into OUT.
#
# There is deliberately no fallback for a missing SRC. This used to reuse
# static/v2 from the checkout, which is gitignored: whatever an earlier build
# had left there, installed beside a binary built from this revision. A target
# without the SPA source is a broken release, and fails like any other build.
build_frontend_bundle() {
    local src="$1" out_dir="$2"
    if [ ! -d "$src" ]; then
        log "$NEW_SHA has no $SPA_SRC_DIR; refusing to install a frontend that was not built from this revision"
        return 1
    fi
    if ! command -v npm >/dev/null 2>&1; then
        log "npm not found; install Node.js/npm or re-run install.sh"
        return 1
    fi

    rm -rf "$out_dir" || return 1
    mkdir -p "$(dirname "$out_dir")" || return 1
    if [ -f "$src/package-lock.json" ]; then
        log "npm ci..."
        if ! (cd "$src" && npm ci --no-audit --no-fund >>"$LOG_FILE" 2>&1); then
            log "npm ci failed; refusing to build with incomplete dependencies"
            return 1
        fi
    else
        log "npm install..."
        if ! (cd "$src" && npm install --no-audit --no-fund >>"$LOG_FILE" 2>&1); then
            log "npm install failed; refusing to build with incomplete dependencies"
            return 1
        fi
    fi
    log "vite build..."
    (cd "$src" && npm run build -- --outDir "$out_dir" >>"$LOG_FILE" 2>&1) || return 1
    # Verification compares the served /v2/ with this file, and the server will
    # not serve a static dir without it (findStaticDir).
    if [ ! -f "$out_dir/index.html" ]; then
        log "the frontend build reported success but produced no index.html"
        return 1
    fi
}

# stage_static_bundle STATIC_SRC BUILT_V2 — assemble $INSTALL_DIR/static.new from
# the exported tree's static/ (minus the SPA source and any v2) plus the build.
# Every step reports failure: called from a condition, set -e does not apply
# inside, and `find -exec ... \;` would swallow a failed copy.
stage_static_bundle() {
    local static_src="$1" built_v2_dir="$2"
    rm -rf -- "$INSTALL_DIR/static.new" || return 1
    mkdir -p -- "$INSTALL_DIR/static.new" || return 1
    if [ -d "$static_src" ]; then
        find "$static_src" -mindepth 1 -maxdepth 1 ! -name redesign ! -name v2 \
            -exec cp -R -t "$INSTALL_DIR/static.new/" -- {} + || return 1
    fi
    cp -R -- "$built_v2_dir" "$INSTALL_DIR/static.new/v2"
}

# export_target_tree — a clean copy of exactly NEW_SHA's tracked files in
# BUILD_TREE. The working-tree check below sees tracked changes only; an
# untracked .go file in a package directory would otherwise be compiled in,
# and untracked or ignored files under static/ copied into the install.
export_target_tree() {
    rm -rf -- "$BUILD_TREE" || return 1
    mkdir -p -- "$BUILD_TREE" || return 1
    git archive --format=tar "$NEW_SHA" | tar -xf - -C "$BUILD_TREE"
}

# ERR trap — when set -e trips, capture the line and report. Once live files
# are being replaced, reporting is the EXIT trap's job (cleanup), which rolls
# back first. Note the ERR trap does not run for a command failing INSIDE a
# function (no errtrace), which is one reason the rollback hangs off EXIT.
on_error() {
    local lineno="$1"
    ABORT_LINE="$lineno"
    log "ABORT at line $lineno (set -e tripped)"
    case "$INSTALL_PHASE" in
        files|restarted) ;;
        *) write_status failed "Update script aborted at line $lineno — see /var/log/aurora/update.log" ;;
    esac
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
# EXIT trap. Every deliberate exit after installation begins goes through
# fail_install or reaches `verified` first, so leaving in `files` or
# `restarted` means an unplanned stop: set -e (including inside a function,
# where the ERR trap never runs), SIGTERM from systemd's TimeoutStartSec, or
# Ctrl-C. Any of those used to leave a half-installed tree with no rollback.
cleanup() {
    local rc=$? where
    trap - ERR
    case "$INSTALL_PHASE" in
        files|restarted)
            if [ "$INSTALL_PHASE" = files ]; then where="while installing files"; else where="after restarting the service"; fi
            report_rollback "the update stopped unexpectedly $where${ABORT_LINE:+ (line $ABORT_LINE)}, exit status $rc"
            [ "$rc" -ne 0 ] || rc=1
            ;;
    esac
    if [ -n "${FRONTEND_TMP:-}" ]; then rm -rf -- "$FRONTEND_TMP"; fi
    # Staged-but-unused install files; after a swap these no longer exist.
    rm -rf -- "$BUILD_TREE" "$VERIFY_INDEX" "$INSTALL_BIN.new" "$INSTALL_DIR/static.new" || true
    exec 9>&- || true
    exit "$rc"
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

# Only when the checkout has the SPA source. build_frontend_bundle has no
# fallback, so a target without it fails at the build whatever Node says. This
# reads the checkout BEFORE the merge: a target that first adds the source is
# not gated here, and an unusable Node then fails at the build instead.
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
    # Migration FILES, not the database. db.RunMigrations applies every .up.sql
    # in the directory that schema_migrations lacks and ignores versions it has
    # no file for, so restoring the old files keeps a restored binary from
    # applying the failed release's migrations at its next start, and is
    # harmless when the failed release already applied them.
    if [ -d "$INSTALL_DIR/migrations" ] && ! cp -a -- "$INSTALL_DIR/migrations" "$tmp/rollback-migrations"; then
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
    python3 -I - "$INSTALL_BIN" "$INSTALL_UPDATER" "$INSTALL_DIR/static" "$INSTALL_DIR/migrations" <<'DEPLOY_PY'
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

# ── Verifying the running service ─────────────────────────────────
#
# The old check was `curl -sf http://localhost:8484/api/health`. It hard-coded
# the port (an AURORA_PORT install failed every update), assumed plain HTTP (a
# server terminating its own TLS failed every update), passed with the
# database down (the route answers 200 "degraded"), never asked which binary
# was running or which process answered, and never looked at the frontend.
# Each helper below checks one of those things on the process systemd is
# actually running.

file_sha256() {
    python3 -I -c '
import hashlib, sys
digest = hashlib.sha256()
with open(sys.argv[1], "rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
print(digest.hexdigest())' "$1"
}

# main_pid — aurora.service's main process, or failure when it has none
# (stopped, crashed, or between automatic restarts).
main_pid() {
    local pid
    pid="$(systemctl show -p MainPID --value aurora 2>/dev/null)" || return 1
    case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
    printf '%s' "$pid"
}

# runs_binary PID SHA256 — is that process executing exactly this content?
# /proc/<pid>/exe opens the inode the process was started from even after the
# path is replaced, so this compares what RUNS, not what is on disk. It also
# catches a unit whose ExecStart (say, a drop-in) runs some other file.
runs_binary() {
    local actual
    actual="$(file_sha256 "$PROC_ROOT/$1/exe" 2>/dev/null)" || return 1
    [ "$actual" = "$2" ]
}

# service_endpoint PID — "scheme|host|port|tls-name|source" for reaching that
# process, or a reason (and failure) when it cannot be reached yet.
#
# The port is always one PID itself listens on, read from /proc/<pid>/fd and the
# process's TCP tables, so whatever answers there is that process (another
# socket can share the port only through SO_REUSEPORT as the same user). The
# serving record, when it names
# PID and one of those ports, says how to speak to it (scheme, TLS name), which
# covers a port or TLS set only in the config file. Without one, the scheme
# follows the TLS_* settings from aurora.env, and the port is AURORA_PORT, else
# the only one PID listens on, else 8484.
service_endpoint() {
    PROC_ROOT_ENV="$PROC_ROOT" SERVING_FILE_ENV="$SERVING_FILE" PID_ENV="$1" \
    python3 -I <<'PY'
import ipaddress, json, os, re, socket, stat, sys

proc, pid = os.environ["PROC_ROOT_ENV"], os.environ["PID_ENV"]
# fullmatch, not match with $: "$" also matches before a trailing newline.
NAME = re.compile(r"[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?")

def port_number(text):
    # str.isdigit() accepts non-ASCII digits; only 1-65535 in ASCII will do.
    return int(text) if text.isascii() and text.isdigit() and 0 < int(text) < 65536 else None

def listening():
    inodes = set()
    fd_dir = os.path.join(proc, pid, "fd")
    try:
        names = os.listdir(fd_dir)
    except OSError:
        names = []
    for name in names:
        try:
            target = os.readlink(os.path.join(fd_dir, name))
        except OSError:
            continue
        if target.startswith("socket:[") and target.endswith("]"):
            inodes.add(target[8:-1])
    found = {}
    for table, family in (("tcp", socket.AF_INET), ("tcp6", socket.AF_INET6)):
        try:
            with open(os.path.join(proc, pid, "net", table)) as stream:
                rows = stream.read().splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            f = row.split()
            if len(f) < 10 or f[3] != "0A" or f[9] not in inodes:
                continue
            addr, _, port = f[1].partition(":")
            raw = bytes.fromhex(addr)
            if sys.byteorder == "little":
                # The kernel prints each 32-bit word as a host-order integer.
                raw = b"".join(raw[i:i + 4][::-1] for i in range(0, len(raw), 4))
            found.setdefault(int(port, 16), socket.inet_ntop(family, raw))
    return found

def connect_host(ip):
    addr = ipaddress.ip_address(ip)
    if addr.is_unspecified:
        # A wildcard bind, including Go's dual-stack "[::]", accepts loopback.
        return "127.0.0.1"
    if addr.version == 6:
        return str(addr.ipv4_mapped) if addr.ipv4_mapped else "[%s]" % addr
    return str(addr)

def serving_record():
    try:
        fd = os.open(os.environ["SERVING_FILE_ENV"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            return None
        data = stream.read(4097)
    try:
        rec = json.loads(data) if len(data) <= 4096 else None
    except ValueError:
        return None
    return rec if isinstance(rec, dict) else None

ports = listening()
if not ports:
    print("pid %s is not listening on any TCP port (yet)" % pid)
    sys.exit(1)

rec = serving_record()
if rec is not None and rec.get("pid") == int(pid):
    _, _, port_text = str(rec.get("addr") or "").rpartition(":")
    port = port_number(port_text)
    scheme = rec.get("scheme")
    name = str(rec.get("server_name") or "") if scheme == "https" else ""
    if port in ports and scheme in ("http", "https") and (not name or NAME.fullmatch(name)):
        print("|".join((scheme, connect_host(ports[port]), str(port), name, "serving record")))
        sys.exit(0)

def setting(key):
    return os.environ.get(key, "").strip()

want = port_number(setting("AURORA_PORT"))
if want in ports:
    port = want
elif len(ports) == 1:
    port = next(iter(ports))
elif 8484 in ports:
    port = 8484
else:
    print("pid %s listens on ports %s, and neither a serving record nor AURORA_PORT says which is Aurora's"
          % (pid, ", ".join(str(p) for p in sorted(ports))))
    sys.exit(1)
# The same choice the server makes (cmd/aurora/main.go): autocert needs a domain,
# a manual certificate needs both files.
domain = setting("TLS_DOMAIN") if NAME.fullmatch(setting("TLS_DOMAIN")) else ""
if setting("TLS_AUTO_CERT").lower() in ("true", "1", "yes") and domain:
    scheme, name = "https", domain
elif setting("TLS_CERT_FILE") and setting("TLS_KEY_FILE"):
    scheme, name = "https", domain
else:
    scheme, name = "http", ""
print("|".join((scheme, connect_host(ports[port]), str(port), name,
                "listening socket, scheme from aurora.env; no serving record names this process")))
PY
}

# curl_service PATH — GET PATH from the endpoint probe_service resolved.
curl_service() {
    local url="$SVC_SCHEME://$SVC_HOST:$SVC_PORT$1"
    # --noproxy: aurora.env is sourced, and an http_proxy there would otherwise
    # carry this loopback request off to the proxy.
    local args=(-sf --max-time 5 --max-filesize 1048576 --noproxy '*' --proto '=http,https')
    if [ "$SVC_SCHEME" = https ]; then
        # The certificate names the public domain, not loopback. Which process
        # answers is already settled: the port is one the verified pid listens on.
        args+=(--insecure)
        if [ -n "$SVC_TLS_NAME" ]; then
            # autocert refuses a handshake without the configured name (SNI).
            args+=(--resolve "$SVC_TLS_NAME:$SVC_PORT:$SVC_HOST")
            url="https://$SVC_TLS_NAME:$SVC_PORT$1"
        fi
    fi
    curl "${args[@]}" "$url"
}

# probe_service SHA256 INDEX BASELINE_PID — one round of checks against the
# running service. Sets PROBED_PID, and VERIFY_REASON when a check fails;
# VERIFY_FATAL=true when waiting cannot help (the process is gone or was
# replaced).
probe_service() {
    local expected="$1" index="$2" baseline="$3" pid endpoint body where
    PROBED_PID=""
    VERIFY_FATAL=false
    if ! pid="$(main_pid)"; then
        VERIFY_REASON="aurora.service's main process (pid $baseline) exited"
        VERIFY_FATAL=true
        return 1
    fi
    PROBED_PID="$pid"
    if [ "$pid" != "$baseline" ]; then
        VERIFY_REASON="aurora.service's main process changed from pid $baseline to $pid (it exited and was restarted)"
        VERIFY_FATAL=true
        return 1
    fi
    # Not fatal: aurora.service is Type=simple, so systemd reports it started
    # once it has forked, before the child has exec'd the binary, and until
    # then /proc/<pid>/exe is systemd's own executor. A unit that really runs
    # some other file fails here at the deadline instead.
    if ! runs_binary "$pid" "$expected"; then
        VERIFY_REASON="aurora.service's main process (pid $pid) is not running the binary just installed at $INSTALL_BIN"
        return 1
    fi
    if ! endpoint="$(service_endpoint "$pid")"; then
        VERIFY_REASON="${endpoint:-could not work out where pid $pid listens}"
        return 1
    fi
    SVC_SCHEME="${endpoint%%|*}"; endpoint="${endpoint#*|}"
    SVC_HOST="${endpoint%%|*}"; endpoint="${endpoint#*|}"
    SVC_PORT="${endpoint%%|*}"; endpoint="${endpoint#*|}"
    SVC_TLS_NAME="${endpoint%%|*}"; SVC_SOURCE="${endpoint#*|}"
    where="$SVC_SCHEME://$SVC_HOST:$SVC_PORT (from the $SVC_SOURCE)"
    if ! body="$(curl_service /api/health)"; then
        VERIFY_REASON="GET /api/health at $where did not answer"
        return 1
    fi
    if ! printf '%s' "$body" | python3 -I -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except ValueError:
    sys.exit(1)
ok = isinstance(doc, dict) and doc.get("status") == "ok" and doc.get("db_connected") is True
sys.exit(0 if ok else 1)'; then
        VERIFY_REASON="/api/health at $where did not report status ok with the database connected (it said: ${body:0:200})"
        return 1
    fi
    if ! curl_service /v2/ > "$VERIFY_INDEX"; then
        VERIFY_REASON="GET /v2/ at $where did not answer"
        return 1
    fi
    if ! cmp -s -- "$VERIFY_INDEX" "$index"; then
        VERIFY_REASON="/v2/ at $where is not serving the index.html just installed in $INSTALL_DIR/static (a stale or different frontend)"
        return 1
    fi
}

# verify_service SHA256 INDEX BASELINE_PID — BASELINE_PID (the main process
# right after the restart) must pass probe_service, and pass again at least
# VERIFY_SETTLE seconds later, within VERIFY_TIMEOUT + VERIFY_SETTLE seconds.
# Any change of main process fails at once: under Restart=on-failure a binary
# that crashes and comes back must not count as healthy, nor one that answers
# once and then dies. Anything else (not exec'd yet, still migrating, one slow
# answer) is retried until the deadline.
verify_service() {
    local expected="$1" index="$2" baseline="$3" rounds=0 passed=false
    local deadline=$((SECONDS + VERIFY_TIMEOUT + VERIFY_SETTLE))
    VERIFY_REASON="no check ran"
    if [ -z "$baseline" ]; then
        VERIFY_REASON="aurora.service had no running main process right after it was started"
    else
        while :; do
            if probe_service "$expected" "$index" "$baseline"; then
                if "$passed"; then
                    log "verified: pid $baseline runs the expected binary, reports healthy at $SVC_SCHEME://$SVC_HOST:$SVC_PORT ($SVC_SOURCE) and serves the installed frontend"
                    return 0
                fi
                passed=true
                sleep "$VERIFY_SETTLE"
                continue
            fi
            "$VERIFY_FATAL" && break
            rounds=$((rounds + 1))
            if [ "$rounds" -ge "$VERIFY_TIMEOUT" ] || [ "$SECONDS" -ge "$deadline" ]; then
                break
            fi
            sleep 1
        done
    fi
    log "verification failed: $VERIFY_REASON"
    return 1
}

# ── Rolling back ──────────────────────────────────────────────────

# restore_dir SNAPSHOT LIVE — replace LIVE with a copy of SNAPSHOT, staged
# beside it so the swap itself is two renames.
restore_dir() {
    local snapshot="$1" live="$2"
    rm -rf -- "$live.rollback" "$live.failed" || return 1
    cp -a -- "$snapshot" "$live.rollback" || return 1
    if [ -e "$live" ]; then
        mv -- "$live" "$live.failed" || return 1
    fi
    mv -- "$live.rollback" "$live" || return 1
    rm -rf -- "$live.failed"
}

# roll_back_install REASON — put the snapshot generation back and verify it.
# Sets ROLLBACK_RESULT to restored, unhealthy or unavailable. Never exits, and
# runs with errexit and the ERR trap off: a rollback must try every step.
roll_back_install() {
    local reason="$1" expected="" pid baseline="" problems=""
    INSTALL_PHASE=rolling_back
    trap - ERR
    # A TERM (systemd's TimeoutStartSec, again) between two renames would leave
    # no static tree at all. Only SIGKILL can stop a rollback now.
    trap '' TERM INT
    set +e
    log "rolling back: $reason"
    write_status restarting "Update to $NEW_SHA failed ($reason) — restoring the previous installed snapshot" "$OLD_SHA" "$NEW_SHA"
    if [ ! -f "$ROLLBACK_BIN" ]; then
        log "no $ROLLBACK_BIN snapshot found — cannot roll back"
        ROLLBACK_RESULT=unavailable
        return 0
    fi
    # Keep the failing binary for post-mortem, unless the failure came before
    # it was installed and the live file is still the snapshot's binary.
    if [ -f "$INSTALL_BIN" ] && ! cmp -s -- "$INSTALL_BIN" "$ROLLBACK_BIN"; then
        cp -p -- "$INSTALL_BIN" "$INSTALL_BIN.failed" || log "could not keep $INSTALL_BIN.failed for post-mortem"
    fi
    if ! cp -p -- "$ROLLBACK_BIN" "$INSTALL_BIN.rollback" || ! mv -f -- "$INSTALL_BIN.rollback" "$INSTALL_BIN"; then
        problems="$problems the binary;"
    fi
    if [ -d "$ROLLBACK_STATIC" ]; then
        if restore_dir "$ROLLBACK_STATIC" "$INSTALL_DIR/static"; then
            # cp -a kept the snapshot's old mtimes, and the server answers
            # conditional requests from Last-Modified alone. A browser that
            # loaded the failed release's index.html (newer) would get 304 and
            # keep it, pointing at chunks that no longer exist: a blank page.
            find "$INSTALL_DIR/static" -type f -exec touch -h -- {} + \
                || log "could not refresh mtimes under $INSTALL_DIR/static; browsers that loaded the failed release may need a hard reload"
        else
            problems="$problems the static tree;"
        fi
    else
        problems="$problems the static tree (no snapshot of it);"
    fi
    if [ -d "$ROLLBACK_MIGRATIONS" ]; then
        restore_dir "$ROLLBACK_MIGRATIONS" "$INSTALL_DIR/migrations" || problems="$problems the migration files;"
    else
        # A generation kept from an attempt by an older updater has none.
        log "no $ROLLBACK_MIGRATIONS snapshot; the new migration files stay in place"
    fi
    chown -R aurora:aurora "$INSTALL_DIR" || problems="$problems ownership of $INSTALL_DIR;"
    if [ -n "$problems" ]; then
        log "rollback could not restore:$problems"
    fi

    expected="$(file_sha256 "$INSTALL_BIN")"
    # Before the restart, the previous process is still running the binary
    # just put back; restarting it would interrupt viewers for nothing.
    if pid="$(main_pid)" && runs_binary "$pid" "$expected"; then
        log "pid $pid already runs the restored binary; not restarting it"
        baseline="$pid"
    else
        log "restarting aurora.service on the restored snapshot"
        systemctl restart aurora >>"$LOG_FILE" 2>&1 || log "systemctl restart failed during rollback"
        baseline="$(main_pid)" || baseline=""
    fi
    if [ -n "$problems" ]; then
        VERIFY_REASON="the rollback could not restore:$problems"
        ROLLBACK_RESULT=unhealthy
    elif verify_service "$expected" "$INSTALL_DIR/static/v2/index.html" "$baseline"; then
        ROLLBACK_RESULT=restored
    else
        ROLLBACK_RESULT=unhealthy
    fi
}

# report_rollback REASON — roll back, then record the outcome as the status.
# The pending record stays, so the failed revision is not retried
# automatically.
report_rollback() {
    local reason="$1"
    roll_back_install "$reason"
    case "$ROLLBACK_RESULT" in
        restored)
            write_status failed "Update to $NEW_SHA failed ($reason) — restored the previous installed snapshot, which passed verification. Automatic retry of this revision is paused; inspect the failure before using --retry. A failed binary that was installed is kept at $INSTALL_BIN.failed; 'journalctl -u aurora -n 80' shows how it behaved." "$OLD_SHA" "$NEW_SHA"
            log "rolled back to the previous snapshot; failed revision $NEW_SHA remains pending manual retry"
            ;;
        unhealthy)
            write_status failed "Update to $NEW_SHA failed ($reason), and the restored previous snapshot ALSO failed verification: $VERIFY_REASON. Manual recovery required: ssh in, inspect 'journalctl -u aurora -n 80' and /var/log/aurora/update.log, and restore service." "$OLD_SHA" "$NEW_SHA"
            log "rollback did not verify — manual recovery required"
            ;;
        *)
            write_status failed "Update to $NEW_SHA failed ($reason) and no rollback snapshot was available. $INSTALL_BIN may be the broken build; restore from a known-good backup." "$OLD_SHA" "$NEW_SHA"
            log "no rollback snapshot — manual recovery required"
            ;;
    esac
}

# fail_install REASON — the one way to stop once installation has begun.
fail_install() {
    report_rollback "$1"
    exit 1
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
# Both halves are built from an export of NEW_SHA, never from $SOURCE_DIR: see
# export_target_tree. The merge above still moves the checkout, so it keeps
# matching what is deployed.
write_status building "Building Aurora frontend and binary" "$OLD_SHA" "$NEW_SHA"
log "exporting $NEW_SHA..."
if ! export_target_tree 2>>"$LOG_FILE"; then
    write_status failed "Could not export $NEW_SHA from $SOURCE_DIR to build it — see /var/log/aurora/update.log. Old binary/static assets are still running." "$OLD_SHA" "$NEW_SHA"
    log "export of $NEW_SHA failed"
    exit 1
fi
FRONTEND_TMP="$(mktemp -d)"
log "frontend build..."
if ! build_frontend_bundle "$BUILD_TREE/$SPA_SRC_DIR" "$FRONTEND_TMP/v2"; then
    write_status failed "frontend build failed — see /var/log/aurora/update.log. Old binary/static assets are still running." "$OLD_SHA" "$NEW_SHA"
    log "frontend build failed"
    exit 1
fi

log "go build..."

# --dirty no longer applies: what is built is the commit itself.
VERSION="$(git describe --tags --always "$NEW_SHA" 2>/dev/null || echo "$NEW_SHA")"
# GOWORK=off: a go.work above the build tree must not redirect modules.
# -buildvcs=false: the export has no .git to stamp from.
if ! (cd "$BUILD_TREE" && CGO_ENABLED=0 GOWORK=off go build -buildvcs=false -ldflags="-s -w -X main.version=${VERSION}" -o "$FRONTEND_TMP/aurora" ./cmd/aurora) >>"$LOG_FILE" 2>&1; then
    write_status failed "go build failed — see /var/log/aurora/update.log. Old binary is still running." "$OLD_SHA" "$NEW_SHA"
    log "go build failed"
    exit 1
fi
# What verification will require the restarted service to be running.
NEW_BIN_SHA="$(file_sha256 "$FRONTEND_TMP/aurora")"

# ── Stage ─────────────────────────────────────────────────────────
# Everything that can be prepared without touching a live file is, so a
# failure here costs nothing and stays automatically retryable.
SQL_FILES=()
shopt -s nullglob
for f in "$BUILD_TREE"/migrations/*.sql; do
    SQL_FILES+=("$f")
done
shopt -u nullglob
if [ "${#SQL_FILES[@]}" -eq 0 ]; then
    write_status failed "$NEW_SHA has no migration files; refusing to install a partial release. Old binary/static assets are still running." "$OLD_SHA" "$NEW_SHA"
    log "no migration files in $NEW_SHA"
    exit 1
fi
rm -rf -- "$INSTALL_DIR/static.old"
if ! stage_static_bundle "$BUILD_TREE/static" "$FRONTEND_TMP/v2" 2>>"$LOG_FILE" \
    || ! install -m 755 "$FRONTEND_TMP/aurora" "$INSTALL_BIN.new" 2>>"$LOG_FILE"; then
    write_status failed "Could not stage the new release beside the live one — see /var/log/aurora/update.log. Old binary/static assets are still running." "$OLD_SHA" "$NEW_SHA"
    log "staging failed"
    exit 1
fi

# Both waits below happen BEFORE anything live changes. They used to run after
# the install, so for up to the drain's five minutes (plus any model pull) the
# old backend served the new frontend to every browser that loaded a page.

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

# ── Drain ─────────────────────────────────────────────────────────

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
# The server now publishes the honest count (sessions a client is still
# holding, playing or paused) every 30 s; streams_busy reads it. Old servers
# that predate the file, or write it where it cannot be created, leave only the
# pgrep half, which is what makes the script safe to deploy before the binary
# that writes it: the drain reads the OLD, still-running server.
# AURORA-DRAIN-BEGIN — identical in aurora-update.sh, install.sh and redeploy.sh;
# scripts/drain-gate-test.sh checks the copies and how they behave. Duplicated
# rather than sourced for the reason node_vite_verdict is.
#
# streams_busy is true while restarting aurora.service would interrupt a viewer.
# It is the UNION of two signals, each covering the other's gap: the server's
# snapshot of the sessions a client is still holding, playing or paused
# (refreshed every 30 s; a paused viewer's encoder is reaped, so pgrep cannot
# see them), and `pgrep -u aurora ffmpeg` (which sees a stream started since
# the last snapshot). Either alone reintroduces one of the two bugs, and the
# union still converges: an abandoned session's encoder exits after 75 s and it
# leaves the 120 s viewer window.
#
# The server writes the snapshot to /var/cache/aurora because it cannot create
# files in /var/lib/aurora (root:root 0755: the root-owned source mirror lives
# there). The aurora user owns /var/cache/aurora, so the snapshot is read as
# untrusted input. A missing, stale or unreadable snapshot is "unknown", never
# "zero viewers": a crashed or wedged server's last snapshot looks exactly like
# an idle one.
STREAM_STATE_FILE=/var/cache/aurora/stream-state.json
_STREAM_STATE_MAX_AGE=90

# read_untrusted PATH — print a small regular file, refusing a symlink, a FIFO
# or anything large, so a file the aurora user controls can neither point root
# at another file nor hang it on a pipe nobody writes.
read_untrusted() {
    python3 -I -c '
import os, stat, sys
try:
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
except OSError:
    sys.exit(1)
with os.fdopen(fd, "rb") as stream:
    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
        sys.exit(1)
    data = stream.read(65537)
if len(data) > 65536:
    sys.exit(1)
sys.stdout.write(data.decode("utf-8", "replace"))' "$1"
}

# viewers_held — how many sessions the snapshot says a client is holding, or
# nothing when that is unknown.
viewers_held() {
    local state
    state="$(read_untrusted "$STREAM_STATE_FILE" 2>/dev/null)" || return 0
    _vh_now=$(date +%s)
    _vh_ts=$(printf '%s\n' "$state" | sed -n 's/.*"unix_time"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p')
    _vh_held=$(printf '%s\n' "$state" | sed -n 's/.*"held_by_viewer"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p')
    # Each field on its own: a half-written or renamed-key snapshot is unknown,
    # and so is a number bash would choke on. The aurora user can write this
    # file: "0793" is an invalid octal to $(( )) and aborts a set -e caller,
    # and a twenty-digit one overflows; 10# reads what is left as decimal.
    case "$_vh_ts" in ''|*[!0-9]*) return 0 ;; esac
    case "$_vh_held" in ''|*[!0-9]*) return 0 ;; esac
    [ "${#_vh_ts}" -le 12 ] && [ "${#_vh_held}" -le 6 ] || return 0
    [ $((_vh_now - 10#$_vh_ts)) -le "$_STREAM_STATE_MAX_AGE" ] || return 0
    printf '%s' "$((10#$_vh_held))"
}

streams_busy() {
    _sb_held=$(viewers_held)
    if [ -n "$_sb_held" ] && [ "$_sb_held" -gt 0 ]; then
        return 0
    fi
    pgrep -u aurora ffmpeg >/dev/null 2>&1
}

# drain_wait MAX — wait in 10 s steps, up to MAX seconds, while streams_busy.
# Sets DRAIN_WAITED. Fails when the streams are still going at MAX: a viewer who
# fell asleep mid-film must not block a deploy forever, and the player rebuilds
# its session at the same position when its keepalive is refused.
drain_wait() {
    DRAIN_WAITED=0
    while streams_busy; do
        [ "$DRAIN_WAITED" -lt "$1" ] || return 1
        sleep 10
        DRAIN_WAITED=$((DRAIN_WAITED + 10))
    done
}
# AURORA-DRAIN-END

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

# Record installation intent before the first live-file mutation. Retain it
# after interrupted installs, restart failures, or rollback; only confirmed
# success clears it. Pre-install build failures do not poison future retries.
write_deploy_state "$PENDING_FILE" "$NEW_SHA"

# ── Install ───────────────────────────────────────────────────────
write_status installing "Installing new binary, migrations, and static assets" "$OLD_SHA" "$NEW_SHA"
log "installing..."

# Audit H3 — snapshot the last known-good binary, static dir and migration
# files BEFORE the swap, so any failure from here on can put them back. The
# database is not snapshotted: forward migrations are usually irreversible
# (DROP COLUMN, type changes). Operators with reversible migrations can
# `pg_dump` separately before tagging a release.
#
# Snapshot publication is atomic.  In particular, a failed copy cannot turn a
# partially prepared tree into a valid snapshot or destroy one retained from a
# prior failed attempt.
if ! prepare_rollback_snapshots; then
    write_status failed "Could not prepare a complete rollback snapshot; live files were not changed. Correct storage/permissions and run 'sudo aurora-update --retry'." "$OLD_SHA" "$NEW_SHA"
    log "rollback snapshot preparation failed"
    exit 1
fi

# From here until verification, every way out restores the snapshot: each step
# below names its failure to fail_install, and anything else is caught by the
# EXIT trap.
INSTALL_PHASE=files

# Binary swap: a rename, so /usr/local/bin/aurora is never missing or
# half-written. (systemd keeps using the OLD inode for the running process
# until we restart; the new binary is what fires on next exec.)
mv -f -- "$INSTALL_BIN.new" "$INSTALL_BIN" 2>>"$LOG_FILE" || fail_install "installing the new binary failed"

{ mkdir -p "$INSTALL_DIR/migrations" && cp -f "${SQL_FILES[@]}" "$INSTALL_DIR/migrations/"; } 2>>"$LOG_FILE" \
    || fail_install "copying the migration files failed"

# Static SPA bundle. The root-owned rollback snapshot above remains untouched
# while any install is pending; static.old is only a transient swap name.
if [ -d "$INSTALL_DIR/static" ]; then
    mv -- "$INSTALL_DIR/static" "$INSTALL_DIR/static.old" 2>>"$LOG_FILE" \
        || fail_install "moving the previous static bundle aside failed"
fi
mv -- "$INSTALL_DIR/static.new" "$INSTALL_DIR/static" 2>>"$LOG_FILE" \
    || fail_install "installing the new static bundle failed"

chown -R aurora:aurora "$INSTALL_DIR" 2>>"$LOG_FILE" || fail_install "chown of $INSTALL_DIR failed"

write_status restarting "Restarting aurora.service" "$OLD_SHA" "$NEW_SHA"
log "restarting service..."

INSTALL_PHASE=restarted
# A failed restart used to trip set -e and exit with the new files installed
# and nothing running them, no rollback attempted.
systemctl restart aurora >>"$LOG_FILE" 2>&1 || fail_install "'systemctl restart aurora' failed"
# The process verification is about. Any later main pid means it exited.
RESTART_PID="$(main_pid)" || RESTART_PID=""

write_status restarting "Verifying the restarted service" "$OLD_SHA" "$NEW_SHA"
if ! verify_service "$NEW_BIN_SHA" "$INSTALL_DIR/static/v2/index.html" "$RESTART_PID"; then
    fail_install "the restarted service failed verification: $VERIFY_REASON"
fi
# The new release is verified and serving. Failures past this point leave it in
# place (rolling a verified release back would be the wrong repair) and keep
# the pending record, so they need --retry.
INSTALL_PHASE=verified

if ! refresh_installed_updater; then
    write_status failed "Aurora passed verification, but installing the updated updater script failed. See update.log; correct permissions/storage and run 'sudo aurora-update --retry'." "$OLD_SHA" "$NEW_SHA"
    log "updater refresh failed after verified application restart"
    exit 1
fi
DEPLOYED_FINGERPRINT="$(deployment_fingerprint)"
write_deploy_state "$DEPLOYED_FILE" "$NEW_SHA $DEPLOYED_FINGERPRINT"
if ! retire_rollback_snapshots; then
    write_status failed "Aurora passed verification, but rollback snapshot cleanup failed. Pending state is retained; correct storage/permissions and run 'sudo aurora-update --retry'." "$OLD_SHA" "$NEW_SHA"
    log "rollback snapshot retirement failed after verified deployment"
    exit 1
fi
rm -rf -- "$INSTALL_DIR/static.old"
rm -f -- "$PENDING_FILE"
COMMIT_SUBJECT="$(git log -1 --format=%s "$NEW_SHA" 2>/dev/null || echo "$NEW_SHA")"
write_status success "Updated to $NEW_SHA ($COMMIT_SUBJECT)" "$OLD_SHA" "$NEW_SHA"
log "SUCCESS: now running $NEW_SHA"
exit 0
