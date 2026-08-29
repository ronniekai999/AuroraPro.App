package streaming

import (
	"os"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
)

// ListSessions used to read a variant's PID straight off its *exec.Cmd
// (v.Cmd.Process.Pid). `started` is set BEFORE cmd.Start() runs, so an admin
// loading the active-streams page while a transcode was spinning up read
// exec.Cmd's fields while the launch goroutine was writing them — a genuine
// data race, and one that holding variantMu could not close, because the
// writer is inside os/exec and holds nothing. `go test -race` caught it
// through TestCreateCastToken_MintAloneDoesNotLease.
//
// The Cmd is no longer reachable from the variant at all (the compiler now
// enforces that); the launch goroutine publishes v.pid under variantMu once
// Start() has returned. This pins the consequences for the admin view: a
// variant that has not reached that point contributes no PID, and one that
// has is what /proc gets sampled from.
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
}
