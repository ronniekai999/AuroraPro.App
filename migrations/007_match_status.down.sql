DROP INDEX IF EXISTS idx_media_items_match_status;
ALTER TABLE media_items DROP COLUMN IF EXISTS match_status;
