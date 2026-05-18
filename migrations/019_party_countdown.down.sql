-- Rollback Migration 019.
DROP INDEX IF EXISTS idx_watch_parties_scheduled;
ALTER TABLE watch_parties
    DROP COLUMN IF EXISTS scheduled_start_at,
    DROP COLUMN IF EXISTS started_at;
