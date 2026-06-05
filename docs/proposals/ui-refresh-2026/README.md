# Aurora UI refresh — Home · Search · Player

Three mockups, **one per surface**, exploring how Aurora's most-used screens could
get better. Where the earlier proposals each gave *three directions for one page*
([library-redesign](../library-redesign/) — shipped as the Hybrid `BrowseView`;
[details-page-redesign](../details-page-redesign/) — pending your pick), this set
goes wide: it picks the three highest-traffic surfaces that **haven't** had a
redesign yet and levels each one up.

They're **self-contained HTML** — open any `index.html` directly in a browser (or
use the Launch preview panel; configs are in `.claude/launch.json` as
`home-mockup` / `search-mockup` / `player-mockup`). Every file pulls the real
Aurora design tokens straight from the live app
([`static/redesign/app/src/index.css`](../../../static/redesign/app/src/index.css)):
`#050505` background, `#A855F7` purple, `#facc15` gold ratings, Inter + Space
Grotesk, the `--glow-halo` card shadows, the 3px purple active-nav bar, the glass
top bar. Home and Search reuse the **exact** sidebar + top-bar chrome from the
shipped Library mockup, so all three read as the *same app on the same account*
(`rontavious999`, anchored on a *Severance* S2 E4 watch).

> These now use **real poster & backdrop art from TMDB** (the same
> `image.tmdb.org` CDN Aurora serves), so they read as production screens, not
> wireframes. Each image falls back to an art-directed gradient if it can't load,
> so nothing ever shows a broken-image icon.

| Surface | File | One-line idea |
|---|---|---|
| 🏠 **Home** | [`home/index.html`](home/index.html) | *Aurora knows you* — lead with the **why**, not another poster wall |
| 🔍 **Search** | [`search/index.html`](search/index.html) | *Search that understands you* — make **semantic** search a visible moment |
| ▶️ **Player** | [`player/index.html`](player/index.html) | *A calm theater* — ambient controls + the social/smart features done well |

The throughline: today these three screens are competent but **generic** — they
look like every other media server and hide the things that actually make Aurora
Aurora (the AI pick *reasons*, semantic search, watch parties, casting). Each
mockup takes one of those differentiators and makes it the point.

---

## 🏠 Home — "Aurora knows you"

**Today (baseline).** [`HomeView`](../../../static/redesign/app/src/App.tsx) is a
hero (a rotating personalized pick) on top of a flat vertical stack of
`MediaRail`s. It works, but it's Netflix-shaped: the AI *reason* behind the hero
is a faint line, rails are unlabeled walls of posters, and Aurora's social +
stats features are nowhere on the landing page.

**What's new**
- **A "Tonight's Pick" hero that leads with the WHY.** The AI reason is a
  first-class element — *"Because you finished Arcane and lean into slow-burn
  sci-fi"* — paired with a **94% match ring** and a **Resume** button with an
  embedded progress bar. A **"Not tonight ↻"** affordance rotates through other
  fully-reasoned picks.
- **Time-aware greeting band** ("Good evening, Ronnie · Friday night · 3 things
  worth your time") + a "Surprise me".
- **Continue Watching as wide 16:9 cards** with progress bars and
  "S2 E4 · 23 min left" labels — the page's #1 action, right under the hero.
- **Self-explaining rails.** Every rail states *why it's here*; the two AI rails
  carry a ✨ "AI pick" tag and a per-card **"why" phrase on hover**
  ("methodical, atmospheric, cerebral") — the [PR #212](../../../) reveal-on-intent
  pattern. The non-AI rails (9.0+, New this week) correctly have neither.
- **A "Your week" stat strip** (the existing `GamificationCard`, made ambient):
  hours, titles finished, a day-streak, top genre.
- **A "Watch together" card** — "Mia started Blade Runner 2049 · join?" with
  auto-sync — surfacing Aurora's real watch parties on the landing page.

**Best for** making the home page feel personal and intelligent instead of a
catalog dump. **Trade-off** the hero-as-inset-card is less full-bleed-cinematic
than today's edge-to-edge hero, in exchange for the concierge framing.

**Build cost** mostly front-end: rating / progress / genre / quality are already
in the payload, and the hero reason + Discover rails already come from
`/api/me/hero` and the Discover/Anchor rail endpoints. New work = the match
score, the stat strip wiring, and the watch-together presence.

## 🔍 Search — "Search that understands you"

**Today (baseline).** [`SearchView`](../../../static/redesign/app/src/App.tsx) is
a plain `Search Results` `<h1>` over a single flat card grid, with a tiny
"✨ Smart search" badge. Aurora routes queries two ways — fast trigram for exact
titles, an LLM **semantic** path for conceptual queries — but the UI barely shows
it, so the smartest thing the search does is invisible.

**What's new**
- **A live Exact ⇄ ✨ Smart mode indicator** as the centerpiece: a big focal
  field that flips mode as you type (literal title → *Exact*; a natural-language
  query → *Smart*) with a one-line explainer — making the
  [trigram-vs-semantic routing](../../../) legible.
- **A "Best match" spotlight** for the top hit with a tangible **"Why this
  matched"** line ("matched on plot: a thief who steals corporate secrets…").
- **Grouped, ranked results** instead of one grid — **Titles** (each with its own
  italic *"matched on theme/mood: …"* caption), **People**, **Collections**.
- **A faceted filter rail** — Type · Genre · Decade · Quality + "In my library" /
  "Unwatched".
- **A taught empty state** — natural-language suggestion chips that advertise
  semantic search ("movies like Inception", "heist films under 2 hours",
  "something cerebral and slow"), plus recent + trending searches. Keyboard-first
  (↑↓ navigate · ↵ open · esc clear).

**Best for** turning a genuine differentiator into something users can *see* and
learn. **Trade-off** the per-result "why it matched" copy needs the semantic path
to return a short rationale (the model already reasons over plot/theme to rank —
this surfaces it).

## ▶️ Player — "A calm theater"

**Today (baseline).**
[`PlayerControls`](../../../static/redesign/app/src/components/PlayerControls.tsx)
+ [`VideoPlayer`](../../../static/redesign/app/src/components/VideoPlayer.tsx)
work, but the controls, track menus, and party/cast affordances feel utilitarian
and native — not premium, and the recently-shipped smart/social features
(next-episode autoplay, watch parties, casting) aren't given room to shine.

**What's new** — a full-viewport, ambient player (same tokens, no sidebar). Five
**states**, each reached from the control it would really come from:
- **Controls** — auto-hiding chrome over the video, a **rich scrubber** (glowing
  played-track, buffered range, **chapter ticks**, hover **thumbnail preview**),
  a calm three-zone transport, and a "24 min left · ends 9:48 PM · Chapter 4" hint.
- **Up Next** — a glass card that slides in near the end with an **autoplay
  countdown ring** (the [next-episode autoplay](../../../) Aurora just shipped),
  made visible and cancellable.
- **Settings** — a **designed** glass popover (Quality · Audio · Subtitles ·
  Speed) with purple check-states, not a native `<select>`.
- **Party** — host-badged avatar stack + a green **"Synced"** pill + a cinematic
  translucent **chat ticker** + floating emoji reactions + a slim chat input
  (the [watch-party chat](../watch-party-chat/) concept, in-player).
- **Casting** — what the player looks like mid-cast: a "Playing on Living Room
  TV" card + a persistent **minimized cast widget** (the
  [cast-widget-persist](../../../) behavior).

**Best for** making *watching* — the thing users spend the most time doing — feel
like a premium product, and giving the social/smart features a home. **Trade-off**
it's the most feature-dense of the three; a real build would ship the ambient
controls + scrubber first, then layer the states.

---

## How to view

```
# from the repo root — or use the Launch panel (home-mockup / search-mockup / player-mockup)
open docs/proposals/ui-refresh-2026/home/index.html
open docs/proposals/ui-refresh-2026/search/index.html
open docs/proposals/ui-refresh-2026/player/index.html
```

Each is interactive: the Home hero shuffles reasoned picks ("Not tonight ↻");
Search flips Exact/Smart as you type, the ✕ clears to the idle/suggestions state,
and clicking a suggestion runs it; the Player's states fire from their real
controls — the gear opens Settings, the cast icon shows the casting view, the
watch-party icon brings up the chat overlay, and Next surfaces the Up-Next card
(move the mouse to reveal the auto-hiding controls).

## Notes
- Posters & backdrops are **real TMDB art** loaded from `image.tmdb.org` (needs an
  internet connection to view; Google Fonts is the only other remote request).
  Every image degrades to an art-directed gradient on failure, so the layouts
  still hold offline.
- Sample metadata (Level 7, "94% match", "2,934 titles", chapter names, the
  Commentary track) illustrates fields the layouts support; some aren't in the
  current API response yet.
- Home and Search lift the sidebar + top-bar chrome verbatim from
  [`library-redesign/03-hybrid-recommended.html`](../library-redesign/03-hybrid-recommended.html)
  so the set is visually consistent with what already shipped.
