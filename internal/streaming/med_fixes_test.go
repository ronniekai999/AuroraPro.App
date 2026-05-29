package streaming

import (
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// TestSubtitleRelativeIndex covers the absolute→subtitle-relative translation
// used by the burn-in `subtitles` filter (audit MED). The filter's stream_index
// counts ONLY subtitle streams, so an absolute ffprobe index must be mapped to
// its position among subtitle tracks.
func TestSubtitleRelativeIndex(t *testing.T) {
	// Typical MKV: stream 0 = video, 1 = audio, 2/3/4 = subtitles.
	tracks := []models.SubtitleTrack{
		{Index: 2},
		{Index: 3},
		{Index: 4},
	}

	tests := []struct {
		name     string
		tracks   []models.SubtitleTrack
		absolute int
		want     int
	}{
		{"first sub (abs 2) -> rel 0", tracks, 2, 0},
		{"second sub (abs 3) -> rel 1", tracks, 3, 1},
		{"third sub (abs 4) -> rel 2", tracks, 4, 2},
		// Not a subtitle stream / stale index: fall back to absolute (pre-fix).
		{"unknown abs index falls back to absolute", tracks, 1, 1},
		{"unknown high index falls back to absolute", tracks, 9, 9},
		// Empty probe result: fall back to absolute unchanged.
		{"nil tracks falls back to absolute", nil, 3, 3},
		{"empty tracks falls back to absolute", []models.SubtitleTrack{}, 0, 0},
		// Single subtitle that is itself stream 0 (audio-less / sub-first file).
		{"sub at abs 0 -> rel 0", []models.SubtitleTrack{{Index: 0}}, 0, 0},
		// Non-contiguous absolute indices (multiple audio tracks between subs).
		{"non-contiguous: abs 5 -> rel 1", []models.SubtitleTrack{{Index: 3}, {Index: 5}}, 5, 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SubtitleRelativeIndex(tt.tracks, tt.absolute)
			if got != tt.want {
				t.Errorf("SubtitleRelativeIndex(%v, %d) = %d, want %d", tt.tracks, tt.absolute, got, tt.want)
			}
		})
	}
}

// TestEffectiveMaxSessions verifies the unlimited-cap clamp (audit MED): a
// configured value of <= 0 must resolve to the bounded default ceiling so
// concurrent transcodes are always limited, while a positive value passes
// through unchanged.
func TestEffectiveMaxSessions(t *testing.T) {
	tests := []struct {
		name       string
		configured int
		want       int
	}{
		{"zero clamps to default", 0, defaultMaxSessions},
		{"negative clamps to default", -1, defaultMaxSessions},
		{"large negative clamps to default", -100, defaultMaxSessions},
		{"positive passes through", 1, 1},
		{"positive passes through (5)", 5, 5},
		{"large positive passes through", 1000, 1000},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := effectiveMaxSessions(tt.configured); got != tt.want {
				t.Errorf("effectiveMaxSessions(%d) = %d, want %d", tt.configured, got, tt.want)
			}
		})
	}

	// The default ceiling must be a sane, strictly-positive bound.
	if defaultMaxSessions <= 0 {
		t.Fatalf("defaultMaxSessions must be > 0, got %d", defaultMaxSessions)
	}
}
