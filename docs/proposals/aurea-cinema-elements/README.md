# Aurea cinema elements — what to borrow, and how it lands in Aurora

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
| 2 | **Eyebrow kickers** | "AUREA ORIGINAL SERIES", "THE LEDGER" | Micro uppercase tracked labels: "TONIGHT'S PICK" above the hero, "HOUSE CHARTS" above the Top 10 rail. Pure CSS class. |
| 3 | **Hero meta chips** | match/year/duration + rating chip + "4K · DOLBY VISION" | We already have `has_4k` + `content_rating` in the list payload (`mapMedia` builds `tags`) — surface them in `HeroSection` alongside the existing match %. |
| 4 | **Serif tagline quote** | italic quote leading the synopsis | One styled span in the hero copy (tagline comes from metadata when present). |
| 5 | **Rank tag** | "№1 in Series Today" glass chip | "№1 · Most watched in your house" — real household watch stats, seated under the existing match ring. |
| 6 | **Ken Burns + staggered entrance** | 26s hero zoom, `rise` cascade | Idle drift layered under the existing mouse parallax (`HeroSection` already owns the transform wrapper); entrance stagger on hero copy. Both off under `prefers-reduced-motion`. |
| 7 | **Genre pill row** | pill filters under the hero | One-tap genre filters between the mood box and the rails; active pill gets the violet glow treatment. |
| 8 | **Top 10 rail** | giant outlined numerals behind posters | New rail type in `MediaRail`'s family: `-webkit-text-stroke` violet numerals (brighten + lift on hover), fed by household play counts. Lives inside the standard glass shelf so it reads native. |
| 9 | **Hover quick actions on cards** | poster hover overlay w/ play + add + match% | Adds a Play / add-to-library row + "% for you" to `MediaCardCinema`'s existing hover scrim — shares the scrim with the current AI-reason reveal; title is NOT duplicated (the shelf keeps it). Play keeps the click→detail language elsewhere on the card. |
| 10 | **Edge-fade mask on rails** | `mask-x` | Cards dissolve at the rail edges instead of clipping. One utility class on `.rail-scroll`; chevron paddles unchanged. |
| 11 | **Continue Watching upgrades** | episode chip, center play-on-hover, luminous progress + % | Episode chip top-left ("S2E4 · 'The Anchorage'"), centered play chip on hover, and the progress bar moves into the shelf as a violet→cyan gradient with % + time-left readout (`formatRemaining` already computes it). |
| 12 | **Sidebar touches** | section labels, active notch, count badge, promo card | Groups the flat nav (Browse / Library / Manage), glowing left-notch active indicator, My Library count badge, and a floating "Premiere" spotlight card fed by the newest library addition. |

**Global touches:** subtle animated **film grain** (Appearance toggle;
disabled under `data-glow="subtle"` and reduced-motion — same budget rules as
the existing overlay blur), violet-tinted **scrollbar** and **selection**
color.

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
