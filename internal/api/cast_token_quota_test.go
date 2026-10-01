package api

// 2026-08 review fix — session-cap cast fallback surfaced. Previously a
// quota failure inside CloneForCast was logged and the ORIGINAL session was
// cast anyway; for a Dolby / non-H.264 / remux original that means silent
// audio or an indefinite receiver spinner the sender never learns about.
// Now quota failures return 429 with an actionable message. Cast-safe
// originals (no clone needed) are unaffected by the cap.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/streaming"
)

// TestCreateCastToken_QuotaFailureReturns429 pins the new behavior: the user
// already holds their one allowed session, the session needs a cast clone
// (H.264 remux → #324 CODECS guard), the clone hits the per-user cap, and the
// endpoint answers 429 instead of silently casting the incompatible original.
func TestCreateCastToken_QuotaFailureReturns429(t *testing.T) {
	fakeFFmpegForAPITest(t)
	tm, err := streaming.NewTranscodeManager(t.TempDir(), config.TranscodeConfig{
		SegmentFormat:      "fmp4",
		MaxSessionsPerUser: 1, // the original session below already fills the user's slot
	})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	src, err := tm.CreateSession(7, "testuser", "/library/movie.mkv", 1920, 1080,
		streaming.SessionOpts{
			Remux:            true,
			RemuxAudioCopy:   true,
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

	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429; body = %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "too many active streams") {
		t.Errorf("429 body should carry the actionable message, got %s", rr.Body.String())
	}
	// And the error must NOT look like a success payload.
	var resp map[string]interface{}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err == nil {
		if _, hasPlaylist := resp["playlist"]; hasPlaylist {
			t.Error("429 response must not contain a playlist URL")
		}
	}
}

// TestCreateCastToken_CastSafeSessionUnaffectedByCap verifies the cap only
// bites when a clone is actually required: a session that is already
// cast-safe (H.264 transcode + AAC, no subtitle tracks) is returned by
// CloneForCast unchanged — no new session is created, so a full user quota
// does not block casting it.
func TestCreateCastToken_CastSafeSessionUnaffectedByCap(t *testing.T) {
	fakeFFmpegForAPITest(t)
	tm, err := streaming.NewTranscodeManager(t.TempDir(), config.TranscodeConfig{
		SegmentFormat:      "fmp4",
		Profiles:           []string{"1080p"},
		MaxSessionsPerUser: 1,
	})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	src, err := tm.CreateSession(7, "testuser", "/library/movie.mkv", 1920, 1080,
		streaming.SessionOpts{
			Remux:           false, // full transcode → H.264 + CODECS attribute
			AudioCodecOut:   "aac",
			SourceFPS:       30,
			AudioTrackIndex: -1,
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
		t.Fatalf("cast-safe session at cap: status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var resp map[string]interface{}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	playlist, _ := resp["playlist"].(string)
	if !strings.Contains(playlist, src.ID) {
		t.Errorf("cast-safe playlist %q should reference the original session %q", playlist, src.ID)
	}
}

func TestCreateCastToken_ReplacementAtQuotaPreservesCommittedCopy(t *testing.T) {
	fakeFFmpegForAPITest(t)
	tm, err := streaming.NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4", MaxSessionsPerUser: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer tm.Close()
	src, err := tm.CreateSession(7, "testuser", "/library/movie.mkv", 1920, 1080, streaming.SessionOpts{Remux: true, RemuxAudioCopy: true, SourceVideoCodec: "h264", AudioCodecOut: "aac", SourceFPS: 30})
	if err != nil {
		t.Fatal(err)
	}
	h := &StreamHandler{transcode: tm, authSvc: auth.NewService(config.AuthConfig{JWTSecret: "test-secret-that-is-at-least-32-chars-long-yes"})}
	first := castTokenJSON(t, h, src.ID, "at=1800")
	copyID := strings.Split(strings.TrimPrefix(first["playlist"].(string), "/api/stream/hls/"), "/")[0]
	rr := httptest.NewRecorder()
	h.CreateCastToken(rr, castTokenRequest(t, src.ID, "at=2400", &auth.JWTClaims{UserID: 7, Username: "testuser", Role: "user"}))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	for _, id := range []string{src.ID, copyID} {
		if _, ok := tm.GetSession(id); !ok {
			t.Fatalf("quota failure destroyed session %s", id)
		}
	}
	if rows := tm.ListSessions(); len(rows) != 2 {
		t.Fatalf("quota allowance changed: %+v", rows)
	}
}
