-- Phase E4 — embedding model upgrade: embeddinggemma (768 native) →
-- qwen3-embedding:0.6b (1024 native, Matryoshka-truncated to 768 in the client).
--
-- Deliberately TINY compared to migration 040. The dimensionality is
-- unchanged (the client truncates qwen3-embedding's MRL output to the
-- existing vector(768) column), so there is no column re-type and no HNSW
-- rebuild. And unlike 040, the null-out of old-model vectors does NOT
-- happen here: the embedder now maintains a `llm_embed_model_active`
-- marker (internal/embedding ensureModelSpace) and nulls-and-re-embeds
-- whenever the effective model differs from the one that produced the
-- stored vectors. That mechanism runs post-boot (never blocks startup on a
-- full-table UPDATE under the HNSW index), covers admin-UI/env model
-- changes that bespoke migrations can never see, and preserves the vectors
-- of operators pinned to an unchanged model.
--
-- The one thing that must happen at migration level: un-pin installs whose
-- admin UI persisted the OLD DEFAULT as an explicit llm_embed_model row
-- (saving the form writes every field). Deleting only rows valued at the
-- old default lets the new binary default take over while a genuine custom
-- choice (e.g. nomic-embed-text at native 768) is preserved.
--
-- OPERATIONAL PREREQ: `ollama pull qwen3-embedding:0.6b` (and the chat
-- model `qwen3:4b-instruct`) on the box before deploy. install.sh and
-- scripts/aurora-update.sh both ensure this; if the model is absent the
-- backfill fails-and-retries with a pull hint in the log, and old-model
-- vectors keep serving until the space check succeeds in re-embedding.

DELETE FROM server_settings
    WHERE key = 'llm_embed_model'
    AND value IN ('embeddinggemma', 'embeddinggemma:latest');
