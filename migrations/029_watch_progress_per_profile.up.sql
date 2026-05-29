-- deep-debug — make watch progress PER-PROFILE.
--
-- Until now the watch_progress uniqueness was keyed on (user_id, media_item_id)
-- and (user_id, episode_id) — ignoring profile_id (migration 003). Two profiles
-- on one account therefore shared a single progress row and clobbered each
-- other's position. This re-keys the uniqueness to include profile_id.
--
-- Self-contained backfill: schema migrations run BEFORE the Go data-migration
-- (migrateDefaultProfiles), so this migration cannot rely on that backfill and
-- does its own here, in the correct order, before enforcing NOT NULL.

-- 1. Every user needs a default profile (mirrors migrateDefaultProfiles).
INSERT INTO user_profiles (user_id, name, is_default, language, subtitle_mode)
SELECT u.id, u.username, TRUE, 'en', 'off'
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM user_profiles up WHERE up.user_id = u.id);

-- 2. A user may have profiles but none marked default — promote the oldest so
--    the backfill below always resolves a profile.
UPDATE user_profiles up
   SET is_default = TRUE
 WHERE up.is_default = FALSE
   AND NOT EXISTS (SELECT 1 FROM user_profiles d WHERE d.user_id = up.user_id AND d.is_default = TRUE)
   AND up.id = (SELECT MIN(p2.id) FROM user_profiles p2 WHERE p2.user_id = up.user_id);

-- 3. Backfill NULL profile_id from the user's default profile (fallback: oldest).
UPDATE watch_progress wp
   SET profile_id = (
       SELECT up.id FROM user_profiles up
        WHERE up.user_id = wp.user_id
        ORDER BY up.is_default DESC, up.id ASC
        LIMIT 1
   )
 WHERE wp.profile_id IS NULL;

-- 4. Fail loudly (rather than silently delete history) if any row still lacks a
--    profile — impossible after steps 1-3 given the user_id FK, but explicit.
DO $$
DECLARE n BIGINT;
BEGIN
    SELECT COUNT(*) INTO n FROM watch_progress WHERE profile_id IS NULL;
    IF n > 0 THEN
        RAISE EXCEPTION 'migration 029: % watch_progress row(s) still have NULL profile_id after backfill; cannot enforce per-profile uniqueness', n;
    END IF;
END
$$;

-- 5. Enforce + re-key. Adding profile_id WIDENS the key, so it can never create
--    a new collision (each old (user,media) row stays unique under the wider key).
ALTER TABLE watch_progress ALTER COLUMN profile_id SET NOT NULL;

DROP INDEX IF EXISTS idx_watch_progress_user_media;
DROP INDEX IF EXISTS idx_watch_progress_user_episode;

CREATE UNIQUE INDEX idx_watch_progress_user_profile_media
    ON watch_progress(user_id, profile_id, media_item_id) WHERE episode_id IS NULL;
CREATE UNIQUE INDEX idx_watch_progress_user_profile_episode
    ON watch_progress(user_id, profile_id, episode_id) WHERE episode_id IS NOT NULL;
