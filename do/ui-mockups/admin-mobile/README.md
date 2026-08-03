# Aurora admin on mobile — three PWA concepts

_Companion to [`index.html`](index.html) (10 device screens at a true 390×844, zero
production code touched). Three alternative answers to one question: **how should the
thirteen admin tabs behave on a phone?**_

Read with [`docs/dev-workflow.md`](../../../docs/dev-workflow.md) — whichever concept is
picked graduates to its own `IMPLEMENTATION_PLAN.md` in this directory, the way
[`option-b/`](../option-b/IMPLEMENTATION_PLAN.md) did.

---

## 1. The PWA already exists

This is the part worth establishing before comparing designs, because it changes the size
of the job. Aurora **already ships an installable, push-capable PWA.** Nothing below
proposes a second app, an app-store listing, or a native wrapper.

| Piece | Where | State |
|---|---|---|
| Web app manifest | `static/redesign/app/public/manifest.webmanifest` | Ships. `display: standalone`, `scope: /v2/`, `id: /v2/`, theme `#050505` |
| Icons | `public/icon-{192,512}.png`, `icon-maskable-{192,512}.png`, `apple-touch-icon.png` | Ships. Both `any` and `maskable` purposes |
| Service worker | `public/sw.js` | Ships. Registered, `skipWaiting` + `clients.claim` |
| Push notifications | `sw.js` push handler + `internal/push/payload.go` | Ships. Declarative-web-push envelope, iOS ≥ 18.4 renders without waking the worker |
| Admin authorization | `internal/api/admin_handlers.go` and friends | Ships. Every admin route is gated server-side |

Note `sw.js` **deliberately has no `fetch` handler and no caches** — the server atomically
replaces the SPA bundle on every deploy (up to every 5 minutes via `aurora-update.timer`),
so a cached asset would outlive the bundle it came from. A repo test pins the absence of a
fetch listener. Offline admin is therefore *out of scope by design*, and none of the three
concepts assume it.

### 2. So what's actually missing

One thing: **`AdminView.tsx` is desktop-first.**

- 2,884 lines carrying roughly **ten** responsive utilities total.
- A **thirteen-item horizontal tab strip** (`ADMIN_TABS`, line 2164) built for a 1440px
  viewport and an ARIA roving-tabindex keyboard model.
- Two `<table>` elements — Active Streams (7 columns) and the users table — that run off
  the side of a 390px screen.
- Modals sized `max-w-3xl` with `pt-24`, e.g. the session Diagnose dialog.

Everything those tabs render is already fetched by API clients that work fine on a phone.
The gap is layout, not data and not auth.

### 3. The thirteen tabs, for reference

`dashboard · users · libraries · rooms · requests · activity · sessions (labelled
"Transcodes") · flagged · logs · server · llm · oauth · backup`

---

## 4. The three concepts

| | **A · Ops Console** | **B · Triage** | **C · Command Deck** |
|---|---|---|---|
| Navigation | Bottom tab bar, 5 destinations | Single severity feed + browse sheet | One surface, collapsible panels |
| Best at | Doing any admin task, anywhere | Reacting fast to what broke | Seeing everything at once |
| Taps to a stuck transcode | 3 | **0** — it's on screen one | 1 |
| Full 13-tab parity | **Complete** | Via the sheet | **Complete** |
| Uses the existing push | Badge counts only | **Deep-links to the card** | Badge counts only |
| Tablet / landscape | Tab bar wastes width | Feed centers, fine | **Reflows to two columns free** |
| New concepts to learn | **None** | Severity model, swipe | Palette, accordion density |
| Build effort | **Low** — layout refactor | Medium — severity rules + feed endpoint | Medium — palette + panel system |
| Main risk | "More" becomes a junk drawer | Alert fatigue if thresholds are wrong | Tap targets and a11y at this density |

### A · Ops Console

Keep all thirteen tabs; fold them into five thumb-reachable destinations behind a standard
bottom tab bar. Tables become stacked cards.

```
Home    ← dashboard
People  ← users, invite codes, referrals
Media   ← libraries, rooms, requests
Live    ← transcodes, activity, logs
More    ← server, LLM, OAuth, backup, flagged
```

The most conventional answer, and the cheapest: mostly a layout refactor of components
that already exist and already fetch the right data. Its weakness is visible in the fourth
screen of the mockup — five of thirteen sections land in one undifferentiated "More" list.

### B · Triage

Inverts the premise. Instead of asking you to navigate, the phone shows **what needs you,
worst first**, and puts the fix on the same card: a severity-ranked feed where a held
request can be approved with a swipe and a failed transcode killed without opening
anything. Everything else lives behind a browse sheet.

This is the concept that pays off the push pipeline already in `sw.js` — that payload
carries a `navigate` link per notification, so a tap can land on the exact actionable card.
The cost is that someone has to define the severity model, and thresholds need tuning or
the feed becomes noise.

### C · Command Deck

A live vitals strip pinned to the top, every section on one scrolling surface as a
collapsible panel — no navigation at all — and a command palette on the thumb for
jump-to-anything plus bulk actions ("kill all transcodes", "scan all libraries"). Density
is preserved deliberately: tables stay tables and scroll inside their own card, so the page
body never scrolls sideways.

The single-surface model is also the only one of the three that reflows to a tablet or a
desktop side panel without a second layout to maintain.

---

## 5. Recommendation

**Build A, then add B as its Home tab.**

A gets a working mobile admin surface with full parity for the least risk, because it is
largely a layout pass over existing components. Once it's in, the triage feed slots into
the *Home* destination in place of a static dashboard — and that's the piece that makes the
push notifications Aurora already sends worth tapping.

Reach for C instead if the admin surface is wanted on a tablet or as a desktop side panel,
since its one-surface model covers phone, tablet and wide screens with the same code.

## 6. What none of these need

No backend work, no API changes, no new data, no new authorization. Every field shown in
the mockups is drawn from types that already exist — `ServerStats`, `AdminUser`,
`ActiveStreamRow`, `MediaRequest`, `Room`, `LogEntry`, `ActivityEntry` in
`static/redesign/app/src/lib/api.ts`.

The one exception is concept B, which would want a small aggregate endpoint (say
`GET /api/admin/attention`) so the feed is one request instead of six — and a severity
policy to go with it. That is the extra work B is asking for, and it is the reason the
recommendation sequences it after A rather than instead of it.

---

## 7. About the mockup file

`index.html` is self-contained: no build step, no external images, no scripts. All artwork
is CSS and inline SVG. Design tokens are copied from production (`src/index.css`) rather
than invented — `#050505` ground, `#A855F7` purple, `#22D3EE` cyan, the glass panel and
purple halo, Bricolage Grotesque + Inter. Semantic state colour (emerald / amber / red) is
kept deliberately off the accent hue so "needs attention" never reads as "branded".

Device frames are drawn at a true 390 × 844 and CSS-scaled, so every measurement inside a
screen is a real device pixel and the layouts can be checked against tap-target minimums.

The Google Fonts `@import` is progressive enhancement only; the type scale is tuned against
the declared system fallback stack for contexts where a font CDN is blocked.
