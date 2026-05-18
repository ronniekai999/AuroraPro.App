-- Migration 014 DOWN: remove semantic search columns and index.
-- The vector extension is left installed in case other tables depend on it.
--
-- WARNING: this is DESTRUCTIVE. Dropping the embedding column irreversibly
-- discards every vector produced by the backfill worker. On a re-up the
-- entire catalog must be re-embedded (hours of work for large libraries,
-- and cloud API cost if you're not running embeddings locally). Do NOT run
-- this migration as part of a normal rollback unless you specifically want
-- to wipe semantic search state.

DO $$
BEGIN
    RAISE NOTICE 'Migration 014 DOWN will DROP the embedding column. All vectors will be lost. Re-up requires full backfill.';
END $$;

DROP INDEX IF EXISTS idx_media_items_embedding_pending;
DROP INDEX IF EXISTS idx_media_items_embedding_hnsw;

ALTER TABLE media_items
    DROP COLUMN IF EXISTS embedded_at,
    DROP COLUMN IF EXISTS embedding_version,
    DROP COLUMN IF EXISTS embedding;
