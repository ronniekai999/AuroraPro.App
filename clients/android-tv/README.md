# AuroraPro for Android TV

Native Kotlin, Compose for TV, and Media3 client for built-in Android TVs and
Google TV devices. Minimum Android version: **9 / API 28**. This is the first
login-to-playback client in the [approved delivery plan](../../docs/android-tv-plan.md),
with the playback refinements of 0.3.0 and the Aurora Stage TV design in version **0.4.0**.
The remaining web features are tracked in [the parity checklist](../../docs/android-tv-parity.md).
Server administration stays in the web app by design; the TV account menu tells
administrators where to find it.

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

- The Aurora Stage design: full-bleed title art behind Home and title pages that
  fades into the canvas and dims once you scroll, a single top bar, pill actions,
  poster and Continue Watching cards with a lilac focus ring, Match and rating
  details, and source badges: 4K/HD/SD from probed geometry and HDR/HLG from
  the probed color transfer, never from the version tag.
- Server connection and password sign-in, or phone/browser approval by QR/code.
- Existing profile selection with saved Aurora nebula orbs/custom images, and
  server-side session activation.
- Home recommendations when enabled, Recently Added, and Continue Watching.
- Paginated movie/show browsing, sorting and genre filters; debounced search with
  movie/show filters, keyboard Search and platform voice input where available.
- Aurora movie/show details, accurately labelled movie versions, seasons and
  episode artwork/progress, with next-episode continuation and restored focus.
- Direct playback when the device reports support, HLS remux/transcode, and a
  bounded H.264/AAC fallback for decoder/container errors.
- A single Aurora playback overlay that hides after five seconds while playing;
  source-time timeline and ±30-second seeking, audio/subtitle/quality settings,
  profile/episode progress, resume, and HLS keepalive/deletion.
- Smart Skip for recap/intro markers and reachable movie credits; next-episode
  controls, a cancellable credits countdown, natural-end autoplay, and a saved
  TV autoplay preference.
- Playback information that separates probed source dimensions, decoded output,
  active decoder and the server's direct/remux/transcode decision and reason.
- Encrypted persistent cookies in Android Keystore, origin isolation, and
  coordinated cookie refresh.

`Play / Resume` reads the selected profile's progress. `Start over` starts at
zero. Continue Watching resumes its listed episode even if earlier episodes are
unfinished. Other show details offer the next unfinished episode as well as manual
season and episode selection. Episode choices retain versions from matching
libraries, including when the selected show's episode has metadata but no local file.
Stop/sleep pauses playback; leaving the player flushes
progress and cleans up its HLS session. Leaving during a pending quality change
or long seek saves the last playable position, before the unconfirmed replacement.
Returning from sleep leaves playback
paused until the viewer resumes it.

In-player `Next episode` follows season/episode order and skips episodes without
files, including on rewatch. It retains the selected edition when the next
episode has that edition, otherwise uses its first available version. The next
episode starts at zero; Home's Continue Watching still uses saved resume progress.
At a credits marker, autoplay waits five seconds of observed playback. Pause,
buffering, sleep, seeking and open settings suspend the countdown. `Watch credits`
cancels automatic advancement for this episode, including its natural end;
`Next episode` remains available. Replaying starts a fresh countdown.
Without credits markers, enabled autoplay advances at the observed natural end.
The last available episode stays in the player; lookup failures offer Retry.

`Auto-play next episode` in player Settings defaults to On and persists on this
TV, just as the web stores its preference in each browser. It is not a server
profile setting and does not synchronize to browsers. Turning it Off retains
explicit next-episode controls. Markers use source-file time, including resumed
HLS anchors; skipping an intro beyond the current playlist creates a new session.
Movie credits only offer a skip when their destination is already reachable,
avoiding a transcode rebuild at approximate EOF. Progress saves the observed
outgoing episode position rather than synthesizing completion at a credits marker.

D-pad/OK reveals hidden player controls without activating an invisible button.
Pause, scrubbing and open settings keep controls visible. Back dismisses settings,
then the overlay, before returning to the title. Media transport keys work while
the overlay is hidden. HLS quality changes replace the session at the source
position and preserve pause and track selections; available tiers come from the
actual supported stream tracks. Direct playback offers Original. Player settings
stay in the video window so older TVs do not have to composite a separate dialog
window over the video surface.

Source dimensions come from scanned `resolution` metadata, not `version_tag`.
A stored "720p" edition tag cannot label a 1918×1038 source as 720p. Refresh
missing dimensions/profile/frame-rate metadata on the server before expecting a
device capability decision. A 4K emulator display does not establish a hardware
HEVC decoder; the information panel explains conservative compatibility playback.

Signing out uses Aurora's existing **account-wide logout**. Its confirmation
states this before sending the request. Changing the server only changes this
client's connection and does not revoke other devices.

## Reviewing the design without a TV

The JVM screen captures render the real app against a fixture server with
Robolectric, so the design can be reviewed where no emulator runs:

```sh
./gradlew testDebugUnitTest --tests '*ScreenCaptureTest' -Paurora.screenshots
# Optional: serve real artwork by file name from a local folder.
./gradlew testDebugUnitTest --tests '*ScreenCaptureTest' -Paurora.screenshots -Paurora.screenshots.art=/path/to/art
```

PNGs are written to `app/build/outputs/screens`. Without `-Paurora.screenshots`
(or with `-Paurora.screenshots=false`) the capture test is excluded from the test
run and Android resources are not merged for unit tests; CI still compiles it and
resolves Robolectric and the Compose test libraries. These are design evidence
only: remote navigation, playback and device behavior are proven by the
instrumentation suite and on a TV.

## Browser pairing contract

Pairing requires the backend and web support delivered with the TV foundation. Password sign-in
can use the existing cookie-auth API. Deploy the reviewed server/web build
before testing phone approval.
Older servers return a clear update/password message in the TV app when pairing
routes are missing, instead of a generic HTTP 404. New/expired codes and temporary
connection loss remain retryable. This client update does not deploy the server.

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

This build includes paginated browsing/filtering, playback quality and track
controls, Smart Skip and automated episode continuation. Bitmap subtitle
burn-in, library saves/collections,
requests, calendar, watch parties, notifications and social features
remain in later milestones; server administration stays in the web app. Track selection is limited to tracks the chosen
direct file/HLS manifest exposes. A manually selected original-file audio track
is matched to scanned language, codec, channels and title before compatibility
fallback. If that metadata cannot identify one track, playback asks for Automatic
audio rather than silently switching languages. Search returns up to the server's
supported maximum of 50 results per query.
Returning mapped audio to Automatic replaces its HLS session at the source
position. Manual captions match across containers by language and meaningful
track properties; unavailable or ambiguous replacements disable captions and
offer a visible Settings message instead of choosing another track.
Progress reads and writes share a profile/title/episode lock across players,
so reopening waits for the preceding player's final save. A replacement stream
keeps the outgoing checkpoint until Media3 reports the new item ready, including
when its playlist or first segments fail. Returning to the title refreshes episode
progress, series continuation, and Home after the final save finishes.
This APK is a sideloaded debug build, not a
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
   Verify source-time progress and that leaving removes its HLS session. Seek
   near the end while the replacement playlist/segments cannot load, then exit:
   the saved position must remain at the last playable checkpoint.
   Finish an episode, return to its title, select the season, and choose Continue
   series: it must start the next unfinished episode. Return to Home as well and
   check that Continue Watching no longer resumes the completed episode. Open
   Profiles during the refresh and return without switching; the title must
   recover its updated episode progress and continuation.
6. Relaunch the app; confirm the cookie session persists, select another
   profile, and check that progress stays attached to the original profile.
7. Test network loss, sleep/wake, and expired credentials; record the TV model,
   Android version, server revision, file codecs, and observed result.

Builds, contract tests, D-pad instrumentation, real-server flows, and physical
device acceptance are separate evidence. Keep their results separate in PRs.
