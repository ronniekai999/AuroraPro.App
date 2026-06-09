package db

import (
	"context"
	"fmt"
)

// Phase D — steerable thumbs. Per-(profile, item) explicit feedback (migration
// 039). 👍 'up' feeds the taste centroid (see the BuildProfileVector UNION); 👎
// 'down' excludes the title from every PROACTIVE recommendation surface (hero,
// discover, engagement rails, popular fallback) via the shared dislikedNotExists
// fragment below. It is deliberately NOT applied to explicit search (Cmd+K,
// AI collections, the home "in the mood for" box): search is intent-driven recall
// — if you go looking for a title by name you should still find it, thumb or not.

// dislikedNotExists is a WHERE-clause fragment (note the leading space, no
// trailing whitespace) concatenated into every recall query so 👎'd titles stop
// appearing. It is whitespace-agnostic — SQL ignores the formatting — so the one
// const drops cleanly into queries with different indentation. It reuses the
// caller's $1 (always the profileID) and the `m` media_items alias that every
// recall query already aliases; it adds NO new bind parameter.
const dislikedNotExists = ` AND NOT EXISTS (SELECT 1 FROM item_feedback di WHERE di.profile_id = $1 AND di.media_item_id = m.id AND di.feedback = 'down')`

// RecordItemFeedback upserts a profile's thumb on an item ('up' | 'down'). One
// row per (profile, item): re-thumbing replaces the prior verdict and refreshes
// recency (so 👍 ordering in BuildProfileVector reflects the latest action).
func (q *Queries) RecordItemFeedback(ctx context.Context, profileID, mediaItemID int64, feedback string) error {
	if feedback != "up" && feedback != "down" {
		return fmt.Errorf("invalid feedback %q (want 'up' or 'down')", feedback)
	}
	_, err := q.pool.Exec(ctx, `
		INSERT INTO item_feedback (profile_id, media_item_id, feedback)
		VALUES ($1, $2, $3)
		ON CONFLICT (profile_id, media_item_id)
		DO UPDATE SET feedback = EXCLUDED.feedback, created_at = NOW()`,
		profileID, mediaItemID, feedback)
	if err != nil {
		return fmt.Errorf("record item feedback: %w", err)
	}
	return nil
}

// DeleteItemFeedback clears a profile's thumb on an item (the un-thumb path).
// No-op if there was no feedback.
func (q *Queries) DeleteItemFeedback(ctx context.Context, profileID, mediaItemID int64) error {
	_, err := q.pool.Exec(ctx,
		`DELETE FROM item_feedback WHERE profile_id = $1 AND media_item_id = $2`,
		profileID, mediaItemID)
	if err != nil {
		return fmt.Errorf("delete item feedback: %w", err)
	}
	return nil
}
