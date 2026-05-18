package auth

import (
	"testing"
	"time"
)

func TestRateLimiter_AllowUnderLimit(t *testing.T) {
	rl := NewRateLimiter(5, time.Minute)
	defer rl.Stop()

	for i := 0; i < 5; i++ {
		if !rl.allow("192.168.1.1") {
			t.Errorf("request %d should be allowed (under limit)", i+1)
		}
	}
}

func TestRateLimiter_BlockOverLimit(t *testing.T) {
	rl := NewRateLimiter(3, time.Minute)
	defer rl.Stop()

	// First 3 should succeed
	for i := 0; i < 3; i++ {
		if !rl.allow("192.168.1.1") {
			t.Errorf("request %d should be allowed", i+1)
		}
	}

	// 4th should be blocked
	if rl.allow("192.168.1.1") {
		t.Error("request 4 should be blocked (over limit)")
	}

	// 5th should also be blocked
	if rl.allow("192.168.1.1") {
		t.Error("request 5 should be blocked (over limit)")
	}
}

func TestRateLimiter_IndependentIPs(t *testing.T) {
	rl := NewRateLimiter(2, time.Minute)
	defer rl.Stop()

	// Exhaust IP 1
	rl.allow("10.0.0.1")
	rl.allow("10.0.0.1")
	if rl.allow("10.0.0.1") {
		t.Error("IP 10.0.0.1 should be rate limited")
	}

	// IP 2 should still be able to make requests
	if !rl.allow("10.0.0.2") {
		t.Error("IP 10.0.0.2 should not be rate limited")
	}
	if !rl.allow("10.0.0.2") {
		t.Error("IP 10.0.0.2 second request should not be rate limited")
	}

	// IP 2 should now be blocked
	if rl.allow("10.0.0.2") {
		t.Error("IP 10.0.0.2 should be rate limited after exceeding limit")
	}
}

func TestRateLimiter_WindowReset(t *testing.T) {
	// Use a very short window so the test runs quickly
	rl := NewRateLimiter(2, 50*time.Millisecond)
	defer rl.Stop()

	// Exhaust the limit
	rl.allow("192.168.1.1")
	rl.allow("192.168.1.1")
	if rl.allow("192.168.1.1") {
		t.Error("should be blocked after exhausting limit")
	}

	// Wait for window to expire
	time.Sleep(60 * time.Millisecond)

	// Should be allowed again after window reset
	if !rl.allow("192.168.1.1") {
		t.Error("should be allowed after window reset")
	}
}

func TestRateLimiter_Cleanup(t *testing.T) {
	rl := NewRateLimiter(5, 50*time.Millisecond)
	defer rl.Stop()

	// Create some visitors
	rl.allow("10.0.0.1")
	rl.allow("10.0.0.2")
	rl.allow("10.0.0.3")

	// Verify visitors exist
	rl.mu.Lock()
	initialCount := len(rl.visitors)
	rl.mu.Unlock()
	if initialCount != 3 {
		t.Errorf("initial visitor count = %d, want 3", initialCount)
	}

	// Wait for entries to become stale (cutoff = now - window*2)
	time.Sleep(120 * time.Millisecond)

	// Run cleanup manually
	rl.cleanup()

	rl.mu.Lock()
	finalCount := len(rl.visitors)
	rl.mu.Unlock()
	if finalCount != 0 {
		t.Errorf("after cleanup, visitor count = %d, want 0", finalCount)
	}
}

func TestRateLimiter_ExactBoundary(t *testing.T) {
	rl := NewRateLimiter(1, time.Minute)
	defer rl.Stop()

	// Exactly at the limit
	if !rl.allow("192.168.1.1") {
		t.Error("first request should be allowed (rate=1)")
	}

	// One over
	if rl.allow("192.168.1.1") {
		t.Error("second request should be blocked (rate=1)")
	}
}

func TestRateLimiter_HighLimit(t *testing.T) {
	rl := NewRateLimiter(1000, time.Minute)
	defer rl.Stop()

	for i := 0; i < 1000; i++ {
		if !rl.allow("10.0.0.1") {
			t.Errorf("request %d should be allowed (limit=1000)", i+1)
		}
	}

	// 1001st should be blocked
	if rl.allow("10.0.0.1") {
		t.Error("request 1001 should be blocked")
	}
}

func TestRateLimiter_StopClosesChannel(t *testing.T) {
	rl := NewRateLimiter(5, time.Minute)
	rl.Stop()

	// Verify the stop channel is closed (should not block)
	select {
	case <-rl.stop:
		// Expected: channel is closed
	default:
		t.Error("stop channel should be closed after Stop()")
	}
}
