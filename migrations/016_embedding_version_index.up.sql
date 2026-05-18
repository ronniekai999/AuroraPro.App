-- Phase 8: speed up backfill scans after an embedding-model version bump.
--
-- The existing partial index `idx_media_items_embedding_pending` only covers
-- the `embedding IS NULL` branch of FetchEmbeddingCandidates:
--
--   WHERE embedding IS NULL OR embedding_version < $1
--
-- After a version bump, the OR branch hits every embedded row and forces a
-- seq scan of media_items. This new index lets the planner use a b-tree
-- range scan for the version-bump path while leaving the existing partial
-- NULL-index in place for cold-start backfill.
CREATE INDEX IF NOT EXISTS idx_media_items_embedding_version
    ON media_items (embedding_version)
    WHERE embedding IS NOT NULL;
