package streaming

import (
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
)

// ListSessions used to read a variant's PID straight off its *exec.Cmd
// (v.Cmd.Process.Pid). `started` is set BEFORE cmd.Start() runs, so an admin
// loading the active-streams page while a transcode was spinning up read
// exec.Cmd's fields while the launch goroutine was writing them — a genuine
// data race, and one that holding variantMu could not close, because the
// writer is inside os/exec and holds nothing of ours. `go test -race` caught
// it through TestCreateCastToken_MintAloneDoesNotLease.
//
// The Cmd is no longer reachable from the variant at all, so the compiler —
// not these tests — is what stops the next reader from reaching through it.
// What the tests pin is the replacement: which variants contribute a PID, and
// that the launch goroutine actually publishes one.

// The read side. A variant that has not reached the publish contributes no
// PID; one that has is what /proc gets sampled from.
func TestListSessions_SamplesProcessesFromThePublishedPID(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("NewTranscodeManager: %v", err)
	}
	t.Cleanup(tm.Close)

	tm.mu.Lock()
	tm.sessions["s"] = &TranscodeSession{
		ID:         "s",
		StartedAt:  time.Now().Add(-time.Minute),
		LastAccess: time.Now(),
		Variants: map[string]*QualityVariant{
			// Running: Start() returned and the goroutine published its PID.
			// Our own PID stands in for FFmpeg's so /proc actually resolves.
			"1080p": {Profile: QualityProfile{Name: "1080p"}, started: true, pid: os.Getpid()},
			// Mid-launch: `started` is already true, the fork/exec has not
			// finished. This is the window the race lived in.
			"720p": {Profile: QualityProfile{Name: "720p"}, started: true},
			// Never launched — an ABR rung nobody fetched.
			"480p": {Profile: QualityProfile{Name: "480p"}},
		},
	}
	tm.mu.Unlock()

	infos := tm.ListSessions()
	if len(infos) != 1 {
		t.Fatalf("ListSessions returned %d sessions, want 1", len(infos))
	}
	got := infos[0]

	active := map[string]bool{}
	for _, name := range got.ActiveVariants {
		active[name] = true
	}
	if !active["1080p"] || !active["720p"] {
		t.Errorf("ActiveVariants = %v, want both started variants listed", got.ActiveVariants)
	}
	if active["480p"] {
		t.Errorf("ActiveVariants = %v, want the unlaunched variant left out", got.ActiveVariants)
	}

	if got.Resources == nil {
		t.Fatal("Resources is nil — the published PID never reached the /proc sampler")
	}
	if got.Resources.NumProcesses != 1 {
		t.Errorf("NumProcesses = %d, want 1: only the variant past cmd.Start() has a PID to sample",
			got.Resources.NumProcesses)
	}
	// NumProcesses is just len(pids), so it stays 1 even for a PID that
	// resolves to nothing. Sampling a PID we know is alive is what proves the
	// value reached /proc rather than merely being counted.
	if runtime.GOOS == "linux" && got.Resources.MemoryBytes <= 0 {
		t.Errorf("MemoryBytes = %d for a live PID, want > 0 — the PID was counted but never sampled",
			got.Resources.MemoryBytes)
	}
}

// The write side, which the read-side test above cannot see: startVariantImpl
// publishes v.pid from the launch goroutine only once cmd.Start() has
// returned, and relaunchVariantLocked clears it. Neither is covered by
// anything else in the package — drop either and the whole suite still passes
// while the admin Active-Streams panel silently loses its CPU/RSS numbers for
// every live transcode, or keeps reporting a PID whose process already died.
func TestStartVariant_PublishesThePIDAndRelaunchClearsIt(t *testing.T) {
	fakeFFmpegOnPath(t) // stub: Start() succeeds, the process then exits 1
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	v := &QualityVariant{
		Profile:   QualityProfile{Name: "source"},
		OutputDir: t.TempDir(),
		Ready:     make(chan struct{}),
	}
	s := &TranscodeSession{
		ID:         "sess-pid",
		FilePath:   "/tmp/x.mkv",
		Variants:   map[string]*QualityVariant{"source": v},
		LastAccess: time.Now(),
		Remux:      true,
	}

	if _, err := tm.EnsureVariant(s, "source", 0); err != nil {
		t.Fatalf("EnsureVariant: %v", err)
	}

	// The publish is asynchronous — it happens in the launch goroutine after
	// Start() returns, which is precisely why it cannot be read off the Cmd.
	pid := waitForVariantPID(t, s, v)
	if pid == os.Getpid() {
		t.Fatalf("published pid %d is our own process, not the spawned ffmpeg", pid)
	}

	// The reset must travel with the relaunch. Reading it while we still hold
	// variantMu is deterministic: the relaunched generation's goroutine cannot
	// publish its own PID until we let go of the lock.
	s.variantMu.Lock()
	relaunchErr := tm.relaunchVariantLocked(s, v, 0, 0)
	pidAfter := v.pid
	s.variantMu.Unlock()
	if relaunchErr != nil {
		t.Fatalf("relaunchVariantLocked: %v", relaunchErr)
	}
	if pidAfter != 0 {
		t.Errorf("pid = %d immediately after relaunch, want 0 — a resumed variant would keep "+
			"reporting the PID of the process that already died", pidAfter)
	}
}

// waitForVariantPID blocks until the launch goroutine has published a PID for
// v, honouring ffmpegDone's contract of reading variant state under variantMu.
func waitForVariantPID(t *testing.T, s *TranscodeSession, v *QualityVariant) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		s.variantMu.Lock()
		pid := v.pid
		s.variantMu.Unlock()
		if pid != 0 {
			return pid
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("launch goroutine never published a PID — ListSessions has nothing to sample /proc with")
	return 0
}
