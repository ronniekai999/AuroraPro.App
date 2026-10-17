package search

// Integration tests for the rating ceiling in the semantic search pipeline:
// both recall legs must apply it, because everything after recall (fusion,
// dedup, rerank, the title fallback) picks only among candidates. Opt-in via
// TEST_DATABASE_URL; the LLM is a local fake that embeds every query to one
// fixed vector and fails every chat call, so the parse falls back to the raw
// query and the rerank falls back to vector order.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ceilingQueryDim is the one non-zero dimension of the fake query embedding.
// It is a high index no other test points at, so the shared catalog's
// embeddings are nearly orthogonal to the query (cosine distance about 1) and
// cannot outrank the fixture's rows at 0 and 0.2. Only a concurrent run of
// these tests seeds rows at the same distances, and the assertions allow it.
const ceilingQueryDim = 710

func ceilingVec(at map[int]float64) string {
	parts := make([]string, 768)
	for i := range parts {
		parts[i] = "0"
	}
	for i, v := range at {
		parts[i] = fmt.Sprintf("%g", v)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// ceilingFixture is a library to seed into and a Searcher over the shared
// test database whose fake LLM embeds every query at ceilingQueryDim.
type ceilingFixture struct {
	t     *testing.T
	pool  *pgxpool.Pool
	libID int64
	token string // random; no other row can contain it
	s     *Searcher
}

func newCeilingFixture(t *testing.T) *ceilingFixture {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	connectCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		t.Fatalf("parse test db url: %v", err)
	}
	// Exact kNN scans, so the fixture's rows lead the vector leg whatever the
	// shared catalog holds. With enough embedded rows the planner picks the
	// HNSW index, whose candidate window (see db.SemanticSearch) would make
	// these results depend on unrelated rows. That window is a documented gap,
	// not what these tests pin.
	cfg.ConnConfig.RuntimeParams["enable_indexscan"] = "off"
	pool, err := pgxpool.NewWithConfig(connectCtx, cfg)
	if err != nil {
		t.Fatalf("connect to test db: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(connectCtx); err != nil {
		t.Fatalf("ping test db: %v", err)
	}

	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	f := &ceilingFixture{t: t, pool: pool, token: "pipeceil" + hex.EncodeToString(b)}

	var userID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
		f.token, f.token+"@example.com").Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID) })
	if err := pool.QueryRow(ctx,
		`INSERT INTO libraries (name, type, paths, owner_id) VALUES ($1, 'movie', $2, $3) RETURNING id`,
		f.token, []string{"/tmp/" + f.token}, userID).Scan(&f.libID); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM libraries WHERE id = $1`, f.libID) })

	embedding := make([]string, 768)
	for i := range embedding {
		embedding[i] = "0"
	}
	embedding[ceilingQueryDim] = "1"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/embed" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"embeddings":[[%s]]}`, strings.Join(embedding, ","))
			return
		}
		http.Error(w, "chat disabled in this test", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	f.s = New(llm.NewClient(llm.Config{BaseURL: srv.URL}), db.NewQueries(pool))
	return f
}

// seed stores a movie; an empty vecLit leaves the embedding NULL. tmdb_id
// stays NULL so cross-library dedup leaves every fixture row alone. Rows are
// dated a month back so these crowds never fill the "Recently added" windows
// other packages' tests read from the shared catalog.
func (f *ceilingFixture) seed(title, rating, vecLit string) int64 {
	f.t.Helper()
	var vec *string
	if vecLit != "" {
		vec = &vecLit
	}
	var id int64
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO media_items
		   (library_id, type, title, sort_title, year, overview, rating, runtime_minutes,
		    content_rating, poster_path, backdrop_path, embedding, added_at)
		 VALUES ($1, 'movie', $2, $2, 0, '', 0, 0, $3, '', '', $4::vector, NOW() - interval '30 days')
		 RETURNING id`,
		f.libID, title, rating, vec).Scan(&id); err != nil {
		f.t.Fatalf("seed %q: %v", title, err)
	}
	return id
}

// TestSearchAppliesRatingCeilingToVectorRecall runs the whole pipeline. The
// rows carry no query token, so only the vector leg can recall them, and they
// sit nearest the query on a dimension no other test uses, so under the
// fixture's exact scans only rows from a concurrent run of this test can tie
// them, and those are over-ceiling too. There are
// more over-ceiling rows nearer the query than the vector leg recalls
// (vectorRecallSize), so a ceiling applied after that LIMIT, in Go, would
// leave nothing allowed. The lexical leg's output cannot be seen here, so the
// hook pins that Search hands that leg the same ceiling, and
// TestLexicalRecallAppliesRatingCeiling pins that the leg applies it.
func TestSearchAppliesRatingCeilingToVectorRecall(t *testing.T) {
	f := newCeilingFixture(t)
	ctx := context.Background()
	var lexicalFilters []db.SemanticFilter
	f.s.testHookLexicalFilter = func(filter db.SemanticFilter) { lexicalFilters = append(lexicalFilters, filter) }
	lexicalRatings := func() []string {
		t.Helper()
		if len(lexicalFilters) != 1 {
			t.Fatalf("lexical leg ran %d times, want once", len(lexicalFilters))
		}
		got := lexicalFilters[0].AllowedRatings
		lexicalFilters = nil
		return got
	}
	sameSet := func(a, b []string) bool {
		if (a == nil) != (b == nil) || len(a) != len(b) {
			return false
		}
		seen := map[string]bool{}
		for _, r := range a {
			seen[r] = true
		}
		for _, r := range b {
			if !seen[r] {
				return false
			}
		}
		return true
	}
	overs := map[int64]bool{}
	near := ceilingVec(map[int]float64{ceilingQueryDim: 1})
	for i := 0; i <= vectorRecallSize; i++ {
		overs[f.seed(fmt.Sprintf("Vector over %s %d", f.token[8:16], i), "R", near)] = true
	}
	allowed := f.seed("Vector allowed "+f.token[8:16], "PG",
		ceilingVec(map[int]float64{ceilingQueryDim: 0.8, ceilingQueryDim + 1: 0.6})) // cosine distance 0.2

	ids := func(hits []Hit) map[int64]bool {
		out := map[int64]bool{}
		for _, h := range hits {
			out[h.Item.ID] = true
		}
		return out
	}

	hits, _, err := f.s.Search(ctx, f.token, 50, db.AllowedRatingsForMax("PG"))
	if err != nil {
		t.Fatalf("Search (restricted): %v", err)
	}
	got := ids(hits)
	for id := range overs {
		if got[id] {
			t.Errorf("PG ceiling returned the R row %d through the vector leg", id)
		}
	}
	if !got[allowed] {
		t.Errorf("PG ceiling lost the PG row %d behind %d nearer R rows; the vector leg must filter before its LIMIT",
			allowed, len(overs))
	}
	for _, h := range hits {
		if !db.RatingAllowed("PG", h.Item.ContentRating) {
			t.Errorf("PG ceiling returned item %d rated %q", h.Item.ID, h.Item.ContentRating)
		}
	}
	if got, want := lexicalRatings(), db.AllowedRatingsForMax("PG"); !sameSet(got, want) {
		t.Errorf("Search handed the lexical leg ceiling %v, want %v", got, want)
	}

	// Control: unfiltered, the vector leg's recall is full without the PG
	// row, so its presence above came from the ceiling being applied before
	// that LIMIT. Checked on the recall itself rather than on Search's
	// rerank-capped output; R rows other runs seed at the same distance only
	// add to the crowd.
	recall, err := f.s.q.SemanticSearch(ctx, near, db.SemanticFilter{}, vectorRecallSize)
	if err != nil {
		t.Fatalf("SemanticSearch (unfiltered): %v", err)
	}
	if len(recall) != vectorRecallSize {
		t.Fatalf("unfiltered recall has %d rows, want %d", len(recall), vectorRecallSize)
	}
	for _, h := range recall {
		if h.Item.ID == allowed {
			t.Fatalf("the PG row %d is inside the unfiltered %d-row recall; the crowd no longer proves the ordering", allowed, vectorRecallSize)
		}
	}

	// Unrestricted, Search hands the lexical leg no ceiling.
	if _, _, err = f.s.Search(ctx, f.token, 50, nil); err != nil {
		t.Fatalf("Search (unrestricted): %v", err)
	}
	if got := lexicalRatings(); got != nil {
		t.Errorf("unrestricted Search handed the lexical leg ceiling %v, want nil", got)
	}
}

// TestLexicalRecallAppliesRatingCeiling checks the trigram leg directly,
// because Search's output cannot show it on a shared database (see
// lexicalRecall). The rows have no embedding, so in Search they are reachable
// through this leg alone. More over-ceiling titles match the query better
// than the allowed one than the leg recalls (lexicalRecallSize), so a ceiling
// applied after that LIMIT would leave nothing allowed.
func TestLexicalRecallAppliesRatingCeiling(t *testing.T) {
	f := newCeilingFixture(t)
	ctx := context.Background()
	// Short titles are the closest trigram matches; the allowed title's long
	// tail makes it the weakest match of the set.
	allowed := f.seed(f.token+" with a much longer tail that dilutes the trigram similarity", "G", "")
	overs := map[int64]bool{}
	for i := 0; i <= lexicalRecallSize; i++ {
		rating := "TV-MA"
		if i%2 == 0 {
			rating = "R"
		}
		overs[f.seed(fmt.Sprintf("%s o%d", f.token, i), rating, "")] = true
	}

	recall := func(allowedRatings []string) (map[int64]bool, map[int64]*models.MediaItem) {
		t.Helper()
		items := map[int64]*models.MediaItem{}
		lists := f.s.lexicalRecall(ctx, []string{f.token}, db.SemanticFilter{AllowedRatings: allowedRatings}, items)
		ids := map[int64]bool{}
		for _, list := range lists {
			for _, id := range list {
				ids[id] = true
			}
		}
		return ids, items
	}

	got, items := recall(db.AllowedRatingsForMax("PG"))
	for id := range overs {
		if got[id] || items[id] != nil {
			t.Errorf("PG ceiling recalled the over-ceiling row %d lexically", id)
		}
	}
	if !got[allowed] || items[allowed] == nil {
		t.Errorf("PG ceiling lost the G row %d behind %d closer over-ceiling matches; the lexical leg must filter before its LIMIT",
			allowed, len(overs))
	}

	// Control: unrestricted, the closer matches fill the recall.
	got, _ = recall(nil)
	sawOver := false
	for id := range overs {
		sawOver = sawOver || got[id]
	}
	if !sawOver || got[allowed] {
		t.Errorf("unrestricted: want the closer over-ceiling matches to crowd out the G row; got some over=%v G=%v", sawOver, got[allowed])
	}
}
