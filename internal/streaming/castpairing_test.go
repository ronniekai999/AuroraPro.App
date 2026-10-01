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

	clone, err := tm.CloneForCast(7, "ronnie", src.ID, -1)
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
		SourceFPS:       30,
		Profiles:        []QualityProfile{AllProfiles["1080p"]},
		AudioTrackIndex: -1,
		BurnSubIndex:    -1,
		BurnSubRelIndex: -1,
	}
	tm.mu.Lock()
	tm.sessions[src.ID] = src
	tm.mu.Unlock()

	got, err := tm.CloneForCast(7, "ronnie", src.ID, -1)
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

// An ADMIN may mint a cast token against ANOTHER user's session
// (requireSessionAccess allows it), and CloneForCast then owns the clone as
// the admin while castCloneOf points at the viewer's session. Those are two
// people watching two things; folding on the id alone reports them as one.
func TestActiveStreamCount_DoesNotFoldAcrossUsers(t *testing.T) {
	tm := castLeaseManager(t)
	now := time.Now()
	addLeaseSession(tm, "viewer-local", now, false)
	addLeaseSession(tm, "admin-tv", now, true)
	tm.mu.Lock()
	tm.sessions["viewer-local"].UserID = 42
	tm.sessions["admin-tv"].UserID = 1 // the admin, not the viewer
	tm.sessions["admin-tv"].castCloneOf = "viewer-local"
	tm.mu.Unlock()

	if got := tm.ActiveStreamCount(); got != 2 {
		t.Errorf("ActiveStreamCount = %d, want 2 — a clone owned by a different user is a different viewer", got)
	}
}

// A self-reference would fold a live stream to zero. Note what this actually
// pins: the ROOT condition rejects it (a self-referencing session's "source"
// is itself, which has a non-empty castCloneOf), so the explicit
// `clone != src` guard in castPairable is redundant and deleting it leaves
// this green. The guard stays as a statement of intent; the coverage claim
// belongs to the root condition.
func TestActiveStreamCount_SelfReferenceStillCounts(t *testing.T) {
	tm := castLeaseManager(t)
	addLeaseSession(tm, "loop", time.Now(), false)
	tm.mu.Lock()
	tm.sessions["loop"].castCloneOf = "loop"
	tm.mu.Unlock()

	if got := tm.ActiveStreamCount(); got != 1 {
		t.Errorf("ActiveStreamCount = %d, want 1 — a self-referencing session is still one live stream", got)
	}
}

// The write side: CreateSession applies SessionOpts.CastCloneOf, and applies
// it BEFORE publishing the session — a clone visible unpaired for even an
// instant is a transient double-count on the tile.
//
// It also refuses a self-reference (streaming.go, the CastCloneOf branch).
// That guard is unreachable by construction — the id is generated inside
// CreateSession, so no caller can name it in advance — and is therefore left
// untested rather than tested vacuously; the reachable half of the same
// invariant is TestActiveStreamCount_SelfReferenceStillCounts on the read
// side.
func TestCreateSession_AppliesTheCastCloneOfOption(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	plain, err := tm.CreateSession(1, "alice", "/library/a.mkv", 1920, 1080)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	clone, err := tm.CreateSession(1, "alice", "/library/a.mkv", 1920, 1080, SessionOpts{
		AudioTrackIndex: -1,
		CastCloneOf:     plain.ID,
	})
	if err != nil {
		t.Fatalf("CreateSession with CastCloneOf: %v", err)
	}

	tm.mu.Lock()
	defer tm.mu.Unlock()
	if plain.castCloneOf != "" {
		t.Errorf("plain session carries castCloneOf = %q, want empty", plain.castCloneOf)
	}
	if clone.castCloneOf != plain.ID {
		t.Errorf("clone castCloneOf = %q, want %q — SessionOpts.CastCloneOf was dropped", clone.castCloneOf, plain.ID)
	}
	if got := len(tm.sessions); got != 2 {
		t.Fatalf("expected 2 sessions in the manager, got %d", got)
	}
	// NOTE what is NOT pinned here: that the field is written BEFORE the
	// session is published into tm.sessions. Moving the assignment after the
	// insert passes every test in this package — the window is a few
	// instructions wide and no test can observe it without reaching inside
	// CreateSession. It is a real invariant (an unpaired clone is a transient
	// double-count on the tile) held by construction and by the comment on
	// SessionOpts.CastCloneOf, not by this test.
}

// The pairing rule is duplicated — castPairable here, groupCastStreams in
// static/redesign/app/src/lib/activeStreams.ts — because a count and a row
// list are rendered side by side from the same data. Nothing can compile the
// two against each other, so this table mirrors the cases in
// activeStreams.test.ts one for one. If you change either side, change both
// and update both tables.
func TestActiveStreamCount_MirrorsTheClientGroupingRule(t *testing.T) {
	type row struct {
		id     string
		userID int64
		clone  string
	}
	cases := []struct {
		name string
		rows []row
		want int
	}{
		{"cast pair plus a guest", []row{{"local", 7, ""}, {"tv", 7, "local"}, {"guest", 9, ""}}, 2},
		{"orphaned clone still counts", []row{{"tv", 7, "local-gone"}}, 1},
		{"two clones on one source", []row{{"local", 7, ""}, {"tv-1", 7, "local"}, {"tv-2", 7, "local"}}, 1},
		{"cross-owner pair is two viewers", []row{{"viewer", 42, ""}, {"admin-tv", 1, "viewer"}}, 2},
		{"self-reference", []row{{"a", 7, "a"}, {"b", 7, ""}}, 2},
		{"cycle", []row{{"a", 7, "b"}, {"b", 7, "a"}}, 2},
		{"chain folds one link only", []row{{"root", 7, ""}, {"mid", 7, "root"}, {"leaf", 7, "mid"}}, 2},
		{"no casts at all", []row{{"a", 7, ""}, {"b", 7, ""}}, 2},
		{"empty", nil, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tm := castLeaseManager(t)
			now := time.Now()
			for _, r := range tc.rows {
				addLeaseSession(tm, r.id, now, false)
				tm.mu.Lock()
				tm.sessions[r.id].UserID = r.userID
				tm.sessions[r.id].castCloneOf = r.clone
				tm.mu.Unlock()
			}
			if got := tm.ActiveStreamCount(); got != tc.want {
				t.Errorf("ActiveStreamCount = %d, want %d (the SPA's groupCastStreams returns %d groups for this input)", got, tc.want, tc.want)
			}
		})
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
