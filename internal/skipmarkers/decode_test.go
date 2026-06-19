package skipmarkers

import (
	"slices"
	"strings"
	"testing"
)

// Credits detection MUST run as two separate single-stream passes. A
// single invocation that filters both video (-vf blackdetect) and audio
// (-af silencedetect) into one `-f null` output makes FFmpeg buffer raw
// decoded frames to interleave the streams, ballooning RSS into the tens
// of GB and OOM-ing the host. These tests pin the split so the combined
// invocation can't quietly come back.

func TestBlackDetectArgsAreVideoOnly(t *testing.T) {
	args := blackDetectArgs("/media/show.mkv", 1234.56)
	if slices.Contains(args, "-af") {
		t.Fatal("black pass must not run an audio filter (-af): streams must not share an output")
	}
	if !slices.Contains(args, "-an") {
		t.Fatal("black pass must drop audio (-an) so the output is single-stream")
	}
	if !hasFilter(args, "-vf", "blackdetect") {
		t.Fatal("black pass must run blackdetect")
	}
	assertSeekAndInput(t, args, "1234.56", "/media/show.mkv")
}

func TestSilenceDetectArgsAreAudioOnly(t *testing.T) {
	args := silenceDetectArgs("/media/show.mkv", 1234.56)
	if slices.Contains(args, "-vf") {
		t.Fatal("silence pass must not run a video filter (-vf): streams must not share an output")
	}
	if !slices.Contains(args, "-vn") {
		t.Fatal("silence pass must drop video (-vn) so the output is single-stream")
	}
	if !hasFilter(args, "-af", "silencedetect") {
		t.Fatal("silence pass must run silencedetect")
	}
	assertSeekAndInput(t, args, "1234.56", "/media/show.mkv")
}

// A video-only file (no audio) makes the silence pass exit non-zero with
// "does not contain any stream"; an audio-only file does the same to the
// black pass. That must be treated as an empty result (file still gets
// ledgered), not a hard error that re-attempts the file every sweep. Real
// decode/IO failures must stay fatal so the file is retried.
func TestStreamAbsentClassification(t *testing.T) {
	absent := []string{
		"Output file #0 does not contain any stream",
		"Output file does not contain any stream",
		"Stream map '0:a:0' matches no streams.",
	}
	for _, s := range absent {
		if !streamAbsent(s) {
			t.Errorf("streamAbsent(%q) = false, want true (missing stream is a benign empty result)", s)
		}
	}
	fatal := []string{
		"Error opening input: Input/output error",
		"Invalid data found when processing input",
		"",
	}
	for _, s := range fatal {
		if streamAbsent(s) {
			t.Errorf("streamAbsent(%q) = true, want false (real errors must stay fatal and retry)", s)
		}
	}
}

func hasFilter(args []string, flag, name string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && strings.Contains(args[i+1], name) {
			return true
		}
	}
	return false
}

func assertSeekAndInput(t *testing.T, args []string, wantSeek, wantPath string) {
	t.Helper()
	if !slices.Contains(args, "-ss") || !slices.Contains(args, "-i") {
		t.Fatal("pass must input-seek (-ss) and set input (-i)")
	}
	for i := 0; i+1 < len(args); i++ {
		switch args[i] {
		case "-ss":
			if args[i+1] != wantSeek {
				t.Fatalf("-ss = %q, want %q", args[i+1], wantSeek)
			}
		case "-i":
			if args[i+1] != wantPath {
				t.Fatalf("-i = %q, want %q", args[i+1], wantPath)
			}
		}
	}
}
