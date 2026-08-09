DROP TABLE IF EXISTS recommendation_watch_events;
DROP INDEX IF EXISTS idx_recommendation_impressions_visible_outcome;
ALTER TABLE recommendation_impressions
    DROP CONSTRAINT IF EXISTS recommendation_impressions_visible_ms_check,
    DROP COLUMN IF EXISTS visible_ms,
    DROP COLUMN IF EXISTS visible_at;
ALTER TABLE recommendation_slates
    DROP CONSTRAINT IF EXISTS recommendation_slates_token_unique,
    DROP COLUMN IF EXISTS slate_token;
