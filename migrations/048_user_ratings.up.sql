-- Star ratings — per-(profile, item) explicit 1-5★ verdicts that feed the
-- recommender: 4-5★ joins the taste centroid like a thumb/seed (BuildProfileVector
-- UNION), 1-2★ hard-excludes the title from every proactive recommendation
-- surface (lowRatedNotExists in all recall queries) AND removes it from the
-- taste slice — so a 5-minute abandoned watch that was pulling the centroid
-- toward the title stops doing so the moment the user 1-stars it. Low-rated
-- titles are also fed to the hero/discover LLM prompts as explicit anti-taste
-- anchors ("rated 1/5 — avoid similar"). 3★ is neutral: stored + displayed,
-- no steering. One row per (profile, item) — re-rating replaces the verdict.
--
-- Kept SEPARATE from item_feedback (binary thumbs): a star rating is graded
-- sentiment on a title the user has an opinion about, not a "show me
-- more/less like this" toggle — both signals coexist and are deduped in the
-- taste slice. `stars` deliberately does NOT reuse media_items.rating (the
-- 0-10 TMDB community score). A rating triggers Hero.Invalidate so the next
-- build reflects it.
CREATE TABLE IF NOT EXISTS user_ratings (
    profile_id    BIGINT      NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    media_item_id BIGINT      NOT NULL REFERENCES media_items(id)  ON DELETE CASCADE,
    stars         SMALLINT    NOT NULL CHECK (stars BETWEEN 1 AND 5),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_id, media_item_id)
);

-- Drives the 4-5★ taste UNION + the 1-2★ recall NOT EXISTS (both filter by
-- profile_id + stars).
CREATE INDEX IF NOT EXISTS idx_user_ratings_lookup ON user_ratings (profile_id, stars);
-- Reverse lookup for ON DELETE / per-item cleanup.
CREATE INDEX IF NOT EXISTS idx_user_ratings_media ON user_ratings (media_item_id);
