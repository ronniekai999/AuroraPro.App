package skipmarkers

import (
	"math"
	"testing"
)

func TestParseDetectOutput(t *testing.T) {
	stderr := `
ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers
[blackdetect @ 0x55d8] black_start:120.5 black_end:124 black_duration:3.5
frame= 1000 fps=250 q=-0.0 size=N/A time=00:01:00.00 bitrate=N/A speed=15x
[silencedetect @ 0x55e0] silence_start: 118.75
[silencedetect @ 0x55e0] silence_end: 130.2 | silence_duration: 11.45
[blackdetect @ 0x55d8] black_start:300 black_end:310.25 black_duration:10.25
[silencedetect @ 0x55e0] silence_start: 305
`
	black, silence := parseDetectOutput(stderr)
	if len(black) != 2 {
		t.Fatalf("black ranges = %d, want 2: %+v", len(black), black)
	}
	if black[0].start != 120.5 || black[0].end != 124 {
		t.Fatalf("black[0] = %+v, want {120.5 124}", black[0])
	}
	if len(silence) != 2 {
		t.Fatalf("silence ranges = %d, want 2: %+v", len(silence), silence)
	}
	if silence[0].start != 118.75 || silence[0].end != 130.2 {
		t.Fatalf("silence[0] = %+v", silence[0])
	}
	// File ended while silent: the open range closes at +Inf (the
	// onset heuristic clamps it to the duration).
	if silence[1].start != 305 || !math.IsInf(silence[1].end, 1) {
		t.Fatalf("silence[1] = %+v, want {305 +Inf}", silence[1])
	}
}

func TestParseDetectOutputEmpty(t *testing.T) {
	black, silence := parseDetectOutput("nothing relevant here\n")
	if len(black) != 0 || len(silence) != 0 {
		t.Fatalf("got %d black / %d silence from noise", len(black), len(silence))
	}
}

func TestCreditsTailSec(t *testing.T) {
	cases := []struct {
		dur, want float64
	}{
		{200, 0},     // too short for credits detection at all
		{600, 120},   // 15% = 90 < min -> floor at 120
		{2400, 360},  // 15% within bounds
		{10000, 600}, // capped at max
		{299.9, 0},   // just under the minimum duration
		{1000, 150},  // 15% exactly between bounds
	}
	for _, c := range cases {
		if got := creditsTailSec(c.dur); got != c.want {
			t.Fatalf("creditsTailSec(%v) = %v, want %v", c.dur, got, c.want)
		}
	}
}

func TestCreditsOnsetBlack(t *testing.T) {
	const dur = 2400.0 // 40 min episode
	black := []timeRange{{2200, 2210}}
	silence := []timeRange{{2205, 2400}}
	onset, conf, ok := creditsOnsetFromRanges(black, silence, dur)
	if !ok {
		t.Fatal("expected a credits onset")
	}
	if onset != 2200 {
		t.Fatalf("onset = %v, want 2200", onset)
	}
	if conf < 0.8 || conf > 0.9 {
		t.Fatalf("confidence = %v, want high (full coverage)", conf)
	}
}

func TestCreditsOnsetPicksLatestQualifying(t *testing.T) {
	const dur = 2400.0
	// Mid-episode black dip (scene transition) + the real credits
	// fade. The transition has almost no tail coverage and the LATER
	// onset is checked first, so the dip is never even considered.
	black := []timeRange{{1700, 1701}, {2250, 2255}}
	silence := []timeRange{{2250, 2400}}
	onset, _, ok := creditsOnsetFromRanges(black, silence, dur)
	if !ok || onset != 2250 {
		t.Fatalf("onset = %v ok=%v, want 2250", onset, ok)
	}
}

func TestCreditsOnsetSilenceFallback(t *testing.T) {
	const dur = 5400.0 // movie
	silence := []timeRange{{5000, math.Inf(1)}}
	onset, conf, ok := creditsOnsetFromRanges(nil, silence, dur)
	if !ok || onset != 5000 {
		t.Fatalf("onset = %v ok=%v, want 5000", onset, ok)
	}
	if conf <= 0 {
		t.Fatalf("confidence = %v", conf)
	}
}

func TestCreditsOnsetRejects(t *testing.T) {
	const dur = 2400.0
	// Too early (before 60% of runtime).
	if _, _, ok := creditsOnsetFromRanges([]timeRange{{1000, 1010}}, []timeRange{{1000, 2400}}, dur); ok {
		t.Fatal("accepted an onset before 60% of the runtime")
	}
	// Too close to EOF (leaves < creditsMinLenSec of credits).
	if _, _, ok := creditsOnsetFromRanges([]timeRange{{2392, 2400}}, []timeRange{{2392, 2400}}, dur); ok {
		t.Fatal("accepted an onset 8s before EOF")
	}
	// Insufficient coverage: a blip with normal content after it.
	if _, _, ok := creditsOnsetFromRanges([]timeRange{{2000, 2001}}, nil, dur); ok {
		t.Fatal("accepted a 1s black blip as credits")
	}
	// Silence-only evidence below the stricter silence bar.
	if _, _, ok := creditsOnsetFromRanges(nil, []timeRange{{2200, 2280}}, dur); ok {
		t.Fatal("accepted weak silence-only evidence")
	}
	// Nothing at all.
	if _, _, ok := creditsOnsetFromRanges(nil, nil, dur); ok {
		t.Fatal("accepted empty evidence")
	}
	// Zero duration is a no-op.
	if _, _, ok := creditsOnsetFromRanges([]timeRange{{10, 20}}, nil, 0); ok {
		t.Fatal("accepted markers on a zero-duration file")
	}
}

func TestCoverage(t *testing.T) {
	// Overlapping + out-of-order ranges merge; open end clamps.
	ranges := []timeRange{{50, 60}, {10, 30}, {25, 40}, {90, math.Inf(1)}}
	got := coverage(ranges, 0, 100)
	want := 0.5 // [10,40)=30 + [50,60)=10 + [90,100)=10 → 50 of 100
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("coverage = %v, want %v", got, want)
	}
	if c := coverage(nil, 0, 100); c != 0 {
		t.Fatalf("empty coverage = %v", c)
	}
	if c := coverage(ranges, 100, 100); c != 0 {
		t.Fatalf("zero-width window coverage = %v", c)
	}
}
