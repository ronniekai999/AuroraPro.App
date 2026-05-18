package db

import (
	"context"
	"errors"
	"fmt"

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
//   (a) require pgvector ≥ 0.7 globally
//   (b) detect the operator at startup and branch
//   (c) pull embeddings to Go and weight there
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
func (q *Queries) BuildProfileVector(ctx context.Context, profileID int64) (string, error) {
	row := q.pool.QueryRow(ctx, `
		WITH recent AS (
		  SELECT m.embedding
		  FROM watch_progress wp
		  JOIN media_items m ON m.id = wp.media_item_id
		  WHERE wp.profile_id = $1
		    AND m.embedding IS NOT NULL
		  ORDER BY wp.completed DESC, wp.updated_at DESC
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

// NearestUnwatched returns the top-N items by cosine distance to the given
// vector, excluding anything the profile has any watch_progress on. Results
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
		  ORDER BY COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id), m.embedding <=> $2::vector
		)
		SELECT id, library_id, type, title, sort_title, year, overview, rating,
		       runtime_minutes, content_rating, poster_path, backdrop_path,
		       added_at, updated_at
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
		if err := rows.Scan(
			&item.ID, &item.LibraryID, &item.Type, &item.Title, &item.SortTitle,
			&item.Year, &item.Overview, &item.Rating, &item.RuntimeMin,
			&item.ContentRating, &item.PosterPath, &item.BackdropPath,
			&item.AddedAt, &item.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan nearest unwatched: %w", err)
		}
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
		  ORDER BY COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id), m.embedding <=> $2::vector
		)
		SELECT id, library_id, type, title, sort_title, year, overview, rating,
		       runtime_minutes, content_rating, poster_path, backdrop_path,
		       added_at, updated_at, embedding_text
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
		if err := rows.Scan(
			&c.Item.ID, &c.Item.LibraryID, &c.Item.Type, &c.Item.Title, &c.Item.SortTitle,
			&c.Item.Year, &c.Item.Overview, &c.Item.Rating, &c.Item.RuntimeMin,
			&c.Item.ContentRating, &c.Item.PosterPath, &c.Item.BackdropPath,
			&c.Item.AddedAt, &c.Item.UpdatedAt, &c.EmbeddingText,
		); err != nil {
			return nil, fmt.Errorf("scan nearest unwatched rich: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// WatchAnchor is a recently-watched item with its embedding, used by the
// rail to attach a "Because you watched X" hint to each recommendation.
type WatchAnchor struct {
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
	rows, err := q.pool.Query(ctx, `
		SELECT m.title, m.type::text, COALESCE(m.year, 0), m.embedding::text
		FROM watch_progress wp
		JOIN media_items m ON m.id = wp.media_item_id
		WHERE wp.profile_id = $1 AND m.embedding IS NOT NULL
		ORDER BY wp.completed DESC, wp.updated_at DESC
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
		if err := rows.Scan(&a.Title, &a.Type, &a.Year, &a.EmbeddingText); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// RecentTasteAnchors returns the titles + types of the most-recently-completed
// (or most-recently-updated) items for a profile. Used by the LLM blurb
// generator to ground "Because you watched X" reasoning in real history.
func (q *Queries) RecentTasteAnchors(ctx context.Context, profileID int64, limit int) ([]TasteAnchor, error) {
	if limit <= 0 {
		limit = 5
	}
	rows, err := q.pool.Query(ctx, `
		SELECT m.title, m.type::text, COALESCE(m.year, 0)
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
	for rows.Next() {
		var a TasteAnchor
		if err := rows.Scan(&a.Title, &a.Type, &a.Year); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// TasteAnchor is one row from RecentTasteAnchors — a recently-watched title
// the user finished or made progress on, used as grounding for blurb generation.
type TasteAnchor struct {
	Title string
	Type  string
	Year  int
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
