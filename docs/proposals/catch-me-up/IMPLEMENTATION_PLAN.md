# Catch Me Up — spoiler-safe AI series recaps

**Implementation plan**
Status: ✅ **SHIPPED** (live on `aurorapro.app`) · Author: prepared for Ronnie · Date: 2026-06-10

> **Feature name: “Previously.”** It reframes the universal TV *“Previously on…”*
> cold-open into a personalized, spoiler-safe lockup — *“Previously, on Wednesday.”*
> Instantly understood, elegant, and ownable as an Aurora surface alongside Discover /
> Hero. Internal code stays neutral (`recap`); only user-facing strings say “Previously.”
> Visual prototype: [`mockup-previously.html`](./mockup-previously.html) (open in a browser).
> Alternatives considered: *Recall*, *Recapsule*.

> **Shipped — what landed (and where):**
> - migration [`042_episode_recaps`](../../../migrations/042_episode_recaps.up.sql) — the (show, boundary) recap cache.
> - [`internal/db/queries_recaps.go`](../../../internal/db/queries_recaps.go) — `LastCompletedEpisode`, `RecapEpisodesUpToBoundary`, `GetRecapBoundaryFacts`, `GetCachedRecap`, `UpsertRecap`.
> - [`internal/recap/recap.go`](../../../internal/recap/recap.go) (+ [`recap_test.go`](../../../internal/recap/recap_test.go)) — the service: three-mode selection (grounded / season-closure / caught-up), boundary enforcement, tolerant LLM-JSON parse, single-flight, model+template+mode cache hashing.
> - [`internal/api/recap_handlers.go`](../../../internal/api/recap_handlers.go) — `GET /api/media/{id}/recap` (profile-scoped, degrades gracefully).
> - Completion-hook prebuild in [`phase2_handlers.go`](../../../internal/api/phase2_handlers.go) — finishing an episode warms the next recap.
> - Frontend: the **“Previously”** action in [`DetailRail`](../../../static/redesign/app/src/components/detail/DetailRail.tsx) + the [`RecapModal`](../../../static/redesign/app/src/components/detail/RecapModal.tsx) (spoiler-safe badge, typewriter reveal, friendly unavailable states).
>
> **Shipped across:** #297 (backend prototype) → #298 (fully live: SPA + prebuild) → #303 (smart model + better prompt) → #304 (prompt-template cache busting) → #305 (caught-up mode) → #306 (season-closure mode + adversarial-review hardening). Verified end-to-end against the live server on *Wednesday* S1.

> One of five feature plans drafted together. Siblings:
> [aurora-concierge](../aurora-concierge/), [movie-night-matchmaker](../movie-night-matchmaker/),
> [smart-skip](../smart-skip/), [aurora-rewind](../aurora-rewind/).

---

## TL;DR

You resume *Severance* after three months and have no idea what's going on. **Catch
Me Up** gives you a "Previously, where things stand…" brief — written by the local
LLM from the synopses of the episodes **you have actually finished**, bounded to your
exact resume point so it can never spoil ahead.

**The good news: every input already exists.** Episodes carry an `Overview`
([`models.go:229`](../../../internal/models/models.go)); watch progress is
**per-profile** with a `completed_at` timestamp (migrations
[029](../../../migrations/029_watch_progress_per_profile.up.sql) /
[033](../../../migrations/033_watch_progress_completed_at.up.sql)); the resume point is
already computed for Continue Watching
([`GetContinueWatchingByProfile`, queries_phase2.go:1221](../../../internal/db/queries_phase2.go));
and the LLM client one-shots structured text via
[`ChatJSON` / `ChatJSONWith` (client.go:419)](../../../internal/llm/client.go). The
feature is: **gather the right overviews → one LLM call → cache → a button.**

No mainstream media server (Plex/Jellyfin/Emby) ships AI catch-up recaps. This is a
small surface with an outsized "wow."

---

## 1. What already exists (so we don't rebuild it)

- **Episode metadata** — `Episode{ Number, Title, Overview, AirDate, SeasonID, MediaItemID }`
  ([`models.go:229`](../../../internal/models/models.go)); seasons via `Season`
  ([`:220`](../../../internal/models/models.go)). Fetched by
  `GetSeasons` / `GetEpisodes` / `GetNextEpisode`
  ([`phase2_handlers.go:93/112/177`](../../../internal/api/phase2_handlers.go)).
- **Per-profile watch state** — `watch_progress.profile_id` + `completed` + `completed_at`
  (migrations 029/033). `UpsertWatchProgress`
  ([`queries_phase2.go:1034`](../../../internal/db/queries_phase2.go)) already returns
  `newlyCompleted`, the natural hook to **invalidate/prebuild** a recap.
- **Resume point** — `GetContinueWatchingByProfile`
  ([`queries_phase2.go:1221`](../../../internal/db/queries_phase2.go)) already knows the
  next episode to play; the recap attaches to exactly that card.
- **LLM one-shot** — `ChatJSON(ctx, system, user, schema)` and the model selector
  `ChatModelFast()` ([`client.go:387`](../../../internal/llm/client.go)). Temperature is
  pinned at 0.1 (deterministic). Tolerant JSON parsing lives in
  [`internal/llmjson`](../../../internal/llmjson).
- **Durable per-user surfacing pattern** — the notifications table + dedup index
  (migration [037](../../../migrations/037_notifications.up.sql)) is the template for a
  cached, idempotent, server-written artifact.

**What does *not* exist:** any recap text, any per-show "where things stand" store, or a
spoiler boundary concept.

---

## 2. The core idea — a spoiler boundary that's a number, not a vibe

A recap is unsafe the instant it mentions something past where the viewer is. The
boundary is **the (season, episode) ordinal of the last episode the profile completed**.
We feed the LLM **only** overviews with ordinal `≤ boundary`, and the system prompt
forbids speculation. Because the model only ever sees what the viewer has seen, "no
spoilers" is **structurally guaranteed by the query**, not by trusting the model.

```
profile P resumes show S, about to play S2E5
        │
        ▼
boundary = last COMPLETED episode for (P, S)  ← e.g. S2E4   (watch_progress)
        │
        ▼
overviews = episodes of S with ordinal ≤ S2E4, in air order   (episodes table)
        │  (capped: last N=~12 episodes + a one-line season-1 preamble)
        ▼
LLM (ChatModelFast, temp 0.1):  "Recap where things stand for someone about to
                                  watch the next episode. Use ONLY these synopses.
                                  Never hint at anything not listed."
        │
        ▼
recap text  ──►  cache in episode_recaps (keyed by show + boundary, NOT profile)
        │
        ▼
"Catch me up" button on the resume card  →  GET /api/media/{id}/recap
```

**Key insight on caching:** the recap depends only on `(show, boundary_episode)` — *not*
on the profile. Two users both resuming at S2E4 get the **same** recap, so we cache by
boundary and reuse across the whole household. The profile is used only to *look up the
boundary*, never stored in the recap row (privacy-clean + high hit rate).

---

## 3. Data model — one cache table

```sql
-- migrations/0NN_episode_recaps.up.sql
CREATE TABLE episode_recaps (
  media_item_id     BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE, -- the show
  up_to_episode_id  BIGINT NOT NULL REFERENCES episodes(id)    ON DELETE CASCADE, -- the boundary
  recap             TEXT   NOT NULL,
  model             TEXT   NOT NULL,        -- which model wrote it (for cache-busting on model change)
  source_hash       TEXT   NOT NULL,        -- hash of concatenated input overviews (rebuild if metadata changes)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (media_item_id, up_to_episode_id)
);
```

- **`source_hash`** lets a metadata refresh (TMDB backfill rewriting overviews) transparently
  invalidate a stale recap: if the recomputed hash differs from the stored one, regenerate.
- **`model`** invalidates when the admin switches chat models — keeps recaps consistent.
- No `profile_id`: see §2. The boundary already encodes "how far this viewer has seen."

`down.sql` drops the table. Follows the existing numbered-migration convention exactly.

---

## 4. Backend

### 4.1 New query (`internal/db/queries_recaps.go`)
- `EpisodesUpToBoundary(ctx, showID, boundaryEpisodeID) ([]Episode, error)` — episodes of
  the show in air order with ordinal `≤` the boundary, `Overview` non-empty. Reuses the
  same season/episode joins as `GetEpisodes`.
- `LastCompletedEpisode(ctx, profileID, showID) (*Episode, error)` — the boundary; derived
  from `watch_progress` (per-profile, `completed = true`) joined to `episodes`,
  `ORDER BY season_number DESC, episode_number DESC LIMIT 1`.
- `GetCachedRecap` / `UpsertRecap` — straight CRUD against `episode_recaps`.

### 4.2 Recap service (`internal/recommender/recap.go` or a new `internal/recap` pkg)
- `Build(ctx, profileID, showID) (text string, boundary *Episode, err error)`:
  1. `LastCompletedEpisode`; if none → return a friendly "nothing watched yet" sentinel
     (frontend hides the button).
  2. Compute `source_hash` over the boundary's input overviews; `GetCachedRecap` →
     return on hit (hash + model match).
  3. Build the prompt (system: role + hard no-spoiler rule + "≤150 words, present tense,
     name the key players and open threads"; user: the bounded overview list). Cap inputs
     to the **last ~12 episodes** plus a single synthesized "earlier this series" line so
     a 60-episode show doesn't blow the prompt budget (same prompt-size discipline the
     Discover code learned the hard way —
     [`discover.go` pool-size note](../../../internal/recommender/discover.go)).
  4. `ChatJSONWith(ctx, ChatModelFast(), system, user, recapSchema, structured)` → tolerant
     parse via `llmjson` → `UpsertRecap` → return.
- **Schema:** `{ "recap": string }` (flat — the shape Ollama Cloud honors reliably).

### 4.3 HTTP
- `GET /api/media/{id}/recap` (authed, profile-scoped) → `{ recap, up_to: {season, episode, title}, generated: bool }`.
  Mount beside the other `/api/media/{id}/...` routes
  ([`router.go:682`](../../../internal/api/router.go)).
- **Prebuild hook (optional, phase 2):** when `UpsertWatchProgress` reports
  `newlyCompleted` for an episode, fire-and-forget a goroutine to build the recap for the
  *next* boundary, so the button is instant when they come back. Mirrors how
  gamification piggybacks on the same completion event
  ([`gamification.go` `AwardForWatch`](../../../internal/api/gamification.go)).

### 4.4 Cost & safety controls
- **Gated on the LLM being configured** (same opt-in posture as semantic search/Discover);
  no LLM → no button. Surface via the existing capability flags the SPA already reads.
- **Per-request timeout + single-flight** so a slow model can't stack duplicate generations
  for the same boundary (reuse the `singleflight`/`golang.org/x/sync` already in `go.mod`).
- **Rate-limit** the endpoint per user (the codebase already has limiter middleware, cf.
  `party_ratelimit.go` / `feedback_limiter`).

---

## 5. Frontend

- **Resume card / DetailView:** a subtle "📺 Catch me up" affordance on any show with a
  resume point > 0 and a boundary ≥ 1 completed episode. Lives next to the Resume button
  (`DetailView` in [`static/redesign/app/src/App.tsx`](../../../static/redesign/app/src/App.tsx)).
- **Interaction:** tap → slide-over / modal with a typewriter reveal of the recap and a
  "Start S2E5 ▶" CTA at the bottom (chains into the existing next-episode play flow). On
  cache miss, a 1–3s shimmer; the prebuild hook makes most opens instant.
- **Empty/edge:** brand-new show (no completed episodes) → no button. Fully caught-up
  (resume == latest) → button reads "Recap so far."

---

## 6. Edge cases & decisions

| Case | Handling |
|---|---|
| Overviews missing (sparse metadata) | If < 2 boundary overviews are non-empty, hide the button — a recap from nothing is worse than none. |
| Anthology / non-serial shows | v1 ships for all TV; a future `is_serialized` heuristic can suppress it where recaps add little. Out of scope now. |
| Mid-season resume (S2E5, watched S1 + S2E1–4) | Boundary handles it natively — ordinal compare spans seasons. |
| Movies | Out of scope — recaps are a serialized-TV feature. |
| Model swap by admin | `model` column busts the cache; next request regenerates. |
| Re-watch (user rewinds) | Boundary = *last completed*, unaffected by scrubbing; recap stays stable. |

**Open decision for you:** recap **length/tone** — terse "3 bullet points" vs. a short
narrative paragraph. Recommend a ~120-word paragraph (reads like the cold open of a TV
"previously on"). Easy to A/B via the system prompt.

---

## 7. Effort & phasing

- **Phase 1 (MVP, ~1 focused build):** migration + queries + `recap.go` + the GET endpoint
  + the button/modal. On-demand generation (no prebuild). Fully shippable.
- **Phase 2:** completion-hook prebuild for instant opens; single-flight; rate limit.
- **Phase 3 (nice-to-have):** "Recap the whole season" long-form variant; voice read-out
  reusing nothing new server-side (browser TTS).

**Why it's worth it:** highest ROI of the five — smallest code surface, leans entirely on
data you already have, and it's the kind of feature people screenshot and tell friends
about. Directly reduces the "I forgot where I was, I'll watch something else" drop-off on
half-finished serialized shows.

---

## 8. Out of scope (v1)

- Cross-show "universe" recaps (e.g. MCU watch order).
- Spoiler-tunable recaps ("remind me what happened to character X only").
- Recaps for movies or for content with no episode metadata.
