-- Taste onboarding ("Pick What You Love"): explicit seed titles a profile picks
-- at first run to bootstrap recommendations before any watch history exists
-- (the cold-start problem). Seeds feed BuildProfileVector exactly like watched
-- items do, so all four AI surfaces (hero, recommendations, discover, anchor
-- rails) personalize on first load instead of the generic popular pool.
--
-- Kept SEPARATE from watch_progress on purpose: a seed is "I told you I like
-- this", NOT "I watched this here". Conflating them would grant XP (migration
-- 023), surface phantom Continue-Watching rows, and count as a real view.
--
-- Natural fade: seeds carry a fixed created_at, so once real watches accrue
-- they outrank the seeds in BuildProfileVector's top-20-by-recency window and
-- the onboarding prior ages out on its own — no expiry job.
CREATE TABLE IF NOT EXISTS taste_seeds (
    profile_id    BIGINT      NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    media_item_id BIGINT      NOT NULL REFERENCES media_items(id)  ON DELETE CASCADE,
    source        VARCHAR(20) NOT NULL DEFAULT 'onboarding',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_id, media_item_id)
);

-- Reverse lookup for the "don't recommend a seeded title back" exclusion in
-- NearestUnwatched / NearestUnwatchedRich / PopularUnwatched (NOT EXISTS by
-- media_item_id within a profile).
CREATE INDEX IF NOT EXISTS idx_taste_seeds_media ON taste_seeds (media_item_id);

-- Per-profile "has this profile finished taste onboarding?" gate. Drives the
-- one-time first-run redirect to the "Pick What You Love" screen.
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS taste_onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE;
