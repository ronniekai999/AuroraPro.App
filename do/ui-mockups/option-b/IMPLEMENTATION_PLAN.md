# Option B "Aurora Stage" — UI migration plan

_Companion to [`index.html`](index.html) (13 screens, 1440×900, zero production code
touched). This plan turns that mockup into the shipped SPA at
`static/redesign/app/`._

Read with [`docs/dev-workflow.md`](../../../docs/dev-workflow.md): every phase below is
one branch off `main` → implement + tests → build/test gate → adversarial review →
squash-merge → delete branch.

---

## 1. What Option B actually changes

The mockup's own framing is right: **same features, same tokens, same components —
different chrome and art direction.** Concretely there are only six structural moves,
and every screen is a consequence of them:

| # | Move | Today | Option B |
|---|------|-------|----------|
| **M1** | **Nav** | 240px fixed `<aside>` sidebar (`App.tsx:636`), 8 nav items + Server Status / Notifications / Settings / user in the footer | 64px slim top bar; the same 8 tabs centered; search pill + party + server dot + bell + avatar on the right; Server Status / Notifications / Settings / Sign Out move **into the avatar dropdown** |
| **M2** | **Page shell** | `<main className="md:ml-[240px]">` (`App.tsx:4451`) wrapping `<div className="p-8">` (`App.tsx:4535`); `DetailView` escapes it with `-mx-8 -mt-8` (`DetailView.tsx:330`) | No left offset, no global padding. Pages are full-bleed; each view owns its own 48px gutter. The `-mx-8` bleed hack disappears |
| **M3** | **Backdrop tint** | Static `.aurora-bg` wash | Per-page `.tint` layer — 2–3 radial gradients keyed to the current backdrop, so each page is "a stage lit for its content" |
| **M4** | **Heroes** | Inset rounded card: `h-[60vh] … rounded-2xl border` (`HeroSection.tsx:129`) | Edge-to-edge, no radius, no border. Home 560px, Detail 522px, Browse 250px strip. Display title jumps to 84px (home) / 64px (detail) / 52px (browse) |
| **M5** | **Cards** | Poster + a **text shelf below** it (`MediaCardCinema.tsx:369`, `index.css:964`) | Metadata **on the art**: overlay title/meta, quality chips, circular library badge, AI gem, progress bar, plus a faint uppercase poster watermark. Rail posters 180px → **206px**; landscape 320px → 336px |
| **M6** | **Type** | Default "Nova" = Sora display + Inter Tight body (`index.css` `:root`) | Bricolage Grotesque display + Inter body — **which is exactly the existing `data-font="eclipse"` system** (`index.css:151`). No new fonts to add; the woff2 is already self-hosted at `src/fonts/bricolage-grotesque.woff2` |

**Everything else in the mockup is these six moves re-applied per screen.** That is the
key scoping insight: this is not 13 rewrites, it's 6 changes plus a per-screen pass.

### What does NOT change

No backend work. No API changes. No new data. The mockup is explicit about feature
parity, and it holds up against the code:

- All 8 nav tabs exist already (`App.tsx:624`) — same ids, same order, same admin gate.
- Hero reason / match ring / "Not tonight" / conversational search / greeting band /
  gamification band / watch-together card are all live (`HeroSection.tsx`,
  `GamificationCard.tsx`, `convo-search` in `index.css:234`).
- Quality + maturity badges already ship from `mapMedia()` in `lib/api.ts`.
- ⌘K palette (`SearchPalette.tsx`), context menu (`ContextMenu.tsx`), scan bar
  (`ScanProgressBar.tsx`), bug-report FAB (`BugReportButton.tsx`), drawers, taste
  onboarding, nebula orbs, all 13 admin tabs, all four typeface systems + three glow
  systems — present.

So the whole plan is **frontend-only**, inside `static/redesign/app/src/`.

---

## 2. Decisions — RESOLVED 2026-07-25

| # | Question | Decision |
|---|----------|----------|
| **D1** | **Screen 07 shows the player as a *windowed theater*** — rounded 20px inset with the dimmed app behind it (`.theater`, `.dim-app`, `.dim-veil`). Today `VideoPlayer` is `fixed inset-0 z-[60] bg-black` (`VideoPlayer.tsx:3200`) | ✅ **Real feature.** Windowed theater mode is in scope — a genuine playback-surface change, not a re-skin. Scoped out of the styling PR into its own branch; see Phase 7b |
| **D2** | **Screen 11 shows My Library + Collections + Calendar as a 3-pane grid** (`.tri`). Merge into one page, or three routed views? | ✅ **Keep three separate routed pages**, unchanged nav — but adopt the mockup's pane UI on each (`.saved-grid`, `.col-card`, `.cal-month`, the `.lm-seg` List⇄Month segment). Styling adopted in full; routing untouched |
| **D3** | **Make Bricolage the default typeface for everyone?** | ✅ **Yes.** `:root` default flipped to the Eclipse pairing; all four systems stay selectable. Shipped in Phase 0 |
| **D4** | **Land phases straight on `main`, or stage on an integration branch?** | ✅ **Straight on `main`**, in order. Phases 1+2 still ship as one PR (see below) |
| **D5** | **How do the theater inset and today's modes fit together?** `VideoPlayer` already calls its non-fullscreen state "windowed" — a card capped at `94vw/88vh` inside a `fixed inset-0 bg-black` surface (`VideoPlayer.tsx:3216`) — plus a third `minimized` state for casting | ✅ **The theater inset REPLACES the black backdrop.** Two user-facing modes: theater ⇄ fullscreen. No new toggle, no 3-way cycle. The existing capped card becomes redundant (the theater box *is* the card), and the word "windowed" is retired from the code in favour of "theater" so it stops meaning two things |
| **D6** | **Is the app behind the theater interactive?** | ✅ **Inert — atmosphere only.** Dimmed, `pointer-events: none`, scroll locked, `aria-hidden`. Focus stays trapped in the theater; Esc closes. Browsing while watching is a bigger feature and is explicitly *not* this phase |
| **D7** | **When does the `/profiles` "Who's watching?" gate appear?** | ✅ **First visit per device, then remembered.** A per-device flag in `aurora_prefs`; reachable any time from the switcher. **Skipped entirely when only one profile exists** — nothing to choose, so a solo server is never nagged |
| **D8** | **How far does the player restyle go, given the mockup's affordances all have real data behind them?** | ✅ **Restyle + surface the wired features + the scrub hover timestamp.** Skip markers, the credits-triggered next-episode advance and Cast/AirPlay are all already implemented; the mockup's `.skip-pill` / `.upnext` / `.cast-pill` give them the chrome they were missing. The hover readout is a time label computed from pointer position — no thumbnail sprites, no new assets, no new backend |

### D1 follow-through — windowed theater is real scope

Treating it as a feature rather than a restyle changes Phase 7. What the mockup implies:

- A **mode toggle** with persistence (`aurora_prefs`, alongside the existing quality /
  typeface / glow prefs) — fullscreen ⇄ windowed, plus the native-fullscreen path.
- **The app stays mounted and visible behind the player** (`.dim-app` at
  `opacity: 0.5; filter: saturate(0.7)`, `.dim-veil` blur on top). Today the player is an
  opaque `fixed inset-0 bg-black` overlay; the tree behind it keeps rendering but is
  never seen. Windowed mode makes what's behind it *visible*, which means the page
  underneath now has to look right while video plays — scroll lock, the TopNav's z-order,
  and paused-background cost all become real considerations.
- **Per-frame cost**: `.dim-veil` is `backdrop-filter: blur(6px)` over a compositing
  layer that contains playing video. That is exactly the blur budget flagged in
  deep-debug Bug 25 and mitigated by `html[data-glow="subtle"] .aurora-glass-overlay`.
  The veil must respect the same escape hatch — Phase 0 already extends that pattern to
  the Stage primitives.
- Keyboard/focus: Esc, click-outside, and focus trapping all differ between a windowed
  panel and a fullscreen surface.

So Phase 7 splits: **7a** restyles the existing controls (low risk, ships with admin /
settings / auth), **7b** adds windowed mode as its own PR with its own review. Sequencing
it last also means the Stage chrome it composites over is already final.

---

## 3. Phase plan

Seven phases. Ordering is by blast radius and by dependency, not by screen number.

### Phase 0 — Design tokens + type scale (no layout change) ✅ SHIPPED

**Branch** `feat/stage-tokens`

> **Landed 2026-07-25.** `index.css` carries the token block, the `.stage-*` primitives
> and the `.type-*` scale utilities; the typeface default is flipped; a new
> `lib/appearance.test.ts` (13 tests) pins the flip's non-destructive invariant. All
> new classes are `stage-`/`type-` prefixed — the mockup's bare `.pill` / `.btn-primary`
> / `.qb` names would be indistinguishable from pre-migration chrome in the DOM across a
> nine-phase migration, and `--primary` / `--cyan` are already taken by the
> shadcn/Tailwind HSL triplets (redefining them to hex would break every Tailwind color
> utility). Details in §3.0 below.

- `index.css` — add the Option B token set alongside the existing ones. The mockup's
  `:root` is already 95% identical to ours (`#050505`, `#A855F7`, `#22D3EE`,
  `--glass`, `--glow-border`, `--halo`, `--card-bg`); the genuinely new ones are:
  - `--topnav-h: 64px` — **do this first.** The mockup hard-codes `top:64px` on the
    browse toolbar (`.toolbar`) and admin tabs (`.admin-tabs`). Those must read a token
    or every sticky offset silently breaks the next time nav height changes.
  - display type scale: `--fs-hero: 84px`, `--fs-detail: 64px`, `--fs-browse: 52px`,
    `--fs-page: 38px`, `--fs-rail: 21px`.
  - `.tint` / page-wash gradient recipes.
- New shared primitives, ported from the mockup CSS 1:1 so later phases just consume
  them: `.glass-badge`, `.qb` quality badges (`.k4` / `.hdr` / `.hd`), `.pill` / `.pill.on`,
  `.btn-primary` / `.btn-white` / `.btn-ghost` / `.btn-quiet`.
- **D3**: flip `:root` `--font-sans` → `'Inter'`, `--font-display` →
  `'Bricolage Grotesque'`; keep `html[data-font="…"]` blocks intact.

**Why first:** it is the only phase with zero layout risk, and every later phase depends
on the tokens. **Test:** all four typeface systems × three glow systems render — Bricolage
has different vertical metrics than Sora, so the 84px hero must be checked in each.

#### 3.0 What actually landed

| File | Change |
|---|---|
| `index.css` | `--topnav-h` / `--page-gutter`; `--fs-hero` … `--fs-rail` scale; `--card-bg`; `--stage-*` palette; `--tint-1/2/3`. `.type-*` utilities bake in line-height + tracking (browser default leading is unusable at 84px). `.page-tint` + `.stage-stars` washes. `.stage-btn` (+`-primary`/`-white`/`-ghost`/`-quiet`), `.stage-pill`, `.stage-badge`, `.stage-qb` (+`-4k`/`-hdr`/`-hd`) with focus-visible rings, `prefers-reduced-motion`, and the `data-glow="subtle"` blur opt-out |
| `index.css` | `:root` = Eclipse; **new** `html[data-font="nova"]` block holding the exact values `:root` had before; `html[data-font="eclipse"]` kept deliberately redundant so a stale attribute still resolves correctly |
| `lib/appearance.ts` | `currentFont()` default → `'eclipse'`; `applyFont()` removes the attribute for `'eclipse'`; `FONT_OPTIONS` reordered, Eclipse labelled `Editorial · default` |
| `main.tsx` | pre-paint shim allowlist `'current'｜'eclipse'｜'halo'` → `'current'｜'nova'｜'halo'` |
| `SettingsView.tsx` | inline radiogroup list, `'eclipse'` fallback, remove-attribute branch |
| `lib/appearance.test.ts` | **new**, 13 tests |

**The one non-obvious risk, and how it's handled.** Making Eclipse attribute-less means
Nova had to become *attributed*. That's only non-destructive because `applyFont()`
persists `aurora_prefs.font_choice` **even for the attribute-less default** — so
"explicitly chose Nova" is distinguishable from "never chose", and only the latter picks
up Bricolage. `appearance.test.ts` pins exactly that (`persists eclipse even though it
writes no attribute`, `keeps Nova for a user who explicitly chose it before the flip`),
because the natural "cleanup" of skipping the write for the default would silently
re-typeface every Nova user.

**Three files encode the default** — `lib/appearance.ts`, the `main.tsx` pre-paint shim,
and `SettingsView`'s inline radiogroup (which duplicates rather than imports the helper).
All three are updated and cross-referenced in comments. Consolidating them onto
`FONT_OPTIONS` / `applyFont` is Phase 7a work, when that settings card gets its two-column
treatment.

**Gate:** `npm run build` clean · `npm test` 34/34 · `go build ./...` + `go test ./...`
green · `npm run lint` unchanged from baseline (7 pre-existing errors, all in
`hooks/useCompanion.ts` + `hooks/useRealtime.ts`, neither touched here).

---

### Phase 1+2 — TopNav replaces Sidebar, and the shell goes full-bleed ✅ SHIPPED

**Branch** `feat/stage-chrome` — **these ship as one PR.** Removing `md:ml-[240px]`
(M1) and removing the global `p-8` (M2) are the same change to the same 6 lines of
`App.tsx`'s render root; splitting them leaves `main` with a top nav over 240px-indented
content.

> **Landed 2026-07-25.** `App.tsx` is 235 lines lighter (`Sidebar` and `UserMenu`
> deleted); `components/TopNav.tsx` is new, with `TopNav.test.ts` pinning the eight
> destinations and the admin gate. Notes on what the mockup didn't answer:
>
> - **The green "OK" health pill is deliberately not built.** Nothing in the app can
>   source it — `ServerPanel` fetches `/api/admin/dashboard` itself and only while open,
>   and there is no `/api/health` helper. Rather than render a fabricated all-clear, the
>   trigger is neutral. Wiring a real signal is the one backend-touching item this
>   migration surfaced; it belongs with Phase 7a or its own small PR.
> - **The server trigger is now admin-only**, matching the panel it opens. Pre-Stage the
>   sidebar offered it to everyone and non-admins got "Server status is admin-only" — a
>   dead affordance.
> - **`MobileSheet` is a sibling of `<nav>`, not a child.** `.stage-topnav` sets
>   `backdrop-filter`, which makes the bar a containing block for fixed descendants, so a
>   nested sheet resolves against the 64px bar instead of the viewport — and only when
>   glow ≠ "subtle", since that mode drops the blur. A bug that appears on one appearance
>   setting and not another is the worst kind to debug later.
> - **The drawers sit at z-45, deliberately below the nav stack (50).** That preserves
>   QA BUG-005's actual intent: the panel must never bury the controls that opened it.

**New file** `src/components/TopNav.tsx` — brand → home, centered tabs (with the `admin`
pill), search pill with `⌘K` kbd, party button + live dot, server-status dot, bell +
count, avatar + dropdown. Extract to its own file; do **not** grow `App.tsx` (5,303
lines already).

**`App.tsx` edits:**

- Delete `Sidebar` (`604–721`) and its render site (`4373–4384`).
- Delete the mobile drawer backdrop + hamburger (`4386–4415`) — superseded by the
  responsive nav below.
- `4451`: `<main className="md:ml-[240px]">` → `<main>`.
- `4455`: sticky stack keeps `ScanProgressBar` but the bar now sits **above** the nav
  (mockup: 3px, z-65, `.scanbar`) instead of above a separate header.
- `4460–4527`: the old `<header>` (search input + party + ProfileSwitcher + UserMenu) is
  absorbed into `TopNav`.
- `4535`: delete `<div className="p-8">`. Each view gains its own gutter.
- **Re-anchor the drawers.** `ServerPanel` and `NotificationPanel` currently position
  themselves relative to their sidebar-footer triggers — see the explicit comments at
  `App.tsx:1367`, `1483`, `3280`. They must re-anchor under the avatar (mockup:
  `.tn-drop` at `top:54px; right:30px`, drawers below it). This is the single easiest
  thing to miss in this phase.
- **Avatar dropdown** gains Server Status (with `OK` state) and Notifications (with
  count badge) next to the existing Profile / Settings / Sign Out from `UserMenu`.

**`DetailView.tsx:330`**: drop `-mx-8 -mt-8` (nothing left to escape).

**Responsive — must ship in this PR, not after.** Losing the sidebar removes the only
navigation below 768px, and the mobile drawer was itself a filed bug fix (QA BUG-012).
Plan: tabs collapse to a horizontally-scrollable strip at `md`, and below `sm` the tab
row becomes a sheet behind a menu button. Eight tabs at 13.5px also collide with
`.tn-right` around 1280px — overflow the tail into a "More" menu at `lg`.

**Z-index audit:** mockup nav is z-60; `VideoPlayer` is `fixed inset-0 z-[60]`
(`VideoPlayer.tsx:3200`) and other overlays sit at z-40/45/55/60. Give the nav z-50 and
verify the player, party panel, palette, and modals all still cover it.

---

### Phase 3 — Cards: metadata onto the art

**Branch** `feat/stage-cards`

Single component, six call sites, highest regression risk in the whole migration.

- `MediaCardCinema.tsx` — replace `.shelf` (`369`) with the mockup's `.ovl` overlay:
  bottom scrim, title, meta row, `.quals` chips above it, `.lib-badge` circle top-left,
  `.ai-gem` top-right, `.card-prog` bottom, `.pt` uppercase watermark top.
- `index.css:756–1075` — the `.media-card-cinema` block. Rewrite carefully: it carries
  annotated fixes that must survive.
  - `index.css:88` — `--text-secondary` exists specifically because the card meta must
    clear WCAG AA 4.5:1. Meta now sits over artwork, so **the scrim has to guarantee
    that contrast**, not just look nice. Do not regress to `text-white/40`.
  - `index.css:787` — poster-wrap corner rounding, fixed for the landscape aspect
    (deep-debug Bug 22).
  - `index.css:898` — the `.reason` caption + native `title=` tooltip pair.
  - the badge blur-budget note (deep-debug Bug 25) and the
    `html[data-glow="subtle"] .aurora-glass-overlay` escape hatch.
- `MediaRail.tsx:164` — `w-[180px]` → `w-[206px]`, `w-[320px]` → `w-[336px]`; rail gap
  to 18px.
- Grids: `grid-cols-2 sm:3 md:4 lg:5 xl:6 gap-5` → `gap-5`/6-col target per the mockup's
  `.mgrid`. Four call sites: `BrowseView.tsx:359`, `LibraryView.tsx:102,123`,
  `SearchView.tsx:111`, `CollectionsView.tsx:217`.
- `MediaListRow.tsx` (density = List) is unchanged.

**Accessibility:** the title moves from a text shelf onto art. Every card needs an
accessible name that doesn't depend on the overlay, and the overlay text needs a
text-shadow/scrim floor. Worth a `MediaCardCinema` render test given `npm test` is
currently one file (`lib/prewarm.test.ts`).

---

### Phase 4 — Home + Browse

**Branch** `feat/stage-home-browse`

- `HeroSection.tsx:129` — inset rounded hero → full-bleed 560px, no border/radius;
  84px Bricolage title; `.hero-scrim` two-layer gradient; match ring moves to
  `top:44px right:52px`; `.pick-pill` + italic `.hero-reason` above the title.
  `HeroSection` is shared with `BrowseView`, so add a variant prop rather than forking:
  Browse gets the 250px `.browse-hero` strip (eyebrow + 52px title + count).
- Greeting band → `.greet` (34px display + pills, right-aligned).
- Conversational search → `.conv-search`, overlapping the hero by −26px.
- `.week-band` (gamification) and `.together` (watch-party) bands adopt the mockup's
  glass treatment; both already have data.
- `BrowseView.tsx` — sticky `.toolbar` at `top: var(--topnav-h)`: genre chips + density
  segment + sort select; `.load-btn` pill for Load More. Genre chips / density toggle /
  sort already exist from the shipped library-hybrid work; this is styling only.

---

### Phase 5 — Detail (movie + show)

**Branch** `feat/stage-detail`

- `detail/DetailHero.tsx` — 522px full-bleed backdrop, glass kind/rating badges, 64px
  title, meta row with italic tagline, floating `.back-btn`.
- `detail/DetailRail.tsx` — poster with inline progress strip (`%` / bar / "59m left"),
  stacked actions, the 3-up `.d-tile` grid (Library / List / Party), and "Play in"
  version chips.
- `detail/DetailTabs.tsx` — underline gradient tab style.
- `detail/MediaInfoPanel.tsx` / `CastGrid.tsx` — `.gcard` glass cards for Details /
  Audio Tracks / Subtitles; lang chips, Default / Forced badges.
- `detail/EpisodeList.tsx` + `EpisodeRow.tsx` — season chips, 212px stills with E-chip,
  watched ✓, progress bar, Continue pill, per-episode Play-in chips.
- Show detail adds the `.prev-btn` "Previously" entry to `RecapModal`.
- The `-238px` overlap between hero and body (`.d-body { margin-top: -238px }`) is the
  fiddly bit — it must not reintroduce the poster/hero collision called out in
  `DetailHero.tsx`'s header comment.

---

### Phase 6 — Requests · Library · Collections · Calendar · Search

**Branch** `feat/stage-content-views`

- `.page-pad` (36px/48px) + `.page-head` (38px display + sub) as the shared page header
  for all four — a small `PageHeader` component, since Option B repeats this exact
  block on five screens.
- `RequestsView.tsx` — filter pills with counts; request cards with 70×105 posters;
  keep the existing status palette exactly (pending amber / pending-approval orange /
  processing blue + progress / available emerald / failed red + humanized error) and the
  delete-only-on-pending/failed rule.
- `LibraryView.tsx` — saved filters + `.saved-grid`.
- `CollectionsView.tsx` — `.col-card` stacked-poster cards, `.cbadge.ai` / `.cbadge.pub`,
  dashed `+ New Collection`.
- `CalendarView.tsx` — List⇄Month segment, date groups with TODAY pill, `.cal-month` grid
  with episode chips.
- `SearchView.tsx` + `SearchPalette.tsx` — 760px palette, 26px display query, poster
  result rows with ⏎ hints, footer key legend; results page gets the `.smart-chip`.

Per **D2** these stay three separate routed pages — the `.tri` 3-column grid is the
mockup's framing device, not the target layout. Each page adopts its pane's UI in full
(`.saved-grid`, `.col-card` + badges, `.cal-month` + `.lm-seg`) at full page width rather
than in a third of the viewport, so the column counts scale up accordingly.

---

### Phase 7a — Admin · Settings · Auth · Profiles · Player/Party restyle

**Branch** `feat/stage-admin-settings` and `feat/stage-auth-player` (two PRs — admin +
settings are dense but low-risk; auth/player touch the login path and the playback
overlay, which deserve their own review)

- `admin/AdminView.tsx` — `.admin-tabs` sticky at `top: var(--topnav-h)`, `.stat-row`
  tiles, `.apanel` / `.strip` compact panels. All 13 tabs stay.
- `SettingsView.tsx:136` — `max-w-3xl` single column → full-width 2-col `.set-grid` of
  `.set-card`s, `.set-card.wide` for full-span sections. Each typeface option keeps
  rendering in its own font.
- `AuthView` — split layout: brand block (84px mark, 46px wordmark, invite hint) beside
  the 428px glass card; five OAuth tiles in a 2-col grid.
- `ProfileSwitcher.tsx` / `NebulaAvatar.tsx` — "Who's watching?" stage, 118px orbs,
  dashed Add Profile, onboarding note.
- `PlayerControls.tsx` / `VideoPlayer.tsx` — scrub with buffered fill + hover timestamp,
  transport chrome, `.skip-pill`, `.upnext` card, `.cast-pill`. **Styling only** — the
  surface stays `fixed inset-0` here; windowed mode is 7b.
- `PartyPanel.tsx` + `CinematicChatTicker` / `VoicePill` / `MiniDock` / `PartyInvite` —
  restyle only; the mockup's minimal/cinematic variants already exist as components.
- Consolidate the triple-encoded typeface default onto `FONT_OPTIONS` / `applyFont`
  (deferred from Phase 0) while this card is being rebuilt anyway.

---

### Phase 7b — Windowed theater mode (per D1)

**Branch** `feat/stage-windowed-theater` — its own PR, last in the sequence, because it
changes playback behavior rather than appearance and it composites over the Stage chrome
from every earlier phase.

- Mode state + persistence in `aurora_prefs` (fullscreen ⇄ windowed), a toggle in the
  player chrome, and a decision on how it interacts with native fullscreen.
- `VideoPlayer.tsx:3200` — the `fixed inset-0 z-[60] bg-black` surface becomes the
  windowed `.theater` inset (90px sides / 58px top-bottom, radius 20px, `--glow-halo-strong`)
  when the mode is on, with `.dim-app` + `.dim-veil` over the still-mounted app.
- Because the app behind the player becomes **visible** for the first time: scroll lock,
  TopNav z-order, and pointer-events on the dimmed tree all need explicit answers.
- `.dim-veil`'s `backdrop-filter: blur(6px)` sits over playing video — the deep-debug
  Bug 25 blur budget. It must honor the `html[data-glow="subtle"]` opt-out, same as the
  Phase 0 primitives.
- Keyboard + focus: Esc, click-outside, focus trap, and tab order all differ from the
  fullscreen surface.
- Watch party overlays (`PartyPanel`, `MiniDock`, `VoicePill`, `ReactionOverlay`) are
  positioned against the viewport today; in windowed mode they need to anchor to the
  theater box instead. **Done in the 7b fix pass**, via `--theater-inset-x/y` custom
  properties that both `.stage-theater` and the three `.stage-party-*` anchors read,
  gated on `html[data-player-surface="theater"]` so fullscreen and the minimized cast
  widget keep their viewport offsets. `VoicePill` needed no change — it renders inside
  `PartyPanel`'s rail.

---

### Phase 8 — Responsive + a11y sweep, then deploy

**Branch** `feat/stage-polish`

The mockup is authored at exactly 1440×900 with hard-coded pixel positions; nothing in
it says what happens at 1280, 768, or 390. This phase is not optional cleanup — it's
where the mockup stops being a spec.

- Breakpoint pass on every screen: nav overflow, hero type scale, grid columns, the
  detail `-238px` overlap, admin tab wrap, settings 2-col → 1-col.
- Contrast audit on every on-art text surface introduced in Phase 3–5.
- Keyboard pass: tabs, avatar dropdown, palette, context menu, card focus rings.
- Then: merge to `main` → `bash scripts/server-test-loop.sh --trigger-update` →
  verify against `https://aurorapro.app` per `docs/server-testing.md`.

---

## 4. Screen → code map

Reference table for whoever picks up a phase.

| Screen | Owning code | Phase |
|---|---|---|
| 01 Sign In | `AuthView` in `App.tsx` | 7 |
| 02 Profiles | `ProfileSwitcher.tsx`, `NebulaAvatar.tsx`, `OnboardingFlow.tsx` | 7 |
| 03 Home | `HomeView` in `App.tsx`, `HeroSection.tsx`, `MediaRail.tsx`, `GamificationCard.tsx` | 4 |
| 04 Movies / TV browse | `BrowseView.tsx` | 4 |
| 05–06 Detail | `DetailView.tsx` + `components/detail/*` | 5 |
| 07 Player | `VideoPlayer.tsx`, `PlayerControls.tsx` | 7 |
| 08 Watch party | `PartyPanel.tsx`, `PartyInvite.tsx`, `MiniDock.tsx`, `VoicePill.tsx`, `CinematicChatTicker.tsx` | 7 |
| 09 Search + ⌘K | `SearchView.tsx`, `SearchPalette.tsx` | 6 |
| 10 Requests | `RequestsView.tsx` | 6 |
| 11 Library / Collections / Calendar | `LibraryView.tsx`, `CollectionsView.tsx`, `CalendarView.tsx` | 6 |
| 12 Admin | `admin/AdminView.tsx` | 7 |
| 13 Settings | `SettingsView.tsx` | 7 |
| Chrome on every screen | `App.tsx` root, new `TopNav.tsx`, `ScanProgressBar.tsx`, `BugReportButton.tsx` | 1+2 |
| Cards on every screen | `MediaCardCinema.tsx`, `index.css` | 3 |

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| **`App.tsx` is 5,303 lines** and owns the shell, Home, Auth, Search, and the drawers. Phase 1+2 edits its render root | Extract `TopNav` to its own file. Resist inlining anything new into `App.tsx`; the app-split precedent (lazy view chunks) is the pattern to follow |
| **The card CSS carries annotated bug fixes** (`index.css:756–1075`): AA contrast token, Bug 22 corner rounding, Bug 25 blur budget, reason-tooltip pairing | Phase 3 rewrites that block deliberately, with each historical constraint re-checked as an acceptance item, not as a diff casualty |
| **Losing the sidebar removes mobile nav** — previously a filed bug (QA BUG-012) | Responsive nav ships in the same PR as the sidebar removal. Non-negotiable |
| **Hard-coded `top:64px` sticky offsets** in the mockup (browse toolbar, admin tabs) | `--topnav-h` token in Phase 0, consumed everywhere |
| **Drawer anchoring silently breaks** — three code comments explicitly tie `ServerPanel` / `NotificationPanel` positioning to sidebar-footer triggers | Called out as an explicit Phase 1+2 checklist item |
| **84px display type in four typeface systems** with different metrics | Phase 0 checks all four × three glow modes before any layout work |
| **Text-on-art contrast** replaces a purpose-built AA text shelf | Scrim must guarantee ≥4.5:1 for meta; audited again in Phase 8 |
| **Thin frontend test coverage** (`npm test` = one file) | Add render tests for `TopNav` and `MediaCardCinema` — the two components every screen depends on |
| **Player z-index collision** — mockup nav z-60 vs `VideoPlayer` z-[60] | Nav at z-50; explicit overlay-stacking check in Phase 1+2 |

---

## 6. Per-phase gate

Same gate every time, per `docs/dev-workflow.md`:

```bash
# frontend
cd static/redesign/app
npm run build     # tsc -b && vite build — must be clean
npm run lint
npm test

# repo
go build ./...    # must be green
go test ./...     # must be green
```

### Then a debug session — mandatory, every phase

`docs/dev-workflow.md` stage 5 (multi-agent adversarial review of the diff) runs on
**every** phase of this migration, not just the risky-looking ones. Decided 2026-07-25;
a UI migration is exactly where "it builds and it looks right" hides second-order
breakage, and the reviewers get their own angles so they don't converge on the same
obvious surface.

The angles that map onto this work:

| Angle | Looks for |
|---|---|
| **Behavioral parity** | every control the replaced code had, still present and still wired — the failure mode of a chrome swap is silent loss, not a crash |
| **Layout / CSS / stacking** | padding assumptions broken by the shell change, stacking-context and containing-block traps (`backdrop-filter`, `transform`), z-index pairs that now overlap wrongly |
| **A11y + responsive** | what's unreachable at each breakpoint, focus/keyboard, aria semantics, contrast on the new on-art surfaces |
| **State / lifecycle / data** | migration of persisted prefs, effect dependencies, listener leaks, and whether the phase's own tests are vacuous |

A phase is not done until every high/critical finding is fixed and re-verified, per the
FIX-FIRST rule. Lows are recorded in the phase's PR rather than silently dropped. The SPA is
built on the box by `scripts/aurora-update.sh` (`npm ci` + `vite build` → `static/v2`),
so a change only reaches `https://aurorapro.app` once it's on `main`:

```bash
bash scripts/server-test-loop.sh --trigger-update
```

### Parity checklist — must survive every phase

8 nav tabs (admin-gated) · ⌘K palette · card context menu · Server Status drawer ·
Notifications drawer + unread count · party live dot · scan progress bar ·
bug-report FAB · hero reason + match ring + "Not tonight" · conversational search ·
gamification band · watch-together card · taste onboarding · 10 nebula orbs ·
4 typeface × 3 glow systems · all 13 admin tabs · request status palette ·
per-episode version chips · Previously/recap modal · cast + companion flows.

---

## 7. Suggested sequencing

| Order | Branch | Screens visibly changed | Status |
|---|---|---|---|
| 1 | `feat/stage-tokens` | none (type + tokens only) | ✅ **shipped** |
| 2 | `feat/stage-chrome` | all (nav + full-bleed shell) | ✅ **shipped** |
| 3 | `feat/stage-cards` | 03, 04, 09, 11 | next |
| 4 | `feat/stage-home-browse` | 03, 04 | |
| 5 | `feat/stage-detail` | 05, 06 | |
| 6 | `feat/stage-content-views` | 09, 10, 11 | |
| 7 | `feat/stage-admin-settings` | 12, 13 | |
| 8 | `feat/stage-auth-player` | 01, 02, 07, 08 | |
| 9 | `feat/stage-polish` | all (responsive + a11y) | |
| 10 | `feat/stage-windowed-theater` | 07, 08 | per D1 |

Ten PRs, frontend-only, no backend or schema work. Phases 3–8 are independent of each
other once 1–2 have landed, so they can be parallelized across branches if you want to
compress the calendar — with the caveat that 3 and 4 both touch rail/grid sizing and
should not be in flight simultaneously. Phase 10 stays last by design: it's the only one
that changes behavior rather than appearance.
