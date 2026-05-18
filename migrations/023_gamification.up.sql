-- Phase 6 — Gamification.
--
-- Per-user XP, streak, level, and achievement unlocks. XP accrues
-- from completed watches (full episode/movie). Streak counts
-- distinct watch days; missing a day resets to 0. Level is derived
-- from XP via a server-computed table.
--
-- Single-row-per-user pattern. INSERT on user creation handled at
-- the application layer (or lazy-created on first XP grant via
-- UPSERT).

CREATE TABLE IF NOT EXISTS user_xp (
    user_id           BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    xp                INTEGER NOT NULL DEFAULT 0,
    level             INTEGER NOT NULL DEFAULT 1,
    current_streak    INTEGER NOT NULL DEFAULT 0,
    longest_streak    INTEGER NOT NULL DEFAULT 0,
    last_watch_date   DATE,                     -- UTC date of last XP grant
    total_watches     INTEGER NOT NULL DEFAULT 0, -- lifetime completed watches
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Achievement unlocks. The achievement_key is an opaque app-level
-- string ('first_watch', 'movie_marathon_5', etc.). Definitions
-- (display name, icon, XP reward) live in code, not the DB — that
-- way we can add/edit achievements without a migration.
CREATE TABLE IF NOT EXISTS user_achievements (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_key TEXT NOT NULL,
    unlocked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, achievement_key)
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);
