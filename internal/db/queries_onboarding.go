package db

import (
	"context"
	"fmt"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// Taste onboarding ("Pick What You Love") storage + reads.
//
// These power the cold-start bootstrap: a brand-new profile picks a few titles
// it loves, we record them in taste_seeds, and BuildProfileVector folds them
// into the taste vector (see queries_recommender.go) so every AI surface
// personalizes on first load. The recommender logic is untouched — it just has
// something to average now.

// AddTasteSeeds records the profile's onboarding picks. Idempotent: re-adding
// an existing (profile, item) pair is a no-op. source is 'onboarding' | 'vibe'
// | 'refine' (defaults to 'onboarding').
func (q *Queries) AddTasteSeeds(ctx context.Context, profileID int64, mediaItemIDs []int64, source string) error {
	if len(mediaItemIDs) == 0 {
		return nil
	}
	if source == "" {
		source = "onboarding"
	}
	_, err := q.pool.Exec(ctx, `
		INSERT INTO taste_seeds (profile_id, media_item_id, source)
		SELECT $1, mid, $3 FROM unnest($2::bigint[]) AS mid
		ON CONFLICT (profile_id, media_item_id) DO NOTHING`,
		profileID, mediaItemIDs, source)
	if err != nil {
		return fmt.Errorf("add taste seeds: %w", err)
	}
	return nil
}

// ListTasteSeeds returns the profile's seeded media_item_ids, newest first.
func (q *Queries) ListTasteSeeds(ctx context.Context, profileID int64) ([]int64, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT media_item_id FROM taste_seeds WHERE profile_id = $1 ORDER BY created_at DESC`,
		profileID)
	if err != nil {
		return nil, fmt.Errorf("list taste seeds: %w", err)
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// CountTasteSeeds returns how many seeds the profile has — for the onboarding
// status endpoint.
func (q *Queries) CountTasteSeeds(ctx context.Context, profileID int64) (int, error) {
	var n int
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM taste_seeds WHERE profile_id = $1`, profileID).Scan(&n); err != nil {
		return 0, fmt.Errorf("count taste seeds: %w", err)
	}
	return n, nil
}

// ClearTasteSeeds drops all of a profile's seeds — used by "Refine your taste"
// to re-run onboarding from scratch.
func (q *Queries) ClearTasteSeeds(ctx context.Context, profileID int64) error {
	if _, err := q.pool.Exec(ctx,
		`DELETE FROM taste_seeds WHERE profile_id = $1`, profileID); err != nil {
		return fmt.Errorf("clear taste seeds: %w", err)
	}
	return nil
}

// SetTasteOnboardingCompleted flips the per-profile first-run gate.
func (q *Queries) SetTasteOnboardingCompleted(ctx context.Context, profileID int64, done bool) error {
	if _, err := q.pool.Exec(ctx,
		`UPDATE user_profiles SET taste_onboarding_completed = $2, updated_at = NOW() WHERE id = $1`,
		profileID, done); err != nil {
		return fmt.Errorf("set taste onboarding completed: %w", err)
	}
	return nil
}

// LibraryHasEmbeddings reports whether ANY media item is embedded. The taste
// onboarding flow is vector-only, so the UI gates the screen on this: with no
// embeddings the seeds can't feed a vector and the screen would do nothing.
func (q *Queries) LibraryHasEmbeddings(ctx context.Context) (bool, error) {
	var exists bool
	if err := q.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM media_items WHERE embedding IS NOT NULL)`).Scan(&exists); err != nil {
		return false, fmt.Errorf("library has embeddings: %w", err)
	}
	return exists, nil
}

// CountEmbeddedItems returns how many of the given ids are embedded. Used to
// guarantee a seed write actually clears BuildProfileVector's threshold before
// we mark onboarding complete (guards against hand-crafted payloads — the grid
// only ever offers embedded titles).
func (q *Queries) CountEmbeddedItems(ctx context.Context, ids []int64) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	var n int
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM media_items WHERE id = ANY($1::bigint[]) AND embedding IS NOT NULL`,
		ids).Scan(&n); err != nil {
		return 0, fmt.Errorf("count embedded items: %w", err)
	}
	return n, nil
}

// PartialTasteVector averages the embeddings of an arbitrary set of items (the
// titles selected so far) into a pgvector text literal — the live "instant
// preview" rail feeds this into NearestUnwatched. Mirrors BuildProfileVector's
// threshold (minHistoryItems) and ErrInsufficientHistory contract so the rail
// stays empty until the picks are meaningful.
func (q *Queries) PartialTasteVector(ctx context.Context, mediaItemIDs []int64) (string, error) {
	if len(mediaItemIDs) == 0 {
		return "", ErrInsufficientHistory
	}
	row := q.pool.QueryRow(ctx, `
		SELECT COUNT(*),
		       CASE WHEN COUNT(*) > 0 THEN AVG(embedding)::text ELSE NULL END
		FROM media_items
		WHERE id = ANY($1::bigint[]) AND embedding IS NOT NULL`,
		mediaItemIDs)
	var count int
	var vec *string
	if err := row.Scan(&count, &vec); err != nil {
		return "", fmt.Errorf("partial taste vector: %w", err)
	}
	if count < minHistoryItems || vec == nil {
		return "", ErrInsufficientHistory
	}
	return *vec, nil
}

// OnboardingGrid returns the embedded, poster-bearing, popularity-ranked titles
// the profile hasn't watched or already seeded — the pool the "Pick What You
// Love" grid draws from. Embedding-gated so the picks always clear the vector
// threshold. allowedRatings (from allowedRatingsForMax) age-filters the pool for
// restricted profiles; pass nil to disable the filter (unrestricted profile).
// (Phase 0: popularity order; diversity sampling lands in Phase 1.)
func (q *Queries) OnboardingGrid(ctx context.Context, profileID int64, limit int, allowedRatings []string) ([]*models.MediaItem, error) {
	if limit <= 0 {
		limit = 40
	}
	rows, err := q.pool.Query(ctx, `
		WITH ranked AS (
		  SELECT DISTINCT ON (COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id))
		         m.id, m.library_id, m.type, m.title, m.sort_title,
		         COALESCE(m.year, 0) AS year,
		         COALESCE(m.overview, '') AS overview,
		         COALESCE(m.rating, 0) AS rating,
		         COALESCE(m.runtime_minutes, 0) AS runtime_minutes,
		         COALESCE(m.content_rating, '') AS content_rating,
		         COALESCE(m.poster_path, '') AS poster_path,
		         COALESCE(m.backdrop_path, '') AS backdrop_path,
		         m.added_at, m.updated_at,
		         COALESCE(m.popularity, 0) AS popularity
		  FROM media_items m
		  WHERE m.embedding IS NOT NULL
		    AND m.poster_path IS NOT NULL
		    AND m.poster_path <> ''
		    AND ($3::text[] IS NULL OR m.content_rating = ANY($3))
		    AND NOT EXISTS (
		      SELECT 1 FROM watch_progress wp
		      WHERE wp.profile_id = $1 AND wp.media_item_id = m.id
		    )
		    AND NOT EXISTS (
		      SELECT 1 FROM taste_seeds ts
		      WHERE ts.profile_id = $1 AND ts.media_item_id = m.id
		    )
		  ORDER BY COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id), COALESCE(m.popularity, 0) DESC
		)
		SELECT id, library_id, type, title, sort_title, year, overview, rating,
		       runtime_minutes, content_rating, poster_path, backdrop_path,
		       added_at, updated_at
		FROM ranked
		ORDER BY popularity DESC, rating DESC
		LIMIT $2`,
		profileID, limit, allowedRatings,
	)
	if err != nil {
		return nil, fmt.Errorf("onboarding grid: %w", err)
	}
	defer rows.Close()
	var items []*models.MediaItem
	for rows.Next() {
		item := &models.MediaItem{}
		if err := rows.Scan(
			&item.ID, &item.LibraryID, &item.Type, &item.Title, &item.SortTitle,
			&item.Year, &item.Overview, &item.Rating, &item.RuntimeMin,
			&item.ContentRating, &item.PosterPath, &item.BackdropPath,
			&item.AddedAt, &item.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan onboarding grid: %w", err)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// CountSeedsOutsideRatings reports how many of the given ids have a content
// rating that is unknown or NOT within the allowed set — used to reject
// onboarding picks above a restricted profile's max_age_rating before they ever
// reach taste_seeds (and thus the profile's taste vector). allowed comes from
// allowedRatingsForMax; nil/empty means "unrestricted" → returns 0, no query.
func (q *Queries) CountSeedsOutsideRatings(ctx context.Context, ids []int64, allowed []string) (int, error) {
	if len(ids) == 0 || len(allowed) == 0 {
		return 0, nil
	}
	var n int
	if err := q.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM media_items
		WHERE id = ANY($1::bigint[])
		  AND (content_rating IS NULL OR content_rating = '' OR NOT (content_rating = ANY($2::text[])))`,
		ids, allowed).Scan(&n); err != nil {
		return 0, fmt.Errorf("count seeds outside ratings: %w", err)
	}
	return n, nil
}

// GetOrCreateFavoritesWatchlist returns the id of the profile's Favorites
// watchlist, creating it if absent. Onboarding mirrors picks here so they're
// not throwaway.
func (q *Queries) GetOrCreateFavoritesWatchlist(ctx context.Context, profileID int64) (int64, error) {
	var id int64
	err := q.pool.QueryRow(ctx,
		`SELECT id FROM watchlists WHERE profile_id = $1 AND list_type = 'favorites' ORDER BY id LIMIT 1`,
		profileID).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != pgx.ErrNoRows {
		return 0, fmt.Errorf("find favorites watchlist: %w", err)
	}
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO watchlists (profile_id, name, list_type) VALUES ($1, 'Favorites', 'favorites') RETURNING id`,
		profileID).Scan(&id); err != nil {
		return 0, fmt.Errorf("create favorites watchlist: %w", err)
	}
	return id, nil
}

// MirrorSeedsToFavorites adds the seeded titles to the profile's Favorites
// watchlist. Best-effort at the caller (a watchlist hiccup must not fail the
// seed write, which is the real contract).
func (q *Queries) MirrorSeedsToFavorites(ctx context.Context, profileID int64, mediaItemIDs []int64) error {
	if len(mediaItemIDs) == 0 {
		return nil
	}
	favID, err := q.GetOrCreateFavoritesWatchlist(ctx, profileID)
	if err != nil {
		return err
	}
	for _, mid := range mediaItemIDs {
		if err := q.AddToWatchlist(ctx, favID, mid); err != nil {
			return err
		}
	}
	return nil
}
