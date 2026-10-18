package db

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// EmbeddingCandidate is a media item that needs to be embedded (or re-embedded
// if the model version was bumped). The text fields are exactly what the
// embedding template will be built from — no additional joins needed.
type EmbeddingCandidate struct {
	ID            int64
	Title         string
	Year          int
	Overview      string
	Type          string   // "movie" | "tv"
	Genres        []string // joined from media_genres
	ContentRating string   // e.g. "TV-G", "R" — Phase E2b audience/tone cue
}

// FetchEmbeddingCandidates returns up to `limit` rows that either have no
// embedding yet, or whose stored embedding_version is older than the version
// currently running in code. Ordered by id ASC for deterministic paging.
//
// We aggregate genres in-query (array_agg) so the backfill worker can build
// the embedding text without N+1 lookups.
func (q *Queries) FetchEmbeddingCandidates(ctx context.Context, currentVersion int16, limit int) ([]*EmbeddingCandidate, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := q.pool.Query(ctx, `
		SELECT m.id,
		       m.title,
		       COALESCE(m.year, 0),
		       COALESCE(m.overview, ''),
		       m.type::text,
		       COALESCE(
		         (SELECT array_agg(g.name ORDER BY g.name)
		          FROM media_genres mg
		          JOIN genres g ON g.id = mg.genre_id
		          WHERE mg.media_item_id = m.id),
		         ARRAY[]::text[]
		       ) AS genres,
		       COALESCE(m.content_rating, '')
		FROM media_items m
		WHERE m.embedding IS NULL
		   OR m.embedding_version < $1
		ORDER BY m.id ASC
		LIMIT $2`,
		currentVersion, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("fetch embedding candidates: %w", err)
	}
	defer rows.Close()

	var out []*EmbeddingCandidate
	for rows.Next() {
		c := &EmbeddingCandidate{}
		if err := rows.Scan(&c.ID, &c.Title, &c.Year, &c.Overview, &c.Type, &c.Genres, &c.ContentRating); err != nil {
			return nil, fmt.Errorf("scan embedding candidate: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SetItemEmbedding stores a pre-formatted pgvector literal (e.g. "[0.1,...]")
// alongside the version + timestamp. The literal is built by llm.FormatVector
// in the worker so this package stays free of LLM-specific imports.
//
// This is the UNCONDITIONAL write — used by inline scanner/enricher
// callbacks where the caller has just generated an embedding from the
// freshest text and wants it to win. The backfill worker uses
// SetItemEmbeddingIfStale instead so it doesn't clobber a fresher inline
// write that happened mid-batch.
func (q *Queries) SetItemEmbedding(ctx context.Context, itemID int64, vectorLit string, version int16) error {
	_, err := q.pool.Exec(ctx, `
		UPDATE media_items
		SET embedding = $2::vector,
		    embedding_version = $3,
		    embedded_at = $4
		WHERE id = $1`,
		itemID, vectorLit, version, time.Now(),
	)
	if err != nil {
		return fmt.Errorf("set item embedding: %w", err)
	}
	return nil
}

// SetItemEmbeddingIfStale writes only when the row's current
// embedding_version is still older than `version` (i.e. no inline
// EmbedItem call has bumped it since the backfill worker fetched the
// candidate). Used by the backfill worker to avoid the read-then-write
// race where:
//
//  1. Backfill fetches item X at version 0
//  2. Scanner enriches X → inline EmbedItem writes vNEW with current text
//  3. Backfill finishes batch, writes vNEW with stale text — clobbers (2)
//
// The conditional WHERE makes step 3 a no-op. The row is left at the
// fresher embedding from step 2 and the next backfill cycle skips it.
func (q *Queries) SetItemEmbeddingIfStale(ctx context.Context, itemID int64, vectorLit string, version int16) error {
	_, err := q.pool.Exec(ctx, `
		UPDATE media_items
		SET embedding = $2::vector,
		    embedding_version = $3,
		    embedded_at = $4
		WHERE id = $1 AND (embedding_version IS NULL OR embedding_version < $3)`,
		itemID, vectorLit, version, time.Now(),
	)
	if err != nil {
		return fmt.Errorf("set item embedding (if stale): %w", err)
	}
	return nil
}

// NullAllEmbeddings clears every stored vector (and resets the version) so
// the backfill re-embeds the whole catalog. Called by the embedder's
// model-marker check when the effective embedding model no longer matches
// the model that produced the stored vectors — embeddings from different
// models live in unrelated vector spaces, so serving a mixed column would
// silently corrupt every similarity ranking. Runs post-boot in the backfill
// goroutine (never blocks startup); the HNSW index shrinks as rows null and
// refills as the backfill writes.
func (q *Queries) NullAllEmbeddings(ctx context.Context) (int64, error) {
	tag, err := q.pool.Exec(ctx, `
		UPDATE media_items
		SET embedding = NULL, embedding_version = 0
		WHERE embedding IS NOT NULL`)
	if err != nil {
		return 0, fmt.Errorf("null all embeddings: %w", err)
	}
	return tag.RowsAffected(), nil
}

// SemanticFilter narrows ANN search to a structured slice of the catalog.
// Empty fields are no-ops; pass the zero value to search everywhere.
type SemanticFilter struct {
	MediaType  string   // media_items.type domain: "movie" | "show" | "" (NOT "tv" — that matches no rows)
	Genres     []string // ANY-match: item must have at least one of these genres
	YearMin    int      // 0 = no floor
	YearMax    int      // 0 = no ceiling
	RuntimeMax int      // minutes; 0 = no cap
	ExcludeIDs []int64  // e.g. items already in user history
	// AllowedRatings is the acting profile's ceiling (AllowedRatingsForMax);
	// nil or empty = unrestricted. SemanticSearch fills a restricted page with
	// allowed rows even under the HNSW index, through its exact retry; a retry
	// that fails returns the short page.
	AllowedRatings []string
}

// SemanticHit is one row from a vector search, with the cosine distance kept
// alongside so callers can blend it with other scores (trigram, recency).
type SemanticHit struct {
	Item     *models.MediaItem
	Distance float64 // pgvector cosine distance: 0 = identical, 2 = opposite
}

// SemanticSearch runs a kNN query against media_items.embedding using the
// supplied vector literal (e.g. "[0.1,...]" — produced by llm.FormatVector).
//
// Filters are a WHERE clause, so no returned row ever fails one. When the
// planner uses the HNSW index, though, the scan yields only about
// hnsw.ef_search candidates (100, set in pool.go) and the filters apply to
// those; pgvector before 0.8 has no fallback, and 0.8's iterative scan is off
// by default. A filter that rejects most of the nearest neighbours (a kid
// profile's rating ceiling on an adult-heavy catalog, a media type the catalog
// has few of) then comes back short, possibly empty, although matching rows
// exist further out. A limit above ef_search does the same unfiltered.
//
// So a short page is re-run once as an exact scan. A full page needs no
// retry: it is as good as an unfiltered ANN query of the same depth, which is
// approximate (HNSW recall is lowest at the tail of its window), and making
// ANN exact is not the retry's job. A page that is short because fewer rows
// match pays for one exact scan, filtered before any distance is computed,
// so its cost follows the share of rows the filter passes: reviews measured
// roughly 15-50 ms on a 20k-row catalog with a fifth of it allowed. A short
// page under a filter that passes nearly everything scores every embedded
// row, roughly 90-180 ms there; that is every search with a limit above
// ef_search, including all of them if pool.go's SET hnsw.ef_search fails and
// pgvector's default of 40 applies. If the retry fails for any reason but
// the context ending (cancelled or past its deadline), the short page is
// returned.
//
// Returns hits sorted by ascending distance. Limit defaults to 30.
func (q *Queries) SemanticSearch(ctx context.Context, vectorLit string, filter SemanticFilter, limit int) ([]SemanticHit, error) {
	if limit <= 0 {
		limit = 30
	}

	where := []string{"m.embedding IS NOT NULL"}
	args := []any{vectorLit}
	argIdx := 2

	if filter.MediaType != "" {
		where = append(where, fmt.Sprintf("m.type = $%d", argIdx))
		args = append(args, filter.MediaType)
		argIdx++
	}
	if filter.YearMin > 0 {
		where = append(where, fmt.Sprintf("m.year >= $%d", argIdx))
		args = append(args, filter.YearMin)
		argIdx++
	}
	if filter.YearMax > 0 {
		where = append(where, fmt.Sprintf("m.year <= $%d", argIdx))
		args = append(args, filter.YearMax)
		argIdx++
	}
	if filter.RuntimeMax > 0 {
		where = append(where, fmt.Sprintf("(m.runtime_minutes = 0 OR m.runtime_minutes <= $%d)", argIdx))
		args = append(args, filter.RuntimeMax)
		argIdx++
	}
	if len(filter.ExcludeIDs) > 0 {
		where = append(where, fmt.Sprintf("m.id <> ALL($%d)", argIdx))
		args = append(args, filter.ExcludeIDs)
		argIdx++
	}
	if len(filter.AllowedRatings) > 0 {
		where = append(where, fmt.Sprintf("m.content_rating = ANY($%d)", argIdx))
		args = append(args, filter.AllowedRatings)
		argIdx++
	}
	if len(filter.Genres) > 0 {
		where = append(where, fmt.Sprintf(`EXISTS (
			SELECT 1 FROM media_genres mg
			JOIN genres g ON g.id = mg.genre_id
			WHERE mg.media_item_id = m.id AND g.name ILIKE ANY($%d))`, argIdx))
		args = append(args, filter.Genres)
		argIdx++
	}

	args = append(args, limit)

	query := func(distance, orderBy string) string {
		return fmt.Sprintf(`
		SELECT m.id, m.library_id, m.type, m.title, m.sort_title,
		       COALESCE(m.year, 0), COALESCE(m.overview, ''),
		       COALESCE(m.rating, 0), COALESCE(m.runtime_minutes, 0),
		       COALESCE(m.content_rating, ''),
		       COALESCE(m.poster_path, ''), COALESCE(m.backdrop_path, ''),
		       m.added_at, m.updated_at,
		       %s AS distance
		FROM media_items m
		WHERE %s
		ORDER BY %s
		LIMIT $%d`,
			distance, strings.Join(where, " AND "), orderBy, argIdx,
		)
	}

	hits, err := q.semanticHits(ctx, query(annDistance, annDistance), args)
	if err != nil {
		return nil, fmt.Errorf("semantic search: %w", err)
	}
	if q.testHookSemanticFirstPass != nil {
		hits = q.testHookSemanticFirstPass(hits)
	}
	if len(hits) >= limit {
		return hits, nil
	}
	exact, err := q.semanticHits(ctx, query(exactDistance, "distance"), args)
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("semantic search: exact retry: %w", err)
		}
		slog.Warn("semantic search: exact retry of a short page failed; returning the short page",
			"rows", len(hits), "limit", limit, "error", err)
		return hits, nil
	}
	return exact, nil
}

// annDistance is the ordering the HNSW index serves: a bare distance to a
// parameter, which the first pass selects and orders by.
//
// The exact retry selects exactDistance, the same value through an expression
// the index cannot serve, and orders by that selected column, so the distance
// is computed once per row. The index serves only an ordering that LEADS with
// the bare form; PostgreSQL 17+ will use it for `ORDER BY <bare>, m.id` with
// an incremental sort, so any tiebreaker must follow the non-bare key. Every
// plan left for the retry is exact: some scan that applies the filters
// (sequential or parallel, or a bitmap or btree scan of whichever index the
// planner picks, the partial embedding index among them), then a sort. That
// holds whatever the session's planner settings and however PostgreSQL caches
// the statement.
// It must stay a separate SQL text. The first version re-ran the same text
// with SET LOCAL enable_indexscan = off, which pgx's statement cache defeated:
// after five executions PostgreSQL may switch a prepared statement to a
// generic plan, costed under the settings of whichever execution builds it,
// and a SET does not re-plan a cached plan. Once a first pass built it, every
// retry on that connection ran the HNSW scan again and came back as short as
// the page it was retrying.
const (
	annDistance   = "(m.embedding <=> $1::vector)"
	exactDistance = "(m.embedding <=> $1::vector) + 0"
)

// semanticHits runs one SemanticSearch query.
func (q *Queries) semanticHits(ctx context.Context, sql string, args []any) ([]SemanticHit, error) {
	rows, err := q.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var hits []SemanticHit
	for rows.Next() {
		item := &models.MediaItem{}
		var dist float64
		if err := rows.Scan(
			&item.ID, &item.LibraryID, &item.Type, &item.Title, &item.SortTitle,
			&item.Year, &item.Overview, &item.Rating, &item.RuntimeMin,
			&item.ContentRating, &item.PosterPath, &item.BackdropPath,
			&item.AddedAt, &item.UpdatedAt, &dist,
		); err != nil {
			return nil, fmt.Errorf("scan semantic hit: %w", err)
		}
		hits = append(hits, SemanticHit{Item: item, Distance: dist})
	}
	return hits, rows.Err()
}

// EmbeddingStatus is a snapshot of catalog-wide embedding coverage for the
// admin UI — total media items, how many are embedded at the current version,
// and the implied pending count.
type EmbeddingStatus struct {
	Total    int64 `json:"total"`
	Embedded int64 `json:"embedded"`
	Pending  int64 `json:"pending"`
}

// GetEmbeddingStatus is a single round-trip variant for the admin dashboard:
// counts total media items, those embedded at the current version, and the
// difference (pending). FILTER lets us compute both in one scan.
func (q *Queries) GetEmbeddingStatus(ctx context.Context, currentVersion int16) (EmbeddingStatus, error) {
	var s EmbeddingStatus
	err := q.pool.QueryRow(ctx, `
		SELECT
		  COUNT(*),
		  COUNT(*) FILTER (WHERE embedding IS NOT NULL AND embedding_version >= $1)
		FROM media_items`,
		currentVersion,
	).Scan(&s.Total, &s.Embedded)
	if err != nil {
		return s, fmt.Errorf("embedding status: %w", err)
	}
	s.Pending = s.Total - s.Embedded
	if s.Pending < 0 {
		s.Pending = 0
	}
	return s, nil
}

// CountPendingEmbeddings returns how many rows still need embedding at the
// given version. Used at startup to log progress / decide whether to spawn
// the backfill worker at all.
func (q *Queries) CountPendingEmbeddings(ctx context.Context, currentVersion int16) (int64, error) {
	var n int64
	err := q.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM media_items
		WHERE embedding IS NULL OR embedding_version < $1`,
		currentVersion,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count pending embeddings: %w", err)
	}
	return n, nil
}
