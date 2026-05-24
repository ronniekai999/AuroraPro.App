package streaming

import (
	"sync"
	"testing"
	"time"
)

func TestDirectPlayRegistry_TouchRoundTrip(t *testing.T) {
	r := NewDirectPlayRegistry(100 * time.Millisecond)
	defer r.Close()

	id := r.Touch(42, "alice", "media", 7, "movie.mkv", "direct_play")
	if id == "" {
		t.Fatal("Touch returned empty ID")
	}
	if r.ActiveCount() != 1 {
		t.Errorf("ActiveCount = %d, want 1", r.ActiveCount())
	}

	// Same (user, file) → same session, no new entry.
	id2 := r.Touch(42, "alice", "media", 7, "movie.mkv", "direct_play")
	if id2 != id {
		t.Errorf("re-Touch returned different ID: %q vs %q", id, id2)
	}
	if r.ActiveCount() != 1 {
		t.Errorf("ActiveCount after re-touch = %d, want 1", r.ActiveCount())
	}

	// Different user → separate entry.
	r.Touch(99, "bob", "media", 7, "movie.mkv", "direct_play")
	if r.ActiveCount() != 2 {
		t.Errorf("ActiveCount with 2 users = %d, want 2", r.ActiveCount())
	}

	// Different fileType → separate entry.
	r.Touch(42, "alice", "episode", 7, "ep.mkv", "direct_play")
	if r.ActiveCount() != 3 {
		t.Errorf("ActiveCount with movie+episode same ID = %d, want 3", r.ActiveCount())
	}
}

func TestDirectPlayRegistry_ListReflectsTTL(t *testing.T) {
	r := NewDirectPlayRegistry(50 * time.Millisecond)
	defer r.Close()

	r.Touch(1, "u", "media", 1, "f.mkv", "direct_play")
	if got := len(r.List()); got != 1 {
		t.Fatalf("List len = %d, want 1", got)
	}

	// Wait past TTL — List() should filter out expired entries even
	// before the GC sweep runs (cutoff is enforced in List itself).
	time.Sleep(70 * time.Millisecond)
	if got := len(r.List()); got != 0 {
		t.Errorf("List len after TTL = %d, want 0", got)
	}
}

func TestDirectPlayRegistry_EndRemoves(t *testing.T) {
	r := NewDirectPlayRegistry(time.Second)
	defer r.Close()

	id := r.Touch(1, "u", "media", 1, "f.mkv", "direct_play")
	if r.ActiveCount() != 1 {
		t.Fatal("setup: count != 1")
	}
	r.End(id)
	if r.ActiveCount() != 0 {
		t.Errorf("ActiveCount after End = %d, want 0", r.ActiveCount())
	}
	// Double-End is safe.
	r.End(id)
	r.End("nonexistent")
}

func TestDirectPlayRegistry_CloseIsSafe(t *testing.T) {
	r := NewDirectPlayRegistry(time.Second)
	r.Close()
	// Double-close must not panic — the registry was closed mid-test
	// in higher-level tests and we want defer r.Close() to be safe.
	r.Close()
}

func TestDirectPlayRegistry_ConcurrentTouchAndList(t *testing.T) {
	r := NewDirectPlayRegistry(time.Second)
	defer r.Close()

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(n int64) {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				r.Touch(n, "u", "media", int64(j), "f", "direct_play")
				_ = r.List()
			}
		}(int64(i))
	}
	wg.Wait()
	// No specific assertion — this test passes when the race
	// detector + concurrent execution don't produce a fault. With
	// -race off it's still useful as a smoke test that the map
	// operations complete without panicking.
}
