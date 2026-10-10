#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
./gradlew assembleDebug assembleDebugAndroidTest

android_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
adb_command="${android_sdk}/platform-tools/adb"
if [[ ! -x "$adb_command" ]]; then adb_command="$(command -v adb)"; fi

# Install a single APK directly. This also works with older TV images where
# AGP's UTP split-APK installer can fail before it runs any tests.
"$adb_command" install -r --no-streaming app/build/outputs/apk/debug/app-debug.apk
"$adb_command" install -r --no-streaming app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
mkdir -p app/build/reports
report=app/build/reports/remote-navigation.txt
"$adb_command" shell am instrument -w app.aurorapro.tv.test/androidx.test.runner.AndroidJUnitRunner | tee "$report"

# am instrument can exit zero even on a test failure. Require a nonempty
# JUnit success report so crashes, zero-test runs, and assertion failures fail CI.
if ! tr -d '\r' < "$report" | grep -Eq '^OK \([1-9][0-9]* tests?\)$'; then
    echo 'TV navigation and playback instrumentation did not pass.' >&2
    exit 1
fi
