package db

import (
	"context"
	"fmt"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// Phase C — proprietary engagement-driven rails. These queries rank by Aurora's
// own first-party signals (local watch heat, completion, runtime, rating) rather
// than the taste vector or the LLM, so the rails are cheap, fast, and keep
// working when the Cloud LLM is down. They reuse the same engagement aggregate
// the Aurora Score is built on (scoringEngagementJoins) and the same eligibility
// + unwatched-exclusion shape as NearestUnwatched.

// railItemCols is the standard media_items projection scanned by scanRailItems —
// the same column set NearestUnwatched returns (minus the distance), so the
// items render identically in a rail card.
const railItemCols = `m.id, m.library_id, m.type, m.title, m.sort_title,
	       COALESCE(m.year, 0), COALESCE(m.overview, ''), COALESCE(m.rating, 0),
	       COALESCE(m.runtime_minutes, 0), COALESCE(m.content_rating, ''),
	       COALESCE(m.poster_path, ''), COALESCE(m.backdrop_path, ''),
	       m.added_at, m.updated_at`

// scanRailItems scans rows projected in railItemCols order into MediaItems.
func scanRailItems(rows pgx.Rows) ([]*models.MediaItem, error) {
	var out []*models.MediaItem
	for rows.Next() {
		it := &models.MediaItem{}
		if err := rows.Scan(
			&it.ID, &it.LibraryID, &it.Type, &it.Title, &it.SortTitle,
			&it.Year, &it.Overview, &it.Rating, &it.RuntimeMin, &it.ContentRating,
			&it.PosterPath, &it.BackdropPath, &it.AddedAt, &it.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan rail item: %w", err)
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// TrendingUnwatched returns the items with the highest recent local watch heat
// server-wide that THIS profile hasn't watched/seeded — "catching fire right
// now." Heat is the same time-decayed event sum as the Aurora Score, but with a
// shorter decay (decayDays) and a recency window (windowDays) so it reflects the
// last few weeks, gated to items with at least minStarts plays so a single watch
// can't trend. allowedRatings (nil = unrestricted) age-gates like NearestUnwatched.
func (q *Queries) TrendingUnwatched(ctx context.Context, profileID int64, allowedRatings []string, decayDays float64, windowDays, minStarts, limit int) ([]*models.MediaItem, error) {
	rows, err := q.pool.Query(ctx, `
		WITH heat AS (
		    SELECT media_item_id,
		           SUM((CASE WHEN completed THEN 1.0 ELSE 0.4 END)::float8
		               * exp(-GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(completed_at, updated_at))) / 86400.0)::float8 / $2)) AS heat
		    FROM watch_progress
		    WHERE COALESCE(completed_at, updated_at) > now() - ($3 * interval '1 day')
		    GROUP BY media_item_id
		    HAVING (COUNT(*) FILTER (WHERE position_ms > 0 OR completed)) >= $4
		)
		SELECT `+railItemCols+`
		FROM media_items m
		JOIN heat h ON h.media_item_id = m.id
		WHERE m.backdrop_path IS NOT NULL AND m.backdrop_path <> ''
		  AND ($5::text[] IS NULL OR m.content_rating = ANY($5))
		  AND NOT EXISTS (SELECT 1 FROM watch_progress wp WHERE wp.profile_id = $1 AND wp.media_item_id = m.id)
		  AND NOT EXISTS (SELECT 1 FROM taste_seeds ts WHERE ts.profile_id = $1 AND ts.media_item_id = m.id)`+dislikedNotExists+`
		ORDER BY h.heat DESC
		LIMIT $6`,
		profileID, decayDays, windowDays, minStarts, allowedRatings, limit)
	if err != nil {
		return nil, fmt.Errorf("trending unwatched: %w", err)
	}
	defer rows.Close()
	return scanRailItems(rows)
}

// HiddenGems returns high-quality titles that few people HERE have watched, and
// that THIS profile hasn't — "great titles audiences haven't found yet." Quality
// is the TMDB rating (gated by minRating + minVotes so it's trustworthy, not a
// 2-vote 10.0); "hidden" is a low LOCAL play count (starts <= maxStarts). On a
// fresh library where most items are unwatched this gracefully degrades to
// "highest-rated unwatched," which is still the right surface.
func (q *Queries) HiddenGems(ctx context.Context, profileID int64, allowedRatings []string, minRating float64, minVotes, maxStarts, limit int) ([]*models.MediaItem, error) {
	rows, err := q.pool.Query(ctx, `
		WITH eng AS (
		    SELECT media_item_id, (COUNT(*) FILTER (WHERE position_ms > 0 OR completed))::int AS starts
		    FROM watch_progress GROUP BY media_item_id
		)
		SELECT `+railItemCols+`
		FROM media_items m
		LEFT JOIN eng e ON e.media_item_id = m.id
		WHERE m.backdrop_path IS NOT NULL AND m.backdrop_path <> ''
		  AND ($5::text[] IS NULL OR m.content_rating = ANY($5))
		  AND m.rating >= $2 AND COALESCE(m.vote_count, 0) >= $3
		  AND COALESCE(e.starts, 0) <= $4
		  AND NOT EXISTS (SELECT 1 FROM watch_progress wp WHERE wp.profile_id = $1 AND wp.media_item_id = m.id)
		  AND NOT EXISTS (SELECT 1 FROM taste_seeds ts WHERE ts.profile_id = $1 AND ts.media_item_id = m.id)`+dislikedNotExists+`
		ORDER BY m.rating DESC, COALESCE(m.vote_count, 0) DESC
		LIMIT $6`,
		profileID, minRating, minVotes, maxStarts, allowedRatings, limit)
	if err != nil {
		return nil, fmt.Errorf("hidden gems: %w", err)
	}
	defer rows.Close()
	return scanRailItems(rows)
}

// FinishTonightShortMovies returns unwatched MOVIES short enough to finish in one
// sitting (runtime in [runtimeMin, runtimeMax]), ranked by quality — "fits the
// evening you've got." Movies only (a half-watched show belongs in Continue
// Watching, which has its own rail); excludes what this profile already watched.
func (q *Queries) FinishTonightShortMovies(ctx context.Context, profileID int64, allowedRatings []string, runtimeMin, runtimeMax, limit int) ([]*models.MediaItem, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT `+railItemCols+`
		FROM media_items m
		WHERE m.type = 'movie'
		  AND m.runtime_minutes BETWEEN $2 AND $3
		  AND m.backdrop_path IS NOT NULL AND m.backdrop_path <> ''
		  AND m.rating > 0
		  AND ($4::text[] IS NULL OR m.content_rating = ANY($4))
		  AND NOT EXISTS (SELECT 1 FROM watch_progress wp WHERE wp.profile_id = $1 AND wp.media_item_id = m.id)
		  AND NOT EXISTS (SELECT 1 FROM taste_seeds ts WHERE ts.profile_id = $1 AND ts.media_item_id = m.id)`+dislikedNotExists+`
		ORDER BY m.rating DESC, COALESCE(m.vote_count, 0) DESC
		LIMIT $5`,
		profileID, runtimeMin, runtimeMax, allowedRatings, limit)
	if err != nil {
		return nil, fmt.Errorf("finish tonight: %w", err)
	}
	defer rows.Close()
	return scanRailItems(rows)
}

// ComfortRewatch returns titles THIS profile has completed, newest-finished
// first — "worth a rewatch." DISTINCT ON (m.id) collapses a show's many completed
// episodes to one card. Returns empty for a profile with no completions (the rail
// is then skipped). This is the one engagement rail that surfaces WATCHED items.
//
// Signal is intentionally loose: a show qualifies once ANY episode is completed
// (watch_progress keys episodes by episode_id under the show's media_item_id),
// not the whole series — fine for a cosmetic, watched-only "comfort" rail.
func (q *Queries) ComfortRewatch(ctx context.Context, profileID int64, allowedRatings []string, limit int) ([]*models.MediaItem, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT id, library_id, type, title, sort_title, year, overview, rating,
		       runtime_minutes, content_rating, poster_path, backdrop_path, added_at, updated_at
		FROM (
		    SELECT DISTINCT ON (m.id)
		           m.id, m.library_id, m.type, m.title, m.sort_title,
		           COALESCE(m.year, 0) AS year, COALESCE(m.overview, '') AS overview, COALESCE(m.rating, 0) AS rating,
		           COALESCE(m.runtime_minutes, 0) AS runtime_minutes, COALESCE(m.content_rating, '') AS content_rating,
		           COALESCE(m.poster_path, '') AS poster_path, COALESCE(m.backdrop_path, '') AS backdrop_path,
		           m.added_at, m.updated_at,
		           wp.completed_at AS ca, wp.updated_at AS ua
		    FROM media_items m
		    JOIN watch_progress wp ON wp.media_item_id = m.id
		    WHERE wp.profile_id = $1 AND wp.completed = TRUE
		      AND m.backdrop_path IS NOT NULL AND m.backdrop_path <> ''
		      AND ($2::text[] IS NULL OR m.content_rating = ANY($2))`+dislikedNotExists+`
		    ORDER BY m.id, wp.completed_at DESC NULLS LAST, wp.updated_at DESC
		) d
		ORDER BY ca DESC NULLS LAST, ua DESC
		LIMIT $3`,
		profileID, allowedRatings, limit)
	if err != nil {
		return nil, fmt.Errorf("comfort rewatch: %w", err)
	}
	defer rows.Close()
	return scanRailItems(rows)
}
