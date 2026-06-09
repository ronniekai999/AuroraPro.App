package db

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"time"

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
	row := q.pool.QueryRow(ctx, tasteRecentSliceCTE+`
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

// tasteRecentSliceCTE is the shared "recent taste slice": a profile's top-20
// embedded items by recency — completed/in-progress watches UNION onboarding
// taste_seeds UNION Phase D 👍 item_feedback, deduped. BuildProfileVector
// AVERAGES this slice into a single centroid; ProfileEmbeddingSlice (Phase E1)
// returns the rows UN-averaged for Go-side k-means. ONE const, two callers, so
// the cluster input can never drift from the average input. Binds $1=profileID;
// append a `SELECT … FROM recent` to use it.
const tasteRecentSliceCTE = `
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
		    UNION ALL
		    -- Phase D: 👍 "more like this" feedback steers the centroid like a
		    -- taste seed (counts as completed, recency-weighted by created_at). It
		    -- competes in the same top-20-by-recency slice as watches and seeds; a
		    -- deliberate thumb is a strong signal, so letting fresh thumbs win that
		    -- slice is intended. Deduped against BOTH watch_progress (the real watch
		    -- supersedes the thumb) AND taste_seeds (the seed row already represents
		    -- this title) so a seeded-and-thumbed item isn't double-weighted.
		    SELECT m.embedding,
		           TRUE          AS completed,
		           fb.created_at AS ts
		    FROM item_feedback fb
		    JOIN media_items m ON m.id = fb.media_item_id
		    WHERE fb.profile_id = $1
		      AND fb.feedback = 'up'
		      AND m.embedding IS NOT NULL
		      AND NOT EXISTS (
		        SELECT 1 FROM watch_progress wp3
		        WHERE wp3.profile_id = $1 AND wp3.media_item_id = fb.media_item_id
		      )
		      AND NOT EXISTS (
		        SELECT 1 FROM taste_seeds ts2
		        WHERE ts2.profile_id = $1 AND ts2.media_item_id = fb.media_item_id
		      )
		  ) src
		  ORDER BY completed DESC, ts DESC
		  LIMIT 20
		)`

// ProfileEmbeddingSlice returns the SAME recency slice BuildProfileVector
// averages, but UN-averaged — one pgvector text literal per item — for Go-side
// k-means clustering (Phase E1 multi-centroid taste). Same minHistoryItems gate
// and ErrInsufficientHistory contract, so callers fall back identically.
func (q *Queries) ProfileEmbeddingSlice(ctx context.Context, profileID int64) ([]string, error) {
	rows, err := q.pool.Query(ctx, tasteRecentSliceCTE+`
		SELECT embedding::text FROM recent`,
		profileID,
	)
	if err != nil {
		return nil, fmt.Errorf("profile embedding slice: %w", err)
	}
	defer rows.Close()
	out := make([]string, 0, 20)
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("scan profile embedding slice: %w", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("profile embedding slice rows: %w", err)
	}
	if len(out) < minHistoryItems {
		return nil, ErrInsufficientHistory
	}
	return out, nil
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

// ProfileMaxAgeRating returns a profile's max_age_rating (” when unrestricted
// or the profile row is missing). The recommender expands it via
// AllowedRatingsForMax to age-gate candidate pools without fetching the whole
// profile row on every rail build.
func (q *Queries) ProfileMaxAgeRating(ctx context.Context, profileID int64) (string, error) {
	var rating string
	err := q.pool.QueryRow(ctx,
		`SELECT COALESCE(max_age_rating, '') FROM user_profiles WHERE id = $1`,
		profileID).Scan(&rating)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", nil
		}
		return "", fmt.Errorf("profile max age rating: %w", err)
	}
	return rating, nil
}

// maturityPenaltyExpr (Phase E2c) is a SELECT-list expression that adds a small
// cosine-distance penalty to items whose maturity tier is far from the profile's
// maturity_pref — a SOFT content-tone lean (the HARD ceiling is allowedRatings).
// Self-contained on $1 (profileID) + m.content_rating, so it injects with NO new
// bind param (mirrors dislikedNotExists). It yields 0 when the preference is off
// (-1 → NULLIF → NULL arithmetic → COALESCE 0) or the item's rating is unknown
// (tier NULL → same). 0.04 per tier-step ≈ ~10 recall ranks at the local cosine
// density, so a 2-step gap (~0.08) is a clear lean without overriding the taste
// match. Why text-embedding tone failed but this works: maturity is categorical
// and lives in content_rating; encode it as a structured ranking term, not as a
// few tokens the encoder drowns under the plot overview (Phase E2b, retired).
const maturityPenaltyExpr = `COALESCE(0.04 * ABS(
		           (CASE
		              WHEN m.content_rating IN ('G','TV-Y','TV-Y7','TV-Y7-FV','TV-G','PG','TV-PG') THEN 0
		              WHEN m.content_rating IN ('PG-13','TV-14') THEN 1
		              WHEN m.content_rating IN ('R','TV-MA','NC-17','NC17','X') THEN 2
		              ELSE NULL
		            END)
		           - NULLIF((SELECT maturity_pref FROM user_profiles WHERE id = $1), -1)
		         ), 0)`

// NearestUnwatched returns the top-N items by cosine distance to the given
// vector, excluding anything the profile has watch_progress on OR has seeded
// via taste onboarding (we don't recommend back a title they told us they
// love). Results
// are deduplicated cross-library (same tmdb_id) keeping the richest copy.
//
// Items without a backdrop are filtered out — the hero needs an image.
// surface + withinSeconds drive Phase B2 anti-repetition: when surface != ""
// (and a positive window), items recently SHOWN to this profile on that surface
// (recently_surfaced_items) are DEMOTED — ordered after fresh items — so
// successive rebuilds rotate instead of returning the same top-by-cosine pool.
// It's a demotion, not an exclusion: stale items still backfill if too few fresh
// ones exist (no starvation). surface == "" makes the whole thing a no-op
// (unchanged behavior — that's how NearestUnwatchedRich/anchor-rails stay clean).
func (q *Queries) NearestUnwatched(ctx context.Context, profileID int64, vectorLit string, limit int, allowedRatings []string, surface string, withinSeconds int64) ([]*models.MediaItem, error) {
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
		         (m.embedding <=> $2::vector) AS distance,
		         `+maturityPenaltyExpr+` AS maturity_penalty,
		         ($5::text <> '' AND EXISTS (
		             SELECT 1 FROM recently_surfaced_items rsi
		             WHERE rsi.profile_id = $1 AND rsi.media_item_id = m.id
		               AND rsi.surface = $5
		               AND rsi.surfaced_at > NOW() - INTERVAL '1 second' * $6
		         )) AS recently_surfaced
		  FROM media_items m
		  WHERE m.embedding IS NOT NULL
		    AND m.backdrop_path IS NOT NULL
		    AND m.backdrop_path <> ''
		    AND ($4::text[] IS NULL OR m.content_rating = ANY($4))
		    AND NOT EXISTS (
		      SELECT 1 FROM watch_progress wp
		      WHERE wp.profile_id = $1 AND wp.media_item_id = m.id
		    )
		    AND NOT EXISTS (
		      SELECT 1 FROM taste_seeds ts
		      WHERE ts.profile_id = $1 AND ts.media_item_id = m.id
		    )`+dislikedNotExists+`
		  ORDER BY COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id), m.embedding <=> $2::vector, m.id
		)
		SELECT id, library_id, type, title, sort_title, year, overview, rating,
		       runtime_minutes, content_rating, poster_path, backdrop_path,
		       added_at, updated_at, distance
		FROM ranked
		ORDER BY recently_surfaced ASC, (distance + maturity_penalty) ASC
		LIMIT $3`,
		profileID, vectorLit, limit, allowedRatings, surface, withinSeconds,
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
// Payload note: 768-dim vectors at 6-digit precision are ~14 KB each. For
// limit=36 that's ~500 KB over the wire — acceptable for a rail that
// loads on home-page navigation, not per-frame.
func (q *Queries) NearestUnwatchedRich(ctx context.Context, profileID int64, vectorLit string, limit int, allowedRatings []string) ([]*RailCandidate, error) {
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
		    AND ($4::text[] IS NULL OR m.content_rating = ANY($4))
		    AND NOT EXISTS (
		      SELECT 1 FROM watch_progress wp
		      WHERE wp.profile_id = $1 AND wp.media_item_id = m.id
		    )
		    AND NOT EXISTS (
		      SELECT 1 FROM taste_seeds ts
		      WHERE ts.profile_id = $1 AND ts.media_item_id = m.id
		    )`+dislikedNotExists+`
		  ORDER BY COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id), m.embedding <=> $2::vector, m.id
		)
		SELECT id, library_id, type, title, sort_title, year, overview, rating,
		       runtime_minutes, content_rating, poster_path, backdrop_path,
		       added_at, updated_at, embedding_text, distance
		FROM ranked
		ORDER BY distance ASC
		LIMIT $3`,
		profileID, vectorLit, limit, allowedRatings,
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

// TasteSeedAnchors returns the most-recently-selected taste-onboarding seeds
// for a profile, with title + type + year + genres, shaped exactly like
// RecentTasteAnchors. This is the cold-start fallback for Discover: a
// brand-new profile that finished "Pick What You Love" but has no watch
// history has no RecentTasteAnchors, so buildDiscover falls back to these
// seeds so the Discover rail appears immediately. NOT used by the anchor
// rails or hero, which require real watch history to avoid incorrect
// "Because you watched X" copy for titles the user only selected in onboarding.
func (q *Queries) TasteSeedAnchors(ctx context.Context, profileID int64, limit int) ([]TasteAnchor, error) {
	if limit <= 0 {
		limit = 5
	}
	rows, err := q.pool.Query(ctx, `
		SELECT m.id, m.title, m.type::text, COALESCE(m.year, 0)
		FROM taste_seeds ts
		JOIN media_items m ON m.id = ts.media_item_id
		WHERE ts.profile_id = $1 AND m.embedding IS NOT NULL
		ORDER BY ts.created_at DESC
		LIMIT $2`,
		profileID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("taste seed anchors: %w", err)
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
	// failing the Discover build entirely. Log the failure so silent
	// regression-to-buggy-behavior is observable in ops.
	if len(ids) > 0 {
		byID, gerr := q.GetMediaGenresBatch(ctx, ids)
		if gerr != nil {
			slog.Warn("taste seed anchors: genre attach failed; rationales will fall back to LLM-inferred genres",
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
func (q *Queries) PopularUnwatched(ctx context.Context, profileID int64, limit int, allowedRatings []string) ([]*models.MediaItem, error) {
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
		  AND ($3::text[] IS NULL OR m.content_rating = ANY($3))
		  AND NOT EXISTS (
		    SELECT 1 FROM watch_progress wp
		    WHERE wp.profile_id = $1 AND wp.media_item_id = m.id
		  )
		  AND NOT EXISTS (
		    SELECT 1 FROM taste_seeds ts
		    WHERE ts.profile_id = $1 AND ts.media_item_id = m.id
		  )`+dislikedNotExists+`
		ORDER BY COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id), m.rating DESC
		LIMIT $2`,
		profileID, limit*2, allowedRatings,
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

// ScoreRow is the per-item signal set the Aurora Score needs: rating + vote
// count (Bayesian-shrunk quality), release year + added_at (freshness), and the
// local engagement aggregates (heat, starts/finishes, favourite + collection
// counts). Returned both by ScoringRows (the whole eligible library, the
// population the score is standardized against) and ScoringSignalsByIDs
// (specific hero picks). Zero engagement is the neutral baseline, so a fresh
// library simply scores on quality + freshness.
type ScoreRow struct {
	ID          int64
	Rating      float64
	VoteCount   int
	ReleaseYear int
	AddedAt     time.Time

	// Local engagement (Phase 2). Heat is a time-decayed sum of watch events;
	// Starts/Finishes feed the Wilson completion-quality signal; FavCount /
	// CollectionCount feed affinity.
	Heat            float64
	Starts          int
	Finishes        int
	FavCount        int
	CollectionCount int
}

// scoringEngagementJoins decorates media_items (aliased m) with per-item
// engagement aggregates: time-decayed heat, watch starts/finishes (for
// completion quality), favourite count and collection count. $1 is the heat
// e-folding scale in days. Shared verbatim by ScoringRows and
// ScoringSignalsByIDs so both compute identical signals — the only difference
// between them is the outer WHERE.
const scoringEngagementJoins = `
		LEFT JOIN (
		    SELECT media_item_id,
		           SUM((CASE WHEN completed THEN 1.0 ELSE 0.4 END)::float8
		               * exp(-GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(completed_at, updated_at))) / 86400.0)::float8 / $1)) AS heat,
		           (COUNT(*) FILTER (WHERE position_ms > 0 OR completed))::int AS starts,
		           (COUNT(*) FILTER (WHERE completed))::int AS finishes
		    FROM watch_progress
		    GROUP BY media_item_id
		) wp ON wp.media_item_id = m.id
		LEFT JOIN (
		    SELECT wi.media_item_id, COUNT(*)::int AS cnt
		    FROM watchlist_items wi
		    JOIN watchlists w ON w.id = wi.watchlist_id
		    WHERE w.list_type = 'favorites'
		    GROUP BY wi.media_item_id
		) fav ON fav.media_item_id = m.id
		LEFT JOIN (
		    SELECT media_item_id, COUNT(*)::int AS cnt
		    FROM collection_items
		    GROUP BY media_item_id
		) col ON col.media_item_id = m.id`

// scoringSelectCols is the shared projection (order matches ScoreRow's scan).
const scoringSelectCols = `m.id, COALESCE(m.rating, 0), COALESCE(m.vote_count, 0),
		       COALESCE(m.year, 0), m.added_at,
		       COALESCE(wp.heat, 0)::float8, COALESCE(wp.starts, 0), COALESCE(wp.finishes, 0),
		       COALESCE(fav.cnt, 0), COALESCE(col.cnt, 0)`

// scanScoreRow scans one row in the scoringSelectCols order.
func scanScoreRow(rows pgx.Rows, r *ScoreRow) error {
	return rows.Scan(&r.ID, &r.Rating, &r.VoteCount, &r.ReleaseYear, &r.AddedAt,
		&r.Heat, &r.Starts, &r.Finishes, &r.FavCount, &r.CollectionCount)
}

// ScoringRows returns a ScoreRow for every item eligible to appear in the hero
// (has a backdrop, has a rating) across all libraries. This is the population
// the Aurora Score's z-score is calibrated against — a few thousand lightweight
// rows, cheap to pull and cached by the caller on a TTL. No per-profile
// filtering: the calibration is global, identical for every viewer.
// heatDecayDays is the heat e-folding scale (the recommender owns the knob).
func (q *Queries) ScoringRows(ctx context.Context, heatDecayDays float64) ([]ScoreRow, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT `+scoringSelectCols+`
		FROM media_items m`+scoringEngagementJoins+`
		WHERE m.backdrop_path IS NOT NULL AND m.backdrop_path <> ''
		  AND m.rating > 0`, heatDecayDays)
	if err != nil {
		return nil, fmt.Errorf("scoring rows: %w", err)
	}
	defer rows.Close()
	var out []ScoreRow
	for rows.Next() {
		var r ScoreRow
		if err := scanScoreRow(rows, &r); err != nil {
			return nil, fmt.Errorf("scan scoring row: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ScoringSignalsByIDs returns the ScoreRow for each requested item id, keyed by
// id. Unlike ScoringRows it applies NO eligibility filter — a personalized hero
// pick may be unrated or backdrop-less and still needs a score. Ids absent from
// the result (e.g. deleted between build and lookup) are simply missing from
// the map; empty input returns an empty map.
func (q *Queries) ScoringSignalsByIDs(ctx context.Context, ids []int64, heatDecayDays float64) (map[int64]ScoreRow, error) {
	out := make(map[int64]ScoreRow, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.pool.Query(ctx, `
		SELECT `+scoringSelectCols+`
		FROM media_items m`+scoringEngagementJoins+`
		WHERE m.id = ANY($2)`, heatDecayDays, ids)
	if err != nil {
		return nil, fmt.Errorf("scoring signals: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var r ScoreRow
		if err := scanScoreRow(rows, &r); err != nil {
			return nil, fmt.Errorf("scan scoring signal: %w", err)
		}
		out[r.ID] = r
	}
	return out, rows.Err()
}

// pgxOK lets us reference pgx.ErrNoRows without an import-cycle if a future
// caller in this package needs it. Free at compile time.
var _ = pgx.ErrNoRows
