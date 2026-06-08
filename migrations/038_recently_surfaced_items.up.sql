-- Phase B2 — anti-repetition. Tracks which items the recommender has recently
-- SHOWN a profile on each cached surface, so successive rebuilds can demote
-- already-seen titles and surface fresh ones instead of returning the same
-- top-by-cosine pool every time (the taste vector is stable, so without this
-- nothing rotates until the user actually watches something).
--
-- Kept SEPARATE from watch_progress / taste_seeds on purpose: "I showed you
-- this" is not "you watched this" and not "you told me you like this". It must
-- NOT count as a view, grant XP, or feed BuildProfileVector — it only affects
-- ordering within NearestUnwatched.
--
-- Demote, don't exclude: NearestUnwatched orders fresh-first then by distance,
-- so a row here only sinks an item to the back of the recall pool; if too few
-- fresh items exist it still backfills (no starvation). Bounded by a recency
-- window in the query + self-prune in RecordSurfaced — no janitor needed.
CREATE TABLE IF NOT EXISTS recently_surfaced_items (
    profile_id    BIGINT      NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    media_item_id BIGINT      NOT NULL REFERENCES media_items(id)  ON DELETE CASCADE,
    surface       VARCHAR(32) NOT NULL,            -- 'hero' | 'discover'
    surfaced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_id, media_item_id, surface)
);

-- Drives the windowed EXISTS demotion in NearestUnwatched (profile + surface +
-- recency) and the per-(profile,surface) prune in RecordSurfaced.
CREATE INDEX IF NOT EXISTS idx_recently_surfaced_lookup
    ON recently_surfaced_items (profile_id, surface, surfaced_at DESC);
