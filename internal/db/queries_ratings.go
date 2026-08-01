package db

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
)

// Star ratings — per-(profile, item) explicit 1-5★ verdicts (migration 048).
// Graded steering for the recommender, layered on top of Phase D's binary
// thumbs:
//
//   - 4-5★ feeds the taste centroid like a 👍/seed (see the BuildProfileVector
//     UNION in queries_recommender.go) — "more like this."
//   - 1-2★ excludes the title from every PROACTIVE recommendation surface via
//     the shared lowRatedNotExists fragment below, removes it from the taste
//     slice (so an abandoned 5-minute watch stops pulling the centroid toward
//     it), keeps it out of the "Because You Watched X" anchor pool, and is fed
//     to the hero/discover LLM prompts as an explicit anti-taste anchor
//     (LowRatedAnchors).
//   - 3★ is neutral: stored and displayed, no steering.
//
// Like thumbs, ratings are deliberately NOT applied to explicit search
// (Cmd+K, AI collections): search is intent-driven recall — if you go looking
// for a title by name you should still find it, rating or not.

// Star thresholds for the steering behaviors above. The SQL fragments below
// inline the literals (SQL consts can't interpolate); keep them in sync.
const (
	// positiveStarsMin — ratings at/above this feed the taste centroid.
	positiveStarsMin = 4
	// negativeStarsMax — ratings at/below this exclude + anti-anchor.
	negativeStarsMax = 2
)

// lowRatedNotExists is a WHERE-clause fragment (leading space, no trailing
// whitespace) concatenated into every recall query so 1-2★ titles stop being
// proactively recommended. Same contract as dislikedNotExists (its Phase D
// sibling, appended alongside it at every recall site; anchor selection —
// RecentAnchorsWithEmbeddings — takes both too, so neither a 👎'd nor a
// panned title can headline a rail): reuses the caller's $1 (always the
// profileID) and the `m` media_items alias every recall query already has; it
// adds NO new bind parameter.
const lowRatedNotExists = ` AND NOT EXISTS (SELECT 1 FROM user_ratings lr WHERE lr.profile_id = $1 AND lr.media_item_id = m.id AND lr.stars <= 2)`

// SetUserRating upserts a profile's star rating on an item (1-5). One row per
// (profile, item): re-rating replaces the prior verdict and refreshes
// updated_at (so rating ordering in the taste slice reflects the latest
// action).
func (q *Queries) SetUserRating(ctx context.Context, profileID, mediaItemID int64, stars int) error {
	if stars < 1 || stars > 5 {
		return fmt.Errorf("invalid stars %d (want 1-5)", stars)
	}
	_, err := q.pool.Exec(ctx, `
		INSERT INTO user_ratings (profile_id, media_item_id, stars)
		VALUES ($1, $2, $3)
		ON CONFLICT (profile_id, media_item_id)
		DO UPDATE SET stars = EXCLUDED.stars, updated_at = NOW()`,
		profileID, mediaItemID, stars)
	if err != nil {
		return fmt.Errorf("set user rating: %w", err)
	}
	return nil
}

// DeleteUserRating clears a profile's star rating on an item (the un-rate
// path). No-op if there was no rating.
func (q *Queries) DeleteUserRating(ctx context.Context, profileID, mediaItemID int64) error {
	_, err := q.pool.Exec(ctx,
		`DELETE FROM user_ratings WHERE profile_id = $1 AND media_item_id = $2`,
		profileID, mediaItemID)
	if err != nil {
		return fmt.Errorf("delete user rating: %w", err)
	}
	return nil
}

// GetUserRating returns the profile's star rating on an item, or 0 when the
// item is unrated.
func (q *Queries) GetUserRating(ctx context.Context, profileID, mediaItemID int64) (int, error) {
	var stars int
	err := q.pool.QueryRow(ctx,
		`SELECT stars FROM user_ratings WHERE profile_id = $1 AND media_item_id = $2`,
		profileID, mediaItemID).Scan(&stars)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("get user rating: %w", err)
	}
	return stars, nil
}

// LowRatedAnchors returns the profile's most recent 1-2★ titles, shaped like
// RecentTasteAnchors (Stars always set). Fed to the hero/discover prompts as
// an explicit anti-taste block so the LLM can steer AWAY from what the user
// panned — the recall-side lowRatedNotExists only removes the titles
// themselves; this is what demotes their close neighbors. No embedding
// requirement: a panned title without a vector is still a valid avoid signal.
func (q *Queries) LowRatedAnchors(ctx context.Context, profileID int64, limit int) ([]TasteAnchor, error) {
	if limit <= 0 {
		limit = 3
	}
	rows, err := q.pool.Query(ctx, `
		SELECT m.id, m.title, m.type::text, COALESCE(m.year, 0), COALESCE(m.content_rating, ''), ur.stars
		FROM user_ratings ur
		JOIN media_items m ON m.id = ur.media_item_id
		WHERE ur.profile_id = $1 AND ur.stars <= 2
		ORDER BY ur.updated_at DESC
		LIMIT $2`,
		profileID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("low rated anchors: %w", err)
	}
	defer rows.Close()
	var out []TasteAnchor
	var ids []int64
	for rows.Next() {
		var a TasteAnchor
		if err := rows.Scan(&a.ID, &a.Title, &a.Type, &a.Year, &a.ContentRating, &a.Stars); err != nil {
			return nil, err
		}
		out = append(out, a)
		ids = append(ids, a.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Batch-attach genres so the prompts can tell the model WHAT about the
	// panned title to avoid (its genres/tone), not just its name. Non-fatal —
	// degrades to name-only avoid signal.
	if len(ids) > 0 {
		byID, gerr := q.GetMediaGenresBatch(ctx, ids)
		if gerr != nil {
			slog.Warn("low rated anchors: genre attach failed; avoid signal degrades to title-only",
				"error", gerr, "profile_id", profileID, "anchor_count", len(ids))
		} else {
			for i := range out {
				if g, ok := byID[out[i].ID]; ok {
					out[i].Genres = g
				}
			}
		}
	}
	return out, nil
}
