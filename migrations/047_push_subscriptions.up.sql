-- 047: Web Push subscriptions (do/pwa-push/IMPLEMENTATION.md, D11).
--
-- One row per browser-profile-per-device that enabled push. The endpoint is
-- the push service's globally-unique URL for that browser instance, so it is
-- the natural key: UNIQUE(endpoint) + the upsert's DO UPDATE user_id is what
-- reassigns a shared device to whichever account most recently enabled push
-- there (instead of the old account silently keeping the channel).
--
-- Rows die three ways: ON DELETE CASCADE with the user; a 404/410 from the
-- push service (sender deletes the row); or the opportunistic prune of rows
-- unseen for 180 days (last_seen_at is refreshed by every boot re-POST).

CREATE TABLE push_subscriptions (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint        TEXT   NOT NULL UNIQUE,
    p256dh          TEXT   NOT NULL,
    auth            TEXT   NOT NULL,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_success_at TIMESTAMPTZ
);

-- The sender's hot path: all subscriptions for one user.
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
