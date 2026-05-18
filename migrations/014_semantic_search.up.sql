-- Migration 014: Semantic search via local LLM embeddings.
--
-- Adds the pgvector extension and an embedding column on media_items so the
-- semantic search pipeline can do nearest-neighbor lookups against vectors
-- produced by a local embedding model (default: nomic-embed-text via Ollama,
-- 768 dims natively but truncated/normalized to 384 for index footprint).
--
-- embedding_version lets us swap models without dropping the column: bump the
-- version constant in code, and the backfill worker will re-embed any rows
-- whose stored version is older than the running version.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE media_items
    ADD COLUMN IF NOT EXISTS embedding         vector(384),
    ADD COLUMN IF NOT EXISTS embedding_version SMALLINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS embedded_at       TIMESTAMPTZ;

-- HNSW gives constant-time ANN regardless of catalog size. Cosine distance
-- matches how nomic / bge / most embedding models are trained.
-- Build time is non-trivial for large libraries (~10k items ≈ 10s on CPU),
-- but only runs once after the initial backfill.
CREATE INDEX IF NOT EXISTS idx_media_items_embedding_hnsw
    ON media_items USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Partial index over rows that still need embedding — the backfill worker
-- pages through this cheaply without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_media_items_embedding_pending
    ON media_items (id)
    WHERE embedding IS NULL;
