# Movie-Night Matchmaker — group taste blending

**Implementation plan**
Status: proposal / for decision · Author: prepared for Ronnie · Date: 2026-06-10

> One of five feature plans drafted together. Siblings:
> [aurora-concierge](../aurora-concierge/), [catch-me-up](../catch-me-up/),
> [smart-skip](../smart-skip/), [aurora-rewind](../aurora-rewind/).

---

## TL;DR

Pick two or more profiles, and Aurora finds the titles **everyone** will actually enjoy —
with a one-line AI reason explaining the compromise (*"light enough for Sam, smart enough
for you"*) — then one tap starts a watch party on the winner.

**This is the feature only Aurora can build.** Plex/Jellyfin have no per-user taste
vectors. Aurora has **per-profile taste centroids** already computed and battle-tested
([`ProfileEmbeddingSlice` + `computeTasteCentroids`, centroids.go](../../../internal/recommender/centroids.go)),
the kNN recall they feed
([`NearestUnwatched`, queries_recommender.go:278](../../../internal/db/queries_recommender.go)),
the AI-reason generator
([`rail_reasons.go`](../../../internal/recommender/rail_reasons.go)), and the entire
watch-party launch flow ([`partyH.Create`, party_handlers.go](../../../internal/api/party_handlers.go)).
Matchmaker is **a new recall objective over existing parts**: instead of "near *my*
taste," it's "near the worst-served person in the room."

---

## 1. What already exists (so we don't rebuild it)

- **Per-profile taste vectors** — `BuildProfileVector` (averaged) and `ProfileEmbeddingSlice`
  (un-averaged recency slice) share **one CTE**
  ([`tasteRecentSliceCTE`, queries_recommender.go:103](../../../internal/db/queries_recommender.go)),
  so a profile's taste is a stable, well-defined object. The `minHistoryItems = 3` gate +
  `ErrInsufficientHistory` contract tells us exactly when a profile is "cold."
- **Multi-centroid taste** — `computeTasteCentroids` clusters a profile into 1–3 taste
  modes deterministically ([`centroids.go:79`](../../../internal/recommender/centroids.go));
  `meanNormalized` / `normalizeVec` / `cosineSimilarity` give us the vector math in Go (the
  deployed pgvector can't do scalar multiply — see the **HARD-LEARNED** note in
  [`queries_recommender.go:29`](../../../internal/db/queries_recommender.go)).
- **kNN recall, age-gated + anti-repeat** — `NearestUnwatched(profileID, vectorLit, limit,
  allowedRatings, surface, within)` ([`:278`](../../../internal/db/queries_recommender.go))
  already excludes watched items and respects maturity. **`NearestUnwatchedRich`**
  ([`:368`](../../../internal/db/queries_recommender.go)) returns scoring fields.
- **Interleave/merge + reasons** — `interleaveMerge`
  ([`centroids.go:259`](../../../internal/recommender/centroids.go)) and `rail_reasons.go`
  for the "why this pick" line.
- **Profiles & maturity** — `GetProfilesByUser`
  ([`queries_phase4.go:28`](../../../internal/db/queries_phase4.go)),
  `ProfileMaxAgeRating` ([`queries_recommender.go:229`](../../../internal/db/queries_recommender.go)),
  `AllowedRatingsForMax`.
- **Watch parties** — `partyH.Create` + rooms ([`router.go:964`](../../../internal/api/router.go))
  to launch on the chosen title.

**What does *not* exist:** any notion of combining > 1 profile's taste into a single
recommendation pass.

---

## 2. The core idea — maximize the *minimum* happiness

Two naive blends both fail:

- **Average the centroids** → a muddy midpoint that recommends things *nobody* loves
  (exactly the failure mode multi-centroid recall was built to avoid —
  [`centroids.go:3`](../../../internal/recommender/centroids.go)).
- **Union each person's top picks** → one dominant taste drowns the others.

The right objective is **max-min**: a great group pick is the title whose **worst** fit
across the room is still high. So we score each candidate by the *minimum* cosine
similarity to any participant's nearest taste centroid, and rank by that.

```
profiles [P1, P2, P3]  (the room)
   │  for each: ProfileEmbeddingSlice → computeTasteCentroids → {c11,c12}, {c21}, {c31,c32,c33}
   ▼
candidate pool C = unwatched-by-ALL ∩ allowed-by-strictest-maturity
   │  (recall a generous pool from every centroid, then intersect on "unwatched by everyone")
   ▼
for each candidate x in C:
     fit(x, Pi) = max over Pi's centroids c of  cosineSimilarity(x.embedding, c)   ← Pi's best-case love
     groupScore(x) = min over i of fit(x, Pi)                                      ← the worst-served person
   ▼
rank C by groupScore (tie-break: mean fit, then Aurora quality score)
   ▼
top N  →  AI reason per pick ("light enough for Sam, smart enough for you")
   ▼
[ Start Watch Party ▶ ]  on the chosen title
```

`fit` uses **max over a person's centroids** so a multi-taste viewer counts as satisfied
if the pick hits *any* of their modes (their horror night OR their rom-com night).
`groupScore` uses **min over people** so we never pick something one person will hate.
This is a tiny amount of Go on top of vectors we already produce.

---

## 3. Backend

### 3.1 New query
- `UnwatchedByAll(ctx, profileIDs []int64, allowedRatings []string, limit int) ([]*RailCandidate, error)`
  in `internal/db/queries_recommender.go` — a candidate pool excluding anything **any**
  participant has a `watch_progress` row for, filtered to the **strictest** maturity in the
  room, embeddings non-null, backdrop required (mirrors `NearestUnwatchedRich`'s filters).
  We pull the pool once and score in Go (HNSW recall per-centroid is also fine; a single
  broad pull keeps the max-min scoring simple and avoids N×K queries).
- Reuse `media_items.embedding::text` → `llm.ParseVector` for candidate vectors.

### 3.2 Matchmaker service (`internal/recommender/matchmaker.go`)
- `Blend(ctx, profileIDs []int64, limit int) ([]GroupPick, error)`:
  1. For each profile: `ProfileEmbeddingSlice` → `computeTasteCentroids(kForN(...))`.
     Cold profiles (`ErrInsufficientHistory`) contribute **no constraint** (they're
     "easy to please") but still get age-gated — so a kid's profile in the room still
     clamps maturity even with no taste history.
  2. `UnwatchedByAll` → candidate pool.
  3. Score each candidate with the max-min objective above (pure Go, reusing
     `cosineSimilarity`/`normalizeVec` from `centroids.go`).
  4. Take top N; attach a `groupScore` and per-person `fit` breakdown.
  5. Generate the compromise reason via the existing `rail_reasons` LLM path (one call for
     the whole set), passing the participant display names. LLM-off → a templated reason
     ("A strong match for everyone in the room").
- `GroupPick{ Item *models.MediaItem; GroupScore float64; PerProfileFit map[int64]float64; Reason string }`.

### 3.3 HTTP
- `POST /api/me/matchmaker` `{ "profile_ids": [2,5,7], "limit": 12 }` → `{ picks: [...] }`.
  Authed; **validate every profile_id belongs to the requesting user's account** (reuse the
  ownership check pattern from `profile_handlers.go`). Mount under the `/api/me` group
  ([`router.go:751`](../../../internal/api/router.go)).
- Optionally `GET /api/me/matchmaker/profiles` to list the account's profiles for the picker
  (or just reuse `GET /api/profiles`).

### 3.4 Hand-off to a party
No new code — the chosen `media_item_id` flows straight into `partyH.Create`. Add an
optional `?from=matchmaker` analytics tag if you want to measure the funnel.

---

## 4. Frontend

- **Entry points:** a "Movie night" button on Home and inside the watch-party create flow.
- **Profile picker:** avatars of the account's profiles; tap to add to the room (2–5).
  A "who's watching?" moment that feels native to the Netflix-style profile model already
  in the app.
- **Results:** a rail of group picks; each card shows the compromise reason and a tiny
  "fit" row (e.g. three avatars with a filled ring each) so the *why* is legible. Primary
  CTA per card: **Start Watch Party**.
- Reuses existing poster-card + rail components; no new design system work.

---

## 5. Edge cases & decisions

| Case | Handling |
|---|---|
| One cold profile (no history) | Contributes no taste constraint but still clamps maturity. Group pick leans to the others; reason notes "and a safe bet for new viewers." |
| All profiles cold | Fall back to `PopularUnwatched`-style top-rated, age-gated to the strictest profile. Graceful, never empty. |
| Mixed maturity (adult + kid) | Strictest `max_age_rating` wins — non-negotiable. The whole pool is pre-filtered, so an adult title can't surface in a room with a kid. |
| Tiny library / pool exhausted | Relax "unwatched by ALL" to "unwatched by the strictest-maturity member," then surface with a note. |
| Embeddings off entirely | Feature hidden (it's a vector feature), same posture as Discover/onboarding. |

**Open decision for you:** room size cap. Recommend **2–5** — beyond 5 the max-min objective
collapses toward "blandly safe," which is itself an honest signal but not a fun UX.

---

## 6. Effort & phasing

- **Phase 1 (MVP):** the query + `matchmaker.go` max-min scorer + the POST endpoint +
  picker/results UI. Templated reasons. Fully shippable; tiny code.
- **Phase 2:** LLM compromise reasons; "fit" visualization; start-party hand-off tagging.
- **Phase 3:** "Veto" — let the room thumb-down a pick and re-rank live (reuses the existing
  `item_feedback` 👎 signal already wired into the recency CTE).

**Why it's worth it:** near-trivial code that **showcases the taste-vector moat** and solves
the universal "what do *WE* watch" deadlock — then funnels straight into your strongest
existing feature, watch parties.

---

## 7. Out of scope (v1)

- Persisting "rooms of people" as reusable groups (could later join `watch_party_rooms`).
- Negative-taste repulsion beyond maturity (the recommender is positive-vector kNN by design).
- Blending across *accounts* (privacy surface); v1 is profiles within one account.
