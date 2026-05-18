-- Aurora Phase 2: Metadata, Artwork, Cast, Watch Progress, Streaming
-- PostgreSQL 14+

-- ============================================================
-- Expand media_items with TMDB metadata
-- ============================================================

ALTER TABLE media_items
    ADD COLUMN IF NOT EXISTS tmdb_id        INTEGER,
    ADD COLUMN IF NOT EXISTS imdb_id        VARCHAR(20),
    ADD COLUMN IF NOT EXISTS tagline        TEXT,
    ADD COLUMN IF NOT EXISTS status         VARCHAR(50),
    ADD COLUMN IF NOT EXISTS original_lang  VARCHAR(10),
    ADD COLUMN IF NOT EXISTS popularity     REAL,
    ADD COLUMN IF NOT EXISTS vote_count     INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS backdrop_path  TEXT,
    ADD COLUMN IF NOT EXISTS poster_path    TEXT,
    ADD COLUMN IF NOT EXISTS metadata_src   VARCHAR(20) DEFAULT 'scanner',
    ADD COLUMN IF NOT EXISTS last_metadata  TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_items_tmdb
    ON media_items(tmdb_id) WHERE tmdb_id IS NOT NULL;

-- ============================================================
-- Expand tv_episodes with TMDB metadata
-- ============================================================

ALTER TABLE tv_episodes
    ADD COLUMN IF NOT EXISTS tmdb_id       INTEGER,
    ADD COLUMN IF NOT EXISTS still_path    TEXT,
    ADD COLUMN IF NOT EXISTS vote_average  REAL,
    ADD COLUMN IF NOT EXISTS vote_count    INTEGER DEFAULT 0;

-- ============================================================
-- Artwork (posters, backdrops, stills, logos)
-- ============================================================

CREATE TABLE IF NOT EXISTS artwork (
    id            BIGSERIAL PRIMARY KEY,
    media_item_id BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    art_type      VARCHAR(20) NOT NULL CHECK (art_type IN ('poster', 'backdrop', 'still', 'logo', 'thumb')),
    source        VARCHAR(20) NOT NULL DEFAULT 'tmdb',
    remote_path   TEXT NOT NULL,
    local_path    TEXT,
    width         INT,
    height        INT,
    lang          VARCHAR(10),
    vote_average  REAL DEFAULT 0,
    is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
    cached_at     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_artwork_media ON artwork(media_item_id, art_type);
CREATE UNIQUE INDEX idx_artwork_unique ON artwork(media_item_id, art_type, source, remote_path);

-- ============================================================
-- Cast & Crew
-- ============================================================

CREATE TABLE IF NOT EXISTS people (
    id          BIGSERIAL PRIMARY KEY,
    tmdb_id     INTEGER UNIQUE,
    name        VARCHAR(255) NOT NULL,
    profile_path TEXT,
    known_for   VARCHAR(50),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS media_cast (
    id            BIGSERIAL PRIMARY KEY,
    media_item_id BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    person_id     BIGINT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    role_type     VARCHAR(20) NOT NULL CHECK (role_type IN ('cast', 'director', 'writer', 'producer', 'creator')),
    character     VARCHAR(500),
    display_order INT NOT NULL DEFAULT 0,
    UNIQUE(media_item_id, person_id, role_type, character)
);

CREATE INDEX idx_media_cast_media ON media_cast(media_item_id, role_type, display_order);
CREATE INDEX idx_media_cast_person ON media_cast(person_id);

-- ============================================================
-- Watch Progress
-- ============================================================

CREATE TABLE IF NOT EXISTS watch_progress (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_item_id BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    episode_id    BIGINT REFERENCES tv_episodes(id) ON DELETE CASCADE,
    position_ms   BIGINT NOT NULL DEFAULT 0,
    duration_ms   BIGINT NOT NULL DEFAULT 0,
    completed     BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each user has one progress entry per media item (or per episode for TV)
CREATE UNIQUE INDEX idx_watch_progress_user_media
    ON watch_progress(user_id, media_item_id) WHERE episode_id IS NULL;
CREATE UNIQUE INDEX idx_watch_progress_user_episode
    ON watch_progress(user_id, episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX idx_watch_progress_continue
    ON watch_progress(user_id, updated_at DESC) WHERE NOT completed;

CREATE TRIGGER trg_watch_progress_updated_at BEFORE UPDATE ON watch_progress
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Transcode sessions (for tracking active transcodes)
-- ============================================================

CREATE TABLE IF NOT EXISTS transcode_sessions (
    id           VARCHAR(64) PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id      BIGINT NOT NULL,
    file_type    VARCHAR(10) NOT NULL CHECK (file_type IN ('media', 'episode')),
    pid          INT,
    status       VARCHAR(20) NOT NULL DEFAULT 'starting' CHECK (status IN ('starting', 'running', 'complete', 'failed', 'cancelled')),
    preset       VARCHAR(50) NOT NULL DEFAULT 'copy',
    resolution   VARCHAR(20),
    started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transcode_sessions_user ON transcode_sessions(user_id);
CREATE INDEX idx_transcode_sessions_active ON transcode_sessions(status) WHERE status IN ('starting', 'running');
