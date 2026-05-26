-- Down migration for 026: remove the partial index first (depends on the
-- columns), then drop the columns. IF EXISTS so the down is idempotent.

DROP INDEX IF EXISTS idx_media_items_ai_match_pending;

ALTER TABLE media_items
    DROP COLUMN IF EXISTS ai_match_ran_at,
    DROP COLUMN IF EXISTS ai_match_reasoning,
    DROP COLUMN IF EXISTS ai_match_confidence,
    DROP COLUMN IF EXISTS ai_suggested_year,
    DROP COLUMN IF EXISTS ai_suggested_title,
    DROP COLUMN IF EXISTS ai_suggested_tmdb_id;
