-- Revert Phase E2: embeddinggemma (768) → nomic-embed-text (384).
-- Null all embeddings + drop/recreate the dimension-bound HNSW index, then shrink
-- the column back to vector(384). A rollback to the pre-E2 binary (CurrentVersion=1,
-- EmbedModel=nomic-embed-text, EmbedDims=384) re-embeds the nulled rows on boot.

UPDATE media_items SET embedding = NULL, embedding_version = 0 WHERE embedding IS NOT NULL;

DROP INDEX IF EXISTS idx_media_items_embedding_hnsw;

ALTER TABLE media_items ALTER COLUMN embedding TYPE vector(384);

CREATE INDEX IF NOT EXISTS idx_media_items_embedding_hnsw
    ON media_items USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
