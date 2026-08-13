# Aurora for macOS

Native SwiftUI client. Its reason to exist is direct play: a libVLC-backed
player decodes the MKV/DTS/TrueHD/Hi10P files a browser cannot, so the server
serves original bytes instead of spawning FFmpeg.

The server side of that landed first — see `docs/native-client-caps.md` for the
capability contract this app implements.

## Build

```bash
cd clients/macos
./scripts/run.sh          # build + run
swift test
```

`swift run Aurora` works too, but **only without VLCKit installed**. See the
dyld note under [Adding VLCKit](#adding-vlckit).

No third-party dependencies, so the first build cannot fail on dependency
resolution — the one failure mode that tells you nothing about whether the code
is right. Requires macOS 14 and Xcode 15+.

To work in Xcode: `open Package.swift`.

> **Why there's an `AppDelegate` that only sets the activation policy.** A
> SwiftPM executable is not a `.app` bundle, so macOS launches it with the
> *accessory* activation policy: the window draws, but the process never
> becomes frontmost, never gets a key window, and silently discards every
> keystroke. It presents as "the login field won't accept typing".
> `AppDelegate` promotes the process to `.regular` and activates it. Once the
> app is properly bundled (Milestone 6) those calls become no-ops, so the
> terminal dev loop and the shipped app behave identically.

## Milestone status

| # | Scope | Status |
|---|---|---|
| 1 | API client, cookie auth, home, detail, player | done |
| **2** | **VLCKit engine + track selection** | **this milestone** |
| 3 | HLS session playback; Library, Browse, Search, Collections, Calendar | next |
| 4 | Watch parties + realtime (4 WebSocket channels) | |
| 5 | Admin + Settings | |
| 6 | Offline downloads | |
| 7 | AirPlay, notarization, updater | |

**VLCKit moved ahead of HLS playback** on evidence, not preference. The
original plan assumed the Apple engine needed HLS to play a real library — but
measuring the live server showed it gets `direct_stream` (a remux), not a full
transcode. So wiring libVLC converts those same files to `direct_play`
outright, which is both the bigger win and less code. HLS still has to exist —
it is the right answer for remote playback over thin links, where transcoding
down is a feature — but it is no longer the urgent half.

**Playback still requires a `direct_play` decision.** On the Apple engine most
of a real library will remux, and the player says so explicitly rather than
failing obscurely. Install VLCKit (below) and those same titles direct-play.

## Adding VLCKit

```bash
./scripts/fetch-vlckit.sh
./scripts/run.sh
```

Then pick **VLC (libVLC)** from the player menu in the toolbar.

> **Use `scripts/run.sh`, not `swift run`, once VLCKit is installed.** The
> framework's install name is
> `@loader_path/../Frameworks/VLCKit.framework/Versions/A/VLCKit`, written for
> an app *bundle* — inside `Aurora.app` that resolves to
> `Contents/Frameworks/` and works natively. `swift run` produces a bare
> executable at `.build/<triple>/debug/Aurora`, so `@loader_path/..` resolves
> to `.build/<triple>/`, where SwiftPM never creates a `Frameworks` directory.
> The build links fine and the process dies at launch with
> `dyld: Library not loaded`. Nothing is broken — dyld looks exactly where it
> was told and nobody put the framework there. `run.sh` puts it there,
> deriving the path from `swift build --show-bin-path` rather than hardcoding
> a triple. Packaging (Milestone 7) makes this moot.

The app ships two engines behind one protocol (`AuroraPlayback/PlaybackEngine.swift`):

| Engine | Plays | Capability set | Dependency |
|---|---|---|---|
| `AVPlaybackEngine` | MP4/MOV — H.264/HEVC, AAC/AC-3/E-AC-3 | `appleNative` | none |
| `VLCPlaybackEngine` | essentially everything | `libVLC` | VLCKit, ~84 MB |

`Package.swift` **detects** `Frameworks/VLCKit.xcframework` rather than pinning
a download URL: VideoLAN's artifact locations, versions and checksums move
between releases, and a stale hard-coded URL fails at dependency resolution —
the one failure that tells you nothing about whether the code is right. Without
the framework the package still builds, `VLCPlaybackEngine` compiles out via
`#if canImport(VLCKit)`, and `EngineKind.libVLC.isAvailable` reports false.

The version is **pinned to VLCKit 3.7.3** (universal `macos-arm64_x86_64`).
VLCKit 4.x reworks the track API entirely, so it is not a drop-in — this engine
is written against the 3.7 Objective-C headers, down to their nullability
annotations. VLCKit is LGPL-2.1+, which suits direct distribution; the fetch
script copies `COPYING.txt` alongside the framework.

### Why it's worth the 84 MB

Measured against a real library file — MKV, HEVC Main 10, E-AC-3, HDR
(`color_transfer: smpte2084`):

| Caps sent | Server decision | What happens |
|---|---|---|
| none | `transcode` | full re-encode |
| `appleNative` | `direct_stream` | FFmpeg remuxes the container |
| `libVLC` | **`direct_play`** | original bytes, no FFmpeg, HDR preserved |

The third row is the entire point of the Tier 1 server work. It also means the
embedded tracks stay available: that file carries **12 subtitle tracks**, which
libVLC reads straight from the container with no server involvement.

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
