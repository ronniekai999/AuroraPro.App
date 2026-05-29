package api

import (
	"context"
	"testing"
	"time"
)

// TestAcquireFFprobeSlot_ReleaseFreesSlot verifies the gate hands out a slot,
// the release func returns it, and a cancelled context never leaks a slot
// (audit MED — fork-bomb guard).
func TestAcquireFFprobeSlot_ReleaseFreesSlot(t *testing.T) {
	ctx := context.Background()

	release, err := acquireFFprobeSlot(ctx)
	if err != nil {
		t.Fatalf("acquireFFprobeSlot returned error on idle gate: %v", err)
	}
	if release == nil {
		t.Fatal("acquireFFprobeSlot returned nil release func")
	}
	// Releasing must make the slot available again.
	release()

	// We should be able to re-acquire immediately after release.
	release2, err := acquireFFprobeSlot(ctx)
	if err != nil {
		t.Fatalf("re-acquire after release failed: %v", err)
	}
	release2()
}

// TestAcquireFFprobeSlot_CtxCancelledWhenFull verifies that when every slot is
// held, a caller whose context is already cancelled does NOT block and does NOT
// acquire a slot — so a disconnected client can't tie up subprocess capacity.
func TestAcquireFFprobeSlot_CtxCancelledWhenFull(t *testing.T) {
	gateSize := maxFFprobeConcurrency()

	// Saturate the gate.
	releases := make([]func(), 0, gateSize)
	for i := 0; i < gateSize; i++ {
		release, err := acquireFFprobeSlot(context.Background())
		if err != nil {
			t.Fatalf("unexpected error filling gate at i=%d: %v", i, err)
		}
		releases = append(releases, release)
	}
	// Ensure we always drain the gate so we don't pollute other api tests
	// that share the package-level ffprobeGate.
	defer func() {
		for _, r := range releases {
			r()
		}
	}()

	// With the gate full, an already-cancelled context must fail fast.
	cancelledCtx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	var gotErr error
	var gotRelease func()
	go func() {
		gotRelease, gotErr = acquireFFprobeSlot(cancelledCtx)
		close(done)
	}()

	select {
	case <-done:
		// good — returned promptly
	case <-time.After(2 * time.Second):
		t.Fatal("acquireFFprobeSlot blocked on a full gate with a cancelled context")
	}

	if gotErr == nil {
		t.Fatal("expected error when gate is full and ctx is cancelled, got nil")
	}
	if gotRelease != nil {
		t.Fatal("no slot should be granted when ctx is cancelled; release func must be nil")
	}
}

// TestMaxFFprobeConcurrency_AlwaysPositive guards the gate-sizing invariant: a
// zero-capacity channel would deadlock every acquire, so the size must be >= 1.
func TestMaxFFprobeConcurrency_AlwaysPositive(t *testing.T) {
	if n := maxFFprobeConcurrency(); n < 1 {
		t.Fatalf("maxFFprobeConcurrency() = %d, want >= 1", n)
	}
}
