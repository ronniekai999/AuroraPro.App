# Aurea cinema elements — what to borrow, and how it lands in Aurora

**Implementation plan:** [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) —
three phased PRs (presentation → interaction → backend-backed), grounded in
the existing code.

**Mockup:** [`mockup-home-aurea-elements.html`](./mockup-home-aurea-elements.html) —
static, self-contained, open in any browser. Use the **"Show adopted
elements"** toggle (bottom-right) to outline every borrowed element with a
numbered chip; the on-page legend maps each number to its source. Film grain
is toggleable and honors `prefers-reduced-motion`.

## Source

A user-provided concept zip ("Kimi Agent — Netflix UI Mockup Redesign",
2026-07): a fictional streaming service branded **Aurea** — dark-plum ground,
gold accent, Fraunces serif-italic display type, film grain, Netflix-style
information architecture (hero → genre pills → rails → Top 10 → Continue
Watching → detail modal). Stack is the same family as ours (React + Vite +
Tailwind), so its patterns translate ~1:1 into
`static/redesign/app`.

## Translation rule

Aurora does not become gold. Every "champagne" moment in Aurea maps to
Aurora's existing violet→cyan identity, and Aurora's layout, components, and
data model stay exactly as they are today (sidebar + glass topbar + greeting
band + inset hero + mood box + glass shelf rails + cinema cards). What we
take is **editorial voice and finishing moves**, not a reskin.

## Adopted (as shown in the mockup)

| # | Element | From Aurea | How it lands in Aurora |
|---|---------|------------|------------------------|
| 1 | **Editorial serif display** | Fraunces italic headlines everywhere | Hero title, rail headings, procedural-poster captions only — body/UI stays Sora/Inter Tight. Ships as a *fifth Typeface system* in Settings → Appearance (we already have the `data-font` token plumbing in `index.css`); self-host `fraunces.woff2` like the other seven faces. |
| 2 | **Eyebrow kickers** | "AUREA ORIGINAL SERIES", "THE LEDGER" | Micro uppercase tracked labels: "TONIGHT'S PICK" above the hero, "THE CHARTS" above the Top 10 rail. Pure CSS class. |
| 3 | **Hero meta chips** | match/year/duration + rating chip + "4K · DOLBY VISION" | We already have `has_4k` + `content_rating` in the list payload (`mapMedia` builds `tags`) — surface them in `HeroSection` alongside the existing match %. |
| 4 | **Serif tagline quote** | italic quote leading the synopsis | One styled span in the hero copy (tagline comes from metadata when present). |
| 5 | **Ken Burns + staggered entrance** | 26s hero zoom, `rise` cascade | Idle drift layered under the existing mouse parallax (`HeroSection` already owns the transform wrapper); entrance stagger on hero copy. Both off under `prefers-reduced-motion`. |
| 6 | **Genre pill row** | pill filters under the hero | One-tap genre filters between the mood box and the rails; active pill gets the violet glow treatment. |
| 7 | **Top 10 rail** | giant outlined numerals behind posters | New rail type in `MediaRail`'s family: `-webkit-text-stroke` violet numerals (brighten + lift on hover), fed by the server's play counts. Lives inside the standard glass shelf so it reads native. |
| 8 | **Hover quick actions on cards** | poster hover overlay w/ play + add + match% | Adds a one-tap Play + "% for you" to `MediaCardCinema`'s existing hover scrim — shares the scrim with the current AI-reason reveal; title is NOT duplicated (the shelf keeps it). Aurea's overlay also had an add button; we deliberately dropped it — the persistent top-left lib-badge is the single add-to-library control (always visible, touch-friendly, and it's where the in-library ✓ state lives). |
| 9 | **Edge-fade mask on rails** | `mask-x` | Cards dissolve at the rail edges instead of clipping. One utility class on `.rail-scroll`; chevron paddles unchanged. |
| 10 | **Continue Watching upgrades** | episode chip, center play-on-hover, luminous progress + % | Episode chip top-left ("S2E4 · 'The Anchorage'"), centered play chip on hover, and the progress bar moves into the shelf as a violet→cyan gradient with % + time-left readout (`formatRemaining` already computes it). |
| 11 | **Sidebar touches** | section labels, active notch, count badge, promo card | Groups the flat nav (Browse / Library / Manage), glowing left-notch active indicator, My Library count badge, and a floating "Premiere" spotlight card (see below). |

**Global touches:** subtle animated **film grain** (Appearance toggle;
disabled under `data-glow="subtle"` and reduced-motion — same budget rules as
the existing overlay blur), violet-tinted **scrollbar** and **selection**
color.

### The Premiere spotlight card (element 11, in depth)

Aurea uses this sidebar slot as a marketing card for its own originals
("Aurea Premiere — Hollow Kings Season 2. Now streaming."). Aurora's version
keeps the slot but makes it a functional surface with **three data states**
(cycle them with the "Premiere card" control in the mockup):

1. **Request arrived** (highest priority, teal accent — the existing
   "fresh content" tint from the Recently Added rail): a title someone
   requested has landed and finished scanning. This is the moment a
   user most wants to be told about, and today it's only discoverable
   via the Requests page or by noticing the rail. Copy stays
   deployment-neutral ("Requested 3 days ago"); multi-user servers
   could optionally attribute the requester.
2. **Added today** (violet): the newest completed library addition —
   effectively card #1 of Recently Added, promoted to a slot visible on
   *every* view. Blurb truncated from the synopsis + quality chips.
3. **Hidden**: nothing new in the last few days → the card doesn't
   render. This rule is what lets it earn permanent sidebar space —
   a card that always shows something stops meaning anything.

Click → DetailView for the title. Hover reveals a per-item **dismiss ×**
(stash the media id in localStorage; the card only returns for a *new*
item). Implementation shape: a self-fetching `PremiereCard.tsx` (same
pattern as `GamificationCard`) reading the recently-added source +
requests state, refreshed off the realtime scan-complete event.

## Removed after review (2026-07-16)

Two elements were in the first cut and dropped once the copy went
deployment-neutral:

- **The hero "№1" rank tag** ("№1 in Series Today" in Aurea). On a
  single-user server "most watched this week" is self-referential — it
  tells you what you yourself watched — and the hero is already dense
  (ring, eyebrow, reason pill, meta chips, tagline, three CTAs). Rank
  lives in the Top 10 rail, which still works solo (a Wrapped-style
  chart of your own habits) and becomes real social proof on multi-user
  servers. If the tag ever returns, it should render only when ≥2
  viewers contributed to the week's chart — the same earn-your-slot
  gating as the premiere card and cold-start personalization.
- **The hover overlay's add-to-library button.** It duplicated the
  card's persistent top-left lib-badge — two "+" affordances for one
  action, visible at the same time on hover. The badge wins: always
  visible, touch-friendly, and it carries the in-library ✓ state. The
  hover scrim keeps what it uniquely adds: one-tap Play + "% for you".

## Deliberately not adopted

- **Gold/champagne palette** — it's Aurea's identity, not ours. Everything
  gold became violet/cyan.
- **Serif body text / full-serif UI** — serif is display-only; body stays
  sans for legibility at UI sizes.
- **"Salon" nomenclature & Aurea Originals branding** — fictional-service
  flavor, not a media server's.
- **Replacing the sidebar with a top-nav** — Aurora's shell (sidebar +
  topbar + mood box + greeting) is already distinctive and stays.
- **The shadcn/ui component kit** — the zip ships 50+ shadcn components;
  we already have our own equivalents.
- **Detail modal** — Aurora has a full `DetailView` route; the modal's
  episode-row treatment ("Watching" chip + inline progress) is worth
  stealing *later* as a DetailView polish pass, but it's out of scope for
  the home mockup.

## Notes

- All titles in the mockup are fictional; art is procedural CSS (no images,
  no network) — matching `docs/proposals/*` mockup conventions.
- The mockup is deliberately dark-only: Aurora is a cinema UI.
