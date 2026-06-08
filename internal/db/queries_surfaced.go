package db

import (
	"context"
	"fmt"
	"time"
)

// RecordSurfaced remembers that the recommender just SHOWED itemIDs to a profile
// on `surface` (e.g. "hero", "discover"), so subsequent NearestUnwatched recalls
// can demote them and rotate fresh titles in (anti-repetition, Phase B2).
//
// Re-showing an item refreshes its recency via ON CONFLICT, and rows older than
// pruneOlderThan are deleted in the same call so the table stays bounded — no
// janitor goroutine. itemIDs are deduped (a duplicate in one INSERT would
// otherwise trip "ON CONFLICT cannot affect row a second time").
//
// Best-effort by contract: callers run this off the hot path on a detached ctx
// and only log the error — a missed record just means slightly less rotation on
// the next build, never a failed recommendation.
func (q *Queries) RecordSurfaced(ctx context.Context, profileID int64, surface string, itemIDs []int64, pruneOlderThan time.Duration) error {
	if surface == "" || len(itemIDs) == 0 {
		return nil
	}
	seen := make(map[int64]struct{}, len(itemIDs))
	uniq := make([]int64, 0, len(itemIDs))
	for _, id := range itemIDs {
		if id <= 0 {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		uniq = append(uniq, id)
	}
	if len(uniq) == 0 {
		return nil
	}

	if _, err := q.pool.Exec(ctx, `
		INSERT INTO recently_surfaced_items (profile_id, media_item_id, surface)
		SELECT $1, unnest($2::bigint[]), $3
		ON CONFLICT (profile_id, media_item_id, surface) DO UPDATE SET surfaced_at = NOW()`,
		profileID, uniq, surface,
	); err != nil {
		return fmt.Errorf("record surfaced: %w", err)
	}

	// Bound the table: drop this (profile, surface)'s rows older than the prune
	// horizon. Callers pass >= the demotion window, so a row still inside the
	// window is never deleted.
	if pruneOlderThan > 0 {
		if _, err := q.pool.Exec(ctx, `
			DELETE FROM recently_surfaced_items
			WHERE profile_id = $1 AND surface = $2
			  AND surfaced_at < NOW() - INTERVAL '1 second' * $3`,
			profileID, surface, int64(pruneOlderThan.Seconds()),
		); err != nil {
			return fmt.Errorf("prune surfaced: %w", err)
		}
	}
	return nil
}
