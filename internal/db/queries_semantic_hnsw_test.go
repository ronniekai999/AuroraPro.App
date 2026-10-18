package db

// Integration test for SemanticSearch under the HNSW index. When the planner
// uses the index, pgvector yields about hnsw.ef_search candidates and applies
// the WHERE clause to those, so a selective filter (a kid profile's rating
// ceiling on an adult-heavy catalog) used to return a short page, or nothing,
// although matching rows existed further out. Opt-in via TEST_DATABASE_URL.

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"testing"
	"time"

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
// The exact retry still has no HNSW plan at all, which is what it relies on;
// a retry that only disabled index scans lost to HNSW here on PostgreSQL 18,
// which breaks ties between disabled plans on cost.
//
// extra holds further session settings; maxConns > 0 caps the pool.
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

func checkHNSWWindowFill(t *testing.T, q *Queries) {
	t.Helper()
	ctx := context.Background()
	libID := seedTypedLibrary(t, q, seedTestUser(t, q), "movie")
	token := "hnswwin" + randomSuffix(t)

	// A random direction across two dimensions (8,100 combinations), so
	// concurrent runs of this test practically never share one: a run on the
	// same first dimension but another second one sits at cosine distance 0.5,
	// beyond this run's allowed rows at 0.2. Other tests use dimensions above
	// 600, and the shared catalog sits at distance ~1.
	a, b := 400+rand.Intn(90), 500+rand.Intn(90)
	const rOffset, pgOffset = 590, 595
	query := sparseVec768(map[int]float64{a: 1, b: 1})
	for i := 0; i < 60; i++ {
		seedSearchCeilingItem(t, q, libID, fmt.Sprintf("%s r%d", token, i), ratingPtr("R"),
			sparseVec768(map[int]float64{a: 1, b: 1, rOffset: 0.001 * float64(i+1)}))
	}
	allowedRatings := AllowedRatingsForMax("PG")
	allowed := map[int64]bool{}
	for i := 0; i < 5; i++ {
		// cos((1,1,x), (1,1)) = 0.8 at x ≈ 1.06: cosine distance ~0.2.
		allowed[seedSearchCeilingItem(t, q, libID, fmt.Sprintf("%s pg%d", token, i), ratingPtr("PG"),
			sparseVec768(map[int]float64{a: 1, b: 1, pgOffset: 1.06 + 0.01*float64(i)}))] = true
	}

	// Precondition: in these sessions the plain index path really is short.
	var direct int
	if err := q.pool.QueryRow(ctx,
		`SELECT count(*) FROM (
		   SELECT 1 FROM media_items m
		   WHERE m.embedding IS NOT NULL AND m.content_rating = ANY($2)
		   ORDER BY m.embedding <=> $1::vector LIMIT 5) s`,
		query, allowedRatings).Scan(&direct); err != nil {
		t.Fatalf("direct index query: %v", err)
	}
	if direct >= 5 {
		t.Fatalf("precondition: the index path returned %d of 5 rows; the fixture no longer reproduces the candidate window", direct)
	}

	hits, err := q.SemanticSearch(ctx, query, SemanticFilter{AllowedRatings: allowedRatings}, 5)
	if err != nil {
		t.Fatalf("SemanticSearch: %v", err)
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
			t.Errorf("SemanticSearch lost the allowed row %d: got %d of 5 rows, while the index path alone found %d", id, len(hits), direct)
		}
	}
	for i := 1; i < len(hits); i++ {
		if hits[i].Distance < hits[i-1].Distance {
			t.Errorf("hits not in ascending distance at %d: %v after %v", i, hits[i].Distance, hits[i-1].Distance)
		}
	}
}
