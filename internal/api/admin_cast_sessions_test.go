package api

// Casting to a Chromecast is one viewer holding TWO transcode sessions: the
// local browser session (paused the moment the receiver connects) and the
// cast-safe clone CloneForCast makes for the TV. The admin surface used to
// show them as two identical rows and count both, which reads as a session
// leak.
//
// These tests cover the API boundary that the SPA actually consumes — the
// serialized JSON of /api/admin/sessions, and the arithmetic behind the
// dashboard's Active Streams tile. The streaming package's own tests pin the
// manager-level behavior; what is pinned HERE is that the handler carries it
// across the wire under the exact keys lib/api.ts reads.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/streaming"
)

// CreateSession only LookPaths ffmpeg; variants launch lazily, so a stub that
// exits nonzero is enough to build real sessions.
func fakeFFmpegForCastTest(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ffmpeg"), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatalf("write ffmpeg stub: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// castPairManager returns a manager holding a real cast pair, built through
// the production path (CreateSession → CloneForCast) rather than by poking at
// the manager's internals — so the pairing under test is the one a live cast
// produces. Returns the source and clone IDs.
func castPairManager(t *testing.T) (*streaming.TranscodeManager, string, string) {
	t.Helper()
	fakeFFmpegForCastTest(t)
	tm, err := streaming.NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	t.Cleanup(tm.Close)

	// Remux forces a cast clone (#324) — the common case for an MKV.
	src, err := tm.CreateSession(7, "ronnie", "/library/movie/halloweentown.mkv", 1592, 1080, streaming.SessionOpts{
		Remux:            true,
		SourceVideoCodec: "h264",
		AudioCodecOut:    "aac",
		AudioTrackIndex:  -1,
	})
	if err != nil {
		t.Fatalf("create source session: %v", err)
	}
	clone, err := tm.CloneForCast(7, "ronnie", src.ID)
	if err != nil {
		t.Fatalf("CloneForCast: %v", err)
	}
	if clone.ID == src.ID {
		t.Fatal("expected a distinct cast clone for a remux source")
	}
	return tm, src.ID, clone.ID
}

// The SPA reads these exact keys (lib/api.ts ActiveStreamRow, consumed by
// lib/activeStreams). Asserting on decoded JSON rather than on Go fields is
// the point: a renamed tag or a stray omitempty is invisible to a
// struct-level test and would silently flatten the UI back to two rows.
func TestAdminSessions_JSONCarriesTheCastPairing(t *testing.T) {
	tm, srcID, cloneID := castPairManager(t)
	h := &AdminHandler{transcode: tm}

	w := httptest.NewRecorder()
	h.Sessions(w, httptest.NewRequest(http.MethodGet, "/api/admin/sessions", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/admin/sessions: status %d: %s", w.Code, w.Body.String())
	}

	var rows []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode sessions: %v (body: %s)", err, w.Body.String())
	}
	if len(rows) != 2 {
		t.Fatalf("expected 2 session rows (local + cast clone), got %d: %s", len(rows), w.Body.String())
	}
	byID := map[string]map[string]any{}
	for _, r := range rows {
		id, _ := r["id"].(string)
		byID[id] = r
	}

	src, ok := byID[srcID]
	if !ok {
		t.Fatalf("source session %q missing from the response", srcID)
	}
	clone, ok := byID[cloneID]
	if !ok {
		t.Fatalf("cast clone %q missing from the response", cloneID)
	}

	// The clone names its source under the key the client groups on.
	if got := clone["cast_clone_of"]; got != srcID {
		t.Errorf("clone cast_clone_of = %v, want %q — the SPA cannot pair the rows without it", got, srcID)
	}
	// The local session is nobody's clone. omitempty means the key is absent
	// rather than "", and the client treats both the same.
	if got, present := src["cast_clone_of"]; present && got != "" {
		t.Errorf("source session carries cast_clone_of = %v, want absent", got)
	}
	// cast_held must be PRESENT and false here, not omitted: the client
	// distinguishes false from an older server that sends nothing at all.
	held, present := src["cast_held"]
	if !present {
		t.Error("cast_held missing from the response — it must not be omitempty; false is the meaningful common case")
	}
	if held != false {
		t.Errorf("cast_held = %v on a session no receiver has fetched from, want false", held)
	}
	// No receiver has fetched from the clone yet either (MarkCastHeld is
	// earned by a real cast-token fetch, not granted at mint).
	if got := clone["cast_held"]; got != false {
		t.Errorf("freshly minted clone cast_held = %v, want false", got)
	}
}

// Criterion: one cast is one stream on the dashboard tile. This is the
// arithmetic Dashboard uses; reverting it to ActiveSessions() fails here.
func TestActiveStreamTileCount_CastPairCountsOnce(t *testing.T) {
	tm, _, _ := castPairManager(t)

	if got := tm.ActiveSessions(); got != 2 {
		t.Fatalf("fixture should hold 2 sessions, got %d", got)
	}
	if got := activeStreamTileCount(tm, nil); got != 1 {
		t.Errorf("Active Streams tile = %d, want 1 — one viewer casting one title is one stream", got)
	}
}

// A second viewer must still be counted; the fold is per-pair, not global.
func TestActiveStreamTileCount_CountsOtherViewersAlongsideACast(t *testing.T) {
	tm, _, _ := castPairManager(t)
	if _, err := tm.CreateSession(9, "guest", "/library/movie/halloweentown.mkv", 1592, 1080); err != nil {
		t.Fatalf("create guest session: %v", err)
	}

	if got := activeStreamTileCount(tm, nil); got != 2 {
		t.Errorf("Active Streams tile = %d, want 2 (one cast + one guest)", got)
	}
}

// A nil transcode manager must not panic the dashboard.
func TestActiveStreamTileCount_NilManager(t *testing.T) {
	if got := activeStreamTileCount(nil, nil); got != 0 {
		t.Errorf("activeStreamTileCount(nil, nil) = %d, want 0", got)
	}
}
