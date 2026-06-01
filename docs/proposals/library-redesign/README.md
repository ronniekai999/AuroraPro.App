# Library redesign — Movies & TV Shows browse pages

Two mockups exploring how the **Movies** and **TV Shows** tabs could look better. Both
keep Aurora's existing chrome (sidebar, top bar, search, the purple "aurora" glow
aesthetic) and pull the exact design tokens from the live app
(`static/redesign/app/src/index.css`): `#050505` background, `#A855F7` purple,
`#facc15` gold ratings, Inter + Space Grotesk, the `--glow-halo` card shadows, the
3px purple active-nav bar, and the indigo resume pill.

They're **self-contained HTML** — open any file directly in a browser. Each has a
**Films / Series** toggle so you can see the design applied to both tabs.

> Poster tiles are art-directed gradient **stand-ins** for the real TMDB poster art the
> app already serves. With real posters dropped in, every layout reads even richer than
> these mockups.

| File | Direction |
|------|-----------|
| ⭐ [`03-hybrid-recommended.html`](03-hybrid-recommended.html) | **Hybrid (recommended)** — hero + chips from #1, density toggle + rich metadata from #2 |
| [`01-cinematic-spotlight.html`](01-cinematic-spotlight.html) | **Cinematic Spotlight** — immersive, lean-back |
| [`02-editorial-mosaic.html`](02-editorial-mosaic.html) | **Editorial Mosaic** — dense, lean-forward |

`01` and `02` are the two original explorations; `03` is the recommended blend of them.

---

## Today (baseline)

The current pages are a clean but flat **6-column poster grid**: a pill badge, an `<h1>`,
a "Showing 100 of 2,423" line, two dropdowns (Genre, Sort), then uniform cards. It works,
but there's no focal point, filtering is hidden behind a `<select>`, and every title gets
equal visual weight regardless of how good it is. Both mockups attack those three things.

---

## Mockup 1 — Cinematic Spotlight

A premium, Apple-TV+/Netflix feel. The page gets a center of gravity and discovery
becomes visual.

**What's new**
- **Full-bleed hero** featuring the #1 title — backdrop, logo-scale title, rating, a
  one-line synopsis, and Play / My List / More Info. Rotator dots imply a featured set.
- **Genre dropdown → scrollable chip rail.** One tap to filter; no menu hunting.
- **Richer poster cards.** On hover the art lifts and a scrim rises with a play button +
  quick-add. Gold rating chip, quality badge (4K/HDR), and a progress bar on in-progress
  titles.
- **A "Continue Watching" rail** reusing the same card, so the browse page also resumes.

**Best for** big-screen / living-room browsing and showing off the catalog.
**Trade-off** the hero eats vertical space before the grid; less raw density per screen.

## Mockup 2 — Editorial Mosaic

A magazine/catalog feel for power-browsing 2,423 movies and 511 shows.

**What's new**
- **Editorial spotlight** for the #1 pick — poster + big rating numeral + synopsis + cast
  + actions, in a compact horizontal card (not a full-bleed hero).
- **"Featured this week"** band of cinematic 16:9 cards for rhythm/variety.
- **Metadata-rich grid** — every card shows rating · year · runtime/seasons · genre, an
  inline rank, and a genre-hue accent. Denser columns = more catalog at a glance.
- **Grid ⇄ List toggle.** List view is a true power-user density mode: rank, thumb,
  title, genre tags, year, rating, quick-add — far more titles per screen.
- **Genre dropdown → underline tabs**; sort stays explicit.

**Best for** large libraries and users who scan, compare, and filter quickly.
**Trade-off** more text-forward / less cinematic than Mockup 1.

---

## Mockup 3 — Hybrid (recommended) ⭐

The blend of the two above — what I'd actually ship. It takes the pieces that tested
strongest in each direction and resolves them into one page:

**From Cinematic Spotlight (#1)**
- **Full-bleed hero** for the #1 title (rotator dots imply a featured set), so the page
  has a center of gravity and discovery is visual.
- **Genre chips** in a scrollable rail — one tap to filter.
- **Continue Watching rail** at the top of the grid view.

**From Editorial Mosaic (#2)**
- **Grid ⇄ List density toggle** right in the toolbar (the list view hides the hero/rail
  and shows rank · thumb · title · genre · length · year · rating — power-browsing mode).
- **Metadata-rich cards** — rating · year · runtime/seasons · genre, an inline rank
  numeral, a genre-hue accent strip, and a 4K/HDR quality badge.

**Unified card** — one design serves both the rail and the grid: #1's hover-play overlay
(big play button + Play/Resume + quick-add) on top of #2's metadata shelf, plus the
progress bar for in-progress titles.

The toolbar packs **Films/Series · genre chips · Grid/List · Sort** into a single sticky
row, so all controls live in one place and the hero gets the space it needs.

**Best for** being the daily driver — cinematic enough for a TV, dense enough to scan a
2,423-movie catalog. **Trade-off** the toolbar is busier than either parent; on very
narrow widths the chips would need to collapse behind a "Genres" button (noted for the
React pass).

---

## How to choose

If you don't want to decide piece-by-piece, **go with `03` (the hybrid)** — it's the
recommended default. If you'd rather lean fully one way, `01` is the most cinematic and
`02` is the most information-dense; tell me which bits you like and I'll adjust the hybrid.

| | Cinematic Spotlight (01) | Editorial Mosaic (02) | Hybrid (03) ⭐ |
|---|---|---|---|
| Vibe | Immersive, lean-back | Editorial, lean-forward | Both — cinematic + scannable |
| Filtering | Genre chips | Underline tabs | Genre chips |
| Density | Medium | High (+ List view) | Toggle: Grid or List |
| Featured title | Full-bleed hero | Compact spotlight + band | Full-bleed hero |
| Metadata per card | Light | Heavy | Heavy |
| Continue Watching | Rail | — | Rail (grid view) |
| Best at | Discovery / TV screens | Scanning a big catalog | Daily driver |

## Next steps

The hybrid (`03`) is ready to wire in. Once you confirm a direction, the React work is
contained:
- `BrowseView` in `static/redesign/app/src/App.tsx` — header/toolbar → chips/tabs, hero
  or spotlight, optional Grid/List state.
- `MediaCardCinema` in `static/redesign/app/src/components/MediaCardCinema.tsx` — the
  richer hover state, quality badge, and metadata row (it's already the single card used
  across rails, grids, library, and search, so one change propagates everywhere).

No backend changes needed — ratings, genres, year, progress, and runtime/season counts
are already in the media payload.
