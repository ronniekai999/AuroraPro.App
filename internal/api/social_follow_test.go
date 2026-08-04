package api

// Handler-level tests for the follow graph + feed (social phase 2):
// POST/DELETE /api/members/{username}/follow, the follower/following lists,
// the directory, and GET /api/me/following/recent. Same opt-in
// TEST_DATABASE_URL contract as the phase-1 tests; shares their helpers.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
)

func memberActionReq(method, username, action string, viewerID int64) *http.Request {
	r := httptest.NewRequest(method, "/api/members/"+username+"/"+action, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("username", username)
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	return socialClaimsCtx(r, viewerID)
}

func seedRatedItem(t *testing.T, q *db.Queries, libID int64, title, contentRating string) *models.MediaItem {
	t.Helper()
	item := &models.MediaItem{
		LibraryID:     libID,
		Type:          models.MediaMovie,
		Title:         title,
		SortTitle:     strings.ToLower(title),
		ContentRating: contentRating,
	}
	if err := q.UpsertMediaItem(context.Background(), item); err != nil {
		t.Fatalf("seed rated item %s: %v", title, err)
	}
	return item
}

func seedCompletedWatch(t *testing.T, q *db.Queries, userID, profileID, itemID int64) {
	t.Helper()
	if _, err := q.UpsertWatchProgress(context.Background(), &models.WatchProgress{
		UserID: userID, ProfileID: profileID, MediaItemID: itemID,
		PositionMs: 100_000, DurationMs: 100_000,
	}); err != nil {
		t.Fatalf("seed completed watch: %v", err)
	}
}

func TestFollow_Lifecycle(t *testing.T) {
	q := requireSocialTestDB(t)
	suffix := socialTestSuffix(t)
	alice := seedSocialUser(t, q, "follow_alice_"+suffix)
	bob := seedSocialUser(t, q, "follow_bob_"+suffix)
	carol := seedSocialUser(t, q, "follow_carol_"+suffix)
	h := NewSocialHandler(q)

	// Follow + idempotent re-follow.
	for i := 0; i < 2; i++ {
		w := socialDo(h.Follow, memberActionReq(http.MethodPost, bob.Username, "follow", alice.ID))
		if w.Code != http.StatusNoContent {
			t.Fatalf("follow (round %d): status %d: %s", i, w.Code, w.Body.String())
		}
	}
	// Self-follow → 400; unknown → 404.
	if w := socialDo(h.Follow, memberActionReq(http.MethodPost, alice.Username, "follow", alice.ID)); w.Code != http.StatusBadRequest {
		t.Errorf("self-follow: want 400, got %d", w.Code)
	}
	if w := socialDo(h.Follow, memberActionReq(http.MethodPost, "follow_missing_"+suffix, "follow", alice.ID)); w.Code != http.StatusNotFound {
		t.Errorf("follow unknown: want 404, got %d", w.Code)
	}

	// Bob's profile as seen by alice: 1 follower, followed.
	w := socialDo(h.MemberProfile, memberGetReq(bob.Username, alice.ID))
	if body := w.Body.String(); !strings.Contains(body, `"follower_count":1`) ||
		!strings.Contains(body, `"is_following":true`) {
		t.Errorf("bob's profile after follow: %s", body)
	}
	// Alice's own profile: following 1, not followed by herself.
	w = socialDo(h.MemberProfile, memberGetReq(alice.Username, alice.ID))
	if body := w.Body.String(); !strings.Contains(body, `"following_count":1`) ||
		!strings.Contains(body, `"is_following":false`) {
		t.Errorf("alice's profile after follow: %s", body)
	}

	// Directory: viewer-relative flags.
	w = socialDo(h.ListMembers, socialClaimsCtx(httptest.NewRequest(http.MethodGet, "/api/members", nil), alice.ID))
	if w.Code != http.StatusOK {
		t.Fatalf("list members: status %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, bob.Username) || !strings.Contains(body, carol.Username) {
		t.Errorf("directory missing members: %s", body)
	}
	// display_name/avatar_url are omitempty and empty in this fixture, so
	// the serialized row is exactly username followed by is_following.
	if !strings.Contains(body, `"username":"`+bob.Username+`","is_following":true`) {
		t.Errorf("directory should mark bob followed: %s", body)
	}

	// Connection lists carry the caller-relative flag too (PR-429 review):
	// carol doesn't follow alice, so alice's row in bob's followers reads
	// false FOR CAROL — and after carol follows alice, true.
	w = socialDo(h.Followers, memberActionReq(http.MethodGet, bob.Username, "followers", carol.ID))
	if body := w.Body.String(); !strings.Contains(body, `"username":"`+alice.Username+`","is_following":false`) {
		t.Errorf("bob's followers should read is_following=false for carol: %s", body)
	}
	if w := socialDo(h.Follow, memberActionReq(http.MethodPost, alice.Username, "follow", carol.ID)); w.Code != http.StatusNoContent {
		t.Fatalf("carol follows alice: %d", w.Code)
	}
	w = socialDo(h.Followers, memberActionReq(http.MethodGet, bob.Username, "followers", carol.ID))
	if body := w.Body.String(); !strings.Contains(body, `"username":"`+alice.Username+`","is_following":true`) {
		t.Errorf("bob's followers should read is_following=true after carol follows alice: %s", body)
	}

	// Lists.
	w = socialDo(h.Followers, memberActionReq(http.MethodGet, bob.Username, "followers", carol.ID))
	if body := w.Body.String(); !strings.Contains(body, alice.Username) {
		t.Errorf("bob's followers should include alice: %s", body)
	}
	w = socialDo(h.Following, memberActionReq(http.MethodGet, alice.Username, "following", carol.ID))
	if body := w.Body.String(); !strings.Contains(body, bob.Username) {
		t.Errorf("alice's following should include bob: %s", body)
	}

	// Unfollow (idempotent), counts drop.
	for i := 0; i < 2; i++ {
		if w := socialDo(h.Unfollow, memberActionReq(http.MethodDelete, bob.Username, "follow", alice.ID)); w.Code != http.StatusNoContent {
			t.Fatalf("unfollow (round %d): status %d", i, w.Code)
		}
	}
	w = socialDo(h.MemberProfile, memberGetReq(bob.Username, alice.ID))
	if body := w.Body.String(); !strings.Contains(body, `"follower_count":0`) ||
		!strings.Contains(body, `"is_following":false`) {
		t.Errorf("bob's profile after unfollow: %s", body)
	}
}

func TestFollowingRecent_PrivacyAndAttribution(t *testing.T) {
	q := requireSocialTestDB(t)
	ctx := context.Background()
	suffix := socialTestSuffix(t)
	viewer := seedSocialUser(t, q, "feed_viewer_"+suffix)
	sharer := seedSocialUser(t, q, "feed_sharer_"+suffix)
	private := seedSocialUser(t, q, "feed_private_"+suffix)
	h := NewSocialHandler(q)

	lib := &models.Library{
		Name:    "feed_test_lib_" + suffix,
		Type:    models.LibraryMovies,
		Paths:   []string{"/tmp/feed_test"},
		OwnerID: viewer.ID,
	}
	if err := q.CreateLibrary(ctx, lib); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() { _, _ = q.DeleteLibrary(ctx, lib.ID) })

	sharedItem := seedSocialItem(t, q, lib.ID, "Feed Shared Movie "+suffix)
	kidsItem := seedSocialItem(t, q, lib.ID, "Feed Kids Movie "+suffix)
	privateItem := seedSocialItem(t, q, lib.ID, "Feed Private Movie "+suffix)

	// sharer opts in with a display name (feed must attribute by it);
	// private leaves sharing off.
	display := "Sharer " + suffix
	w := socialDo(h.UpdateMyProfile, socialPutReq(
		`{"display_name":"`+display+`","share_watch_history":true}`, sharer.ID))
	if w.Code != http.StatusOK {
		t.Fatalf("sharer opt-in: %d %s", w.Code, w.Body.String())
	}

	// Viewer follows both.
	for _, followee := range []string{sharer.Username, private.Username} {
		if w := socialDo(h.Follow, memberActionReq(http.MethodPost, followee, "follow", viewer.ID)); w.Code != http.StatusNoContent {
			t.Fatalf("follow %s: %d", followee, w.Code)
		}
	}

	// Watches: sharer completes on default profile + on a kids profile;
	// private completes on default profile.
	kidsProfile := &models.UserProfile{UserID: sharer.ID, Name: "feed_kids_" + suffix, Language: "en", SubtitleMode: "off"}
	if err := q.CreateProfile(ctx, kidsProfile); err != nil {
		t.Fatalf("seed kids profile: %v", err)
	}
	seedCompletedWatch(t, q, sharer.ID, 0, sharedItem.ID)
	seedCompletedWatch(t, q, sharer.ID, kidsProfile.ID, kidsItem.ID)
	seedCompletedWatch(t, q, private.ID, 0, privateItem.ID)

	feed := func() string {
		w := socialDo(h.FollowingRecent, socialClaimsCtx(httptest.NewRequest(http.MethodGet, "/api/me/following/recent", nil), viewer.ID))
		if w.Code != http.StatusOK {
			t.Fatalf("feed: status %d: %s", w.Code, w.Body.String())
		}
		return w.Body.String()
	}

	body := feed()
	if !strings.Contains(body, sharedItem.Title) || !strings.Contains(body, `"watched_by":"`+display+`"`) {
		t.Errorf("feed missing shared watch with attribution: %s", body)
	}
	if strings.Contains(body, kidsItem.Title) {
		t.Errorf("feed leaked a non-default-profile watch: %s", body)
	}
	if strings.Contains(body, privateItem.Title) {
		t.Errorf("feed leaked a non-sharing member's watch: %s", body)
	}

	// The 049 flag is re-checked at read time: opting in surfaces
	// immediately, opting out vanishes immediately.
	if w := socialDo(h.UpdateMyProfile, socialPutReq(`{"share_watch_history":true}`, private.ID)); w.Code != http.StatusOK {
		t.Fatalf("private opt-in: %d", w.Code)
	}
	if body := feed(); !strings.Contains(body, privateItem.Title) {
		t.Errorf("feed should include newly shared member: %s", body)
	}
	if w := socialDo(h.UpdateMyProfile, socialPutReq(`{"share_watch_history":false}`, sharer.ID)); w.Code != http.StatusOK {
		t.Fatalf("sharer opt-out: %d", w.Code)
	}
	if body := feed(); strings.Contains(body, sharedItem.Title) {
		t.Errorf("feed should drop opted-out member immediately: %s", body)
	}

	// A member who follows nobody gets an empty (non-null) items array.
	w = socialDo(h.FollowingRecent, socialClaimsCtx(httptest.NewRequest(http.MethodGet, "/api/me/following/recent", nil), sharer.ID))
	if body := w.Body.String(); !strings.Contains(body, `"items":[]`) {
		t.Errorf("empty feed should be [], got: %s", body)
	}
}

// TestFollowingRecent_CeilingAndSharedTitle pins the two PR-429 review
// findings on the feed query: (1) the viewing sub-profile's parental
// ceiling applies to the rail exactly like every sibling home surface;
// (2) when two followees complete the SAME title, the feed shows one row
// attributed to the LATER completer (DISTINCT ON keeps whole rows, so
// watched_at and watched_by can never disagree).
func TestFollowingRecent_CeilingAndSharedTitle(t *testing.T) {
	q := requireSocialTestDB(t)
	ctx := context.Background()
	suffix := socialTestSuffix(t)
	h := NewSocialHandler(q)

	// Restricted viewer: default profile with a PG ceiling (seedSocialUser
	// can't be used — its default profile is unrestricted).
	kidName := "feed_kid_" + suffix
	kid, err := q.CreateUser(ctx, kidName, kidName+"@example.com", "$2a$10$placeholder", models.RoleUser)
	if err != nil {
		t.Fatalf("seed restricted user: %v", err)
	}
	t.Cleanup(func() { _, _ = q.DeleteUser(ctx, kid.ID) })
	kidProfile := &models.UserProfile{UserID: kid.ID, Name: kidName, IsDefault: true, MaxAgeRating: "PG", Language: "en", SubtitleMode: "off"}
	if err := q.CreateProfile(ctx, kidProfile); err != nil {
		t.Fatalf("seed restricted profile: %v", err)
	}
	adult := seedSocialUser(t, q, "feed_adult_"+suffix)
	s1 := seedSocialUser(t, q, "feed_s1_"+suffix)
	s2 := seedSocialUser(t, q, "feed_s2_"+suffix)
	for id, name := range map[int64]string{s1.ID: "S One", s2.ID: "S Two"} {
		if w := socialDo(h.UpdateMyProfile, socialPutReq(`{"display_name":"`+name+`","share_watch_history":true}`, id)); w.Code != http.StatusOK {
			t.Fatalf("sharer opt-in: %d %s", w.Code, w.Body.String())
		}
	}

	lib := &models.Library{
		Name:    "feed_ceiling_lib_" + suffix,
		Type:    models.LibraryMovies,
		Paths:   []string{"/tmp/feed_ceiling_test"},
		OwnerID: adult.ID,
	}
	if err := q.CreateLibrary(ctx, lib); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() { _, _ = q.DeleteLibrary(ctx, lib.ID) })
	pgItem := seedRatedItem(t, q, lib.ID, "Feed PG Movie "+suffix, "PG")
	rItem := seedRatedItem(t, q, lib.ID, "Feed R Movie "+suffix, "R")

	for _, viewerID := range []int64{kid.ID, adult.ID} {
		for _, followee := range []string{s1.Username, s2.Username} {
			if w := socialDo(h.Follow, memberActionReq(http.MethodPost, followee, "follow", viewerID)); w.Code != http.StatusNoContent {
				t.Fatalf("follow %s as %d: %d", followee, viewerID, w.Code)
			}
		}
	}

	// s1 completes both titles; s2 completes the PG title strictly later,
	// so the shared-title row must attribute to S Two.
	seedCompletedWatch(t, q, s1.ID, 0, pgItem.ID)
	seedCompletedWatch(t, q, s1.ID, 0, rItem.ID)
	time.Sleep(25 * time.Millisecond) // completed_at = statement NOW(); force a strictly later stamp
	seedCompletedWatch(t, q, s2.ID, 0, pgItem.ID)

	feedFor := func(userID int64, query string) string {
		t.Helper()
		w := socialDo(h.FollowingRecent, socialClaimsCtx(httptest.NewRequest(http.MethodGet, "/api/me/following/recent"+query, nil), userID))
		if w.Code != http.StatusOK {
			t.Fatalf("feed for %d: status %d: %s", userID, w.Code, w.Body.String())
		}
		return w.Body.String()
	}

	// Restricted viewer: R title gone, PG title present exactly once.
	body := feedFor(kid.ID, "")
	if strings.Contains(body, rItem.Title) {
		t.Errorf("ceiling: R title leaked into restricted feed: %s", body)
	}
	if got := strings.Count(body, pgItem.Title); got != 1 {
		t.Errorf("shared title should appear exactly once, got %d: %s", got, body)
	}
	if !strings.Contains(body, `"watched_by":"S Two"`) {
		t.Errorf("shared title should attribute to the later completer: %s", body)
	}

	// Unrestricted viewer sees the R title (attributed to its only
	// completer) and the same single shared-title row.
	body = feedFor(adult.ID, "")
	if !strings.Contains(body, rItem.Title) || !strings.Contains(body, `"watched_by":"S One"`) {
		t.Errorf("unrestricted feed missing R title/attribution: %s", body)
	}
	if got := strings.Count(body, pgItem.Title); got != 1 {
		t.Errorf("unrestricted: shared title should appear exactly once, got %d", got)
	}

	// ?profile_id= ownership: another user's profile id is a 403.
	w := socialDo(h.FollowingRecent, socialClaimsCtx(
		httptest.NewRequest(http.MethodGet, "/api/me/following/recent?profile_id="+strconv.FormatInt(kidProfile.ID, 10), nil), adult.ID))
	if w.Code != http.StatusForbidden {
		t.Errorf("foreign profile_id: want 403, got %d: %s", w.Code, w.Body.String())
	}
}
