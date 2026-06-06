-- Add completed_at to watch_progress so "finished this week" stats have an
-- accurate completion timestamp. updated_at can't be used: it moves on every
-- post-completion heartbeat (the BEFORE UPDATE trigger), so an old completion
-- that's been re-touched would look recent.
--
-- Nullable and deliberately NOT backfilled: backfilling from updated_at would
-- falsely place historical completions inside the recent window. It's
-- populated going forward by UpsertWatchProgress, set to NOW() only on the
-- false->true completion transition (and preserved thereafter).
ALTER TABLE watch_progress ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Supports the weekly aggregate: completed rows for a user, by completion time.
CREATE INDEX IF NOT EXISTS idx_watch_progress_completed_at
    ON watch_progress(user_id, completed_at) WHERE completed;
