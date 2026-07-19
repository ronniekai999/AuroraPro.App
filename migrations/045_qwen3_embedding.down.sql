-- Down: revert to the embeddinggemma default. The schema never changed in
-- the up migration (same vector(768) column, same indexes), so down is just
-- the same null-and-re-embed dance in reverse: clear vectors produced by
-- qwen3-embedding so the (older) binary's embeddinggemma backfill re-embeds
-- from scratch, and drop any qwen3 embed-model override row so the older
-- default wins.

DELETE FROM server_settings
    WHERE key = 'llm_embed_model'
    AND value IN ('qwen3-embedding:0.6b', 'qwen3-embedding');

UPDATE media_items SET embedding = NULL, embedding_version = 0 WHERE embedding IS NOT NULL;
