-- Phase E2 — embedding model upgrade: nomic-embed-text (384) → embeddinggemma (768).
--
-- pgvector cannot ALTER a populated vector column to a new dimension, so we null
-- every embedding first; the code-side embedding.CurrentVersion bump (1 → 2) then
-- drives RunBackfill to re-embed all items with the new model on the next boot.
-- The HNSW index is dimension-bound, so it is dropped before the ALTER and
-- recreated for 768 dims afterward. The pending/version partial indexes only
-- reference embedding via IS-NULL / on other columns, so they survive the ALTER.
--
-- The migration runner wraps this file in a single transaction (internal/db/pool.go),
-- so the null + ALTER + index rebuild apply atomically.
--
-- OPERATIONAL PREREQ: `ollama pull embeddinggemma` must be run on the embed host
-- before deploy. If the model is absent the backfill fails-and-retries (embeddings
-- stay NULL, recommender falls back to popular/empty) until the model is present.

-- Clear any persisted embed-model override so the new embeddinggemma default is
-- authoritative. A stale `llm_embed_model` (e.g. nomic-embed-text) would pin the
-- OLD model against the new vector(768) column: a narrower model writes a
-- too-short vector pgvector rejects (now a loud EmbedBatch error), and a 768-wide
-- stale model silently re-embeds with the wrong model. Either way, drop the row
-- and let the binary default win. (Mirrors the earlier reranker-model reset.)
DELETE FROM server_settings WHERE key = 'llm_embed_model';

UPDATE media_items SET embedding = NULL, embedding_version = 0 WHERE embedding IS NOT NULL;

DROP INDEX IF EXISTS idx_media_items_embedding_hnsw;

ALTER TABLE media_items ALTER COLUMN embedding TYPE vector(768);

CREATE INDEX IF NOT EXISTS idx_media_items_embedding_hnsw
    ON media_items USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
