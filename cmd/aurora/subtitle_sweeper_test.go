package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeAged(t *testing.T, dir, name string, age time.Duration) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("WEBVTT\n"), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	// os.Chtimes rather than a sleep: the age is what the test is about, so
	// it should be stated, not waited for.
	when := time.Now().Add(-age)
	if err := os.Chtimes(p, when, when); err != nil {
		t.Fatalf("chtimes %s: %v", name, err)
	}
	return p
}

func TestSweepSubtitleCache(t *testing.T) {
	dir := t.TempDir()
	const maxAge = 30 * 24 * time.Hour

	stale := writeAged(t, dir, "stale.vtt", maxAge+time.Hour)
	fresh := writeAged(t, dir, "fresh.vtt", time.Hour)
	// A directory older than the cutoff must be left alone.
	subdir := filepath.Join(dir, "nested")
	if err := os.Mkdir(subdir, 0o750); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-maxAge - time.Hour)
	if err := os.Chtimes(subdir, old, old); err != nil {
		t.Fatal(err)
	}

	if got := sweepSubtitleCache(dir, maxAge); got != 1 {
		t.Errorf("sweepSubtitleCache() purged %d, want 1", got)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("entry older than maxAge survived the sweep")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("entry inside maxAge was purged: %v", err)
	}
	if _, err := os.Stat(subdir); err != nil {
		t.Errorf("sweep removed a directory: %v", err)
	}
}

// A missing cache dir must be a no-op, not a panic: the sweeper starts before
// anything has necessarily created it.
func TestSweepSubtitleCacheMissingDir(t *testing.T) {
	if got := sweepSubtitleCache(filepath.Join(t.TempDir(), "nope"), time.Hour); got != 0 {
		t.Errorf("sweepSubtitleCache() on a missing dir purged %d, want 0", got)
	}
}

// The regression this exists for: the sweep must run BEFORE the first tick.
// With the work inside `case <-ticker.C` the first purge needed a full
// interval of uptime, which a box redeploying every 5 minutes never gets — so
// orphaned cache entries accumulated forever.
//
// The interval here is an hour, so a tick cannot fire during the test: if the
// stale file disappears at all, it was the boot sweep that removed it.
func TestSubtitleCacheSweeperSweepsBeforeFirstTick(t *testing.T) {
	dir := t.TempDir()
	const maxAge = 30 * 24 * time.Hour
	stale := writeAged(t, dir, "stale.vtt", maxAge+time.Hour)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runSubtitleCacheSweeper(ctx, dir, time.Hour, maxAge)

	// Poll to a deadline rather than sleeping a fixed span: the assertion is
	// "it happens without waiting for a tick", and polling states that
	// without coupling the test to scheduler timing.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(stale); os.IsNotExist(err) {
			return // swept before any tick could fire
		}
		if time.Now().After(deadline) {
			t.Fatal("stale entry survived: the sweeper waited for its first tick " +
				"instead of sweeping at startup, so a box that restarts often never purges")
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// The sweeper must return when its context is cancelled rather than live
// until the process exits. Deleting the ctx.Done() arm left every other test
// green, so without this the shutdown path is unpinned.
func TestSubtitleCacheSweeperStopsOnContextCancel(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		// A long interval means only cancellation can end this.
		runSubtitleCacheSweeper(ctx, dir, time.Hour, time.Hour)
		close(done)
	}()

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("sweeper did not return after its context was cancelled; " +
			"it would outlive shutdown and keep sweeping")
	}
}
