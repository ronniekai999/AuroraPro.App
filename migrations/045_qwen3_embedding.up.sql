-- Phase E4 — embedding model upgrade: embeddinggemma (768 native) →
-- qwen3-embedding:0.6b (1024 native, Matryoshka-truncated to 768 in the client).
--
-- MUCH lighter than migration 040: the target dimensionality is unchanged
-- (the client truncates qwen3-embedding's MRL output to the existing
-- vector(768) column), so there is NO column re-type and NO HNSW drop/rebuild
-- — the 040-style table-rewrite lock is avoided entirely. We only:
--
--   1. Drop a persisted `llm_embed_model` override IF it still points at the
--      old default (embeddinggemma), so the new binary default takes over.
--      Unlike 040 this is conditional: an operator who deliberately pinned a
--      DIFFERENT 768-compatible model (e.g. nomic-embed-text at its native
--      768) keeps their choice — same-dims models can't corrupt the column,
--      so there is no safety reason to wipe a genuine customization. (040
--      wiped unconditionally because the column width itself changed.)
--   2. Null the stored vectors. Embeddings from different models live in
--      different spaces — cosine between an embeddinggemma vector and a
--      qwen3-embedding vector is meaningless — so a mixed-space column
--      during an in-place re-embed would silently corrupt similarity
--      ranking. Nulling everything keeps search honest (trigram fallback)
--      until the version-4 backfill (embedding.CurrentVersion bump) refills.
--
-- OPERATIONAL PREREQ: `ollama pull qwen3-embedding:0.6b` on the embed host
-- before deploy. If absent, the backfill fails-and-retries (embeddings stay
-- NULL, recommender falls back to popular/empty) until the model is pulled.
-- install.sh's preflight prints the exact pull commands when models are
-- missing.

DELETE FROM server_settings
    WHERE key = 'llm_embed_model'
    AND value IN ('embeddinggemma', 'embeddinggemma:latest');

UPDATE media_items SET embedding = NULL, embedding_version = 0 WHERE embedding IS NOT NULL;
