-- Phase 6 — Collections.
--
-- Two flavors:
--   kind='manual'  — admin builds a curated list of media items.
--   kind='ai'      — LLM-generated from a natural-language prompt. The
--                    `prompt` column preserves the seed text so the
--                    collection can be "regenerated" later if the
--                    library has grown.
--
-- Visibility: owner_user_id scopes ownership; `is_public` lets a
-- collection appear in other users' home rails (admin-built
-- "Marvel Cinematic Universe" collections are typically public).

CREATE TABLE IF NOT EXISTS collections (
    id              BIGSERIAL PRIMARY KEY,
    owner_user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    kind            TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'ai'
    prompt          TEXT,                            -- AI seed text
    is_public       BOOLEAN NOT NULL DEFAULT false,
    cover_path      TEXT,                            -- optional poster path
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT collections_kind_check CHECK (kind IN ('manual', 'ai'))
);

CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_collections_public ON collections(is_public) WHERE is_public = true;

CREATE TABLE IF NOT EXISTS collection_items (
    id              BIGSERIAL PRIMARY KEY,
    collection_id   BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    media_item_id   BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL DEFAULT 0,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (collection_id, media_item_id)
);

CREATE INDEX IF NOT EXISTS idx_collection_items_collection ON collection_items(collection_id, position);
