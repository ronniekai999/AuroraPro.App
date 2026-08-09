package library

import "testing"

// parseFrameRate feeds the fps-aware H.264 level table (migration 053).
// Wrong parsing here mis-stamps levels: a 59.94 file read as 0 silently
// keeps the under-declared 4.0/5.1, and garbage read as >30 would bump
// ≤30fps content off the Chromecast-pinned rungs. Both directions are
// pinned down below.
func TestParseFrameRate(t *testing.T) {
	tests := []struct {
		in   string
		want float64
	}{
		{"30000/1001", 29.97002997002997}, // NTSC 30
		{"60000/1001", 59.94005994005994}, // NTSC 60
		{"24/1", 24},
		{"25/1", 25},
		{"60/1", 60},
		{"24000/1001", 23.976023976023978},
		{"50/1", 50},
		{"0/0", 0},     // ffprobe's unknown sentinel
		{"", 0},        // missing field
		{"garbage", 0}, // malformed
		{"30/0", 0},    // zero denominator
		{"0/1", 0},     // zero numerator
		{"-24/1", 0},   // negative is nonsense
		{" 60/1 ", 60}, // whitespace tolerated
		{"NaN", 0},     // ParseFloat accepts NaN — must not reach the DB
		{"1e999/1", 0}, // overflows to +Inf — encoding/json would choke
	}
	for _, tt := range tests {
		if got := parseFrameRate(tt.in); got != tt.want {
			t.Errorf("parseFrameRate(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
}
