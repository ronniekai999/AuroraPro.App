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
	"sync/atomic"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ceilingFixture is a restricted ("PG") profile with three watched, embedded
// PG anchors (the taste-history threshold, so Discover reaches its LLM step),
// beside over-ceiling titles that every recommender surface would pick for it
// without a ceiling: newest and tmdb-less (they lead PopularUnwatched) and
// embedded next to the anchors (taste and anchor recall). Unwatched G titles
// sit beyond them, so the real lookup has something allowed to build every
// surface from.
//
// The engagement rails are the catch. Hidden Gems and Finish It Tonight rank
// the WHOLE catalog by rating with no tiebreaker, so rows that qualify there
// crowd other runs of this test and the db package's engagement tests, whose
// titles must land inside a catalog-wide LIMIT. So the R titles and anchors
// qualify for neither (rating 6.9 is under Hidden Gems' 7.0, 120 minutes is
// over Finish It Tonight's 110), and the G titles qualify at the bottom
// (7.1, 50 votes). The unrestricted engagement proof is Comfort Rewatch, which
// reads only this profile's own completions: a watched R title, unembedded so
// it moves neither the taste centroid nor the history count.
type ceilingFixture struct {
	q         *db.Queries
	profileID int64
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
	t.Cleanup(func() { cleanupExec(t, pool, `DELETE FROM users WHERE id = $1`, userID) })
	profileID := exec(`INSERT INTO user_profiles (user_id, name, is_default, max_age_rating, language, subtitle_mode)
		VALUES ($1, 'kid', FALSE, 'PG', 'en', 'off') RETURNING id`, userID)
	libID := exec(`INSERT INTO libraries (name, type, paths, owner_id) VALUES ($1, 'movie', $2, $3) RETURNING id`,
		token, []string{"/tmp/" + token}, userID)
	t.Cleanup(func() { cleanupExec(t, pool, `DELETE FROM libraries WHERE id = $1`, libID) })

	// Each run's direction is two dimensions picked independently (672..697
	// and 740..767, clear of the other tests' dimensions), about 700
	// combinations, with each title's offset on a shared third one. The rest
	// of the catalog sits at distance ~1, and a concurrent run sharing one of
	// the two dimensions at ~0.5, far beyond this fixture's titles (< 0.05);
	// a run would have to draw both to interfere. Titles still count by
	// rating, not by id, in case it ever does.
	d1, d2 := 672+int(b[0]%26), 740+int(b[1]%28)
	vec := func(lead float64) *string {
		parts := make([]string, 768)
		for i := range parts {
			parts[i] = "0"
		}
		parts[d1], parts[d2] = "1", "1"
		parts[699] = fmt.Sprintf("%g", lead)
		v := "[" + strings.Join(parts, ",") + "]"
		return &v
	}
	// item seeds a movie; a nil embedding leaves it unembedded.
	item := func(name, rating string, score float64, votes, runtime int, embedding *string) int64 {
		return exec(`INSERT INTO media_items
			   (library_id, type, title, sort_title, year, overview, rating, vote_count, runtime_minutes,
			    content_rating, poster_path, backdrop_path, embedding)
			 VALUES ($1, 'movie', $2, $2, 2000, 'An overview.', $3, $4, $5, $6, '/p.jpg', '/b.jpg', $7::vector)
			 RETURNING id`, libID, token+" "+name, score, votes, runtime, rating, embedding)
	}
	watch := func(itemID int64) {
		exec(`INSERT INTO watch_progress (user_id, media_item_id, position_ms, duration_ms, completed, completed_at, profile_id)
			VALUES ($1, $2, 5400000, 5400000, TRUE, NOW(), $3) RETURNING id`, userID, itemID, profileID)
	}
	for i := 0; i < db.PersonalizationThreshold(); i++ {
		watch(item(fmt.Sprintf("anchor %d", i), "PG", 6.9, 1000, 120, vec(-0.01*float64(i+1))))
	}
	for i := 0; i < 8; i++ {
		item(fmt.Sprintf("over %d", i), "R", 6.9, 1000, 120, vec(0.01*float64(i+1)))
	}
	watch(item("watched over", "R", 6.9, 1000, 120, nil))
	// Allowed titles, enough for an anchor rail (anchorRailMinItems), placed
	// beyond the R titles so an unrestricted build reaches the R ones first.
	// They are rated G, the all-ages tier allowedRatings returns on failure,
	// so a surface that ignored ok would build these and be caught.
	for i := 0; i < anchorRailMinItems+1; i++ {
		item(fmt.Sprintf("allowed %d", i), "G", 7.1, 50, 90, vec(0.3+0.01*float64(i)))
	}
	return &ceilingFixture{q: db.NewQueries(pool), profileID: profileID}
}

// cleanupExec runs a fixture cleanup statement and reports a failure instead
// of leaking the rows. A concurrent run's cleanup can deadlock with this one
// over rows that link the two runs' fixtures, so a deadlock is retried.
func cleanupExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if _, err = pool.Exec(context.Background(), sql, args...); err == nil {
			return
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "40P01" {
			break
		}
		time.Sleep(time.Duration(attempt+1) * 50 * time.Millisecond)
	}
	t.Errorf("cleanup %q: %v", sql, err)
}

// newTestHero is a Hero with anti-repetition off. Recording surfaced picks
// would link this run's profile to other runs' titles, and the two runs'
// cleanups then lock those rows in opposite orders and deadlock.
func newTestHero(q *db.Queries, chat *llm.Client) *Hero {
	h := New(q, chat)
	h.SetRepeatWindow(0)
	return h
}

// countingLLM is a chat endpoint that records whether it was called and
// fails every call, so Discover builds nothing past its LLM step either way.
func countingLLM(t *testing.T) (*llm.Client, *atomic.Bool) {
	t.Helper()
	called := &atomic.Bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
		http.Error(w, "no chat in this test", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	return llm.NewClient(llm.Config{BaseURL: srv.URL}), called
}

// overPG reports whether a title is over the fixture profile's PG ceiling,
// judged by its rating, so concurrent runs' titles count too.
func overPG(it *models.MediaItem) bool { return it != nil && !db.RatingAllowed("PG", it.ContentRating) }

// TestRecommenderCeilingLookupFailureBuildsNothing: when the ceiling cannot
// be read, every surface builds nothing, and nothing is cached. Two controls
// prove the fixture reaches each surface: with the real lookup every surface
// builds something and nothing over the ceiling, and unrestricted every
// surface builds the R titles. The first also catches a lookup that always
// fails, which would blank every profile's Home page.
func TestRecommenderCeilingLookupFailureBuildsNothing(t *testing.T) {
	f := newCeilingFixture(t)
	ctx := context.Background()

	// Control 1: the real lookup applies the PG ceiling and still builds.
	withCeiling := newTestHero(f.q, nil)
	picks, err := withCeiling.PoolFor(ctx, f.profileID)
	if err != nil {
		t.Fatalf("PoolFor (real lookup): %v", err)
	}
	if len(picks) == 0 || anyPickOver(picks, overPG) {
		t.Errorf("real lookup: hero built %d picks, over-ceiling %v; want some, none over", len(picks), anyPickOver(picks, overPG))
	}
	if rail, _ := withCeiling.RailFor(ctx, f.profileID, 24); len(rail) == 0 || anyItemOver(rail, overPG) {
		t.Errorf("real lookup: rail built %d items, over-ceiling %v; want some, none over", len(rail), anyItemOver(rail, overPG))
	}
	if rails, _ := withCeiling.EngagementRailsFor(ctx, f.profileID); len(rails) == 0 || anyEngagementOver(rails, overPG) {
		t.Errorf("real lookup: %d engagement rails, over-ceiling %v; want some, none over", len(rails), anyEngagementOver(rails, overPG))
	}
	if rails, _ := withCeiling.AnchorRailsFor(ctx, f.profileID); len(rails) == 0 || anyAnchorOver(rails, overPG) {
		t.Errorf("real lookup: %d anchor rails, over-ceiling %v; want some, none over", len(rails), anyAnchorOver(rails, overPG))
	}
	// Discover reaches its LLM step under the real lookup, so a Discover that
	// returned early for every restricted profile would be caught here.
	chat, llmCalled := countingLLM(t)
	withCeilingLLM := newTestHero(f.q, chat)
	_, _ = withCeilingLLM.DiscoverFor(ctx, f.profileID)
	if !llmCalled.Load() {
		t.Error("real lookup: Discover never reached its LLM step for a restricted profile")
	}

	// Control 2: without a ceiling the same fixture yields over-ceiling titles
	// on every surface; this is what a failed lookup used to build, and cache.
	unrestricted := newTestHero(f.q, nil)
	unrestricted.profileCeiling = func(context.Context, int64) (string, error) { return "", nil }
	if picks, _ := unrestricted.PoolFor(ctx, f.profileID); !anyPickOver(picks, overPG) {
		t.Error("precondition: an unrestricted hero build picks no R title")
	}
	if rail, _ := unrestricted.RailFor(ctx, f.profileID, 24); !anyItemOver(rail, overPG) {
		t.Error("precondition: an unrestricted rail picks no R title")
	}
	if rails, _ := unrestricted.EngagementRailsFor(ctx, f.profileID); !anyEngagementOver(rails, overPG) {
		t.Error("precondition: unrestricted engagement rails pick no R title")
	}
	if rails, _ := unrestricted.AnchorRailsFor(ctx, f.profileID); !anyAnchorOver(rails, overPG) {
		t.Error("precondition: unrestricted anchor rails pick no R title")
	}

	failing := newTestHero(f.q, nil)
	failing.profileCeiling = func(context.Context, int64) (string, error) {
		return "", errors.New("transient ceiling lookup failure")
	}

	picks, err = failing.PoolFor(ctx, f.profileID)
	if err != nil {
		t.Fatalf("PoolFor (failing lookup): %v", err)
	}
	if len(picks) != 0 {
		t.Errorf("a failed ceiling lookup still built %d hero picks (over-ceiling: %v)", len(picks), anyPickOver(picks, overPG))
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
	// records the call (and fails it, so Discover itself builds nothing either
	// way); the unrestricted run proves the fixture reaches that step.
	llmCalled.Store(false)
	failingWithLLM := newTestHero(f.q, chat)
	failingWithLLM.profileCeiling = failing.profileCeiling
	if _, err := failingWithLLM.DiscoverFor(ctx, f.profileID); err != nil {
		t.Errorf("DiscoverFor (failing lookup): %v", err)
	}
	if llmCalled.Load() {
		t.Error("a failed ceiling lookup still sent the Discover candidates to the LLM")
	}
	if _, cached := failingWithLLM.discoverCache.Load(f.profileID); cached {
		t.Error("a failed ceiling lookup cached Discover rails")
	}
	unrestrictedWithLLM := newTestHero(f.q, chat)
	unrestrictedWithLLM.profileCeiling = unrestricted.profileCeiling
	_, _ = unrestrictedWithLLM.DiscoverFor(ctx, f.profileID)
	if !llmCalled.Load() {
		t.Error("precondition: an unrestricted Discover build never reaches its LLM step")
	}
}

// TestAllowedRatingsFailsClosed pins the values allowedRatings hands its
// callers. On a failed lookup it must be a non-empty restriction, never nil
// or an empty slice: gates that test len(allowed) > 0 read an empty slice as
// unrestricted, so a caller that ignored ok would fail open on one.
func TestAllowedRatingsFailsClosed(t *testing.T) {
	ctx := context.Background()
	h := New(nil, nil)

	h.profileCeiling = func(context.Context, int64) (string, error) { return "", errors.New("lookup failed") }
	allowed, ok := h.allowedRatings(ctx, 1)
	if ok {
		t.Error("a failed lookup reported ok")
	}
	if len(allowed) == 0 {
		t.Fatalf("a failed lookup returned %v; want a non-empty restriction", allowed)
	}
	for _, r := range allowed {
		if !db.RatingAllowed("G", r) {
			t.Errorf("a failed lookup allowed %q, above the all-ages tier", r)
		}
	}

	h.profileCeiling = func(context.Context, int64) (string, error) { return "", nil }
	if allowed, ok := h.allowedRatings(ctx, 1); !ok || allowed != nil {
		t.Errorf("an unrestricted profile got (%v, %v); want (nil, true)", allowed, ok)
	}

	h.profileCeiling = func(context.Context, int64) (string, error) { return "PG", nil }
	if allowed, ok := h.allowedRatings(ctx, 1); !ok || len(allowed) == 0 || !db.RatingAllowed("PG", allowed[0]) {
		t.Errorf("a PG profile got (%v, %v); want the PG ladder and ok", allowed, ok)
	}
}

func anyPickOver(picks []HeroPick, over func(*models.MediaItem) bool) bool {
	for _, p := range picks {
		if over(p.Item) {
			return true
		}
	}
	return false
}

func anyItemOver(items []*models.MediaItem, over func(*models.MediaItem) bool) bool {
	for _, it := range items {
		if over(it) {
			return true
		}
	}
	return false
}

func anyEngagementOver(rails []EngagementRail, over func(*models.MediaItem) bool) bool {
	for _, r := range rails {
		if anyItemOver(r.Items, over) {
			return true
		}
	}
	return false
}

func anyAnchorOver(rails []AnchorRail, over func(*models.MediaItem) bool) bool {
	for _, r := range rails {
		if anyItemOver(r.Items, over) {
			return true
		}
	}
	return false
}
