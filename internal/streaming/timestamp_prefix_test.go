package streaming

// Tests for timestampPrefixArgs — the FFmpeg input-side timestamp options
// chosen by delivery path. Extracted from startVariantImpl so the A/V-anchoring
// contract is unit-testable without spawning FFmpeg. See #348: the fresh-start
// transcode branch used to emit +genpts without -copyts/-start_at_zero, which
// left re-encoded (EAC-3→AAC) audio unanchored to the force-keyframed video and
// produced audible drops at the first two segment boundaries on hls.js.

import (
	"slices"
	"strings"
	"testing"
)

func TestTimestampPrefixArgs_Remux(t *testing.T) {
	// Remux over MPEG-TS: -copyts/-start_at_zero, avoid_negative_ts disabled.
	got := timestampPrefixArgs(&TranscodeSession{Remux: true, FMP4: false})
	if !slices.Contains(got, "-copyts") || !slices.Contains(got, "-start_at_zero") {
		t.Fatalf("remux must anchor with -copyts -start_at_zero, got %v", got)
	}
	if !slices.Contains(got, "-avoid_negative_ts") || !slices.Contains(got, "disabled") {
		t.Errorf("remux over TS must use avoid_negative_ts disabled, got %v", got)
	}
	if slices.Contains(got, "+genpts") {
		t.Errorf("remux must never use +genpts (clashes with copied video PTS), got %v", got)
	}
	if slices.Contains(got, "+discardcorrupt") {
		t.Errorf("remux must not carry +discardcorrupt (transcode-only), got %v", got)
	}
}

func TestTimestampPrefixArgs_TranscodeFMP4(t *testing.T) {
	// Full transcode over fMP4 (the #348 path: EAC-3 promoted to transcode,
	// Chrome/hls.js, play-from-start). Must anchor A/V with -copyts
	// -start_at_zero and use avoid_negative_ts make_zero for the fMP4 muxer.
	got := timestampPrefixArgs(&TranscodeSession{Remux: false, FMP4: true})
	for _, want := range []string{"-copyts", "-start_at_zero", "-avoid_negative_ts", "make_zero", "+discardcorrupt"} {
		if !slices.Contains(got, want) {
			t.Errorf("transcode/fMP4 missing %q, got %v", want, got)
		}
	}
	if slices.Contains(got, "+genpts") {
		t.Errorf("transcode must not use +genpts — it leaves re-encoded audio unanchored to video (#348), got %v", got)
	}
}

func TestTimestampPrefixArgs_TranscodeTS(t *testing.T) {
	// Full transcode over MPEG-TS: avoid_negative_ts disabled (the TS muxer
	// tolerates/needs it; make_zero would add the ~1.4 s offset that desyncs
	// subtitle cue times). This also pins the prior-inconsistency fix where
	// fresh-start hard-coded make_zero even on TS.
	got := timestampPrefixArgs(&TranscodeSession{Remux: false, FMP4: false})
	if !slices.Contains(got, "-copyts") || !slices.Contains(got, "-start_at_zero") {
		t.Fatalf("transcode/TS must anchor with -copyts -start_at_zero, got %v", got)
	}
	if !slices.Contains(got, "-avoid_negative_ts") || !slices.Contains(got, "disabled") {
		t.Errorf("transcode/TS must use avoid_negative_ts disabled, got %v", got)
	}
	if slices.Contains(got, "make_zero") {
		t.Errorf("transcode/TS must not use make_zero (desyncs subtitles), got %v", got)
	}
	if slices.Contains(got, "+genpts") {
		t.Errorf("transcode/TS must not use +genpts (#348), got %v", got)
	}
}

func TestTimestampPrefixArgs_NoGenptsAnywhere(t *testing.T) {
	// Regression guard for #348: no path may emit +genpts (exact token or as
	// part of a compound flag like "+genpts+discardcorrupt"), which was the
	// root cause of the startup audio drift on re-encoded audio.
	cases := []struct {
		name    string
		session *TranscodeSession
	}{
		{"remux-ts", &TranscodeSession{Remux: true, FMP4: false}},
		{"remux-fmp4", &TranscodeSession{Remux: true, FMP4: true}},
		{"transcode-ts", &TranscodeSession{Remux: false, FMP4: false}},
		{"transcode-fmp4", &TranscodeSession{Remux: false, FMP4: true}},
	}
	for _, c := range cases {
		got := timestampPrefixArgs(c.session)
		if slices.ContainsFunc(got, func(a string) bool { return strings.Contains(a, "+genpts") }) {
			t.Errorf("%s: +genpts must never appear (causes #348 startup audio drift), got %v", c.name, got)
		}
		// Every path must anchor A/V together.
		if !slices.Contains(got, "-copyts") || !slices.Contains(got, "-start_at_zero") {
			t.Errorf("%s: must anchor A/V with -copyts -start_at_zero, got %v", c.name, got)
		}
	}
}
