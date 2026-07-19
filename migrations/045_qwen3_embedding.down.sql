-- Down: nothing structural to revert (the up migration only removed
-- old-default llm_embed_model override rows, which cannot be restored).
-- Vector-space consistency on a rollback is handled by the same
-- llm_embed_model_active marker mechanism: the older binary's default
-- (embeddinggemma) will differ from the marker (qwen3-embedding:0.6b),
-- so the embedder nulls and re-embeds on next boot — provided the older
-- binary carries the marker code; for a rollback to a pre-marker binary,
-- run: UPDATE media_items SET embedding = NULL, embedding_version = 0;
SELECT 1;
