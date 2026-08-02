package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/streaming"
	"github.com/go-chi/chi/v5"
)

func keepaliveRequest(sessionID string, claims *auth.JWTClaims) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/stream/sessions/"+sessionID+"/keepalive", nil)
	ctx := context.WithValue(req.Context(), auth.ClaimsContextKey, claims)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("sessionID", sessionID)
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	return req.WithContext(ctx)
}

func keepaliveHandler(t *testing.T) (*StreamHandler, *streaming.TranscodeManager) {
	t.Helper()
	fakeFFmpegForAPITest(t)
	tm, err := streaming.NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	t.Cleanup(tm.Close)
	return &StreamHandler{transcode: tm}, tm
}

// A player stuck on a dead session pings forever. The wire answer is right
// either way — 404 is 404 — so the only thing that can surface it is the log.
func TestKeepAlive_WarnsAboutAClientStuckOnADeadSession(t *testing.T) {
	h, _ := keepaliveHandler(t)
	claims := &auth.JWTClaims{UserID: 8, Username: "viewer", Role: "user"}

	out := captureLogs(t, func() {
		for i := 0; i < staleKeepaliveThreshold; i++ {
			rr := httptest.NewRecorder()
			h.KeepAlive(rr, keepaliveRequest("d2fa80a86bbefb79", claims))
			if rr.Code != http.StatusNotFound {
				t.Fatalf("ping %d: status = %d, want 404", i+1, rr.Code)
			}
		}
	})

	if !strings.Contains(out, "no longer exists") {
		t.Fatalf("a client past the threshold produced no warning:\n%s", out)
	}
	// The operator needs to know WHICH client to go reload.
	if !strings.Contains(out, "d2fa80a86bbefb79") || !strings.Contains(out, "user_id=8") {
		t.Fatalf("warning does not identify the stuck client:\n%s", out)
	}
}

// One 404 is how every client learns its session died in a restart. Warning
// there would fire for every viewer on every deploy — the noise this replaces.
func TestKeepAlive_SilentOnTheFirstMiss(t *testing.T) {
	h, _ := keepaliveHandler(t)
	claims := &auth.JWTClaims{UserID: 8, Username: "viewer", Role: "user"}

	out := captureLogs(t, func() {
		rr := httptest.NewRecorder()
		h.KeepAlive(rr, keepaliveRequest("gone-after-restart", claims))
		if rr.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rr.Code)
		}
	})

	if strings.Contains(out, "no longer exists") {
		t.Fatalf("warned on the first 404:\n%s", out)
	}
}

// The handler answers 404 for two different reasons, and only one of them is a
// stuck client. A client poking at someone else's live session is an
// authorization miss: it must not raise a warning claiming the session is gone,
// and it must not spend the watcher's bounded budget.
func TestKeepAlive_ForeignSessionIsNotAStuckClient(t *testing.T) {
	h, tm := keepaliveHandler(t)

	src, err := tm.CreateSession(7, "owner", "/library/movie.mkv", 1920, 1080,
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

	intruder := &auth.JWTClaims{UserID: 99, Username: "someone-else", Role: "user"}
	out := captureLogs(t, func() {
		for i := 0; i < staleKeepaliveThreshold+3; i++ {
			rr := httptest.NewRecorder()
			h.KeepAlive(rr, keepaliveRequest(src.ID, intruder))
			if rr.Code != http.StatusNotFound {
				t.Fatalf("ping %d: status = %d, want a uniform 404", i+1, rr.Code)
			}
		}
	})

	if strings.Contains(out, "no longer exists") {
		t.Fatalf("an access-control 404 was reported as a dead session:\n%s", out)
	}
	if _, tracked := h.staleKeepalive.entries[src.ID]; tracked {
		t.Fatal("a live session someone else pinged consumed a tracking slot")
	}
}

// A successful keepalive clears whatever run of misses preceded it, so a
// session that recovers cannot inherit a warning it no longer deserves.
func TestKeepAlive_SuccessClearsTheRun(t *testing.T) {
	h, tm := keepaliveHandler(t)

	src, err := tm.CreateSession(7, "owner", "/library/movie.mkv", 1920, 1080,
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

	owner := &auth.JWTClaims{UserID: 7, Username: "owner", Role: "user"}
	h.staleKeepalive.miss(src.ID, time.Now())

	rr := httptest.NewRecorder()
	h.KeepAlive(rr, keepaliveRequest(src.ID, owner))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if _, tracked := h.staleKeepalive.entries[src.ID]; tracked {
		t.Fatal("a successful keepalive left the session's miss count in place")
	}
}
