// 2026-05-28 — Tests for ShiftVTTCues. Issue #131 — when a transcode
// session uses -ss to seek the input, the player's HLS time domain
// (currentTime=0 corresponds to file-time=startSec) no longer matches
// the subtitle cue domain. The shifter rewrites cue timestamps so the
// browser fires them at the correct moment after resume.
package streaming

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTempVTT(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatalf("write temp vtt: %v", err)
	}
	return p
}

func TestShiftVTTCuesNoOpWhenStartSecZero(t *testing.T) {
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nhi\n")
	got, err := ShiftVTTCues(src, 0, dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != src {
		t.Errorf("startSec=0 should return source path unchanged; got %q want %q", got, src)
	}
}

func TestShiftVTTCuesNoOpWhenNegative(t *testing.T) {
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nhi\n")
	got, err := ShiftVTTCues(src, -50, dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != src {
		t.Errorf("negative startSec should be no-op; got %q want %q", got, src)
	}
}

func TestShiftVTTCuesShiftsTimestamps(t *testing.T) {
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", strings.Join([]string{
		"WEBVTT",
		"",
		"00:30:00.000 --> 00:30:02.000",
		"first line at 30 min",
		"",
		"00:30:30.500 --> 00:30:33.250",
		"second line",
		"",
	}, "\n"))
	// Resume at 30:00 (1800s). Cue #1 starts exactly at the resume
	// point; cue #2 is 30.5s later in the original file. After shift:
	// cue #1 should be 00:00:00.000 → 00:00:02.000.
	// cue #2 should be 00:00:30.500 → 00:00:33.250.
	got, err := ShiftVTTCues(src, 1800, dir)
	if err != nil {
		t.Fatalf("shift err: %v", err)
	}
	if got == src {
		t.Fatalf("expected new file path; got source path")
	}
	data, err := os.ReadFile(got)
	if err != nil {
		t.Fatalf("read shifted: %v", err)
	}
	out := string(data)
	if !strings.Contains(out, "00:00:00.000 --> 00:00:02.000") {
		t.Errorf("expected cue 1 shifted to 00:00:00.000 → 00:00:02.000; got:\n%s", out)
	}
	if !strings.Contains(out, "00:00:30.500 --> 00:00:33.250") {
		t.Errorf("expected cue 2 shifted to 00:00:30.500 → 00:00:33.250; got:\n%s", out)
	}
	// The original timestamps should NOT survive.
	if strings.Contains(out, "00:30:00.000") {
		t.Errorf("original cue 1 timestamp leaked through; got:\n%s", out)
	}
}

func TestShiftVTTCuesDropsFullyNegativeCues(t *testing.T) {
	dir := t.TempDir()
	// Three cues in the original. Resume at 60s.
	// - Cue 1 ends at 0:30 → fully in the past → DROP
	// - Cue 2 straddles the resume point (0:50 → 1:10) → CLAMP start to 0
	// - Cue 3 is after resume (2:00 → 2:05) → SHIFT to 1:00 → 1:05
	src := writeTempVTT(t, dir, "in.vtt", strings.Join([]string{
		"WEBVTT",
		"",
		"00:00:20.000 --> 00:00:30.000",
		"DROP ME",
		"",
		"00:00:50.000 --> 00:01:10.000",
		"clamped",
		"",
		"00:02:00.000 --> 00:02:05.000",
		"shifted",
		"",
	}, "\n"))
	got, err := ShiftVTTCues(src, 60, dir)
	if err != nil {
		t.Fatalf("shift err: %v", err)
	}
	data, _ := os.ReadFile(got)
	out := string(data)

	if strings.Contains(out, "DROP ME") {
		t.Errorf("fully-past cue should be dropped; got:\n%s", out)
	}
	if !strings.Contains(out, "00:00:00.000 --> 00:00:10.000") {
		t.Errorf("straddling cue should clamp start to 0 and shift end; got:\n%s", out)
	}
	if !strings.Contains(out, "clamped") {
		t.Errorf("straddling cue text should still appear; got:\n%s", out)
	}
	if !strings.Contains(out, "00:01:00.000 --> 00:01:05.000") {
		t.Errorf("after-resume cue should shift correctly; got:\n%s", out)
	}
	if !strings.Contains(out, "shifted") {
		t.Errorf("after-resume cue text should still appear; got:\n%s", out)
	}
}

func TestShiftVTTCuesPreservesHeader(t *testing.T) {
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", strings.Join([]string{
		"WEBVTT - Sample subtitle",
		"NOTE",
		"This is a comment block",
		"that spans multiple lines.",
		"",
		"00:01:00.000 --> 00:01:02.000",
		"hi",
		"",
	}, "\n"))
	got, err := ShiftVTTCues(src, 10, dir)
	if err != nil {
		t.Fatalf("shift err: %v", err)
	}
	data, _ := os.ReadFile(got)
	out := string(data)
	if !strings.HasPrefix(out, "WEBVTT - Sample subtitle") {
		t.Errorf("WEBVTT header should be preserved verbatim; got first line:\n%q", strings.Split(out, "\n")[0])
	}
	if !strings.Contains(out, "NOTE") {
		t.Errorf("NOTE comment block should be preserved")
	}
	if !strings.Contains(out, "00:00:50.000 --> 00:00:52.000") {
		t.Errorf("cue should shift correctly even after NOTE block; got:\n%s", out)
	}
}

func TestShiftVTTCuesCachesResult(t *testing.T) {
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nhi\n")
	first, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	infoFirst, err := os.Stat(first)
	if err != nil {
		t.Fatalf("stat first: %v", err)
	}
	// Second call with the same args should reuse the cached file
	// (same path, same mtime).
	second, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if second != first {
		t.Errorf("expected same cached path, got %q vs %q", first, second)
	}
	infoSecond, _ := os.Stat(second)
	if !infoSecond.ModTime().Equal(infoFirst.ModTime()) {
		t.Errorf("cached file's mtime changed — cache was rebuilt unnecessarily")
	}
}

func TestShiftVTTCuesHandlesCueIDLines(t *testing.T) {
	// Some VTT files include an optional cue ID line BEFORE the
	// timing line. The shifter must preserve cue IDs for kept cues
	// and drop them along with dropped (fully-past) cues.
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", strings.Join([]string{
		"WEBVTT",
		"",
		"cue-1",
		"00:00:10.000 --> 00:00:12.000",
		"DROP ME — fully past",
		"",
		"cue-2",
		"00:02:00.000 --> 00:02:05.000",
		"keep me",
		"",
	}, "\n"))
	got, err := ShiftVTTCues(src, 30, dir)
	if err != nil {
		t.Fatalf("shift err: %v", err)
	}
	data, _ := os.ReadFile(got)
	out := string(data)
	if strings.Contains(out, "cue-1") {
		t.Errorf("cue-1 id should be dropped with its now-past timing; got:\n%s", out)
	}
	if strings.Contains(out, "DROP ME") {
		t.Errorf("dropped cue text leaked through; got:\n%s", out)
	}
	if !strings.Contains(out, "cue-2") {
		t.Errorf("cue-2 id should be preserved for the kept cue; got:\n%s", out)
	}
	if !strings.Contains(out, "00:01:30.000 --> 00:01:35.000") {
		t.Errorf("cue-2 should shift to 01:30 → 01:35; got:\n%s", out)
	}
}

func TestShiftVTTCuesPreservesMultiLineStyleBlock(t *testing.T) {
	// Deep-debug C1 — STYLE blocks can span multiple lines with CSS
	// rules. Previous line-by-line parser would flush CSS rules
	// individually through the cue-id path. Block-mode parser keeps
	// the entire STYLE block verbatim.
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", strings.Join([]string{
		"WEBVTT",
		"",
		"STYLE",
		"::cue {",
		"  background-color: rgba(0, 0, 0, 0.6);",
		"  color: yellow;",
		"}",
		"::cue(b) {",
		"  font-weight: bold;",
		"}",
		"",
		"00:01:00.000 --> 00:01:02.000",
		"hi",
		"",
	}, "\n"))
	got, err := ShiftVTTCues(src, 10, dir)
	if err != nil {
		t.Fatalf("shift err: %v", err)
	}
	data, _ := os.ReadFile(got)
	out := string(data)
	// All STYLE block lines must survive verbatim.
	for _, want := range []string{
		"STYLE",
		"::cue {",
		"background-color: rgba(0, 0, 0, 0.6);",
		"color: yellow;",
		"::cue(b) {",
		"font-weight: bold;",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("STYLE block line %q missing from output:\n%s", want, out)
		}
	}
	// The cue still shifts correctly.
	if !strings.Contains(out, "00:00:50.000 --> 00:00:52.000") {
		t.Errorf("cue should shift to 00:50 → 00:52; got:\n%s", out)
	}
}

func TestShiftVTTCuesPreservesMultiLineNoteBlock(t *testing.T) {
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", strings.Join([]string{
		"WEBVTT",
		"",
		"NOTE",
		"Translator: Jane Doe",
		"Source: Original Spanish dub",
		"Created: 2026-05-28",
		"",
		"00:01:00.000 --> 00:01:02.000",
		"hi",
		"",
	}, "\n"))
	got, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("shift err: %v", err)
	}
	data, _ := os.ReadFile(got)
	out := string(data)
	for _, want := range []string{
		"NOTE",
		"Translator: Jane Doe",
		"Source: Original Spanish dub",
		"Created: 2026-05-28",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("NOTE block line %q missing from output:\n%s", want, out)
		}
	}
}

func TestShiftVTTCuesHandlesTrailingCueIDAtEOF(t *testing.T) {
	// Deep-debug H1 — a trailing cue-id with no timing line at EOF
	// is malformed VTT; the previous parser would emit the orphan
	// id. Block-mode parser treats unrecognized blocks as
	// passthrough, which is the safer behavior (preserves source
	// data for forensics) but does NOT corrupt the output.
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", strings.Join([]string{
		"WEBVTT",
		"",
		"00:00:30.000 --> 00:00:32.000",
		"first cue",
		"",
		"orphan-cue-id-no-timing-line",
	}, "\n"))
	got, err := ShiftVTTCues(src, 10, dir)
	if err != nil {
		t.Fatalf("shift err: %v", err)
	}
	data, _ := os.ReadFile(got)
	out := string(data)
	// The valid cue shifts.
	if !strings.Contains(out, "00:00:20.000 --> 00:00:22.000") {
		t.Errorf("valid cue should shift to 00:20 → 00:22; got:\n%s", out)
	}
	if !strings.Contains(out, "first cue") {
		t.Errorf("cue text missing; got:\n%s", out)
	}
	// The orphan id is passed through as an unrecognized block —
	// not dropped silently (forensic preservation), not promoted
	// to a fake timing line.
	if !strings.Contains(out, "orphan-cue-id-no-timing-line") {
		t.Errorf("orphan id should be passed through as unknown block; got:\n%s", out)
	}
}

func TestShiftVTTCuesCollapsesMultipleBlankSeparators(t *testing.T) {
	// VTT spec says one or more blank lines separate blocks. Our
	// block grouping collapses runs of blanks into a single
	// separator. Verify the output uses exactly one blank between
	// blocks (no spurious extras, no missing).
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", strings.Join([]string{
		"WEBVTT",
		"",
		"",
		"",
		"00:00:30.000 --> 00:00:32.000",
		"one",
		"",
		"",
		"00:01:00.000 --> 00:01:02.000",
		"two",
		"",
	}, "\n"))
	got, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("shift err: %v", err)
	}
	data, _ := os.ReadFile(got)
	out := string(data)
	// Should NOT contain four consecutive newlines (that would be
	// three blank lines, indicating uncollapsed runs).
	if strings.Contains(out, "\n\n\n\n") {
		t.Errorf("output has uncollapsed multi-blank runs; got:\n%s", out)
	}
	// Both cues should still be present and shifted.
	if !strings.Contains(out, "00:00:25.000 --> 00:00:27.000") {
		t.Errorf("first cue missing or wrong; got:\n%s", out)
	}
	if !strings.Contains(out, "00:00:55.000 --> 00:00:57.000") {
		t.Errorf("second cue missing or wrong; got:\n%s", out)
	}
}

func TestShiftVTTCuesNoBlankBetweenWEBVTTAndFirstCueIsOK(t *testing.T) {
	// Some non-strict VTT producers omit the blank line between the
	// WEBVTT header and the first cue. This produces a single
	// "block" mixing both — verify we don't choke.
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", strings.Join([]string{
		"WEBVTT",
		"00:00:30.000 --> 00:00:32.000",
		"hi",
		"",
	}, "\n"))
	got, err := ShiftVTTCues(src, 10, dir)
	if err != nil {
		t.Fatalf("shift err: %v", err)
	}
	data, _ := os.ReadFile(got)
	out := string(data)
	// First block is treated as the header (because it's block index 0)
	// and passed through verbatim. The timing line embedded in it
	// will NOT be shifted, but the file is at least not corrupted.
	if !strings.Contains(out, "WEBVTT") {
		t.Errorf("WEBVTT header missing; got:\n%s", out)
	}
	// Defensive: just make sure the output doesn't error out and the
	// cue text is still present (whether shifted or not).
	if !strings.Contains(out, "hi") {
		t.Errorf("cue text lost; got:\n%s", out)
	}
}

func TestParseVTTTimestamp(t *testing.T) {
	cases := []struct {
		in   string
		want float64
	}{
		{"00:00:00.000", 0},
		{"00:00:01.500", 1.5},
		{"00:01:00.000", 60},
		{"01:00:00.000", 3600},
		{"02:30:45.250", 9045.25},
		// MM:SS.fff form (no hours)
		{"30:00.000", 1800},
		{"01:30.500", 90.5},
	}
	for _, c := range cases {
		got := parseVTTTimestamp(c.in)
		if got != c.want {
			t.Errorf("parseVTTTimestamp(%q) = %v; want %v", c.in, got, c.want)
		}
	}
}

func TestFormatVTTTimestamp(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{0, "00:00:00.000"},
		{1.5, "00:00:01.500"},
		{60, "00:01:00.000"},
		{3600, "01:00:00.000"},
		{9045.250, "02:30:45.250"},
		// Negative input clamps to 0.
		{-5, "00:00:00.000"},
	}
	for _, c := range cases {
		got := formatVTTTimestamp(c.in)
		if got != c.want {
			t.Errorf("formatVTTTimestamp(%v) = %q; want %q", c.in, got, c.want)
		}
	}
}
