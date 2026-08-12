package streaming

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestEscapeFFmpegPath_RealFFmpeg proves the two-level filtergraph escaping
// against an actual ffmpeg binary: for each hostile path shape, a real .srt is
// written at that path and ffmpeg must OPEN it through the subtitles filter
// (with a trailing :stream_index= option, so option separation is exercised
// too). This is the test that the pure-string TestEscapeFFmpegPath cannot be:
// the original single-level escaping passed the string test while every
// apostrophe/colon path failed against real ffmpeg (option-level quote region
// swallowed the rest of the argument string).
//
// Skipped when ffmpeg — or its libass-backed subtitles filter — is not
// available, so CI without media tooling is unaffected.
func TestEscapeFFmpegPath_RealFFmpeg(t *testing.T) {
	// Both guards escalate to failures under AURORA_REQUIRE_MEDIA_TESTS (CI):
	// this test's whole value is that it runs against a REAL ffmpeg, so a
	// silent skip in the pipeline is indistinguishable from deleting it.
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		failOrSkipMedia(t, "ffmpeg not in PATH")
	}
	filters, _ := exec.Command(ffmpeg, "-hide_banner", "-filters").Output()
	if !strings.Contains(string(filters), " subtitles ") {
		failOrSkipMedia(t, "ffmpeg lacks the subtitles filter (built without libass)")
	}

	names := []string{
		"Ocean's Eleven",                  // apostrophe: quote syntax at both parse levels
		"Mission: Impossible",             // colon: option separator
		"a,b;c=d[e]f",                     // graph separators, key/value, link labels
		`back\slash`,                      // literal backslash (legal in Linux filenames)
		"It's a Mad, Mad World: Part [2]", // everything at once
	}
	srt := "1\n00:00:00,000 --> 00:00:01,000\nHello\n"

	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			subPath := filepath.Join(t.TempDir(), name+".srt")
			if werr := os.WriteFile(subPath, []byte(srt), 0o644); werr != nil {
				t.Skipf("filesystem rejects %q: %v", name, werr)
			}

			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			vf := "subtitles=" + escapeFFmpegPath(subPath) + ":stream_index=0"
			cmd := exec.CommandContext(ctx, ffmpeg, "-hide_banner",
				"-f", "lavfi", "-i", "testsrc=duration=0.2:size=64x64:rate=10",
				"-vf", vf,
				"-frames:v", "1", "-f", "null", "-")
			out, runErr := cmd.CombinedOutput()
			if runErr != nil {
				tail := string(out)
				if len(tail) > 800 {
					tail = tail[len(tail)-800:]
				}
				t.Fatalf("ffmpeg rejected escaped path\n  path: %q\n  -vf:  %q\n  err:  %v\n  stderr tail:\n%s",
					subPath, vf, runErr, tail)
			}
		})
	}
}
