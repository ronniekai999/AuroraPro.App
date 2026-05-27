// Tests for the per-user feedback rate limiter. Covers the edge
// cases that are easy to break in a refactor: cap boundaries,
// pruning, retry-after math, and the bounded-map eviction. (Phase 3
// deep-debug S3.)
package api

import (
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
)

func TestFeedbackLimiterAllowUntilCap(t *testing.T) {
	l := newFeedbackLimiter(3, time.Minute)
	uid := int64(42)
	// First 3 calls allowed.
	for i := 0; i < 3; i++ {
		ok, _ := l.allow(uid)
		if !ok {
			t.Fatalf("call %d: expected allowed, got denied", i+1)
		}
	}
	// 4th call denied — over the cap within the window.
	ok, retry := l.allow(uid)
	if ok {
		t.Fatal("4th call: expected denied, got allowed")
	}
	if retry <= 0 {
		t.Fatalf("4th call: expected positive retryAfter, got %v", retry)
	}
	if retry > time.Minute {
		t.Fatalf("4th call: retryAfter %v exceeds window", retry)
	}
}

func TestFeedbackLimiterPerUserIsolation(t *testing.T) {
	l := newFeedbackLimiter(2, time.Minute)
	// User A exhausts their budget.
	for i := 0; i < 2; i++ {
		ok, _ := l.allow(int64(1))
		if !ok {
			t.Fatalf("user A call %d: expected allowed", i+1)
		}
	}
	if ok, _ := l.allow(int64(1)); ok {
		t.Fatal("user A 3rd call: expected denied")
	}
	// User B should still have a full budget.
	for i := 0; i < 2; i++ {
		ok, _ := l.allow(int64(2))
		if !ok {
			t.Fatalf("user B call %d: expected allowed", i+1)
		}
	}
}

func TestFeedbackLimiterRetryAfterFloor(t *testing.T) {
	// With a 100ms window and immediate-cap-hit, retryAfter should
	// be floored at 1 second so the HTTP header carries a useful
	// integer (clients with sub-second Retry-After tend to misbehave).
	l := newFeedbackLimiter(1, 100*time.Millisecond)
	uid := int64(7)
	if ok, _ := l.allow(uid); !ok {
		t.Fatal("first call: expected allowed")
	}
	ok, retry := l.allow(uid)
	if ok {
		t.Fatal("second call: expected denied")
	}
	if retry < time.Second {
		t.Errorf("retryAfter %v: expected floor of 1s", retry)
	}
}

func TestFeedbackLimiterPruneAcrossWindow(t *testing.T) {
	// Sub-window: 50ms. Two allowed calls, wait for the window to
	// roll, then two more allowed calls should land cleanly.
	l := newFeedbackLimiter(2, 50*time.Millisecond)
	uid := int64(99)
	for i := 0; i < 2; i++ {
		if ok, _ := l.allow(uid); !ok {
			t.Fatalf("call %d: expected allowed", i+1)
		}
	}
	// Confirm we're capped.
	if ok, _ := l.allow(uid); ok {
		t.Fatal("3rd call: expected denied within window")
	}
	// Wait past the window + a buffer, then the limiter should
	// allow 2 more.
	time.Sleep(80 * time.Millisecond)
	for i := 0; i < 2; i++ {
		if ok, _ := l.allow(uid); !ok {
			t.Fatalf("post-window call %d: expected allowed after prune", i+1)
		}
	}
}

func TestFeedbackLimiterMapBound(t *testing.T) {
	// Insert maxUsers + 5 distinct users; verify the map stays
	// bounded at maxUsers (eviction kicks in).
	l := newFeedbackLimiter(1, time.Hour)
	l.maxUsers = 10 // shrink for test speed
	for i := 0; i < 15; i++ {
		l.allow(int64(i))
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.bucket) > l.maxUsers {
		t.Fatalf("bucket size %d exceeded cap %d", len(l.bucket), l.maxUsers)
	}
}

func TestFeedbackLimiterEvictExpiredLocked(t *testing.T) {
	l := newFeedbackLimiter(3, 10*time.Millisecond)
	// Seed a few users with stale timestamps.
	old := time.Now().Add(-time.Hour)
	l.mu.Lock()
	l.bucket[1] = []time.Time{old}
	l.bucket[2] = []time.Time{old}
	l.bucket[3] = []time.Time{time.Now()}
	l.mu.Unlock()
	// Cutoff = now - 10ms; users 1 and 2 should be evicted.
	l.mu.Lock()
	l.evictExpiredLocked(time.Now().Add(-10 * time.Millisecond))
	l.mu.Unlock()
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.bucket[1]; ok {
		t.Error("user 1 should have been evicted (stale)")
	}
	if _, ok := l.bucket[2]; ok {
		t.Error("user 2 should have been evicted (stale)")
	}
	if _, ok := l.bucket[3]; !ok {
		t.Error("user 3 should have survived (fresh)")
	}
}

// 2026-05-27 — Test that NewFeedbackHandler resolves the env-tunable
// fields correctly: explicit cfg wins, zero falls back to default,
// negative is treated as zero (fall back to default).
func TestNewFeedbackHandlerResolvesTunables(t *testing.T) {
	t.Run("explicit values used", func(t *testing.T) {
		cfg := config.BugReportConfig{
			Enabled:              false, // skip goroutine spawn
			RateLimitMax:         10,
			RateLimitWindow:      2 * time.Hour,
			AttachmentTTL:        7 * 24 * time.Hour,
			JanitorSweepInterval: 30 * time.Minute,
		}
		h := NewFeedbackHandler(nil, cfg, t.TempDir(), "")
		if h.submitLimiter.rate != 10 {
			t.Errorf("rate: got %d, want 10", h.submitLimiter.rate)
		}
		if h.submitLimiter.window != 2*time.Hour {
			t.Errorf("window: got %v, want 2h", h.submitLimiter.window)
		}
		if h.effectiveTTL != 7*24*time.Hour {
			t.Errorf("TTL: got %v, want 7d", h.effectiveTTL)
		}
		if h.effectiveSweepInterval != 30*time.Minute {
			t.Errorf("sweep: got %v, want 30m", h.effectiveSweepInterval)
		}
	})
	t.Run("zeros fall back to defaults", func(t *testing.T) {
		cfg := config.BugReportConfig{Enabled: false} // all tunables zero
		h := NewFeedbackHandler(nil, cfg, t.TempDir(), "")
		if h.submitLimiter.rate != defaultFeedbackRateMax {
			t.Errorf("rate: got %d, want default %d", h.submitLimiter.rate, defaultFeedbackRateMax)
		}
		if h.submitLimiter.window != defaultFeedbackRateWindow {
			t.Errorf("window: got %v, want default %v", h.submitLimiter.window, defaultFeedbackRateWindow)
		}
		if h.effectiveTTL != defaultAttachmentTTL {
			t.Errorf("TTL: got %v, want default %v", h.effectiveTTL, defaultAttachmentTTL)
		}
		if h.effectiveSweepInterval != defaultJanitorSweepInterval {
			t.Errorf("sweep: got %v, want default %v", h.effectiveSweepInterval, defaultJanitorSweepInterval)
		}
	})
	t.Run("negative values fall back to defaults", func(t *testing.T) {
		// Deep-debug #6 — covers all four tunables, including
		// JanitorSweepInterval (omitted in the earlier version
		// where its absence would have been the only field whose
		// mishandling could panic the janitor goroutine).
		cfg := config.BugReportConfig{
			Enabled:              false,
			RateLimitMax:         -1,
			RateLimitWindow:      -time.Hour,
			AttachmentTTL:        -time.Hour,
			JanitorSweepInterval: -time.Hour,
		}
		h := NewFeedbackHandler(nil, cfg, t.TempDir(), "")
		if h.submitLimiter.rate != defaultFeedbackRateMax {
			t.Errorf("negative rate should fall back to default; got %d", h.submitLimiter.rate)
		}
		if h.submitLimiter.window != defaultFeedbackRateWindow {
			t.Errorf("negative window should fall back to default; got %v", h.submitLimiter.window)
		}
		if h.effectiveTTL != defaultAttachmentTTL {
			t.Errorf("negative TTL should fall back to default; got %v", h.effectiveTTL)
		}
		if h.effectiveSweepInterval != defaultJanitorSweepInterval {
			t.Errorf("negative sweep interval should fall back to default; got %v", h.effectiveSweepInterval)
		}
	})
}
