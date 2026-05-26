// queries_matching.go owns the DB-side surface for the AI re-matching
// pipeline introduced in migration 026. Lives in a sibling file to
// queries_embedding.go because both subsystems share the same backfill
// shape (paged candidate fetch → per-item work → conditional write back).
//
// Import discipline: this file holds the boundary type AISuggestionUpdate.
// The matching package (internal/matching) converts its higher-level
// Suggestion struct into this DB-flat form before calling UpdateAISuggestion.
// Keeping the boundary type here mirrors the EmbeddingCandidate precedent in
// queries_embedding.go and avoids a db → matching → db import cycle.
package db

import (
	"context"
	"fmt"

	"github.com/aurora-media/aurora/internal/models"
)

// AISuggestionUpdate carries the LLM matcher's verdict to UpdateAISuggestion.
// All fields are pointer-typed so the persisted columns reflect the
// difference between "AI ran but had nothing to suggest" (all fields nil)
// and "AI returned a real suggestion" (fields populated). The "ran_at"
// timestamp is set unconditionally by the query itself, so this struct
// never carries that field — every UpdateAISuggestion call is an
// evaluation marker, with or without a suggestion attached.
type AISuggestionUpdate struct {
	TMDBID     *int
	Title      *string
	Year       *int    // SMALLINT in the schema; matcher clamps to [0, 32767]
	Confidence *int    // 0..100; matcher clamps before passing
	Reasoning  *string // one short sentence; matcher truncates before passing
}

// CountFlagged returns the total number of items in match_status =
// 'needs_review' regardless of whether AI has evaluated them. Exposed for
// the admin dashboard so it can show "X flagged / Y AI-evaluated" without
// two round trips on the same predicate.
func (q *Queries) CountFlagged(ctx context.Context) (int, error) {
	var n int
	err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM media_items WHERE match_status = 'needs_review'`,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count flagged: %w", err)
	}
	return n, nil
}

// CountFlaggedWithoutAISuggestion returns how many flagged items have not
// yet been evaluated by the AI matcher. The backfill worker calls this at
// startup to decide whether to spawn at all (same pattern as
// CountPendingEmbeddings) and again to populate JobStatus.Total when a
// manual run kicks off via the admin endpoint.
//
// Exact predicate matches the idx_media_items_ai_match_pending partial
// index from migration 026, so this is O(unevaluated items), not a full
// scan.
func (q *Queries) CountFlaggedWithoutAISuggestion(ctx context.Context) (int, error) {
	var n int
	err := q.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM media_items
		WHERE match_status = 'needs_review' AND ai_match_ran_at IS NULL`,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count flagged without ai suggestion: %w", err)
	}
	return n, nil
}

// GetFlaggedWithoutAISuggestion pages through items the AI matcher hasn't
// touched yet, in id-ascending order for deterministic paging. Each call
// returns up to `limit` rows; the backfill loop calls in a tight loop and
// stops when this returns zero rows (no cursor / OFFSET needed because
// successful evaluations stamp ai_match_ran_at and drop out of the partial
// index between iterations).
//
// Returns *models.MediaItem populated with the fields the matcher needs to
// build a prompt: title, year, type, plus a representative file_path so the
// LLM can use the filename as a tiebreaker between candidates. AI-suggestion
// fields are NOT selected because by construction (the WHERE clause) every
// returned row has ai_match_ran_at IS NULL — they'd all be empty.
func (q *Queries) GetFlaggedWithoutAISuggestion(ctx context.Context, limit int) ([]*models.MediaItem, error) {
	if limit <= 0 {
		limit = 25
	}
	rows, err := q.pool.Query(ctx, `
		SELECT m.id, m.library_id, m.type, m.title, m.sort_title,
		       COALESCE(m.year, 0), COALESCE(m.overview, ''),
		       COALESCE(m.rating, 0), COALESCE(m.runtime_minutes, 0),
		       COALESCE(m.content_rating, ''),
		       COALESCE(m.poster_path, ''), COALESCE(m.backdrop_path, ''),
		       m.added_at, m.updated_at,
		       COALESCE(
		           (SELECT mf.path FROM media_files mf WHERE mf.media_item_id = m.id ORDER BY mf.id LIMIT 1),
		           (SELECT ef.path FROM episode_files ef
		            JOIN tv_episodes ep ON ep.id = ef.episode_id
		            WHERE ep.media_item_id = m.id
		            ORDER BY ep.season_id, ep.episode_number, ef.id LIMIT 1),
		           ''
		       ) AS file_path
		FROM media_items m
		WHERE m.match_status = 'needs_review' AND m.ai_match_ran_at IS NULL
		ORDER BY m.id ASC
		LIMIT $1`,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("get flagged without ai suggestion: %w", err)
	}
	defer rows.Close()

	var items []*models.MediaItem
	for rows.Next() {
		item := &models.MediaItem{}
		if err := rows.Scan(
			&item.ID, &item.LibraryID, &item.Type, &item.Title, &item.SortTitle,
			&item.Year, &item.Overview, &item.Rating, &item.RuntimeMin, &item.ContentRating,
			&item.PosterPath, &item.BackdropPath,
			&item.AddedAt, &item.UpdatedAt,
			&item.FilePath,
		); err != nil {
			return nil, fmt.Errorf("scan flagged candidate: %w", err)
		}
		item.MatchStatus = "needs_review"
		items = append(items, item)
	}
	return items, rows.Err()
}

// UpdateAISuggestion persists the matcher's verdict and bumps
// ai_match_ran_at = NOW(). MUST be called with a non-nil u; pass
// MarkAIEvaluated for the "evaluated but no suggestion" path so a prior
// successful suggestion isn't nulled out on a later failed re-run.
//
// NOTE: this does NOT change match_status. Auto-promotion to 'matched'
// happens via the existing enricher.EnrichByTMDBID path inside the
// matcher itself, which writes match_status='matched' AND fully populates
// poster/cast/genres in one atomic-feeling sweep. Splitting the
// match_status flip into this query would create a transient row where
// the item is "matched" but has no TMDB metadata — bad for the UI.
func (q *Queries) UpdateAISuggestion(ctx context.Context, itemID int64, u *AISuggestionUpdate) error {
	if u == nil {
		// Nil-input was previously a documented "mark evaluated" shortcut;
		// callers should now use MarkAIEvaluated explicitly to avoid the
		// silent data loss described in the deep-debugger review (Bug 2.1).
		return q.MarkAIEvaluated(ctx, itemID)
	}
	_, err := q.pool.Exec(ctx, `
		UPDATE media_items SET
		    ai_suggested_tmdb_id = $2,
		    ai_suggested_title   = $3,
		    ai_suggested_year    = $4,
		    ai_match_confidence  = $5,
		    ai_match_reasoning   = $6,
		    ai_match_ran_at      = NOW()
		WHERE id = $1`,
		itemID, u.TMDBID, u.Title, u.Year, u.Confidence, u.Reasoning,
	)
	if err != nil {
		return fmt.Errorf("update ai suggestion: %w", err)
	}
	return nil
}

// MarkAIEvaluated stamps ai_match_ran_at = NOW() WITHOUT touching the
// suggestion columns. Used for the "we tried but had nothing to suggest"
// paths in the matcher: TMDB returned zero candidates, the LLM call
// errored, or the response failed to parse. Distinct from
// UpdateAISuggestion(nil) so a re-run failure can't wipe an earlier
// successful suggestion (deep-debugger Bug 2.1).
//
// The backfill loop's WHERE clause filters on ai_match_ran_at IS NULL,
// so stamping here is what removes the item from the eval queue. Without
// this call the loop would re-process the same failed item forever.
func (q *Queries) MarkAIEvaluated(ctx context.Context, itemID int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE media_items SET ai_match_ran_at = NOW() WHERE id = $1`, itemID)
	if err != nil {
		return fmt.Errorf("mark ai evaluated: %w", err)
	}
	return nil
}
