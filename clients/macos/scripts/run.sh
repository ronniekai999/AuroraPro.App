#!/usr/bin/env bash
# Build and run Aurora, with VLCKit placed where dyld will actually look.
#
# Why this exists: VLCKit.framework's install name is
#
#   @loader_path/../Frameworks/VLCKit.framework/Versions/A/VLCKit
#
# which is written for an app BUNDLE — inside Aurora.app it resolves to
# Aurora.app/Contents/Frameworks/ and just works. `swift run` produces a bare
# executable at .build/<triple>/debug/Aurora instead, so @loader_path/..
# resolves to .build/<triple>/, and SwiftPM never creates a Frameworks
# directory there. The build links fine and the process dies at launch:
#
#   dyld: Library not loaded: @loader_path/../Frameworks/VLCKit.framework/…
#
# Nothing is broken — dyld is looking exactly where it was told, and no one put
# the framework there. This script does, deriving the path from
# `swift build --show-bin-path` rather than hardcoding a triple, so it works on
# Apple Silicon and Intel and in debug or release.
#
# This is a DEV-LOOP fix only. A packaged .app (Milestone 7) puts frameworks in
# Contents/Frameworks, which is what the install name already expects.
#
#   ./scripts/run.sh                 # debug
#   ./scripts/run.sh -c release      # anything here is passed to swift build

set -euo pipefail
cd "$(dirname "$0")/.."

swift build "$@"

BIN_DIR="$(swift build "$@" --show-bin-path)"
XCFW="Frameworks/VLCKit.xcframework"

if [ -d "$XCFW" ]; then
  # Pick the macOS slice by name rather than assuming one: the universal build
  # is "macos-arm64_x86_64", but a single-arch build would differ.
  SLICE="$(find "$XCFW" -maxdepth 1 -type d -name "macos-*" -print -quit)"
  if [ -z "$SLICE" ]; then
    echo "warning: $XCFW has no macos-* slice; running without VLCKit" >&2
  else
    DEST="$BIN_DIR/../Frameworks"
    mkdir -p "$DEST"
    # Symlink rather than copy: 84 MB, and it stays current if the framework
    # is ever re-fetched.
    rm -rf "$DEST/VLCKit.framework"
    ln -s "$PWD/$SLICE/VLCKit.framework" "$DEST/VLCKit.framework"
    echo "linked VLCKit → $DEST/VLCKit.framework"
  fi
fi

exec "$BIN_DIR/Aurora"
