-- Aurora Phase 2 gap fixes: full-text search on overview, NFO metadata columns

-- Gap 4: Full-text search should cover overview, not just title
CREATE INDEX IF NOT EXISTS idx_media_items_overview_trgm
    ON media_items USING gin (overview gin_trgm_ops)
    WHERE overview IS NOT NULL;

-- Gap 5: Track TMDB last_changed timestamp for smart diffing
ALTER TABLE media_items
    ADD COLUMN IF NOT EXISTS tmdb_last_changed TIMESTAMPTZ;

-- Gap 7: Store blurhash for poster placeholder loading
ALTER TABLE artwork
    ADD COLUMN IF NOT EXISTS blurhash VARCHAR(50);

-- Gap 8: Store user-preferred language for metadata
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS metadata_lang VARCHAR(10) DEFAULT 'en';
