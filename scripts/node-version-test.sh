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

# ── The fatal path must be fatal, and only there ──────────────────
# The verdict is only useful if the call sites act on it. Assert each script
# still routes verdict 1 to a hard stop, since a refactor that drops the
# `case` is exactly the regression this whole file exists to prevent.
if grep -q 'write_status misconfigured "Node.js' "$REPO_ROOT/scripts/aurora-update.sh"; then
    ok "aurora-update.sh reports verdict 1 as misconfigured"
else
    bad "aurora-update.sh no longer reports verdict 1 as misconfigured"
fi
for s in install.sh redeploy.sh; do
    if grep -q '1) error "Node.js\|error "Node.js' "$REPO_ROOT/scripts/$s"; then
        ok "scripts/$s exits on verdict 1"
    else
        bad "scripts/$s no longer exits on verdict 1"
    fi
done

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
