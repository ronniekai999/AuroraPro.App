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

SOURCE_DIR="${AURORA_SOURCE_DIR:-/var/lib/aurora/source}"
BRANCH="${AURORA_UPDATE_BRANCH:-main}"

while [ $# -gt 0 ]; do
    case "$1" in
        --source-dir) SOURCE_DIR="${2:?--source-dir needs a value}"; shift 2 ;;
        --branch)     BRANCH="${2:?--branch needs a value}"; shift 2 ;;
        # Print the header block by content, not a hardcoded line range —
        # a fixed range silently truncates the help the moment the comment
        # above grows a line.
        -h|--help)    awk 'NR>1 && /^#/ {print} NR>1 && !/^#/ {exit}' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ ! -d "$SOURCE_DIR/.git" ]; then
    echo "ERROR: $SOURCE_DIR is not a git checkout (pass --source-dir)" >&2
    exit 2
fi

cd "$SOURCE_DIR"

TIP="$(git rev-parse "origin/$BRANCH" 2>/dev/null || true)"
if [ -z "$TIP" ]; then
    echo "ERROR: origin/$BRANCH not found in $SOURCE_DIR — run a git fetch first" >&2
    exit 2
fi

echo "Repository : $SOURCE_DIR"
echo "Branch     : origin/$BRANCH"
echo "Tip        : $TIP"
echo "Committer  : $(git log -1 --format='%cn <%ce>' "$TIP")"
echo

# Informational: what signature is on the tip, and from which key.
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
if [ -n "${AURORA_UPDATE_ALLOWED_SIGNERS:-}" ]; then
    echo "Mode       : SSH allowed-signers ($AURORA_UPDATE_ALLOWED_SIGNERS)"
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

echo "Gate command: git verify-commit $TIP  → exit $VERIFY_RC"
echo
[ -n "$VERIFY_OUT" ] && { echo "$VERIFY_OUT" | sed 's/^/    /'; echo; }

if [ "$VERIFY_RC" -eq 0 ]; then
    echo "VERDICT: the gate PASSES. Safe to enable — set in /etc/aurora/aurora.env:"
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
        echo "server, it needs a signing key of your own):"
        echo "    gpg --list-keys --with-colons ${KEY:-<key>} | awk -F: '/^fpr/{print \$10; exit}'"
        echo "    echo '<that-fingerprint>:6:' | gpg --import-ownertrust"
    fi
    exit 0
fi

echo "VERDICT: DO NOT enable — the gate FAILS, so the updater would stop deploying."
echo
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
exit 1
