package recommender

import (
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// TestSurfaceArgs pins the gate that makes anti-repetition a clean no-op when
// disabled: window 0 → ("", 0) so NearestUnwatched behaves exactly as before.
func TestSurfaceArgs(t *testing.T) {
	h := &Hero{repeatWindow: 72 * time.Hour}
	if s, sec := h.surfaceArgs(surfaceHero); s != surfaceHero || sec != int64((72*time.Hour).Seconds()) {
		t.Errorf("enabled: got (%q, %d), want (%q, %d)", s, sec, surfaceHero, int64((72 * time.Hour).Seconds()))
	}
	h0 := &Hero{repeatWindow: 0}
	if s, sec := h0.surfaceArgs(surfaceDiscover); s != "" || sec != 0 {
		t.Errorf("disabled: got (%q, %d), want (\"\", 0)", s, sec)
	}
}

// TestSetRepeatWindow: New defaults to the configured window; SetRepeatWindow
// applies overrides and clamps negatives to 0 (disabled).
func TestSetRepeatWindow(t *testing.T) {
	h := New(nil, nil)
	if h.repeatWindow != surfacedRepeatWindowDefault {
		t.Errorf("New default = %v, want %v", h.repeatWindow, surfacedRepeatWindowDefault)
	}
	h.SetRepeatWindow(48 * time.Hour)
	if h.repeatWindow != 48*time.Hour {
		t.Errorf("SetRepeatWindow(48h) → %v", h.repeatWindow)
	}
	h.SetRepeatWindow(0)
	if h.repeatWindow != 0 {
		t.Errorf("SetRepeatWindow(0) → %v, want 0 (disabled)", h.repeatWindow)
	}
	h.SetRepeatWindow(-5 * time.Hour)
	if h.repeatWindow != 0 {
		t.Errorf("negative window should clamp to 0, got %v", h.repeatWindow)
	}
}

// TestPickItemIDs / TestRailItemIDs: extraction skips nil items (never panics)
// and flattens in order — these feed RecordSurfaced.
func TestPickItemIDs(t *testing.T) {
	picks := []HeroPick{
		{Item: &models.MediaItem{ID: 7}},
		{Item: nil},
		{Item: &models.MediaItem{ID: 9}},
	}
	if got := pickItemIDs(picks); len(got) != 2 || got[0] != 7 || got[1] != 9 {
		t.Errorf("pickItemIDs = %v, want [7 9]", got)
	}
	if got := pickItemIDs(nil); len(got) != 0 {
		t.Errorf("nil picks → %v, want empty", got)
	}
}

func TestRailItemIDs(t *testing.T) {
	rails := []DiscoverRail{
		{Items: []*models.MediaItem{{ID: 1}, nil, {ID: 2}}},
		{Items: []*models.MediaItem{{ID: 3}}},
		{Items: nil},
	}
	if got := railItemIDs(rails); len(got) != 3 || got[0] != 1 || got[1] != 2 || got[2] != 3 {
		t.Errorf("railItemIDs = %v, want [1 2 3]", got)
	}
}
