package db

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// ErrInsufficientHistory is returned when a profile has fewer than the
// minimum number of embedded watched items needed to compute a meaningful
// taste vector. Callers should fall back to a generic "popular" pool.
var ErrInsufficientHistory = errors.New("insufficient watch history for personalization")

// minHistoryItems is how many embedded watched items we require before we
// trust the averaged taste vector. Below this we'd be recommending based on
// a single weekend's watching, which is noisy.
const minHistoryItems = 3

// BuildProfileVector returns a single taste vector for a profile, computed
// as the UNWEIGHTED average of the profile's 20 most recent watched items
// (ordered by completed DESC, updated_at DESC).
//
// HARD-LEARNED HISTORY — do not "improve" this back to weighted math.
//
// Two attempts at recency × completion weighted averaging failed in
// production on the deployed pgvector version. Both shapes of the natural
// formula errored at runtime:
//
//	SUM(embedding * w) / SUM(w)
//	  with w as float8 → "operator does not exist: vector * double precision"
//	  with w as real   → "operator does not exist: vector * real"
//
// pgvector's `vector * scalar` operator was added in v0.7.0 (Jan 2024).
// This Aurora install runs an older pgvector that has `sum(vector)`,
// `AVG(vector)`, and the distance operators (<->, <=>) but NOT scalar
// multiplication. We could:
//
//	(a) require pgvector ≥ 0.7 globally
//	(b) detect the operator at startup and branch
//	(c) pull embeddings to Go and weight there
//
// All three are more work than they're worth for a perceived improvement
// over the (already-working) unweighted approach. The top-20-by-recency
// slice IS itself a form of recency weighting — items older than 20
// finishes ago drop to weight 0, which is the same effect EXP(-days/30)
// produces past ~60 days, just discretized.
//
// If a future caller observes that the centroid feels stale, the right
// fix is option (c) — pull the 20 embeddings + their weights to Go,
// compute the weighted mean with float32 math, and re-format as a
// pgvector text literal. ~140 KB transfer per call which is fine at
// our cache hit rate (24h hero, async-fill rail). Until then: trust the
// unweighted slice.
//
// Returned as a pgvector text literal so callers can pass it straight back
// into SemanticSearch / NearestUnwatched without Go-side allocation.
//
// Returns ErrInsufficientHistory when fewer than minHistoryItems embedded
// items are available — the caller should switch to a non-personalized pool.
//
// Taste onboarding: a profile's taste_seeds (the "Pick What You Love" picks)
// are UNION'd into the same recency slice as completed watches, so a brand-new
// profile with zero watch history but >= minHistoryItems seeds still yields a
// vector — that's the cold-start bootstrap. Seeds the profile has since watched
// are skipped (the real watch row supersedes them), which is also how the
// onboarding prior fades out as genuine history accrues. Seeds stay in the
// unweighted slice — nothing to weight, so the HARD-LEARNED note above holds.
func (q *Queries) BuildProfileVector(ctx context.Context, profileID int64) (string, error) {
	row := q.pool.QueryRow(ctx, `
		WITH recent AS (
		  SELECT embedding FROM (
		    SELECT m.embedding,
		           wp.completed  AS completed,
		           wp.updated_at AS ts
		    FROM watch_progress wp
		    JOIN media_items m ON m.id = wp.media_item_id
		    WHERE wp.profile_id = $1
		      AND m.embedding IS NOT NULL
		    UNION ALL
		    SELECT m.embedding,
		           TRUE          AS completed,
		           ts.created_at AS ts
		    FROM taste_seeds ts
		    JOIN media_items m ON m.id = ts.media_item_id
		    WHERE ts.profile_id = $1
		      AND m.embedding IS NOT NULL
		      AND NOT EXISTS (
		        SELECT 1 FROM watch_progress wp2
		        WHERE wp2.profile_id = $1 AND wp2.media_item_id = ts.media_item_id
		      )
		  ) src
		  ORDER BY completed DESC, ts DESC
		  LIMIT 20
		)
		SELECT
		  COUNT(*),
		  CASE WHEN COUNT(*) > 0
		       THEN AVG(embedding)::text
		       ELSE NULL
		  END
		FROM recent`,
		profileID,
	)
	var count int
	var vec *string
	if err := row.Scan(&count, &vec); err != nil {
		return "", fmt.Errorf("build profile vector: %w", err)
	}
	if count < minHistoryItems || vec == nil {
		return "", ErrInsufficientHistory
	}
	return *vec, nil
}

// PersonalizationHistoryCount returns the number of embedded inputs
// BuildProfileVector would count for the profile: embedded watch_progress rows
// PLUS embedded taste_seeds the profile hasn't watched yet. Exposed for UI
// cold-start hints ("Watch X more titles to unlock personalized picks"); once a
// profile has finished taste onboarding this reads as already-personalized.
//
// Capped at 20 to mirror BuildProfileVector's LIMIT — past that we're
// fully personalized and the exact count stops mattering for UX.
func (q *Queries) PersonalizationHistoryCount(ctx context.Context, profileID int64) (int, error) {
	row := q.pool.QueryRow(ctx, `
		SELECT
		  (SELECT COUNT(*)
		     FROM watch_progress wp
		     JOIN media_items m ON m.id = wp.media_item_id
		     WHERE wp.profile_id = $1 AND m.embedding IS NOT NULL)
		  +
		  (SELECT COUNT(*)
		     FROM taste_seeds ts
		     JOIN media_items m ON m.id = ts.media_item_id
		     WHERE ts.profile_id = $1 AND m.embedding IS NOT NULL
		       AND NOT EXISTS (
		         SELECT 1 FROM watch_progress wp2
		         WHERE wp2.profile_id = $1 AND wp2.media_item_id = ts.media_item_id))`,
		profileID,
	)
	var n int
	if err := row.Scan(&n); err != nil {
		return 0, fmt.Errorf("personalization history count: %w", err)
	}
	if n > 20 {
		n = 20
	}
	return n, nil
}

// PersonalizationThreshold is the public-facing read of minHistoryItems.
// Lives here next to BuildProfileVector so the constant + accessor stay
// co-located — easier to maintain than re-deriving the gate in the API
// layer.
func PersonalizationThreshold() int { return minHistoryItems }

// NearestUnwatched returns the top-N items by cosine distance to the given
// vector, excluding anything the profile has watch_progress on OR has seeded
// via taste onboarding (we don't recommend back a title they told us they
// love). Results
// are deduplicated cross-library (same tmdb_id) keeping the richest copy.
//
// Items without a backdrop are filtered out — the hero needs an image.
func (q *Queries) NearestUnwatched(ctx context.Context, profileID int64, vectorLit string, limit int) ([]*models.MediaItem, error) {
	if limit <= 0 {
		limit = 12
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
		         (m.embedding <=> $2::vector) AS distance
		  FROM media_items m
		  WHERE m.embedding IS NOT NULL
		    AND m.backdrop_path IS NOT NULL
		    AND m.backdrop_path <> ''
		    AND NOT EXISTS (
		      SELECT 1 FROM watch_progress wp
		      WHERE wp.profile_id = $1 AND wp.media_item_id = m.id
		    )
		    AND NOT EXISTS (
		      SELECT 1 FROM taste_seeds ts
		      WHERE ts.profile_id = $1 AND ts.media_item_id = m.id
		    )
		  ORDER BY COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id), m.embedding <=> $2::vector
		)
		SELECT id, library_id, type, title, sort_title, year, overview, rating,
		       runtime_minutes, content_rating, poster_path, backdrop_path,
		       added_at, updated_at, distance
		FROM ranked
		ORDER BY distance ASC
		LIMIT $3`,
		profileID, vectorLit, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("nearest unwatched: %w", err)
	}
	defer rows.Close()

	var items []*models.MediaItem
	for rows.Next() {
		item := &models.MediaItem{}
		var distance float64
		if err := rows.Scan(
			&item.ID, &item.LibraryID, &item.Type, &item.Title, &item.SortTitle,
			&item.Year, &item.Overview, &item.Rating, &item.RuntimeMin,
			&item.ContentRating, &item.PosterPath, &item.BackdropPath,
			&item.AddedAt, &item.UpdatedAt, &distance,
		); err != nil {
			return nil, fmt.Errorf("scan nearest unwatched: %w", err)
		}
		// Cosine distance d∈[0,2] on L2-normalized embeddings; similarity =
		// 1-d∈[-1,1]. Clamp negatives to 0 so the frontend never sees a
		// nonsensical match below zero.
		item.MatchScore = matchFromDistance(distance)
		items = append(items, item)
	}
	return items, rows.Err()
}

// RailCandidate is a NearestUnwatched row augmented with the raw embedding
// text so the recommender can do Go-side similarity math (MMR
// diversification, anchor matching). The text is pgvector's text format —
// parse with llm.ParseVector. Kept as a string in transport so we don't
// widen the db package's type dependencies on []float32.
type RailCandidate struct {
	Item          *models.MediaItem
	EmbeddingText string
}

// NearestUnwatchedRich is NearestUnwatched + each row's embedding (as text).
// Used by the rail when we want to do MMR / anchor matching client-side.
// Same WHERE / ORDER BY as NearestUnwatched — embedding column added.
//
// Payload note: 384-dim vectors at 6-digit precision are ~7 KB each. For
// limit=36 that's ~250 KB over the wire — acceptable for a rail that
// loads on home-page navigation, not per-frame.
func (q *Queries) NearestUnwatchedRich(ctx context.Context, profileID int64, vectorLit string, limit int) ([]*RailCandidate, error) {
	if limit <= 0 {
		limit = 24
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
		         m.embedding::text AS embedding_text,
		         (m.embedding <=> $2::vector) AS distance
		  FROM media_items m
		  WHERE m.embedding IS NOT NULL
		    AND m.backdrop_path IS NOT NULL
		    AND m.backdrop_path <> ''
		    AND NOT EXISTS (
		      SELECT 1 FROM watch_progress wp
		      WHERE wp.profile_id = $1 AND wp.media_item_id = m.id
		    )
		    AND NOT EXISTS (
		      SELECT 1 FROM taste_seeds ts
		      WHERE ts.profile_id = $1 AND ts.media_item_id = m.id
		    )
		  ORDER BY COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id), m.embedding <=> $2::vector
		)
		SELECT id, library_id, type, title, sort_title, year, overview, rating,
		       runtime_minutes, content_rating, poster_path, backdrop_path,
		       added_at, updated_at, embedding_text, distance
		FROM ranked
		ORDER BY distance ASC
		LIMIT $3`,
		profileID, vectorLit, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("nearest unwatched rich: %w", err)
	}
	defer rows.Close()

	var out []*RailCandidate
	for rows.Next() {
		c := &RailCandidate{Item: &models.MediaItem{}}
		var distance float64
		if err := rows.Scan(
			&c.Item.ID, &c.Item.LibraryID, &c.Item.Type, &c.Item.Title, &c.Item.SortTitle,
			&c.Item.Year, &c.Item.Overview, &c.Item.Rating, &c.Item.RuntimeMin,
			&c.Item.ContentRating, &c.Item.PosterPath, &c.Item.BackdropPath,
			&c.Item.AddedAt, &c.Item.UpdatedAt, &c.EmbeddingText, &distance,
		); err != nil {
			return nil, fmt.Errorf("scan nearest unwatched rich: %w", err)
		}
		// Same distance→similarity mapping as NearestUnwatched.
		c.Item.MatchScore = matchFromDistance(distance)
		out = append(out, c)
	}
	return out, rows.Err()
}

// matchFromDistance converts a pgvector cosine distance into a [0,1]
// similarity score. Embeddings in media_items.embedding are L2-normalized at
// insert time (see internal/llm/client.go `normalize`), so the cosine
// DISTANCE the `<=>` operator returns is d = 1 - cos(θ) ∈ [0,2], and the
// similarity is 1 - d. We clamp the result to [0,1]: the upper end can't
// exceed 1 for normalized vectors, and the lower clamp guards against the
// (theoretically possible) negative-similarity case for near-opposite
// vectors so the frontend never renders a sub-zero match. Kept here next to
// its only callers (NearestUnwatched / NearestUnwatchedRich) rather than in
// the recommender so the conversion lives where the distance is read.
func matchFromDistance(distance float64) float64 {
	sim := 1 - distance
	// A zero/degenerate embedding makes the cosine distance NaN; NaN fails every
	// comparison below, so guard it explicitly or it would propagate into the
	// user-facing match %.
	if math.IsNaN(sim) || sim < 0 {
		return 0
	}
	if sim > 1 {
		return 1
	}
	return sim
}

// WatchAnchor is a recently-watched item with its embedding, used by the
// rail to attach a "Because you watched X" hint to each recommendation.
type WatchAnchor struct {
	// MediaItemID identifies the underlying title so callers can dedupe
	// anchors. watch_progress holds one row PER EPISODE, so a multi-
	// episode show would otherwise appear as several anchors (→ duplicate
	// "Because you watched <show>" rails). See RecentAnchorsWithEmbeddings.
	MediaItemID   int64
	Title         string
	Year          int
	Type          string
	EmbeddingText string
}

// RecentAnchorsWithEmbeddings returns the profile's N most recent watched
// items that have embeddings, with the embedding text included. Mirrors
// RecentTasteAnchors but adds the embedding column so the recommender can
// score each rail item against each anchor in Go.
//
// Ordering matches BuildProfileVector's slice — completed items first,
// then by recency — so the anchors a rail item could match against are
// the same items that pulled the centroid in the first place.
func (q *Queries) RecentAnchorsWithEmbeddings(ctx context.Context, profileID int64, limit int) ([]*WatchAnchor, error) {
	if limit <= 0 {
		limit = 10
	}
	// watch_progress holds one row PER EPISODE for shows (episode_id NOT
	// NULL; movies get a single item-level row), so a JOIN to media_items
	// returns a binged show once per watched episode. Collapse to ONE
	// anchor per title with
	// DISTINCT ON (m.id): the inner query keeps each title's best progress
	// row (completed first, then most recent), and the outer query re-sorts
	// those one-per-title rows by the same key before LIMIT. Without this a
	// binged show produced N identical "Because you watched <show>" rails.
	rows, err := q.pool.Query(ctx, `
		SELECT id, title, type, year, embedding FROM (
			SELECT DISTINCT ON (m.id)
			       m.id, m.title, m.type::text AS type, COALESCE(m.year, 0) AS year,
			       m.embedding::text AS embedding,
			       wp.completed AS completed, wp.updated_at AS updated_at
			FROM watch_progress wp
			JOIN media_items m ON m.id = wp.media_item_id
			WHERE wp.profile_id = $1 AND m.embedding IS NOT NULL
			ORDER BY m.id, wp.completed DESC, wp.updated_at DESC
		) d
		ORDER BY d.completed DESC, d.updated_at DESC
		LIMIT $2`,
		profileID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("recent anchors with embeddings: %w", err)
	}
	defer rows.Close()
	var out []*WatchAnchor
	for rows.Next() {
		a := &WatchAnchor{}
		if err := rows.Scan(&a.MediaItemID, &a.Title, &a.Type, &a.Year, &a.EmbeddingText); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// RecentTasteAnchors returns the most-recently-completed (or most-recently-
// updated) items for a profile, with title + type + year + genres. Used by
// the LLM blurb generator to ground "Because you watched X" reasoning in
// real history. QA BUG-010 fix: include each anchor's actual genres so the
// LLM doesn't have to infer them from its training data (which led to
// confidently-wrong claims like "action-spy fun similar to Drake & Josh").
func (q *Queries) RecentTasteAnchors(ctx context.Context, profileID int64, limit int) ([]TasteAnchor, error) {
	if limit <= 0 {
		limit = 5
	}
	rows, err := q.pool.Query(ctx, `
		SELECT m.id, m.title, m.type::text, COALESCE(m.year, 0)
		FROM watch_progress wp
		JOIN media_items m ON m.id = wp.media_item_id
		WHERE wp.profile_id = $1 AND m.embedding IS NOT NULL
		ORDER BY wp.completed DESC, wp.updated_at DESC
		LIMIT $2`,
		profileID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("taste anchors: %w", err)
	}
	defer rows.Close()
	var out []TasteAnchor
	var ids []int64
	for rows.Next() {
		var a TasteAnchor
		if err := rows.Scan(&a.ID, &a.Title, &a.Type, &a.Year); err != nil {
			return nil, err
		}
		out = append(out, a)
		ids = append(ids, a.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Batch-attach genres so the rerank prompt can ground per-anchor
	// reasoning in real metadata. Genre lookup failure is non-fatal —
	// degrades to the prior anchor-without-genres behavior rather than
	// failing the hero pool entirely. Log the failure so silent
	// regression-to-buggy-behavior is observable in ops.
	if len(ids) > 0 {
		byID, gerr := q.GetMediaGenresBatch(ctx, ids)
		if gerr != nil {
			slog.Warn("taste anchors: genre attach failed; rationales will fall back to LLM-inferred genres",
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

// TasteAnchor is one row from RecentTasteAnchors — a recently-watched title
// the user finished or made progress on, used as grounding for blurb generation.
// Genres carries the anchor's actual genre tags; passed to the LLM so it
// doesn't have to infer them (QA BUG-010).
type TasteAnchor struct {
	ID     int64
	Title  string
	Type   string
	Year   int
	Genres []string
}

// PopularUnwatched is the cold-start fallback: top-rated items the profile
// hasn't started, with backdrops. Used when BuildProfileVector returns
// ErrInsufficientHistory.
func (q *Queries) PopularUnwatched(ctx context.Context, profileID int64, limit int) ([]*models.MediaItem, error) {
	if limit <= 0 {
		limit = 12
	}
	rows, err := q.pool.Query(ctx, `
		SELECT DISTINCT ON (COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id))
		       m.id, m.library_id, m.type, m.title, m.sort_title,
		       COALESCE(m.year, 0), COALESCE(m.overview, ''),
		       COALESCE(m.rating, 0), COALESCE(m.runtime_minutes, 0),
		       COALESCE(m.content_rating, ''),
		       COALESCE(m.poster_path, ''), COALESCE(m.backdrop_path, ''),
		       m.added_at, m.updated_at
		FROM media_items m
		WHERE m.backdrop_path IS NOT NULL AND m.backdrop_path <> ''
		  AND m.rating > 0
		  AND NOT EXISTS (
		    SELECT 1 FROM watch_progress wp
		    WHERE wp.profile_id = $1 AND wp.media_item_id = m.id
		  )
		  AND NOT EXISTS (
		    SELECT 1 FROM taste_seeds ts
		    WHERE ts.profile_id = $1 AND ts.media_item_id = m.id
		  )
		ORDER BY COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id), m.rating DESC
		LIMIT $2`,
		profileID, limit*2,
	)
	if err != nil {
		return nil, fmt.Errorf("popular unwatched: %w", err)
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
			return nil, fmt.Errorf("scan popular: %w", err)
		}
		items = append(items, item)
		if len(items) >= limit {
			break
		}
	}
	return items, rows.Err()
}

// pgxOK lets us reference pgx.ErrNoRows without an import-cycle if a future
// caller in this package needs it. Free at compile time.
var _ = pgx.ErrNoRows
