-- Migration 027: Partial index for the AI matcher retry pass.
--
-- Migration 026 created `idx_media_items_ai_match_pending` to cover the
-- eval-pass predicate (match_status='needs_review' AND ai_match_ran_at
-- IS NULL). PR #88 then added a retry pass that scans a DIFFERENT
-- predicate — items the matcher already evaluated with confidence above
-- the auto-promote threshold but whose EnrichByTMDBID failed:
--
--   WHERE match_status = 'needs_review'
--     AND ai_match_ran_at IS NOT NULL
--     AND ai_suggested_tmdb_id IS NOT NULL
--     AND ai_match_confidence >= $1
--
-- That predicate isn't covered by the 026 index (which requires
-- ai_match_ran_at IS NULL — the opposite of what the retry pass wants).
-- On a large library, each iteration of the retry pass currently does a
-- seq scan + filter; with the 10k+ flagged backlogs we see on
-- aurorapro.app, that's expensive.
--
-- The confidence threshold is a runtime parameter (default 90, env
-- AI_MATCH_AUTO_THRESHOLD), so we can't bake it into the partial-index
-- predicate. Instead the index narrows to the always-true conditions;
-- Postgres uses it for the initial scan, then applies the confidence
-- filter as a fast in-memory check.

CREATE INDEX IF NOT EXISTS idx_media_items_ai_match_retry_pending
    ON media_items (id)
    WHERE match_status = 'needs_review'
      AND ai_match_ran_at IS NOT NULL
      AND ai_suggested_tmdb_id IS NOT NULL;
