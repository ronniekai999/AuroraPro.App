-- Migration 019: Host-controlled watch party countdown.
--
-- Adds two nullable timestamps to watch_parties:
--   scheduled_start_at — the host's planned start time. The server runs a
--     timer per party and at the scheduled moment broadcasts a "starting"
--     event that triggers play across all connected clients. NULL means
--     "no schedule, party plays whenever the host hits play".
--   started_at — the actual moment playback began (either from the
--     scheduled timer firing or from a manual host play). Lets late
--     joiners compute the elapsed-since-start offset deterministically
--     instead of relying on the in-memory PartyState alone.
--
-- Both columns are nullable so existing parties (and new ad-hoc parties
-- that don't use a schedule) continue to work without changes.
ALTER TABLE watch_parties
    ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS started_at         TIMESTAMPTZ NULL;

-- Index on scheduled_start_at for the "upcoming parties" public-listing
-- query (used by the share-to-story flow in Phase 2 of this feature
-- and any future "join an upcoming party" surface).
CREATE INDEX IF NOT EXISTS idx_watch_parties_scheduled
    ON watch_parties (scheduled_start_at)
    WHERE is_active = TRUE AND scheduled_start_at IS NOT NULL;
