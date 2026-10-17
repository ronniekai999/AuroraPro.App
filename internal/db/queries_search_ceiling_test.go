package db

// Integration tests for the rating ceiling on library search. SearchMedia and
// SemanticSearch used to take no rating filter, so a restricted (kid) profile
// could find any title in the library by typing its name or describing it.
// Opt-in via TEST_DATABASE_URL, same harness as the other db-package
// integration tests.

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// exactScanQueries is a Queries on its own pool with index scans disabled, so
// a kNN query is an exact sequential scan whatever the shared catalog holds.
// With enough embedded rows the planner picks the HNSW index, whose candidate
// window (see SemanticSearch) would make a fixture's result depend on
// unrelated rows. That window is a documented gap, not what these tests pin.
func exactScanQueries(t *testing.T) *Queries {
	t.Helper()
	requireIntegrationDB(t) // skips without TEST_DATABASE_URL
	cfg, err := pgxpool.ParseConfig(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("parse test db url: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["enable_indexscan"] = "off"
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

// seedSearchCeilingItem inserts a movie with the given title, rating (nil
// stores SQL NULL) and embedding (empty leaves it NULL). Unrelated scalars are
// zero values rather than NULL, as in seedTypedMediaItem.
func seedSearchCeilingItem(t *testing.T, q *Queries, libID int64, title string, rating *string, vecLit string) int64 {
	t.Helper()
	var vec *string
	if vecLit != "" {
		vec = &vecLit
	}
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO media_items
		   (library_id, type, title, sort_title, tmdb_id, year, overview, rating, runtime_minutes,
		    content_rating, poster_path, backdrop_path, embedding)
		 VALUES ($1, 'movie', $2, $2, $3, 0, '', 0, 0, $4, '', '', $5::vector)
		 RETURNING id`,
		libID, title, uniqueTMDBID(t), rating, vec,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed media item %q: %v", title, err)
	}
	return id
}

// sparseVec768 builds a 768-dim vector literal that is zero except at the
// given indices. The search tests point their vectors at high indices no
// other test uses, so the shared catalog's embeddings are orthogonal to them
// (cosine distance 1) and cannot outrank the fixture.
func sparseVec768(at map[int]float64) string {
	parts := make([]string, 768)
	for i := range parts {
		parts[i] = "0"
	}
	for i, v := range at {
		parts[i] = fmt.Sprintf("%g", v)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// TestSearchMediaAppliesRatingCeilingBeforeLimit: over-ceiling and unrated
// titles that match the query BETTER than the allowed one must not crowd it
// out of a three-row page. Filtering in Go after LIMIT would return none of
// the fixture's allowed rows.
func TestSearchMediaAppliesRatingCeilingBeforeLimit(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	libID := seedTypedLibrary(t, q, seedTestUser(t, q), "movie")
	// No other row can contain this token, so the query matches only the
	// fixture, whatever else is in the catalog.
	token := "srchceil" + randomSuffix(t)

	// Short titles are the closest trigram matches and sort first; the allowed
	// title's long tail makes it the weakest match of the set.
	allowed := seedSearchCeilingItem(t, q, libID, token+" with a much longer tail that dilutes the trigram similarity", ratingPtr("G"), "")
	excluded := map[int64]string{}
	for i := 0; i < 5; i++ {
		excluded[seedSearchCeilingItem(t, q, libID, fmt.Sprintf("%s r%d", token, i), ratingPtr("R"), "")] = "R"
	}
	excluded[seedSearchCeilingItem(t, q, libID, token+" n", nil, "")] = "NULL"
	excluded[seedSearchCeilingItem(t, q, libID, token+" e", ratingPtr(""), "")] = "empty"

	restricted, err := q.SearchMedia(ctx, token, 3, AllowedRatingsForMax("PG"))
	if err != nil {
		t.Fatalf("SearchMedia (restricted): %v", err)
	}
	sawAllowed := false
	for _, it := range restricted {
		if it.ID == allowed {
			sawAllowed = true
		}
		if rating, bad := excluded[it.ID]; bad {
			t.Errorf("PG ceiling returned item %d rated %s", it.ID, rating)
		}
	}
	if !sawAllowed {
		t.Errorf("PG ceiling with limit 3 omitted the G-rated item %d behind closer over-ceiling matches — "+
			"the ceiling must be applied before LIMIT, not after", allowed)
	}

	// Control: unrestricted, the closer matches fill the page, so the allowed
	// row's presence above came from filtering.
	open, err := q.SearchMedia(ctx, token, 3, nil)
	if err != nil {
		t.Fatalf("SearchMedia (unrestricted): %v", err)
	}
	if len(open) != 3 {
		t.Fatalf("unrestricted page has %d rows, want 3", len(open))
	}
	for _, it := range open {
		if it.ID == allowed {
			t.Errorf("unrestricted three-row page held the weakest match %d; the fixture no longer proves ordering", allowed)
		}
	}
}

// TestSemanticSearchAppliesRatingCeilingBeforeLimit is the same contract for
// the vector leg: rows nearer the query but over the ceiling (or unrated) must
// not crowd an allowed, farther row out of the kNN page. It pins the filter's
// placement in the query, under exact scans (exactScanQueries); the HNSW
// candidate window SemanticSearch documents is not exercised here.
func TestSemanticSearchAppliesRatingCeilingBeforeLimit(t *testing.T) {
	q := exactScanQueries(t)
	ctx := context.Background()
	libID := seedTypedLibrary(t, q, seedTestUser(t, q), "movie")
	token := "semceil" + randomSuffix(t)

	query := sparseVec768(map[int]float64{700: 1})
	allowed := seedSearchCeilingItem(t, q, libID, token+" allowed", ratingPtr("PG"),
		sparseVec768(map[int]float64{700: 0.8, 701: 0.6})) // cosine distance 0.2
	excluded := map[int64]string{}
	for i := 0; i < 5; i++ {
		excluded[seedSearchCeilingItem(t, q, libID, fmt.Sprintf("%s r%d", token, i), ratingPtr("TV-MA"), query)] = "TV-MA"
	}
	excluded[seedSearchCeilingItem(t, q, libID, token+" n", nil, query)] = "NULL"
	excluded[seedSearchCeilingItem(t, q, libID, token+" e", ratingPtr(""), query)] = "empty"

	restricted, err := q.SemanticSearch(ctx, query, SemanticFilter{AllowedRatings: AllowedRatingsForMax("PG")}, 3)
	if err != nil {
		t.Fatalf("SemanticSearch (restricted): %v", err)
	}
	sawAllowed := false
	for _, h := range restricted {
		if h.Item.ID == allowed {
			sawAllowed = true
		}
		if rating, bad := excluded[h.Item.ID]; bad {
			t.Errorf("PG ceiling returned item %d rated %s", h.Item.ID, rating)
		}
	}
	if !sawAllowed {
		t.Errorf("PG ceiling with limit 3 omitted the PG item %d behind nearer over-ceiling rows — "+
			"the ceiling must be applied before LIMIT, not after", allowed)
	}

	open, err := q.SemanticSearch(ctx, query, SemanticFilter{}, 3)
	if err != nil {
		t.Fatalf("SemanticSearch (unrestricted): %v", err)
	}
	if len(open) != 3 {
		t.Fatalf("unrestricted page has %d rows, want 3", len(open))
	}
	for _, h := range open {
		if h.Item.ID == allowed {
			t.Errorf("unrestricted three-row page held the farther row %d; the fixture no longer proves ordering", allowed)
		}
	}
}
