package recommender

import (
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// TestDedupRailsInOrder pins the cross-rail first-wins de-dup + empty-drop that
// keeps each title in at most one engagement rail.
func TestDedupRailsInOrder(t *testing.T) {
	mk := func(ids ...int64) []*models.MediaItem {
		out := make([]*models.MediaItem, len(ids))
		for i, id := range ids {
			out[i] = &models.MediaItem{ID: id}
		}
		return out
	}
	out := dedupRailsInOrder([]EngagementRail{
		{Title: "A", Items: mk(1, 2, 3)},
		{Title: "B", Items: mk(2, 4)}, // 2 already in A → drop; 4 kept
		{Title: "C", Items: mk(1, 3)}, // both already shown → rail empty → dropped
		{Title: "D", Items: nil},      // empty → dropped
		{Title: "E", Items: mk(5)},
	})
	if len(out) != 3 {
		t.Fatalf("want 3 rails (A,B,E), got %d: %+v", len(out), out)
	}
	if out[0].Title != "A" || len(out[0].Items) != 3 {
		t.Errorf("A should keep all 3: %+v", out[0])
	}
	if out[1].Title != "B" || len(out[1].Items) != 1 || out[1].Items[0].ID != 4 {
		t.Errorf("B should keep only id 4: %+v", out[1])
	}
	if out[2].Title != "E" || out[2].Items[0].ID != 5 {
		t.Errorf("E should survive: %+v", out[2])
	}

	// nil items are skipped, never panic.
	got := dedupRailsInOrder([]EngagementRail{{Title: "N", Items: []*models.MediaItem{nil, {ID: 9}, nil}}})
	if len(got) != 1 || len(got[0].Items) != 1 || got[0].Items[0].ID != 9 {
		t.Errorf("nil items should be skipped: %+v", got)
	}
}
