package api

// Handler tests for profile max_age_rating validation. Both handlers used to
// store whatever string arrived, and the ladder only knew exact uppercase
// keys, so "pg" or a typo saved as a ceiling that restricted nothing. Opt-in
// via TEST_DATABASE_URL, same harness as rating_ceiling_test.go.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
)

func profileReq(t *testing.T, method, body string, userID, profileID int64) *http.Request {
	t.Helper()
	r := httptest.NewRequest(method, "/api/profiles", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	if profileID != 0 {
		rctx.URLParams.Add("id", i64(profileID))
	}
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	return rcClaimsCtx(r, userID, 0)
}

func TestCreateProfile_MaxAgeRatingValidated(t *testing.T) {
	q := requireRequestTestDB(t)
	userID := seedReqUser(t, q)
	ctx := context.Background()
	h := NewProfileHandler(q)

	create := func(t *testing.T, rating string) (*httptest.ResponseRecorder, *models.UserProfile) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"name": "p " + reqTestSuffix(t)[:8], "max_age_rating": rating})
		rr := httptest.NewRecorder()
		h.CreateProfile(rr, profileReq(t, http.MethodPost, string(body), userID, 0))
		if rr.Code != http.StatusCreated {
			return rr, nil
		}
		var p models.UserProfile
		if err := json.Unmarshal(rr.Body.Bytes(), &p); err != nil {
			t.Fatalf("decode: %v", err)
		}
		stored, err := q.GetProfile(ctx, p.ID)
		if err != nil || stored == nil {
			t.Fatalf("reload profile %d: %v", p.ID, err)
		}
		return rr, stored
	}

	for in, want := range map[string]string{" pg ": "PG", "tv-14": "TV-14", "NC-17": "NC-17", "": ""} {
		rr, stored := create(t, in)
		if stored == nil {
			t.Errorf("max_age_rating %q: status %d, want 201 (body %q)", in, rr.Code, rr.Body.String())
			continue
		}
		if stored.MaxAgeRating != want {
			t.Errorf("max_age_rating %q stored as %q, want the canonical %q", in, stored.MaxAgeRating, want)
		}
	}

	before, err := q.CountProfilesByUser(ctx, userID)
	if err != nil {
		t.Fatalf("count profiles: %v", err)
	}
	for _, bad := range []string{"BOGUS", "PG13", "12A", "TV 14"} {
		rr, _ := create(t, bad)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("max_age_rating %q: status %d, want 400", bad, rr.Code)
		}
		if !strings.Contains(rr.Body.String(), "TV-14") {
			t.Errorf("max_age_rating %q: error %q does not list the accepted ratings", bad, rr.Body.String())
		}
	}
	if after, _ := q.CountProfilesByUser(ctx, userID); after != before {
		t.Errorf("rejected creates still stored profiles: %d before, %d after", before, after)
	}
}

func TestUpdateProfile_MaxAgeRatingValidatedAndInvalidatesHero(t *testing.T) {
	q := requireRequestTestDB(t)
	userID := seedReqUser(t, q)
	ctx := context.Background()
	p := &models.UserProfile{UserID: userID, Name: "kid", Language: "en", SubtitleMode: "off"}
	if err := q.CreateProfile(ctx, p); err != nil {
		t.Fatalf("seed profile: %v", err)
	}
	hero := &ratingFakeHero{}
	h := NewProfileHandler(q)
	h.SetHeroProvider(hero)

	update := func(t *testing.T, body string) (int, string) {
		t.Helper()
		hero.invalidated = nil
		rr := httptest.NewRecorder()
		h.UpdateProfile(rr, profileReq(t, http.MethodPut, body, userID, p.ID))
		stored, err := q.GetProfile(ctx, p.ID)
		if err != nil || stored == nil {
			t.Fatalf("reload profile: %v", err)
		}
		return rr.Code, stored.MaxAgeRating
	}
	invalidated := func() bool { return len(hero.invalidated) == 1 && hero.invalidated[0] == p.ID }

	if code, got := update(t, `{"max_age_rating":" tv-14 "}`); code != http.StatusOK || got != "TV-14" {
		t.Errorf("update to %q: status %d stored %q, want 200 and the canonical TV-14", " tv-14 ", code, got)
	}
	if !invalidated() {
		t.Errorf("a ceiling change invalidated %v, want [%d]: cached hero/discover picks were built under the old ceiling", hero.invalidated, p.ID)
	}

	if code, got := update(t, `{"max_age_rating":"PG13"}`); code != http.StatusBadRequest || got != "TV-14" {
		t.Errorf("update to PG13: status %d stored %q, want 400 with TV-14 unchanged", code, got)
	}
	if len(hero.invalidated) != 0 {
		t.Errorf("a rejected update invalidated %v", hero.invalidated)
	}

	// A name-only update leaves the ceiling and the caches alone.
	if code, got := update(t, `{"name":"kiddo"}`); code != http.StatusOK || got != "TV-14" {
		t.Errorf("name-only update: status %d stored %q, want 200 with TV-14 unchanged", code, got)
	}
	if len(hero.invalidated) != 0 {
		t.Errorf("a name-only update invalidated %v", hero.invalidated)
	}

	if code, got := update(t, `{"max_age_rating":""}`); code != http.StatusOK || got != "" {
		t.Errorf("clearing the ceiling: status %d stored %q, want 200 and unrestricted", code, got)
	}
	if !invalidated() {
		t.Errorf("clearing the ceiling invalidated %v, want [%d]", hero.invalidated, p.ID)
	}
}
