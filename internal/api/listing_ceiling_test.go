package api

// Handler tests for the listings that name titles across the server without
// a profile (issue #462): the calendar, every live party, the account's
// party invites, collections, and a party's highlight reel. Each used to
// list or serve a title over the acting profile's ceiling. Opt-in via
// TEST_DATABASE_URL.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/watchparty"
)

// TestTheCalendarHidesShowsOverTheCeiling: the calendar lists every show's
// upcoming episodes, so the kid's session must not see the TV-MA show's.
func TestTheCalendarHidesShowsOverTheCeiling(t *testing.T) {
	f := newGateFixture(t)
	pool := lockTestPool(t)
	if _, err := pool.Exec(context.Background(),
		`UPDATE tv_episodes SET air_date = CURRENT_DATE + 1 WHERE id = ANY($1)`, []int64{f.epOK, f.epR}); err != nil {
		t.Fatalf("schedule episodes: %v", err)
	}
	h := NewCalendarHandler(f.q)
	shows := func(rt int64) map[int64]bool {
		t.Helper()
		rr := gateCall(f.lockFixture, h.Upcoming, http.MethodGet, rt, nil, "", "")
		if rr.Code != http.StatusOK {
			t.Fatalf("calendar: %d %s", rr.Code, rr.Body.String())
		}
		var eps []struct {
			MediaItemID int64 `json:"media_item_id"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &eps); err != nil {
			t.Fatalf("decode calendar: %v", err)
		}
		out := map[int64]bool{}
		for _, e := range eps {
			out[e.MediaItemID] = true
		}
		return out
	}
	if kid := shows(f.kidRT); kid[f.showR] || !kid[f.showOK] {
		t.Errorf("the kid's calendar: TV-MA show listed %v, G show listed %v; want only the G show", kid[f.showR], kid[f.showOK])
	}
	if parent := shows(f.parentRT); !parent[f.showR] || !parent[f.showOK] {
		t.Errorf("the parent's calendar is missing a show: TV-MA %v, G %v", parent[f.showR], parent[f.showOK])
	}
}

// listingParty starts a party on media hosted by a new user, and returns its
// code and its watch_parties row id.
func listingParty(t *testing.T, f *gateFixture, m *watchparty.Manager, mediaID int64) (string, int64) {
	t.Helper()
	ctx := context.Background()
	host := seedReqUser(t, f.q)
	ps, err := m.CreateParty(ctx, host, "host", mediaID, nil, "P", fmt.Sprintf("title %d", mediaID), "/poster.jpg", 10,
		watchparty.PartySettings{AllowPause: true, AllowChat: true}, 0, nil)
	if err != nil {
		t.Fatalf("create party: %v", err)
	}
	pool := lockTestPool(t)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM watch_parties WHERE party_code = $1`, ps.Code)
	})
	var id int64
	if err := pool.QueryRow(ctx, `SELECT id FROM watch_parties WHERE party_code = $1 AND is_active`, ps.Code).Scan(&id); err != nil {
		t.Fatalf("party row: %v", err)
	}
	return ps.Code, id
}

// TestActivePartiesHideTitlesOverTheCeiling: /api/parties/active lists every
// live party on the server with its title and poster.
func TestActivePartiesHideTitlesOverTheCeiling(t *testing.T) {
	f := newGateFixture(t)
	m := watchparty.NewManager(f.q, nil)
	okCode, _ := listingParty(t, f, m, f.movieOK)
	rCode, _ := listingParty(t, f, m, f.movieR)
	// A live party whose title has since been deleted: under a ceiling a
	// title that cannot be found reads as hidden.
	gone := &models.MediaItem{LibraryID: f.libraryOf(t, f.movieOK), Type: models.MediaMovie,
		Title: "Gate gone " + reqTestSuffix(t), SortTitle: "gate gone", ContentRating: "PG"}
	if err := f.q.UpsertMediaItem(context.Background(), gone); err != nil {
		t.Fatalf("seed: %v", err)
	}
	goneCode, _ := listingParty(t, f, m, gone.ID)
	if _, err := lockTestPool(t).Exec(context.Background(), `DELETE FROM media_items WHERE id = $1`, gone.ID); err != nil {
		t.Fatalf("delete the party's title: %v", err)
	}
	h := NewPartyHandler(m, f.q, nil, nil, "", "", "")
	codes := func(rt int64) map[string]bool {
		t.Helper()
		rr := gateCall(f.lockFixture, h.ListActive, http.MethodGet, rt, nil, "", "")
		if rr.Code != http.StatusOK {
			t.Fatalf("active parties: %d %s", rr.Code, rr.Body.String())
		}
		var body struct {
			Parties []struct {
				Code string `json:"code"`
			} `json:"parties"`
			Total int `json:"total"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body.Total != len(body.Parties) {
			t.Errorf("total %d for %d parties", body.Total, len(body.Parties))
		}
		out := map[string]bool{}
		for _, p := range body.Parties {
			out[p.Code] = true
		}
		return out
	}
	if kid := codes(f.kidRT); kid[rCode] || kid[goneCode] || !kid[okCode] {
		t.Errorf("the kid's party list: R party %v, deleted title's party %v, PG party %v; want only the PG party",
			kid[rCode], kid[goneCode], kid[okCode])
	}
	if parent := codes(f.parentRT); !parent[rCode] || !parent[okCode] || !parent[goneCode] {
		t.Errorf("the parent's party list is missing a party: R %v, PG %v, deleted title %v", parent[rCode], parent[okCode], parent[goneCode])
	}
}

// TestPartyInvitesHideTitlesOverTheCeiling: an invite was checked against the
// account's default profile when it was sent, and the bell and calendar list
// it for every session on the account.
func TestPartyInvitesHideTitlesOverTheCeiling(t *testing.T) {
	f := newGateFixture(t)
	m := watchparty.NewManager(f.q, nil)
	pool := lockTestPool(t)
	invite := func(mediaID int64) string {
		code, partyID := listingParty(t, f, m, mediaID)
		if _, err := pool.Exec(context.Background(), `
			INSERT INTO party_invites (party_id, inviter_user_id, invitee_user_id)
			SELECT id, host_user_id, $2 FROM watch_parties WHERE id = $1`, partyID, f.userID); err != nil {
			t.Fatalf("invite: %v", err)
		}
		return code
	}
	okCode, rCode := invite(f.movieOK), invite(f.movieR)
	h := NewPartyInviteHandler(m, f.q, nil)
	codes := func(rt int64) map[string]bool {
		t.Helper()
		rr := gateCall(f.lockFixture, h.MyInvites, http.MethodGet, rt, nil, "", "")
		if rr.Code != http.StatusOK {
			t.Fatalf("my invites: %d %s", rr.Code, rr.Body.String())
		}
		var body struct {
			Invites []struct {
				PartyCode string `json:"party_code"`
			} `json:"invites"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		out := map[string]bool{}
		for _, i := range body.Invites {
			out[i.PartyCode] = true
		}
		return out
	}
	if kid := codes(f.kidRT); kid[rCode] || !kid[okCode] {
		t.Errorf("the kid's invites: R party listed %v, PG party listed %v; want only the PG party", kid[rCode], kid[okCode])
	}
	if parent := codes(f.parentRT); !parent[rCode] || !parent[okCode] {
		t.Errorf("the parent's invites are missing one: R %v, PG %v", parent[rCode], parent[okCode])
	}
}

// TestCollectionsHideMembersOverTheCeiling: a collection is shared beyond the
// session that filled it (public ones with every user), and its card carries
// a member count, a poster mosaic and a cover copied from its first title.
func TestCollectionsHideMembersOverTheCeiling(t *testing.T) {
	f := newGateFixture(t)
	ctx := context.Background()
	pool := lockTestPool(t)
	for id, poster := range map[int64]string{f.movieOK: "/ok.jpg", f.movieR: "/r.jpg"} {
		if _, err := pool.Exec(ctx, `UPDATE media_items SET poster_path = $2 WHERE id = $1`, id, poster); err != nil {
			t.Fatalf("set poster: %v", err)
		}
	}
	c := &models.Collection{OwnerUserID: f.userID, Name: "listing " + reqTestSuffix(t), Kind: "manual"}
	if err := f.q.CreateCollection(ctx, c); err != nil {
		t.Fatalf("create collection: %v", err)
	}
	t.Cleanup(func() { _ = f.q.DeleteCollection(context.Background(), c.ID) })
	// The R title first, so the stored cover is its poster.
	for _, id := range []int64{f.movieR, f.movieOK} {
		if err := f.q.AddToCollection(ctx, c.ID, id); err != nil {
			t.Fatalf("add %d: %v", id, err)
		}
	}
	h := NewCollectionsHandler(f.q)
	idParam := map[string]string{"id": strconv.FormatInt(c.ID, 10)}

	card := func(rt int64) models.Collection {
		t.Helper()
		rr := gateCall(f.lockFixture, h.List, http.MethodGet, rt, nil, "", "")
		if rr.Code != http.StatusOK {
			t.Fatalf("list collections: %d %s", rr.Code, rr.Body.String())
		}
		var list []models.Collection
		if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
			t.Fatalf("decode: %v", err)
		}
		for _, got := range list {
			if got.ID == c.ID {
				return got
			}
		}
		t.Fatalf("collection %d not listed", c.ID)
		return models.Collection{}
	}
	detail := func(rt int64) (models.Collection, map[int64]bool) {
		t.Helper()
		rr := gateCall(f.lockFixture, h.Get, http.MethodGet, rt, idParam, "", "")
		if rr.Code != http.StatusOK {
			t.Fatalf("get collection: %d %s", rr.Code, rr.Body.String())
		}
		var body struct {
			Collection models.Collection   `json:"collection"`
			Items      []*models.MediaItem `json:"items"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		items := map[int64]bool{}
		for _, it := range body.Items {
			items[it.ID] = true
		}
		return body.Collection, items
	}

	kid := card(f.kidRT)
	if kid.ItemCount != 1 || kid.CoverPath != "/ok.jpg" || len(kid.PosterPaths) != 1 || kid.PosterPaths[0] != "/ok.jpg" {
		t.Errorf("the kid's card: count %d, cover %q, mosaic %v; want 1, /ok.jpg, [/ok.jpg]", kid.ItemCount, kid.CoverPath, kid.PosterPaths)
	}
	parent := card(f.parentRT)
	if parent.ItemCount != 2 || parent.CoverPath != "/r.jpg" || len(parent.PosterPaths) != 2 {
		t.Errorf("the parent's card: count %d, cover %q, mosaic %v; want 2, /r.jpg and both posters", parent.ItemCount, parent.CoverPath, parent.PosterPaths)
	}
	if got, items := detail(f.kidRT); items[f.movieR] || !items[f.movieOK] || got.ItemCount != 1 || got.CoverPath != "/ok.jpg" {
		t.Errorf("the kid's collection: R listed %v, PG listed %v, count %d, cover %q", items[f.movieR], items[f.movieOK], got.ItemCount, got.CoverPath)
	}
	if _, items := detail(f.parentRT); !items[f.movieR] || !items[f.movieOK] {
		t.Errorf("the parent's collection is missing a title: R %v, PG %v", items[f.movieR], items[f.movieOK])
	}

	// Adding is a by-id probe: an over-ceiling title reads as missing.
	add := func(rt, id int64) *httptest.ResponseRecorder {
		return gateCall(f.lockFixture, h.AddItem, http.MethodPost, rt, idParam, "", fmt.Sprintf(`{"media_item_id":%d}`, id))
	}
	hidden, missing := add(f.kidRT, f.showR), add(f.kidRT, missingID)
	if hidden.Code != http.StatusNotFound || hidden.Body.String() != missing.Body.String() {
		t.Errorf("the kid adding an over-ceiling title: %d %q; want the 404 a missing id gets (%d %q)",
			hidden.Code, hidden.Body.String(), missing.Code, missing.Body.String())
	}
	if rr := add(f.kidRT, f.showOK); rr.Code != http.StatusOK {
		t.Errorf("the kid adding an allowed title: %d %s", rr.Code, rr.Body.String())
	}
	if rr := add(f.parentRT, f.showR); rr.Code != http.StatusOK {
		t.Errorf("the parent adding the TV-MA show: %d %s", rr.Code, rr.Body.String())
	}
	var showRCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM collection_items WHERE collection_id = $1 AND media_item_id = $2`,
		c.ID, f.showR).Scan(&showRCount); err != nil || showRCount != 1 {
		t.Errorf("the TV-MA show is in the collection %d times (%v); want once, the parent's add", showRCount, err)
	}
}

// TestTheHighlightReelHidesATitleOverTheCeiling: the reel is clips of the
// party's title. Membership was its only check, and admins skipped even that.
func TestTheHighlightReelHidesATitleOverTheCeiling(t *testing.T) {
	f := newGateFixture(t)
	m := watchparty.NewManager(f.q, nil)
	dir := t.TempDir()
	m.SetHighlightCacheDir(dir)
	pool := lockTestPool(t)
	h := NewPartyHandler(m, f.q, nil, nil, "", "", "")
	reel := func(mediaID int64, joined bool) (string, int64) {
		code, id := listingParty(t, f, m, mediaID)
		if joined {
			if _, err := pool.Exec(context.Background(),
				`INSERT INTO watch_party_participants (party_id, user_id) VALUES ($1, $2)`, id, f.userID); err != nil {
				t.Fatalf("join party: %v", err)
			}
		}
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("%s-%d.mp4", code, id)), []byte("not a real reel"), 0o644); err != nil {
			t.Fatalf("write reel: %v", err)
		}
		return code, id
	}
	serve := func(rt int64, role, code string, id int64) int {
		r := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/x?session=%d", id), nil)
		r = rcRouteReq(http.MethodGet, r.URL.String(), map[string]string{"code": code})
		claims := &auth.JWTClaims{UserID: f.userID, Username: "u", Role: role, RefreshTokenID: rt}
		r = r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, claims))
		rr := httptest.NewRecorder()
		h.ServeHighlightReel(rr, r)
		return rr.Code
	}
	okCode, okID := reel(f.movieOK, true)
	rCode, rID := reel(f.movieR, true)
	// Admins still skip the membership check, and only that.
	otherCode, otherID := reel(f.movieOK, false)
	if got := serve(f.parentRT, "user", otherCode, otherID); got != http.StatusNotFound {
		t.Errorf("a non-member fetching a reel: %d, want 404", got)
	}
	if got := serve(f.parentRT, "admin", otherCode, otherID); got != http.StatusOK {
		t.Errorf("an admin who was not in the party fetching its reel: %d, want 200", got)
	}
	// A session acting as a restricted profile has no admin powers, so it
	// does not skip the membership check either (adminPowers).
	if got := serve(f.kidRT, "admin", otherCode, otherID); got != http.StatusNotFound {
		t.Errorf("a restricted session on an admin account fetching a reel of a party it was not in: %d, want 404", got)
	}
	for _, role := range []string{"user", "admin"} {
		if got := serve(f.kidRT, role, rCode, rID); got != http.StatusNotFound {
			t.Errorf("the kid (%s) fetching the R party's reel: %d, want 404", role, got)
		}
		if got := serve(f.kidRT, role, okCode, okID); got != http.StatusOK {
			t.Errorf("the kid (%s) fetching the PG party's reel: %d, want 200", role, got)
		}
		if got := serve(f.parentRT, role, rCode, rID); got != http.StatusOK {
			t.Errorf("the parent (%s) fetching the R party's reel: %d, want 200", role, got)
		}
	}
}

// libraryOf returns the library holding mediaID.
func (f *gateFixture) libraryOf(t *testing.T, mediaID int64) int64 {
	t.Helper()
	item, err := f.q.GetMediaItem(context.Background(), mediaID)
	if err != nil || item == nil {
		t.Fatalf("read media %d: %v", mediaID, err)
	}
	return item.LibraryID
}

type kidActingResolver struct{}

func (kidActingResolver) ResolveActingProfile(_ context.Context, userID, _ int64) (*models.UserProfile, error) {
	return &models.UserProfile{UserID: userID, MaxAgeRating: "PG"}, nil
}

// TestListingsFailOpenWhenTheProfileCannotBeResolved: the listings are
// discovery, not the boundary, so like browse and search they list
// unrestricted when the acting profile cannot be resolved (CLAUDE.md's
// policy); the by-id gates are the ones that fail closed.
func TestListingsFailOpenWhenTheProfileCannotBeResolved(t *testing.T) {
	claims := &auth.JWTClaims{UserID: 1, RefreshTokenID: 2}
	if got := listingAllowedRatings(context.Background(), failingActingResolver{}, claims, "test"); got != nil {
		t.Errorf("a resolve error gave the listing ceiling %v, want nil (unrestricted)", got)
	}
	if got := listingAllowedRatings(context.Background(), kidActingResolver{}, claims, "test"); len(got) == 0 {
		t.Error("a resolved PG profile gave the listing no ceiling")
	}
}

type failingRatingsReader struct{}

func (failingRatingsReader) GetContentRatings(context.Context, []int64) (map[int64]string, error) {
	return nil, fmt.Errorf("database down")
}

// TestTheLivePartyListFailsClosedWhenRatingsCannotBeRead: once the profile
// is known to be restricted, a party whose title cannot be judged is not
// listed.
func TestTheLivePartyListFailsClosedWhenRatingsCannotBeRead(t *testing.T) {
	parties := []map[string]interface{}{{"code": "AAAAAA", "media_item_id": int64(7)}}
	if got := partiesWithin(context.Background(), failingRatingsReader{}, parties, []string{"G", "PG"}); len(got) != 0 {
		t.Errorf("a ratings read error listed %d parties, want none", len(got))
	}
}

// TestCollectionVisibilityIsUnchanged: the listing's two queries (admin,
// and owner-or-public) became one predicate. An admin sees every
// collection; anyone else sees their own and the public ones.
func TestCollectionVisibilityIsUnchanged(t *testing.T) {
	f := newGateFixture(t)
	ctx := context.Background()
	other := seedReqUser(t, f.q)
	collection := func(owner int64, public bool) int64 {
		c := &models.Collection{OwnerUserID: owner, Name: "vis " + reqTestSuffix(t), Kind: "manual", IsPublic: public}
		if err := f.q.CreateCollection(ctx, c); err != nil {
			t.Fatalf("create collection: %v", err)
		}
		t.Cleanup(func() { _ = f.q.DeleteCollection(context.Background(), c.ID) })
		return c.ID
	}
	mine, theirsPrivate, theirsPublic := collection(f.userID, false), collection(other, false), collection(other, true)
	h := NewCollectionsHandler(f.q)
	listed := func(role string) map[int64]bool {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/x", nil)
		claims := &auth.JWTClaims{UserID: f.userID, Username: "u", Role: role, RefreshTokenID: f.parentRT}
		r = r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, claims))
		rr := httptest.NewRecorder()
		h.List(rr, r)
		if rr.Code != http.StatusOK {
			t.Fatalf("list collections: %d %s", rr.Code, rr.Body.String())
		}
		var list []models.Collection
		if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
			t.Fatalf("decode: %v", err)
		}
		out := map[int64]bool{}
		for _, c := range list {
			out[c.ID] = true
		}
		return out
	}
	if got := listed("user"); !got[mine] || got[theirsPrivate] || !got[theirsPublic] {
		t.Errorf("a user's list: own %v, another's private %v, another's public %v; want own and public only",
			got[mine], got[theirsPrivate], got[theirsPublic])
	}
	if got := listed("admin"); !got[mine] || !got[theirsPrivate] || !got[theirsPublic] {
		t.Errorf("an admin's list: own %v, another's private %v, another's public %v; want all three",
			got[mine], got[theirsPrivate], got[theirsPublic])
	}
}
