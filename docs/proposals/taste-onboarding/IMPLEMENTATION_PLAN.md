# Taste Onboarding — "Pick What You Love"

**Implementation plan + mockup**
Status: proposal / decisions locked, ready to build · Author: prepared for Ronnie · Date: 2026-06-07

Mockup (open in any browser, no build needed):
- [`mockup-pick-what-you-love.html`](./mockup-pick-what-you-love.html) — the full screen with all v1 twists wired up (selection, vibe chips, reactive grid, instant preview)

---

## Decisions locked (2026-06-07)

| # | Decision | Choice | Consequence baked into this plan |
|---|---|---|---|
| 1 | Embeddings-off behavior | **Vector-only** (no genre fallback) | The screen **only triggers when the library is embedded** (`library_embedded`). Embeddings-off installs never see onboarding and stay on today's popular-fallback. |
| 2 | Seed lifetime | **Natural fade** | Seeds carry a fixed `created_at`; real watches outrank them and push them out of the top-20 window over time. No expiry job. |
| 3 | Picks → Favorites | **Yes** | `POST /seeds` mirrors the picks into the profile's `favorites` watchlist. |
| 4 | Minimum picks | **5** | "Done" unlocks at 5. The vector is computable at 3, so the **instant-preview rail appears at 3 and sharpens through 5**. |

Out of scope for v1 (own follow-up): negative/"not for me" signal — the recommender is pure positive-vector kNN with no repulsion term.

---

## TL;DR

You want the Netflix/Plex "pick a few titles you love" onboarding screen — **but built so Aurora's AI recommendations work out of the box** for a brand-new profile, with our own twist.

**The good news: you already shipped ~90% of the recommendation engine.** Hero picks, the recommendations rail, Discover, and "Because You Watched" rails *all* derive from **one function** — `BuildProfileVector()` ([`internal/db/queries_recommender.go:65`](../../internal/db/queries_recommender.go)) — which averages the embeddings of a profile's recently-watched titles into a single taste vector. It refuses to personalize until there are **≥3 embedded watched items** ([`minHistoryItems = 3`](../../internal/db/queries_recommender.go)); below that, *every* surface falls back to a generic "popular" pool. **That fallback is the cold-start gap, and it's the entire problem this feature solves.**

So the feature reduces to one sentence:

> **Give `BuildProfileVector` something to chew on the moment a profile is born — and every AI surface lights up at once.**

The "Pick What You Love" screen is just the UX that collects that seed. Mechanically it's: **one new table (`taste_seeds`), three surgical SQL edits, a handful of small endpoints, and one React screen.** No recommender-logic rewrite — hero rerank, Discover curation, and anchor rails keep working untouched.

**Our twist (v1):**
1. **Instant preview at pick #3** — a live "you'll love…" rail appears *inside* the screen the moment the picks are vector-computable, and sharpens as they add more (Done at 5).
2. **Diversity-sampled grid** — the grid spans the taste space (not 5 lookalike blockbusters), so the picks yield a sharp vector.
3. **Reactive grid** — unselected posters re-rank toward what they're tapping.
4. **Vibe chips** — mood chips as an on-ramp, resolved against this library's embeddings.

---

## 1. What already exists (so we don't rebuild it)

From a read of the codebase:

**The recommender — one keystone, four surfaces**
- **`BuildProfileVector(profileID)`** ([`queries_recommender.go:65`](../../internal/db/queries_recommender.go)) — averages the embeddings of the profile's **20 most-recent watched** titles (`ORDER BY wp.completed DESC, wp.updated_at DESC LIMIT 20`) into a pgvector text literal. Returns `ErrInsufficientHistory` when fewer than **3** embedded items exist.
- **`PersonalizationThreshold()` = 3** and **`PersonalizationHistoryCount()`** ([`:103`](../../internal/db/queries_recommender.go), [`:126`](../../internal/db/queries_recommender.go)) — the public gate + the count the UI uses for "watch N more to unlock" hints.
- **`NearestUnwatched(profileID, vec, n)`** ([`:133`](../../internal/db/queries_recommender.go)) — kNN over `media_items.embedding <=> vec`, **excluding anything with a `watch_progress` row**, deduped cross-library on `tmdb_id`, backdrop-required.
- **`PopularUnwatched()`** ([`~:430`](../../internal/db/queries_recommender.go)) — the cold-start fallback (top-rated, no embedding needed).
- Consumers, all keyed on `profile_id`: `Hero.PoolFor` / `RailFor` ([`recommender/hero.go`](../../internal/recommender/hero.go)), `DiscoverFor` ([`discover.go`](../../internal/recommender/discover.go)), `AnchorRailsFor` ([`anchor_rails.go:61`](../../internal/recommender/anchor_rails.go)) — surfaced at `GET /api/me/hero`, `/api/me/recommendations`, `/api/me/discover`, `/api/me/anchor-rails` (`internal/api/router.go`).
- **`Hero.Invalidate(profileID)`** ([`hero.go:399`](../../internal/recommender/hero.go)) — clears the per-profile hero/discover caches (both 24h TTL). We must call this after a seed write or the first post-onboarding load serves the stale cold-start pool.

> **Load-bearing comment to respect:** `BuildProfileVector` carries a long "**do not 'improve' this back to weighted math**" note (the deployed pgvector predates `vector * scalar`). Our seeds enter the *unweighted top-20 slice* — there's nothing to weight, so we stay clear of that landmine.

**Embeddings (required for this feature to trigger — decision #1)**
- `media_items.embedding vector(384)` + HNSW cosine index (migration 014); generated by [`internal/embedding`](../../internal/embedding) (`EmbedItem`, `BuildText`, `RunBackfill`) via Ollama `nomic-embed-text`.
- The README is explicit that this is opt-in ("Semantic search: Local LLM embeddings via Ollama (optional)"). Per **decision #1 (vector-only)** we don't try to personalize without it: the onboarding screen is **gated on the library having embeddings**, and embeddings-off installs keep today's popular behavior.

**Profiles, lists, metadata (all reusable)**
- **Multi-profile**, Netflix-style — watch history, age rating, and the taste vector are **per `profile_id`** (`user_profiles`, migration 006). Onboarding is therefore **per-profile**, and `user_profiles.max_age_rating` already exists to age-filter a kid profile's grid.
- **Watchlists** with `list_type IN ('want_to_watch','favorites','custom')` (migration 006) — picks mirror into **Favorites** (decision #3).
- **Genres** via `media_genres` junction + `genres` (migration 001) — still useful as the cheap *diversity* axis for the grid (§4), independent of any embeddings-off path.
- **XP/achievements granted on *completed watches*** (migration 023) — this is exactly *why* we must **not** fake watch history (see [§3](#3-the-seed-mechanism-a-table-not-fake-history)).

**Frontend** — React + TS + Vite + Tailwind/shadcn SPA in [`static/redesign/app/src`](../../static/redesign/app/src). `App.tsx` is the state-driven router; `lib/api.ts` exposes `apiFetch()` (Bearer header + silent 401-refresh). There is **no onboarding route today** — auth drops straight to home.

**What does *not* exist yet:** any explicit taste/preference store, any onboarding screen or completion flag, and any negative ("not for me") signal.

---

## 2. Architecture — seed one function, light up four surfaces

```
   "Pick What You Love"  (new React screen, per profile, gated on library_embedded)
            │  POST /api/onboarding/seeds  { media_ids: [5+] }
            ▼
   ┌─────────────────────┐        writes
   │   taste_seeds        │◄───────────────  + mirror picks into Favorites watchlist
   │ (profile_id,         │                  + recommender.Invalidate(profileID)
   │  media_item_id,      │
   │  source, created_at) │
   └─────────┬───────────┘
             │  UNION ALL into the "recent" CTE  (one edit)
             ▼
   ┌───────────────────────────────┐
   │  BuildProfileVector(profile)   │   ← the keystone. Now satisfied at t=0.
   │  avg(embedding) of seeds ∪     │
   │  watches, top-20 by recency    │
   └───────────────┬───────────────┘
                   │  (same vector every surface already consumes)
     ┌─────────────┼─────────────┬──────────────────┐
     ▼             ▼             ▼                  ▼
  /api/me/hero  /api/me/      /api/me/          /api/me/
   (PoolFor)    recommend-     discover          anchor-rails
                ations        (DiscoverFor)     (AnchorRailsFor)
   ALL FOUR are personalized on first load — zero changes to their logic.
```

The whole value proposition is that arrow fan-out: because the surfaces already share one vector source, **seeding that source is the feature.** Everything else (the grid, the twists) is in service of collecting a *good* seed and making the moment feel great.

---

## 3. The seed mechanism: a table, not fake history

The tempting shortcut is to insert synthetic `watch_progress` rows (`completed=true`) so `BuildProfileVector` "just sees them." **Don't.** On a media server, watch history is real and user-visible — it drives Continue Watching, the "already seen, hide it" exclusion, and the **XP/achievements** in migration 023. A synthetic completed row would **mint XP for a movie nobody watched** and surface phantom history. It conflates *"I told you I like this"* with *"I watched this here."*

Instead, a dedicated, resettable, auditable table and **three surgical SQL edits**:

```sql
-- migrations/0NN_taste_seeds.up.sql
CREATE TABLE taste_seeds (
  profile_id    BIGINT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  media_item_id BIGINT NOT NULL REFERENCES media_items(id)  ON DELETE CASCADE,
  source        TEXT   NOT NULL DEFAULT 'onboarding',   -- onboarding | vibe | refine
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, media_item_id)
);
ALTER TABLE user_profiles ADD COLUMN taste_onboarding_completed BOOLEAN NOT NULL DEFAULT false;
```

1. **`BuildProfileVector`** — `UNION ALL` the seeds into the `recent` CTE, carrying sort keys so seeds sort as `completed=true` at their `created_at`:

   ```sql
   WITH recent AS (
     SELECT m.embedding, wp.completed AS completed, wp.updated_at AS ts
     FROM watch_progress wp JOIN media_items m ON m.id = wp.media_item_id
     WHERE wp.profile_id = $1 AND m.embedding IS NOT NULL
     UNION ALL
     SELECT m.embedding, true AS completed, ts.created_at AS ts
     FROM taste_seeds ts JOIN media_items m ON m.id = ts.media_item_id
     WHERE ts.profile_id = $1 AND m.embedding IS NOT NULL
     ORDER BY completed DESC, ts DESC
     LIMIT 20
   )
   SELECT COUNT(*), CASE WHEN COUNT(*)>0 THEN AVG(embedding)::text END FROM recent
   ```

2. **`PersonalizationHistoryCount`** — count seeds too, so the `≥3` gate is met by the picks.
3. **`NearestUnwatched`** — add a second `NOT EXISTS` against `taste_seeds`, so we never recommend back a title they just told us they love.

That's the whole backend behavior change. **Decision #2 (natural fade) is free:** seeds carry a fixed `created_at`, so the instant the user finishes one *real* title (later `updated_at`), it sorts above the seeds; after 20 real watches the seeds fall out of the top-20 window entirely. The onboarding prior **fades on its own** — no expiry job, straight out of the existing recency slice.

---

## 4. The grid is *your* library, diversity-sampled (twist #2)

Aurora streams what's on the host's disk, so a hardcoded "Godfather / LOTR" grid is wrong: half won't exist, and a pick only seeds the vector if the title is **in this catalog and embedded**. New endpoint `GET /api/onboarding/grid`:

- **Embedding-gated** — only offers embedded titles, so the **5 picks always clear the `=3` vector threshold** with headroom. (And per decision #1 the screen only shows when the library is embedded at all.)
- **Age-filtered** by the profile's `max_age_rating` — a kid profile's grid must be filtered, or we've built a content-rating hole into onboarding.
- **Diversity-sampled, not top-popularity.** 5 blockbusters are low-signal — they're neighbors in embedding space, so the picks yield mush. Two ways to span the space, cheapest first:
  - **v1 — genre-stratified:** bucket by `media_genres`, take the top-popularity embedded titles per genre, round-robin to fill the grid. Cheap, no vector math.
  - **upgrade — embedding k-means:** pull the top-N popular embeddings to Go (the codebase already contemplates ~140 KB transfers for vector work), cluster into K, sample representatives. Build once per library, cache. Sharper coverage.

---

## 5. Embeddings-off behavior (decided: vector-only)

Per **decision #1**, we do not build a genre-affinity fallback. The implication is a single guard:

- `GET /api/onboarding/status` returns `library_embedded` (true once any media has an embedding). The frontend **only routes to onboarding when it's true**; otherwise the new profile lands on home with today's popular pool, unchanged.
- Once an admin enables Ollama and the backfill ([`embedding.RunBackfill`](../../internal/embedding)) populates vectors, `library_embedded` flips true and the next new profile gets the screen. (Optional nicety, not v1: offer "Tune your taste" to *existing* profiles created during the embeddings-off window.)

Two smaller calls are also locked: trigger = per-profile first-run gated on `taste_onboarding_completed`, with a re-runnable **"Refine your taste"** entry in Settings; picks mirror to **Favorites** (decision #3).

---

## 6. The twists, in detail

All four reuse existing machinery — they're mostly new *surfaces* over the kNN you already have.

**6.1 Instant preview (highest leverage).** New `GET /api/onboarding/preview?selected=…`: build a partial vector from the selected seeds' embeddings, run a `NearestUnwatched`-style kNN, return ~12 picks with one-line reasons. The screen reveals a "✨ Your first recommendations" rail **the moment the picks are vector-computable (3)** and re-renders as picks 4 and 5 land — the AI proves itself *before* Done (5). With <3 selected the rail stays hidden.

**6.2 Reactive grid.** `GET /api/onboarding/grid?selected=…` re-ranks the *unselected* tiles toward the running partial centroid (and seeds later rows with fresh neighbors), so the grid narrows toward their taste as they tap. Throttle to one refresh per tap; keep already-selected tiles pinned so the layout never yanks under the cursor.

**6.3 Vibe chips.** ~6 chips ("Mind-benders", "Cozy comfort", "Edge-of-seat", "Epics", "Crime & capers", "Surprise me"). Each chip resolves **per-library** to a handful of representative title IDs — nearest to a reference centroid in embedding space — so chips reflect what's actually on *this* server. Tapping a chip biases the grid toward that mood; it's a fast on-ramp for users who don't recognize the posters.

**6.4 Diversity-sampled grid** — covered in [§4](#4-the-grid-is-your-library-diversity-sampled-twist-2).

---

## 7. Data model & API additions

Net-new is small; most of this is reuse.

**DB** — `taste_seeds` table + `user_profiles.taste_onboarding_completed` (DDL in [§3](#3-the-seed-mechanism-a-table-not-fake-history)); the three SQL edits to `queries_recommender.go`.

**Queries** (`internal/db`) — `AddTasteSeeds(profileID, mediaIDs)`, `ListTasteSeeds(profileID)`, `ClearTasteSeeds(profileID)`, `LibraryHasEmbeddings()` (for the status gate).

**API** (`internal/api`, chi authenticated group, `requireClaims` pattern):
- `GET  /api/onboarding/status` → `{ completed, threshold: 3, min_picks: 5, library_embedded }`
- `GET  /api/onboarding/grid?selected=…` → diversity/reactive poster set (age-filtered, embedded-only)
- `GET  /api/onboarding/preview?selected=…` → instant-recs rail (≥3 selected)
- `POST /api/onboarding/seeds` `{ media_ids }` → validates ≥5, writes seeds, mirrors to Favorites, sets the flag, calls `Invalidate`
- `GET  /api/onboarding/chips` + `POST /api/onboarding/chips/{id}` → vibe chips resolved per-library

**Models** — extend `UserProfile` with `TasteOnboardingCompleted bool`.

**Frontend** (`static/redesign/app/src`) — a `TasteOnboarding.tsx` screen gated in `App.tsx` on `library_embedded && !taste_onboarding_completed`, fetching via `apiFetch`. A Settings → "Refine your taste" entry reuses the same component.

---

## 8. Security, abuse, correctness

- **Age gate is a correctness requirement, not a nicety** — the grid, preview, and chips must all honor `max_age_rating`, or onboarding becomes a way around content ratings on a kid profile.
- **Validate every `media_id`** in `POST /seeds` belongs to a readable library, is embedded, and isn't above the profile's rating before writing — don't trust the client's list. Require **≥5**, dedupe, cap at ~50.
- **`selected=` query params are length-capped** to avoid building pathological vectors.
- **Reuse** the existing 1 MB body cap (`decodeJSON`) and authenticated-group middleware; onboarding endpoints are user-scoped, never admin.
- **No PII leaves the box** — everything is local; chips/preview are computed server-side from the local catalog.

---

## 9. Phasing & rough effort

Sizing is relative (S ≈ a few days, M ≈ 1–2 weeks), one engineer familiar with the stack. Each phase is independently shippable.

| Phase | Scope | Size | Net-new vs reuse |
|---|---|---|---|
| **0. Keystone** | `taste_seeds` + the 3 SQL edits + `Invalidate` wiring; `status` gate; `POST /seeds` (≥5, mirror→Favorites); minimal embedded pick-grid screen (no twists) | **M** | tiny backend, reused recommender |
| **1. Diversity grid** | genre-stratified `GET /grid` + age filter | **S–M** | reuse `media_genres` |
| **2. Instant preview** | `GET /preview` partial-vector rail (shows at 3, sharpens to 5) | **S** | reuse kNN |
| **3. Reactive grid** | `selected=`-aware re-rank + client throttle/pinning | **S–M** | new UI, reused query |
| **4. Vibe chips** | per-library chip resolution via embedding centroids | **S–M** | new, reused embeddings |
| **5. Refine-your-taste** | Settings entry + `ClearTasteSeeds` re-run | **S** | reuse screen |

**Phase 0 alone delivers "works out of the box"** on any embedded library. Phases 1–4 are the twists; Phase 5 makes it re-runnable.

---

## 10. Risks & remaining open items

**Risks**
- **Tiny / un-backfilled library** → thin grid + thin preview. Degrade by count; show "still scanning…" if a backfill is mid-flight; the `library_embedded` gate already keeps the screen hidden until there's *something* embedded.
- **Stale caches** → forgetting `Invalidate(profileID)` after the seed write serves cold-start recs on first load. *Mitigated* by wiring it into `POST /seeds`.
- **Reactive-grid jank** → re-ranking under the cursor feels bad. *Mitigated* by pinning selected tiles + throttling to one refresh per tap.
- **Recommending the seed back** → handled by the `NearestUnwatched` seed-exclusion edit.

**Remaining open items (non-blocking)**
- Offer "Tune your taste" to profiles created *before* embeddings were enabled? (Nice-to-have; not v1.)
- Negative/"not for me" signal — deliberately deferred; needs a repulsion term the recommender doesn't have yet.

---

## 11. Suggested next step

The lowest-risk, highest-signal start is **Phase 0 (the keystone)** — `taste_seeds` + the three SQL edits + `Invalidate`, behind even a plain grid. That one phase flips a brand-new profile from "generic popular" to "personalized on first load," and it's the foundation every twist builds on. Phases 1–4 then layer the experience in the [`mockup`](./mockup-pick-what-you-love.html). All of it would go through the standard pipeline (branch → implement + tests → build/test in CI → review → merge).

*Nothing here is committed — this is a proposal doc + a static mockup. Say the word and I'll turn Phase 0 into a real branch.*
