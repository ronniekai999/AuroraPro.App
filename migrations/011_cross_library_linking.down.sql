-- Down migration: Restore the unique tmdb_id index.
-- WARNING: This will fail if duplicate tmdb_ids exist across libraries.
-- You must manually resolve duplicates before running this down migration.

DROP INDEX IF EXISTS idx_media_items_tmdb;
DROP INDEX IF EXISTS idx_media_items_tmdb_type;

CREATE UNIQUE INDEX idx_media_items_tmdb ON media_items(tmdb_id) WHERE tmdb_id IS NOT NULL;
