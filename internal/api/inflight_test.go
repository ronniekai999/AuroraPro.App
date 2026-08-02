package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestInFlightRegistry_EmptyWhenIdle(t *testing.T) {
	reg := NewInFlightRegistry()
	if got := reg.Count(); got != 0 {
		t.Fatalf("Count = %d, want 0", got)
	}
	if got := reg.Snapshot(); got != "none" {
		t.Fatalf("Snapshot = %q, want \"none\"", got)
	}
}

// TestTrackInFlight_VisibleDuringHandler is the behaviour that matters: the
// request must be observable WHILE its handler runs. RequestLogger can't do
// this — it logs after the handler returns, which is exactly why a shutdown
// that timed out mid-request left no evidence of what it was waiting on.
func TestTrackInFlight_VisibleDuringHandler(t *testing.T) {
	reg := NewInFlightRegistry()

	release := make(chan struct{})
	entered := make(chan struct{})
	h := TrackInFlight(reg)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
	}))

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		h.ServeHTTP(httptest.NewRecorder(),
			httptest.NewRequest(http.MethodGet, "/api/stream/563/direct", nil))
	}()

	<-entered
	if got := reg.Count(); got != 1 {
		t.Fatalf("Count during handler = %d, want 1", got)
	}
	snap := reg.Snapshot()
	if !strings.Contains(snap, "/api/stream/563/direct") || !strings.Contains(snap, "GET") {
		t.Fatalf("Snapshot should name the in-flight request, got %q", snap)
	}

	close(release)
	wg.Wait()

	if got := reg.Count(); got != 0 {
		t.Fatalf("Count after handler = %d, want 0", got)
	}
}

// A panicking handler must still deregister, or a single panic would leave a
// phantom entry that makes every later shutdown look blocked.
func TestTrackInFlight_DeregistersOnPanic(t *testing.T) {
	reg := NewInFlightRegistry()
	h := TrackInFlight(reg)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))

	func() {
		defer func() { _ = recover() }()
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
	}()

	if got := reg.Count(); got != 0 {
		t.Fatalf("Count after panic = %d, want 0", got)
	}
}

func TestInFlightRegistry_SnapshotBounded(t *testing.T) {
	reg := NewInFlightRegistry()
	for i := 0; i < 25; i++ {
		reg.add(http.MethodGet, "/api/thing")
	}
	snap := reg.Snapshot()
	if !strings.Contains(snap, "25 in flight") {
		t.Fatalf("snapshot should report the true total, got %q", snap)
	}
	if !strings.Contains(snap, "+15 more") {
		t.Fatalf("snapshot should be bounded and say what it elided, got %q", snap)
	}
}

func TestInFlightRegistry_ConcurrentAddDone(t *testing.T) {
	reg := NewInFlightRegistry()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				id := reg.add(http.MethodGet, "/api/x")
				_ = reg.Snapshot()
				reg.done(id)
			}
		}()
	}
	wg.Wait()
	if got := reg.Count(); got != 0 {
		t.Fatalf("Count = %d, want 0 after all requests completed", got)
	}
}
