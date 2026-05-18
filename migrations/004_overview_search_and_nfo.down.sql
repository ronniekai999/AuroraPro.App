DROP INDEX IF EXISTS idx_media_items_overview_trgm;
ALTER TABLE media_items DROP COLUMN IF EXISTS tmdb_last_changed;
ALTER TABLE artwork DROP COLUMN IF EXISTS blurhash;
ALTER TABLE users DROP COLUMN IF EXISTS metadata_lang;
