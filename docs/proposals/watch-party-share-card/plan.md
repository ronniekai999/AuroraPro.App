# Watch-party share card — implementation plan

Mockup: [`mockup-share-card.html`](./mockup-share-card.html) (open in a browser —
every length inside a `.card-*` block is the real output pixel value, so the
mockup doubles as the renderer's layout spec).

## What ships

A host schedules a watch party and gets a poster: a 1080×1920 PNG carrying the
media artwork, the start moment pinned to Eastern, who's hosting, and a QR +
six-character code that gets a friend into the room. Downloadable, or handed
straight to the OS share sheet on a phone.

Three crops off one composition:

| Variant | Size | Where it goes |
| --- | --- | --- |
| `story` | 1080×1920 | Instagram/Snapchat Stories, TikTok — the one people post |
| `square` | 1080×1080 | Feeds, Discord drops |
| `og` | 1200×630 | `og:image`, so a pasted party link unfurls into artwork |

## Why server-side Go, not browser canvas

`internal/api/party_share.go` already renders and disk-caches a 1080×1920 party
PNG. It carries the parts that are genuinely hard: an SSRF-guarded poster fetch
(host allowlist re-validated on every redirect), a 5 MB read cap, atomic cache
writes, and a reaper. Rebuilding that in canvas would duplicate the security
boundary and still not produce an image a social crawler can fetch.

The existing renderer is also **the right thing to extend rather than sit
beside**: it has no SPA consumer today (nothing in `static/redesign/app/src`
references `share-image`), so it is effectively dead-ended behind a URL nobody
is given. The new card supersedes it; the old route stays registered as an alias
for one release, then goes.

What the existing renderer does *not* have, and this feature adds: the schedule,
the host, brand typography, and any of the Aurora look — today it is a poster
and four lines of Go's default typeface on a flat background.

## Surface

```
GET  /api/parties/{code}/card.png?v={story|square|og}&t={token}   public, token-gated
GET  /api/parties/{code}/card-links                               authed, host-only
```

`card-links` returns the signed URLs the SPA renders and copies:

```json
{
  "story":  "https://aurorapro.app/api/parties/7K2QD9/card.png?v=story&t=Xk9…",
  "square": "…?v=square&t=Xk9…",
  "og":     "…?v=og&t=Xk9…",
  "page":   "https://aurorapro.app/p/7K2QD9"
}
```

### Security model

The image endpoint must stay unauthenticated — a crawler unfurling a link cannot
log in. But the card is a real increment over what `share-image.png` exposes
today: it adds a **person's name** and **where they'll be at a specific time**.
Publishing that on a blind `{code}` guess is not a trade we should make silently.

So: `t` is a stateless HMAC tag, `base64url(HMAC-SHA256(cfg.Auth.JWTSecret,
"partycard:v1:" + code))[:16]`. Unguessable, no migration, no new table, stable
for the life of the code, and mintable only by an authenticated host through
`card-links`. Compare with `hmac.Equal`. A wrong or absent tag 404s (not 403 —
a 403 confirms the code exists).

Alongside that:

- **Only the host appears.** Invitee names never render — a party is other
  people's plans too, and the RSVP roster is already treated as private
  (`party_invite_handlers.go` filters `declined` rows at the API, not just in
  the UI). The card shows host display name + `memberSafeAvatar` avatar, never
  username-as-identity, email, or role.
- **Host consent is the button.** The host generating and sharing the image is
  the consent event. Nothing auto-publishes.
- Rate-limit the public route per IP using `internal/auth/ratelimit.go`, so the
  token can't be brute-forced and the renderer can't be used as a CPU sink.

## Render pipeline

One `compose(variant, data)` over shared primitives, all on `golang.org/x/image`
(already a dependency at v0.43.0 — no new modules):

1. **Ground** — fill `#050505`.
2. **Aurora curtain** — the signature, and the one piece worth doing properly.
   Three rotated bands filled with the `.aurora-ring` sweep
   (`#A855F7 → #818CF8 → #22D3EE`). Render each at 1/8 scale into a small RGBA,
   3× box blur (a box blur run three times is a close enough Gaussian and is
   O(n) per pass), then upscale with `xdraw.CatmullRom` — which the file already
   imports. Blurring at full 1080×1920 would be ~30× the work for no visible
   gain.
3. **Starfield** — 16 specks from a PRNG seeded on the party code, so a given
   party's card is stable across re-renders but two parties differ.
4. **Poster** — reuse `fetchPosterImage` unchanged (that is the SSRF boundary;
   do not fork it). Round the corners with a `vector.Rasterizer` alpha mask via
   `draw.DrawMask`; drop a blurred violet rounded-rect underneath for the bloom.
5. **Type** — `font.Drawer` as today.
6. **Gradient text** for the time and the brandline: draw the string into an
   `image.Alpha` (it satisfies `draw.Image`), then `draw.DrawMask` a gradient
   through it. This is what makes the time read as designed rather than as flat
   white.
7. **Grain** — deterministic low-alpha noise so the large flat gradients don't
   band on a phone screen.
8. **QR** — `github.com/skip2/go-qrcode`, already vendored for
   `party_qr.go`; borderless, white modules on transparent, encoding
   `https://<host>/join/{CODE}`. Reuse `party_qr.go`'s Host-header validation —
   the same header-injection defense applies verbatim.

Budget: ~2.1 M pixels × a handful of layers, generated once per party and
cached. Tens of milliseconds.

### Fonts — the one real gotcha

The card must be set in Bricolage Grotesque + Inter (`--font-display` /
`--font-sans`) or it isn't on brand. Two constraints collide:

- `static/redesign/app/src/fonts/*.woff2` **cannot be used** —
  `x/image/font/opentype` reads TTF/OTF, not WOFF2.
- Those files are also **variable** fonts, and `opentype` renders only the
  default instance (weight 400). Shipping the variable TTF would silently give
  us Regular everywhere the design calls for 700/800.

So vendor **static instances**: `BricolageGrotesque-ExtraBold`,
`BricolageGrotesque-Bold`, `Inter-Regular`, `Inter-Medium`, `Inter-Bold`, under
`internal/api/assets/fonts/` with `go:embed`. Both families are SIL OFL 1.1 —
redistributable, and the license file ships alongside them. Cost: roughly
0.5–1 MB of binary.

Titles containing runes outside those fonts' coverage (CJK, Cyrillic) fall back
to the existing `gofont` faces for the whole string rather than rendering tofu
boxes. Known limit, worth stating rather than discovering.

### Time, and the "EST" question

Pin to `America/New_York` and print the abbreviation the zone **actually
resolves to at that instant** — `Format("3:04 PM MST")` yields `EDT` from March
to November and `EST` from November to March.

August 15 in New York is EDT. Printing a literal "EST" on a summer party is an
hour-wrong instruction to anyone who does the conversion, which is the one thing
a share card must not be. The date and time stay Eastern regardless of where the
host or the viewer is — that's the house timezone, as asked.

Add `import _ "time/tzdata"` to `cmd/aurora/main.go`. Nothing in the codebase
calls `LoadLocation` today, so the binary currently depends on the host's
zoneinfo database existing; embedding the IANA tables (~450 KB) makes the card
correct on any box.

### Caching and the stale-poster trap

Today's key is `<code>.png`. That is wrong the moment a host reschedules — they
would keep handing out a poster advertising the old time.

Key on the inputs instead:

```
<cacheDir>/party-card/<code>-<variant>-<fp>.png
fp = sha256(scheduledStartAt | mediaTitle | mediaPoster | hostName | code)[:8]
```

A reschedule changes `fp`, so the next request renders fresh and the stale file
simply ages out. Extend `reapOnce` to sweep `party-card/` alongside
`party-share/`, and make `InvalidateCache` glob `<code>-*`.

Worth noting while we're here: `InvalidateCache` has **no callers** —
`manager.go:2780` records that wiring it in was left as a follow-up. The reaper
is the only cleanup in the system today. This plan does not depend on fixing
that (the fingerprint makes staleness self-correcting), but it's the right
moment to close it.

### Eligibility

The card renders for any party in manager state. Scheduled parties
(`ScheduledStartAt != nil`) get the date/time block; a live party gets a
`LIVE NOW` treatment in the same slot. One code path, no 404 for the live case.

Scheduled parties survive restarts already — `internal/watchparty/rehydrate.go`
re-arms them at boot — so `GetPartyState(code)` is a sound source for a party
booked days out.

## SPA

- **`PartyShareCardModal.tsx`** (new) — format tabs, preview, `Download PNG`,
  `Share…`, `Copy link`. `Share…` uses the Web Share API with the PNG as a
  `File` so a phone opens the native sheet straight into Instagram or Messages;
  desktop falls back to download.
- **`PartyComposerModal.tsx`** — after a successful *scheduled* create, the
  success state offers the card. This is the moment of intent.
- **`PartyLobbyCard.tsx`** — one `Share card` button in the existing host-only
  button row (alongside `Start now` / `Change time`), so a host can come back
  for it any time before showtime.
- **`lib/partyShare.ts`** — fetch `card-links`, download helper, Web Share
  capability probe. Pure, unit-testable.

## Tests

`party_share.go` currently has no test file at all. New code lands with:

- Eastern formatting across the DST boundary — a March and a November instant,
  asserting `EDT` / `EST` and the correct local clock time.
- Cache key changes when the schedule moves; unchanged when nothing moves.
- Token: valid tag renders, wrong/absent tag 404s, tag is stable per code.
- Host-only: non-host gets 403 from `card-links`.
- No invitee name appears in rendered output for a party with a roster.
- Poster host allowlist still rejects a non-allowlisted URL and a redirect to
  one (reuse the existing table pattern).
- Rune-safe truncation on a multi-byte title (the existing `drawCenteredText`
  contract).
- Smoke: each variant decodes as PNG at the declared dimensions and is not a
  single flat color.

## Phasing

**Phase 1 — the ask.** Story variant, `card.png` + `card-links`, HMAC token,
fonts, tzdata, fingerprinted cache, share modal wired into the composer's
scheduled-success state and the lobby card. Tests above.

**Phase 2 — reach.** Square + OG variants, Web Share API file path, `LIVE NOW`
treatment.

**Phase 3 — unfurl.** `og:image` / `og:title` / `twitter:card` on `/p/{CODE}`.
This one has prerequisites worth surfacing early: Aurora ships **no Open Graph
tags anywhere** today, and `robots.txt` disallows everything (`router.go`, added
deliberately after 1,139 crawler 404s). Making links unfurl means serving a
small crawler-facing HTML shell for `/p/{CODE}` and carving that one path out of
the disallow — a deliberate change to "Aurora is not indexed", and the reason
it's phased separately rather than folded into Phase 1.

## Open decisions

1. **Literal "EST" vs. the true abbreviation.** Plan assumes true (`EDT` in
   summer). Say the word and it prints "EST" year-round.
2. **Retire `share-image.png`?** It has no consumer. Recommend: alias for one
   release, then delete.
3. **Phase 3 at all** — it's the strongest viral mechanism (every pasted link
   becomes artwork) but it's also the first crack in "nothing here gets
   crawled". Worth a separate yes.
