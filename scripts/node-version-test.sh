#!/usr/bin/env bash
# Aurora — node_vite_verdict() self-test.
#
# Three deploy scripts each carry their own copy of node_vite_verdict():
# install.sh, redeploy.sh and aurora-update.sh. They are duplicated rather
# than sourced from a shared file on purpose — aurora-update.sh runs as root
# out of a source mirror that may be mid-checkout, and install.sh runs before
# the repo layout is guaranteed, so a `source` of a fourth file is a new
# failure mode in exactly the paths that must not acquire one. This script is
# the price of that duplication: it asserts the three copies are identical
# and that all three agree on a table of real Node version strings.
#
# Why the function exists at all: a production box ran Node 18.19.1 (Ubuntu
# 24.04's distro package) for two weeks. Vite 7 calls crypto.hash(), added in
# Node 20.12, so every one of eight consecutive updates died with
# "crypto.hash is not a function" several hundred lines into npm's output,
# and the operator saw only "frontend build failed". The gate turns that into
# a named version and a remedy, before the update is attempted.
#
# No network, no npm, no dependence on the checkout's own Node.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS=(install.sh redeploy.sh aurora-update.sh)

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── Extract each copy ─────────────────────────────────────────────
# From the `node_vite_verdict() {` line to the next line that is exactly `}`.
# The function has no nested closing brace at column 0, which the identity
# check below would catch anyway (a truncated body would not match its peers,
# and a body that failed to extract is empty and fails the behaviour table).
extract() {
    awk '/^node_vite_verdict\(\) \{$/ {grab=1} grab {print} grab && /^\}$/ {exit}' "$1"
}

echo "node_vite_verdict: extracting from ${#SCRIPTS[@]} scripts"
for s in "${SCRIPTS[@]}"; do
    extract "$REPO_ROOT/scripts/$s" > "$WORK/$s.fn"
    if [ ! -s "$WORK/$s.fn" ]; then
        bad "scripts/$s defines node_vite_verdict()"
        continue
    fi
    if ! grep -q '^}$' "$WORK/$s.fn"; then
        bad "scripts/$s's node_vite_verdict() body is unterminated"
        continue
    fi
    ok "scripts/$s defines node_vite_verdict()"
done
[ "$FAIL" -eq 0 ] || { echo; echo "extraction failed — cannot check behaviour"; exit 1; }

# ── The copies must not drift ─────────────────────────────────────
REFERENCE="$WORK/${SCRIPTS[0]}.fn"
for s in "${SCRIPTS[@]:1}"; do
    if diff -q "$REFERENCE" "$WORK/$s.fn" >/dev/null; then
        ok "scripts/$s's copy matches scripts/${SCRIPTS[0]}'s"
    else
        bad "scripts/$s's copy has drifted from scripts/${SCRIPTS[0]}'s"
        diff -u "$REFERENCE" "$WORK/$s.fn" | sed 's/^/      /'
    fi
done

# ── Behaviour ─────────────────────────────────────────────────────
# 0 = meets the toolchain's declared engines (^20.19 || >=22.12)
# 1 = cannot build: no crypto.hash() (added in Node 20.12 and 21.7)
# 2 = absent, or a version string we could not parse
# 3 = has crypto.hash but outside the declared engines — vite warns and builds
#
# 1 and 3 are the point of the table. Collapsing them (refusing everything
# below the declared engines) would block updates on a box whose build
# actually succeeds; keeping them apart means only the provable failure is
# fatal.
mkdir -p "$WORK/bin"
run_verdict() {  # $1 = fn file, $2 = fake `node --version` output ("" = no node)
    local fn="$1" ver="$2" rc=0
    if [ -n "$ver" ]; then
        printf '#!/bin/sh\necho %s\n' "$ver" > "$WORK/bin/node"
        chmod +x "$WORK/bin/node"
    else
        rm -f "$WORK/bin/node"
    fi
    # PATH is replaced wholesale, not prefixed: prefixing would let a real
    # `node` earlier in PATH answer for the "no node" row. That also puts the
    # shell itself out of PATH's reach, hence the absolute interpreter.
    PATH="$WORK/bin" "${BASH:-/bin/bash}" -c "set -euo pipefail; $(cat "$fn"); node_vite_verdict" || rc=$?
    printf '%s' "$rc"
}

# version                want  why
TABLE=(
    "v18.19.1            1     Ubuntu 24.04's distro node — the box that stalled"
    "v18.20.8            1     last 18.x; crypto.hash was never backported"
    "v20.11.1            1     20.x before crypto.hash landed"
    "v20.12.0            3     crypto.hash lands; below vite's declared floor"
    "v20.18.3            3     builds, unsupported"
    "v20.19.0            0     vite's ^20.19 floor, exactly"
    "v20.20.2            0     the version this box ran before the downgrade"
    "v21.6.2             1     21.x before crypto.hash landed"
    "v21.7.3             3     crypto.hash present; 21.x is outside the engines"
    "v22.11.0            3     builds, below the >=22.12 floor"
    "v22.12.0            0     the >=22.12 floor, exactly"
    "v22.22.2            0     current 22 LTS"
    "v24.10.1            0     current 24"
    "v26.0.0             0     a major we have never seen"
    "v9.11.2             1     ancient"
    "vBOGUS              2     unparseable — warn, never block"
    "v20.x               2     unparseable minor"
    ""                 # sentinel row handled below
)

echo
echo "node_vite_verdict: behaviour"
for row in "${TABLE[@]}"; do
    [ -n "$row" ] || continue
    read -r ver want why <<< "$row"
    for s in "${SCRIPTS[@]}"; do
        got="$(run_verdict "$WORK/$s.fn" "$ver")"
        if [ "$got" = "$want" ]; then
            [ "$s" = "${SCRIPTS[0]}" ] && ok "$ver -> $got ($why)"
        else
            bad "$ver in scripts/$s -> $got, want $want ($why)"
        fi
    done
done

# No node at all. Must be 2 (warn and continue), never 1: "absent" is not
# evidence the build will fail, and the scripts must not refuse an update
# over a PATH we merely could not read.
for s in "${SCRIPTS[@]}"; do
    got="$(run_verdict "$WORK/$s.fn" "")"
    if [ "$got" = "2" ]; then
        [ "$s" = "${SCRIPTS[0]}" ] && ok "no node on PATH -> 2 (warn, never block)"
    else
        bad "no node on PATH in scripts/$s -> $got, want 2"
    fi
done

# ── The call sites must ACT on the verdict ────────────────────────
#
# The function being right is worth nothing if its callers ignore it. These
# used to be greps for the error message, which pass if the `case` arms are
# swapped (old Node warns, current Node is refused), if `exit 1` is dropped,
# or if the message survives only in a comment. So instead: extract each
# script's real call site, run it against a stubbed node_vite_verdict, and
# assert what it does.
#
# Extraction is by marker comment rather than by guessing line ranges, so a
# refactor that moves the block is a failure here rather than a silent pass.
extract_callsite() {  # $1 = script, prints the guarded block
    awk '/# AURORA-NODE-GATE-BEGIN/ {grab=1; next} /# AURORA-NODE-GATE-END/ {exit} grab {print}' "$1"
}

# verdict_action: run one script's call site with node_vite_verdict stubbed to
# return $2, and report what happened as one of exit:<code> / warn / silent.
verdict_action() {  # $1 = fn file, $2 = stubbed verdict
    local block="$1" verdict="$2" out rc=0
    out="$(PATH="$WORK/bin:/usr/bin:/bin" "${BASH:-/bin/bash}" -c "
        set -uo pipefail
        SPA_SRC_DIR=. ; PROJECT_DIR=. ; SKIP_FRONTEND=false ; SPA_OUTPUT_DIR=static/v2
        NODE_BUILD_MIN_TEXT='20.19+ or 22.12+'
        NODE_ENGINES_TEXT='20.19+ or 22.12+'
        NODE_MIN=22 ; NODE_TARGET_MAJOR=22
        info() { :; }
        warn() { echo \"WARNED: \$1\"; }
        ok()   { :; }
        log()  { echo \"LOGGED: \$1\"; }
        error() { echo \"ERRORED: \$1\"; exit \"\${2:-1}\"; }
        write_status() { echo \"STATUS: \$1 \$2\"; }
        node() { echo v18.19.1; }
        node_vite_verdict() { return $verdict; }
        $(cat "$block")
    " 2>&1)" || rc=$?
    printf '%s|%s' "$rc" "$out"
}

echo
echo "node gate: call sites"
for s in "${SCRIPTS[@]}"; do
    extract_callsite "$REPO_ROOT/scripts/$s" > "$WORK/$s.site"
    if [ ! -s "$WORK/$s.site" ]; then
        bad "scripts/$s has no AURORA-NODE-GATE-BEGIN/END block"
        continue
    fi

    # Verdict 1 — cannot build — must stop the script.
    res="$(verdict_action "$WORK/$s.site" 1)"
    rc="${res%%|*}"; out="${res#*|}"
    if [ "$rc" = "0" ]; then
        bad "scripts/$s does not stop on verdict 1 (cannot build) — output: $out"
    else
        ok "scripts/$s stops on verdict 1 (exit $rc)"
    fi
    case "$out" in
        *"Node.js"*) ok "scripts/$s names Node.js in its verdict-1 message" ;;
        *)           bad "scripts/$s's verdict-1 message does not mention Node.js: $out" ;;
    esac

    # Verdict 0 — fine — must be silent and must NOT stop.
    res="$(verdict_action "$WORK/$s.site" 0)"
    rc="${res%%|*}"; out="${res#*|}"
    if [ "$rc" != "0" ]; then
        bad "scripts/$s stops on verdict 0 (a supported Node) — this would block every update: $out"
    elif [ -n "$out" ]; then
        bad "scripts/$s complains on verdict 0 (a supported Node): $out"
    else
        ok "scripts/$s is silent and continues on verdict 0"
    fi

    # Verdicts 2 and 3 — unknown, and unsupported-but-working — must warn and
    # continue. Stopping here is the regression that would strand a box whose
    # build actually succeeds.
    for v in 2 3; do
        res="$(verdict_action "$WORK/$s.site" "$v")"
        rc="${res%%|*}"; out="${res#*|}"
        if [ "$rc" != "0" ]; then
            bad "scripts/$s stops on verdict $v — it must warn and continue: $out"
        elif [ -z "$out" ]; then
            bad "scripts/$s says nothing on verdict $v — it must warn"
        else
            ok "scripts/$s warns and continues on verdict $v"
        fi
    done
done

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
