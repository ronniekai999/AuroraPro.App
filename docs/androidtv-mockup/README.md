# Aurora Pro — Android TV UI mockup

A high-fidelity, **design-parity** mockup of a native Android TV app for Aurora
Pro. Open [`index.html`](./index.html) in any browser — no build step, no
dependencies.

> The goal: *"we can make the app look like that."* Every value here is lifted
> straight from the live web SPA (`static/redesign/app`), then re-laid-out for
> the 10-foot / D-pad living-room experience.

## What's in it

A single self-contained `index.html` renders five native **1280 × 720 (16:9)**
TV screens, each framed in a TV bezel:

1. **Home** — personalized hero (backdrop, match ring, reason line, CTAs) over
   glass rails: *Continue Watching* (landscape cards + resume pills),
   *Recommended For You* (AI-gem cards), *Trending*. One poster per row shows the
   **D-pad focus** state.
2. **Title detail** — backdrop + poster, synopsis, version chips (4K / Dolby
   Vision), cast row, and the Play / Trailer / My List action bar.
3. **Player** — 10-foot transport controls, scrubber, and an *Up Next* card over
   the video surface.
4. **Search** — on-screen keyboard for D-pad input (incl. voice mic key) with a
   live result grid.
5. **Settings → Appearance** — Theme, the **NOVA** typeface system, and Glow
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

### The TV adaptation (vs. the web app)

- **Hover → focus.** Mouse hover is replaced by a bright `--focus-ring` (white +
  purple bloom) plus a lift/scale, the standard Android TV selection affordance.
- **Sidebar → icon rail.** The 240px web sidebar becomes a 96px icon rail that
  expands to 248px when focused (shown expanded on Home).
- **Bigger type & spacing** for legibility at ~3 m viewing distance.
- **Landscape, fixed 16:9.** Authored at 1280×720; the page scales each screen
  to fit.

## Recommended native build target

- **UI:** Jetpack **Compose for TV** (or Leanback) — each screen maps to a
  Compose route, and the tokens above become a Compose `Theme`.
- **Playback:** **Media3 / ExoPlayer** for Aurora's HLS direct-play + transcode
  fallback, subtitles (WebVTT), and resume.
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
