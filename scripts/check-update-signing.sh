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

# What signature, if any, is on the tip? %G? is git's verification verdict:
#   G = good, U = good-but-untrusted, X = good-but-expired, Y/R = expiry/revoke
#   E = cannot check (no key / no allowedSigners), N = no signature at all
SIG_STATUS="$(git log -1 --format='%G?' "$TIP" 2>/dev/null || echo '?')"
SIGNER="$(git log -1 --format='%GS' "$TIP" 2>/dev/null || true)"
KEY="$(git log -1 --format='%GK' "$TIP" 2>/dev/null || true)"

case "$SIG_STATUS" in
    N)
        echo "Signature  : NONE"
        echo
        echo "VERDICT: enabling AURORA_UPDATE_REQUIRE_SIGNED would BREAK UPDATES."
        echo "The tip commit carries no signature at all, so verification cannot pass."
        echo
        echo "If you merge via the GitHub web UI, GitHub signs the resulting commit"
        echo "with its own key and this should not happen — check that the tip is the"
        echo "merge commit and not a locally-pushed unsigned one."
        exit 1
        ;;
    G)
        echo "Signature  : GOOD (trusted by this machine's keyring)"
        [ -n "$SIGNER" ] && echo "Signer     : $SIGNER"
        [ -n "$KEY" ] && echo "Key        : $KEY"
        echo
        echo "VERDICT: safe to enable. Set in /etc/aurora/aurora.env:"
        echo "    AURORA_UPDATE_REQUIRE_SIGNED=true"
        echo "then: systemctl restart aurora"
        exit 0
        ;;
    U|X|Y|R)
        echo "Signature  : present but status '$SIG_STATUS' (untrusted/expired/revoked)"
        [ -n "$SIGNER" ] && echo "Signer     : $SIGNER"
        [ -n "$KEY" ] && echo "Key        : $KEY"
        echo
        echo "VERDICT: DO NOT enable yet — git verify-commit would reject this."
        echo "The signature exists but this machine does not fully trust the key."
        exit 1
        ;;
    E|*)
        echo "Signature  : present, but this machine CANNOT CHECK it"
        [ -n "$KEY" ] && echo "Key        : $KEY"
        echo
        echo "VERDICT: DO NOT enable yet — the signing key is not in root's keyring,"
        echo "so verification fails and the updater would stop."
        echo
        echo "If you merge pull requests through the GitHub web UI, the commits on"
        echo "$BRANCH are signed by GitHub's web-flow key rather than your own."
        echo "Trusting it is a real improvement — it stops a MITM on the fetch or a"
        echo "hijacked mirror from shipping code that runs as root — but understand"
        echo "what it does NOT cover: anyone who can push to the repository still"
        echo "gets a valid signature, so it is not protection against an account"
        echo "compromise."
        echo
        echo "To trust GitHub's web-flow key, as root:"
        echo "    curl -fsSL https://github.com/web-flow.gpg | gpg --import"
        echo "    gpg --lsign-key <key-id-from-the-import-output>"
        echo "then re-run this script; it should report GOOD."
        echo
        echo "To trust your OWN key instead, sign your commits and either import"
        echo "your public key into root's keyring (GPG) or point"
        echo "AURORA_UPDATE_ALLOWED_SIGNERS at an allowed_signers file (SSH)."
        exit 1
        ;;
esac
