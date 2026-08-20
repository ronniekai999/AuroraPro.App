package streaming

// Casting to a Chromecast produces TWO sessions for one viewer: the local
// browser session, which the sender force-pauses the moment the receiver
// connects, and the cast-safe clone CloneForCast makes for the TV. Both are
// real rows in the manager, and until castCloneOf existed nothing told them
// apart — the admin dashboard showed the same user, the same file and the
// same "transcode" badge twice, which reads as a session leak rather than as
// one person watching one movie.
//
// These tests pin the pairing (who was cloned from whom) and the counting
// rule that hangs off it.

import (
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
)

// A clone must name its source. This is the fact the whole feature rests on:
// without it the two rows are indistinguishable at the API boundary.
func TestCloneForCast_RecordsTheSourceOnTheClone(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	src := &TranscodeSession{
		ID:               "src-local",
		UserID:           7,
		FilePath:         "/library/movie/halloweentown.mkv",
		SourceWidth:      1592,
		SourceHeight:     1080,
		Remux:            true, // forces a clone (#324)
		SourceVideoCodec: "h264",
		AudioCodecOut:    "aac",
		AudioTrackIndex:  -1,
		BurnSubIndex:     -1,
		BurnSubRelIndex:  -1,
	}
	tm.mu.Lock()
	tm.sessions[src.ID] = src
	tm.mu.Unlock()

	clone, err := tm.CloneForCast(7, "ronnie", src.ID)
	if err != nil {
		t.Fatalf("CloneForCast: %v", err)
	}
	if clone.ID == src.ID {
		t.Fatal("expected a clone for this fixture; the pairing test needs two distinct sessions")
	}

	tm.mu.Lock()
	gotClone, gotSrc := clone.castCloneOf, src.castCloneOf
	tm.mu.Unlock()

	if gotClone != src.ID {
		t.Errorf("clone.castCloneOf = %q, want %q — the admin surface cannot pair the rows without it", gotClone, src.ID)
	}
	if gotSrc != "" {
		t.Errorf("source session gained castCloneOf = %q, want empty — the local player's session is nobody's clone", gotSrc)
	}
}

// When the server decides no clone is needed (already H.264 + AAC, no
// subtitle tracks) the receiver shares the local session and there is only
// ever ONE row. Stamping castCloneOf on it would make a session its own
// parent — and ActiveStreamCount would then fold the only stream away.
func TestCloneForCast_SharedSessionIsNotMarkedAsItsOwnClone(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	// A transcode session already emitting H.264 + AAC with no subtitle
	// tracks: cast-safe as-is, so CloneForCast returns it unchanged.
	src := &TranscodeSession{
		ID:              "src-already-safe",
		UserID:          7,
		FilePath:        "/library/movie/safe.mp4",
		SourceWidth:     1920,
		SourceHeight:    1080,
		AudioCodecOut:   "aac",
		AudioTrackIndex: -1,
		BurnSubIndex:    -1,
		BurnSubRelIndex: -1,
	}
	tm.mu.Lock()
	tm.sessions[src.ID] = src
	tm.mu.Unlock()

	got, err := tm.CloneForCast(7, "ronnie", src.ID)
	if err != nil {
		t.Fatalf("CloneForCast: %v", err)
	}
	if got.ID != src.ID {
		t.Fatalf("expected the shared-session path (no clone), got a new session %q", got.ID)
	}
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if src.castCloneOf != "" {
		t.Errorf("shared session marked as a clone of %q — it is the local session, not a clone of anything", src.castCloneOf)
	}
	if n := len(tm.sessions); n != 1 {
		t.Errorf("shared-session path created %d sessions, want 1", n)
	}
}

// ListSessions is the admin API's only window onto these two facts, and both
// are read under tm.mu inside it — so this also exercises that they survive
// the snapshot.
func TestListSessions_ExposesCastHeldAndTheClonePairing(t *testing.T) {
	tm := castLeaseManager(t)
	now := time.Now()
	addLeaseSession(tm, "local", now, false)
	addLeaseSession(tm, "tv", now, true)
	tm.mu.Lock()
	tm.sessions["tv"].castCloneOf = "local"
	tm.mu.Unlock()

	byID := map[string]SessionInfo{}
	for _, info := range tm.ListSessions() {
		byID[info.ID] = info
	}
	if len(byID) != 2 {
		t.Fatalf("ListSessions returned %d sessions, want 2", len(byID))
	}
	if byID["local"].CastHeld {
		t.Error("the local (paused) session reported cast_held — no receiver ever fetched it")
	}
	if byID["local"].CastCloneOf != "" {
		t.Errorf("local session reported cast_clone_of = %q, want empty", byID["local"].CastCloneOf)
	}
	if !byID["tv"].CastHeld {
		t.Error("the receiver's session reported cast_held = false — the UI has nothing to label")
	}
	if byID["tv"].CastCloneOf != "local" {
		t.Errorf("clone reported cast_clone_of = %q, want %q", byID["tv"].CastCloneOf, "local")
	}
}

// The dashboard tile counts viewers, not rows: a cast pair is one stream.
func TestActiveStreamCount_CollapsesACastPair(t *testing.T) {
	tm := castLeaseManager(t)
	now := time.Now()
	addLeaseSession(tm, "local", now, false)
	addLeaseSession(tm, "tv", now, true)
	addLeaseSession(tm, "guest", now, false)
	tm.mu.Lock()
	tm.sessions["tv"].castCloneOf = "local"
	tm.mu.Unlock()

	if got := tm.ActiveSessions(); got != 3 {
		t.Errorf("ActiveSessions = %d, want 3 — the raw row count must not change", got)
	}
	if got := tm.ActiveStreamCount(); got != 2 {
		t.Errorf("ActiveStreamCount = %d, want 2 (one cast + one guest)", got)
	}
}

// The ordinary end state of a cast is the local player closing while the TV
// keeps playing. That clone is somebody watching something, so it must count
// on its own — the tile can never read lower than the number of viewers.
func TestActiveStreamCount_OrphanedCloneStillCounts(t *testing.T) {
	tm := castLeaseManager(t)
	addLeaseSession(tm, "tv", time.Now(), true)
	tm.mu.Lock()
	tm.sessions["tv"].castCloneOf = "local-long-gone"
	tm.mu.Unlock()

	if got := tm.ActiveStreamCount(); got != 1 {
		t.Errorf("ActiveStreamCount = %d, want 1 — a clone whose source is gone is still a live stream", got)
	}
}

// Nothing to fold when nobody is casting.
func TestActiveStreamCount_MatchesRowCountWithoutCasts(t *testing.T) {
	tm := castLeaseManager(t)
	now := time.Now()
	addLeaseSession(tm, "a", now, false)
	addLeaseSession(tm, "b", now, false)

	if got := tm.ActiveStreamCount(); got != 2 {
		t.Errorf("ActiveStreamCount = %d, want 2", got)
	}
}
