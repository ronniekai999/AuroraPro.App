package skipmarkers

import (
	"math/rand"
	"testing"
)

// randSig builds n frames of pseudo-random fingerprint words. Random
// 32-bit words sit ~16 bits apart on average, far above the 9-bit
// match threshold, so distinct draws act as "unrelated audio".
func randSig(rng *rand.Rand, n int) []uint32 {
	out := make([]uint32, n)
	for i := range out {
		out[i] = rng.Uint32()
	}
	return out
}

func TestMatchWindowsFindsSharedSegment(t *testing.T) {
	rng := rand.New(rand.NewSource(10))
	shared := randSig(rng, 300) // ~19 s
	a := randSig(rng, 900)
	b := randSig(rng, 900)
	copy(a[100:], shared)
	copy(b[250:], shared)

	wins := matchWindows(a, b)
	if len(wins) != 1 {
		t.Fatalf("got %d windows, want 1: %+v", len(wins), wins)
	}
	w := wins[0]
	if w.aStart != 100 || w.aEnd != 400 || w.bStart != 250 || w.bEnd != 550 {
		t.Fatalf("window = a[%d,%d) b[%d,%d), want a[100,400) b[250,550)", w.aStart, w.aEnd, w.bStart, w.bEnd)
	}
	if w.score < 0.99 {
		t.Fatalf("score = %f, want ~1 for identical frames", w.score)
	}
}

func TestMatchWindowsToleratesBriefGaps(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	shared := randSig(rng, 300)
	a := randSig(rng, 900)
	b := randSig(rng, 900)
	copy(a[100:], shared)
	copy(b[100:], shared)
	// Corrupt a 1 s stretch inside the shared region of A (encoder
	// hiccup) — shorter than maxRunGapSec, so the run must hold.
	for i := 200; i < 215; i++ {
		a[i] = rng.Uint32()
	}

	wins := matchWindows(a, b)
	if len(wins) != 1 {
		t.Fatalf("got %d windows, want 1", len(wins))
	}
	if w := wins[0]; w.aStart != 100 || w.aEnd != 400 {
		t.Fatalf("window = [%d,%d), want [100,400)", w.aStart, w.aEnd)
	}
}

func TestMatchWindowsSplitsOnLongGap(t *testing.T) {
	rng := rand.New(rand.NewSource(12))
	seg1 := randSig(rng, 250)
	seg2 := randSig(rng, 250)
	a := randSig(rng, 1200)
	b := randSig(rng, 1200)
	// Same lag for both segments, separated by ~13 s of unrelated
	// audio — must come back as two windows, not one bridged run.
	copy(a[100:], seg1)
	copy(b[100:], seg1)
	copy(a[550:], seg2)
	copy(b[550:], seg2)

	wins := matchWindows(a, b)
	if len(wins) != 2 {
		t.Fatalf("got %d windows, want 2: %+v", len(wins), wins)
	}
}

func TestMatchWindowsTwoSegmentsDifferentLags(t *testing.T) {
	rng := rand.New(rand.NewSource(13))
	recap := randSig(rng, 220) // ~14 s
	intro := randSig(rng, 320) // ~20 s
	a := randSig(rng, 1500)
	b := randSig(rng, 1500)
	// Recap at different relative offsets (different lag), intro too.
	copy(a[50:], recap)
	copy(b[300:], recap)
	copy(a[500:], intro)
	copy(b[700:], intro)

	wins := matchWindows(a, b)
	if len(wins) != 2 {
		t.Fatalf("got %d windows, want 2: %+v", len(wins), wins)
	}
	// Sorted by length: intro first.
	if w := wins[0]; w.aStart != 500 || w.bStart != 700 {
		t.Fatalf("intro window a[%d,%d) b[%d,%d), want a[500,820) b[700,1020)", w.aStart, w.aEnd, w.bStart, w.bEnd)
	}
	if w := wins[1]; w.aStart != 50 || w.bStart != 300 {
		t.Fatalf("recap window a[%d,%d) b[%d,%d), want a[50,270) b[300,520)", w.aStart, w.aEnd, w.bStart, w.bEnd)
	}
}

func TestMatchWindowsRejectsShortAndNoise(t *testing.T) {
	rng := rand.New(rand.NewSource(14))
	// Shared segment below minSharedSec must be ignored.
	shortSeg := randSig(rng, secToFrames(minSharedSec)-30)
	a := randSig(rng, 800)
	b := randSig(rng, 800)
	copy(a[100:], shortSeg)
	copy(b[400:], shortSeg)
	if wins := matchWindows(a, b); len(wins) != 0 {
		t.Fatalf("short segment produced %d windows", len(wins))
	}

	// Pure noise: no windows.
	if wins := matchWindows(randSig(rng, 1000), randSig(rng, 1000)); len(wins) != 0 {
		t.Fatalf("noise produced %d windows", len(wins))
	}

	// Inputs shorter than the minimum run can't match at all.
	if wins := matchWindows(randSig(rng, 10), randSig(rng, 10)); wins != nil {
		t.Fatalf("tiny inputs produced windows: %+v", wins)
	}
}
