package recommender

// Integration test for the recommender's rating-ceiling lookup failing. It
// used to fall back to "unrestricted", and the hero, discover and engagement
// builds cached that result (the hero for up to a day), so one database error
// served a restricted profile unfiltered picks long after it. Opt-in via
// TEST_DATABASE_URL.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
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

// ceilingFixture is a restricted ("PG") profile with three watched, embedded
// PG anchors (the taste-history threshold, so Discover reaches its LLM step),
// beside over-ceiling titles that every recommender surface would pick for it
// without a ceiling: newest and tmdb-less (they lead PopularUnwatched), rated
// 10 with 1000 votes (hidden gems), 90 minutes (finish tonight), and embedded
// next to the anchors (taste and anchor recall).
type ceilingFixture struct {
	q         *db.Queries
	profileID int64
	over      map[int64]bool
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
	pool, err := pgxpool.New(connectCtx, dbURL)
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
	token := "recceil" + hex.EncodeToString(b)
	exec := func(sql string, args ...any) int64 {
		t.Helper()
		var id int64
		if err := pool.QueryRow(ctx, sql, args...).Scan(&id); err != nil {
			t.Fatalf("seed: %v\n%s", err, sql)
		}
		return id
	}

	userID := exec(`INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`, token, token+"@example.com")
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID) })
	profileID := exec(`INSERT INTO user_profiles (user_id, name, is_default, max_age_rating, language, subtitle_mode)
		VALUES ($1, 'kid', FALSE, 'PG', 'en', 'off') RETURNING id`, userID)
	libID := exec(`INSERT INTO libraries (name, type, paths, owner_id) VALUES ($1, 'movie', $2, $3) RETURNING id`,
		token, []string{"/tmp/" + token}, userID)
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM libraries WHERE id = $1`, libID) })

	// A dimension of its own, so the shared catalog sits at distance ~1.
	vec := func(lead float64) string {
		parts := make([]string, 768)
		for i := range parts {
			parts[i] = "0"
		}
		parts[730] = "1"
		parts[731] = fmt.Sprintf("%g", lead)
		return "[" + strings.Join(parts, ",") + "]"
	}
	item := func(name, rating string, lead float64) int64 {
		return exec(`INSERT INTO media_items
			   (library_id, type, title, sort_title, year, overview, rating, vote_count, runtime_minutes,
			    content_rating, poster_path, backdrop_path, embedding)
			 VALUES ($1, 'movie', $2, $2, 2000, 'An overview.', 10, 1000, 90, $3, '/p.jpg', '/b.jpg', $4::vector)
			 RETURNING id`, libID, token+" "+name, rating, vec(lead))
	}
	for i := 0; i < db.PersonalizationThreshold(); i++ {
		anchor := item(fmt.Sprintf("anchor %d", i), "PG", -0.01*float64(i+1))
		exec(`INSERT INTO watch_progress (user_id, media_item_id, position_ms, duration_ms, completed, completed_at, profile_id)
			VALUES ($1, $2, 5400000, 5400000, TRUE, NOW(), $3) RETURNING id`, userID, anchor, profileID)
	}
	over := map[int64]bool{}
	for i := 0; i < 8; i++ {
		over[item(fmt.Sprintf("over %d", i), "R", 0.01*float64(i+1))] = true
	}
	return &ceilingFixture{q: db.NewQueries(pool), profileID: profileID, over: over}
}

// TestRecommenderCeilingLookupFailureBuildsNothing: when the ceiling cannot
// be read, every surface builds nothing, and nothing is cached. The control
// run with a working lookup proves the fixture reaches each surface and that
// the ceiling, not an empty catalog, is what keeps the R titles out.
func TestRecommenderCeilingLookupFailureBuildsNothing(t *testing.T) {
	f := newCeilingFixture(t)
	ctx := context.Background()
	overCeiling := func(id int64) bool { return f.over[id] }

	// Control: the real lookup applies the PG ceiling on every surface.
	h := New(f.q, nil)
	picks, err := h.PoolFor(ctx, f.profileID)
	if err != nil {
		t.Fatalf("PoolFor (control): %v", err)
	}
	for _, p := range picks {
		if overCeiling(p.Item.ID) {
			t.Errorf("control: hero pick %d is over the PG ceiling", p.Item.ID)
		}
	}

	// Without a ceiling the same fixture yields over-ceiling titles on every
	// surface; this is what a failed lookup used to build, and cache.
	unrestricted := New(f.q, nil)
	unrestricted.profileCeiling = func(context.Context, int64) (string, error) { return "", nil }
	if picks, _ := unrestricted.PoolFor(ctx, f.profileID); !anyPickOver(picks, overCeiling) {
		t.Fatal("precondition: an unrestricted hero build picks none of the R titles; the fixture no longer reaches it")
	}

	failing := New(f.q, nil)
	failing.profileCeiling = func(context.Context, int64) (string, error) {
		return "", errors.New("transient ceiling lookup failure")
	}

	picks, err = failing.PoolFor(ctx, f.profileID)
	if err != nil {
		t.Fatalf("PoolFor (failing lookup): %v", err)
	}
	if len(picks) != 0 {
		t.Errorf("a failed ceiling lookup still built %d hero picks (over-ceiling: %v)", len(picks), anyPickOver(picks, overCeiling))
	}
	if _, cached := failing.cache.Load(f.profileID); cached {
		t.Error("a failed ceiling lookup cached a hero pool")
	}

	rail, err := failing.RailFor(ctx, f.profileID, 24)
	if err != nil {
		t.Fatalf("RailFor (failing lookup): %v", err)
	}
	if len(rail) != 0 {
		t.Errorf("a failed ceiling lookup still built a %d-item rail", len(rail))
	}

	engagement, err := failing.EngagementRailsFor(ctx, f.profileID)
	if err != nil {
		t.Fatalf("EngagementRailsFor (failing lookup): %v", err)
	}
	if len(engagement) != 0 {
		t.Errorf("a failed ceiling lookup still built %d engagement rails", len(engagement))
	}
	if _, cached := failing.engagementCache.Load(f.profileID); cached {
		t.Error("a failed ceiling lookup cached engagement rails")
	}

	anchors, err := failing.AnchorRailsFor(ctx, f.profileID)
	if err != nil {
		t.Fatalf("AnchorRailsFor (failing lookup): %v", err)
	}
	if len(anchors) != 0 {
		t.Errorf("a failed ceiling lookup still built %d anchor rails", len(anchors))
	}

	// Discover returns before its LLM step when the lookup fails. The fake LLM
	// records the call; the unrestricted run proves the fixture reaches it.
	llmCalled := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		llmCalled = true
		http.Error(w, "no chat in this test", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	failingWithLLM := New(f.q, llm.NewClient(llm.Config{BaseURL: srv.URL}))
	failingWithLLM.profileCeiling = failing.profileCeiling
	if rails, err := failingWithLLM.DiscoverFor(ctx, f.profileID); err != nil || len(rails) != 0 {
		t.Errorf("a failed ceiling lookup still built Discover: %d rails, err %v", len(rails), err)
	}
	if llmCalled {
		t.Error("a failed ceiling lookup still sent the Discover candidates to the LLM")
	}
	if _, cached := failingWithLLM.discoverCache.Load(f.profileID); cached {
		t.Error("a failed ceiling lookup cached Discover rails")
	}
	unrestrictedWithLLM := New(f.q, llm.NewClient(llm.Config{BaseURL: srv.URL}))
	unrestrictedWithLLM.profileCeiling = unrestricted.profileCeiling
	_, _ = unrestrictedWithLLM.DiscoverFor(ctx, f.profileID)
	if !llmCalled {
		t.Error("precondition: an unrestricted Discover build never reaches its LLM step")
	}

	// The same surfaces unrestricted, so each empty result above came from
	// the failed lookup rather than from a fixture that reaches nothing.
	if rail, _ := unrestricted.RailFor(ctx, f.profileID, 24); !anyItemOver(rail, overCeiling) {
		t.Error("precondition: an unrestricted rail picks none of the R titles")
	}
	if rails, _ := unrestricted.EngagementRailsFor(ctx, f.profileID); len(rails) == 0 {
		t.Error("precondition: an unrestricted build produces no engagement rails")
	}
	if rails, _ := unrestricted.AnchorRailsFor(ctx, f.profileID); len(rails) == 0 {
		t.Error("precondition: an unrestricted build produces no anchor rails")
	}
}

func anyPickOver(picks []HeroPick, over func(int64) bool) bool {
	for _, p := range picks {
		if p.Item != nil && over(p.Item.ID) {
			return true
		}
	}
	return false
}

func anyItemOver(items []*models.MediaItem, over func(int64) bool) bool {
	for _, it := range items {
		if it != nil && over(it.ID) {
			return true
		}
	}
	return false
}
