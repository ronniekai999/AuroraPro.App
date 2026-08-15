#!/usr/bin/env bash
# Download VLCKit and put its XCFramework where Package.swift looks for it.
#
# libVLC is what turns the server's Tier 1 work into actual direct play.
# Measured against a real library file (MKV / HEVC Main 10 / E-AC-3 / HDR):
#
#   Apple caps  → direct_stream   "container \"mkv\" not natively supported"
#   libVLC caps → direct_play     (compatible)
#
# i.e. original bytes, no FFmpeg on the server, and the HDR survives instead of
# being tone-mapped to SDR.
#
# Package.swift DETECTS Frameworks/VLCKit.xcframework rather than pinning a
# URL, so the package still builds without this — the Apple engine just remuxes
# more. Run this once, then `swift build`.
#
#   ./scripts/fetch-vlckit.sh              # default pinned version
#   VLCKIT_URL=<url> ./scripts/fetch-vlckit.sh
#
# The build is a universal macOS slice (arm64 + x86_64), ~84 MB compressed.
# VLCKit is LGPL-2.1+; fine for the direct-download distribution this app
# targets. See the COPYING.txt it ships with.

set -euo pipefail

# Pinned rather than "latest": a version bump can move the Objective-C surface
# (VLCKit 4.x reworks the track API entirely), and this engine is written
# against the 3.7 headers.
DEFAULT_URL="https://download.videolan.org/pub/cocoapods/prod/VLCKit-3.7.3-319ed2c0-79128878.tar.xz"
URL="${VLCKIT_URL:-$DEFAULT_URL}"

cd "$(dirname "$0")/.."
DEST="Frameworks"
TARGET="$DEST/VLCKit.xcframework"

if [ -d "$TARGET" ]; then
  echo "VLCKit.xcframework already present at $TARGET"
  echo "Remove it first if you want to re-download."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading VLCKit…"
echo "  $URL"
curl -# -L --fail --max-time 900 -o "$TMP/vlckit.tar.xz" "$URL"

echo "Extracting…"
tar -xJf "$TMP/vlckit.tar.xz" -C "$TMP"

# The archive unpacks to a directory whose name contains spaces
# ("VLCKit - binary package"), so find the framework rather than assuming a path.
FOUND="$(find "$TMP" -maxdepth 3 -type d -name "VLCKit.xcframework" -print -quit)"
if [ -z "$FOUND" ]; then
  echo "error: no VLCKit.xcframework inside the archive." >&2
  echo "The layout may have changed; check the contents of $URL" >&2
  exit 1
fi

mkdir -p "$DEST"
cp -R "$FOUND" "$TARGET"

# Ship the licence alongside the binary — LGPL requires it, and a stray
# framework with no COPYING is a problem you find at distribution time.
LICENSE="$(find "$TMP" -maxdepth 2 -name "COPYING.txt" -print -quit)"
[ -n "$LICENSE" ] && cp "$LICENSE" "$DEST/VLCKit-COPYING.txt"

SLICES="$(ls "$TARGET" | grep -v Info.plist | tr '\n' ' ')"
echo
echo "Installed $TARGET"
echo "  slices: $SLICES"
echo
echo "Next:"
echo "  swift build && swift run Aurora"
echo "Then pick 'VLC (libVLC)' from the player menu in the toolbar."
