package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Exercise the real HTTP handlers against migrated PostgreSQL, with DB rows as
// the oracle. Explicit bodies, acting-session fallback and destructive clears
// must agree on whose history they mutate.
type progressFixture struct {
	q                                                                  *db.Queries
	pool                                                               *pgxpool.Pool
	user, media, defaultProfile, childProfile, foreignProfile, refresh int64
}

func newProgressFixture(t *testing.T, withProfiles bool) *progressFixture {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping progress-profile integration test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	q := db.NewQueries(pool)
	f := &progressFixture{q: q, pool: pool, user: seedReqUser(t, q)}
	ctx := context.Background()
	var lib int64
	if err = pool.QueryRow(ctx, `INSERT INTO libraries (name,type,paths,owner_id) VALUES ('Progress profile test','movie',ARRAY['/tmp/progress-test'],$1) RETURNING id`, f.user).Scan(&lib); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM libraries WHERE id=$1`, lib) })
	if err = pool.QueryRow(ctx, `INSERT INTO media_items (library_id,type,title,sort_title) VALUES ($1,'movie','Progress test','progress test') RETURNING id`, lib).Scan(&f.media); err != nil {
		t.Fatal(err)
	}
	if withProfiles {
		p, err := q.CreateDefaultProfileForUser(ctx, f.user, "Default")
		if err != nil {
			t.Fatal(err)
		}
		f.defaultProfile = p.ID
		child := &models.UserProfile{UserID: f.user, Name: "Child", Language: "en", SubtitleMode: "off"}
		if err = q.CreateProfile(ctx, child); err != nil {
			t.Fatal(err)
		}
		f.childProfile = child.ID
		other := seedReqUser(t, q)
		p, err = q.CreateDefaultProfileForUser(ctx, other, "Other")
		if err != nil {
			t.Fatal(err)
		}
		f.foreignProfile = p.ID
		f.refresh = seedRCRefreshToken(t, q, f.user)
		if ok, err := q.SetActiveProfileForToken(ctx, f.refresh, f.user, f.childProfile); err != nil || !ok {
			t.Fatalf("activate: %v %v", ok, err)
		}
	}
	return f
}
func (f *progressFixture) request(method, path, body string, refresh int64) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", fmt.Sprint(f.media))
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	return rcClaimsCtx(r, f.user, refresh)
}
func (f *progressFixture) seedRows(t *testing.T) {
	t.Helper()
	for _, id := range []int64{f.defaultProfile, f.childProfile} {
		_, err := f.q.UpsertWatchProgress(context.Background(), &models.WatchProgress{UserID: f.user, ProfileID: id, MediaItemID: f.media, PositionMs: 1000, DurationMs: 10000})
		if err != nil {
			t.Fatal(err)
		}
	}
}
func (f *progressFixture) assertRow(t *testing.T, profile, position int64, completed bool) {
	t.Helper()
	var got int64
	var complete bool
	if err := f.pool.QueryRow(context.Background(), `SELECT position_ms,completed FROM watch_progress WHERE user_id=$1 AND media_item_id=$2 AND profile_id=$3`, f.user, f.media, profile).Scan(&got, &complete); err != nil {
		t.Fatal(err)
	}
	if got != position || complete != completed {
		t.Fatalf("profile %d progress=(%d,%v), want (%d,%v)", profile, got, complete, position, completed)
	}
}
func TestProgressActingProfileAndExplicitProfile(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		t.Run(fmt.Sprint("explicit=", explicit), func(t *testing.T) {
			f := newProgressFixture(t, true)
			f.seedRows(t)
			h := NewProgressHandler(f.q, nil)
			refresh := f.refresh
			body := `{"position_ms":4000,"duration_ms":10000}`
			mark := `{}`
			query := ""
			if explicit {
				refresh = 0
				body = fmt.Sprintf(`{"position_ms":4000,"duration_ms":10000,"profile_id":%d}`, f.childProfile)
				mark = fmt.Sprintf(`{"profile_id":%d}`, f.childProfile)
				query = fmt.Sprintf("?profile_id=%d", f.childProfile)
			}
			w := httptest.NewRecorder()
			h.UpdateProgress(w, f.request(http.MethodPut, "/api/progress/x", body, refresh))
			if w.Code != http.StatusOK {
				t.Fatalf("heartbeat: %d %s", w.Code, w.Body.String())
			}
			f.assertRow(t, f.childProfile, 4000, false)
			f.assertRow(t, f.defaultProfile, 1000, false)
			w = httptest.NewRecorder()
			h.MarkWatched(w, f.request(http.MethodPost, "/api/progress/x/watched", mark, refresh))
			if w.Code != http.StatusOK {
				t.Fatalf("mark watched: %d %s", w.Code, w.Body.String())
			}
			f.assertRow(t, f.childProfile, 0, true)
			f.assertRow(t, f.defaultProfile, 1000, false)
			w = httptest.NewRecorder()
			h.DeleteProgress(w, f.request(http.MethodDelete, "/api/progress/x"+query, "", refresh))
			if w.Code != http.StatusOK {
				t.Fatalf("clear: %d %s", w.Code, w.Body.String())
			}
			f.assertRow(t, f.defaultProfile, 1000, false)
			var count int
			if err := f.pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM watch_progress WHERE user_id=$1 AND media_item_id=$2 AND profile_id=$3`, f.user, f.media, f.childProfile).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatal("clear did not delete the child's row")
			}
		})
	}
}
func TestProgressRejectsForeignProfileAndForgedSessionBinding(t *testing.T) {
	f := newProgressFixture(t, true)
	f.seedRows(t)
	h := NewProgressHandler(f.q, nil)
	for _, method := range []string{http.MethodPut, http.MethodPost, http.MethodDelete} {
		path := "/api/progress/x"
		body := fmt.Sprintf(`{"position_ms":4000,"duration_ms":10000,"profile_id":%d}`, f.foreignProfile)
		handler := h.UpdateProgress
		if method == http.MethodPost {
			handler = h.MarkWatched
			path += "/watched"
		}
		if method == http.MethodDelete {
			handler = h.DeleteProgress
			path += fmt.Sprintf("?profile_id=%d", f.foreignProfile)
		}
		w := httptest.NewRecorder()
		handler(w, f.request(method, path, body, f.refresh))
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s foreign profile: %d %s", method, w.Code, w.Body.String())
		}
	}
	f.assertRow(t, f.defaultProfile, 1000, false)
	f.assertRow(t, f.childProfile, 1000, false)
	// Even a corrupted DB binding may not select another user's profile.
	if _, err := f.pool.Exec(context.Background(), `UPDATE refresh_tokens SET active_profile_id=$1 WHERE id=$2`, f.foreignProfile, f.refresh); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.UpdateProgress(w, f.request(http.MethodPut, "/api/progress/x", `{"position_ms":4000,"duration_ms":10000}`, f.refresh))
	if w.Code != http.StatusOK {
		t.Fatalf("forged binding: %d %s", w.Code, w.Body.String())
	}
	f.assertRow(t, f.defaultProfile, 4000, false)
	f.assertRow(t, f.childProfile, 1000, false)
}
func TestProgressOAuthCreatesRealDefaultProfileConcurrently(t *testing.T) {
	f := newProgressFixture(t, false)
	h := NewProgressHandler(f.q, nil)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// Omitted and explicit synthetic zero both need a persistent profile.
			body := `{"position_ms":4000,"duration_ms":10000}`
			if i%2 == 0 {
				body = `{"position_ms":4000,"duration_ms":10000,"profile_id":0}`
			}
			w := httptest.NewRecorder()
			h.UpdateProgress(w, f.request(http.MethodPut, "/api/progress/x", body, 0))
			if w.Code != http.StatusOK {
				t.Errorf("OAuth heartbeat: %d %s", w.Code, w.Body.String())
			}
		}(i)
	}
	wg.Wait()
	p, err := f.q.GetDefaultProfile(context.Background(), f.user)
	if err != nil || p == nil || p.ID <= 0 {
		t.Fatalf("persistent profile: %+v %v", p, err)
	}
	f.assertRow(t, p.ID, 4000, false)
	var count int
	if err := f.pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM user_profiles WHERE user_id=$1 AND is_default`, f.user).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("default profiles=%d, want 1", count)
	}
}

func TestProgressResumeReadsUseActingProfile(t *testing.T) {
	f := newProgressFixture(t, true)
	f.seedRows(t)
	_, err := f.q.UpsertWatchProgress(context.Background(), &models.WatchProgress{UserID: f.user, ProfileID: f.childProfile, MediaItemID: f.media, PositionMs: 4000, DurationMs: 10000})
	if err != nil {
		t.Fatal(err)
	}
	h := NewProgressHandler(f.q, nil)
	w := httptest.NewRecorder()
	h.GetProgress(w, f.request(http.MethodGet, "/api/progress/x", "", f.refresh))
	var progress models.WatchProgress
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &progress) != nil || progress.ProfileID != f.childProfile || progress.PositionMs != 4000 {
		t.Fatalf("acting resume: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	h.GetProgress(w, f.request(http.MethodGet, fmt.Sprintf("/api/progress/x?profile_id=%d", f.foreignProfile), "", 0))
	if w.Code != http.StatusForbidden {
		t.Fatalf("foreign resume: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	h.GetProgress(w, f.request(http.MethodGet, fmt.Sprintf("/api/progress/x?profile_id=%d", f.childProfile), "", 0))
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &progress) != nil || progress.ProfileID != f.childProfile {
		t.Fatalf("explicit resume: %d %s", w.Code, w.Body.String())
	}
	metadata := NewMetadataHandler(f.q, nil, nil)
	w = httptest.NewRecorder()
	metadata.GetEnriched(w, f.request(http.MethodGet, "/api/media/x/enriched", "", f.refresh))
	var enriched struct {
		UserProgress *models.WatchProgress `json:"user_progress"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &enriched) != nil || enriched.UserProgress == nil || enriched.UserProgress.ProfileID != f.childProfile || enriched.UserProgress.PositionMs != 4000 {
		t.Fatalf("movie resume: %d %s", w.Code, w.Body.String())
	}
}
func TestEpisodeResumeAndNextUpUseActingProfile(t *testing.T) {
	f := newProgressFixture(t, true)
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `UPDATE media_items SET type='show' WHERE id=$1`, f.media); err != nil {
		t.Fatal(err)
	}
	season, err := f.q.UpsertSeason(ctx, f.media, 1)
	if err != nil {
		t.Fatal(err)
	}
	ep1, err := f.q.UpsertEpisode(ctx, season, f.media, 1)
	if err != nil {
		t.Fatal(err)
	}
	ep2, err := f.q.UpsertEpisode(ctx, season, f.media, 2)
	if err != nil {
		t.Fatal(err)
	}
	// Default has finished E1 and is on E2. Child is still watching E1.
	for _, wp := range []*models.WatchProgress{
		{UserID: f.user, ProfileID: f.defaultProfile, MediaItemID: f.media, EpisodeID: &ep1, PositionMs: 10000, DurationMs: 10000},
		{UserID: f.user, ProfileID: f.defaultProfile, MediaItemID: f.media, EpisodeID: &ep2, PositionMs: 6000, DurationMs: 10000},
		{UserID: f.user, ProfileID: f.childProfile, MediaItemID: f.media, EpisodeID: &ep1, PositionMs: 3000, DurationMs: 10000},
	} {
		if _, err := f.q.UpsertWatchProgress(ctx, wp); err != nil {
			t.Fatal(err)
		}
	}
	tv := NewTVHandler(f.q)
	request := f.request(http.MethodGet, "/api/media/x/seasons/1/episodes", "", f.refresh)
	chi.RouteContext(request.Context()).URLParams.Add("season", "1")
	w := httptest.NewRecorder()
	tv.GetEpisodes(w, request)
	var episodes []models.EpisodeDetail
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &episodes) != nil || len(episodes) != 2 || episodes[0].Progress == nil || episodes[0].Progress.ProfileID != f.childProfile || episodes[0].Progress.PositionMs != 3000 || episodes[1].Progress != nil {
		t.Fatalf("episode progress: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	tv.GetNextEpisode(w, f.request(http.MethodGet, "/api/media/x/next-episode", "", f.refresh))
	var next models.EpisodeDetail
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &next) != nil || next.ID != ep1 || next.Progress == nil || next.Progress.ProfileID != f.childProfile {
		t.Fatalf("child next: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	tv.GetNextEpisode(w, f.request(http.MethodGet, "/api/media/x/next-episode", "", 0))
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &next) != nil || next.ID != ep2 || next.Progress == nil || next.Progress.ProfileID != f.defaultProfile {
		t.Fatalf("default next: %d %s", w.Code, w.Body.String())
	}
	metadata := NewMetadataHandler(f.q, nil, nil)
	w = httptest.NewRecorder()
	metadata.GetEnriched(w, f.request(http.MethodGet, "/api/media/x/enriched", "", f.refresh))
	var enriched struct {
		UserProgress *models.WatchProgress `json:"user_progress"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &enriched) != nil || enriched.UserProgress == nil || enriched.UserProgress.ProfileID != f.childProfile || enriched.UserProgress.EpisodeID == nil || *enriched.UserProgress.EpisodeID != ep1 {
		t.Fatalf("show resume: %d %s", w.Code, w.Body.String())
	}
}

func TestContinueWatchingOmittedProfileUsesActingProfile(t *testing.T) {
	f := newProgressFixture(t, true)
	f.seedRows(t)
	ctx := context.Background()
	// A second item is visible only in the default profile's history, ensuring
	// omitted query params cannot return a mixed rail or deduplicate to it.
	var otherMedia int64
	if err := f.pool.QueryRow(ctx, `INSERT INTO media_items (library_id,type,title,sort_title) SELECT library_id,'movie','Default only','default only' FROM media_items WHERE id=$1 RETURNING id`, f.media).Scan(&otherMedia); err != nil {
		t.Fatal(err)
	}
	if _, err := f.q.UpsertWatchProgress(ctx, &models.WatchProgress{UserID: f.user, ProfileID: f.defaultProfile, MediaItemID: otherMedia, PositionMs: 4000, DurationMs: 10000}); err != nil {
		t.Fatal(err)
	}
	h := NewProgressHandler(f.q, nil)
	check := func(refresh int64, path string, wantProfile int64, wantItems int) {
		t.Helper()
		w := httptest.NewRecorder()
		h.ContinueWatching(w, f.request(http.MethodGet, path, "", refresh))
		var items []models.ContinueWatchingItem
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &items) != nil || len(items) != wantItems {
			t.Fatalf("rail %s: %d %s", path, w.Code, w.Body.String())
		}
		for _, item := range items {
			if item.ProfileID != wantProfile {
				t.Fatalf("rail exposed profile %d, want %d: %s", item.ProfileID, wantProfile, w.Body.String())
			}
		}
	}
	check(f.refresh, "/api/progress/continue-watching", f.childProfile, 1)
	check(0, "/api/progress/continue-watching", f.defaultProfile, 2)
	check(0, fmt.Sprintf("/api/progress/continue-watching?profile_id=%d", f.childProfile), f.childProfile, 1)
	w := httptest.NewRecorder()
	h.ContinueWatching(w, f.request(http.MethodGet, fmt.Sprintf("/api/progress/continue-watching?profile_id=%d", f.foreignProfile), "", f.refresh))
	if w.Code != http.StatusForbidden {
		t.Fatalf("foreign rail: %d %s", w.Code, w.Body.String())
	}
	// Ownership validation also applies to corrupted acting-session bindings.
	if _, err := f.pool.Exec(ctx, `UPDATE refresh_tokens SET active_profile_id=$1 WHERE id=$2`, f.foreignProfile, f.refresh); err != nil {
		t.Fatal(err)
	}
	check(f.refresh, "/api/progress/continue-watching", f.defaultProfile, 2)
}

func TestContinueWatchingWithoutPersistentProfileIsEmpty(t *testing.T) {
	f := newProgressFixture(t, false)
	h := NewProgressHandler(f.q, nil)
	w := httptest.NewRecorder()
	h.ContinueWatching(w, f.request(http.MethodGet, "/api/progress/continue-watching", "", 0))
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("OAuth rail: %d %s", w.Code, w.Body.String())
	}
}
