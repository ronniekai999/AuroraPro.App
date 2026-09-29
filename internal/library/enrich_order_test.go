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

// The full-enrichment queue dedups per show, like the backfill map. Without it a
// show not yet attempted contributes one entry per new file — thousands on a
// large library — and the "enriching TV shows full=N" log counts files rather
// than shows. First-wins is load-bearing: enrichNewItem reads the retained
// entry's filePath to find a sibling .nfo.
func TestAddPendingFullDedupsPerShowAndKeepsTheFirstEntry(t *testing.T) {
	seen := make(map[int64]struct{})
	var pending []*pendingEnrichItem
	show1 := &models.MediaItem{ID: 1}
	show2 := &models.MediaItem{ID: 2}

	pending = addPendingFull(seen, pending, &pendingEnrichItem{item: show1, filePath: "/s1/e01.mkv"})
	pending = addPendingFull(seen, pending, &pendingEnrichItem{item: show1, filePath: "/s1/e02.mkv"})
	pending = addPendingFull(seen, pending, &pendingEnrichItem{item: show1, filePath: "/s1/e03.mkv"})
	pending = addPendingFull(seen, pending, &pendingEnrichItem{item: show2, filePath: "/s2/e01.mkv"})

	if len(pending) != 2 {
		t.Fatalf("expected one entry per show, got %d", len(pending))
	}
	if pending[0].item.ID != 1 || pending[1].item.ID != 2 {
		t.Fatalf("expected shows [1 2] in first-seen order, got [%d %d]", pending[0].item.ID, pending[1].item.ID)
	}
	if pending[0].filePath != "/s1/e01.mkv" {
		t.Errorf("kept filePath %q, want the FIRST file's — enrichNewItem resolves the .nfo from it", pending[0].filePath)
	}
}
