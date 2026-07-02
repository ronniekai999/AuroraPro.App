package library

import (
	"reflect"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// A season-pack import produces one backfill signal per new file; the map
// must collapse them to one entry per show with the union of touched seasons
// (so the deferred pass costs one TMDB call per touched season, not per file).
func TestAddPendingBackfillAggregatesPerShow(t *testing.T) {
	m := make(map[int64]*episodeBackfillEntry)
	show1 := &models.MediaItem{ID: 1}
	show2 := &models.MediaItem{ID: 2}

	addPendingBackfill(m, show1, 2)
	addPendingBackfill(m, show1, 2) // duplicate file in same season
	addPendingBackfill(m, show1, 4)
	addPendingBackfill(m, show2, 1)
	addPendingBackfill(m, show2, 0) // parser couldn't determine — no season recorded

	if len(m) != 2 {
		t.Fatalf("expected 2 shows, got %d", len(m))
	}
	if got := m[1].sortedSeasons(); !reflect.DeepEqual(got, []int{2, 4}) {
		t.Fatalf("show 1: expected seasons [2 4], got %v", got)
	}
	if got := m[2].sortedSeasons(); !reflect.DeepEqual(got, []int{1}) {
		t.Fatalf("show 2: expected seasons [1], got %v", got)
	}
}
