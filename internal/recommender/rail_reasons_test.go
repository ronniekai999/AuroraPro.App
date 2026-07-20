package recommender

import (
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// storeFillResults is the vet+cache half of the async rail-reason fill,
// split out so its guards are testable without an LLM. A zero-value Hero is
// sufficient — the method only touches reasonCache and the epoch map.

func railFillItems() []*models.MediaItem {
	return []*models.MediaItem{
		{ID: 10, Title: "The 'Burbs", Genres: []string{"Comedy"}, ContentRating: "PG-13"},
		{ID: 20, Title: "The Exorcist", Genres: []string{"Drama", "Horror"}, ContentRating: "R"},
		{ID: 30, Title: "Severance", Genres: []string{"Drama", "Sci-Fi"}, ContentRating: "TV-MA"},
	}
}

func loadEntry(t *testing.T, h *Hero, profileID, itemID int64) (railReasonEntry, bool) {
	t.Helper()
	v, ok := h.reasonCache.Load(railReasonKey{profileID: profileID, itemID: itemID})
	if !ok {
		return railReasonEntry{}, false
	}
	return v.(railReasonEntry), true
}

func TestStoreFillResults_VetsAndNegativeCaches(t *testing.T) {
	h := &Hero{}
	items := railFillItems()
	specs := []railReasonPickSpec{
		{Index: 1, Reason: "A supernatural drama with a dark, atmospheric tone"}, // contradiction on [Comedy] → veto
		{Index: 2, Reason: "Family-friendly fantasy edge"},                       // family words on R → veto
		{Index: 3, Reason: "Because you finished Severance"},                     // clean
	}
	epoch := h.epochFor(1).Load()
	stored, vetoed, ok := h.storeFillResults(1, items, specs, epoch)
	if !ok || stored != 1 || vetoed != 2 {
		t.Fatalf("storeFillResults = (stored=%d, vetoed=%d, ok=%v), want (1, 2, true)", stored, vetoed, ok)
	}
	// Vetoed blurbs become NEGATIVE entries (empty reason, present in cache)
	// so the fill isn't re-requested every render inside the negative TTL.
	for _, id := range []int64{10, 20} {
		e, found := loadEntry(t, h, 1, id)
		if !found || e.reason != "" {
			t.Errorf("item %d: want negative cache entry, got (found=%v, reason=%q)", id, found, e.reason)
		}
	}
	if e, found := loadEntry(t, h, 1, 30); !found || e.reason != "Because you finished Severance" {
		t.Errorf("item 30: want stored clean reason, got (found=%v, reason=%q)", found, e.reason)
	}
}

func TestStoreFillResults_EpochGuardDropsStaleFill(t *testing.T) {
	h := &Hero{}
	items := railFillItems()
	specs := []railReasonPickSpec{{Index: 3, Reason: "Because you finished Severance"}}
	epoch := h.epochFor(1).Load()
	// Invalidate mid-flight: the epoch advances, so the fill's results are
	// stale and must be dropped wholesale — including would-be negative
	// entries, which would otherwise gag regeneration despite the user's
	// taste having just changed.
	h.Invalidate(1)
	stored, vetoed, ok := h.storeFillResults(1, items, specs, epoch)
	if ok || stored != 0 || vetoed != 0 {
		t.Fatalf("stale fill must store nothing: got (stored=%d, vetoed=%d, ok=%v)", stored, vetoed, ok)
	}
	if _, found := loadEntry(t, h, 1, 30); found {
		t.Error("stale fill wrote a cache entry despite the epoch mismatch")
	}
}

func TestStoreFillResults_DuplicateSpecFirstWins(t *testing.T) {
	h := &Hero{}
	items := railFillItems()
	specs := []railReasonPickSpec{
		{Index: 3, Reason: "Because you finished Severance"},
		// Duplicate index whose blurb would be vetoed (overlong): it must
		// NOT overwrite the good entry above with a negative one.
		{Index: 3, Reason: screenshotBurbsBlurb},
	}
	epoch := h.epochFor(1).Load()
	stored, vetoed, ok := h.storeFillResults(1, items, specs, epoch)
	if !ok || stored != 1 || vetoed != 0 {
		t.Fatalf("storeFillResults = (stored=%d, vetoed=%d, ok=%v), want (1, 0, true)", stored, vetoed, ok)
	}
	if e, found := loadEntry(t, h, 1, 30); !found || e.reason != "Because you finished Severance" {
		t.Errorf("duplicate veto overwrote the good reason: (found=%v, reason=%q)", found, e.reason)
	}
}

func TestHasFreshReasonEntry_NegativeTTLShorterThanPositive(t *testing.T) {
	h := &Hero{}
	// Two hours old: past the 1h negative TTL, well inside the 24h positive.
	stale := time.Now().Add(-2 * time.Hour)
	h.reasonCache.Store(railReasonKey{profileID: 1, itemID: 10}, railReasonEntry{reason: "", addedAt: stale})
	h.reasonCache.Store(railReasonKey{profileID: 1, itemID: 20}, railReasonEntry{reason: "kept", addedAt: stale})
	if h.hasFreshReasonEntry(1, 10) {
		t.Error("negative entry older than railReasonNegativeTTL must not read as fresh (veto would never retry)")
	}
	if !h.hasFreshReasonEntry(1, 20) {
		t.Error("positive entry inside railReasonTTL must read as fresh")
	}
	// A fresh negative entry DOES suppress refill — that's the point of the
	// negative cache.
	h.reasonCache.Store(railReasonKey{profileID: 1, itemID: 30}, railReasonEntry{reason: "", addedAt: time.Now()})
	if !h.hasFreshReasonEntry(1, 30) {
		t.Error("fresh negative entry must read as fresh (suppresses per-render re-asks)")
	}
}

func TestAttachCachedReasons_EvictsExpiredNegative(t *testing.T) {
	h := &Hero{}
	items := []*models.MediaItem{{ID: 10}}
	h.reasonCache.Store(railReasonKey{profileID: 1, itemID: 10},
		railReasonEntry{reason: "", addedAt: time.Now().Add(-2 * time.Hour)})
	h.attachCachedReasons(1, items)
	if items[0].Reason != "" {
		t.Errorf("negative entry must never attach a reason, got %q", items[0].Reason)
	}
	if _, found := loadEntry(t, h, 1, 10); found {
		t.Error("expired negative entry should be lazily evicted by attachCachedReasons")
	}
}
