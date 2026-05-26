-- Migration 026: AI-driven re-match for flagged media items.
--
-- The existing enricher assigns match_status='needs_review' to items whose
-- TMDB title-and-year heuristic confidence lands in 50..84 (see
-- internal/metadata/enricher.go). For a large library this produces a long
-- tail of flagged items the operator has to manually pick TMDB IDs for.
--
-- This migration adds five nullable columns + one timestamp on media_items
-- so an LLM-based matcher (internal/matching) can store its suggestion
-- alongside the existing match_status. The matcher promotes high-confidence
-- suggestions to match_status='matched' directly; sub-threshold suggestions
-- remain visible in the flagged-items admin endpoint so the operator can
-- approve them in one click.
--
-- Column rationale:
--   ai_suggested_tmdb_id  — the TMDB id the LLM picked from a candidate list
--                           we fetched ourselves. Validated against that list
--                           at write-time (defense against the model
--                           hallucinating an id it remembers from training).
--   ai_suggested_title    — denormalized so the admin UI can render the
--                           suggestion without a TMDB round-trip, matching
--                           the existing poster_path/content_rating style.
--   ai_suggested_year     — same rationale.
--   ai_match_confidence   — 0-100 self-reported by the LLM. Same scale as
--                           the existing MATCH_AUTO_THRESHOLD env var so the
--                           operator's mental model carries over.
--   ai_match_reasoning    — one short sentence the LLM emits; surfaced to
--                           the operator as the rationale for the
--                           suggestion. Capped at 280 chars by the matcher.
--   ai_match_ran_at       — sentinel marking "we evaluated this item". The
--                           backfill worker pages by `ai_match_ran_at IS
--                           NULL` so re-runs don't re-evaluate items the
--                           LLM already gave up on.
--
-- All columns are nullable: existing rows are unaffected, and an item the
-- matcher gives up on (no candidates / parse failure) is marked evaluated
-- with NULL TMDB id so it doesn't spin in the backfill loop.

ALTER TABLE media_items
    ADD COLUMN IF NOT EXISTS ai_suggested_tmdb_id INTEGER,
    ADD COLUMN IF NOT EXISTS ai_suggested_title   TEXT,
    ADD COLUMN IF NOT EXISTS ai_suggested_year    SMALLINT,
    ADD COLUMN IF NOT EXISTS ai_match_confidence  SMALLINT,
    ADD COLUMN IF NOT EXISTS ai_match_reasoning   TEXT,
    ADD COLUMN IF NOT EXISTS ai_match_ran_at      TIMESTAMPTZ;

-- Partial index targeting the exact predicate the backfill worker pages on.
-- Same shape as idx_media_items_embedding_pending from migration 014: keeps
-- the index size O(pending items) regardless of total catalog size, so
-- backfill paging stays cheap even with millions of media_items rows.
CREATE INDEX IF NOT EXISTS idx_media_items_ai_match_pending
    ON media_items (id)
    WHERE match_status = 'needs_review' AND ai_match_ran_at IS NULL;
