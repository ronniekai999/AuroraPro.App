package api

import "testing"

// The client bitrate ceiling is self-limiting, but its normalization still
// has to be right at the edges: a stray zero, a negative, a kbps figure typed
// where bps was meant, or a non-number must all read as "no ceiling" rather
// than as a ceiling nothing can exceed (or one everything exceeds).
func TestClampMaxBPS(t *testing.T) {
	for _, tt := range []struct {
		in, want int64
	}{
		{0, 0},
		{-1, 0},
		{1, 1},
		{8_000_000, 8_000_000},
		{maxBPSCeiling, maxBPSCeiling},
		{maxBPSCeiling + 1, 0},
		{1 << 40, 0},
	} {
		if got := clampMaxBPS(tt.in); got != tt.want {
			t.Errorf("clampMaxBPS(%d) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestParseMaxBPS(t *testing.T) {
	for raw, want := range map[string]int64{
		"":            0,
		"  ":          0,
		"abc":         0,
		"8M":          0, // units are not accepted; bps only
		"-5":          0,
		"0":           0,
		"8000000":     8_000_000,
		" 8000000 ":   8_000_000,
		"1000000000":  maxBPSCeiling,
		"1000000001":  0,
		"99999999999": 0,
	} {
		if got := parseMaxBPS(raw); got != want {
			t.Errorf("parseMaxBPS(%q) = %d, want %d", raw, got, want)
		}
	}
}
