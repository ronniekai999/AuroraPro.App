package logging

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
)

func newTestHandler(size int) *RingBufferHandler {
	return NewRingBufferHandler(
		slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelDebug}),
		size,
	)
}

func logN(h *RingBufferHandler, level slog.Level, msg string, n int) {
	l := slog.New(h)
	for i := 0; i < n; i++ {
		l.Log(context.Background(), level, msg)
	}
}

// TestProblemRing_SurvivesInfoFlood is the reason the second ring exists.
//
// The admin Logs page ran off a single 1000-entry ring, and ~95% of Aurora's
// lines are INFO request logs. Measured on two weeks of production logs, that
// ring covered 17 minutes when idle and 3.6 minutes at its busiest — so any
// WARN or ERROR was evicted within minutes and the page could not show you an
// error unless you were watching when it happened.
//
// Filtering the main ring by level cannot fix that; the entries are gone.
// This test floods INFO past the main ring's capacity and requires the earlier
// error to still be retrievable.
func TestProblemRing_SurvivesInfoFlood(t *testing.T) {
	h := newTestHandler(100)

	slog.New(h).Error("disk on fire")
	// Flood well past the main ring's capacity.
	logN(h, slog.LevelInfo, "request", 500)

	if got := h.Entries(1000, 0); len(got) != 100 {
		t.Fatalf("main ring should be full at capacity, got %d", len(got))
	}
	for _, e := range h.Entries(1000, 0) {
		if e.Message == "disk on fire" {
			t.Fatal("precondition failed: the error should have been evicted from the main ring")
		}
	}

	problems := h.ProblemEntries(100, 0)
	if len(problems) != 1 || problems[0].Message != "disk on fire" {
		t.Fatalf("the error must survive in the problem ring, got %+v", problems)
	}
}

func TestProblemRing_LevelSelection(t *testing.T) {
	h := newTestHandler(1000)
	l := slog.New(h)

	l.Debug("debug line")
	l.Info("info line")
	l.Warn("warn line")
	l.Error("error line")

	problems := h.ProblemEntries(100, 0)
	if len(problems) != 2 {
		t.Fatalf("problem ring should hold exactly WARN and ERROR, got %d: %+v",
			len(problems), problems)
	}
	// Newest first.
	if problems[0].Message != "error line" || problems[1].Message != "warn line" {
		t.Fatalf("unexpected contents/order: %+v", problems)
	}

	// The main ring still holds everything, so chronological context around a
	// problem line is not lost.
	if got := len(h.Entries(100, 0)); got != 4 {
		t.Fatalf("main ring should hold all four levels, got %d", got)
	}
}

// WithAttrs/WithGroup return NEW handler values sharing state by pointer. If a
// derived handler failed to carry the warn ring, every subsystem that calls
// slog.With(...) — which is most of them — would silently stop recording
// problems, and the page would look reassuringly empty.
func TestProblemRing_DerivedHandlersShareTheRing(t *testing.T) {
	h := newTestHandler(1000)

	slog.New(h).With("subsystem", "scanner").Error("walk failed")
	slog.New(h).WithGroup("g").Warn("grouped warning")

	problems := h.ProblemEntries(100, 0)
	if len(problems) != 2 {
		t.Fatalf("derived handlers must feed the same problem ring, got %d: %+v",
			len(problems), problems)
	}
}

func TestProblemRing_Wraparound(t *testing.T) {
	h := newTestHandler(10)
	logN(h, slog.LevelError, "err", warnRingSize+50)

	problems := h.ProblemEntries(warnRingSize*2, 0)
	if len(problems) != warnRingSize {
		t.Fatalf("problem ring should cap at %d, got %d", warnRingSize, len(problems))
	}
}

func TestRing_PaginationAndBounds(t *testing.T) {
	h := newTestHandler(1000)
	l := slog.New(h)
	for i := 0; i < 5; i++ {
		l.Error("e")
	}

	if got := h.ProblemEntries(2, 0); len(got) != 2 {
		t.Fatalf("limit not honoured: %d", len(got))
	}
	if got := h.ProblemEntries(10, 3); len(got) != 2 {
		t.Fatalf("offset not honoured: %d", len(got))
	}
	// Offset past the end must be empty, not a panic or a wrapped read.
	if got := h.ProblemEntries(10, 99); len(got) != 0 {
		t.Fatalf("offset past end should be empty, got %d", len(got))
	}
	// Empty ring.
	if got := newTestHandler(10).ProblemEntries(10, 0); len(got) != 0 {
		t.Fatalf("empty ring should return nothing, got %d", len(got))
	}
}

// Both rings are written on every log call from many goroutines. Run with
// -race; a missing lock here corrupts the admin page rather than crashing.
func TestRings_ConcurrentWrites(t *testing.T) {
	h := newTestHandler(64)
	l := slog.New(h)

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				if j%3 == 0 {
					l.Error("boom")
				} else {
					l.Info("tick")
				}
				_ = h.Entries(10, 0)
				_ = h.ProblemEntries(10, 0)
			}
		}(i)
	}
	wg.Wait()

	if got := len(h.ProblemEntries(warnRingSize, 0)); got == 0 {
		t.Fatal("expected problem entries after concurrent writes")
	}
}
