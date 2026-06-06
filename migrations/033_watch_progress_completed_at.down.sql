DROP INDEX IF EXISTS idx_watch_progress_completed_at;
ALTER TABLE watch_progress DROP COLUMN IF EXISTS completed_at;
