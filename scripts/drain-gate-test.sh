#!/usr/bin/env bash
# Aurora — viewer-drain self-test.
#
# Three deploy scripts restart aurora.service: aurora-update.sh, install.sh (on
# a re-run) and redeploy.sh. Each must first wait for anyone watching, and each
# carries its own copy of the drain predicate (the AURORA-DRAIN block), for the
# reason node_vite_verdict is duplicated (see node-version-test.sh). This
# asserts the three copies are identical, that the predicate behaves (including
# against the hostile files the aurora user could leave in its own directory),
# that it reads the file the server writes, and that each script waits before
# it changes anything live.
#
# Why it exists: install.sh and redeploy.sh never waited at all, and the
# snapshot the updater waited on was written where the server cannot create
# files, so on a standard install every restart path ignored paused viewers.
#
# No network, no systemd, no root.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS=(aurora-update.sh install.sh redeploy.sh)

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

block_of() {  # $1 = script; the block, markers included
    awk '/^# AURORA-DRAIN-BEGIN/ {grab=1} grab {print} /^# AURORA-DRAIN-END/ {exit}' "$1"
}
line_of() {  # $1 = script, $2 = ERE; first matching line number
    grep -nE "$2" "$1" | head -1 | cut -d: -f1
}

# ── The copies ────────────────────────────────────────────────────
echo "drain block: copies"
# CI checks only the updater's syntax elsewhere; everything below reads these.
for s in "${SCRIPTS[@]}"; do
    if bash -n "$REPO_ROOT/scripts/$s" 2>"$WORK/syntax"; then
        ok "scripts/$s parses"
    else
        bad "scripts/$s does not parse: $(cat "$WORK/syntax")"
    fi
done
for s in "${SCRIPTS[@]}"; do
    f="$REPO_ROOT/scripts/$s"
    n="$(grep -c '^# AURORA-DRAIN-BEGIN' "$f")"
    [ "$n" = 1 ] && ok "scripts/$s has one drain block" || bad "scripts/$s has $n drain blocks"
    block_of "$f" > "$WORK/$s.block"
    if [ -s "$WORK/$s.block" ] && tail -1 "$WORK/$s.block" | grep -q '^# AURORA-DRAIN-END'; then
        ok "scripts/$s's drain block extracts"
    else
        bad "scripts/$s's drain block did not extract (missing END marker?)"
    fi
done
for s in install.sh redeploy.sh; do
    if cmp -s "$WORK/aurora-update.sh.block" "$WORK/$s.block"; then
        ok "scripts/$s's drain block is identical to aurora-update.sh's"
    else
        bad "scripts/$s's drain block differs from aurora-update.sh's:"
        diff "$WORK/aurora-update.sh.block" "$WORK/$s.block" | head -20
    fi
done

# The block reads where the server writes.
go_path="$(sed -n 's/^const DefaultStreamStateFile = "\(.*\)"$/\1/p' "$REPO_ROOT/internal/streaming/drainstate.go")"
sh_path="$(sed -n 's/^STREAM_STATE_FILE=//p' "$WORK/aurora-update.sh.block")"
if [ -n "$go_path" ] && [ "$go_path" = "$sh_path" ]; then
    ok "the drain block reads $sh_path, where the server writes it"
else
    bad "the drain block reads '$sh_path' but the server writes '$go_path'"
fi
case "$sh_path" in
    /var/lib/aurora/*) bad "the snapshot is under /var/lib/aurora, which the server (the aurora user) cannot write" ;;
esac

# ── How the predicate behaves ─────────────────────────────────────
#
# Each case runs the real block, with the snapshot path pointed into $WORK and
# a stub pgrep, under set -euo pipefail with an ERR trap like the real scripts.
# timeout catches a predicate that blocks (a FIFO opened without O_NONBLOCK).
echo
echo "drain block: behaviour"
mkdir -p "$WORK/bin"
cat > "$WORK/bin/pgrep" <<'STUB'
#!/bin/sh
[ -f "$PGREP_FINDS" ]
STUB
chmod +x "$WORK/bin/pgrep"
STATE="$WORK/stream-state.json"
sed "s|^STREAM_STATE_FILE=.*|STREAM_STATE_FILE='$STATE'|" "$WORK/aurora-update.sh.block" > "$WORK/block.sh"

busy() {  # $1 = expected busy|idle, $2 = description; uses $STATE / $WORK/ffmpeg as set up
    local got
    got="$(PATH="$WORK/bin:$PATH" PGREP_FINDS="$WORK/ffmpeg" timeout 10 bash -c "
        set -euo pipefail
        trap 'echo TRAPPED' ERR
        . '$WORK/block.sh'
        if streams_busy; then echo busy; else echo idle; fi
    " 2>&1)" || got="exit $? ($got)"
    [ "$got" = "$1" ] && ok "$2 → $1" || bad "$2 → want $1, got: $got"
}
reset() { rm -rf "$STATE" "$WORK/ffmpeg" "$WORK/elsewhere.json"; }
now="$(date +%s)"
snapshot() { printf '{"unix_time":%s,"sessions":%s,"held_by_viewer":%s}\n' "$1" "$2" "$2"; }

reset;                                             busy idle "no snapshot, no ffmpeg"
reset; touch "$WORK/ffmpeg";                       busy busy "no snapshot, ffmpeg running"
reset; snapshot "$now" 2 > "$STATE";               busy busy "fresh snapshot holding 2 (a paused viewer has no ffmpeg)"
reset; snapshot "$now" 0 > "$STATE";               busy idle "fresh snapshot holding 0"
reset; snapshot "$now" 0 > "$STATE"; touch "$WORK/ffmpeg"
                                                   busy busy "fresh snapshot holding 0, but a stream started since"
reset; snapshot $((now - 600)) 2 > "$STATE";       busy idle "stale snapshot is unknown, not a count"
reset; echo '{"unix_time":' > "$STATE";            busy idle "half-written snapshot is unknown"
reset; mkfifo "$STATE";                            busy idle "a FIFO neither hangs nor counts"
reset; snapshot "$now" 2 > "$WORK/elsewhere.json"; ln -s "$WORK/elsewhere.json" "$STATE"
                                                   busy idle "a symlink is not followed"
reset; { snapshot "$now" 2; head -c 70000 /dev/zero | tr '\0' ' '; } > "$STATE"
                                                   busy idle "an oversized file is not read"
reset; snapshot "0$now" 2 > "$STATE";              busy busy "a leading zero is decimal, not invalid octal"
reset; snapshot 99999999999999999999 2 > "$STATE"; busy idle "an absurd timestamp is unknown"
reset; printf '{"unix_time":%s,"held_by_viewer":99999999999999999999}\n' "$now" > "$STATE"
                                                   busy idle "an absurd count is unknown"

# The updater calls viewers_held at top level, under set -e: an arithmetic
# error there (a number bash cannot read) aborted every update.
for ts in "0793$now" 99999999999999999999 08; do
    printf '{"unix_time":%s,"held_by_viewer":1}\n' "$ts" > "$STATE"
    got="$(timeout 10 bash -c "
        set -euo pipefail
        trap 'echo TRAPPED' ERR
        . '$WORK/block.sh'
        held=\$(viewers_held)
        echo \"held=\$held\"
    " 2>&1)"
    case "$got" in
        held=*) ok "viewers_held survives unix_time=$ts at top level under set -e ($got)" ;;
        *) bad "viewers_held aborts a set -e caller on unix_time=$ts: $got" ;;
    esac
done

# drain_wait: waits while busy, gives up at its limit, and says how long.
dw() {  # $1 = expected exit, $2 = expected DRAIN_WAITED, $3 = busy rounds, $4 = max, $5 = description
    local got
    got="$(timeout 10 bash -c "
        set -euo pipefail
        . '$WORK/block.sh'
        left=$3
        streams_busy() { [ \"\$left\" -gt 0 ] && left=\$((left - 1)); }
        sleep() { :; }
        rc=0; drain_wait $4 || rc=\$?
        echo \"\$rc \$DRAIN_WAITED\"
    " 2>&1)"
    [ "$got" = "$1 $2" ] && ok "drain_wait: $5" || bad "drain_wait: $5 → want '$1 $2', got '$got'"
}
dw 0 0  0 300 "nothing to wait for returns at once"
dw 0 30 3 300 "waits until the streams finish"
dw 1 300 99 300 "gives up at its limit"

# ── Each script waits before it changes anything live ─────────────
#
# Waiting just before the restart is not enough: until then the old backend
# would serve the new frontend, which is what the updater used to do.
echo
echo "drain block: call sites"
check_before() {  # $1 = script, $2 = first (ERE), $3 = second (ERE), $4 = what second is, [$5 = what first is]
    local f="$REPO_ROOT/scripts/$1" w c first="${5:-waits for viewers}"
    w="$(line_of "$f" "$2")"; c="$(line_of "$f" "$3")"
    if [ -z "$w" ] || [ -z "$c" ]; then
        bad "scripts/$1: could not find where it $first ($w) or $4 ($c); this check is inert"
    elif [ "$w" -lt "$c" ]; then
        ok "scripts/$1 $first (line $w) before $4 (line $c)"
    else
        bad "scripts/$1 reaches $4 (line $c) BEFORE it $first (line $w)"
    fi
}
check_before aurora-update.sh '^if streams_busy; then'          '^INSTALL_PHASE=files'                 'the first live file'
# install.sh does its live changes in one function, called right after the
# wait and right before the restart: everything between used to take minutes
# (a prompt, an Ollama pull) with the new frontend live and nobody checking.
check_before install.sh       '^take_deploy_lock$'              '^drain_viewers_before_install$'       'the drain' 'takes the deploy lock'
check_before install.sh       '^drain_viewers_before_install$'  '^install_release_files$'              'the release files'
check_before install.sh       '^    systemctl restart aurora$'  '^release_deploy_lock$'                'releasing the deploy lock' 'restarts'
check_before install.sh       '^install_release_files$'         '^# Restart \(handles re-runs'          'the restart'
f="$REPO_ROOT/scripts/install.sh"
release="$(awk '/^install_release_files\(\) \{$/ {grab=1} grab {print} grab && /^\}$/ {exit}' "$f")"
# Staging too: the updater stages into the same static.new, so it happens under
# the lock, and an updater tick can no longer fall between staging and the swap.
for change in 'stage_static_bundle "$FRONTEND_TMP/v2"' 'install -m 755 aurora "$INSTALL_BIN.new"' 'mv "$INSTALL_DIR/static.new" "$INSTALL_DIR/static"' 'cp -f "$PROJECT_DIR"/migrations/*.sql'; do
    case "$release" in
        *"$change"*) ok "scripts/install.sh changes '$change' inside install_release_files" ;;
        *) bad "scripts/install.sh's install_release_files no longer does '$change'" ;;
    esac
    if grep -nF "$change" "$f" | grep -vq '^[0-9]*:    '; then
        bad "scripts/install.sh does '$change' outside install_release_files"
    fi
done
w="$(line_of "$f" '^drain_viewers_before_install$')"; r="$(line_of "$f" '^install_release_files$')"
# Between the wait and the install: comments, and the signal guard, only.
between="$(sed -n "$((w + 1)),$((r - 1))p" "$f" | grep -vE '^[[:space:]]*(#|$)' | grep -vxF "trap '' INT TERM HUP PIPE")"
if [ -n "$w" ] && [ -n "$r" ] && [ "$w" -lt "$r" ] && [ -z "$between" ]; then
    ok "scripts/install.sh installs the release straight after the wait"
else
    bad "scripts/install.sh runs something between the wait (line $w) and the install (line $r): $between"
fi
# The swap and the restart run with interrupts ignored, and the handler is put
# back after the restart: an interrupt mid-swap would leave no static/.
g="$(line_of "$f" "^trap '' INT TERM HUP PIPE$")"; s="$(line_of "$f" '^    systemctl restart aurora$')"
# The last such trap: the one after the restart.
back="$(grep -nE "^trap 'cleanup_on_interrupt; exit 130' INT$" "$f" | tail -1 | cut -d: -f1)"
# ... and only then: guarding the drain too would make a five-minute wait that
# Ctrl-C could not end, which the exiting handler is there to allow.
if [ -n "$g" ] && [ -n "$s" ] && [ -n "$back" ] && [ "$w" -lt "$g" ] && [ "$g" -lt "$r" ] && [ "$s" -lt "$back" ]; then
    ok "scripts/install.sh ignores interrupts from the swap (line $g) to the restart, then restores them (line $back)"
else
    bad "scripts/install.sh does not guard the swap and restart against interrupts (guard $g, install $r, restart $s, restore $back)"
fi
check_before install.sh       '^take_deploy_lock$'              '^chown -R "\$AURORA_USER'             'the final chown' 'takes the deploy lock'
check_before install.sh       '^take_deploy_lock$'              'systemctl start aurora-update.timer'  'starting the update timer' 'takes the deploy lock'

# take_deploy_lock really locks: it takes a free lock, waits for a held one,
# and gives up on one held past its limit. Only its position was checked.
lockfn="$(awk '/^take_deploy_lock\(\) \{$/ {grab=1} grab {print} grab && /^\}$/ {exit}' "$f")"
take_lock() {  # $1 = how long another process holds the lock (0 = free); prints the outcome
    local lock="$WORK/deploy.lock" holder=""
    rm -f "$lock"
    if [ "$1" != 0 ]; then
        flock "$lock" sleep "$1" & holder=$!
        sleep 0.3
    fi
    timeout 20 bash -c "
        set -euo pipefail
        info() { :; }; warn() { echo \"WARN \$1\"; }; error() { echo FAILED; exit 1; }
        DEPLOY_LOCK='$lock'; DEPLOY_LOCK_WAIT=2
        $lockfn
        take_deploy_lock
        if flock -n '$lock' true; then echo free; else echo held; fi
    " 2>&1
    [ -z "$holder" ] || wait "$holder" 2>/dev/null
}
for case in "0 held a free lock is taken" "1 held a lock held for 1 s is waited for, then taken" "6 FAILED a lock held past the limit gives up"; do
    set -- $case; hold="$1"; want="$2"; shift 2
    got="$(take_lock "$hold")"
    [ "$got" = "$want" ] && ok "take_deploy_lock: $*" || bad "take_deploy_lock: $* → want '$want', got '$got'"
done
check_before redeploy.sh      '^drain_viewers_before_install$'  'sudo cp -f "\$\{SQL_FILES\[@\]\}"'    'the migrations'
check_before redeploy.sh      '^drain_viewers_before_install$'  '^if ! sudo systemctl restart aurora'  'the restart'
for s in "${SCRIPTS[@]}"; do
    f="$REPO_ROOT/scripts/$s"
    b="$(line_of "$f" '^# AURORA-DRAIN-BEGIN')"
    # The first call outside the block and outside comments.
    u="$(awk '/^# AURORA-DRAIN-BEGIN/ {inb=1} /^# AURORA-DRAIN-END/ {inb=0; next}
              !inb && !/^[[:space:]]*#/ && /(^|[^_a-z])(streams_busy|drain_wait)( |;|$)/ {print NR; exit}' "$f")"
    if [ -n "$b" ] && [ -n "$u" ] && [ "$b" -lt "$u" ]; then
        ok "scripts/$s defines the drain block (line $b) before using it (line $u)"
    else
        bad "scripts/$s uses streams_busy (line $u) before the drain block (line $b)"
    fi
    if awk -v n="$b" 'NR==n {exit} /^[a-z_]+\(\) \{$/ {f=1} /^\}$/ {f=0} END {exit !f}' "$f"; then
        bad "scripts/$s's drain block sits inside a function"
    else
        ok "scripts/$s's drain block is at top level"
    fi
done

# Ctrl-C during the drain must stop install.sh. Its handler used to return,
# and the script went on to install and restart under the viewers it was
# interrupted for.
if grep -nE "^trap .*cleanup_on_interrupt" "$REPO_ROOT/scripts/install.sh" | grep -vqE 'exit [0-9]+'; then
    bad "scripts/install.sh traps an interrupt without exiting"
else
    ok "scripts/install.sh exits when interrupted"
fi

# The skips: each script's own way out, and nothing else, turns the wait off.
echo
echo "drain block: skip conditions"
skip_case() {  # $1 = script, $2 = env/setup, $3 = expected (waited|skipped), $4 = description
    local f="$REPO_ROOT/scripts/$1" fn got
    fn="$(awk '/^drain_viewers_before_install\(\) \{$/ {grab=1} grab {print} grab && /^\}$/ {exit}' "$f")"
    got="$(PATH="$WORK/bin:$PATH" timeout 10 bash -c "
        set -euo pipefail
        info() { :; }; ok() { :; }; warn() { :; }
        systemctl() { [ \"\${ACTIVE:-1}\" = 1 ]; }
        streams_busy() { true; }
        drain_wait() { echo waited; DRAIN_WAITED=0; }
        RESTART=true; DRAIN=true
        $2
        $fn
        drain_viewers_before_install
    " 2>&1)"
    [ "${got:-skipped}" = "$3" ] && ok "scripts/$1: $4 → $3" || bad "scripts/$1: $4 → want $3, got '${got}'"
}
skip_case install.sh  ''                        waited  "a re-run with viewers waits"
skip_case install.sh  'export AURORA_SKIP_DRAIN=1' skipped "AURORA_SKIP_DRAIN=1"
skip_case install.sh  'ACTIVE=0'                skipped "a fresh install (service not running)"
skip_case redeploy.sh ''                        waited  "a deploy with viewers waits"
skip_case redeploy.sh 'DRAIN=false'             skipped "--no-drain"
skip_case redeploy.sh 'RESTART=false'           skipped "--no-restart (nothing to interrupt)"
skip_case redeploy.sh 'ACTIVE=0'                skipped "service not running"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
