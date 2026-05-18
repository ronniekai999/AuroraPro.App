-- Aurora Media Server - Phase 1 Schema
-- PostgreSQL 14+

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm; -- For fast LIKE/ILIKE and full-text search

-- ============================================================
-- Users & Authentication
-- ============================================================

CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    username      VARCHAR(50) UNIQUE NOT NULL,
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    avatar_url    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE refresh_tokens (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       VARCHAR(255) UNIQUE NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked     BOOLEAN NOT NULL DEFAULT FALSE,
    device_info TEXT
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token ON refresh_tokens(token) WHERE NOT revoked;

CREATE TABLE invite_codes (
    id          BIGSERIAL PRIMARY KEY,
    code        VARCHAR(64) UNIQUE NOT NULL,
    created_by  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    used_at     TIMESTAMPTZ,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invite_codes_code ON invite_codes(code) WHERE used_by IS NULL;

-- ============================================================
-- Libraries
-- ============================================================

CREATE TABLE libraries (
    id                BIGSERIAL PRIMARY KEY,
    name              VARCHAR(255) NOT NULL,
    type              VARCHAR(10) NOT NULL CHECK (type IN ('movie', 'show')),
    paths             TEXT[] NOT NULL,
    scan_interval_min INT NOT NULL DEFAULT 360,
    owner_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Media Items (Movies & Shows)
-- ============================================================

CREATE TABLE media_items (
    id              BIGSERIAL PRIMARY KEY,
    library_id      BIGINT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    type            VARCHAR(10) NOT NULL CHECK (type IN ('movie', 'show')),
    title           VARCHAR(500) NOT NULL,
    sort_title      VARCHAR(500) NOT NULL,
    year            INT,
    overview        TEXT,
    rating          DECIMAL(3,1),
    runtime_minutes INT,
    content_rating  VARCHAR(20),
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_media_items_library ON media_items(library_id, type);
CREATE INDEX idx_media_items_sort_title ON media_items(sort_title);
CREATE INDEX idx_media_items_year ON media_items(year);
CREATE INDEX idx_media_items_rating ON media_items(rating DESC NULLS LAST);
CREATE INDEX idx_media_items_added ON media_items(added_at DESC);

-- Full-text search index using pg_trgm for fuzzy matching
CREATE INDEX idx_media_items_title_trgm ON media_items USING gin (title gin_trgm_ops);

-- ============================================================
-- Media Files (physical files on disk)
-- ============================================================

CREATE TABLE media_files (
    id            BIGSERIAL PRIMARY KEY,
    media_item_id BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    path          TEXT UNIQUE NOT NULL,
    size_bytes    BIGINT NOT NULL DEFAULT 0,
    container     VARCHAR(20),
    video_codec   VARCHAR(50),
    audio_codec   VARCHAR(50),
    resolution    VARCHAR(20),
    bitrate       BIGINT,
    duration_ms   BIGINT,
    file_hash     VARCHAR(128) NOT NULL,
    scanned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_media_files_item ON media_files(media_item_id);
CREATE INDEX idx_media_files_hash ON media_files(file_hash);

-- ============================================================
-- TV Shows: Seasons & Episodes
-- ============================================================

CREATE TABLE tv_seasons (
    id            BIGSERIAL PRIMARY KEY,
    media_item_id BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    season_number INT NOT NULL,
    title         VARCHAR(255),
    overview      TEXT,
    UNIQUE(media_item_id, season_number)
);

CREATE TABLE tv_episodes (
    id              BIGSERIAL PRIMARY KEY,
    season_id       BIGINT NOT NULL REFERENCES tv_seasons(id) ON DELETE CASCADE,
    media_item_id   BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    episode_number  INT NOT NULL,
    title           VARCHAR(500),
    overview        TEXT,
    runtime_minutes INT,
    air_date        DATE,
    UNIQUE(season_id, episode_number)
);

CREATE TABLE episode_files (
    id           BIGSERIAL PRIMARY KEY,
    episode_id   BIGINT NOT NULL REFERENCES tv_episodes(id) ON DELETE CASCADE,
    path         TEXT UNIQUE NOT NULL,
    size_bytes   BIGINT NOT NULL DEFAULT 0,
    container    VARCHAR(20),
    video_codec  VARCHAR(50),
    audio_codec  VARCHAR(50),
    resolution   VARCHAR(20),
    bitrate      BIGINT,
    duration_ms  BIGINT,
    file_hash    VARCHAR(128) NOT NULL,
    scanned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_episode_files_episode ON episode_files(episode_id);
CREATE INDEX idx_episode_files_hash ON episode_files(file_hash);

-- ============================================================
-- Genres
-- ============================================================

CREATE TABLE genres (
    id   BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL
);

CREATE TABLE media_genres (
    media_item_id BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    genre_id      BIGINT NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (media_item_id, genre_id)
);

-- ============================================================
-- External IDs (TMDB, TVDB, IMDB)
-- ============================================================

CREATE TABLE external_ids (
    media_item_id BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    provider      VARCHAR(20) NOT NULL,
    external_id   VARCHAR(100) NOT NULL,
    PRIMARY KEY (media_item_id, provider)
);

-- ============================================================
-- Helper function for updated_at trigger
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_libraries_updated_at BEFORE UPDATE ON libraries
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_media_items_updated_at BEFORE UPDATE ON media_items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
