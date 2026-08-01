package api

// Handler-level tests for the star-rating endpoints (POST/GET /api/me/rating).
// Opt-in: set TEST_DATABASE_URL=postgres://... to run (skipped otherwise),
// same contract as the other API integration tests. Covers the request
// validation, the FK→404 mapping, the clear path, profile resolution to the
// default profile, and the invalidate-only-when-attached recommender contract.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5/pgxpool"
)

func requireRatingTestDB(t *testing.T) *db.Queries {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping rating-handler integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect to test db: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping test db: %v", err)
	}
	t.Cleanup(pool.Close)
	return db.NewQueries(pool)
}

func ratingTestSuffix(t *testing.T) string {
	t.Helper()
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

// seedRatingFixtures creates a user (with default profile), a library, and a
// media item via the exported query methods; cleanup cascades from the
// user/library deletes.
func seedRatingFixtures(t *testing.T, q *db.Queries) (userID, itemID int64) {
	t.Helper()
	ctx := context.Background()
	suffix := ratingTestSuffix(t)
	user, err := q.CreateUser(ctx,
		"rating_test_"+suffix, "rating_test_"+suffix+"@example.com", "$2a$10$placeholder", models.RoleUser)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() { _, _ = q.DeleteUser(ctx, user.ID) })
	if _, err := q.CreateDefaultProfileForUser(ctx, user.ID, "rating_test"); err != nil {
		t.Fatalf("seed profile: %v", err)
	}
	lib := &models.Library{
		Name:    "rating_test_lib_" + suffix,
		Type:    models.LibraryMovies,
		Paths:   []string{"/tmp/rating_test"},
		OwnerID: user.ID,
	}
	if err := q.CreateLibrary(ctx, lib); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() { _, _ = q.DeleteLibrary(ctx, lib.ID) })
	item := &models.MediaItem{
		LibraryID: lib.ID,
		Type:      models.MediaMovie,
		Title:     "Rating Test Movie " + suffix,
		SortTitle: "rating test movie " + suffix,
	}
	if err := q.UpsertMediaItem(ctx, item); err != nil {
		t.Fatalf("seed media item: %v", err)
	}
	return user.ID, item.ID
}

func int64Str(v int64) string { return strconv.FormatInt(v, 10) }

// ratingFakeHero satisfies HeroProvider with no-ops; it only records
// Invalidate calls so tests can assert the re-curate contract.
type ratingFakeHero struct{ invalidated []int64 }

func (f *ratingFakeHero) PoolFor(context.Context, int64) ([]HeroPick, error) { return nil, nil }
func (f *ratingFakeHero) RailFor(context.Context, int64, int) ([]*models.MediaItem, error) {
	return nil, nil
}
func (f *ratingFakeHero) DiscoverFor(context.Context, int64) ([]DiscoverRail, error) { return nil, nil }
func (f *ratingFakeHero) DiscoverCached(int64) ([]DiscoverRail, bool)                { return nil, false }
func (f *ratingFakeHero) AnchorRailsFor(context.Context, int64) ([]AnchorRail, error) {
	return nil, nil
}
func (f *ratingFakeHero) EngagementRailsFor(context.Context, int64) ([]EngagementRail, error) {
	return nil, nil
}
func (f *ratingFakeHero) Invalidate(profileID int64) {
	f.invalidated = append(f.invalidated, profileID)
}

func ratingPostReq(body string, userID int64) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/me/rating", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	claims := &auth.JWTClaims{UserID: userID, Username: "u", Role: "user"}
	return r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, claims))
}

func ratingGetReq(query string, userID int64) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/me/rating"+query, nil)
	claims := &auth.JWTClaims{UserID: userID, Username: "u", Role: "user"}
	return r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, claims))
}

func TestRatingHandlers_SetGetClear(t *testing.T) {
	q := requireRatingTestDB(t)
	userID, itemID := seedRatingFixtures(t, q)
	h := NewHeroHandler(q)
	fake := &ratingFakeHero{}
	h.SetHeroProvider(fake)

	do := func(r *http.Request, handler http.HandlerFunc) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		handler(w, r)
		return w
	}
	getStars := func() string {
		w := do(ratingGetReq("?media_item_id="+int64Str(itemID), userID), h.GetRating)
		if w.Code != http.StatusOK {
			t.Fatalf("get rating: status %d: %s", w.Code, w.Body.String())
		}
		return w.Body.String()
	}

	// Unrated → stars 0.
	if body := getStars(); !strings.Contains(body, `"stars":0`) {
		t.Errorf("unrated item should read stars 0, got %s", body)
	}
	// Set 1★ → 204, invalidated, readable.
	w := do(ratingPostReq(`{"media_item_id":`+int64Str(itemID)+`,"stars":1}`, userID), h.SetRating)
	if w.Code != http.StatusNoContent {
		t.Fatalf("set rating: status %d: %s", w.Code, w.Body.String())
	}
	if len(fake.invalidated) != 1 {
		t.Errorf("set should invalidate the rec caches once, got %d", len(fake.invalidated))
	}
	if body := getStars(); !strings.Contains(body, `"stars":1`) {
		t.Errorf("want stars 1, got %s", body)
	}
	// Clear (stars=0) → 204, gone.
	w = do(ratingPostReq(`{"media_item_id":`+int64Str(itemID)+`,"stars":0}`, userID), h.SetRating)
	if w.Code != http.StatusNoContent {
		t.Fatalf("clear rating: status %d: %s", w.Code, w.Body.String())
	}
	if body := getStars(); !strings.Contains(body, `"stars":0`) {
		t.Errorf("cleared item should read stars 0, got %s", body)
	}

	// Validation: out-of-range stars, missing item, bad body.
	for _, tc := range []struct {
		name, body string
		want       int
	}{
		{"stars too high", `{"media_item_id":` + int64Str(itemID) + `,"stars":6}`, http.StatusBadRequest},
		{"stars negative", `{"media_item_id":` + int64Str(itemID) + `,"stars":-1}`, http.StatusBadRequest},
		{"missing item", `{"stars":3}`, http.StatusBadRequest},
		{"nonexistent item", `{"media_item_id":999999999,"stars":3}`, http.StatusNotFound},
		{"garbage body", `{`, http.StatusBadRequest},
	} {
		if w := do(ratingPostReq(tc.body, userID), h.SetRating); w.Code != tc.want {
			t.Errorf("%s: want %d, got %d (%s)", tc.name, tc.want, w.Code, w.Body.String())
		}
	}
	// GET validation.
	if w := do(ratingGetReq("?media_item_id=abc", userID), h.GetRating); w.Code != http.StatusBadRequest {
		t.Errorf("non-numeric media_item_id: want 400, got %d", w.Code)
	}
	if w := do(ratingGetReq("", userID), h.GetRating); w.Code != http.StatusBadRequest {
		t.Errorf("missing media_item_id: want 400, got %d", w.Code)
	}
}

// TestRatingHandlers_NilHero pins the deliberate divergence from Feedback:
// rating storage must work on an install with no recommender attached
// (LLM-less box) — no 503, no nil-pointer panic on the skipped Invalidate.
func TestRatingHandlers_NilHero(t *testing.T) {
	q := requireRatingTestDB(t)
	userID, itemID := seedRatingFixtures(t, q)
	h := NewHeroHandler(q) // no SetHeroProvider

	w := httptest.NewRecorder()
	h.SetRating(w, ratingPostReq(`{"media_item_id":`+int64Str(itemID)+`,"stars":5}`, userID))
	if w.Code != http.StatusNoContent {
		t.Fatalf("set rating without recommender: want 204, got %d: %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	h.GetRating(w, ratingGetReq("?media_item_id="+int64Str(itemID), userID))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"stars":5`) {
		t.Errorf("get rating without recommender: got %d %s", w.Code, w.Body.String())
	}
}
