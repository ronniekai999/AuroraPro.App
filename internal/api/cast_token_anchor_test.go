package api

// The cast-token endpoint's positioning contract.
//
// ?at=<absolute source seconds> tells the server where the sender is, so the
// cast clone's FFmpeg -ss anchor can be put near it instead of inheriting the
// source session's. start_sec in the response reports the anchor the cast
// session ACTUALLY got — the sender cannot infer it, because the shared-session
// path (no clone needed) and the cloned path give different answers, and using
// the wrong one is how a midstream cast ends up seeking into a playlist that
// has produced seconds.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/streaming"
)

func castAnchorHandler(t *testing.T, profiles ...string) (*StreamHandler, *streaming.TranscodeManager) {
	t.Helper()
	fakeFFmpegForAPITest(t)
	tm, err := streaming.NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4", Profiles: profiles})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	t.Cleanup(tm.Close)
	authSvc := auth.NewService(config.AuthConfig{
		JWTSecret:       "test-secret-that-is-at-least-32-chars-long-yes",
		CastTokenExpiry: 4 * 3600 * 1e9,
	})
	return &StreamHandler{transcode: tm, authSvc: authSvc}, tm
}

// A remux source, which #324 forces a clone for — the path where the anchor
// actually moves.
func castAnchorSource(t *testing.T, tm *streaming.TranscodeManager, startSec int) *streaming.TranscodeSession {
	t.Helper()
	src, err := tm.CreateSession(7, "testuser", "/library/scooby.mkv", 1920, 1080,
		streaming.SessionOpts{
			Remux:            true,
			RemuxAudioCopy:   true,
			SourceVideoCodec: "h264",
			AudioCodecOut:    "aac",
			AudioTrackIndex:  -1,
			StartSec:         startSec,
		},
	)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return src
}

func castTokenJSON(t *testing.T, h *StreamHandler, sessionID, query string) map[string]interface{} {
	t.Helper()
	claims := &auth.JWTClaims{UserID: 7, Username: "testuser", Role: "user"}
	rr := httptest.NewRecorder()
	h.CreateCastToken(rr, castTokenRequest(t, sessionID, query, claims))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var resp map[string]interface{}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp
}

// The headline case: casting 40 minutes into a session anchored at 0 must not
// hand the receiver a clone that starts at 0.
func TestCreateCastToken_AtAnchorsTheCloneNearTheSender(t *testing.T) {
	h, tm := castAnchorHandler(t)
	src := castAnchorSource(t, tm, 0)

	resp := castTokenJSON(t, h, src.ID, "at=2400")

	playlist, _ := resp["playlist"].(string)
	if strings.Contains(playlist, src.ID) {
		t.Fatalf("expected a clone for a remux source, got the original: %q", playlist)
	}
	startSec, ok := resp["start_sec"].(float64)
	if !ok {
		t.Fatalf("start_sec missing from response: %+v", resp)
	}
	// The exact arithmetic, not just "somewhere plausible": a band like
	// (0, 2400] is satisfied by an anchor of 1, which would be the bug.
	if want := float64(2400 - castAnchorPadForTest); startSec != want {
		t.Fatalf("start_sec = %v, want %v (the sender's position less the pad); "+
			"inheriting the source's 0 is the bug this closes", startSec, want)
	}
}

// Mirrors streaming.castAnchorPadSec, which is unexported. Pinned here so a
// change to the pad has to be made deliberately on both sides rather than
// silently loosening this assertion.
const castAnchorPadForTest = 15

// Omitting ?at= must keep the pre-2026-09 behaviour exactly: a sender that has
// not been updated still gets a working (if badly anchored) cast.
func TestCreateCastToken_WithoutAtInheritsTheSourceAnchor(t *testing.T) {
	h, tm := castAnchorHandler(t)
	src := castAnchorSource(t, tm, 300)

	resp := castTokenJSON(t, h, src.ID, "")

	startSec, ok := resp["start_sec"].(float64)
	if !ok {
		t.Fatalf("start_sec missing from response: %+v", resp)
	}
	if startSec != 300 {
		t.Fatalf("start_sec = %v, want the source's 300 when no ?at= is sent", startSec)
	}
}

// A garbage ?at= is a hint that failed to parse, not a reason to fail the mint
// — casting must not break because a query parameter was mangled.
func TestCreateCastToken_UnusableAtIsIgnoredNotFatal(t *testing.T) {
	// "" is deliberately absent: an empty ?at= never reaches the parser (the
	// handler tests the raw string first), so including it would duplicate
	// TestCreateCastToken_WithoutAtInheritsTheSourceAnchor under a name that
	// claims to test parsing.
	for _, raw := range []string{"banana", "-5", "12.5", "9e9", "2400x"} {
		t.Run("at="+raw, func(t *testing.T) {
			h, tm := castAnchorHandler(t)
			src := castAnchorSource(t, tm, 300)

			resp := castTokenJSON(t, h, src.ID, "at="+raw)

			if _, ok := resp["token"].(string); !ok {
				t.Fatalf("token missing from response: %+v", resp)
			}
			startSec, ok := resp["start_sec"].(float64)
			if !ok {
				t.Fatalf("start_sec missing from response: %+v", resp)
			}
			if startSec != 300 {
				t.Fatalf("start_sec = %v, want the source's 300 — an unusable "+
					"?at= must fall back to no preference", startSec)
			}
		})
	}
}

// The shared-session path reports the LOCAL session's anchor, unmoved. The
// sender converts absolute positions through whatever start_sec says, so
// reporting the clone's arithmetic here would desync a cast that needed no
// clone at all.
func TestCreateCastToken_SharedSessionReportsItsOwnAnchor(t *testing.T) {
	h, tm := castAnchorHandler(t, "1080p")
	// Cast-safe as-is (transcode, H.264 + AAC, no subtitle tracks), so
	// CloneForCast hands the original session straight back.
	src, err := tm.CreateSession(7, "testuser", "/library/scooby.mkv", 1920, 1080,
		streaming.SessionOpts{
			Remux:            false,
			SourceVideoCodec: "h264",
			VideoCodecOut:    "h264",
			SourceFPS:        30,
			AudioCodecOut:    "aac",
			AudioTrackIndex:  -1,
			StartSec:         600,
		},
	)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	resp := castTokenJSON(t, h, src.ID, "at=610")

	playlist, _ := resp["playlist"].(string)
	if !strings.Contains(playlist, src.ID) {
		t.Fatalf("expected the shared session back, got %q", playlist)
	}
	startSec, ok := resp["start_sec"].(float64)
	if !ok {
		t.Fatalf("start_sec missing from response: %+v", resp)
	}
	if startSec != 600 {
		t.Fatalf("start_sec = %v, want the local session's 600 — ?at= must not "+
			"re-anchor the session the browser is playing", startSec)
	}
}

// for_airplay skips cloning entirely (#326); its start_sec is the source's.
func TestCreateCastToken_ForAirplayReportsTheSourceAnchor(t *testing.T) {
	h, tm := castAnchorHandler(t)
	src := castAnchorSource(t, tm, 450)

	resp := castTokenJSON(t, h, src.ID, "for_airplay=true&at=2400")

	playlist, _ := resp["playlist"].(string)
	if !strings.Contains(playlist, src.ID) {
		t.Fatalf("for_airplay must not clone; got %q", playlist)
	}
	startSec, ok := resp["start_sec"].(float64)
	if !ok {
		t.Fatalf("start_sec missing from response: %+v", resp)
	}
	if startSec != 450 {
		t.Fatalf("start_sec = %v, want the source's 450", startSec)
	}
}

func TestCreateCastToken_ReportsActualFormatAndOneReadyRung(t *testing.T) {
	for _, tc := range []struct {
		name, query, format string
		shared              bool
	}{
		{"private TS copy", "at=2400", "ts", false},
		{"near shared fMP4", "at=610", "fmp4", true},
		{"AirPlay original", "for_airplay=true&at=2400", "fmp4", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, tm := castAnchorHandler(t, "1080p")
			src, err := tm.CreateSession(7, "testuser", "/library/movie.mkv", 1920, 1080, streaming.SessionOpts{SourceVideoCodec: "h264", SourceFPS: 30, AudioCodecOut: "aac", AudioTrackIndex: -1, StartSec: 600})
			if err != nil {
				t.Fatal(err)
			}
			resp := castTokenJSON(t, h, src.ID, tc.query)
			if resp["segment_format"] != tc.format {
				t.Fatalf("format=%v want %s", resp["segment_format"], tc.format)
			}
			id := strings.Split(strings.TrimPrefix(resp["playlist"].(string), "/api/stream/hls/"), "/")[0]
			if (id == src.ID) != tc.shared {
				t.Fatalf("shared=%v want %v", id == src.ID, tc.shared)
			}
			cs, ok := tm.GetSession(id)
			if !ok {
				t.Fatal("missing cast session")
			}
			if len(cs.Profiles) != 1 || len(cs.Variants) != 1 {
				t.Fatalf("cast ladder=%+v", cs.Profiles)
			}
			if !strings.Contains(tc.query, "for_airplay") {
				playlist := filepath.Join(cs.OutputDir, cs.Profiles[0].Name, "stream.m3u8")
				if _, err := os.Stat(playlist); err != nil {
					t.Fatalf("response precedes cast readiness: %v", err)
				}
			}
			if src.StartSec != 600 {
				t.Fatalf("source anchor moved to %d", src.StartSec)
			}
		})
	}
}

func TestCreateCastToken_FailedWarmDoesNotLeakCopyOrReplaceOriginal(t *testing.T) {
	h, tm := castAnchorHandler(t)
	src := castAnchorSource(t, tm, 0)
	// A real startup failure, not quota. Fail closed and clean up only the
	// unpublished receiver copy; never offer the incompatible original URL.
	fakeDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(fakeDir, "ffmpeg"), []byte("#!/bin/sh\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", fakeDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	rr := httptest.NewRecorder()
	h.CreateCastToken(rr, castTokenRequest(t, src.ID, "at=2400", &auth.JWTClaims{UserID: 7, Username: "testuser", Role: "user"}))
	if rr.Code != http.StatusServiceUnavailable || strings.Contains(rr.Body.String(), "playlist") {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if _, ok := tm.GetSession(src.ID); !ok {
		t.Fatal("startup failure deleted caller's original session")
	}
	if rows := tm.ListSessions(); len(rows) != 1 {
		t.Fatalf("unpublished cast leaked: %+v", rows)
	}
}
