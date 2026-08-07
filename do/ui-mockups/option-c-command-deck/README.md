# Option C — "Command Deck"

_Companion to [`index.html`](index.html) (16 screens at a true 1440×900, zero production
code touched). One of the head-to-head full-parity redesign directions; compare with
[`option-b/`](../option-b/IMPLEMENTATION_PLAN.md) and `option-d-daybreak/`._

**Thesis.** Today's Aurora is a theater — this is the control room behind it. Density is
respect: show more, scroll less, never hide a number. Every surface is an instrument
panel, every list is a table, the keyboard is a first-class citizen. Linear × DaVinci
Resolve × a flight deck. There is no display face and no glow anywhere in the chrome;
hierarchy is weight, size steps and drawn 1px lines — all the romance is left to the
content art itself.

---

## 1. What Option C actually changes

Same features, same routes, same data — different chrome and register. Eight structural
moves; every screen is a consequence of them:

| # | Move | Today | Command Deck |
|---|------|-------|--------------|
| **M1** | **Chrome** | 240px sidebar + per-page toolbars; toasts float; scan bar is its own strip | 240px rail re-cut (grouped `LIBRARY / TOGETHER / SYSTEM`, kbd hints, server LED, profile chip + bell in the footer) **plus** a 44px command bar (⌘K permanently visible, breadcrumb, scan/party chips, clock) **plus** a 26px status bar that absorbs the ambient roles of toasts *and* the scan bar |
| **M2** | **Surface system** | `#050505` cosmic ground, purple `#A855F7` accent, glass + glow halos, 16–20px radii | Carbon `#101215`, signal-amber `#ffb224`, depth = surface steps + 1px lines only; no shadows, no blur, no gradients in chrome; 4px max radius (chips 2px) |
| **M3** | **Type** | Bricolage Grotesque display over Inter | No display face at all. Inter 13px/20 base, weight+size-step hierarchy (titles cap 28px); **IBM Plex Mono carries every datum** — runtimes, codecs, sizes, counts, kbd, IDs, ISO timestamps |
| **M4** | **Home** | Full-bleed billboard hero | A briefing: TONIGHT'S PICK panel (framed art, mono `MATCH 87` readout) beside YOUR WEEK stat tiles and ACTIVE PARTIES rows; rails become dense shelf rows with captions *under* the art |
| **M5** | **Browse** | Poster grid with hero band | **Table first**: 44px rows (thumb, title w/ watched ✓ / progress %, year, genre, ★, quality chip, size, added), sortable headers, honest counts (`1,204 results`), explicit `Load 100 more`; grid is the toggle's other state |
| **M6** | **Detail** | Backdrop hero page | Spec sheet beside art: FILE panel first-class (container/video/audio/subs/size/path), cast as compact 2-col data, episodes as a sortable table |
| **M7** | **Player** | Controls float over the video | Master monitor: 16:9 stage on `--inset`, full-width control deck *below* it (scrub w/ chapter ticks + preview, mono timecode, kbd cheat row always visible); only cues, skip and up-next ride the image |
| **M8** | **Feedback** | Toasts + dedicated scan bar | The status bar is the ambient truth (`2,341 items · scan: Movies 62% ▰▰▰▰▰▱▱▱ · transcode 1 active`); errors still announce assertively; the bug-report launcher lives there too |

The wordmark reuses the app's BOREALIS_PATHS letterform, re-cut for the deck: butt caps,
reduced stroke, flat ink, only the A's wave crossbar in amber, over a mono
`MEDIA OPERATIONS` micro-label.

## 2. The 16 screens

01 Sign In · 02 First Run · 03 Who's Watching · 04 Home · 05 Movies (table browse) ·
06 Movie Detail · 07 Show Detail (recap modal open) · 08 Player · 09 Party — Live ·
10 Party — Plan (composer + lobby + hub) · 11 Search (⌘K palette open) · 12 Requests ·
13 Library · Collections · Calendar · 14 Members & Profiles · 15 Settings · 16 Admin
(LLM tab active, real 13-tab strip)

Each frame repeats the full app chrome and carries numbered amber callouts with a legend
strip underneath (option-b convention). A running fiction ties them together: one
evening on `aurora-01`, clock advancing 19:42 → 20:04, the Movies scan ticking
62% → 73% in the command-bar chip and status bar on every post-auth screen.

## 3. Parity

**All items of `PARITY_CHECKLIST.md` are drawn or explicitly annotated — nothing was
dropped as out of scope.** Rendered open on their home screens: the bell panel with
inline RSVP, profile-switcher menu, recap modal, CC menu, cast widget, party composer +
lobby + hub (Recently in / My Rooms / Enter a code), ⌘K palette, request dialog, and the
admin LLM tab.

Covered by annotation rather than pixels (transient or below-breakpoint states that
can't coexist with the base screenshot): the mobile hamburger sheet (s4 note 11), browse
grid view (s5 note 1), trailer modal and card context menu, collections *detail* view
(s13 note 2), the bug-report recording pill and `REPORTED · #412` success state (s15
note 7), player error/recovery ladder, and the 12 non-LLM admin tabs' contents (s16
note 7).

## 4. Spec

```
bg #101215 · panel #16191d · panel-2 #1c2025 · inset #0b0d0f
line #262b31 / #343a42 · ink #e8eaed / #9aa3ad / #5f6a75
accent #ffb224 (on-amber ink #161000) · info #4c9eeb · ok #3fb950 · warn #d29922 · danger #f85149
radius 4px max (chips 2px) · no shadows/blur/glow · gradients only inside poster art

ui   Inter 13px/20 — steps 11/12/13/15/18/22/28, titles cap 28px
data IBM Plex Mono — micro-labels 10.5px uppercase +0.08em; timestamps ISO (2026-08-07 19:42)
```

Voice: terse, verb-first, diagnostic. Numbers never rounded away; empty states state
facts + one action; errors name the cause and the fix.

## 5. Open questions for review

1. **Is table-first browse right for a media library?** The grid survives as a toggle,
   but the default fights years of poster-wall muscle memory. Per-library defaults
   (table for operators, grid for guests) may be the honest answer.
2. **Status bar as toast replacement** — ambient truth is quieter than toasts by design,
   but save/error feedback in a 26px mono strip needs a real a11y story (assertive live
   region) and may be too subtle on large monitors.
3. **Amber-on-carbon accessibility**: accent `#ffb224` vs warn `#d29922` proximity, and
   small mono micro-labels at `--ink-3`, should be contrast-checked before any build.
4. **Keyboard-first chrome on touch** — kbd hints and ⌘K earn their space on desktop;
   the below-md sheet is annotated but a tablet pass (no hover, no ⌘) is undesigned.
5. **Density default**: the deck reads best at Compact; whether Cozy should be the
   shipped default for non-operator members is a product call, not a design one.
6. **The wordmark re-cut** (flat ink, amber wave only) deliberately drops the aurora
   gradient — worth confirming the brand is allowed to be this quiet.
7. **Ship path**: like option-b, chrome first (sidebar/command bar/status bar as a
   layout swap around existing views), then per-surface passes behind the existing
   redesign feature flags. The footer of `index.html` sketches this; a picked direction
   graduates to its own `IMPLEMENTATION_PLAN.md`.

## 6. About the mockup file

Self-contained single HTML file: no build step, no scripts, no external assets beyond
one Google Fonts `@import` (Inter + IBM Plex Mono) with full local fallbacks. All poster
art is CSS gradients + typographic treatment; icons and the wordmark are inline SVG.
Frames are authored at a true 1440×900 so measurements are real pixels. The shared fake
catalog (The Last Meridian, Neon Divide, …) and people (Maya/Theo/Pip, alice, jae, …)
are identical across the head-to-head options for 1:1 comparison.
