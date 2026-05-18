# Aurora TV — Android TV Client

Native Jetpack Compose for TV client for the Aurora media server.

## Phase 0 status

This is **scaffolding only**. Two screens (sign-in → profile picker) run end-
to-end against stubbed state. P1 will wire the real backend and ship a home
screen matching `../static/aurora_tv_mockup.html`.

## Getting started

Prerequisites:
- JDK 17
- Android Studio Ladybug (2024.2.1) or newer
- Android SDK 35 + build-tools

**First-time setup — generate the Gradle wrapper.** This scaffold doesn't
check in the wrapper binaries. Pick one:

```bash
# Option A — open in Android Studio; it generates the wrapper on first sync.
# Option B — from a shell, if you have Gradle ≥ 8.11 installed globally:
cd android-tv
gradle wrapper --gradle-version 8.11.1
```

Once the wrapper exists:

```bash
cd android-tv
./gradlew :app:assembleDebug        # build an installable APK
./gradlew :app:installDebug         # install on a connected Android TV device
```

For Android Studio: open the `android-tv/` directory as a project. Studio
recognizes the `settings.gradle.kts` and syncs all modules automatically.

## Distribution

Sideload-only for now — we do not publish to the Play Store. Releases are
cut as signed `.apk` files attached to GitHub releases. Users can install
via `adb install` or via a sideloader app on Android TV. An in-app updater
(P2) will check the Aurora server for newer builds.

## Module layout

```
app/                 — single installable APK; MainActivity + nav host
core/
  design/            — color / typography / shape / dimension tokens
  ui/                — AuroraMark, FocusableCard, ShimmerPoster
  auth/              — sign-in UI, JWT token store, auth state machine
  network/           — shared OkHttp/JSON singletons (Retrofit per-server in P1)
  database/          — Room + DataStore (P1 adds DAOs)
  media/             — CapabilityProber, DeviceProfile
feature/
  profiles/          — "Who's Watching?" picker (launch screen)
```

Each `:feature:*` module depends only on `:core:*`. Features do not depend
on each other; cross-feature transitions go through `app/navigation/`.

## Design-principle enforcement (research-derived)

These rules are non-negotiable as features are added. See the build plan
for why each matters and which competitor pain point it addresses.

| # | Rule | Where enforced |
|---|------|----------------|
| P1 | Cold start → visible home ≤ 2s | benchmarked in CI (P1) |
| P2 | Focus is state, not DOM | `FocusableCard`; no `LazyRow` tricks |
| P3 | Runtime codec probing, not static profiles | `CapabilityProber` |
| P4 | Every automatic decision has a manual override | settings screen (P1) |
| P5 | Resume position is a first-class invariant | Room `PlaybackPosition` DAO (P1) |
| P6 | Profile picker before home | wired in `AuroraNavHost` |
| P7 | Google TV Watch Next channel on day one | `:integration:watchnext` (P1) |
| P8 | Offline library works when offline | `:feature:downloads` (P2) |
| P9 | Skip Intro/Credits works everywhere Plex/web does | `:feature:player` (P1) |
| P10 | No cross-platform shims — Compose, Media3, OkHttp only | no RN/Flutter/Ionic |

## Backend dependencies

- JWT auth (already in Aurora — `internal/api/auth`)
- Streaming endpoints (HLS + direct download, already in Aurora)
- **New for P1**: `POST /api/v1/device/probe` — accept a `DeviceProfile` JSON and
  cache it so server can pre-select direct-play candidates per session
- **New for P1**: `GET /api/v1/watchnext/channel` — flat list of items for
  the Google TV Watch Next system channel

## Phase roadmap

| Phase | Weeks | Outcome |
|-------|-------|---------|
| P0    | 2     | This scaffold — auth + profile screens, theme, prober |
| P1    | 6     | Home, Library, Detail, Player, Search, Requests, Watch Next |
| P2    | 6     | Downloads, parental controls, Watch Party, Chromecast |
| P3    | 4     | Lyrics, ambient mode, voice AI, polish |

Beta = end of P1. Public = end of P2.
