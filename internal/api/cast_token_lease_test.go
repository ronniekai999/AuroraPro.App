package api

// Cast lease wiring — the longer idle window is granted on the first
// cast-token-authenticated FETCH, not when the token is minted.
//
// Minting is the wrong moment: the clone exists and is leased before the
// response is written, so a response lost on the way back to a flaky phone
// leaves a 30-minute clone whose ID the client never learned and can never
// release. Two of those exhaust the per-user session cap and ordinary
// playback starts failing — the failure this whole area exists to avoid.
//
// Asserted at the handlers rather than through streaming's helpers. An
// earlier version of these tests exercised only the pure timeout helper, and
// deleting the wiring entirely left the whole suite green.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/streaming"
	"github.com/go-chi/chi/v5"
)

func leaseTestHandler(t *testing.T) (*StreamHandler, *streaming.TranscodeManager) {
	t.Helper()
	fakeFFmpegForAPITest(t)
	tm, err := streaming.NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	t.Cleanup(tm.Close)
	authSvc := auth.NewService(config.AuthConfig{
		JWTSecret:       "test-secret-that-is-at-least-32-chars-long-yes",
		CastTokenExpiry: 4 * 3600 * 1e9, // 4h
	})
	return &StreamHandler{transcode: tm, authSvc: authSvc}, tm
}

// A remux H.264 source: cast-safe enough that CloneForCast returns the
// ORIGINAL when for_airplay skips it, and clones when it doesn't — which is
// what lets one fixture drive both directions.
func leaseTestSession(t *testing.T, tm *streaming.TranscodeManager) *streaming.TranscodeSession {
	t.Helper()
	s, err := tm.CreateSession(7, "testuser", "/library/movie.mkv", 1920, 1080,
		streaming.SessionOpts{
			Remux:            true,
			RemuxAudioCopy:   true,
			SourceVideoCodec: "h264",
			AudioCodecOut:    "aac",
			AudioTrackIndex:  -1,
		})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return s
}

// castFetch drives an HLS route the way a RECEIVER does: a cast-scoped token
// bound to the session it is asking for.
func castFetch(t *testing.T, h *StreamHandler, sessionID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/stream/hls/"+sessionID+"/master.m3u8", nil)
	claims := &auth.JWTClaims{
		UserID: 7, Username: "testuser", Role: "user",
		Scope: auth.ScopeCast, SessionID: sessionID,
	}
	ctx := context.WithValue(req.Context(), auth.ClaimsContextKey, claims)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("sessionID", sessionID)
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	rr := httptest.NewRecorder()
	h.ServeMasterPlaylist(rr, req.WithContext(ctx))
	return rr
}

// Minting alone leases nothing. This is the M1 guard: if the response never
// reaches the sender, the clone must age out on the normal five-minute sweep
// rather than hold a session slot for thirty.
func TestCreateCastToken_MintAloneDoesNotLease(t *testing.T) {
	h, tm := leaseTestHandler(t)
	src := leaseTestSession(t, tm)
	claims := &auth.JWTClaims{UserID: 7, Username: "testuser", Role: "user"}

	rr := httptest.NewRecorder()
	h.CreateCastToken(rr, castTokenRequest(t, src.ID, "", claims))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}

	for _, s := range tm.ListSessions() {
		if tm.IsCastHeld(s.ID) {
			t.Errorf("session %s was leased at mint time; the lease belongs on the first receiver fetch", s.ID)
		}
	}
}

// The fix: once a receiver actually pulls from the session, it goes on the
// longer idle window — so a paused cast with a frozen (locked-phone) sender
// is not reaped five minutes later.
func TestCastFetch_LeasesTheSessionTheReceiverPulls(t *testing.T) {
	h, tm := leaseTestHandler(t)
	src := leaseTestSession(t, tm)
	claims := &auth.JWTClaims{UserID: 7, Username: "testuser", Role: "user"}

	rr := httptest.NewRecorder()
	h.CreateCastToken(rr, castTokenRequest(t, src.ID, "", claims))
	if rr.Code != http.StatusOK {
		t.Fatalf("mint: status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var resp struct{ Playlist string }
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// This source clones, so the receiver's session is NOT the original —
	// which is the point: the clone is what the TV fetches and what must be
	// leased.
	castID := castSessionIDFromPlaylist(t, resp.Playlist)
	if castID == src.ID {
		t.Fatalf("precondition: expected a clone, got the original %s", src.ID)
	}

	castFetch(t, h, castID)

	if !tm.IsCastHeld(castID) {
		t.Error("the session the receiver fetched should be on the cast lease")
	}
	if tm.IsCastHeld(src.ID) {
		t.Error("the ORIGINAL session must not be leased; the receiver streams the clone")
	}
}

// The regression guard. ?for_airplay=true is NOT an "AirPlay started"
// signal: the SPA mints one during ordinary native-HLS setup for EVERY
// Safari/iOS playback, AirPlay or not. That must not lease the local session
// — a live browser is pinging keepalive for it, which is what the normal
// window is sized for, and abandoned tabs are most common on that platform.
func TestCreateCastToken_ForAirplayDoesNotLeaseTheLocalSession(t *testing.T) {
	h, tm := leaseTestHandler(t)
	src := leaseTestSession(t, tm)
	claims := &auth.JWTClaims{UserID: 7, Username: "testuser", Role: "user"}

	rr := httptest.NewRecorder()
	h.CreateCastToken(rr, castTokenRequest(t, src.ID, "for_airplay=true", claims))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}

	if tm.IsCastHeld(src.ID) {
		t.Error("an ordinary Safari/iOS native-HLS session must not get the cast lease")
	}
	for _, s := range tm.ListSessions() {
		if tm.IsCastHeld(s.ID) {
			t.Errorf("for_airplay=true leased session %s; it should lease nothing", s.ID)
		}
	}
}

// …but a real Apple TV pulling that same session with the cast token does
// earn the lease. The AirPlay gap the previous round documented is closed by
// moving the grant to fetch time: the signal is the fetch itself.
func TestCastFetch_LeasesAnAirplaySessionOnceAReceiverPulls(t *testing.T) {
	h, tm := leaseTestHandler(t)
	src := leaseTestSession(t, tm)
	claims := &auth.JWTClaims{UserID: 7, Username: "testuser", Role: "user"}

	rr := httptest.NewRecorder()
	h.CreateCastToken(rr, castTokenRequest(t, src.ID, "for_airplay=true", claims))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if tm.IsCastHeld(src.ID) {
		t.Fatal("precondition: minting must not lease")
	}

	castFetch(t, h, src.ID)

	if !tm.IsCastHeld(src.ID) {
		t.Error("an Apple TV pulling the session with a cast token should earn the lease")
	}
}

func castSessionIDFromPlaylist(t *testing.T, playlist string) string {
	t.Helper()
	const prefix = "/api/stream/hls/"
	rest, ok := strings.CutPrefix(playlist, prefix)
	if !ok {
		t.Fatalf("unexpected playlist URL %q", playlist)
	}
	id, _, ok := strings.Cut(rest, "/")
	if !ok || id == "" {
		t.Fatalf("no session ID in playlist URL %q", playlist)
	}
	return id
}
