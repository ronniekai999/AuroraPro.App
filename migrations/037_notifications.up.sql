-- Per-user in-app notifications backing the bell + Notifications panel.
--
-- v1 events: 'request_available' (a media request finished downloading/importing
-- and is ready to watch) and 'request_failed' (the *arr service gave up or the
-- item was removed). The request monitor inserts a row on the status transition
-- and pushes a 'notification' WebSocket event. The SPA reads the durable feed via
-- /api/me/notifications so a user who was offline at the transition still sees it
-- — the WS hub is best-effort / online-only and does NOT replay (it even evicts
-- slow clients), so the persisted row is the source of truth.
CREATE TABLE notifications (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        VARCHAR(50) NOT NULL,
    title       TEXT NOT NULL,
    media_type  VARCHAR(20),
    request_id  BIGINT,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Feed query: most-recent-first per user.
CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at DESC);

-- Unread-count query (partial: only the rows the bell badge cares about).
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;

-- Idempotency guard. The request monitor polls every 5s; without this a re-checked
-- row could spawn duplicate notifications. CreateNotification uses ON CONFLICT
-- (user_id, request_id, type) DO NOTHING against this index, so at most one
-- notification exists per (user, request, type). Rows with a NULL request_id
-- (future non-request notifications) are exempt — NULLs are distinct in a unique
-- index, so they never collide.
CREATE UNIQUE INDEX idx_notifications_dedup ON notifications(user_id, request_id, type);
