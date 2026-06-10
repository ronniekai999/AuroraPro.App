package api

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	ws "github.com/aurora-media/aurora/internal/websocket"
)

// fakeHeroProvider is a minimal HeroProvider for exercising the non-blocking
// Discover build state machine. Only DiscoverFor / DiscoverCached carry
// behaviour; the rest satisfy the interface.
type fakeHeroProvider struct {
	calls   int32 // DiscoverFor invocations (atomic)
	entered chan struct{}
	release chan struct{}            // when non-nil, DiscoverFor blocks until closed/sent
	rails   []DiscoverRail           // result returned by DiscoverFor
	cached  map[int64][]DiscoverRail // DiscoverCached hits
}

func (f *fakeHeroProvider) PoolFor(context.Context, int64) ([]HeroPick, error) { return nil, nil }
func (f *fakeHeroProvider) RailFor(context.Context, int64, int) ([]*models.MediaItem, error) {
	return nil, nil
}
func (f *fakeHeroProvider) DiscoverFor(context.Context, int64) ([]DiscoverRail, error) {
	atomic.AddInt32(&f.calls, 1)
	if f.entered != nil {
		f.entered <- struct{}{}
	}
	if f.release != nil {
		<-f.release
	}
	return f.rails, nil
}
func (f *fakeHeroProvider) DiscoverCached(profileID int64) ([]DiscoverRail, bool) {
	r, ok := f.cached[profileID]
	return r, ok
}
func (f *fakeHeroProvider) AnchorRailsFor(context.Context, int64) ([]AnchorRail, error) {
	return nil, nil
}
func (f *fakeHeroProvider) EngagementRailsFor(context.Context, int64) ([]EngagementRail, error) {
	return nil, nil
}
func (f *fakeHeroProvider) Invalidate(int64) {}

// fakeHub records discover_ready broadcasts.
type fakeHub struct {
	events chan broadcast
}
type broadcast struct {
	userID    int64
	eventType string
	data      interface{}
}

func (h *fakeHub) BroadcastToUser(userID int64, eventType string, data interface{}) {
	h.events <- broadcast{userID, eventType, data}
}

func newTestHeroHandler(prov HeroProvider, hub HubBroadcaster) *HeroHandler {
	h := NewHeroHandler(nil)
	h.SetHeroProvider(prov)
	h.SetHub(hub)
	return h
}

// TestKickDiscoverBuild_BuildingThenBroadcast: a cold kick returns "building"
// immediately and, when the background build completes, pushes a discover_ready
// event to the right user with the right profile_id. This is the core of the
// fix — the slow LLM result now reaches the open page instead of being
// discarded.
func TestKickDiscoverBuild_BuildingThenBroadcast(t *testing.T) {
	prov := &fakeHeroProvider{rails: []DiscoverRail{{Title: "Slow-burn neo-noir"}}}
	hub := &fakeHub{events: make(chan broadcast, 1)}
	h := newTestHeroHandler(prov, hub)

	const profileID, userID = int64(7), int64(42)
	if got := h.kickDiscoverBuild(context.Background(), profileID, userID); got != "building" {
		t.Fatalf("cold kick status = %q, want building", got)
	}

	select {
	case ev := <-hub.events:
		if ev.eventType != ws.EventDiscoverReady {
			t.Errorf("event type = %q, want %q", ev.eventType, ws.EventDiscoverReady)
		}
		if ev.userID != userID {
			t.Errorf("broadcast userID = %d, want %d", ev.userID, userID)
		}
		data, ok := ev.data.(map[string]any)
		if !ok || data["profile_id"] != profileID {
			t.Errorf("broadcast data = %#v, want profile_id=%d", ev.data, profileID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for discover_ready broadcast")
	}
	if n := atomic.LoadInt32(&prov.calls); n != 1 {
		t.Errorf("DiscoverFor called %d times, want 1", n)
	}
}

// TestKickDiscoverBuild_DedupesConcurrent: while a build is in flight, a second
// kick reports "building" WITHOUT starting a second build — the recommender's
// singleflight already collapses the work and we don't want goroutine churn.
func TestKickDiscoverBuild_DedupesConcurrent(t *testing.T) {
	prov := &fakeHeroProvider{
		entered: make(chan struct{}, 1),
		release: make(chan struct{}),
		rails:   []DiscoverRail{{Title: "x"}},
	}
	hub := &fakeHub{events: make(chan broadcast, 1)}
	h := newTestHeroHandler(prov, hub)
	const profileID, userID = int64(3), int64(9)

	// First kick spawns the (blocked) build.
	if got := h.kickDiscoverBuild(context.Background(), profileID, userID); got != "building" {
		t.Fatalf("first kick = %q, want building", got)
	}
	<-prov.entered // ensure the build goroutine is inside DiscoverFor

	// Second kick while in flight: still "building", no new build.
	if got := h.kickDiscoverBuild(context.Background(), profileID, userID); got != "building" {
		t.Fatalf("second kick = %q, want building", got)
	}

	close(prov.release) // let the build finish
	select {
	case <-hub.events:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for broadcast")
	}
	if n := atomic.LoadInt32(&prov.calls); n != 1 {
		t.Errorf("DiscoverFor called %d times, want 1 (deduped)", n)
	}
}

// TestKickDiscoverBuild_EmptySuppression: a build that yields zero rails marks
// the profile so subsequent kicks report "empty" (terminal — the client hides
// the section) instead of re-building on every poll. clearDiscoverEmpty
// (the ?refresh=1 path) lifts the suppression.
func TestKickDiscoverBuild_EmptySuppression(t *testing.T) {
	prov := &fakeHeroProvider{rails: nil} // empty build
	hub := &fakeHub{events: make(chan broadcast, 2)}
	h := newTestHeroHandler(prov, hub)
	const profileID, userID = int64(5), int64(11)

	if got := h.kickDiscoverBuild(context.Background(), profileID, userID); got != "building" {
		t.Fatalf("first kick = %q, want building", got)
	}
	// Broadcast fires after the (empty) build completes and emptyTill is set.
	select {
	case <-hub.events:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for broadcast")
	}

	if got := h.kickDiscoverBuild(context.Background(), profileID, userID); got != "empty" {
		t.Fatalf("post-empty kick = %q, want empty (suppressed)", got)
	}
	if n := atomic.LoadInt32(&prov.calls); n != 1 {
		t.Errorf("DiscoverFor called %d times, want 1 (suppressed re-build)", n)
	}

	// ?refresh=1 clears the suppression → a fresh build is kicked.
	h.clearDiscoverEmpty(profileID)
	if got := h.kickDiscoverBuild(context.Background(), profileID, userID); got != "building" {
		t.Fatalf("post-clear kick = %q, want building", got)
	}
	select {
	case <-hub.events:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for second broadcast")
	}
	if n := atomic.LoadInt32(&prov.calls); n != 2 {
		t.Errorf("DiscoverFor called %d times, want 2 after clear", n)
	}
}
