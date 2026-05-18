-- Phase 4: User Profiles, Watchlists, Activity Log, Server Settings

-- ============================================================
-- User Profiles (Netflix-style sub-profiles per account)
-- ============================================================

CREATE TABLE user_profiles (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    avatar_url      TEXT,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    max_age_rating  VARCHAR(20),
    language        VARCHAR(10) DEFAULT 'en',
    subtitle_lang   VARCHAR(10),
    subtitle_mode   VARCHAR(20) DEFAULT 'off',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_profiles_user ON user_profiles(user_id);

-- Ensure at most one default profile per user
CREATE UNIQUE INDEX idx_user_profiles_default
    ON user_profiles(user_id) WHERE is_default = TRUE;

-- ============================================================
-- Watchlists (per-profile curated lists)
-- ============================================================

CREATE TABLE watchlists (
    id              BIGSERIAL PRIMARY KEY,
    profile_id      BIGINT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    list_type       VARCHAR(20) NOT NULL DEFAULT 'custom'
                    CHECK (list_type IN ('want_to_watch', 'favorites', 'custom')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(profile_id, name)
);

CREATE INDEX idx_watchlists_profile ON watchlists(profile_id);

CREATE TABLE watchlist_items (
    id              BIGSERIAL PRIMARY KEY,
    watchlist_id    BIGINT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
    media_item_id   BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sort_order      INT NOT NULL DEFAULT 0,
    UNIQUE(watchlist_id, media_item_id)
);

CREATE INDEX idx_watchlist_items_list ON watchlist_items(watchlist_id, sort_order);

-- ============================================================
-- Activity Log (server-wide event log for admin dashboard)
-- ============================================================

CREATE TABLE activity_log (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
    profile_id      BIGINT REFERENCES user_profiles(id) ON DELETE SET NULL,
    event_type      VARCHAR(50) NOT NULL,
    details         JSONB,
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_log_created ON activity_log(created_at DESC);
CREATE INDEX idx_activity_log_user ON activity_log(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_activity_log_type ON activity_log(event_type);

-- ============================================================
-- Server Settings (key-value runtime configuration)
-- ============================================================

CREATE TABLE server_settings (
    key             VARCHAR(100) PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      BIGINT REFERENCES users(id) ON DELETE SET NULL
);

-- ============================================================
-- Migrate watch_progress to support profiles
-- ============================================================

ALTER TABLE watch_progress
    ADD COLUMN IF NOT EXISTS profile_id BIGINT REFERENCES user_profiles(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_watch_progress_profile
    ON watch_progress(profile_id, updated_at DESC) WHERE NOT completed;

-- ============================================================
-- Triggers (reuse update_updated_at from migration 001)
-- ============================================================

CREATE TRIGGER trg_user_profiles_updated_at BEFORE UPDATE ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_watchlists_updated_at BEFORE UPDATE ON watchlists
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Default settings
-- ============================================================

INSERT INTO server_settings (key, value) VALUES
    ('completion_threshold', '0.90'),
    ('max_profiles_per_user', '6'),
    ('now_playing_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
