-- Revert to account-wide (profile-blind) watch-progress uniqueness.
--
-- WARNING (operator-only): if multiple profiles accumulated progress for the
-- same (user, media)/(user, episode) while the per-profile key was in effect,
-- recreating the narrower unique index below will FAIL on those duplicates.
-- Deduplicate first (keep the most-recently-updated row per user+media) if so.
DROP INDEX IF EXISTS idx_watch_progress_user_profile_media;
DROP INDEX IF EXISTS idx_watch_progress_user_profile_episode;

ALTER TABLE watch_progress ALTER COLUMN profile_id DROP NOT NULL;

CREATE UNIQUE INDEX idx_watch_progress_user_media
    ON watch_progress(user_id, media_item_id) WHERE episode_id IS NULL;
CREATE UNIQUE INDEX idx_watch_progress_user_episode
    ON watch_progress(user_id, episode_id) WHERE episode_id IS NOT NULL;
