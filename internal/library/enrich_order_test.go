package library

import (
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// Full enrichments and episode backfills share the per-scan dedup map, so a
// backfill that runs before the same show's full enrichment would mark the
// show done and starve the full pass. orderPendingEnrich must therefore put
// every full enrichment first, preserving relative order within each group.
func TestOrderPendingEnrichFullEnrichmentsFirst(t *testing.T) {
	mk := func(id int64, backfill bool) *pendingEnrichItem {
		return &pendingEnrichItem{item: &models.MediaItem{ID: id}, episodeBackfillOnly: backfill}
	}
	pending := []*pendingEnrichItem{
		mk(1, true),  // backfill raced ahead of its show's full enrichment
		mk(2, false), // full enrichment for another show
		mk(1, false), // full enrichment for show 1
		mk(3, true),
	}

	ordered := orderPendingEnrich(pending)
	if len(ordered) != len(pending) {
		t.Fatalf("expected %d entries, got %d", len(pending), len(ordered))
	}
	want := []struct {
		id       int64
		backfill bool
	}{{2, false}, {1, false}, {1, true}, {3, true}}
	for i, w := range want {
		if ordered[i].item.ID != w.id || ordered[i].episodeBackfillOnly != w.backfill {
			t.Fatalf("position %d: expected (id=%d backfill=%v), got (id=%d backfill=%v)",
				i, w.id, w.backfill, ordered[i].item.ID, ordered[i].episodeBackfillOnly)
		}
	}
}
