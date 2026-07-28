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

- ~~Breakpoint pass on every screen~~ **done.** Nav overflow, admin tab wrap and
  the detail `-238px` overlap were already correct (the tabstrip is a scroll
  container at every width with a contrast-checked mask; the overlap is `lg:`-gated).
  Hero type scale is clean: every fixed display token (`--fs-browse` 52px,
  `--fs-page` 38px) is behind `md:`/`lg:` with a smaller Tailwind size below it,
  and `--fs-hero`/`--fs-detail` are fluid `clamp()`s. Settings' 2-col is Tailwind
  at the call site, deliberately, so `md:` can collapse it. One real fix: the
  media-list rule at `max-width: 768px` OVERLAPPED `md:` at exactly 768px.
  Automated as `npm run audit:breakpoints` — it resolves every `max-width` query
  against the Tailwind breakpoints actually emitted in the build.
- ~~Contrast audit on every on-art text surface~~ **done**, as
  `npm run audit:contrast`. It composites the multi-layer scrims at each string's
  own x AND y over both a black and a white frame, because a single "the scrim is
  0.72" figure is meaningless for a two-layer gradient. The left text column
  passes comfortably (5.3–20.4:1). Two failures, both on the RIGHT, where the
  horizontal ramp thins to 0.15 on purpose to show artwork: the MATCH/SCORE
  eyebrow at **1.22:1** and the percentage numeral at 2.16:1. Fixed with a local
  `.stage-hero-match-veil` rather than by darkening the scrim, which would spend
  the artwork the ramp exists to preserve.
- Keyboard pass — **PARTLY done, and the "done" claim was wrong.** The input-focus
  half below is finished and verified. The FIVE WIDGETS the plan actually names
  ("tabs, avatar dropdown, palette, context menu, card focus rings") were not
  swept; I checked the admin tabstrip and the input population and generalised from
  them. A reviewer refuted 4 of the 5, and none of these is subtle:
    - **`ContextMenu.tsx` — WCAG 2.1.1, Level A.** Its only trigger is
      `onContextMenu`. No `role="menu"`, no focus moved into it, no arrow keys.
      Four actions — Mark as Watched, Clear Progress, More like this, Not
      interested — have **no other route anywhere in the app**, so they are
      unreachable by keyboard entirely.
    - **`detail/DetailTabs.tsx`** declares `role="tablist"`/`role="tab"` with ZERO
      `onKeyDown` and no roving `tabIndex`: every tab is its own tab stop, no
      Arrow/Home/End, and `aria-controls` dangles on inactive tabs.
      `AdminView.tsx` is the correct implementation and was not ported.
    - **`TopNav.tsx` AvatarMenu** — Escape only; no arrows, and every activation
      path unmounts the focused button leaving focus on `<body>`.
      `ProfileSwitcher.tsx`, ten lines away in the same file, does it correctly.
    - **`SearchPalette.tsx`** — `aria-modal="true"` with no focus trap, no opener
      capture, no scroll lock; plus a real functional bug where its window-level
      Enter handler opens the HIGHLIGHTED row rather than a Tab-focused one.
    - Card focus rings: grid cards pass; `.media-list-row:focus-visible` overrode
      the floor at a lower alpha (2.45:1 vs 3.19:1) — **fixed**.
  **All four fixed in Phase 9** (see below). What was done in Phase 8, and was the
  largest single a11y defect of the whole redesign: **no `<input>`, `<select>` or `<textarea>` in the app had an adequate
  focus indicator.** The global exemption strips the `:focus-visible` outline from
  every input at (0,2,1), deferring to a `:focus` treatment that measured
  **1.99:1** (border), 1.07:1 (background shift) and 1.09:1 (halo). Also corrected
  a comment on the `:focus-visible` floor which claimed layer precedence made it
  unsuppressable — Tailwind 3 emits **no native `@layer`**, so a
  `focus:outline-none` at (0,2,0) beats it, which is why the same bug had already
  shipped three times. `npm run audit:a11y` now checks it, and the cascade question
  is answerable by `scripts/resolve-focus.mjs` instead of by reading source order.

  **"Checked", not "guarded"** — the honest word. This repo has no `.github/`, no
  CI and no git hooks, so `npm run audit` runs only when a human types it; it is
  listed in `CLAUDE.md`'s gate for that reason. Reviewers also established that the
  FIRST versions of three of these four scripts would have reported clean on their
  own target bugs — the contrast one read no files at all and was structurally
  incapable of failing. All four were rewritten, and each is now mutation-tested
  against the specific defect it exists to catch, with the surviving-mutation list
  recorded in its header.
- Then: merge to `main` → `bash scripts/server-test-loop.sh --trigger-update` →
  verify against `https://aurorapro.app` per `docs/server-testing.md`.

---

### Phase 9 — the four hand-rolled keyboard widgets

**Branch** `feat/stage-polish` (same)

Phase 8 claimed a keyboard pass and delivered half of one: the input-focus
population was fixed, and the five widgets the plan names were not swept. This is
the other half. None of these use a Radix primitive — `ui/dropdown-menu`,
`ui/context-menu` and `ui/tabs` have zero importers — so all four are hand-rolled
and all four were incomplete in the same way: a role that promises a keyboard
contract, without the contract.

- **`ContextMenu` — was a WCAG 2.1.1 (Level A) failure.** Four items had no other
  route in the app. The trigger was never the problem: cards are
  `role="button" tabIndex={0}` and browsers fire a real `contextmenu` for Shift+F10
  and the Menu key, so it opened — but a keyboard-generated event reports
  clientX/clientY of 0, so it pinned itself to the viewport corner, and once open
  there was no `role="menu"`, no roving tabIndex and no arrow keys. Now has the
  full APG Menu contract plus `anchorFor()`, which is extracted and unit-tested
  because the keyboard/pointer distinction is invisible to a mouse-driven pass.
- **`detail/DetailTabs`** declared `role="tablist"`/`role="tab"` with zero key
  handling. Now the same manual-activation contract `AdminView` already used
  (arrows move, Enter/Space selects, one tab stop), via the shared
  `nextRadioIndex`. Also stopped pointing `aria-controls` at panels that don't
  exist — only one panel is rendered at a time, so it dangled on every inactive tab.
- **`TopNav`'s AvatarMenu** — `role="menu"` with Escape only. Arrows/Home/End over
  the live row set, focus into the menu on open, Tab dismisses, and every
  activation path returns focus to the trigger instead of dropping it to `<body>`.
- **`SearchPalette`** — `aria-modal="true"` with no trap, no opener capture and no
  scroll lock, plus a real functional bug: its window-level Enter handler opened
  `results[highlighted]` even when the user had Tab-focused a *different* row, so
  Enter opened the wrong title.

Worth recording as the lesson: in all four cases the ARIA role was the liability.
`role="menu"` and `role="tablist"` put NVDA and JAWS into forms mode and hand the
arrow keys to the application — so a role without its keyboard contract is worse
than no role at all, because the screen reader has stopped offering its own
navigation in exchange for nothing.

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


---

### Phase 10 — the two defects the Phase 9 review found but did not fix

**Branch** `feat/stage-polish` (same)

Both were raised by the AT reviewer as bigger than what Phase 9 had actually fixed,
and both were deliberately deferred rather than half-done.

- **`SearchPalette` had no combobox semantics at all** — no `role="combobox"`, no
  listbox, no `aria-activedescendant`, no `aria-selected`, no live region. A
  screen-reader user got an input that silently changed a list they could not
  perceive: typing produced silence, and arrowing produced silence, because the only
  difference between the highlighted row and its neighbours was a background colour
  and a `⏎` glyph appended to one label. Now the APG Combobox-with-listbox pattern.
  `aria-activedescendant` is the load-bearing piece and it fits this widget without
  changing how it behaves — arrows already moved a highlight while focus stayed in
  the input, which is exactly what the pattern describes.
  It also removes a real bug rather than only a semantic one. As tabbable
  `<button>`s the rows created THREE competing cursors — Tab moved DOM focus, arrows
  moved `highlighted`, hover moved it again — so the `⏎` affordance could advertise
  on a row Enter would not act on. Phase 9 patched that symptom by making Enter
  defer to a Tab-focused row; `role="option"` on non-focusable rows removes the
  second cursor entirely.
- **The media card never announced that a context menu exists.** Phase 9 showed the
  menu IS keyboard-reachable and concluded "the trigger was never the problem" —
  true for SC 2.1.1 (operability) and beside the point for discoverability. Four of
  that menu's items have no other route anywhere in the app, and being reachable by
  a shortcut you have no way to learn about is not much better than unreachable.
  Shipped as `aria-keyshortcuts="Shift+F10"` on the card and the list row, NOT the
  `aria-haspopup="menu"` this section originally specified — the fix pass showed
  haspopup is the attribute ARIA's own authoring note argues against when there is
  no visual indicator, that it describes what ACTIVATION opens (the detail view, not
  the menu), and that NVDA renders the state as the literal string "subMenu".
  Deliberately no `aria-expanded` either: that is for a trigger that owns its popup,
  and the menu is App-level state shared across the whole grid, so a per-card flag
  would be false on every card but one.
- **The vibe search bar is full width**, third and final answer on its WIDTH. Phase
  8 and the 8 fix pass both measured it against the hero's TEXT COLUMN; the thing it
  actually sits next to is the Continue Watching rail panel 32px below (`mb-8`),
  which runs the full gutter width. Capped at any value it stair-stepped against
  that panel. Full width also settles what the element is — the first page-level
  band rather than the last line of the hero stack, which is how it behaves, since
  using it replaces the rails with results.

### Phase 10b — the vibe bar's vertical gap

Going full width made the bar look wrong against the hero's Play / My List / More
Info row, and the obvious reading — the one the user's question started from — was
that the BUTTONS were now misaligned. They are not, and this is the fourth time on
this element that the instinct was to move the wrong thing.

The hero's bottom row is `absolute bottom-0 left-0 right-0 … px-[var(--page-gutter)]
max-md:px-[18px]`; the bar's wrapper is `.stage-gutter`, whose own mobile override is
also 18px below 768. Both edges match at every width. The button row and the bar span
exactly the same measure.

What was wrong is density plus proximity. The row above is two small clusters with
the width of the page between them; the bar below is a continuously filled surface
across that same span, so **the bar is what made the void above it legible** — the
gap was always there, nothing solid had ever sat under it. And at `-mt-5` the two
were 16px apart, close enough to read as one row, at which point the eye tries to
reconcile a four-pill row in which one pill is the width of the viewport.

`-mt-5` → `mt-2`. Gap is `margin-top + 36px` (the hero row's `pb-9`), so 16px → 44px,
against `mb-8`'s 32px below.

**This is a deliberate divergence from the mockup, not a port of it.** `index.html`
specifies `.hero-inner{padding:0 48px 42px}`, `.conv-search{margin:-26px 48px 0}`,
`.home-rails{padding:36px 48px 0}` — **16px above the bar, 36px below**, i.e. the bar
grouped with the HERO. Production matched that intent exactly until now (16/32).
Phase 10b inverts it to 44/32, grouping the bar with the RAILS, which is the right
call once the bar is full width — it is the control that replaces the rails with
results — but Phase 0's "ported 1:1 from the mockup" doctrine does not cover it, and
the first version of this section recorded the change as a spec-consistent fix. It
is not. Recorded here so the next person diffing against the mockup finds the reason
instead of the discrepancy.

The cost is the overlap — 20px of the bar's ~49 used to sit on the artwork and now
none of its border box does — which is deliberate, since the overlap was the
mechanism welding it to the hero.

One consequence was justified wrongly and is worth carrying forward. "Safe because
Phase 4 made the hero's bottom scrim land on exactly `#050505`" is true of the inside
of the hero and is not what the bar pulled away from: the app root is `bg-[#050505]
aurora-bg`, and `.aurora-bg` composites three purple radials at α 0.05–0.08 over that
base, which the hero's own opaque `#050505` masks. So the hero's bottom edge is a
~6–10 sRGB-level step, full width, no ramp. It is pre-existing, but the negative
margin had been straddling and attenuating it across everything but the two gutters;
at `mt-2` it is bare edge to edge. Small — an OLED-in-a-dark-room band, not a contrast
defect — and **left as a follow-up**, because the honest fix is in the hero/page
background system and this element has already been broken three times by fixing it
from the wrong reference.

Rejected, recorded so it is not relitigated a fifth time: moving "Not tonight" into
the CTA cluster closes the void but promotes a deliberately quiet tertiary control
(`bg-white/[0.04]`, a 1.19:1 border) to Play's peer; re-capping the bar to the hero
text column is where this started, twice.

Then the deploy: merge to `main` → `bash scripts/server-test-loop.sh --trigger-update`
→ verify against `https://aurorapro.app` per `docs/server-testing.md`.

---

### Phase 11 — close the loop the reviews have been closing by hand ✅ SHIPPED

**Branch** `feat/stage-hardening`

Phases 8–10b were each gated by a four-angle adversarial review, and those reviews
found real defects every time. That is the problem this phase exists for: **they
found them by reading, and a human read is not repeatable.** The pattern that
actually paid off was converting a review finding into a permanent machine check —
`audit-focus-indicators.mjs` Checks 3 and 4 both came from findings that would
otherwise have had to be re-found. Phase 11 does that deliberately, then clears the
recorded follow-ups.

Ordered by value, and the first item is worth more than everything below it.

#### 11.1 — A DOM test layer (the one real gap)

There is none. No `jsdom`, no `@testing-library/react`, and **zero tests that render
anything**: all 140 tests are pure functions over extracted helpers. Meanwhile `src`
carries 380+ `aria-*` attributes, and every keyboard widget in Phases 9 and 10 is
hand-rolled.

This is proven, not projected. The Phase 10 reviewer applied SIX simultaneous
mutations to everything that phase added — `role="option"` to `listitem`,
`role="listbox"` to `list`, `aria-expanded` to `false`, `aria-activedescendant` to
`undefined`, `aria-selected` to `false`, and the zero-result message to a wrong
string — and the entire gate stayed green. 132/132, `tsc` 0, lint unchanged. Every
semantic that phase existed to add could have been deleted without one check
noticing. `searchStatus.ts` was extracted specifically because it was the only piece
testable without a DOM; the rest still is not.

Minimum worth doing:
- `jsdom` + `@testing-library/react` + `@testing-library/user-event`.
- Assertions on the APG contracts already written: `SearchPalette`'s combobox
  (`aria-expanded` tracks the listbox's presence, `aria-activedescendant` follows
  the highlight, the listbox owns only `option` children), `ContextMenu`'s roving
  tabIndex, `DetailTabs`' Left/Right/Home/End.

  **Delivered, minus two items this list got wrong.** `ContextMenu` type-ahead was
  specified here and is NOT tested, because the feature does not exist — there is
  no printable-key handler to test. `TopNav`'s focus-restore is also untested and
  remains open. Both were written into the plan before anyone looked at the code.
- The focus-trap regressions specifically, because they have already shipped twice:
  the ⌘K opener-capture race, and mousedown-drag on a `<div>` row escaping the modal
  to `<body>`.

#### 11.2 — Widen the contrast audit past HeroSection

`audit-onart-contrast.mjs` reads exactly two files — `src/index.css` and
`src/components/HeroSection.tsx` — against a hardcoded surface list. Every other
view's on-art and on-glass text is unmeasured.

That is not hypothetical either: the vibe bar's own placeholder sat at 3.18–3.53:1
for three phases, under the 4.5 floor, and the audit was structurally incapable of
seeing it. A reviewer found it by hand. The `↵ Search` chip, the "Clear" button, the
rail headers, the card overlays and every glass panel are in the same position now.

#### 11.3 — Audit reduced-motion, don't just write it

`index.css` has 11 `prefers-reduced-motion` rules and nothing verifies any of them.
The Phase 10b review found a genuine reduced-motion-ONLY defect — `.animate-fade-in
{ animation: none !important }` stops that element being a stacking context, which
would have sent `.convo-search::before`'s `z-index: -1` halo behind `.aurora-bg` and
made it invisible for exactly the users least likely to report a missing animation.
Bugs that exist only under a media query are invisible to every check that renders
one state.

#### 11.4 — The recorded follow-ups

Carried forward from Phases 8–10b, none urgent, all real:

- **The `.aurora-bg` seam.** The app root is `bg-[#050505] aurora-bg`; `.aurora-bg`
  composites three radials at α 0.05–0.08 over that base, and the hero paints its own
  opaque `#050505` on top, so the hero's bottom edge is a ~6–10 sRGB-level step at
  full width with no ramp. Phase 10b unmasked it by removing the overlap that had
  been attenuating it. The fix belongs in the background system.
- **iOS Safari zooms the vibe input on focus.** Its font-size is under 16px, which is
  the trigger. `.stage-navsearch` already guards this with a 16px-below-lg rule and a
  comment explaining why; `.convo-search` does not.
- **`ServerPanel` / `NotificationPanel`** render `role="dialog"` with no focus
  management — no trap, no restore, no initial focus.
- **`SearchPalette`'s "Smart" chip** (`mode === 'semantic'`) is unannounced.
- **Ultra-wide.** No page-level max-width on the rail stack; at 2560+ everything sits
  at a 48px gutter.
- **390px horizontal overflow**, ~48px, from HeroSection's bottom flex row. Clipped
  rather than scrollable (`overflow-hidden` on the hero, `overflow-x: hidden` on
  body), so it hides content rather than breaking layout — which is why it survived
  the Phase 8 breakpoint pass.

#### 11.5 — Make the deploy verification runnable

`docs/server-testing.md` documents `scripts/server-test-loop.sh` as the way to verify
a change against the live instance, and it needs `AURORA_TEST_USER` /
`AURORA_TEST_PASS` from the environment. Those are not present in the Claude Code web
environment, so the documented path cannot actually be run from there — Phase 10b was
verified instead by building the merged tree locally and matching both emitted asset
hashes against what `https://aurorapro.app/v2/` serves. That works, but it checks
that the right bytes shipped, not that the app behaves. Either configure the secrets
or document the hash-match as the supported fallback.

