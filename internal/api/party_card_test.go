package api

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/watchparty"
	"github.com/go-chi/chi/v5"
)

// ============================================================
// Watch-party share card
// ============================================================

const testJWTSecret = "test-secret-at-least-32-characters-long"

// fakeCardManager stands in for *watchparty.Manager. PartyState's fields
// are exported and its zero mutex is usable, so a test can hand the
// handler a party without Postgres.
type fakeCardManager struct {
	states map[string]*watchparty.PartyState
}

func (f *fakeCardManager) GetPartyState(code string) *watchparty.PartyState {
	return f.states[code]
}

// fakeCardQueries answers the four lookups the card makes.
type fakeCardQueries struct {
	profile *models.MemberProfile
	item    *models.MediaItem
	genres  []string
	epTitle string
	season  int
	episode int
}

func (f *fakeCardQueries) GetMemberProfileByID(context.Context, int64) (*models.MemberProfile, error) {
	return f.profile, nil
}
func (f *fakeCardQueries) GetMediaItem(context.Context, int64) (*models.MediaItem, error) {
	return f.item, nil
}
func (f *fakeCardQueries) GetMediaGenres(context.Context, int64) ([]string, error) {
	return f.genres, nil
}
func (f *fakeCardQueries) GetEpisodeNowPlayingInfo(context.Context, int64) (string, int, int, string, error) {
	return "", f.season, f.episode, f.epTitle, nil
}

func newCardTestHandler(t *testing.T, mgr partyStateLookup, q cardQueries) *PartyShareHandler {
	t.Helper()
	// Construct directly rather than through NewPartyShareHandler so the
	// test doesn't spawn the reaper goroutine.
	return &PartyShareHandler{
		manager:   mgr,
		queries:   q,
		cacheDir:  t.TempDir(),
		jwtSecret: testJWTSecret,
	}
}

func cardTestParty(code string, hostID int64, scheduled *time.Time) *watchparty.PartyState {
	return &watchparty.PartyState{
		Code:        code,
		HostUserID:  hostID,
		MediaItemID: 42,
		MediaTitle:  "Jurassic World Dominion",
		// Empty poster keeps the compositor off the network.
		MediaPoster:      "",
		ScheduledStartAt: scheduled,
		Participants:     map[int64]*watchparty.Participant{},
	}
}

func cardRequest(code, query, host string, claims *auth.JWTClaims) *http.Request {
	url := "/api/parties/" + code + "/card.png"
	if query != "" {
		url += "?" + query
	}
	r := httptest.NewRequest(http.MethodGet, url, nil)
	r.Host = host
	if claims != nil {
		r = r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, claims))
	}
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("code", code)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// ── Eastern time, and the "EST" trap ────────────────────────────────

// The locked decision is the TRUE abbreviation: America/New_York resolves
// to EDT March–November and EST November–March. Printing a literal "EST"
// on a summer party is an hour-wrong instruction to anyone who converts,
// which is the one thing a share card must not be.
func TestFormatCardWhen_DSTBoundary(t *testing.T) {
	if cardTimeZone == time.UTC {
		t.Skip("no IANA tzdata available in this environment")
	}
	cases := []struct {
		name     string
		utc      string
		wantDate string
		wantTime string
	}{
		// 2026 US DST: begins Sun Mar 8, ends Sun Nov 1.
		{"summer is EDT", "2026-08-16T00:00:00Z", "Saturday, August 15", "8:00 PM EDT"},
		{"march after the switch", "2026-03-16T00:00:00Z", "Sunday, March 15", "8:00 PM EDT"},
		{"march before the switch", "2026-03-08T01:00:00Z", "Saturday, March 7", "8:00 PM EST"},
		{"november after the switch", "2026-11-15T01:00:00Z", "Saturday, November 14", "8:00 PM EST"},
		{"november before the switch", "2026-11-01T00:00:00Z", "Saturday, October 31", "8:00 PM EDT"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts, err := time.Parse(time.RFC3339, tc.utc)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			gotDate, gotTime := formatCardWhen(ts)
			if gotDate != tc.wantDate {
				t.Errorf("date = %q, want %q", gotDate, tc.wantDate)
			}
			if gotTime != tc.wantTime {
				t.Errorf("time = %q, want %q", gotTime, tc.wantTime)
			}
		})
	}
}

// Guard the specific regression the plan calls out: no code path may emit
// a hardcoded EST for an instant that is genuinely EDT.
func TestFormatCardWhen_NoHardcodedEST(t *testing.T) {
	if cardTimeZone == time.UTC {
		t.Skip("no IANA tzdata available in this environment")
	}
	ts := time.Date(2026, 8, 15, 20, 0, 0, 0, cardTimeZone)
	if _, clock := formatCardWhen(ts); !strings.HasSuffix(clock, "EDT") {
		t.Errorf("August in New York rendered %q; want an EDT suffix", clock)
	}
}

// ── Cache fingerprint ───────────────────────────────────────────────

// The old key was `<code>.png`, which meant a reschedule kept handing out
// a poster advertising the old time. The fingerprint must move whenever
// anything the card renders moves — and must NOT move otherwise, or the
// cache never hits.
func TestPartyCardFingerprint(t *testing.T) {
	t0 := time.Date(2026, 8, 15, 20, 0, 0, 0, time.UTC)
	t1 := t0.Add(time.Hour)
	base := partyCardFingerprint("7K2QD9", "Dominion", "/p.jpg", "Ronnie", &t0)

	if again := partyCardFingerprint("7K2QD9", "Dominion", "/p.jpg", "Ronnie", &t0); again != base {
		t.Errorf("fingerprint not stable: %q vs %q", base, again)
	}
	moved := []struct {
		name string
		got  string
	}{
		{"reschedule", partyCardFingerprint("7K2QD9", "Dominion", "/p.jpg", "Ronnie", &t1)},
		{"schedule cleared", partyCardFingerprint("7K2QD9", "Dominion", "/p.jpg", "Ronnie", nil)},
		{"media title", partyCardFingerprint("7K2QD9", "Fallen Kingdom", "/p.jpg", "Ronnie", &t0)},
		{"poster", partyCardFingerprint("7K2QD9", "Dominion", "/q.jpg", "Ronnie", &t0)},
		{"host name", partyCardFingerprint("7K2QD9", "Dominion", "/p.jpg", "Mia", &t0)},
		{"code", partyCardFingerprint("QX48TM", "Dominion", "/p.jpg", "Ronnie", &t0)},
	}
	for _, m := range moved {
		if m.got == base {
			t.Errorf("%s did not change the fingerprint (%q)", m.name, base)
		}
	}

	// Field boundaries must be unambiguous: two different input tuples
	// that concatenate to the same string would collide.
	a := partyCardFingerprint("AB", "CD", "", "", nil)
	b := partyCardFingerprint("A", "BCD", "", "", nil)
	if a == b {
		t.Errorf("fingerprint fields are not delimited: %q == %q", a, b)
	}
}

func TestPartyCardCachePath(t *testing.T) {
	got := partyCardCachePath("/cache", "7K2QD9", CardVariantStory, "deadbeef")
	want := filepath.Join("/cache", "party-card", "7K2QD9-story-deadbeef.png")
	if got != want {
		t.Errorf("cache path = %q, want %q", got, want)
	}
}

// ── Token ───────────────────────────────────────────────────────────

func TestCardToken_StableAndCodeScoped(t *testing.T) {
	h := newCardTestHandler(t, &fakeCardManager{}, &fakeCardQueries{})
	a := h.cardToken("7K2QD9")
	if a != h.cardToken("7K2QD9") {
		t.Error("token is not stable for a code")
	}
	if len(a) != cardTokenLen {
		t.Errorf("token length = %d, want %d", len(a), cardTokenLen)
	}
	if a == h.cardToken("QX48TM") {
		t.Error("two codes share a token")
	}
	other := &PartyShareHandler{jwtSecret: testJWTSecret + "x"}
	if a == other.cardToken("7K2QD9") {
		t.Error("token does not depend on the JWT secret")
	}
	if !h.validCardToken("7K2QD9", a) {
		t.Error("freshly minted token rejected")
	}
	if h.validCardToken("7K2QD9", "") || h.validCardToken("7K2QD9", "nope") ||
		h.validCardToken("7K2QD9", h.cardToken("QX48TM")) {
		t.Error("validCardToken accepted a bad tag")
	}
	// Fail closed with no secret configured.
	empty := &PartyShareHandler{}
	if empty.validCardToken("7K2QD9", empty.cardToken("7K2QD9")) {
		t.Error("an unset JWT secret must reject every tag")
	}
}

func TestServeCardPNG_ValidTokenRenders(t *testing.T) {
	sched := time.Date(2026, 8, 15, 20, 0, 0, 0, time.UTC)
	mgr := &fakeCardManager{states: map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, &sched),
	}}
	h := newCardTestHandler(t, mgr, &fakeCardQueries{
		profile: &models.MemberProfile{UserID: 7, Username: "ronnie", DisplayName: "Ronnie"},
		item:    &models.MediaItem{ID: 42, Year: 2022, RuntimeMin: 147},
		genres:  []string{"Action", "Adventure"},
	})

	rec := httptest.NewRecorder()
	h.ServeCardPNG(rec, cardRequest("7K2QD9", "v=story&t="+h.cardToken("7K2QD9"), "aurora.example.com", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", ct)
	}
	img, err := png.Decode(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatalf("body is not a PNG: %v", err)
	}
	if b := img.Bounds(); b.Dx() != storyLayout.Width || b.Dy() != storyLayout.Height {
		t.Errorf("PNG is %dx%d, want %dx%d", b.Dx(), b.Dy(), storyLayout.Width, storyLayout.Height)
	}

	// The render should have landed in the fingerprinted cache…
	fp := partyCardFingerprint("7K2QD9", "Jurassic World Dominion", "", "Ronnie", &sched) +
		hostCacheTag("http://aurora.example.com")
	if _, err := os.Stat(partyCardCachePath(h.cacheDir, "7K2QD9", CardVariantStory, fp)); err != nil {
		t.Errorf("expected a cached card at the fingerprinted path: %v", err)
	}
	// …and a reschedule must not serve it.
	moved := sched.Add(24 * time.Hour)
	mgr.states["7K2QD9"].ScheduledStartAt = &moved
	rec2 := httptest.NewRecorder()
	h.ServeCardPNG(rec2, cardRequest("7K2QD9", "v=story&t="+h.cardToken("7K2QD9"), "aurora.example.com", nil))
	if rec2.Code != http.StatusOK {
		t.Fatalf("reschedule render status = %d", rec2.Code)
	}
	if bytes.Equal(rec.Body.Bytes(), rec2.Body.Bytes()) {
		t.Error("rescheduled party served the identical (stale) image")
	}
}

// A wrong, absent or foreign token must 404 — never 403, which would
// confirm that the code names a real party. An unknown code, an unknown
// variant and a bad tag must all be indistinguishable.
func TestServeCardPNG_RejectionsAreIndistinguishable404s(t *testing.T) {
	sched := time.Date(2026, 8, 15, 20, 0, 0, 0, time.UTC)
	mgr := &fakeCardManager{states: map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, &sched),
	}}
	h := newCardTestHandler(t, mgr, &fakeCardQueries{
		profile: &models.MemberProfile{UserID: 7, Username: "ronnie", DisplayName: "Ronnie"},
	})

	cases := []struct{ name, code, query string }{
		{"no token", "7K2QD9", "v=story"},
		{"wrong token", "7K2QD9", "v=story&t=0000000000000000"},
		{"token for another code", "7K2QD9", "v=story&t=" + h.cardToken("QX48TM")},
		{"unknown party, valid-shaped token", "QX48TM", "v=story&t=" + h.cardToken("QX48TM")},
		{"malformed code", "abc", "v=story"},
		{"unknown variant", "7K2QD9", "v=banner&t=" + h.cardToken("7K2QD9")},
		{"variant case does not fold", "7K2QD9", "v=Square&t=" + h.cardToken("7K2QD9")},
		{"nonsense variant", "7K2QD9", "v=../../etc&t=" + h.cardToken("7K2QD9")},
	}
	var bodies []string
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeCardPNG(rec, cardRequest(tc.code, tc.query, "aurora.example.com", nil))
			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404", rec.Code)
			}
			bodies = append(bodies, rec.Body.String())
		})
	}
	for i := 1; i < len(bodies); i++ {
		if bodies[i] != bodies[0] {
			t.Errorf("404 bodies differ (%q vs %q) — the response distinguishes failure modes",
				bodies[0], bodies[i])
		}
	}
}

// The variant defaults to story so a bare ?t= link still resolves.
func TestServeCardPNG_DefaultsToStory(t *testing.T) {
	sched := time.Date(2026, 8, 15, 20, 0, 0, 0, time.UTC)
	mgr := &fakeCardManager{states: map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, &sched),
	}}
	h := newCardTestHandler(t, mgr, &fakeCardQueries{
		profile: &models.MemberProfile{UserID: 7, Username: "ronnie", DisplayName: "Ronnie"},
	})
	rec := httptest.NewRecorder()
	h.ServeCardPNG(rec, cardRequest("7K2QD9", "t="+h.cardToken("7K2QD9"), "aurora.example.com", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

// ── card-links: host-only ───────────────────────────────────────────

func TestCardLinks_HostOnly(t *testing.T) {
	sched := time.Date(2026, 8, 15, 20, 0, 0, 0, time.UTC)
	mgr := &fakeCardManager{states: map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, &sched),
	}}
	h := newCardTestHandler(t, mgr, &fakeCardQueries{})

	linksReq := func(code string, userID int64) *http.Request {
		r := cardRequest(code, "", "aurora.example.com",
			&auth.JWTClaims{UserID: userID, Username: "u", Role: "user"})
		return r
	}

	// Host: 200 with a token-bearing story URL.
	rec := httptest.NewRecorder()
	h.CardLinks(rec, linksReq("7K2QD9", 7))
	if rec.Code != http.StatusOK {
		t.Fatalf("host status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp cardLinksResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	wantStory := "http://aurora.example.com/api/parties/7K2QD9/card.png?v=story&t=" + h.cardToken("7K2QD9")
	if resp.Story != wantStory {
		t.Errorf("story = %q, want %q", resp.Story, wantStory)
	}
	if resp.Page != "http://aurora.example.com/p/7K2QD9" {
		t.Errorf("page = %q", resp.Page)
	}

	// A signed-in non-host: 403.
	rec = httptest.NewRecorder()
	h.CardLinks(rec, linksReq("7K2QD9", 9))
	if rec.Code != http.StatusForbidden {
		t.Errorf("non-host status = %d, want 403", rec.Code)
	}

	// An admin is not the host: the card carries the HOST's name, and the
	// host pressing the button is the consent event.
	rec = httptest.NewRecorder()
	h.CardLinks(rec, cardRequest("7K2QD9", "", "aurora.example.com",
		&auth.JWTClaims{UserID: 9, Username: "admin", Role: "admin"}))
	if rec.Code != http.StatusForbidden {
		t.Errorf("admin status = %d, want 403", rec.Code)
	}

	// No such party: 404.
	rec = httptest.NewRecorder()
	h.CardLinks(rec, linksReq("QX48TM", 7))
	if rec.Code != http.StatusNotFound {
		t.Errorf("missing party status = %d, want 404", rec.Code)
	}

	// Unauthenticated: 401 from requireClaims, never a minted link.
	rec = httptest.NewRecorder()
	h.CardLinks(rec, cardRequest("7K2QD9", "", "aurora.example.com", nil))
	if rec.Code == http.StatusOK {
		t.Error("anonymous caller received card links")
	}
}

// card-links mints one URL per crop the compositor can render. The tag is
// over the CODE, so all three carry the same `t` and differ only in `?v=`
// — and each one has to actually resolve, at its own size. A link the
// modal shows but the server 404s is worse than no link at all.
func TestCardLinks_MintsEveryVariantAndEachOneRenders(t *testing.T) {
	sched := time.Date(2026, 8, 15, 20, 0, 0, 0, time.UTC)
	mgr := &fakeCardManager{states: map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, &sched),
	}}
	h := newCardTestHandler(t, mgr, &fakeCardQueries{
		profile: &models.MemberProfile{UserID: 7, Username: "ronnie", DisplayName: "Ronnie"},
	})

	rec := httptest.NewRecorder()
	h.CardLinks(rec, cardRequest("7K2QD9", "", "aurora.example.com",
		&auth.JWTClaims{UserID: 7, Username: "ronnie", Role: "user"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp cardLinksResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The JSON keys are the contract the SPA indexes by format, and the
	// one Phase 3's og:image tag reads.
	var keys map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &keys); err != nil {
		t.Fatalf("decode as map: %v", err)
	}
	for _, k := range []string{"code", "story", "square", "og", "page"} {
		if keys[k] == "" {
			t.Errorf("card-links response has no %q", k)
		}
	}

	token := h.cardToken("7K2QD9")
	for _, tc := range []struct {
		variant CardVariant
		url     string
	}{
		{CardVariantStory, resp.Story},
		{CardVariantSquare, resp.Square},
		{CardVariantOG, resp.OG},
	} {
		t.Run(string(tc.variant), func(t *testing.T) {
			want := "http://aurora.example.com/api/parties/7K2QD9/card.png?v=" +
				string(tc.variant) + "&t=" + token
			if tc.url != want {
				t.Fatalf("url = %q, want %q", tc.url, want)
			}
			// Follow the minted URL back through the image route.
			rec := httptest.NewRecorder()
			h.ServeCardPNG(rec, cardRequest("7K2QD9",
				"v="+string(tc.variant)+"&t="+token, "aurora.example.com", nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s → %d", tc.url, rec.Code)
			}
			L, _ := cardLayoutFor(tc.variant)
			img := decodeCard(t, rec.Body.Bytes())
			if b := img.Bounds(); b.Dx() != L.Width || b.Dy() != L.Height {
				t.Errorf("served %dx%d, want %dx%d", b.Dx(), b.Dy(), L.Width, L.Height)
			}
			// Each crop gets its own cache entry — the variant is in the
			// filename, so square must never be served for og.
			fp := partyCardFingerprint("7K2QD9", "Jurassic World Dominion", "", "Ronnie", &sched) +
				hostCacheTag("http://aurora.example.com")
			if _, err := os.Stat(partyCardCachePath(h.cacheDir, "7K2QD9", tc.variant, fp)); err != nil {
				t.Errorf("no cache entry for this variant: %v", err)
			}
		})
	}
	if resp.Story == resp.Square || resp.Square == resp.OG {
		t.Error("two crops were minted to the same URL")
	}
}

// A party with no scheduled start is the LIVE case: the renderer needs the
// flag, and it must NOT be handed a date — printing today's would be a
// claim the party never made.
func TestBuildCardData_LiveWhenUnscheduled(t *testing.T) {
	h := newCardTestHandler(t, &fakeCardManager{}, &fakeCardQueries{})
	in := cardInputs{
		Code: "7K2QD9", MediaTitle: "Dune", HostName: "Ronnie",
		Base: "https://aurora.example.com",
	}

	live := h.buildCardData(context.Background(), in)
	if !live.Live {
		t.Error("unscheduled party did not set Live")
	}
	if live.DateCaps != "" || live.TimeText != "" {
		t.Errorf("unscheduled party carries a schedule: %q / %q", live.DateCaps, live.TimeText)
	}

	sched := time.Date(2026, 8, 15, 20, 0, 0, 0, time.UTC)
	in.Scheduled = &sched
	booked := h.buildCardData(context.Background(), in)
	if booked.Live {
		t.Error("a scheduled party was marked Live")
	}
	if booked.DateCaps == "" || booked.TimeText == "" {
		t.Errorf("scheduled party has no date/time: %q / %q", booked.DateCaps, booked.TimeText)
	}
}

// End to end: an unscheduled party is served, not 404ed, on every crop.
func TestServeCardPNG_UnscheduledPartyRendersLive(t *testing.T) {
	mgr := &fakeCardManager{states: map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, nil),
	}}
	h := newCardTestHandler(t, mgr, &fakeCardQueries{
		profile: &models.MemberProfile{UserID: 7, Username: "ronnie", DisplayName: "Ronnie"},
	})
	for _, v := range []CardVariant{CardVariantStory, CardVariantSquare, CardVariantOG} {
		rec := httptest.NewRecorder()
		h.ServeCardPNG(rec, cardRequest("7K2QD9",
			"v="+string(v)+"&t="+h.cardToken("7K2QD9"), "aurora.example.com", nil))
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", v, rec.Code)
			continue
		}
		if isFlatImage(decodeCard(t, rec.Body.Bytes())) {
			t.Errorf("%s: live card is a single flat colour", v)
		}
	}
}

// A forged Host header must never be embedded in a minted URL (or, on the
// image route, in the QR payload). Same defence as party_qr.go.
func TestCardLinks_RejectsUnsafeHost(t *testing.T) {
	sched := time.Date(2026, 8, 15, 20, 0, 0, 0, time.UTC)
	mgr := &fakeCardManager{states: map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, &sched),
	}}
	h := newCardTestHandler(t, mgr, &fakeCardQueries{})
	for _, host := range []string{"evil.com/x?", "a\x00b", "host name", "a/b"} {
		rec := httptest.NewRecorder()
		h.CardLinks(rec, cardRequest("7K2QD9", "", host,
			&auth.JWTClaims{UserID: 7, Username: "u", Role: "user"}))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("host %q: status = %d, want 400", host, rec.Code)
		}
	}
}

// ── Only the host appears ───────────────────────────────────────────

// A party is other people's plans too. No invitee or participant name may
// reach the card, in any field — the roster is private at the API and the
// image must not become a side channel around that.
func TestBuildCardData_CarriesNoInviteeNames(t *testing.T) {
	sched := time.Date(2026, 8, 15, 20, 0, 0, 0, time.UTC)
	ps := cardTestParty("7K2QD9", 7, &sched)
	ps.Participants = map[int64]*watchparty.Participant{
		7: {UserID: 7, Username: "ronnie"},
		8: {UserID: 8, Username: "MiaTheInvitee"},
		9: {UserID: 9, Username: "DevTheInvitee"},
	}
	ps.PartyName = "MiaTheInvitee and friends"

	h := newCardTestHandler(t, &fakeCardManager{states: map[string]*watchparty.PartyState{"7K2QD9": ps}},
		&fakeCardQueries{
			profile: &models.MemberProfile{UserID: 7, Username: "ronnie", DisplayName: "Ronnie"},
			item:    &models.MediaItem{ID: 42, Year: 2022, RuntimeMin: 147},
			genres:  []string{"Action", "Adventure"},
		})

	d := h.buildCardData(context.Background(), cardInputs{
		Code:        "7K2QD9",
		MediaItemID: 42,
		MediaTitle:  ps.MediaTitle,
		Scheduled:   &sched,
		HostName:    "Ronnie",
		Base:        "https://aurora.example.com",
	})

	fields := []string{d.Code, d.MediaTitle, d.MetaLine, d.DateCaps, d.TimeText,
		d.HostName, d.HostInitial, d.Tagline, d.JoinLabel, d.JoinURL}
	for _, forbidden := range []string{"MiaTheInvitee", "DevTheInvitee"} {
		for _, f := range fields {
			if strings.Contains(f, forbidden) {
				t.Errorf("card data leaked %q via %q", forbidden, f)
			}
		}
	}
	if d.HostName != "Ronnie" {
		t.Errorf("host name = %q, want Ronnie", d.HostName)
	}
	if d.MetaLine != "2022 · Action Adventure · 2h 27m" {
		t.Errorf("meta line = %q", d.MetaLine)
	}
}

// A non-TMDB avatar reference (a built-in nebula id, or anything the
// member boundary blanked) must never be fetched.
func TestFetchAvatarImage_OnlyTMDB(t *testing.T) {
	h := newCardTestHandler(t, &fakeCardManager{}, &fakeCardQueries{})
	for _, v := range []string{"", "nebula:aurora-3", "https://evil.example.com/a.jpg", "/local/a.jpg"} {
		if got := h.fetchAvatarImage(v); got != nil {
			t.Errorf("fetchAvatarImage(%q) returned an image; want nil", v)
		}
	}
}

func TestHostIdentity_FallsBackToUsernameAndFiltersAvatar(t *testing.T) {
	h := newCardTestHandler(t, &fakeCardManager{}, &fakeCardQueries{
		profile: &models.MemberProfile{
			UserID: 7, Username: "ronnie", DisplayName: "   ",
			AvatarURL: "https://evil.example.com/tracking.png",
		},
	})
	name, avatar := h.hostIdentity(context.Background(), 7)
	if name != "ronnie" {
		t.Errorf("name = %q, want the username fallback", name)
	}
	if avatar != "" {
		t.Errorf("avatar = %q; memberSafeAvatar must blank a foreign host", avatar)
	}
}

// ── Poster fetch stays inside the SSRF boundary ─────────────────────

func TestIsShareImageHostAllowed(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"https://image.tmdb.org/t/p/w780/a.jpg", true},
		{"https://IMAGE.TMDB.ORG/t/p/w780/a.jpg", true},
		{"https://artworks.thetvdb.com/banners/a.jpg", true},
		{"https://evil.example.com/a.jpg", false},
		{"https://image.tmdb.org.evil.example.com/a.jpg", false},
		{"https://evil.example.com/image.tmdb.org/a.jpg", false},
		// userinfo must not be mistaken for the host
		{"https://image.tmdb.org@evil.example.com/a.jpg", false},
		{"http://169.254.169.254/latest/meta-data/", false},
		{"file:///etc/passwd", false},
		{"gopher://image.tmdb.org/", false},
		{":://nonsense", false},
	}
	for _, tc := range cases {
		if got := isShareImageHostAllowed(tc.url); got != tc.want {
			t.Errorf("isShareImageHostAllowed(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

func TestFetchPosterImage_RejectsNonAllowlistedURL(t *testing.T) {
	h := newCardTestHandler(t, &fakeCardManager{}, &fakeCardQueries{})
	if _, err := h.fetchPosterImage("https://evil.example.com/poster.jpg"); err == nil {
		t.Fatal("expected an allowlist rejection")
	}
}

// The prefix check alone is not enough: an allowlisted host that 302s to
// internal infrastructure is the whole SSRF gadget. CheckRedirect has to
// re-validate every hop. Temporarily allowlisting the loopback test
// server is the only way to reach that code path.
func TestFetchPosterImage_RejectsRedirectOffAllowlist(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	}))
	defer srv.Close()

	shareAllowedImageHosts["127.0.0.1"] = true
	t.Cleanup(func() { delete(shareAllowedImageHosts, "127.0.0.1") })

	h := newCardTestHandler(t, &fakeCardManager{}, &fakeCardQueries{})
	_, err := h.fetchPosterImage(srv.URL + "/poster.jpg")
	if err == nil {
		t.Fatal("redirect to a disallowed host was followed")
	}
	if !strings.Contains(err.Error(), "disallowed host") {
		t.Errorf("error = %v; want the redirect allowlist rejection", err)
	}
}

// ── Rune-safe truncation ────────────────────────────────────────────

// Byte-slicing multi-byte UTF-8 leaves a partial codepoint at the
// boundary, which the rasteriser paints as a tofu box. Both the card's
// truncateToWidth and the legacy drawCenteredText iterate over runes.
func TestTruncateToWidth_RuneSafe(t *testing.T) {
	lib, err := cardFonts()
	if err != nil {
		t.Fatalf("fonts: %v", err)
	}
	fs, err := lib.face(roleDisplayExtraBold, 74)
	if err != nil {
		t.Fatalf("face: %v", err)
	}
	inputs := []string{
		"Frédéric Chopin — Ünïcödé Tëst À Très Long Titre Qui Déborde Vraiment Beaucoup",
		"Æthelred the Unready’s Extremely Long Chronicle of Œuvres and Ærial Œdemas",
		"ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ",
	}
	for _, in := range inputs {
		for _, maxW := range []int{920, 400, 120, 40, 10} {
			got := truncateToWidth(fs, in, em(-0.03, 74), maxW)
			if !utf8.ValidString(got) {
				t.Fatalf("truncateToWidth(%q, %d) produced invalid UTF-8: %q", in, maxW, got)
			}
			if strings.ContainsRune(got, utf8.RuneError) {
				t.Fatalf("truncateToWidth(%q, %d) produced U+FFFD: %q", in, maxW, got)
			}
			if got != in && !strings.HasSuffix(got, "…") {
				t.Errorf("truncated result %q lacks an ellipsis", got)
			}
		}
	}
	// A run that already fits is returned untouched.
	if got := truncateToWidth(fs, "Dune", 0, 920); got != "Dune" {
		t.Errorf("short run was modified: %q", got)
	}
}

// The legacy renderer's contract still holds; a multi-byte overflow must
// draw, not panic, and must put ink on the canvas.
func TestDrawCenteredText_MultiByteDoesNotPanic(t *testing.T) {
	h := &PartyShareHandler{}
	if err := h.initFonts(); err != nil {
		t.Fatalf("init fonts: %v", err)
	}
	img := newTestRGBA(shareImgWidth, 200)
	h.drawCenteredText(img, strings.Repeat("Frédéric Chopin ", 20), 100, h.titleFace,
		hexRGBA(0xFFFFFF, 1))
	if isFlatImage(img) {
		t.Error("drawCenteredText drew nothing")
	}
}

// ── Compositor smoke ────────────────────────────────────────────────

func TestComposeCard_StorySmoke(t *testing.T) {
	d := cardData{
		Code: "7K2QD9", MediaTitle: "Jurassic World Dominion",
		MetaLine: "2022 · Action Adventure · 2h 27m",
		DateCaps: "Saturday, August 15", TimeText: "8:00 PM EDT",
		HostName: "Ronnie", HostInitial: "R", Tagline: cardTagline,
		JoinLabel: "Join at aurora.example.com",
		JoinURL:   "https://aurora.example.com/join/7K2QD9",
		Seed:      cardSeed("7K2QD9"),
	}
	raw, err := composeCard(CardVariantStory, d)
	if err != nil {
		t.Fatalf("composeCard: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("not a PNG: %v", err)
	}
	if b := img.Bounds(); b.Dx() != 1080 || b.Dy() != 1920 {
		t.Errorf("size = %dx%d, want 1080x1920", b.Dx(), b.Dy())
	}
	if isFlatImage(img) {
		t.Error("rendered card is a single flat colour")
	}

	// Deterministic: the disk cache can be dropped at any time, and two
	// renders of the same party must not differ.
	again, err := composeCard(CardVariantStory, d)
	if err != nil {
		t.Fatalf("second composeCard: %v", err)
	}
	if !bytes.Equal(raw, again) {
		t.Error("composeCard is not deterministic for identical input")
	}

	// Different party, different sky.
	d2 := d
	d2.Code, d2.Seed = "QX48TM", cardSeed("QX48TM")
	other, err := composeCard(CardVariantStory, d2)
	if err != nil {
		t.Fatalf("third composeCard: %v", err)
	}
	if bytes.Equal(raw, other) {
		t.Error("two parties rendered byte-identical cards")
	}
}

// An unscheduled party renders rather than 404ing: the schedule slot
// carries LIVE NOW instead of a date and a clock time. One code path for
// both cases, as the plan's eligibility rule requires.
func TestComposeCard_NoScheduleStillRenders(t *testing.T) {
	d := cardData{
		Code: "7K2QD9", MediaTitle: "Dune", HostName: "Ronnie", HostInitial: "R",
		Live: true, Tagline: cardTagline, JoinLabel: "Join at aurora.example.com",
		JoinURL: "https://aurora.example.com/join/7K2QD9", Seed: 1,
	}
	raw, err := composeCard(CardVariantStory, d)
	if err != nil {
		t.Fatalf("composeCard: %v", err)
	}
	if img, err := png.Decode(bytes.NewReader(raw)); err != nil {
		t.Fatalf("not a PNG: %v", err)
	} else if img.Bounds().Dy() != 1920 {
		t.Errorf("height = %d", img.Bounds().Dy())
	}
}

// A variant string the compositor does not know must not silently render
// as story — the image route turns the miss into a 404 instead.
func TestComposeCard_UnknownVariantErrors(t *testing.T) {
	for _, v := range []CardVariant{"", "STORY", "Square", "banner", "og.png"} {
		if _, err := composeCard(v, cardData{Code: "7K2QD9", MediaTitle: "Dune"}); err == nil {
			t.Errorf("composeCard(%q) succeeded; want an error", v)
		}
	}
}

// A title long enough to wrap must still leave the CTA on the card.
func TestComposeCard_LongTitleKeepsJoinBarOnCard(t *testing.T) {
	d := cardData{
		Code:       "7K2QD9",
		MediaTitle: "The Lord of the Rings: The Fellowship of the Ring Extended Edition",
		MetaLine:   "2001 · Adventure Fantasy · 3h 48m",
		DateCaps:   "Saturday, August 15", TimeText: "8:00 PM EDT",
		HostName: "Ronnie", HostInitial: "R", Tagline: cardTagline,
		JoinLabel: "Join at aurora.example.com",
		JoinURL:   "https://aurora.example.com/join/7K2QD9", Seed: 3,
	}
	raw, err := composeCard(CardVariantStory, d)
	if err != nil {
		t.Fatalf("composeCard: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("not a PNG: %v", err)
	}
	// The join bar is a light panel spanning the content width; the last
	// row of the card must be background, not a clipped CTA.
	if rowMean(img, storyLayout.Height-4) > rowMean(img, storyLayout.Height-40) {
		t.Error("join bar appears to run off the bottom edge")
	}
}

// ── The reflowed crops: square + og ─────────────────────────────────

// sampleCardData is the mockup's own content, which is what the layout
// tables were transcribed against.
func sampleCardData() cardData {
	return cardData{
		Code: "7K2QD9", MediaTitle: "Jurassic World Dominion",
		MetaLine: "2022 · Action Adventure · 2h 27m",
		DateCaps: "Saturday, August 15", TimeText: "8:00 PM EDT",
		HostName: "Ronnie", HostInitial: "R", Tagline: cardTagline,
		JoinLabel: "Join at aurorapro.app",
		JoinURL:   "https://aurorapro.app/join/7K2QD9",
		Seed:      cardSeed("7K2QD9"),
	}
}

func decodeCard(t *testing.T, raw []byte) image.Image {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("not a PNG: %v", err)
	}
	return img
}

// Each crop decodes at its declared size, actually draws something, and
// renders byte-identically on a re-run — the disk cache can be dropped at
// any moment, so two renders of one party must not differ.
func TestComposeCard_EveryVariantSmoke(t *testing.T) {
	for _, v := range []CardVariant{CardVariantStory, CardVariantSquare, CardVariantOG} {
		t.Run(string(v), func(t *testing.T) {
			L, ok := cardLayoutFor(v)
			if !ok {
				t.Fatalf("no layout for %q", v)
			}
			d := sampleCardData()
			raw, err := composeCard(v, d)
			if err != nil {
				t.Fatalf("composeCard: %v", err)
			}
			img := decodeCard(t, raw)
			if b := img.Bounds(); b.Dx() != L.Width || b.Dy() != L.Height {
				t.Errorf("size = %dx%d, want %dx%d", b.Dx(), b.Dy(), L.Width, L.Height)
			}
			if isFlatImage(img) {
				t.Error("rendered card is a single flat colour")
			}
			again, err := composeCard(v, d)
			if err != nil {
				t.Fatalf("second composeCard: %v", err)
			}
			if !bytes.Equal(raw, again) {
				t.Error("composeCard is not deterministic for identical input")
			}
			// Different party, different sky.
			d2 := d
			d2.Code, d2.Seed = "QX48TM", cardSeed("QX48TM")
			other, err := composeCard(v, d2)
			if err != nil {
				t.Fatalf("third composeCard: %v", err)
			}
			if bytes.Equal(raw, other) {
				t.Error("two parties rendered byte-identical cards")
			}
		})
	}
}

// The three crops are three compositions, not one image at three sizes.
func TestComposeCard_VariantsAreDistinct(t *testing.T) {
	seen := map[string]CardVariant{}
	for _, v := range []CardVariant{CardVariantStory, CardVariantSquare, CardVariantOG} {
		raw, err := composeCard(v, sampleCardData())
		if err != nil {
			t.Fatalf("composeCard(%q): %v", v, err)
		}
		key := string(raw)
		if prev, dup := seen[key]; dup {
			t.Errorf("%q rendered byte-identically to %q", v, prev)
		}
		seen[key] = v
	}
}

// The reflow is the whole point of these two crops: the poster takes the
// left, and every line of type sets flush left in the column beside it.
//
// Rendered WITHOUT key art on purpose — with the poster plate empty, any
// bright pixel left of the column is type that escaped, and the assertion
// is about where the type went rather than what the artwork looks like.
func TestComposeCard_SideBySidePutsAllTypeBesideThePoster(t *testing.T) {
	live := sampleCardData()
	live.DateCaps, live.TimeText, live.Live = "", "", true

	for _, v := range []CardVariant{CardVariantSquare, CardVariantOG} {
		for _, tc := range []struct {
			name string
			d    cardData
		}{{"scheduled", sampleCardData()}, {"live", live}} {
			t.Run(string(v)+"/"+tc.name, func(t *testing.T) {
				L, _ := cardLayoutFor(v)
				colX := L.PadX + L.PosterW + L.ContentGap
				raw, err := composeCard(v, tc.d)
				if err != nil {
					t.Fatalf("composeCard: %v", err)
				}
				img := decodeCard(t, raw)

				// Type is set at or near full white; the curtain, the poster
				// plate and the brightest starfield speck all stay well under.
				const typeLevel = 0.85 * 65535
				if got := maxLuma(img, image.Rect(0, 0, colX-4, L.Height)); got >= typeLevel {
					t.Errorf("type appears left of the column (max luma %.0f at x<%d)", got, colX-4)
				}
				if got := maxLuma(img, image.Rect(colX, 0, L.Width, L.Height)); got < typeLevel {
					t.Errorf("no type found in the text column (max luma %.0f)", got)
				}
				// And the poster plate really is drawn on the left: its centre
				// must differ from the ground beside it.
				mid := L.PadTop + (L.Height-L.PadTop-L.PadBottom)/2
				if sameColour(img.At(L.PadX+L.PosterW/2, mid), img.At(L.Width-2, mid)) {
					t.Error("poster plate is missing from the left column")
				}
			})
		}
	}
}

// The CTA must not slide off the bottom edge, on any crop, at content the
// design was drawn for or well past it. Same shape of assertion as the
// story's: the last scanline has to be quieter than the CTA's own.
func TestComposeCard_CTAStaysOnTheCard(t *testing.T) {
	long := sampleCardData()
	long.MediaTitle = "Everything Everywhere All at Once: The Extended Multiverse Director's Cut"
	long.HostName = "Bartholomew Featherstonehaugh-Wellington III"
	long.MetaLine = "2022 · Action Adventure Science Fiction Comedy Drama · 2h 59m"
	live := sampleCardData()
	live.DateCaps, live.TimeText, live.Live = "", "", true

	for _, v := range []CardVariant{CardVariantStory, CardVariantSquare, CardVariantOG} {
		for _, tc := range []struct {
			name string
			d    cardData
		}{{"designed", sampleCardData()}, {"overlong", long}, {"live", live}} {
			t.Run(string(v)+"/"+tc.name, func(t *testing.T) {
				L, _ := cardLayoutFor(v)
				raw, err := composeCard(v, tc.d)
				if err != nil {
					t.Fatalf("composeCard: %v", err)
				}
				img := decodeCard(t, raw)
				ctaH := L.JoinH
				if ctaH == 0 {
					ctaH = 2 * L.ChipPadY // the og crop's pill
				}
				if rowMean(img, L.Height-4) > rowMean(img, L.Height-L.PadBottom-ctaH/2) {
					t.Error("the CTA appears to run off the bottom edge")
				}
			})
		}
	}
}

// LIVE NOW occupies the schedule slot: one row, taking the DATE row's
// leading margin (it replaces the whole date+time block, not just the
// time) and set at the TIME's size in the TIME's face.
//
// Asserted on the flow rather than on pixels, because the flow is where
// the contract lives — a shorter column legitimately re-centres the whole
// composition, so a pixel diff between a live and a scheduled card spans
// every row and proves nothing.
func TestCardColumn_LiveNowTakesTheScheduleSlot(t *testing.T) {
	lib, err := cardFonts()
	if err != nil {
		t.Fatalf("cardFonts: %v", err)
	}
	for _, v := range []CardVariant{CardVariantStory, CardVariantSquare, CardVariantOG} {
		t.Run(string(v), func(t *testing.T) {
			L, _ := cardLayoutFor(v)
			dst := image.NewRGBA(image.Rect(0, 0, L.Width, L.Height))
			colW := L.Width - 2*L.PadX
			schedule := func(d cardData) []cardBlock {
				c := newCardColumn(dst, L, lib, d, L.PadX, colW, L.ContentGap == 0)
				if err := c.addSchedule(); err != nil {
					t.Fatalf("addSchedule: %v", err)
				}
				return c.blocks
			}

			live := sampleCardData()
			live.DateCaps, live.TimeText, live.Live = "", "", true
			liveBlocks := schedule(live)
			if len(liveBlocks) != 1 {
				t.Fatalf("live schedule produced %d rows, want 1", len(liveBlocks))
			}
			if got := liveBlocks[0].marginTop; got != L.DateMarginTop {
				t.Errorf("live row margin-top = %d, want the date row's %d", got, L.DateMarginTop)
			}

			// Same label pushed through the TIME row proves the live row is
			// set in the time's face at the time's size: identical height.
			asTime := sampleCardData()
			asTime.DateCaps, asTime.TimeText = "", cardLiveLabel
			timeBlocks := schedule(asTime)
			if len(timeBlocks) != 1 {
				t.Fatalf("time-only schedule produced %d rows, want 1", len(timeBlocks))
			}
			if liveBlocks[0].height != timeBlocks[0].height {
				t.Errorf("live row is %dpx tall, the time row is %dpx — different face or size",
					liveBlocks[0].height, timeBlocks[0].height)
			}
			if liveBlocks[0].height <= 0 {
				t.Error("live row has no height")
			}

			// A scheduled party still gets both rows, in order.
			booked := schedule(sampleCardData())
			if len(booked) != 2 {
				t.Fatalf("scheduled party produced %d rows, want date + time", len(booked))
			}
			if booked[0].marginTop != L.DateMarginTop || booked[1].marginTop != L.TimeMarginTop {
				t.Errorf("scheduled margins = %d/%d, want %d/%d",
					booked[0].marginTop, booked[1].marginTop, L.DateMarginTop, L.TimeMarginTop)
			}
		})
	}
}

// And end to end: the live treatment is really drawn — a card with the
// flag set differs from one whose schedule fields are simply blank, on
// every crop.
func TestComposeCard_LiveNowIsDrawn(t *testing.T) {
	for _, v := range []CardVariant{CardVariantStory, CardVariantSquare, CardVariantOG} {
		t.Run(string(v), func(t *testing.T) {
			blank := sampleCardData()
			blank.DateCaps, blank.TimeText = "", ""
			live := blank
			live.Live = true

			blankRaw, err := composeCard(v, blank)
			if err != nil {
				t.Fatalf("composeCard(blank): %v", err)
			}
			liveRaw, err := composeCard(v, live)
			if err != nil {
				t.Fatalf("composeCard(live): %v", err)
			}
			if bytes.Equal(blankRaw, liveRaw) {
				t.Error("an unscheduled party rendered no LIVE NOW treatment")
			}
			booked, err := composeCard(v, sampleCardData())
			if err != nil {
				t.Fatalf("composeCard(scheduled): %v", err)
			}
			if bytes.Equal(booked, liveRaw) {
				t.Error("the live card is indistinguishable from a scheduled one")
			}
			if isFlatImage(decodeCard(t, liveRaw)) {
				t.Error("live card is a single flat colour")
			}
		})
	}
}

// The layout tables ARE the spec (each is a transcription of one `.card-*`
// block), so the arithmetic they have to satisfy is worth pinning: the
// declared crop sizes, and enough room for both columns.
func TestCardLayouts_GeometryHolds(t *testing.T) {
	cases := []struct {
		v             CardVariant
		width, height int
	}{
		{CardVariantStory, 1080, 1920},
		{CardVariantSquare, 1080, 1080},
		{CardVariantOG, 1200, 630},
	}
	for _, tc := range cases {
		t.Run(string(tc.v), func(t *testing.T) {
			L, ok := cardLayoutFor(tc.v)
			if !ok {
				t.Fatalf("no layout registered for %q", tc.v)
			}
			if L.Variant != tc.v {
				t.Errorf("layout self-identifies as %q", L.Variant)
			}
			if L.Width != tc.width || L.Height != tc.height {
				t.Errorf("crop = %dx%d, want %dx%d", L.Width, L.Height, tc.width, tc.height)
			}
			if L.PosterH+L.PadTop+L.PadBottom > L.Height {
				t.Errorf("poster (%d) does not fit between the vertical padding", L.PosterH)
			}
			if L.ContentGap == 0 {
				return // story stacks; the checks below are for the reflow
			}
			colW := L.Width - 2*L.PadX - L.PosterW - L.ContentGap
			if colW <= 0 {
				t.Fatalf("text column has width %d", colW)
			}
			// A join bar has to hold its own text beside the QR; a code
			// chip has to be narrower than the column it sets in.
			if L.JoinH > 0 && colW <= 2*L.JoinPadX+L.QRSize+L.JoinTextGap {
				t.Errorf("join bar leaves no room for the code beside the QR")
			}
			if L.JoinH == 0 && L.ChipLabelSize <= 0 {
				t.Error("crop has neither a join bar nor a code chip — no CTA")
			}
		})
	}
}

// maxLuma is the brightest pixel mean inside r.
func maxLuma(img image.Image, r image.Rectangle) float64 {
	r = r.Intersect(img.Bounds())
	var max float64
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			cr, cg, cb, _ := img.At(x, y).RGBA()
			if v := float64(cr+cg+cb) / 3; v > max {
				max = v
			}
		}
	}
	return max
}

func sameColour(a, b color.Color) bool {
	r1, g1, b1, a1 := a.RGBA()
	r2, g2, b2, a2 := b.RGBA()
	return r1 == r2 && g1 == g2 && b1 == b2 && a1 == a2
}

// ── Cache invalidation + reaper ─────────────────────────────────────

func TestInvalidateCache_GlobsEveryVariantAndFingerprint(t *testing.T) {
	h := newCardTestHandler(t, &fakeCardManager{}, &fakeCardQueries{})
	cardDir := filepath.Join(h.cacheDir, partyCardCacheSubdir)
	if err := os.MkdirAll(cardDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(h.cacheDir, "party-share"), 0o755); err != nil {
		t.Fatal(err)
	}
	mine := []string{"7K2QD9-story-aaaaaaaa.png", "7K2QD9-story-bbbbbbbb.png", "7K2QD9-square-cccccccc.png"}
	theirs := []string{"QX48TM-story-dddddddd.png"}
	for _, n := range append(append([]string{}, mine...), theirs...) {
		if err := os.WriteFile(filepath.Join(cardDir, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	legacy := h.cachePath("7K2QD9")
	if err := os.WriteFile(legacy, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	h.InvalidateCache("7K2QD9")

	for _, n := range mine {
		if _, err := os.Stat(filepath.Join(cardDir, n)); !os.IsNotExist(err) {
			t.Errorf("%s survived invalidation", n)
		}
	}
	for _, n := range theirs {
		if _, err := os.Stat(filepath.Join(cardDir, n)); err != nil {
			t.Errorf("%s (another party) was deleted: %v", n, err)
		}
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Error("legacy share image survived invalidation")
	}
}

// The glob pattern is built from the code, so a non-canonical code must
// never reach filepath.Glob.
func TestInvalidateCache_RefusesNonCanonicalCode(t *testing.T) {
	h := newCardTestHandler(t, &fakeCardManager{}, &fakeCardQueries{})
	cardDir := filepath.Join(h.cacheDir, partyCardCacheSubdir)
	if err := os.MkdirAll(cardDir, 0o755); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(cardDir, "7K2QD9-story-aaaaaaaa.png")
	if err := os.WriteFile(keep, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"*", "../*", "7K2QD", "7K2QD9X", ""} {
		h.InvalidateCache(bad)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Errorf("a wildcard code deleted real cache entries: %v", err)
	}
}

func TestReapOnce_SweepsBothNamespaces(t *testing.T) {
	h := newCardTestHandler(t, &fakeCardManager{}, &fakeCardQueries{})
	old := time.Now().Add(-2 * partyShareCacheMaxAge)
	mk := func(sub, name string, mod time.Time) string {
		dir := filepath.Join(h.cacheDir, sub)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, mod, mod); err != nil {
			t.Fatal(err)
		}
		return p
	}
	staleCard := mk(partyCardCacheSubdir, "7K2QD9-story-aaaaaaaa.png", old)
	freshCard := mk(partyCardCacheSubdir, "QX48TM-story-bbbbbbbb.png", time.Now())
	staleShare := mk("party-share", "7K2QD9.png", old)

	h.reapOnce()

	for _, p := range []string{staleCard, staleShare} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s was not reaped", filepath.Base(p))
		}
	}
	if _, err := os.Stat(freshCard); err != nil {
		t.Errorf("fresh card was reaped: %v", err)
	}
}

// ── Misc helpers ────────────────────────────────────────────────────

func TestFormatRuntime(t *testing.T) {
	cases := map[int]string{0: "0m", 47: "47m", 60: "1h", 62: "1h 2m", 147: "2h 27m", 228: "3h 48m"}
	for in, want := range cases {
		if got := formatRuntime(in); got != want {
			t.Errorf("formatRuntime(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestFirstInitial(t *testing.T) {
	cases := map[string]string{"Ronnie": "R", "  mia": "M", "Émile": "É", "": "", "  ": "", "9lives": "9"}
	for in, want := range cases {
		if got := firstInitial(in); got != want {
			t.Errorf("firstInitial(%q) = %q, want %q", in, got, want)
		}
	}
}

// newTestRGBA builds a black canvas for the ink assertions above.
func newTestRGBA(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(img, img.Bounds(), &image.Uniform{C: hexRGBA(0x000000, 1)}, image.Point{}, draw.Src)
	return img
}

// isFlatImage reports whether every pixel is the same colour — the "did
// the compositor actually draw anything" check the plan asks for.
func isFlatImage(img image.Image) bool {
	b := img.Bounds()
	r0, g0, b0, _ := img.At(b.Min.X, b.Min.Y).RGBA()
	for y := b.Min.Y; y < b.Max.Y; y += 7 {
		for x := b.Min.X; x < b.Max.X; x += 7 {
			r, g, bb, _ := img.At(x, y).RGBA()
			if r != r0 || g != g0 || bb != b0 {
				return false
			}
		}
	}
	return true
}

// rowMean is the average luminance of one scanline.
func rowMean(img image.Image, y int) float64 {
	b := img.Bounds()
	if y < b.Min.Y || y >= b.Max.Y {
		return 0
	}
	var sum float64
	for x := b.Min.X; x < b.Max.X; x++ {
		r, g, bb, _ := img.At(x, y).RGBA()
		sum += float64(r+g+bb) / 3
	}
	return sum / float64(b.Dx())
}

// The card embeds the request authority (QR payload, "Join at …"), so a
// second origin must not be served the first origin's cached PNG — that
// would let anyone holding a valid tag poison the host's own card with a
// QR pointing somewhere else.
func TestServeCardPNG_CacheIsPerOrigin(t *testing.T) {
	sched := time.Date(2026, 8, 15, 20, 0, 0, 0, time.UTC)
	mgr := &fakeCardManager{states: map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, &sched),
	}}
	h := newCardTestHandler(t, mgr, &fakeCardQueries{
		profile: &models.MemberProfile{UserID: 7, Username: "ronnie", DisplayName: "Ronnie"},
	})
	tok := h.cardToken("7K2QD9")

	get := func(host string) []byte {
		rec := httptest.NewRecorder()
		h.ServeCardPNG(rec, cardRequest("7K2QD9", "v=story&t="+tok, host, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("host %q: status %d", host, rec.Code)
		}
		return rec.Body.Bytes()
	}
	a := get("aurora.example.com")
	b := get("elsewhere.example")
	if bytes.Equal(a, b) {
		t.Error("a second Host was served the first Host's cached card")
	}
	// And the first origin still gets its own image back.
	if !bytes.Equal(a, get("aurora.example.com")) {
		t.Error("the original origin's cache entry was clobbered")
	}
	if hostCacheTag("http://a.example") == hostCacheTag("http://b.example") {
		t.Error("hostCacheTag collides for distinct origins")
	}
}

// A forged Host must be rejected identically whether or not the code
// names a real party — otherwise the 400/404 split is an existence
// oracle for anyone who has a tag-shaped string to try.
func TestServeCardPNG_UnsafeHostDoesNotLeakExistence(t *testing.T) {
	sched := time.Date(2026, 8, 15, 20, 0, 0, 0, time.UTC)
	mgr := &fakeCardManager{states: map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, &sched),
	}}
	h := newCardTestHandler(t, mgr, &fakeCardQueries{
		profile: &models.MemberProfile{UserID: 7, Username: "ronnie", DisplayName: "Ronnie"},
	})
	real := httptest.NewRecorder()
	h.ServeCardPNG(real, cardRequest("7K2QD9", "v=story&t="+h.cardToken("7K2QD9"), "evil.com/x?", nil))
	fake := httptest.NewRecorder()
	h.ServeCardPNG(fake, cardRequest("QX48TM", "v=story&t="+h.cardToken("QX48TM"), "evil.com/x?", nil))
	if real.Code != fake.Code || real.Body.String() != fake.Body.String() {
		t.Errorf("existing party answered %d/%q, missing party %d/%q",
			real.Code, real.Body.String(), fake.Code, fake.Body.String())
	}
}

// The join QR has to be readable by an ordinary scanner. Rendering it as
// the mockup literally specifies — white modules, no quiet zone, on the
// dark panel — produced a symbol the ZXing/OpenCV lineage refuses, so the
// renderer plates it. Guard the plate: the QR's own footprint must be
// dark-on-light.
//
// The square's bar carries the same symbol at 74px with a 6px quiet zone,
// so the plating has to survive the smaller footprint too — that crop is
// where a borderless symbol would fail first.
func TestDrawJoinQR_IsDarkOnLight(t *testing.T) {
	for _, L := range []*cardLayout{&storyLayout, &squareLayout} {
		t.Run(string(L.Variant), func(t *testing.T) {
			if L.QRSize == 0 {
				t.Skip("crop has no QR")
			}
			img := image.NewRGBA(image.Rect(0, 0, L.QRSize, L.QRSize))
			draw.Draw(img, img.Bounds(), &image.Uniform{C: hexRGBA(tokenInk, 1)}, image.Point{}, draw.Src)
			if err := drawJoinQR(img, L, "https://aurora.example.com/join/7K2QD9", 0, 0); err != nil {
				t.Fatalf("drawJoinQR: %v", err)
			}
			// The plate's interior mean must be light; a light-on-dark
			// symbol would sit well under half.
			if mean := rowMean(img, L.QRSize/2); mean < 0.5*65535 {
				t.Errorf("QR row mean = %.0f of 65535; the symbol is not on a light plate", mean)
			}
			// The quiet-zone corner must be plate, not module.
			r, g, b, _ := img.At(2, L.QRSize/2).RGBA()
			if float64(r+g+b)/3 < 0.7*65535 {
				t.Error("no quiet zone inside the plate")
			}
			// A quiet zone that swallowed the symbol is not a QR: some of
			// the plate has to be dark modules.
			if maxLuma(img, image.Rect(0, 0, L.QRSize, L.QRSize)) == 0 {
				t.Error("nothing drawn")
			}
			if rowMean(img, L.QRSize/2) > 0.98*65535 {
				t.Error("plate carries no modules — the symbol did not render")
			}
		})
	}
}
