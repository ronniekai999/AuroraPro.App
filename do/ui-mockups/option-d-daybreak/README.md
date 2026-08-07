# Option D "Daybreak" — soft daylight on paper

_Companion to [`index.html`](index.html) (16 screens at 1440×900, zero production code
touched, no scripts). One design thesis: **the media server as a quiet morning room.**
Today's Aurora is a midnight theater — near-black ground, purple glow, cinematic scale.
Daybreak is the most extreme possible flip: light where Aurora is dark, soft where it is
theatrical, quiet where it is cinematic. Content sits like books on a warm shelf; the
interface whispers. It reads like a beautifully-made reading app that happens to play
films._

Read with [`docs/dev-workflow.md`](../../../docs/dev-workflow.md) — if this direction is
picked it graduates to its own `IMPLEMENTATION_PLAN.md` in this directory, the way
[`option-b/`](../option-b/IMPLEMENTATION_PLAN.md) did.

---

## 1. What Daybreak actually changes

Same features, same data, same routes — different soul. Concretely there are seven
structural moves, and every screen is a consequence of them:

| # | Move | Today (shipped SPA) | Daybreak |
|---|------|---------------------|----------|
| **M1** | **Ground** | `#050505` cosmic dark, glass panels, purple halo/glow | Warm paper `#f6f4ef`; depth is one soft shadow + hairlines. **Light-only** — dark pixels exist solely inside film/poster art (player stage, party strip) |
| **M2** | **Nav** | 240px fixed sidebar (`App.tsx:636`) with footer utilities | No sidebar, no bar: wordmark loose on paper, one floating **pill nav** (7 rooms + "More ▾"), search / bell / profile-switcher chip / avatar on the right |
| **M3** | **Page shell** | Edge-to-edge full-bleed canvas | A bounded **1200px reading column** with real margins — a page, not a canvas |
| **M4** | **Accent system** | Purple `#A855F7` + cyan, semantic emerald/amber/red | Color is scarce: sage (actions), clay (warmth/RSVP), mist (links/info), honey (ratings & pending work) on paper+ink. No gradients in chrome |
| **M5** | **Type** | Bricolage Grotesque + Inter, uppercase labels, display scale to 84px | **Fraunces** serif + **Karla** body, sentence case everywhere, nothing uppercase; page titles 34–40px max, italic serif for whispered asides |
| **M6** | **Numbers** | Counts, percentages and badges everywhere | **De-quantified prose**: "about two hours", "ends around 10:40", "twelve nights running". Exact numerals keep full parity in hovers and the details card — softened presentation, same information |
| **M7** | **Playback surface** | `fixed inset-0 bg-black` player | A listening room: the film floats as a rounded 22px card **on paper**, one hairline scrub, one floating control pill; fullscreen stays the immersive state |

Everything else — copy voice (warm, plain, no exclamation marks), poster titles set in
the lower third of the art, shelf cards with the title *below* the poster, stationery-styled
modals — is these moves re-applied per screen.

## 2. The sixteen screens

01 Sign In · 02 First Run (taste onboarding live) · 03 Who's Watching · 04 Home ·
05 Movies (browse) · 06 Movie Detail · 07 Show Detail (recap open) · 08 Player ·
09 Party — Live · 10 Party — Plan · 11 Search + ⌘K · 12 Requests ·
13 Library / Collections / Calendar · 14 Members & Profiles · 15 Settings · 16 Admin
(13-tab strip, LLM tab open).

## 3. Parity

**Every checklist item is present.** Most are drawn; a deliberate minority are covered by
numbered annotation callouts where drawing them would mean a seventeenth screen or an
impossible double-state. The notable annotation-covered items:

- **Admin tab interiors** other than Dashboard/LLM/Flagged — Users, Libraries, Rooms,
  Requests, Activity, Transcodes, Logs, Server, OAuth, Backup are enumerated field-by-field
  in s16 legend 4.
- **Onboarding welcome step** ("Welcome to Aurora, Maya" + "take me in →") — s2 legend 6.
- **Mobile menu sheet** (below-md nav fold with real search field and profile chip) —
  s4 legend 14.
- **Bell exact unread count** (bare clay dot on the surface; numeral in hover + accessible
  name) — s4 legend 1.
- **Fullscreen player** and cast/AirPlay minimized variants — s8 legends 5–8.
- **Server-status popover** (eight tiles) — s16 legend 1.

Everything else on the checklist — avatar menu, profile switcher chip + dropdown,
add-to-watchlist dialog, the full bug-report letter (attachments, console/network privacy
note, recording pill, filed-as-issue answer) — is drawn, mostly as the "little doors"
callout row at the bottom of s4.

## 4. Palette & type

```
--paper #f6f4ef   --card #fffdf9   --card-2 #efece4   --hairline #e3dfd5
--ink   #23211c   --ink-2 #6f6a60  --ink-3 #a39d90
--sage  #6f7f65   primary accent — actions, active states
--clay  #c26d52   warmth — RSVP, hearts, badges, sign-out
--mist  #7d93a7   dusty blue — links, info
--honey #d9a83c   quiet fourth hue — rating stars, work-still-pending states
radii: 22px cards/modals · 14px posters/inputs · pill controls
shadow: 0 1px 2px rgba(35,33,28,.05), 0 12px 32px rgba(35,33,28,.07)
```

Type: **Fraunces** (opsz, 400–600 + italic) for titles, greetings and numerals-of-honor;
**Karla** 15px/1.6 body. Google Fonts import with full local fallbacks
(Georgia / system-ui) so the file still looks designed when the CDN is blocked.

## 5. Open questions for review

1. **A light-only media server.** Films are mostly watched at night; paper at 10 PM is
   bright. The Settings "Warmth — morning / noon / dusk" tints are the mockup's only
   concession. Is dusk enough, or does Daybreak need an honest lamp-light variant —
   which starts to unwind the thesis?
2. **De-quantified copy is a real module.** "About two hours" / "twelve nights running"
   needs a formatting layer with number-words, plus tooltip parity — and hover doesn't
   exist on touch. Where do the exact numerals live on a phone?
3. **Honey.** The fourth hue is now declared, but it's one accent more than the brief's
   original three. Keep it, or fold stars/pending into clay at reduced opacity?
4. **The pill nav's "More ▾"** holds Collections, Search, Admin and Settings. Search
   also has an icon-pill, but is one-level-hidden Admin acceptable to the keeper?
5. **The windowed player** (film as a card on paper) is the same real playback-surface
   scope option B's plan split into its own phase (D1/7b there) — not a re-skin. Same
   caveat applies here.
6. **Serif in-art poster titles** are a CSS-art convention; real installs show real
   artwork, so the lower-third title band mostly disappears in production. The title-below-
   poster shelf layout is the part that ships.
7. **Fraunces at body-adjacent sizes** (episode rows, 13px serif titles) needs a
   rendering check on Windows/low-DPI before committing to the pairing.
