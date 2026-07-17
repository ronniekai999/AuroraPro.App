# Aurea cinema elements — implementation plan

Status: proposal / ready to build · Date: 2026-07-16
Mockup: [`mockup-home-aurea-elements.html`](./mockup-home-aurea-elements.html) · Element analysis: [`README.md`](./README.md)

Scope: the **11 adopted elements** (+ film grain) from the mockup, phased into
three independent PRs that each run the full
[dev-workflow pipeline](../../dev-workflow.md) (research → implement+tests →
adversarial review → merge gate). Each PR is useful alone and cheap to revert —
the Catalogue Edition overhaul (#363–#366) taught us not to ship look-and-feel
as one mega-change.

---

## Decisions to lock before building (proposed defaults)

| # | Decision | Proposed | Why |
|---|---|---|---|
| 1 | Serif display rollout — **LOCKED 2026-07-16 (Phase A shipped): opt-in** | **Opt-in**: ships as a fifth Typeface system ("VELVET") in Settings → Appearance; NOVA stays default | Flipping the default font under existing users is exactly the kind of jarring change that got Catalogue Edition reverted. The mockup's serif look = VELVET selected. Revisit the default after feedback. |
| 2 | Genre pills v1 behavior | **Navigate**: pill click routes to the Movies/Shows browse grid with `?genre=` preapplied | The server-side filter already exists (`GET /api/media?genre=…`); filtering the *home rails* in place would gut curated rails and needs new recommender plumbing. In-place filtering can be a v2. |
| 3 | Top 10 metric | Distinct **profiles with watch activity per title, trailing 7 days** (fallback: progress-row count when the server has 1 profile); rail hides below 4 qualifying titles | "Plays" is ambiguous for partial watches; distinct-viewers matches "most watched" language and stays meaningful solo. Hide-when-thin = the earn-your-slot rule. |
| 4 | Film grain default — **LOCKED 2026-07-16 (Phase A shipped): off** | **Off**; toggle in Settings → Appearance; force-off under `data-glow="subtle"` and `prefers-reduced-motion` | Same GPU budget rules as the existing overlay blur (see the Bug 25 note in `index.css`). |
| 5 | "% for you" on card hover | Only when the item's payload carries a recommender score; otherwise the hover shows Play alone | No fake numbers. Requires threading `score` into discover/anchor rail items (backend, Phase C). |
| 6 | Premiere "request arrived" audience | Show to **all users**, neutral copy ("Requested 3 days ago"); requester attribution is a possible later enhancement | Deployment-neutral per the 2026-07-16 review pass. |

---

## What already exists (verified against the code)

**Frontend plumbing we reuse as-is**
- **Typeface/glow token system** — `appearance.ts:101-109` writes `data-font` / `data-glow` on `<html>`; `index.css` `:root` tokens + per-system override blocks (`index.css:62-159`). Seven self-hosted variable `.woff2` faces already follow this pattern (`src/fonts/`).
- **Genre data** — `listGenres()` → `GET /api/media/genres` (`api.ts:575-584`, built for the BrowseView dropdown) and server-side `?genre=` filtering on both list endpoints (`api.ts:522-562`).
- **My Library state** — App already holds `libraryIds: Set<number>` for the card badges; the sidebar count badge is `libraryIds.size`. Zero backend.
- **Continue Watching math** — `formatRemaining()` (`App.tsx:212`) already renders "23m left"; the CW rail already threads per-card subtitles + `resolveResume` with the click-time re-lookup guard (`App.tsx:1041-1058`, deep-debug H3).
- **Recent additions** — `GET /api/media/recent?per_page=` (`api.ts:909`).
- **Requests lifecycle** — status enum `pending → pending_approval → processing → available | failed` (`models.go:885`), the `RequestAvailable = "available"` constant (`models.go:870`), and a **`request_available` notification type** (`models.go:905,920`). The realtime socket already delivers `request_status` and `notification` events (`useRealtime.ts:95-110`).
- **Quality/maturity chips** — `mapMedia` already assembles `tags: ["4K","TV-MA"]` from `has_4k` + `content_rating` (`api.ts`); `MediaCardCinema` renders them under `showBadges`.
- **Tagline in the DB** — `media_items.tagline` since migration 003; exposed on detail (`models.go:594`) but **not** in the hero payload yet.

**Things that do NOT exist yet (built in Phase C)**
- Any most-watched/top-N aggregation (`internal/recap` is episode synopses, not counts).
- `tagline` / `season_count` / per-item `score` in the hero + rail payloads.
- A "spotlight" selector for the premiere card.

**A deliberate design reversal to be honest about:** `MediaRail` removed the
hover-Play CTA when the cinema card shipped ("click card → detail → act", see
`MediaRail.tsx:11-16` and the Bug C note in `HomeViewProps`). Element 8
reintroduces hover-Play on purpose. The plan reuses the existing
resume-interceptor pattern rather than inventing a new play path.

---

## Phase A — "Cinema dress" (presentation only, no backend) — ~1 PR

1. **VELVET typeface system** (element 1)
   - Add `src/fonts/fraunces.woff2` (variable, latin subset, same self-hosting
     rationale as the existing seven faces — no CDN).
   - `index.css`: `@font-face` + `html[data-font="velvet"]` block setting
     `--font-display: 'Fraunces', …` (body stays Inter Tight) **plus**
     `--font-display-style: italic` — a new token consumed by `.font-display`
     headline sites so serif italic only applies under VELVET.
   - `appearance.ts` + SettingsView Typeface picker: add the option card.
2. **Eyebrow kickers** (2) — one `.eyebrow` utility class; add above the hero
   ("TONIGHT'S PICK") in `HeroSection.tsx` and as an optional `eyebrow` prop on
   `MediaRail`'s header (used by the Top 10 rail in Phase C).
3. **Hero meta chips** (3) — `HeroSection` renders `hero.tags` as
   certification/format chips next to the existing genre•year line. Data
   already flows via `mapMedia`; chips render only when tags exist.
4. **Ken Burns + staggered rise** (5) — CSS keyframes; ken burns on the hero
   `<img>` wrapper *under* the existing parallax transform (separate element so
   the two transforms compose); `.rise` stagger on hero copy. Both inside
   `@media (prefers-reduced-motion: reduce)` guards.
5. **Edge-fade mask** (9) — `.mask-x` utility on `.rail-scroll`; verify the
   chevron paddles still hit-test (they sit outside the masked element).
6. **Film grain** (global) — `html[data-grain="film"] body::before` fixed
   noise layer (inline SVG turbulence data-URI, 4% opacity, `steps(6)` drift);
   Appearance toggle writing `data-grain`; hard-off under `data-glow="subtle"`
   and reduced-motion. Default off (decision 4).
7. **Scrollbar + selection tint** (global) — violet `::selection` /
   `::-webkit-scrollbar-thumb`, matching the mockup.

*Tests:* vitest for the appearance mapping (new ids round-trip
localStorage → `data-*` attributes); visual pass via the mockup as reference.
*Out:* hero tagline (needs the Phase C payload field).

## Phase B — Cards, rails & sidebar interaction — ~1 PR

1. **Hover quick actions** (8) — in `MediaCardCinema`: a bottom scrim row with
   one-tap **Play** (and "% for you" once Phase C lands the score field —
   gated, decision 5). Wiring:
   - Thread `onPlay` through `MediaRail` → card (the prop already exists but is
     ignored — `MediaRail.tsx:11-16`).
   - For CW cards the play action goes through the existing `onResume`
     resolver (click-time re-lookup, `App.tsx:1041-1058`) — do **not** add a
     second resume path.
   - The scrim shares space with the existing AI-reason reveal (reason above,
     actions below — as mocked). No add-to-library button here (the persistent
     `lib-badge` stays the single add control — README "Removed after review").
   - Keyboard: the play control is a real focusable button inside the card;
     card-level `:focus-within` reveals the scrim (pattern already used by the
     reason scrim).
2. **Continue Watching upgrades** (10) — `MediaCardCinema` landscape variant:
   episode chip (renders the existing `subtitle` string, e.g. "S2E4 · 23m
   left", as a top-left chip), center play-on-hover chip (calls `onResume`),
   and move the progress bar into the shelf as the violet→cyan gradient with
   `%` + time-left readout (both derivable from the CW record the caller
   already holds).
3. **Sidebar touches** (11, minus premiere card) — group `navItems` under
   Browse / Library / Manage section labels, active left-notch indicator,
   My Library count badge from `libraryIds.size` (`Sidebar` in
   `App.tsx:604-721`). Admin item stays gated on role.
4. **Genre pill row** (6) — pills from `listGenres()` (cached at App level);
   click navigates to the browse view with the genre preapplied (decision 2 —
   the `onNavigate(view, opts)` plumbing that "See All" uses already exists,
   `App.tsx:757-761`; extend `opts` with `genre`).

*Tests:* vitest — pill → navigate wiring; CW subtitle → chip/progress
rendering; hover-play resume interceptor uses click-time lookup (regression
test mirroring deep-debug H3). `npm run build` + `npm test` green.

## Phase C — Backend-backed features — ~1 PR (Go + frontend)

1. **Top 10 rail** (7)
   - **Query**: aggregate `watch_progress` over a trailing 7-day window —
     distinct profiles per title (fallback to row counts single-profile,
     decision 3) — top 10, deduped on `tmdb_id` like the recommender queries.
   - **Endpoint**: `GET /api/media/top?window=7d&limit=10` (handler in
     `internal/api/media_handlers.go` + query in `internal/db`), or fold into
     the home-rails payload as a server-built rail — pick whichever matches
     how `HomeView` already receives rails; the endpoint is more reusable.
   - **Frontend**: new `TopTenRail` presentation inside the standard
     `.rail-container` (outlined `-webkit-text-stroke` numerals per the
     mockup); rail hides below 4 qualifying titles.
   - *Go tests*: aggregation window/dedup/threshold; empty-library returns [].
2. **Premiere spotlight card** (11) — `PremiereCard.tsx`, self-fetching (the
   `GamificationCard` pattern), rendered by `Sidebar`:
   - **State priority**: (a) newest request with `status == "available"`
     within N days → *request arrived* (teal); else (b) newest item from
     `/api/media/recent` within N days → *added* (violet); else (c) render
     nothing.
   - **Refresh**: on the existing realtime `request_status` + `notification`
     (`request_available`) events (`useRealtime.ts:95-110`); plus refetch on
     mount. No polling.
   - **Dismiss**: × stores the dismissed media/request id in localStorage;
     selector skips dismissed ids so the card only returns for something new.
   - **Click**: routes to the title's DetailView.
   - *Tests*: vitest for the selector priority + dismiss logic (pure function
     over the two lists).
3. **Payload additions** — add `tagline`, `season_count`, and per-item
   `score` where the recommender already computes similarity (hero pick +
   discover/anchor items). Then: hero renders the serif tagline quote (4) and
   "2 Seasons" meta; card hover renders "% for you" (unblocks decision 5).
   - *Go tests*: fields present/omitted correctly; no N+1 (tagline +
     season_count join once in the existing list queries).

## Explicitly not in scope

- In-place genre filtering of home rails (v2 of decision 2).
- Requester attribution on the premiere card (decision 6).
- The rank tag and duplicate hover add-button — removed after review; see
  README for the re-entry condition (≥2 weekly viewers) if ever revisited.
- DetailView episode-row polish ("Watching" chip) — separate proposal.

## Rollout & verification

- Each phase merges via the standard pipeline, then deploys through
  `scripts/server-test-loop.sh --trigger-update` against the live instance
  (see `docs/server-testing.md`); Phase C adds its endpoint to the API smoke
  test (`scripts/aurora_smoke_test.sh`).
- Perf guardrails: no new per-card `backdrop-filter` layers (Bug 25 rule);
  grain is a single fixed layer, off by default; ken burns is one composited
  transform on an element that already animates.
- A11y: every new control focusable with a visible ring; scrim reveals on
  `:focus-within`; reduced-motion kills grain/ken-burns/rise; chips keep
  AA contrast against scrims (reuse the `--text-secondary` rationale).
