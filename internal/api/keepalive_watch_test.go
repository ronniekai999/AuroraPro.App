package api

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

// Pins the boundary the watcher exists to draw. It is costly in both
// directions: warning on the first 404 would fire for every viewer on every
// restart (the exact log noise this is meant to cut through), and never
// warning restores the silence that let thirteen identical 404s pass for
// ordinary traffic on 2026-08-02.

func TestStaleKeepalive_OneMissIsNormal(t *testing.T) {
	var w staleKeepaliveWatcher
	now := time.Now()

	// A restart drops every session; the next ping is how each client finds
	// out. That is not a stuck client.
	if _, warn := w.miss("sess", now); warn {
		t.Fatal("warned on the first 404 — every viewer gets one after a restart")
	}
	for i := 2; i < staleKeepaliveThreshold; i++ {
		if _, warn := w.miss("sess", now); warn {
			t.Fatalf("warned at miss %d, before the threshold of %d", i, staleKeepaliveThreshold)
		}
	}
}

func TestStaleKeepalive_WarnsOnceAtThreshold(t *testing.T) {
	var w staleKeepaliveWatcher
	now := time.Now()

	var warned int
	var warnedAt int
	for i := 1; i <= staleKeepaliveThreshold+5; i++ {
		misses, warn := w.miss("sess", now)
		if warn {
			warned++
			warnedAt = misses
		}
	}

	if warned != 1 {
		t.Fatalf("warned %d times; a stuck client pings forever, so the log line must not", warned)
	}
	if warnedAt != staleKeepaliveThreshold {
		t.Fatalf("warned at %d misses, want %d", warnedAt, staleKeepaliveThreshold)
	}
}

func TestStaleKeepalive_SessionsCountedIndependently(t *testing.T) {
	var w staleKeepaliveWatcher
	now := time.Now()

	// Two clients each one miss short of the threshold. Pooling their counts
	// would warn about a session that is not actually stuck.
	for i := 1; i < staleKeepaliveThreshold; i++ {
		if _, warn := w.miss("a", now); warn {
			t.Fatal("session a warned early")
		}
		if _, warn := w.miss("b", now); warn {
			t.Fatal("session b warned early")
		}
	}
	if _, warn := w.miss("a", now); !warn {
		t.Fatal("session a did not warn at its own threshold")
	}
	if _, warn := w.miss("b", now); !warn {
		t.Fatal("session b did not warn at its own threshold")
	}
}

func TestStaleKeepalive_AliveClearsTheRun(t *testing.T) {
	var w staleKeepaliveWatcher
	now := time.Now()

	for i := 1; i < staleKeepaliveThreshold; i++ {
		w.miss("sess", now)
	}
	w.alive("sess")

	// The run restarts from zero, so the next miss must be treated as a
	// client's first news again.
	if _, warn := w.miss("sess", now); warn {
		t.Fatal("a live keepalive did not clear the accumulated misses")
	}
}

func TestStaleKeepalive_CapBoundsTheMap(t *testing.T) {
	var w staleKeepaliveWatcher
	now := time.Now()

	for i := 0; i < staleKeepaliveMaxTracked; i++ {
		w.miss(fmt.Sprintf("sess-%d", i), now)
	}

	// Session IDs come from the URL, so a client can mint them without
	// limit. Past the cap we stop tracking rather than keep allocating.
	for i := 0; i < 50; i++ {
		id := fmt.Sprintf("flood-%d", i)
		for j := 0; j < staleKeepaliveThreshold+2; j++ {
			if _, warn := w.miss(id, now); warn {
				t.Fatalf("%s warned despite the map being full", id)
			}
		}
	}
	if got := len(w.entries); got > staleKeepaliveMaxTracked {
		t.Fatalf("tracking %d sessions, cap is %d", got, staleKeepaliveMaxTracked)
	}

	// Sessions already being tracked keep working — the cap costs new
	// diagnoses, not existing ones. sess-0 is one miss in already.
	var warned bool
	for i := 1; i < staleKeepaliveThreshold; i++ {
		if _, warn := w.miss("sess-0", now); warn {
			warned = true
		}
	}
	if !warned {
		t.Fatal("an already-tracked session stopped counting once the map filled")
	}
}

func TestStaleKeepalive_TTLFreesCapacity(t *testing.T) {
	var w staleKeepaliveWatcher
	start := time.Now()

	for i := 0; i < staleKeepaliveMaxTracked; i++ {
		w.miss(fmt.Sprintf("old-%d", i), start)
	}

	// Those clients stopped pinging. Long after, a genuinely stuck one turns
	// up: it must not be locked out by a map full of history.
	later := start.Add(staleKeepaliveTTL + time.Minute)
	for i := 1; i <= staleKeepaliveThreshold; i++ {
		_, warn := w.miss("fresh", later)
		if i == staleKeepaliveThreshold && !warn {
			t.Fatal("a new stuck session never warned — expired entries did not free capacity")
		}
	}
}

// The map cap bounds MEMORY, not the log: entries expire, freeing slots for
// the next batch of invented IDs. This endpoint has no rate limiter, and since
// #415 warnings land in a scarce ring the admin log filter reads — so without
// a budget an authenticated client looping over fresh session IDs could evict
// every real warning someone is trying to find.
func TestStaleKeepalive_WarnBudgetBoundsTheFlood(t *testing.T) {
	var w staleKeepaliveWatcher
	now := time.Now()

	warns := 0
	for i := 0; i < staleKeepaliveWarnBudget*5; i++ {
		id := fmt.Sprintf("minted-%d", i)
		for j := 0; j < staleKeepaliveThreshold; j++ {
			if _, warn := w.miss(id, now); warn {
				warns++
			}
		}
	}

	if warns != staleKeepaliveWarnBudget {
		t.Fatalf("emitted %d warnings for %d stuck sessions; budget is %d",
			warns, staleKeepaliveWarnBudget*5, staleKeepaliveWarnBudget)
	}
}

// The budget must throttle the log, not switch the diagnostic off for good —
// a genuinely stuck client turning up tomorrow still has to be reportable.
func TestStaleKeepalive_BudgetRefillsInTheNextWindow(t *testing.T) {
	var w staleKeepaliveWatcher
	start := time.Now()

	for i := 0; i < staleKeepaliveWarnBudget*2; i++ {
		id := fmt.Sprintf("minted-%d", i)
		for j := 0; j < staleKeepaliveThreshold; j++ {
			w.miss(id, start)
		}
	}

	later := start.Add(staleKeepaliveTTL + time.Minute)
	var warned bool
	for j := 0; j < staleKeepaliveThreshold; j++ {
		if _, warn := w.miss("stuck-tomorrow", later); warn {
			warned = true
		}
	}
	if !warned {
		t.Fatal("a stuck client in a later window never warned — the budget silenced the diagnostic permanently")
	}
}

// A session that crossed the threshold while the budget was spent must still
// latch. Leaving it unlatched would make it retry on every subsequent ping and
// spend the next window's budget on a client already counted.
func TestStaleKeepalive_BudgetedOutSessionDoesNotRetryLater(t *testing.T) {
	var w staleKeepaliveWatcher
	start := time.Now()

	for i := 0; i < staleKeepaliveWarnBudget; i++ {
		id := fmt.Sprintf("filler-%d", i)
		for j := 0; j < staleKeepaliveThreshold; j++ {
			w.miss(id, start)
		}
	}

	// Crosses the threshold with the budget already gone.
	for j := 0; j < staleKeepaliveThreshold; j++ {
		if _, warn := w.miss("budgeted-out", start); warn {
			t.Fatal("warned past the budget")
		}
	}

	// Next window: this session must not resurface, having already been
	// counted once.
	later := start.Add(staleKeepaliveTTL + time.Minute)
	for j := 0; j < staleKeepaliveThreshold+2; j++ {
		if _, warn := w.miss("budgeted-out", later); warn {
			t.Fatal("a session already past its threshold warned in a later window")
		}
	}
}

func TestStaleKeepalive_ConcurrentMisses(t *testing.T) {
	var w staleKeepaliveWatcher
	now := time.Now()

	// This is called straight from an HTTP handler, so every ping in flight
	// hits it at once. Run under -race.
	var wg sync.WaitGroup
	var mu sync.Mutex
	warns := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				if _, warn := w.miss("sess", now); warn {
					mu.Lock()
					warns++
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()

	if warns != 1 {
		t.Fatalf("got %d warnings across concurrent pings, want exactly 1", warns)
	}
}
