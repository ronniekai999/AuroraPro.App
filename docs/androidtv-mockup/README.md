# Aurora Pro — Android TV UI mockup

A high-fidelity, **design-parity** mockup of a native Android TV app for Aurora
Pro, covering the **full web feature set**. Open [`index.html`](./index.html)
in any browser — no build step, no dependencies.

> The goal: *"we can make the app look like that."* Every value here is lifted
> straight from the live web SPA (`static/redesign/app`), then re-laid-out for
> the 10-foot / D-pad living-room experience.

## What's in it

A single self-contained `index.html` renders **thirteen** native
**1280 × 720 (16:9)** TV screens, each framed in a TV bezel:

1. **Sign In** — the web login card TV-sized: username/password, purple CTA,
   invite-code hint, and the OAuth providers the server can enable (Google,
   Discord, Twitch, Facebook, X).
2. **Who's Watching** — per-user profiles with nebula avatars; new profiles get
   the taste-onboarding flow that seeds recommendations.
3. **Home** — personalized hero (backdrop, match ring, reason line, CTAs) over
   glass rails: *Continue Watching* (landscape cards + resume pills),
   *Recommended For You* (AI-gem cards), *Trending*. One poster per row shows
   the **D-pad focus** state.
4. **Movie detail** — backdrop + poster, synopsis, version chips (4K / Dolby
   Vision), cast row, and the Play / Trailer / My List / Watch Party action bar.
5. **Show detail** — season chips and the episode list with watched state,
   in-progress resume, and the **Catch Me Up** entry point.
6. **Catch Me Up** — the AI episode recap overlay ("Previously, on …"),
   generated locally through Ollama, with the spoiler-safe up-to marker.
7. **Player** — 10-foot transport controls, scrubber, *Up Next* card, and the
   **Smart Skip** pill from intro/credits detection.
8. **Watch Party** — synced playback with live chat ticker, floating reactions,
   WebRTC voice pill, the quick-reply mini dock, and the **QR / code invite**
   (`/v2/join/CODE`) so friends join from their phones.
9. **Semantic search** — describe a vibe in plain English; the "Smart" badge
   appears when the pgvector + local-model path answers (trigram fallback
   otherwise). On-screen keyboard with voice mic key.
10. **Requests** — the Radarr/Sonarr request flow with every status from the
    web app (pending, pending approval, processing + progress, available,
    failed), 4K/1080p flags, and inline admin approve/decline.
11. **My Library** — Collections (stacked-poster cards), My List, and the
    upcoming-episode **Calendar** panel.
12. **Admin** — all 13 web admin tabs; dashboard stat tiles, live transcode
    sessions (NVENC vs Direct Play), the AI flagged-match review queue, and
    the auto-updater (Update Now + timer note).
13. **Settings → Appearance** — Theme, the **NOVA** typeface system, and Glow
    Style — the same controls the web Settings exposes.

## Parity — where each value comes from

| Aspect | Source in the web app | Used here |
|---|---|---|
| Color tokens | `src/index.css` `:root` (L63–116) | `#050505` bg, `#A855F7` primary, `rgba(220,220,232,.65)` secondary, `--glow-halo` / `--glow-border` verbatim |
| Logo mark | `public/favicon.svg` / `auroraMark` | violet→cyan circle (`#A855F7 → #7C3AED → #22D3EE`) + white play triangle |
| Typeface | NOVA = `Sora` + `Inter Tight` | default; Classic / Eclipse / Halo shown in Settings |
| Icons | `src/components/Icon.tsx` | same Feather/Lucide path data, inline |
| Cards & rails | `MediaCardCinema.tsx`, `MediaRail.tsx`, `index.css` `.media-card-cinema` / `.rail-*` | glass rail header, lib badge, AI gem, quality badges, progress bar, shelf meta |
| Hero | `HeroSection.tsx` | match ring, "Because you finished…" reason, CTA stack |
| Nav | `App.tsx` sidebar | same items; becomes a collapsible icon rail that expands on focus |
| Auth | `App.tsx` LoginView + `setupStatus` flags | "Welcome Back" card, invite codes, Google/Discord/Twitch/Facebook/X |
| Profiles | `ProfileSwitcher.tsx`, `NebulaAvatar.tsx`, `TasteOnboarding.tsx` | aurora-orb avatars, onboarding note |
| Episodes | `detail/EpisodeList.tsx` / `EpisodeRow.tsx` | E-number chip, watched label, resume pill |
| Recaps | `detail/RecapModal.tsx` | "Previously, on …", typewriter reveal, up-to chip |
| Smart Skip | `VideoPlayer.tsx` `skipLabel` + `skipmarkers` workers | "Skip Intro" pill (Intro / Recap / Credits) |
| Watch party | `PartyPanel.tsx` (cinematic mode), `CinematicChatTicker`, `ReactionOverlay`, `VoicePill`, `MiniDock`, `PartyInvite.tsx` | chat ticker, floating emoji, voice pill, mini dock, 6-char code + QR |
| Requests | `RequestsView.tsx` `statusColors` | exact status palette + 4K/1080p badges, approval buttons |
| Library | `LibraryView.tsx`, `CollectionsView.tsx`, `CalendarView.tsx` | collections cards, My List, Upcoming calendar |
| Admin | `admin/AdminView.tsx` (13 tabs), `UpdatePanel`, `ManualMatchModal` | tab row, stat tiles, sessions, flagged queue, updater states |

### The TV adaptation (vs. the web app)

- **Hover → focus.** Mouse hover is replaced by a bright `--focus-ring` (white +
  purple bloom) plus a lift/scale, the standard Android TV selection affordance.
- **Sidebar → icon rail.** The 240px web sidebar becomes a 96px icon rail that
  expands to 248px when focused (shown expanded on Home).
- **Modals → overlays sized for 3 m.** Catch Me Up and the party overlay keep
  the web components' anatomy at TV type sizes.
- **Bigger type & spacing** for legibility at ~3 m viewing distance.
- **Landscape, fixed 16:9.** Authored at 1280×720; the page scales each screen
  to fit.
- **Casting** is intentionally absent: a TV app is a cast *target*, not a
  sender.

## Recommended native build target

- **UI:** Jetpack **Compose for TV** (or Leanback) — each screen maps to a
  Compose route, and the tokens above become a Compose `Theme`.
- **Playback:** **Media3 / ExoPlayer** for Aurora's HLS direct-play + transcode
  fallback, subtitles (WebVTT), skip markers, and resume.
- **Party sync:** the web app's WebSocket party protocol + WebRTC voice mesh
  map to a foreground playback session; the QR invite already deep-links
  phones to `/v2/join/CODE`.
- **Fastest-to-parity alternative:** a **TV-WebView** wrapper around the existing
  responsive SPA with D-pad focus handling — it could reuse this exact CSS.

## Viewing

```bash
# from the repo root
xdg-open docs/androidtv-mockup/index.html      # Linux
open docs/androidtv-mockup/index.html          # macOS
```

Fonts load from Google Fonts when online; they fall back gracefully to the
system grotesque/sans stack offline.
