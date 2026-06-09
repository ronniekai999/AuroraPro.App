-- Phase D — steerable thumbs. Per-(profile, item) explicit feedback that
-- reshapes recommendations live: 👍 'up' feeds the taste centroid (BuildProfileVector
-- UNIONs it like a taste_seed), 👎 'down' hard-excludes the title from every
-- recommendation surface (a NOT EXISTS in all recall queries). One row per
-- (profile, item) — re-thumbing replaces the prior verdict.
--
-- Kept SEPARATE from taste_seeds (an onboarding "I love this") and watch_progress
-- ("I watched this") — feedback is "show me more/less like this," a distinct
-- steering signal. A thumb triggers Hero.Invalidate so the next build reflects it.
CREATE TABLE IF NOT EXISTS item_feedback (
    profile_id    BIGINT      NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    media_item_id BIGINT      NOT NULL REFERENCES media_items(id)  ON DELETE CASCADE,
    feedback      VARCHAR(8)  NOT NULL CHECK (feedback IN ('up', 'down')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_id, media_item_id)
);

-- Drives the 👍 taste UNION + the 👎 recall NOT EXISTS (both filter by
-- profile_id + feedback).
CREATE INDEX IF NOT EXISTS idx_item_feedback_lookup ON item_feedback (profile_id, feedback);
-- Reverse lookup for ON DELETE / per-item cleanup.
CREATE INDEX IF NOT EXISTS idx_item_feedback_media ON item_feedback (media_item_id);
