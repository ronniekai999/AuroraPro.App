# AuroraPro for Android TV

Native Kotlin, Compose for TV, and Media3 client for built-in Android TVs and
Google TV devices. Minimum Android version: **9 / API 28**. This is the first
login-to-playback build in the [approved delivery plan](../../docs/android-tv-plan.md).
The remaining web features are tracked in [the parity checklist](../../docs/android-tv-parity.md).

## Build and install

Open `clients/android-tv` as a project in Android Studio. Use a **JDK 21** Gradle
JDK, install Android SDK Platform 36, and let Gradle install its required build
tools. The checked-in wrapper uses Gradle 8.13; local SDK paths belong in ignored
`local.properties`.

```sh
./gradlew assembleDebug testDebugUnitTest lintDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n app.aurorapro.tv/.MainActivity
```

Select an Android TV emulator in Device Manager, rather than a phone. Run the
remote and playback tests with `bash scripts/test-remote.sh`. These run real instrumentation
through ADB and check the JUnit result; this supports older TV images whose
Gradle split-APK installer can fail before running tests. A built-in Android TV is
the first physical-device target; an emulator cannot validate its decoder, HDR,
audio output, memory limits, or sleep behavior.

Enter the normal Aurora server origin, optionally ending in `/v2/`. Public
servers require HTTPS. HTTP is allowed for private IPv4 addresses, loopback,
and `.local`/`.lan` hosts. In an Android emulator, a server on the same computer
is reachable at `http://10.0.2.2:PORT`, while `localhost` refers to the emulator.
Self-signed HTTPS certificates require a properly trusted server certificate.

The desktop user's emulator and this chat's cloud environment are separate.
An APK can be installed locally with the commands above; leaving an emulator
open does not connect it to the cloud agent.

The playback instrumentation serves a generated color/tone fixture through an
in-device HTTP test server. It verifies real Media3 playback, the returned HLS
anchor, profile-bound source progress, and session cleanup without a production
server or media library.

## Available in this build

- Server connection and password sign-in, or phone/browser approval by QR/code.
- Existing profile selection and server-side session activation.
- Home recommendations when enabled, Recently Added, and Continue Watching.
- Basic movie/show browsing, library search, movie versions, seasons, and episodes.
- Direct playback when the device reports support, HLS remux/transcode, and a
  bounded H.264/AAC fallback for decoder/container errors.
- Native playback controls and track selection, source-time ±30-second seeking,
  profile/episode progress, resume, and HLS keepalive/deletion.
- Encrypted persistent cookies in Android Keystore, origin isolation, and
  coordinated cookie refresh.

`Play / Resume` reads the selected profile's progress. `Start over` starts at
zero. Show details offer the next unfinished episode as well as manual season
and episode selection. Stop/sleep pauses playback; leaving the player flushes
progress and cleans up its HLS session. Returning from sleep leaves playback
paused until the viewer resumes it.

Signing out uses Aurora's existing **account-wide logout**. Its confirmation
states this before sending the request. Changing the server only changes this
client's connection and does not revoke other devices.

## Browser pairing contract

Pairing requires the backend and web changes from this branch. Password sign-in
can use the existing cookie-auth API. Deploy the reviewed server/web build
before testing phone approval.

| Endpoint | Authentication | Behavior |
| --- | --- | --- |
| `POST /api/auth/device/start` | Public; rate limited | Device name → random secret, public code, relative `/v2/device` URI, ten-minute expiry and five-second poll interval |
| `GET /api/auth/device/preview?code=…` | Signed-in browser | Returns the pending device name and verified account identity; no session or device secret |
| `POST /api/auth/device/authorize` | Signed-in browser; same-origin check | Approves the public code with the preview's `expected_user_id`; rejects an account change before approval |
| `POST /api/auth/device/poll` | Device secret; rate limited | Pending/expired status or one cookie-auth session; no bearer/refresh token in JSON |

The server stores a digest of the 256-bit device secret in bounded memory.
Approval codes and grants expire, survive neither server restarts nor exchanges,
and can create only one refresh-token row. Password changes/account revocation
invalidate an approved grant before exchange. Restart the sign-in flow if a code
expires or a response is lost. Pairing assumes the existing single-server
deployment; multiple replicas would need a shared transient grant store.

Device exchange checks the approved account version while locking its user row.
Refresh rotation consumes and replaces the old session under that lock, carrying
its profile and capturing the current identity before committing. Account-wide
logout/password revocation use the same lock
to change that version and revoke refresh sessions in one transaction, so a
pending exchange cannot insert a renewable session after revocation completes.
The native client serializes profile activation with refresh, so renewal carries
the acknowledged parental/profile binding rather than copying a stale selection.

OAuth sign-in on the browser retains only the public code in session storage
for up to ten minutes and returns to the explicit approval page. If browser
storage is unavailable, scan the TV QR again after signing in.

## Playback contract and current limits

Capabilities follow [the native contract](../../docs/native-client-caps.md).
The app probes hardware video decoders for the source size/frame rate and HDR
display support, declares `hls_native`, and never declares `hls_js` or Hi10P.
Unknown source dimensions/frame rate and height-only legacy labels use the
server path. HEVC claims require matching source and decoder profiles; Main10
does not imply support for 12-bit or Range Extensions sources.
DTS/TrueHD/legacy video and uncertain high-bit-depth VP9/AV1 fall back through
the server. Hardware-specific capability behavior still needs physical-TV tests.

Progress and seek requests use **source milliseconds**. For HLS, player time
is translated by the server's returned `start_sec`, rather than by the requested
offset. An HLS seek outside the available playlist starts a new session and
deletes the previous one. The visible source clock uses the source duration,
not the length of a growing playlist.

This build has a basic browse page, native track controls, and manual episode
continuation. Complete pagination/filtering, quality controls, skip markers,
bitmap subtitle burn-in, automated episode advance, library saves/collections,
requests, calendar, watch parties, notifications, social, and administration
remain in later milestones. Track selection is limited to tracks the chosen
direct file/HLS manifest exposes. This APK is a sideloaded debug build, not a
signed production release.

## First device acceptance run

1. Install, launch from the TV launcher, and connect to the Aurora origin.
2. Sign in with a password; then repeat with a browser code and confirm that
   scanning/looking up a code alone does not approve it.
3. Choose a profile, navigate Home/search/details with the D-pad, and select a
   movie version or episode. Check that restricted profiles cannot play a title
   excluded by their rating ceiling.
4. Play a baseline H.264/AAC file, pause/resume, seek, and leave the player.
   Open that title in the web app using the same profile and verify its position.
5. Repeat with a forced-transcode/remux fixture and a nonzero resume offset.
   Verify source-time progress and that leaving removes its HLS session.
6. Relaunch the app; confirm the cookie session persists, select another
   profile, and check that progress stays attached to the original profile.
7. Test network loss, sleep/wake, and expired credentials; record the TV model,
   Android version, server revision, file codecs, and observed result.

Builds, contract tests, D-pad instrumentation, real-server flows, and physical
device acceptance are separate evidence. Keep their results separate in PRs.
