package api

// Handler-level tests for the member-profile endpoints (GET/PUT
// /api/me/profile, GET /api/members/{username}). Split per house convention:
// pure input-validation cases run unconditionally against a nil *db.Queries
// (UpdateMyProfile validates the whole patch before its first DB touch);
// behavioral cases are opt-in via TEST_DATABASE_URL, same contract as the
// other API integration tests.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func requireSocialTestDB(t *testing.T) *db.Queries {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping social-handler integration test")
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

func socialTestSuffix(t *testing.T) string {
	t.Helper()
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

func socialClaimsCtx(r *http.Request, userID int64) *http.Request {
	claims := &auth.JWTClaims{UserID: userID, Username: "u", Role: "user"}
	return r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, claims))
}

func socialPutReq(body string, userID int64) *http.Request {
	r := httptest.NewRequest(http.MethodPut, "/api/me/profile", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return socialClaimsCtx(r, userID)
}

func socialGetMeReq(userID int64) *http.Request {
	return socialClaimsCtx(httptest.NewRequest(http.MethodGet, "/api/me/profile", nil), userID)
}

// memberGetReq builds GET /api/members/{username} with the chi route param
// injected manually — handlers are called directly, not through the router.
func memberGetReq(username string, viewerID int64) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/members/"+username, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("username", username)
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	return socialClaimsCtx(r, viewerID)
}

func socialDo(handler http.HandlerFunc, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	handler(w, r)
	return w
}

// TestSocialProfile_ValidationNoDB pins that every rejected patch is refused
// BEFORE any DB access — the nil queries here nil-panic if that ordering
// regresses.
func TestSocialProfile_ValidationNoDB(t *testing.T) {
	h := NewSocialHandler(nil)
	long := strings.Repeat("x", 81)
	longBio := strings.Repeat("b", 501)
	for _, tc := range []struct{ name, body string }{
		{"garbage body", `{`},
		{"x handle with space", `{"social_x":"bad handle"}`},
		{"x handle too long", `{"social_x":"sixteen_chars_xx"}`},
		{"instagram url paste", `{"social_instagram":"https://instagram.com/someone"}`},
		{"facebook slash", `{"social_facebook":"pages/someone"}`},
		{"snapchat leading digit", `{"social_snapchat":"1ronnie"}`},
		{"display name too long", `{"display_name":"` + long + `"}`},
		{"bio too long", `{"bio":"` + longBio + `"}`},
	} {
		if w := socialDo(h.UpdateMyProfile, socialPutReq(tc.body, 1)); w.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d (%s)", tc.name, w.Code, w.Body.String())
		}
	}
	// Member lookup with no route param (empty username) also fails pre-DB.
	if w := socialDo(h.MemberProfile, memberGetReq("", 1)); w.Code != http.StatusBadRequest {
		t.Errorf("empty username: want 400, got %d", w.Code)
	}
}

// TestSocialSanitizers covers the field cleaners directly: invisible/control
// characters must not survive into member-visible fields, but the bio's
// newlines must.
func TestSocialSanitizers(t *testing.T) {
	if got := sanitizeProfileLine("  Ron\u200bnie\nK  "); got != "RonnieK" {
		t.Errorf("sanitizeProfileLine: got %q", got)
	}
	if got := sanitizeProfileBio("Movie nights\r\nevery friday\x07"); got != "Movie nights\neveryfriday" {
		t.Errorf("sanitizeProfileBio: got %q", got)
	}
	if got := normalizeHandle("  @Ronnie_K "); got != "Ronnie_K" {
		t.Errorf("normalizeHandle: got %q", got)
	}
}

// seedSocialUser creates a user with a default sub-profile; cleanup cascades
// from the user delete.
func seedSocialUser(t *testing.T, q *db.Queries, name string) *models.User {
	t.Helper()
	ctx := context.Background()
	user, err := q.CreateUser(ctx, name, name+"@example.com", "$2a$10$placeholder", models.RoleUser)
	if err != nil {
		t.Fatalf("seed user %s: %v", name, err)
	}
	t.Cleanup(func() { _, _ = q.DeleteUser(ctx, user.ID) })
	if _, err := q.CreateDefaultProfileForUser(ctx, user.ID, name); err != nil {
		t.Fatalf("seed default profile for %s: %v", name, err)
	}
	return user
}

func seedSocialItem(t *testing.T, q *db.Queries, libID int64, title string) *models.MediaItem {
	t.Helper()
	item := &models.MediaItem{
		LibraryID: libID,
		Type:      models.MediaMovie,
		Title:     title,
		SortTitle: strings.ToLower(title),
	}
	if err := q.UpsertMediaItem(context.Background(), item); err != nil {
		t.Fatalf("seed media item %s: %v", title, err)
	}
	return item
}

func TestSocialProfile_RoundtripAndPrivacy(t *testing.T) {
	q := requireSocialTestDB(t)
	ctx := context.Background()
	suffix := socialTestSuffix(t)
	owner := seedSocialUser(t, q, "social_owner_"+suffix)
	viewer := seedSocialUser(t, q, "social_viewer_"+suffix)
	h := NewSocialHandler(q)

	lib := &models.Library{
		Name:    "social_test_lib_" + suffix,
		Type:    models.LibraryMovies,
		Paths:   []string{"/tmp/social_test"},
		OwnerID: owner.ID,
	}
	if err := q.CreateLibrary(ctx, lib); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() { _, _ = q.DeleteLibrary(ctx, lib.ID) })

	// PUT: messy-but-valid inputs — leading @, padding, CRLF bio.
	w := socialDo(h.UpdateMyProfile, socialPutReq(
		`{"display_name":"  Ronnie K ","bio":"Movie nights\r\nEvery friday","social_x":"@ronnie_k","social_instagram":"ronnie.k","share_watch_history":false}`,
		owner.ID))
	if w.Code != http.StatusOK {
		t.Fatalf("update profile: status %d: %s", w.Code, w.Body.String())
	}
	if body := w.Body.String(); !strings.Contains(body, `"display_name":"Ronnie K"`) ||
		!strings.Contains(body, `"social_x":"ronnie_k"`) {
		t.Errorf("update response missing normalized fields: %s", body)
	}

	// GET /api/me/profile reads it back (bio newline survives, CR gone).
	w = socialDo(h.MyProfile, socialGetMeReq(owner.ID))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"bio":"Movie nights\nEvery friday"`) {
		t.Errorf("my profile: got %d %s", w.Code, w.Body.String())
	}

	// Viewer sees identity but no history while sharing is off — and never
	// email/auth material.
	w = socialDo(h.MemberProfile, memberGetReq(owner.Username, viewer.ID))
	if w.Code != http.StatusOK {
		t.Fatalf("member profile: status %d: %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"display_name":"Ronnie K"`) ||
		!strings.Contains(body, `"is_me":false`) ||
		!strings.Contains(body, `"history_visible":false`) {
		t.Errorf("member view (sharing off): %s", body)
	}
	if strings.Contains(body, "@example.com") || strings.Contains(body, "password") {
		t.Errorf("member view leaks account fields: %s", body)
	}

	// The owner previews their own page: history visible even while sharing
	// is off (is_me).
	w = socialDo(h.MemberProfile, memberGetReq(owner.Username, owner.ID))
	if body := w.Body.String(); !strings.Contains(body, `"is_me":true`) ||
		!strings.Contains(body, `"history_visible":true`) {
		t.Errorf("self view: %s", body)
	}

	// Watch fixtures: one completed on the DEFAULT profile (visible), one
	// completed on a second profile (never visible), one in-progress
	// (never visible).
	sharedItem := seedSocialItem(t, q, lib.ID, "Social Shared Movie "+suffix)
	kidsItem := seedSocialItem(t, q, lib.ID, "Social Kids Movie "+suffix)
	halfItem := seedSocialItem(t, q, lib.ID, "Social Halfway Movie "+suffix)

	kidsProfile := &models.UserProfile{UserID: owner.ID, Name: "kids_" + suffix, Language: "en", SubtitleMode: "off"}
	if err := q.CreateProfile(ctx, kidsProfile); err != nil {
		t.Fatalf("seed kids profile: %v", err)
	}
	upsert := func(itemID, profileID, pos, dur int64) {
		t.Helper()
		if _, err := q.UpsertWatchProgress(ctx, &models.WatchProgress{
			UserID: owner.ID, ProfileID: profileID, MediaItemID: itemID,
			PositionMs: pos, DurationMs: dur,
		}); err != nil {
			t.Fatalf("seed watch progress: %v", err)
		}
	}
	upsert(sharedItem.ID, 0, 100_000, 100_000)          // default profile, completed
	upsert(kidsItem.ID, kidsProfile.ID, 100_000, 100_000) // non-default profile, completed
	upsert(halfItem.ID, 0, 10_000, 100_000)             // default profile, in progress

	// Opt in via partial patch — earlier fields must persist.
	w = socialDo(h.UpdateMyProfile, socialPutReq(`{"share_watch_history":true}`, owner.ID))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"display_name":"Ronnie K"`) {
		t.Fatalf("partial patch: got %d %s", w.Code, w.Body.String())
	}

	// Case-insensitive lookup + strip contents: default-profile completion
	// only.
	w = socialDo(h.MemberProfile, memberGetReq(strings.ToUpper(owner.Username), viewer.ID))
	if w.Code != http.StatusOK {
		t.Fatalf("member profile (upper): status %d: %s", w.Code, w.Body.String())
	}
	body = w.Body.String()
	if !strings.Contains(body, `"history_visible":true`) || !strings.Contains(body, sharedItem.Title) {
		t.Errorf("shared history missing: %s", body)
	}
	if strings.Contains(body, kidsItem.Title) {
		t.Errorf("non-default profile's watch leaked: %s", body)
	}
	if strings.Contains(body, halfItem.Title) {
		t.Errorf("in-progress watch leaked into history: %s", body)
	}

	// Clearing a field via empty string.
	w = socialDo(h.UpdateMyProfile, socialPutReq(`{"social_x":""}`, owner.ID))
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), `"social_x"`) {
		t.Errorf("clear social_x (omitempty should drop it): got %d %s", w.Code, w.Body.String())
	}

	// Unknown member → 404.
	if w := socialDo(h.MemberProfile, memberGetReq("social_missing_"+suffix, viewer.ID)); w.Code != http.StatusNotFound {
		t.Errorf("unknown member: want 404, got %d", w.Code)
	}
}

// TestMemberProfile_AvatarMirrorsDefaultProfile pins the avatar source: the
// card shows the DEFAULT sub-profile's avatar, not users.avatar_url.
func TestMemberProfile_AvatarMirrorsDefaultProfile(t *testing.T) {
	q := requireSocialTestDB(t)
	ctx := context.Background()
	suffix := socialTestSuffix(t)
	name := "social_avatar_" + suffix
	user, err := q.CreateUser(ctx, name, name+"@example.com", "$2a$10$placeholder", models.RoleUser)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() { _, _ = q.DeleteUser(ctx, user.ID) })
	p := &models.UserProfile{UserID: user.ID, Name: name, AvatarURL: "nebula:tidal", IsDefault: true, Language: "en", SubtitleMode: "off"}
	if err := q.CreateProfile(ctx, p); err != nil {
		t.Fatalf("seed default profile: %v", err)
	}

	h := NewSocialHandler(q)
	w := socialDo(h.MemberProfile, memberGetReq(name, user.ID))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"avatar_url":"nebula:tidal"`) {
		t.Errorf("avatar should mirror default sub-profile: got %d %s", w.Code, w.Body.String())
	}
}
