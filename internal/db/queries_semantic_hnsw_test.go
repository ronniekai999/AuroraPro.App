package db

// Integration test for SemanticSearch under the HNSW index. When the planner
// uses the index, pgvector yields about hnsw.ef_search candidates and applies
// the WHERE clause to those, so a selective filter (a kid profile's rating
// ceiling on an adult-heavy catalog) used to return a short page, or nothing,
// although matching rows existed further out. Opt-in via TEST_DATABASE_URL.

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// hnswWindowQueries is a Queries whose sessions force the planner onto the
// HNSW index, with a one-candidate window (ef_search 1) so that every index
// page longer than one row comes back short. That is the condition a large
// catalog meets under the default plan whenever the filter rejects most of
// the ~100 candidates, made deterministic: with a real window, HNSW's graph
// search is approximate, and on a small fixture it sometimes reaches the
// allowed rows anyway.
//
// Turning seqscan off is not enough to force the index: a scan of
// idx_media_items_embedding_version (partial, on embedding IS NOT NULL) plus a
// sort is exact too, and the planner flips to it as statistics change. With
// sorts off as well, the HNSW scan is the only plan with no disabled node.
// The exact retry still has no HNSW plan at all, which is what it relies on; a
// retry that only disabled index scans loses to HNSW under these settings
// (through cost penalties, or on PostgreSQL 18 by breaking ties between
// disabled plans on cost).
//
// hnsw.ef_search is 1, a one-candidate window; extra holds further session
// settings; maxConns > 0 caps the pool.
func hnswWindowQueries(t *testing.T, maxConns int32, extra ...string) *Queries {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		t.Fatalf("parse test db url: %v", err)
	}
	if maxConns > 0 {
		cfg.MaxConns = maxConns
	}
	stmts := append([]string{
		// Load pgvector first so hnsw.ef_search exists, as pool.go does.
		"SELECT '[0]'::vector(1)",
		"SET enable_seqscan = off", "SET enable_sort = off", "SET hnsw.ef_search = 1",
	}, extra...)
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		for _, stmt := range stmts {
			if _, err := conn.Exec(ctx, stmt); err != nil {
				return err
			}
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect to test db: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping test db: %v", err)
	}
	return NewQueries(pool)
}

// TestSemanticSearchFillsAFilteredPageUnderTheHNSWIndex: the index path
// returns at most one row of a five-row page, so the search must notice the
// short page and fill it exactly. Sixty over-ceiling rows sit nearer the query
// than the five allowed ones, so the exact page also proves the retry keeps
// the filter.
//
// The generic-plan case runs every statement on one connection with
// plan_cache_mode = force_generic_plan. That makes deterministic what the
// default mode does after five executions of a statement: PostgreSQL reuses a
// generic plan, costed under the settings of the execution that built it. A
// retry that re-ran the first pass's SQL text then got the first pass's HNSW
// plan back whatever it SET, and returned the same short page.
func TestSemanticSearchFillsAFilteredPageUnderTheHNSWIndex(t *testing.T) {
	for _, tc := range []struct {
		name     string
		maxConns int32
		extra    []string
	}{
		{name: "default_plan_cache"},
		{name: "generic_plans", maxConns: 1, extra: []string{"SET plan_cache_mode = force_generic_plan"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			checkHNSWWindowFill(t, hnswWindowQueries(t, tc.maxConns, tc.extra...))
		})
	}
}

// hnswFixture is sixty R rows nearest a per-run query direction and
// allowedRows PG rows further out (cosine distance 0.2 to 0.3). Each set is
// inserted alternately from its two ends (nearest, farthest, second nearest,
// ...), so ids follow distance in neither direction and a sort by id, either
// way, cannot pass for one by distance.
type hnswFixture struct {
	query   string
	allowed map[int64]bool
	// ranked holds the PG rows' ids, nearest first.
	ranked []int64
	// decoys holds the R rows' ids.
	decoys []int64
}

// nearest is the set of the n nearest PG rows.
func (f hnswFixture) nearest(n int) map[int64]bool {
	out := map[int64]bool{}
	for _, id := range f.ranked[:n] {
		out[id] = true
	}
	return out
}

func seedHNSWFixture(t *testing.T, q *Queries, allowedRows int) hnswFixture {
	t.Helper()
	libID := seedTypedLibrary(t, q, seedTestUser(t, q), "movie")
	token := "hnswwin" + randomSuffix(t)

	// A random direction across two dimensions (8,100 combinations), so
	// concurrent runs of this test practically never share one: a run on the
	// same first dimension but another second one sits at cosine distance 0.5,
	// beyond this run's allowed rows at 0.2. Other tests' sparse vectors sit
	// outside dimensions 400-599, and the shared catalog sits at distance ~1.
	a, b := 400+rand.Intn(90), 500+rand.Intn(90)
	const rOffset, pgOffset = 590, 595
	f := hnswFixture{query: sparseVec768(map[int]float64{a: 1, b: 1}), allowed: map[int64]bool{}, ranked: make([]int64, allowedRows)}
	for _, i := range fromBothEnds(60) {
		f.decoys = append(f.decoys, seedSearchCeilingItem(t, q, libID, fmt.Sprintf("%s r%d", token, i), ratingPtr("R"),
			sparseVec768(map[int]float64{a: 1, b: 1, rOffset: 0.001 * float64(i+1)})))
	}
	for _, i := range fromBothEnds(allowedRows) {
		// cos((1,1,x), (1,1)) = 0.8 at x ≈ 1.06: cosine distance ~0.2, and
		// about 0.3 at the fiftieth row, still short of a concurrent run's 0.5.
		id := seedSearchCeilingItem(t, q, libID, fmt.Sprintf("%s pg%d", token, i), ratingPtr("PG"),
			sparseVec768(map[int]float64{a: 1, b: 1, pgOffset: 1.06 + 0.005*float64(i)}))
		f.allowed[id] = true
		f.ranked[i] = id
	}
	return f
}

// fromBothEnds is 0..n-1 taken alternately from each end: 0, n-1, 1, n-2, ...
func fromBothEnds(n int) []int {
	out := make([]int, 0, n)
	for lo, hi := 0, n-1; lo <= hi; lo, hi = lo+1, hi-1 {
		out = append(out, lo)
		if hi != lo {
			out = append(out, hi)
		}
	}
	return out
}

// directIndexCount runs the first pass's plain index query under a ceiling
// and counts its rows.
func directIndexCount(t *testing.T, q *Queries, query string, allowedRatings []string, limit int) int {
	t.Helper()
	var n int
	if err := q.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM (
		   SELECT 1 FROM media_items m
		   WHERE m.embedding IS NOT NULL AND m.content_rating = ANY($2)
		   ORDER BY m.embedding <=> $1::vector LIMIT $3) s`,
		query, allowedRatings, limit).Scan(&n); err != nil {
		t.Fatalf("direct index query: %v", err)
	}
	return n
}

func checkAscending(t *testing.T, hits []SemanticHit) {
	t.Helper()
	for i := 1; i < len(hits); i++ {
		if hits[i].Distance < hits[i-1].Distance {
			t.Errorf("hits not in ascending distance at %d: %v after %v", i, hits[i].Distance, hits[i-1].Distance)
		}
	}
}

// TestSemanticSearchRetriesAShortButNonEmptyPage: the retry must fire on any
// short page, not only an empty one. A regression to "retry when empty" would
// bring back the original symptom (7-10 rows of 50), and the HNSW cases above
// cannot see it: their one-candidate window almost always comes back empty,
// and a wider window can too, when dead index entries from other tests'
// deleted rows fill it. So the first pass runs exactly (index scans off, so
// it finds this fixture's allowed rows) and a hook drops one. The page is the
// production recall size, 50, so a page one row short is 98% full and any
// tolerance short of the full limit (90% as a float, limit - limit/10) fails.
// Five more allowed rows than the page holds lie further out, so a retry
// that asked for more than the page shows too. The short page also holds one
// of those, as an approximate page can, so a retry that only topped the page
// up with the rows it lacks keeps a row from beyond the page and fails.
func TestSemanticSearchRetriesAShortButNonEmptyPage(t *testing.T) {
	const limit = 50
	q := exactScanQueries(t)
	f := seedHNSWFixture(t, q, limit+5)
	firstPass := -1
	q.testHookSemanticFirstPass = func(hits []SemanticHit) []SemanticHit {
		firstPass = len(hits)
		if len(hits) < 2 {
			return hits
		}
		beyond := SemanticHit{Item: &models.MediaItem{ID: f.ranked[limit+4]}, Distance: hits[len(hits)-2].Distance}
		return append(hits[:len(hits)-2:len(hits)-2], beyond)
	}
	allowedRatings := AllowedRatingsForMax("PG")

	hits, err := q.SemanticSearch(context.Background(), f.query, SemanticFilter{AllowedRatings: allowedRatings}, limit)
	if err != nil {
		t.Fatalf("SemanticSearch: %v", err)
	}
	if firstPass != limit {
		t.Fatalf("precondition: the exact first pass returned %d rows, want a full page of %d", firstPass, limit)
	}
	// A first pass one row short loses a row unless the page is retried.
	checkFilledPage(t, hits, f.nearest(limit), limit)
}

func checkHNSWWindowFill(t *testing.T, q *Queries) {
	t.Helper()
	ctx := context.Background()
	f := seedHNSWFixture(t, q, 5)
	query, allowed := f.query, f.allowed
	allowedRatings := AllowedRatingsForMax("PG")

	// Precondition: in these sessions the plain index path really is short.
	direct := directIndexCount(t, q, query, allowedRatings, 5)
	if direct >= 5 {
		t.Fatalf("precondition: the index path returned %d of 5 rows; the fixture no longer reproduces the candidate window", direct)
	}

	// The first pass itself must still be the index scan: an ordering the
	// index cannot serve would make every search an exact scan, and the page
	// would then come back full, retry or not.
	firstPass := -1
	q.testHookSemanticFirstPass = func(hits []SemanticHit) []SemanticHit {
		firstPass = len(hits)
		return hits
	}
	hits, err := q.SemanticSearch(ctx, query, SemanticFilter{AllowedRatings: allowedRatings}, 5)
	if err != nil {
		t.Fatalf("SemanticSearch: %v", err)
	}
	if firstPass < 0 || firstPass >= 5 {
		t.Errorf("SemanticSearch's first pass returned %d of 5 rows where the index path returns %d; it no longer runs as an index scan", firstPass, direct)
	}
	checkFilledPage(t, hits, allowed, 5)
}

// checkFilledPage checks that hits holds every row of allowed, and no more
// than limit rows, all within the PG ceiling and in ascending distance.
func checkFilledPage(t *testing.T, hits []SemanticHit, allowed map[int64]bool, limit int) {
	t.Helper()
	if len(hits) > limit {
		t.Errorf("SemanticSearch returned %d rows for a page of %d", len(hits), limit)
	}
	got := map[int64]bool{}
	for _, h := range hits {
		got[h.Item.ID] = true
		if !RatingAllowed("PG", h.Item.ContentRating) {
			t.Errorf("PG ceiling returned item %d rated %q", h.Item.ID, h.Item.ContentRating)
		}
	}
	for id := range allowed {
		if !got[id] {
			t.Errorf("SemanticSearch lost the allowed row %d: got %d of %d rows", id, len(hits), limit)
		}
	}
	checkAscending(t, hits)
}

// TestSemanticSearchRetryFailures pins what a short page does when its exact
// retry fails: a cancelled search reports the cancellation, and any other
// failure falls back to the short page rather than failing the search.
func TestSemanticSearchRetryFailures(t *testing.T) {
	seeder := exactScanQueries(t)
	f := seedHNSWFixture(t, seeder, 5)
	allowedRatings := AllowedRatingsForMax("PG")
	short := func(before func()) func([]SemanticHit) []SemanticHit {
		return func(hits []SemanticHit) []SemanticHit {
			before()
			if len(hits) > 1 {
				hits = hits[:len(hits)-1]
			}
			return hits
		}
	}

	t.Run("cancelled", func(t *testing.T) {
		q := exactScanQueries(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		q.testHookSemanticFirstPass = short(cancel)
		hits, err := q.SemanticSearch(ctx, f.query, SemanticFilter{AllowedRatings: allowedRatings}, 5)
		if !errors.Is(err, context.Canceled) {
			t.Errorf("a search cancelled before its retry returned %d hits and err %v; want context.Canceled", len(hits), err)
		}
	})

	t.Run("past its deadline", func(t *testing.T) {
		q := exactScanQueries(t)
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		q.testHookSemanticFirstPass = short(func() { <-ctx.Done() })
		hits, err := q.SemanticSearch(ctx, f.query, SemanticFilter{AllowedRatings: allowedRatings}, 5)
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("a search past its deadline before its retry returned %d hits and err %v; want context.DeadlineExceeded", len(hits), err)
		}
	})

	t.Run("failed", func(t *testing.T) {
		q := exactScanQueries(t)
		q.testHookSemanticFirstPass = short(q.pool.Close)
		hits, err := q.SemanticSearch(context.Background(), f.query, SemanticFilter{AllowedRatings: allowedRatings}, 5)
		if err != nil {
			t.Fatalf("a failed retry failed the search: %v; want the short page", err)
		}
		if len(hits) != 4 {
			t.Errorf("a failed retry returned %d hits, want the first pass's 4", len(hits))
		}
	})
}

// TestSemanticSearchFillsAPageBeyondTheLargestWindow: 1,100 over-ceiling rows
// sit nearer the query than the five allowed ones, more than pgvector's
// largest candidate window (hnsw.ef_search 1000), so no index scan of any
// window reaches the allowed rows and only an exact retry fills the page. The
// five-row cases above put only sixty rows in front, which a retry that just
// widened the window would get past.
func TestSemanticSearchFillsAPageBeyondTheLargestWindow(t *testing.T) {
	const nearer = 1100
	q := hnswWindowQueries(t, 0)
	ctx := context.Background()
	libID := seedTypedLibrary(t, q, seedTestUser(t, q), "movie")
	token := "hnswwide" + randomSuffix(t)
	a, b := 400+rand.Intn(90), 500+rand.Intn(90)
	query := sparseVec768(map[int]float64{a: 1, b: 1})
	// The R rows, in one statement: (1, 1, x) with x up to 0.11 on dimension
	// 590, within cosine distance ~0.003 of the query. Columns as in
	// seedSearchCeilingItem.
	if _, err := q.pool.Exec(ctx, `
		INSERT INTO media_items
		  (library_id, type, title, sort_title, tmdb_id, year, overview, rating, runtime_minutes,
		   content_rating, poster_path, backdrop_path, embedding, added_at, last_metadata_attempt)
		SELECT $1, 'movie', $2 || g, $2 || g, $3 + g, 0, '', 0, 0, 'R', '', '',
		       (SELECT array_agg(CASE WHEN d = $4 OR d = $5 THEN 1.0 WHEN d = 590 THEN 0.0001 * g ELSE 0.0 END ORDER BY d)
		        FROM generate_series(0, 767) d)::vector,
		       NOW() - interval '30 days', NOW()
		FROM generate_series(1, $6::int) g`,
		libID, token+" r", uniqueTMDBID(t), a, b, nearer); err != nil {
		t.Fatalf("seed the nearer rows: %v", err)
	}
	allowed := map[int64]bool{}
	for _, i := range fromBothEnds(5) {
		allowed[seedSearchCeilingItem(t, q, libID, fmt.Sprintf("%s pg%d", token, i), ratingPtr("PG"),
			sparseVec768(map[int]float64{a: 1, b: 1, 595: 1.06 + 0.005*float64(i)}))] = true
	}
	allowedRatings := AllowedRatingsForMax("PG")

	// Precondition: under the largest window the index path is still short.
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec(ctx, "SET LOCAL hnsw.ef_search = 1000"); err != nil {
		t.Fatalf("widen the window: %v", err)
	}
	var widest int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM (
		  SELECT 1 FROM media_items m
		  WHERE m.embedding IS NOT NULL AND m.content_rating = ANY($2)
		  ORDER BY m.embedding <=> $1::vector LIMIT 5) s`, query, allowedRatings).Scan(&widest); err != nil {
		t.Fatalf("index query under the largest window: %v", err)
	}
	_ = tx.Rollback(ctx)
	if widest >= 5 {
		// HNSW search is approximate. Run alone, this window never reached the
		// allowed rows; with another run filling the shared index it sometimes
		// does, and the case then proves nothing, so it skips rather than fail.
		t.Skipf("precondition: under ef_search 1000 the index path returned %d of 5 rows; the fixture did not put the allowed rows beyond the window here", widest)
	}

	hits, err := q.SemanticSearch(ctx, query, SemanticFilter{AllowedRatings: allowedRatings}, 5)
	if err != nil {
		t.Fatalf("SemanticSearch: %v", err)
	}
	checkFilledPage(t, hits, allowed, 5)
}

// semanticQueryCounter counts the SemanticSearch statements a pool runs.
type semanticQueryCounter struct{ n atomic.Int32 }

func (c *semanticQueryCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "AS distance") {
		c.n.Add(1)
	}
	return ctx
}

func (c *semanticQueryCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// TestSemanticSearchRunsOneQueryForAFullPage: the exact retry is paid only by
// a short page. A full first page is as good as any HNSW result, and an
// unconditional retry would make every search an exact scan.
func TestSemanticSearchRunsOneQueryForAFullPage(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		t.Fatalf("parse test db url: %v", err)
	}
	// Index scans off, so the first pass is exact and finds the whole page.
	cfg.ConnConfig.RuntimeParams["enable_indexscan"] = "off"
	counter := &semanticQueryCounter{}
	cfg.ConnConfig.Tracer = counter
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("connect to test db: %v", err)
	}
	t.Cleanup(pool.Close)
	q := NewQueries(pool)
	f := seedHNSWFixture(t, q, 5)
	allowedRatings := AllowedRatingsForMax("PG")

	counter.n.Store(0)
	hits, err := q.SemanticSearch(context.Background(), f.query, SemanticFilter{AllowedRatings: allowedRatings}, 5)
	if err != nil {
		t.Fatalf("SemanticSearch: %v", err)
	}
	checkFilledPage(t, hits, f.allowed, 5)
	if got := counter.n.Load(); got != 1 {
		t.Errorf("a full first page ran %d search queries, want 1: the exact retry is for short pages only", got)
	}

	// The counter does see a retry.
	q.testHookSemanticFirstPass = func(hits []SemanticHit) []SemanticHit { return hits[:len(hits)-1] }
	counter.n.Store(0)
	if _, err := q.SemanticSearch(context.Background(), f.query, SemanticFilter{AllowedRatings: allowedRatings}, 5); err != nil {
		t.Fatalf("SemanticSearch: %v", err)
	}
	if got := counter.n.Load(); got != 2 {
		t.Errorf("a short first page ran %d search queries, want 2", got)
	}
}

// TestSemanticSearchRetryKeepsEveryFilter: the retry must fire, and keep its
// filter, for every filter SemanticSearch takes, not only a ceiling. Each
// case, with no ceiling, makes the fixture's five farther rows the only ones
// its filter passes, and its sixty nearer rows fail it.
func TestSemanticSearchRetryKeepsEveryFilter(t *testing.T) {
	ctx := context.Background()
	exec := func(t *testing.T, q *Queries, sql string, args ...any) {
		t.Helper()
		if _, err := q.pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("set up the filter: %v", err)
		}
	}
	ids := func(set map[int64]bool) []int64 {
		out := make([]int64, 0, len(set))
		for id := range set {
			out = append(out, id)
		}
		return out
	}
	for _, tc := range []struct {
		name  string
		setup func(t *testing.T, q *Queries, f hnswFixture) SemanticFilter
	}{
		{"media type", func(t *testing.T, q *Queries, f hnswFixture) SemanticFilter {
			exec(t, q, `UPDATE media_items SET type = 'show' WHERE id = ANY($1)`, ids(f.allowed))
			return SemanticFilter{MediaType: "show"}
		}},
		{"year", func(t *testing.T, q *Queries, f hnswFixture) SemanticFilter {
			exec(t, q, `UPDATE media_items SET year = 2001 WHERE id = ANY($1)`, ids(f.allowed))
			// Decoys on both sides, so dropping either bound lets some in.
			exec(t, q, `UPDATE media_items SET year = 1980 WHERE id = ANY($1)`, f.decoys[:30])
			exec(t, q, `UPDATE media_items SET year = 2020 WHERE id = ANY($1)`, f.decoys[30:])
			return SemanticFilter{YearMin: 1995, YearMax: 2005}
		}},
		{"runtime", func(t *testing.T, q *Queries, f hnswFixture) SemanticFilter {
			exec(t, q, `UPDATE media_items SET runtime_minutes = 90 WHERE id = ANY($1)`, ids(f.allowed))
			exec(t, q, `UPDATE media_items SET runtime_minutes = 200 WHERE id = ANY($1)`, f.decoys)
			return SemanticFilter{RuntimeMax: 120}
		}},
		{"exclusions", func(t *testing.T, q *Queries, f hnswFixture) SemanticFilter {
			return SemanticFilter{ExcludeIDs: f.decoys}
		}},
		{"genre", func(t *testing.T, q *Queries, f hnswFixture) SemanticFilter {
			name := "hnswgenre" + randomSuffix(t)
			var genreID int64
			if err := q.pool.QueryRow(ctx, `INSERT INTO genres (name) VALUES ($1) RETURNING id`, name).Scan(&genreID); err != nil {
				t.Fatalf("seed genre: %v", err)
			}
			t.Cleanup(func() { _, _ = q.pool.Exec(context.Background(), `DELETE FROM genres WHERE id = $1`, genreID) })
			exec(t, q, `INSERT INTO media_genres (media_item_id, genre_id) SELECT unnest($1::bigint[]), $2`, ids(f.allowed), genreID)
			return SemanticFilter{Genres: []string{name}}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := hnswWindowQueries(t, 0)
			f := seedHNSWFixture(t, q, 5)
			filter := tc.setup(t, q, f)
			firstPass := -1
			q.testHookSemanticFirstPass = func(hits []SemanticHit) []SemanticHit {
				firstPass = len(hits)
				return hits
			}
			hits, err := q.SemanticSearch(ctx, f.query, filter, 5)
			if err != nil {
				t.Fatalf("SemanticSearch: %v", err)
			}
			if firstPass < 0 || firstPass >= 5 {
				t.Fatalf("precondition: the first pass returned %d of 5 rows; the index window no longer comes back short", firstPass)
			}
			checkFilledPage(t, hits, f.allowed, 5)
		})
	}
}
