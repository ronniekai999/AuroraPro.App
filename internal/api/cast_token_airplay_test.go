package api

// Issue #326 — "Scooby doo does not play": H.264 remux titles failed to play
// on Mac + Chrome 149+ because the native-HLS initialisation path called
// createCastToken at session-start to pre-bake an AirPlay-auth URL into
// vid.src. The #324 fix made CreateCastToken unconditionally call CloneForCast
// for remux sessions, which spawned a fresh FFmpeg transcode. That clone had
// produced no segments yet, so vid.src pointed at an empty playlist and the
// video never started.
//
// Fix: the for_airplay=true query parameter skips CloneForCast. Apple TV and
// the browser's native HLS player decode H.264 remux natively; the CODECS
// guarantee is only needed by the Chromecast Default Media Receiver.

import (
	"context"
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
	"github.com/go-chi/chi/v5"
)

func fakeFFmpegForAPITest(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	stub := filepath.Join(dir, "ffmpeg")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatalf("write ffmpeg stub: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func castTokenRequest(t *testing.T, sessionID, query string, claims *auth.JWTClaims) *http.Request {
	t.Helper()
	url := "/api/stream/sessions/" + sessionID + "/cast-token"
	if query != "" {
		url += "?" + query
	}
	req := httptest.NewRequest(http.MethodPost, url, nil)
	// Inject auth claims (simulates RequireAuth middleware).
	ctx := context.WithValue(req.Context(), auth.ClaimsContextKey, claims)
	// Inject chi URL param so chi.URLParam(r, "sessionID") resolves.
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("sessionID", sessionID)
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	return req.WithContext(ctx)
}

// TestCreateCastToken_ForAirplaySkipsClone verifies that ?for_airplay=true
// returns a token whose playlist URL points at the ORIGINAL session — no clone
// is created — even when the source is an H.264 remux that would otherwise
// trigger CloneForCast (issue #326).
func TestCreateCastToken_ForAirplaySkipsClone(t *testing.T) {
	fakeFFmpegForAPITest(t)
	tm, err := streaming.NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	// Create an H.264 remux session — the shape that triggered an
	// unnecessary CloneForCast in issue #326.
	src, err := tm.CreateSession(7, "testuser", "/library/scooby.mkv", 1920, 1080,
		streaming.SessionOpts{
			Remux:            true,
			RemuxAudioCopy:   true, // H.264+AAC source — audio can be copied as-is
			SourceVideoCodec: "h264",
			AudioCodecOut:    "aac",
			AudioTrackIndex:  -1,
		},
	)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	authSvc := auth.NewService(config.AuthConfig{
		JWTSecret:       "test-secret-that-is-at-least-32-chars-long-yes",
		CastTokenExpiry: 4 * 3600 * 1e9, // 4h in nanoseconds
	})
	h := &StreamHandler{transcode: tm, authSvc: authSvc}

	claims := &auth.JWTClaims{UserID: 7, Username: "testuser", Role: "user"}

	rr := httptest.NewRecorder()
	h.CreateCastToken(rr, castTokenRequest(t, src.ID, "for_airplay=true", claims))

	if rr.Code != http.StatusOK {
		t.Fatalf("for_airplay=true: status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var resp map[string]interface{}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	playlist, _ := resp["playlist"].(string)
	if !strings.Contains(playlist, src.ID) {
		t.Errorf("for_airplay=true: playlist %q should contain the original session ID %q (no clone expected)", playlist, src.ID)
	}
}

// TestCreateCastToken_WithoutForAirplayClonesRemux verifies the baseline
// behavior: without ?for_airplay=true, an H.264 remux session gets a clone
// (the CODECS-attribute guard from #324), and the playlist URL points at the
// clone, not the original.
func TestCreateCastToken_WithoutForAirplayClonesRemux(t *testing.T) {
	fakeFFmpegForAPITest(t)
	tm, err := streaming.NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	src, err := tm.CreateSession(7, "testuser", "/library/scooby.mkv", 1920, 1080,
		streaming.SessionOpts{
			Remux:            true,
			RemuxAudioCopy:   true, // H.264+AAC source — audio can be copied as-is
			SourceVideoCodec: "h264",
			AudioCodecOut:    "aac",
			AudioTrackIndex:  -1,
		},
	)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	authSvc := auth.NewService(config.AuthConfig{
		JWTSecret:       "test-secret-that-is-at-least-32-chars-long-yes",
		CastTokenExpiry: 4 * 3600 * 1e9,
	})
	h := &StreamHandler{transcode: tm, authSvc: authSvc}

	claims := &auth.JWTClaims{UserID: 7, Username: "testuser", Role: "user"}

	rr := httptest.NewRecorder()
	h.CreateCastToken(rr, castTokenRequest(t, src.ID, "", claims))

	if rr.Code != http.StatusOK {
		t.Fatalf("no for_airplay: status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var resp map[string]interface{}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	playlist, _ := resp["playlist"].(string)
	if strings.Contains(playlist, src.ID) {
		t.Errorf("no for_airplay: playlist %q still contains the original session ID %q; expected a clone session ID", playlist, src.ID)
	}
}
