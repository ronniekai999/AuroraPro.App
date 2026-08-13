# Aurora for macOS

Native SwiftUI client. Its reason to exist is direct play: a libVLC-backed
player decodes the MKV/DTS/TrueHD/Hi10P files a browser cannot, so the server
serves original bytes instead of spawning FFmpeg.

The server side of that landed first — see `docs/native-client-caps.md` for the
capability contract this app implements.

## Build

```bash
cd clients/macos
swift build
swift run Aurora
swift test
```

No third-party dependencies, so the first build cannot fail on dependency
resolution — the one failure mode that tells you nothing about whether the code
is right. Requires macOS 14 and Xcode 15+.

To work in Xcode: `open Package.swift`.

## Milestone status

| # | Scope | Status |
|---|---|---|
| **1** | API client, cookie auth, home, detail, player | **this milestone** |
| 2 | HLS session playback; Library, Browse, Search, Collections, Calendar, Requests | next |
| 3 | Watch parties + realtime (4 WebSocket channels) | |
| 4 | Admin + Settings | |
| 5 | Offline downloads | |
| 6 | AirPlay, notarization, updater | |

**Milestone 1 plays direct-play titles only.** Anything the server decides to
remux or transcode shows an explicit message rather than failing obscurely —
HLS session playback is Milestone 2. On the Apple engine that will be most of
the library, which is the point: it makes the engine's limits visible before
VLCKit is wired up.

## Adding VLCKit

The app ships two engines behind one protocol (`AuroraPlayback/PlaybackEngine.swift`):

| Engine | Plays | Capability set |
|---|---|---|
| `AVPlaybackEngine` | MP4/MOV — H.264/HEVC, AAC/AC-3/E-AC-3 | `ClientCapabilities.appleNative` |
| `VLCPlaybackEngine` | essentially everything | `ClientCapabilities.libVLC` |

`VLCPlaybackEngine.swift` is wrapped in `#if canImport(VLCKit)`, so it compiles
in only once the dependency exists and `EngineKind.libVLC.isAvailable` reports
the truth at runtime.

To add it, either add the package dependency in Xcode (File → Add Package
Dependencies) pointing at VideoLAN's VLCKit, or add it to `Package.swift` and
list `"VLCKit"` in the `AuroraPlayback` target's dependencies. VideoLAN
publishes VLCKit as a binary XCFramework; check
<https://code.videolan.org/videolan/VLCKit> for the current SPM URL and tag,
since the distribution has changed across major versions.

> **The engine chooses the capability string.** They are one decision, not two.
> `ClientCapabilities.appleNative` deliberately omits `mkv_container`, `dts`,
> `truehd`, `h264_hi10` and the legacy codecs, because the server trusts a
> capability claim completely — it has no way to verify one. Claiming what the
> active engine cannot decode earns a direct-play decision that renders as a
> black window with no transcode fallback. If you add an engine, add its
> capability set alongside it; never reuse another's.

## How the contract stays honest

Swift cannot be compiled on the Linux hosts that build this repo, which makes
the capability string the highest-risk part of the client: pure data, fully
trusted by the server, and invisible to `go test`.

So it is checked from the Go side. `internal/streaming/macclient_caps_test.go`
reads `Sources/AuroraKit/ClientCaps.swift` as text and enforces that:

- the `libVLC` set equals the documented contract exactly — drift in *either*
  direction fails, since a missing key silently transcodes files that could
  have direct-played;
- every key both engines send is one `ParseClientCaps` actually understands, so
  a typo cannot become a permanent silent transcode;
- the `appleNative` set claims nothing AVFoundation cannot decode, and stays a
  subset of `libVLC`.

Those run on every `go test ./...` with no Mac in the loop. Changing the caps in
Swift without updating `docs/native-client-caps.md` fails CI on Linux.

## Architecture

```
AuroraKit        — API client, DTOs, cookie auth, capabilities. No UI.
AuroraPlayback   — PlaybackEngine protocol + the two engines. No UI beyond an NSView.
AuroraApp        — SwiftUI views and app state.
```

Auth is **cookie-based**, not bearer tokens: `POST /api/auth/login` sets
httpOnly cookies and returns no tokens in the body (`internal/models/models.go`
says non-browser clients must use the cookies). `URLSession` carries them
automatically; `CookieStore` persists them to the Keychain across launches, and
`AuroraClient` refreshes them single-flight so a burst of concurrent 401s
produces one refresh rather than N.

## Packaging

`swift run` produces a bare executable, which is fine for development but is
not a bundle — no Info.plist, no icon, no code signature. Distribution needs an
Xcode app target wrapping these packages, then signing and notarization.
That's Milestone 6; unsigned local builds are expected until then.
