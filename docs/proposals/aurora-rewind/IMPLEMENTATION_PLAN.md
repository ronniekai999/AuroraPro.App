# Aurora Rewind — a shareable, AI-narrated taste recap

**Implementation plan**
Status: proposal / for decision · Author: prepared for Ronnie · Date: 2026-06-10

> One of five feature plans drafted together. Siblings:
> [aurora-concierge](../aurora-concierge/), [catch-me-up](../catch-me-up/),
> [movie-night-matchmaker](../movie-night-matchmaker/), [smart-skip](../smart-skip/).

---

## TL;DR

"Spotify Wrapped, for your library." A recap for any window (the year, a season, "since you
joined"): hours watched, top genres, your **embedding-derived taste fingerprint**, an
AI-written paragraph about your year in film, a surprising stat or two, and a freshly
unlocked badge — rendered to a **shareable image**.

**The unlock: you already generate share images server-side.** The watch-party share-image
renderer ([`party_share.go`](../../../internal/api/party_share.go)) already composites
posters + text into a PNG with embedded Go fonts, an SSRF host-allowlist, and a cache+reaper.
Rewind is **a new render template over that exact machinery**, fed by watch history +
gamification + embeddings you already compute.

---

## 1. What already exists (so we don't rebuild it)

- **Server-side image composition** — `PartyShareHandler` renders PNGs with
  `image/draw` + `golang.org/x/image/draw` + embedded `gofont` faces
  (`initFonts`, [`party_share.go:219`](../../../internal/api/party_share.go)), a poster
  fetch with an **`image.tmdb.org` host allowlist**
  ([`isShareImageHostAllowed`, :53](../../../internal/api/party_share.go)), and a cache dir
  + background reaper ([`runReaper`, :161](../../../internal/api/party_share.go)). This is
  ~80% of Rewind's hardest part, already shipped and security-reviewed.
- **Watch history** — `GetWatchHistory`
  ([`queries_phase4.go:604`](../../../internal/db/queries_phase4.go)),
  `GetRecentlyWatched` ([`:577`](../../../internal/db/queries_phase4.go)), per-profile with
  `completed_at` (migration [033](../../../migrations/033_watch_progress_completed_at.up.sql))
  — so windowed aggregation ("this year") is a `WHERE completed_at BETWEEN …`.
- **Gamification** — XP/levels/streaks/achievements
  ([`gamification.go`](../../../internal/api/gamification.go),
  [`queries_gamification.go`](../../../internal/db/queries_gamification.go)); a Rewind reveal
  can **unlock a dedicated achievement** ("Wrapped 2026"). Achievement defs are code, not a
  migration ([`gamification.go:59`](../../../internal/api/gamification.go)) — trivial to add.
- **Taste fingerprint** — the same per-profile centroids
  ([`computeTasteCentroids`](../../../internal/recommender/centroids.go)) that power
  recommendations describe a viewer's taste modes; we can name them (LLM) into a
  fingerprint ("Cerebral sci-fi · Cozy comedies · Twisty thrillers").
- **Genres** — `media_genres` junction (migration 001) for the "top genres" ring.
- **LLM narrative** — one `ChatJSON` call ([`client.go:419`](../../../internal/llm/client.go))
  turns the stats into a warm paragraph.

**What does *not* exist:** any time-windowed aggregate report, the Rewind render template, or
a "Wrapped" achievement.

---

## 2. The core idea — aggregate → narrate → render, all from existing parts

```
window W (e.g. 2026-01-01 .. now), profile P
        │
        ▼
 AGGREGATE (one SQL pass over watch_progress + media_genres):
   hours watched · titles + episodes finished · top genres · busiest month ·
   longest streak · night-owl count · first & favorite title · new-vs-rewatch
        │
        ▼
 FINGERPRINT: computeTasteCentroids(P) → LLM names each mode (≤3 short labels)
        │
        ▼
 NARRATE: ChatJSON(stats + labels) → ~60-word "your year in film" paragraph
        │  (LLM-off → a templated paragraph; Rewind still works)
        ▼
 RENDER: reuse the party-share PNG compositor → a Rewind card
   (poster collage of top titles + the headline number + fingerprint chips + badge)
        │
        ▼
 GET /api/me/rewind            → JSON (for an in-app animated reveal)
 GET /api/me/rewind/card.png   → the shareable image  (cached + reaped)
        │
        ▼
 Unlock "Wrapped" achievement on first view (XP via the existing engine)
```

Everything in the RENDER box is the party-share machinery with a new layout function.
Everything in AGGREGATE is one query. The only new "intelligence" is two small LLM calls,
both optional.

---

## 3. Backend

### 3.1 Aggregation query (`internal/db/queries_rewind.go`)
- `RewindStats(ctx, profileID int64, from, to time.Time) (RewindStats, error)` — a single
  query (or a few) over `watch_progress` (per-profile, `completed_at` in window) joined to
  `media_items` + `media_genres`:
  - total finishes (movies vs. episodes), estimated hours (sum of runtimes),
  - top N genres with counts, busiest month, longest daily streak in window (the
    gamification streak logic already computes distinct UTC watch-days — reuse it),
    night-owl count (midnight–4am, mirroring the existing `night_owl` achievement),
  - first title of the window + most-rewatched, new-vs-rewatch split.
- All numbers come from real rows — **no fabrication**, which matters for a shareable artifact.

### 3.2 Rewind service (`internal/rewind/rewind.go`)
- `Build(ctx, profileID, from, to)`:
  1. `RewindStats`.
  2. Fingerprint labels — `computeTasteCentroids` → one `ChatJSON` mapping centroids'
     nearest titles to ≤3 short labels (cap the prompt; reuse the proven-safe size band).
  3. Narrative — one `ChatJSON` over the stat block → ≤60-word paragraph (temp 0.1; tolerant
     parse). Templated fallback when LLM is off.
- Cache the JSON per `(profile, from, to)` — for an annual Rewind it's effectively immutable
  once the year closes.

### 3.3 Image render (`internal/api/rewind_card.go`)
- A new `renderRewindCard(stats, labels) ([]byte, error)` that **reuses** the
  `party_share.go` font init, the poster-fetch + host-allowlist, the scaler, and PNG encode.
  Refactor the shared bits (font faces, `fetchPoster`, allowlist, cache/reaper) into a small
  internal helper both handlers call, so we don't fork the security-sensitive poster fetch.
- Layout: dark Aurora-branded card (`#050505` bg, `#A855F7` purple, `#facc15` gold accents —
  the tokens the mockups already use), a 3–5 poster collage of top titles, the hero number
  ("**142 hours**"), fingerprint chips, and the unlocked badge.

### 3.4 HTTP
- `GET /api/me/rewind?from=&to=` → JSON. Defaults to the current calendar year.
- `GET /api/me/rewind/card.png?from=&to=` → cached PNG (mirror `ServeShareImage`'s
  cache-key + reaper handling, [`party_share.go`](../../../internal/api/party_share.go)).
- Mount under `/api/me` ([`router.go:751`](../../../internal/api/router.go)). Authed,
  profile-scoped, rate-limited.
- **Achievement unlock** on first `GET /api/me/rewind` — add `wrapped_2026` (or a generic
  `rewind_viewed`) to `achievementDefs` ([`gamification.go:59`](../../../internal/api/gamification.go))
  and grant via the existing engine.

### 3.5 Privacy
- The PNG is served to the **authed owner**; sharing is the user copying/downloading it
  deliberately (like the party share image). No public unauthenticated Rewind URL in v1
  (the party share path's host-allowlist + token discipline is the precedent to follow if a
  public link is ever added).

---

## 4. Frontend

- **In-app reveal:** a swipeable, animated story sequence (Wrapped-style cards) driven by
  `GET /api/me/rewind` — one stat per card, building to the taste-fingerprint and the
  narrative. Pure SPA animation over the JSON.
- **Share:** a "Share my Rewind" button surfaces the `card.png` (download / native share
  sheet on mobile).
- **Entry points:** a seasonal banner on Home (December → "Your 2026 Rewind is ready"), and
  an always-available "Year in review" in profile settings (defaulting to the current year,
  with a window picker).

---

## 5. Edge cases & decisions

| Case | Handling |
|---|---|
| Sparse history (new user) | Below a threshold of finishes, show a "come back at year-end" teaser instead of a thin card. |
| Embeddings off | Skip the fingerprint chips; everything else (hours, genres, narrative) still renders. |
| LLM off | Templated narrative; Rewind fully functional. |
| Poster fetch fails | Reuse the share renderer's gradient fallback (already handles broken posters). |
| Profile vs. account | Rewind is **per-profile** (taste + history are per-profile); a "household Rewind" merging profiles is a possible phase 3. |
| Time zone for "year" | Use the server's local day boundary, consistent with the gamification streak logic. |

**Open decision for you:** **windowing** — annual-only, or arbitrary windows (season, "since
you joined")? Recommend shipping **annual + "all time"** first; arbitrary ranges are a cheap
follow-on since the query is already parameterized by `from/to`.

---

## 6. Effort & phasing

- **Phase 1:** `RewindStats` query + `GET /api/me/rewind` JSON + the in-app reveal +
  templated narrative + the "Wrapped" achievement. No image yet — already delightful.
- **Phase 2:** the share `card.png` (refactor party-share helpers → shared module, add the
  Rewind layout) + LLM narrative + fingerprint labels.
- **Phase 3:** household/merged Rewind; seasonal/auto-generated notifications ("Your Rewind
  is ready" via the existing notifications table, migration
  [037](../../../migrations/037_notifications.up.sql)).

**Why it's worth it:** retention + **free growth** — a shareable artifact users post publicly,
built almost entirely from machinery you've already shipped (history, gamification,
embeddings, and — critically — the server-side image compositor).

---

## 7. Out of scope (v1)

- Public, unauthenticated Rewind links.
- Video/animated export (still PNG share card in v1).
- Cross-install leaderboards.
