package streaming

// Where a cast clone's FFmpeg -ss anchor lands.
//
// A clone is a brand-new encode. It used to inherit the SOURCE session's
// anchor, which is correct arithmetic and useless readiness: a viewer 40
// minutes into a session anchored at 0 got a clone that also started at 0 and
// was then asked to seek 40 minutes into it. Sequential encoding means the
// receiver waits for the encoder — ~10 minutes at readRateFactor — showing the
// issue #172 symptom of a receiver that connects and never plays.
//
// These tests pin the anchor arithmetic and the one case that must NOT move:
// the session the local player is itself using.

import (
	"testing"

	"github.com/aurora-media/aurora/internal/config"
)

func TestCastCloneAnchorSec(t *testing.T) {
	cases := []struct {
		name        string
		srcStartSec int
		atSec       int
		want        int
	}{
		{
			// The sentinel every caller that only cares about the clone's
			// codec/subtitle shape passes. Pre-2026-09 behaviour exactly.
			name:        "no preference inherits the source anchor",
			srcStartSec: 900,
			atSec:       -1,
			want:        900,
		},
		{
			// The headline case: 40 minutes into a session anchored at 0.
			name:        "midstream anchors near the sender, not at the source anchor",
			srcStartSec: 0,
			atSec:       2400,
			want:        2400 - castAnchorPadSec,
		},
		{
			// The pad may not push the anchor negative.
			name:        "the pad floors at zero",
			srcStartSec: 0,
			atSec:       3,
			want:        0,
		},
		{
			name:        "exactly at the pad still floors at zero",
			srcStartSec: 0,
			atSec:       castAnchorPadSec,
			want:        0,
		},
		{
			// A resumed session is already anchored deep into the file; the
			// clone follows the SENDER, not that anchor.
			name:        "a resumed source does not pin the clone",
			srcStartSec: 1800,
			atSec:       1830,
			want:        1830 - castAnchorPadSec,
		},
		{
			// Casting near the start of a session resumed deep into a file
			// means anchoring BEFORE the source's own -ss. That is legal:
			// the anchor addresses the file, not the source session.
			name:        "the clone may anchor before the source anchor",
			srcStartSec: 1800,
			atSec:       60,
			want:        60 - castAnchorPadSec,
		},
		{
			name:        "a garbage far-future position is capped",
			srcStartSec: 0,
			atSec:       1 << 30,
			want:        maxCastAnchorSec - castAnchorPadSec,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := castCloneAnchorSec(tc.srcStartSec, tc.atSec); got != tc.want {
				t.Fatalf("castCloneAnchorSec(%d, %d) = %d, want %d",
					tc.srcStartSec, tc.atSec, got, tc.want)
			}
		})
	}
}

// The pad exists to buy BACKWARD headroom: a receiver can seek forward
// anywhere inside what the clone has produced, but never before the clone's
// own anchor. Anchoring at or after the sender would create that dead end
// deliberately, so the direction is the invariant — not the magnitude.
func TestCastCloneAnchorIsNeverAheadOfTheSender(t *testing.T) {
	for at := 0; at < 5000; at += 7 {
		if got := castCloneAnchorSec(0, at); got > at {
			t.Fatalf("anchor %d is ahead of the sender position %d", got, at)
		}
	}
}

// The pad has to fit inside the unthrottled burst every variant launch gets,
// or it stops being free: past the burst, FFmpeg is capped at readRateFactor×
// realtime and the receiver waits on the encoder for the padded seconds.
func TestCastAnchorPadFitsInsideTheInitialBurst(t *testing.T) {
	burst := atoiOrFatal(t, readRateInitialBurstSec)
	if castAnchorPadSec > burst {
		t.Fatalf("castAnchorPadSec (%d) exceeds readRateInitialBurstSec (%d): the pad "+
			"would be paced rather than burst, so it is no longer free",
			castAnchorPadSec, burst)
	}
}

// The clone actually carries the chosen anchor through CreateSession — the
// unit above only pins the arithmetic.
func TestCloneForCast_AnchorsTheCloneAtTheSenderPosition(t *testing.T) {
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
		SourceWidth:      1920,
		SourceHeight:     1080,
		Remux:            true, // forces a clone (#324)
		SourceVideoCodec: "h264",
		AudioCodecOut:    "aac",
		AudioTrackIndex:  -1,
		BurnSubIndex:     -1,
		BurnSubRelIndex:  -1,
		StartSec:         0,
	}
	tm.mu.Lock()
	tm.sessions[src.ID] = src
	tm.mu.Unlock()

	clone, err := tm.CloneForCast(7, "ronnie", src.ID, 2400)
	if err != nil {
		t.Fatalf("CloneForCast: %v", err)
	}
	if clone.ID == src.ID {
		t.Fatal("expected a clone for this fixture")
	}
	if want := 2400 - castAnchorPadSec; clone.StartSec != want {
		t.Fatalf("clone.StartSec = %d, want %d (the sender's position less the pad); "+
			"inheriting the source's %d is the bug this closes",
			clone.StartSec, want, src.StartSec)
	}
}

// The one session that must never be re-anchored: when no clone is needed the
// receiver shares the LOCAL player's session, and moving its -ss would restart
// the encode under the browser that is playing it.
func TestCloneForCast_SharedSessionKeepsItsOwnAnchor(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	// Cast-safe as-is: a transcode emitting H.264 + AAC with no subtitle
	// tracks, so CloneForCast returns it unchanged.
	src := &TranscodeSession{
		ID:               "src-local",
		UserID:           7,
		FilePath:         "/library/movie/halloweentown.mkv",
		SourceWidth:      1920,
		SourceHeight:     1080,
		Remux:            false,
		SourceVideoCodec: "h264",
		VideoCodecOut:    "h264",
		AudioCodecOut:    "aac",
		AudioTrackIndex:  -1,
		BurnSubIndex:     -1,
		BurnSubRelIndex:  -1,
		StartSec:         600,
	}
	tm.mu.Lock()
	tm.sessions[src.ID] = src
	tm.mu.Unlock()

	got, err := tm.CloneForCast(7, "ronnie", src.ID, 2400)
	if err != nil {
		t.Fatalf("CloneForCast: %v", err)
	}
	if got.ID != src.ID {
		t.Fatalf("expected the shared session back, got a clone (%s)", got.ID)
	}
	if got.StartSec != 600 {
		t.Fatalf("shared session StartSec = %d, want 600 — re-anchoring it would "+
			"restart the encode the local player is reading", got.StartSec)
	}
}

func atoiOrFatal(t *testing.T, s string) int {
	t.Helper()
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			t.Fatalf("not a number: %q", s)
		}
		n = n*10 + int(c-'0')
	}
	return n
}
