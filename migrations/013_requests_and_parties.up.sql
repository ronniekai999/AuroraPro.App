-- Migration 013: Requests and Watch Parties
-- Creates tables for media request system and synchronized watch party sessions.

-- 1. requests — user media requests with TMDB metadata, quality preferences,
--    ARR job tracking, and status lifecycle (pending -> processing -> available | failed).
CREATE TABLE IF NOT EXISTS requests (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_type      VARCHAR(10) NOT NULL CHECK (media_type IN ('movie', 'tv')),
    tmdb_id         INT NOT NULL,
    title           VARCHAR(500) NOT NULL,
    poster_path     VARCHAR(500) DEFAULT '',
    overview        TEXT DEFAULT '',
    year            INT DEFAULT 0,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'available', 'failed')),
    quality_1080p   BOOLEAN NOT NULL DEFAULT TRUE,
    quality_4k      BOOLEAN NOT NULL DEFAULT FALSE,
    arr_job_ids     TEXT DEFAULT '',
    error_message   TEXT DEFAULT '',
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: prevent duplicate active requests per user+media.
-- Failed requests are excluded so a user can re-request after a failure.
CREATE UNIQUE INDEX idx_requests_active_unique
    ON requests (user_id, media_type, tmdb_id)
    WHERE status NOT IN ('failed');

CREATE INDEX idx_requests_user_id ON requests (user_id);
CREATE INDEX idx_requests_status ON requests (status);

-- 2. watch_parties — party sessions with alphanumeric code, host user,
--    media reference, settings, and active flag.
CREATE TABLE IF NOT EXISTS watch_parties (
    id                  BIGSERIAL PRIMARY KEY,
    party_code          VARCHAR(6) NOT NULL,
    host_user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_item_id       BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    episode_id          BIGINT REFERENCES tv_episodes(id) ON DELETE SET NULL,
    party_name          VARCHAR(200) NOT NULL DEFAULT '',
    media_title         VARCHAR(500) NOT NULL DEFAULT '',
    media_poster        VARCHAR(500) NOT NULL DEFAULT '',
    max_participants    INT NOT NULL DEFAULT 10,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    settings_json       JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at            TIMESTAMPTZ
);

-- Partial unique indexes on active parties only.
CREATE UNIQUE INDEX idx_watch_parties_code_active
    ON watch_parties (party_code) WHERE is_active = TRUE;

CREATE INDEX idx_watch_parties_host_active
    ON watch_parties (host_user_id) WHERE is_active = TRUE;

CREATE INDEX idx_watch_parties_media_item
    ON watch_parties (media_item_id);

-- 3. watch_party_participants — join/leave audit trail.
CREATE TABLE IF NOT EXISTS watch_party_participants (
    id          BIGSERIAL PRIMARY KEY,
    party_id    BIGINT NOT NULL REFERENCES watch_parties(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_wpp_party_user
    ON watch_party_participants (party_id, user_id);

CREATE INDEX idx_wpp_party_id ON watch_party_participants (party_id);
