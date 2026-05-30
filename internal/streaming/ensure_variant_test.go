package streaming

import (
	"errors"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
)

// TestEnsureVariant_CleanCompletionNotRestarted is the regression test for
// issues #172 / #174. A remux variant copies the source video far faster than
// realtime, so its FFmpeg can run to EOF and exit cleanly (v.Err == nil) —
// having written a complete VOD playlist (#EXT-X-ENDLIST) — within a single
// viewing session. ffmpegDone() is then true, but that is a CLEAN COMPLETION,
// not a crash: EnsureVariant must return the finished variant so its playlist
// is served, and must NOT attempt the mid-stream restart (which seeks FFmpeg
// past EOF, produces nothing, and then 500s every subsequent variant-playlist
// fetch — breaking Chromecast, which can't bootstrap from a 500).
//
// Without the fix this case would fall into the restart path and call
// startVariantAt (launching FFmpeg), bumping restartAttempts and clearing
// `started`. The assertions below pin the corrected behaviour.
func TestEnsureVariant_CleanCompletionNotRestarted(t *testing.T) {
	base := t.TempDir()
	tm, err := NewTranscodeManager(base, config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	ready := make(chan struct{})
	close(ready) // a completed variant has already closed Ready
	v := &QualityVariant{
		Profile: QualityProfile{Name: "source"},
		Ready:   ready,
		started: true,
		exited:  true, // FFmpeg exited...
		Err:     nil,  // ...cleanly: ran to EOF and wrote the final playlist
	}
	s := &TranscodeSession{
		ID:         "sess-clean",
		Variants:   map[string]*QualityVariant{"source": v},
		LastAccess: time.Now(),
		Remux:      true,
	}

	got, err := tm.EnsureVariant(s, "source", 0)
	if err != nil {
		t.Fatalf("EnsureVariant on a cleanly-completed variant returned error: %v", err)
	}
	if got != v {
		t.Fatal("EnsureVariant returned a different variant; want the completed one served as-is")
	}
	if v.restartAttempts != 0 {
		t.Errorf("restartAttempts = %d, want 0 — a clean completion must NOT trigger a restart", v.restartAttempts)
	}
	if !v.started {
		t.Error("v.started was reset to false — a restart was wrongly attempted on a clean completion")
	}
}

// TestEnsureVariant_CrashStillSurfacesError confirms the #172/#174 fix does not
// mask a genuine mid-stream crash. A variant that exited WITH an error and has
// exhausted its restart budget must still surface a terminal error (→ HTTP 500)
// so the frontend recovers by creating a fresh session.
func TestEnsureVariant_CrashStillSurfacesError(t *testing.T) {
	base := t.TempDir()
	tm, err := NewTranscodeManager(base, config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	ready := make(chan struct{})
	close(ready)
	crashErr := errors.New("ffmpeg stderr tail: Conversion failed")
	v := &QualityVariant{
		Profile:         QualityProfile{Name: "source"},
		Ready:           ready,
		started:         true,
		exited:          true,
		Err:             crashErr,          // a real crash, not a clean exit
		restartAttempts: variantRestartMax, // budget spent → skip restart, surface error
	}
	s := &TranscodeSession{
		ID:         "sess-crash",
		Variants:   map[string]*QualityVariant{"source": v},
		LastAccess: time.Now(),
		Remux:      true,
	}

	if _, err := tm.EnsureVariant(s, "source", 0); err == nil {
		t.Fatal("EnsureVariant on a crashed variant with no restart budget returned nil; want a terminal error")
	} else if !errors.Is(err, crashErr) {
		t.Errorf("returned error %q does not wrap the underlying crash error", err)
	}
}
