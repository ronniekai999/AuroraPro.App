#!/usr/bin/env bash
#
# check-update-signing.sh — dry-run the update signature gate.
#
# WHY THIS EXISTS
#
# aurora-update.sh can require a valid commit signature before it builds and
# installs code as root (AURORA_UPDATE_REQUIRE_SIGNED=true). That control is
# off by default, so every deploy logs:
#
#   WARN: AURORA_UPDATE_REQUIRE_SIGNED not enabled — building UNVERIFIED code
#   from origin/main (<sha>); a compromised origin or MITM could run code as
#   root.
#
# The reason it stays off is that turning it on is a one-way door taken blind:
# if verification fails, the updater exits 1 and STOPS UPDATING ENTIRELY. You
# find out via a server that has silently stopped taking deploys, and fixing it
# needs shell access to the box. Nobody flips a flag with that failure mode
# without a way to test it first.
#
# So: this script answers "would the gate pass right now?" without enforcing
# anything. Run it, read the verdict, then decide.
#
# USAGE
#   scripts/check-update-signing.sh [--source-dir DIR] [--branch NAME]
#
# Exit codes: 0 = would pass, 1 = would FAIL (do not enable), 2 = usage error.

set -euo pipefail

# Load the SAME environment the updater loads, the same way (aurora-update.sh
# does `set -a; . /etc/aurora/aurora.env; set +a` before reading any of these).
#
# Skipping this was a real defect: the gate's mode (SSH allowed-signers vs
# GPG), its branch, and its source directory all come from aurora.env, while
# this script was reading them from whatever shell the operator happened to be
# in. A signers file configured only in aurora.env made the preflight report
# FAIL for a gate that would PASS — and the reverse is worse.
if [ -f /etc/aurora/aurora.env ]; then
    set -a; . /etc/aurora/aurora.env; set +a
fi

SOURCE_DIR="${AURORA_SOURCE_DIR:-/var/lib/aurora/source}"
BRANCH="${AURORA_UPDATE_BRANCH:-main}"

# CLI flags override, so the script stays testable against arbitrary checkouts.
while [ $# -gt 0 ]; do
    case "$1" in
        --source-dir)
            [ $# -ge 2 ] || { echo "ERROR: --source-dir needs a value" >&2; exit 2; }
            SOURCE_DIR="$2"; shift 2 ;;
        --branch)
            [ $# -ge 2 ] || { echo "ERROR: --branch needs a value" >&2; exit 2; }
            BRANCH="$2"; shift 2 ;;
        # Print the header block by content, not a hardcoded line range —
        # a fixed range silently truncates the help the moment the comment
        # above grows a line.
        -h|--help)    awk 'NR>1 && /^#/ {print} NR>1 && !/^#/ {exit}' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

# The gate runs as root with HOME=/root (aurora-update.service), and GPG picks
# its keyring from HOME. Run as anyone else and this script consults a
# DIFFERENT keyring than the updater will — which can produce a PASS for a gate
# that would fail, silently stopping deploys. That is this script's one job to
# prevent, so say so loudly rather than quietly reporting a verdict that does
# not apply.
RUNNING_AS_ROOT=true
if [ "$(id -u)" -ne 0 ]; then
    RUNNING_AS_ROOT=false
    echo "WARNING: not running as root."
    echo "  The updater runs as root with HOME=/root and reads root's GPG keyring."
    echo "  This run consults ${HOME:-?} instead, so the verdict below may not match"
    echo "  what the updater will do. Re-run with sudo for an authoritative answer."
    echo
fi

if [ ! -d "$SOURCE_DIR/.git" ]; then
    echo "ERROR: $SOURCE_DIR is not a git checkout (pass --source-dir)" >&2
    exit 2
fi

cd "$SOURCE_DIR"

# --verify --quiet, not a bare rev-parse: `git rev-parse origin/main` ECHOES
# the literal string "origin/main" on stdout when the ref doesn't exist, so the
# old emptiness check never fired and a missing ref fell through to be reported
# as a failing gate (exit 1) instead of a usage error (exit 2).
TIP="$(git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH^{commit}" 2>/dev/null || true)"
if [ -z "$TIP" ]; then
    echo "ERROR: origin/$BRANCH not found in $SOURCE_DIR — run a git fetch first" >&2
    exit 2
fi

echo "Repository : $SOURCE_DIR"
echo "Branch     : origin/$BRANCH"
echo "Tip        : $TIP"
echo "Committer  : $(git log -1 --format='%cn <%ce>' "$TIP")"
echo

# Which mode will the gate use? aurora-update.sh branches on this, so the
# preflight must too — and the %G? codes below are GPG-only.
SSH_MODE=false
[ -n "${AURORA_UPDATE_ALLOWED_SIGNERS:-}" ] && SSH_MODE=true

SIG_STATUS=""
SIGNER=""
KEY=""
if $SSH_MODE; then
    # %G? is deliberately NOT consulted in SSH mode. Without the ssh config it
    # reports 'N' (no signature) for a perfectly good SSH-signed commit, and
    # WITH the ssh -c flags it reports 'B' (bad) even for a valid allowed
    # signature. Either way it would print a header contradicting the verdict,
    # so the gate's own output below is the only thing worth showing.
    echo "Signature  : SSH-signed (details in the gate output below)"
else
    # GPG mode. Informational only — the verdict comes from the gate.
    #   G = good and trusted, U = good but key not trusted, X/Y/R = expired/revoked,
    #   E = cannot check (key absent), N = no signature at all
    SIG_STATUS="$(git log -1 --format='%G?' "$TIP" 2>/dev/null || echo '?')"
    SIGNER="$(git log -1 --format='%GS' "$TIP" 2>/dev/null || true)"
    KEY="$(git log -1 --format='%GK' "$TIP" 2>/dev/null || true)"

    case "$SIG_STATUS" in
        N) echo "Signature  : NONE" ;;
        G) echo "Signature  : good, and the key is trusted by this machine" ;;
        U) echo "Signature  : good, but the key is not marked trusted" ;;
        X) echo "Signature  : good, but EXPIRED" ;;
        Y|R) echo "Signature  : present, key expired or revoked ('$SIG_STATUS')" ;;
        E) echo "Signature  : present, but this machine cannot check it (key not imported)" ;;
        *) echo "Signature  : unknown status '$SIG_STATUS'" ;;
    esac
    [ -n "$SIGNER" ] && echo "Signer     : $SIGNER"
    [ -n "$KEY" ] && echo "Key        : $KEY"
fi
echo

# THE VERDICT COMES FROM THE REAL GATE, NOT FROM READING %G?.
#
# An earlier version of this script inferred the answer from %G? and got it
# wrong: it declared status 'U' (good signature, untrusted key) a failure,
# when `git verify-commit` actually EXITS 0 on 'U' and the update would have
# proceeded fine. Guessing at another program's accept/reject policy is how
# you produce a preflight that is confidently incorrect — so run the exact
# command aurora-update.sh runs and report what it actually does.
VERIFY_OUT=""
VERIFY_RC=0
GATE_DESC="git verify-commit $TIP"
if $SSH_MODE; then
    echo "Mode       : SSH allowed-signers ($AURORA_UPDATE_ALLOWED_SIGNERS)"
    GATE_DESC="git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=$AURORA_UPDATE_ALLOWED_SIGNERS verify-commit $TIP"
    if [ ! -r "$AURORA_UPDATE_ALLOWED_SIGNERS" ]; then
        echo
        echo "VERDICT: DO NOT enable — AURORA_UPDATE_ALLOWED_SIGNERS is set but the file"
        echo "is missing or unreadable, and the updater refuses to build in that state."
        exit 1
    fi
    VERIFY_OUT="$(git -c gpg.format=ssh \
        -c "gpg.ssh.allowedSignersFile=$AURORA_UPDATE_ALLOWED_SIGNERS" \
        verify-commit "$TIP" 2>&1)" || VERIFY_RC=$?
else
    VERIFY_OUT="$(git verify-commit "$TIP" 2>&1)" || VERIFY_RC=$?
fi

# Print the command actually run, flags included — an operator copy-pasting a
# command that omits the ssh flags would reproduce the GPG path and get a
# different answer, which rather defeats the point.
echo "Gate command: $GATE_DESC  → exit $VERIFY_RC"
echo
[ -n "$VERIFY_OUT" ] && { echo "$VERIFY_OUT" | sed 's/^/    /'; echo; }

if [ "$VERIFY_RC" -eq 0 ]; then
    if $RUNNING_AS_ROOT; then
        echo "VERDICT: the gate PASSES. Safe to enable — set in /etc/aurora/aurora.env:"
    else
        echo "VERDICT: the gate PASSES *for this user* — NOT necessarily for the updater."
        echo "Re-run with sudo before trusting this; a PASS here with a FAIL as root is"
        echo "exactly how you end up with a server that has silently stopped deploying."
        echo
        echo "If it also passes as root, enable it by setting in /etc/aurora/aurora.env:"
    fi
    echo "    AURORA_UPDATE_REQUIRE_SIGNED=true"
    echo "then: systemctl restart aurora"
    if [ "$SIG_STATUS" = "U" ]; then
        echo
        echo "Note: the key is not marked trusted, which is why the output above"
        echo "carries a 'not certified with a trusted signature' warning. The gate"
        echo "still passes, and the protection is real: forging this signature needs"
        echo "the key's private half."
        echo
        echo "What actually bounds your security here is WHICH PUBLIC KEYS are in"
        echo "root's keyring — git verify-commit accepts a good signature from any"
        echo "of them regardless of trust level. Keep that keyring minimal."
        echo
        echo "To silence the warning and record the intent, mark the key trusted"
        echo "(no secret key required — this is why 'gpg --lsign-key' fails on a"
        echo "server, it needs a signing key of your own). One command, nothing"
        echo "to substitute — the fingerprint is piped straight through:"
        echo
        echo "    gpg --list-keys --with-colons ${KEY:-<key-id>} \\"
        echo "      | awk -F: '/^fpr/{print \$10\":6:\"; exit}' \\"
        echo "      | gpg --import-ownertrust"
    fi
    exit 0
fi

echo "VERDICT: DO NOT enable — the gate FAILS, so the updater would stop deploying."
echo
if $SSH_MODE; then
    # Advice keyed off the gate's own output, not %G? — in SSH mode the old
    # code fell into the "no signature at all" branch and told operators to
    # check whether the tip was really the merge commit, when the actual
    # problem was usually a signer missing from the allowed_signers file.
    case "$VERIFY_OUT" in
        *"No principal matched"*|*"no principal"*)
            echo "The signature is present but its signer is not listed in"
            echo "$AURORA_UPDATE_ALLOWED_SIGNERS. Add the signing key there, in"
            echo "the allowed_signers format:"
            echo "    <email-or-principal> <key-type> <public-key>"
            ;;
        *"No signature"*|*"no signature"*)
            echo "The tip carries no signature. Sign your commits, or unset"
            echo "AURORA_UPDATE_ALLOWED_SIGNERS to use the GPG path instead."
            ;;
        *)
            echo "See the git/ssh-keygen output above for the specific reason."
            ;;
    esac
    echo
    $RUNNING_AS_ROOT || echo "NOTE: re-run with sudo — this verdict used the wrong keyring/HOME."
    exit 1
fi
case "$SIG_STATUS" in
    N)
        echo "The tip carries no signature at all. If you merge through the GitHub web"
        echo "UI, GitHub signs the merge commit, so check the tip is that merge commit"
        echo "and not a locally-pushed unsigned one."
        ;;
    E)
        echo "The signing key is not in root's keyring, so the signature cannot be"
        echo "checked. If you merge pull requests through the GitHub web UI, commits on"
        echo "$BRANCH are signed by GitHub's key rather than your own. Trusting it stops"
        echo "a MITM on the fetch or a hijacked mirror from shipping code that runs as"
        echo "root — but note it does NOT stop anyone who can push to the repository,"
        echo "since they get a valid signature too."
        echo
        echo "To import it, as root:"
        echo "    curl -fsSL https://github.com/web-flow.gpg | gpg --import"
        echo "then re-run this script."
        ;;
    *)
        echo "See the gpg output above for the specific reason."
        ;;
esac
echo
echo "To use your OWN key instead, sign your commits and either import your public"
echo "key into root's keyring (GPG) or point AURORA_UPDATE_ALLOWED_SIGNERS at an"
echo "allowed_signers file (SSH)."
echo
$RUNNING_AS_ROOT || echo "NOTE: re-run with sudo — this verdict used the wrong keyring/HOME."
exit 1
