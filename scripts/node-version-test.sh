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
    ""                 # sentinel: "no node on PATH", driven separately below
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
# Extraction is by marker comment rather than by guessing line ranges. Note
# what that does and does NOT pin: it pins the block's BEHAVIOUR in isolation,
# not where the block sits. Position is checked separately below, because
# "before the fetch" is the whole point of the updater's gate and moving the
# block past it would otherwise pass every behavioural assertion.
extract_callsite() {  # $1 = script, prints the guarded block
    awk '/# AURORA-NODE-GATE-BEGIN/ {grab=1; next} /# AURORA-NODE-GATE-END/ {exit} grab {print}' "$1"
}

# verdict_action: run one script's call site with node_vite_verdict stubbed to
# return $2, and report what happened as "<exit code>|<output>".
#
# $3 selects the environment: "src" (the normal case), "nodir" (no SPA source
# tree — install.sh falls back to a prebuilt static/v2; aurora-update.sh has no
# fallback, and its build of the target then refuses, so its gate has nothing
# to protect), or "skipfe" (--skip-npm, redeploy.sh's equivalent).
#
# nodir and skipfe are kept SEPARATE, and each sets only its own variable. An
# earlier version set both at once, which made the two conditions
# indistinguishable: swapping redeploy.sh's `! $SKIP_FRONTEND` guard for
# `[ -d "$SPA_SRC_DIR" ]` passed the whole suite, while in reality it would
# abort `redeploy.sh --skip-npm` on any box that still had the source tree and
# an old Node — the exact case the guard exists for.
#
# The subshell runs under `set -e` WITH an ERR trap, matching the real scripts.
# Without them the suite could not see its most important regression: a call
# site refactored from `node_vite_verdict || NODE_VERDICT=$?` to a bare call
# plus `$?` aborts the updater into its generic "Update script aborted at line
# N" — the anonymous message this whole gate exists to replace — while every
# assertion below still passed.
verdict_action() {  # $1 = call-site file, $2 = stubbed verdict, $3 = src|nosrc
    local block="$1" verdict="$2" mode="${3:-src}" out rc=0
    local spa_src=. skip_frontend=false
    case "$mode" in
        nodir)  spa_src="definitely/not/here" ;;
        skipfe) skip_frontend=true ;;
    esac
    out="$(PATH="$WORK/bin:/usr/bin:/bin" "${BASH:-/bin/bash}" -c "
        set -euo pipefail
        trap 'echo TRAPPED-BY-ERR' ERR
        SPA_SRC_DIR='$spa_src' ; PROJECT_DIR=. ; SKIP_FRONTEND=$skip_frontend ; SPA_OUTPUT_DIR=static/v2
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
    case "$out" in
        *TRAPPED-BY-ERR*)
            bad "scripts/$s's call site trips the ERR trap — under the real set -e this aborts with a generic message instead of the Node one: $out" ;;
    esac
    # The updater must report this as `misconfigured`, not `failed`. "Failed"
    # means an update was attempted and broke, and sends the operator looking
    # for a revert; this is a configuration problem with its own remedy.
    if [ "$s" = "aurora-update.sh" ]; then
        case "$out" in
            *"STATUS: misconfigured"*) ok "aurora-update.sh reports verdict 1 as misconfigured" ;;
            *) bad "aurora-update.sh must report verdict 1 as misconfigured, got: $out" ;;
        esac
    fi

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

    # An UNKNOWN verdict. node_vite_verdict only ever returns 0-3, so this is
    # unreachable from it — and that is the point: 127 is what the shell
    # returns when the function is renamed, deleted, or moved BELOW the call
    # site. With no default arm the `case` matches nothing, the gate does
    # nothing, says nothing, and the box is back to failing every update on an
    # anonymous npm error with the check still visibly present in the file.
    # Must warn and continue — failing closed here would block a box whose
    # build is fine over a bug in this script.
    res="$(verdict_action "$WORK/$s.site" 127)"
    rc="${res%%|*}"; out="${res#*|}"
    if [ "$rc" != "0" ]; then
        bad "scripts/$s stops on an unrecognised verdict — a bug in the gate must not block a working build: $out"
    elif [ -z "$out" ]; then
        bad "scripts/$s is SILENT on an unrecognised verdict — if node_vite_verdict is renamed or moved below its call site, the gate vanishes without a word"
    else
        ok "scripts/$s warns and continues on an unrecognised verdict"
    fi

    # A box that will not build the SPA needs no Node at all, and even the
    # fatal verdict must not stop it. Each script has its own way of not
    # building, and must respond to THAT one and not the other — checking both
    # at once cannot tell a correct guard from one reading the wrong variable.
    case "$s" in
        redeploy.sh) skip_mode=skipfe; other_mode=nodir;  why="--skip-npm" ;;
        *)           skip_mode=nodir;  other_mode=skipfe; why="no SPA source tree" ;;
    esac

    res="$(verdict_action "$WORK/$s.site" 1 "$skip_mode")"
    rc="${res%%|*}"; out="${res#*|}"
    if [ "$rc" != "0" ]; then
        bad "scripts/$s stops on verdict 1 with $why — that box never invokes node: $out"
    elif [ -n "$out" ]; then
        bad "scripts/$s complains about Node with $why: $out"
    else
        ok "scripts/$s ignores the Node verdict with $why"
    fi

    # ...and must NOT be quieted by the other script's condition, which it does
    # not read. This is what catches a guard wired to the wrong variable.
    res="$(verdict_action "$WORK/$s.site" 1 "$other_mode")"
    rc="${res%%|*}"; out="${res#*|}"
    if [ "$rc" = "0" ] && [ -z "$out" ]; then
        bad "scripts/$s skipped the Node gate under the OTHER script's skip condition ($other_mode) — its guard reads a variable it should not"
    else
        ok "scripts/$s still gates on verdict 1 under $other_mode (not its own condition)"
    fi
done

# ── Reachability: the gate must actually run ──────────────────────
#
# Behaviour in isolation is not enough. A gate that never executes passes every
# assertion above while restoring exactly the anonymous npm failure it was
# written to remove. Two shapes do that — moving the marked block past the
# thing it must precede, and wrapping it in a function nobody calls — and both
# are checked for ALL THREE scripts. Checking only the updater left the
# first-run path (install.sh) and the manual deploy path (redeploy.sh) able to
# lose their gate silently.
echo
echo "node gate: reachability"

gate_line_of() { grep -n '# AURORA-NODE-GATE-BEGIN' "$1" | head -1 | cut -d: -f1; }
def_line_of()  { grep -n '^node_vite_verdict() {' "$1" | head -1 | cut -d: -f1; }

# Exactly one gate block per script. `head -1` above would silently check the
# first of several and leave the rest unexamined, and extract_callsite's awk
# range would splice them together.
for s in "${SCRIPTS[@]}"; do
    n="$(grep -c '# AURORA-NODE-GATE-BEGIN' "$REPO_ROOT/scripts/$s")"
    if [ "$n" = "1" ]; then
        ok "scripts/$s has exactly one gate block"
    else
        bad "scripts/$s has $n gate blocks — every check here inspects only the first"
    fi
done

# The DEFINITION must precede the CALL. Bash resolves a function name at call
# time, so a definition below its call site is not a syntax error: the shell
# reports "command not found", returns 127, and the `case` falls through. The
# call-site tests stub node_vite_verdict, so they cannot see this — the stub is
# always defined first. Ordering is fine today; nothing pinned it.
for s in "${SCRIPTS[@]}"; do
    d="$(def_line_of "$REPO_ROOT/scripts/$s")"
    g="$(gate_line_of "$REPO_ROOT/scripts/$s")"
    if [ -z "$d" ] || [ -z "$g" ]; then
        bad "scripts/$s: could not locate the definition ($d) or the gate ($g) — this check is inert"
    elif [ "$d" -lt "$g" ]; then
        ok "scripts/$s defines node_vite_verdict (line $d) before calling it (line $g)"
    else
        bad "scripts/$s calls node_vite_verdict at line $g but defines it at line $d — the call returns 127 and the gate does nothing"
    fi
done

# ...and so must every VARIABLE the gate interpolates. verdict_action supplies
# these itself, so the behavioural assertions above cannot see their ordering
# at all. All three scripts run under `set -u`, so a message built from one
# that is not yet assigned aborts the script with "unbound variable" — a
# generic failure in place of the Node-specific one this gate exists to
# produce, and in aurora-update.sh that means no write_status at all.
gate_vars() {  # $1 = script; the variables its gate block interpolates
    awk '/# AURORA-NODE-GATE-BEGIN/,/# AURORA-NODE-GATE-END/' "$1" \
    | grep -oE '\$\{?[A-Z][A-Z0-9_]+\}?' | tr -d '${}' | sort -u
}
gate_assigns() {  # $1 = script; variables the gate block assigns for itself
    awk '/# AURORA-NODE-GATE-BEGIN/,/# AURORA-NODE-GATE-END/' "$1" \
    | grep -oE '^[[:space:]]*[A-Z][A-Z0-9_]+=' | tr -d ' =' | sort -u
}
for s in "${SCRIPTS[@]}"; do
    f="$REPO_ROOT/scripts/$s"
    g="$(gate_line_of "$f")"
    own="$(gate_assigns "$f")"
    late=""
    while IFS= read -r v; do
        [ -n "$v" ] || continue
        # A variable the block sets for itself (NODE_VERDICT and friends) is
        # assigned at the top of the block and used below — not a prerequisite.
        printf '%s\n' "$own" | grep -qx "$v" && continue
        # Only variables this script assigns itself; the rest come from the
        # environment or from arguments and have no line number to compare.
        a="$(grep -nE "^[[:space:]]*(readonly[[:space:]]+|declare[[:space:]]+-[a-zA-Z]+[[:space:]]+)?$v=" "$f" | head -1 | cut -d: -f1)"
        [ -n "$a" ] || continue
        [ "$a" -lt "$g" ] || late="$late $v(line $a)"
    done <<< "$(gate_vars "$f")"
    if [ -z "$late" ]; then
        ok "scripts/$s assigns every variable its gate uses before the gate"
    else
        bad "scripts/$s's gate (line $g) interpolates variables assigned later —$late. Under set -u this aborts with 'unbound variable' instead of the Node message"
    fi
done

# Each script's gate must come before the thing it exists to pre-empt.
check_before() {  # $1 = script, $2 = anchor regex, $3 = what the anchor is
    local f="$REPO_ROOT/scripts/$1" g a
    g="$(gate_line_of "$f")"
    a="$(grep -nE "$2" "$f" | head -1 | cut -d: -f1)"
    if [ -z "$g" ] || [ -z "$a" ]; then
        bad "scripts/$1: could not locate the gate ($g) or $3 ($a) — this check is inert"
        return
    fi
    if [ "$g" -lt "$a" ]; then
        ok "scripts/$1 gates on Node (line $g) before $3 (line $a)"
    else
        bad "scripts/$1 reaches $3 (line $a) BEFORE its Node gate (line $g) — the operator would learn about Node only after the build had already failed"
    fi
}

check_before aurora-update.sh '^if ! git fetch'                'the fetch'
check_before aurora-update.sh 'write_status checking'          'the "checking" status'
check_before install.sh       'build_frontend_bundle '         'the frontend build'
check_before redeploy.sh      'npm ci --no-audit'              'npm ci'

# ...and must be at top level, not inside a function nobody calls.
for s in "${SCRIPTS[@]}"; do
    g="$(gate_line_of "$REPO_ROOT/scripts/$s")"
    if [ -z "$g" ]; then
        bad "scripts/$s has no gate marker"
    elif awk -v n="$g" 'NR==n {exit} /^[a-z_]+\(\) \{$/ {f=1} /^\}$/ {f=0} END {exit !f}' "$REPO_ROOT/scripts/$s"; then
        bad "scripts/$s's Node gate sits inside a function — it may never run"
    else
        ok "scripts/$s's Node gate is at top level"
    fi
done

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
