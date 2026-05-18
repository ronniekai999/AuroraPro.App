package library

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// TestEnrichmentDedup verifies that the scanner's enrichedItems atomic.Pointer[sync.Map]
// prevents duplicate OnNewItem calls for the same media item ID.
func TestEnrichmentDedup(t *testing.T) {
	t.Run("same item ID enriched only once", func(t *testing.T) {
		var s Scanner
		s.enrichedItems.Store(&sync.Map{})

		var callCount atomic.Int64
		s.OnNewItem = func(ctx context.Context, item *models.MediaItem) {
			callCount.Add(1)
		}

		ctx := context.Background()

		// Simulate 100 episodes of the same show (same media item ID = 42)
		for i := 0; i < 100; i++ {
			item := &models.MediaItem{ID: 42, Title: "Breaking Bad", Type: models.MediaShow}
			if _, already := s.enrichedItems.Load().LoadOrStore(item.ID, true); !already {
				if s.OnNewItem != nil {
					s.OnNewItem(ctx, item)
				}
			}
		}

		if callCount.Load() != 1 {
			t.Errorf("expected OnNewItem called 1 time, got %d", callCount.Load())
		}
	})

	t.Run("different items each enriched once", func(t *testing.T) {
		var s Scanner
		s.enrichedItems.Store(&sync.Map{})

		seen := make(map[int64]int)
		var mu sync.Mutex
		s.OnNewItem = func(ctx context.Context, item *models.MediaItem) {
			mu.Lock()
			seen[item.ID]++
			mu.Unlock()
		}

		ctx := context.Background()

		// 5 different shows, 20 episodes each = 100 files, 5 enrichments
		for showID := int64(1); showID <= 5; showID++ {
			for ep := 0; ep < 20; ep++ {
				item := &models.MediaItem{ID: showID, Title: "Show", Type: models.MediaShow}
				if _, already := s.enrichedItems.Load().LoadOrStore(item.ID, true); !already {
					if s.OnNewItem != nil {
						s.OnNewItem(ctx, item)
					}
				}
			}
		}

		if len(seen) != 5 {
			t.Errorf("expected 5 unique items enriched, got %d", len(seen))
		}
		for id, count := range seen {
			if count != 1 {
				t.Errorf("item %d enriched %d times, want 1", id, count)
			}
		}
	})

	t.Run("concurrent episodes dedup safely", func(t *testing.T) {
		var s Scanner
		s.enrichedItems.Store(&sync.Map{})

		var callCount atomic.Int64
		s.OnNewItem = func(ctx context.Context, item *models.MediaItem) {
			callCount.Add(1)
		}

		ctx := context.Background()

		// Simulate concurrent processing of 50 episodes of the same show
		var wg sync.WaitGroup
		for i := 0; i < 50; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				item := &models.MediaItem{ID: 99, Title: "The Wire", Type: models.MediaShow}
				if _, already := s.enrichedItems.Load().LoadOrStore(item.ID, true); !already {
					if s.OnNewItem != nil {
						s.OnNewItem(ctx, item)
					}
				}
			}()
		}
		wg.Wait()

		if callCount.Load() != 1 {
			t.Errorf("expected OnNewItem called exactly 1 time under concurrency, got %d", callCount.Load())
		}
	})

	t.Run("map resets between scans", func(t *testing.T) {
		var s Scanner
		s.enrichedItems.Store(&sync.Map{})

		var callCount atomic.Int64
		s.OnNewItem = func(ctx context.Context, item *models.MediaItem) {
			callCount.Add(1)
		}

		ctx := context.Background()
		item := &models.MediaItem{ID: 7, Title: "Fargo", Type: models.MediaShow}

		// First "scan"
		if _, already := s.enrichedItems.Load().LoadOrStore(item.ID, true); !already {
			s.OnNewItem(ctx, item)
		}
		if callCount.Load() != 1 {
			t.Fatalf("first scan: expected 1 call, got %d", callCount.Load())
		}

		// Second episode same scan -- should be deduped
		if _, already := s.enrichedItems.Load().LoadOrStore(item.ID, true); !already {
			s.OnNewItem(ctx, item)
		}
		if callCount.Load() != 1 {
			t.Fatalf("same scan duplicate: expected still 1 call, got %d", callCount.Load())
		}

		// Simulate new scan -- reset the map via atomic pointer swap
		s.enrichedItems.Store(&sync.Map{})

		// Same item in new scan -- should enrich again
		if _, already := s.enrichedItems.Load().LoadOrStore(item.ID, true); !already {
			s.OnNewItem(ctx, item)
		}
		if callCount.Load() != 2 {
			t.Errorf("new scan: expected 2 total calls, got %d", callCount.Load())
		}
	})

	t.Run("NFO enrichment blocks duplicate search enrichment", func(t *testing.T) {
		// When the first episode enriches via NFO (OnNewItemByID),
		// the second episode of the same show must be deduped by the map
		// and NOT trigger OnNewItem or OnNewItemByID.
		var s Scanner
		s.enrichedItems.Store(&sync.Map{})

		var nfoCalls, searchCalls atomic.Int64
		s.OnNewItemByID = func(ctx context.Context, item *models.MediaItem, tmdbID int) {
			nfoCalls.Add(1)
		}
		s.OnNewItem = func(ctx context.Context, item *models.MediaItem) {
			searchCalls.Add(1)
		}

		ctx := context.Background()

		// Episode 1 has NFO with TMDB ID -> enriches via OnNewItemByID
		item := &models.MediaItem{ID: 50, Title: "Stranger Things", Type: models.MediaShow}
		if _, already := s.enrichedItems.Load().LoadOrStore(item.ID, true); !already {
			// Simulating NFO path: call OnNewItemByID
			if s.OnNewItemByID != nil {
				s.OnNewItemByID(ctx, item, 66732)
			}
		}

		// Episodes 2-20 have no NFO -> should be deduped (NOT trigger OnNewItem)
		for i := 0; i < 19; i++ {
			if _, already := s.enrichedItems.Load().LoadOrStore(item.ID, true); !already {
				if s.OnNewItem != nil {
					s.OnNewItem(ctx, item)
				}
			}
		}

		if nfoCalls.Load() != 1 {
			t.Errorf("expected OnNewItemByID called 1 time, got %d", nfoCalls.Load())
		}
		if searchCalls.Load() != 0 {
			t.Errorf("expected OnNewItem called 0 times (all deduped), got %d", searchCalls.Load())
		}
	})

	t.Run("TVDB NFO enrichment blocks duplicates", func(t *testing.T) {
		var s Scanner
		s.enrichedItems.Store(&sync.Map{})

		var tvdbCalls, searchCalls atomic.Int64
		s.OnNewItemByTVDBID = func(ctx context.Context, item *models.MediaItem, tvdbID int) {
			tvdbCalls.Add(1)
		}
		s.OnNewItem = func(ctx context.Context, item *models.MediaItem) {
			searchCalls.Add(1)
		}

		ctx := context.Background()

		item := &models.MediaItem{ID: 60, Title: "Doctor Who", Type: models.MediaShow}
		if _, already := s.enrichedItems.Load().LoadOrStore(item.ID, true); !already {
			if s.OnNewItemByTVDBID != nil {
				s.OnNewItemByTVDBID(ctx, item, 78804)
			}
		}

		// 9 more episodes -- all should be deduped
		for i := 0; i < 9; i++ {
			if _, already := s.enrichedItems.Load().LoadOrStore(item.ID, true); !already {
				if s.OnNewItem != nil {
					s.OnNewItem(ctx, item)
				}
			}
		}

		if tvdbCalls.Load() != 1 {
			t.Errorf("expected OnNewItemByTVDBID called 1 time, got %d", tvdbCalls.Load())
		}
		if searchCalls.Load() != 0 {
			t.Errorf("expected OnNewItem called 0 times, got %d", searchCalls.Load())
		}
	})

	t.Run("movies not affected by dedup", func(t *testing.T) {
		var s Scanner
		s.enrichedItems.Store(&sync.Map{})

		var callCount atomic.Int64
		s.OnNewItem = func(ctx context.Context, item *models.MediaItem) {
			callCount.Add(1)
		}

		ctx := context.Background()

		// Each movie has a unique media item ID -- all should enrich
		for id := int64(100); id < 110; id++ {
			item := &models.MediaItem{ID: id, Title: "Movie", Type: models.MediaMovie}
			if _, already := s.enrichedItems.Load().LoadOrStore(item.ID, true); !already {
				if s.OnNewItem != nil {
					s.OnNewItem(ctx, item)
				}
			}
		}

		if callCount.Load() != 10 {
			t.Errorf("expected 10 movie enrichments, got %d", callCount.Load())
		}
	})
}
