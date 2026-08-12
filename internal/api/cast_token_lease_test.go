package api

// Cast lease wiring — CreateCastToken must put the session the RECEIVER will
// stream onto streaming's longer idle window, and must NOT put an ordinary
// Safari/iOS playback session there.
//
// Both halves are asserted at the handler, not through the streaming
// package's own helpers. An earlier version of these tests exercised only
// the pure timeout helper, and deleting the handler's MarkCastHeld call
// entirely left the whole suite green — the behaviour change was
// unprotected. These fail if the wiring is removed.

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/streaming"
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

// The fix: minting a Chromecast token puts the session the receiver streams
// on the cast lease, so a paused cast with a frozen (locked-phone) sender
// isn't reaped five minutes later.
func TestCreateCastToken_MarksTheCastSessionHeld(t *testing.T) {
	h, tm := leaseTestHandler(t)
	src := leaseTestSession(t, tm)
	claims := &auth.JWTClaims{UserID: 7, Username: "testuser", Role: "user"}

	rr := httptest.NewRecorder()
	h.CreateCastToken(rr, castTokenRequest(t, src.ID, "", claims))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}

	// This source clones, so the leased session is the clone — find it as
	// "the session that isn't the original". Asserting on the clone rather
	// than the original is the point: the clone is what the TV fetches.
	var leased int
	for _, s := range tm.ListSessions() {
		if tm.IsCastHeld(s.ID) {
			leased++
			if s.ID == src.ID {
				t.Error("the ORIGINAL session was leased; the receiver streams the clone")
			}
		}
	}
	if leased != 1 {
		t.Errorf("expected exactly 1 cast-held session, got %d", leased)
	}
}

// The regression guard. ?for_airplay=true is NOT an "AirPlay started"
// signal: the SPA mints one during ordinary native-HLS setup for EVERY
// Safari/iOS playback, AirPlay or not. Leasing there would put every
// Apple-browser session — including the abandoned-tab case, which is most
// common on exactly that platform — on a 30-minute window it has no receiver
// to justify, while a live browser is still pinging keepalive for it.
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
