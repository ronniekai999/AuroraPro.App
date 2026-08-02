package watchparty

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestHighlightReelArgs_ExplicitMuxer is the regression test that matters,
// because it runs everywhere — including CI, which has no ffmpeg.
//
// The bug: generateHighlightReel renders to "<code>-<id>.mp4.tmp" (atomic-
// rename staging) and the argv carried no -f flag. ffmpeg infers the muxer
// from the output extension, ".tmp" matches nothing, and every render in
// production died before encoding a single frame with:
//
//	Unable to choose an output format for '...mp4.tmp'; use a standard
//	extension for the filename or specify the format manually.
//	Error initializing the muxer ...: Invalid argument
//
// The feature was 100%% dead and nothing caught it: every pre-existing test
// covered the moment-bucketing math, and the only way to observe the failure
// was to run ffmpeg against a .tmp path.
func TestHighlightReelArgs_ExplicitMuxer(t *testing.T) {
	moments := []highlightMoment{{CenterMs: 5000, Count: 9}, {CenterMs: 12000, Count: 4}}
	outPath := "/var/cache/aurora/images/party-highlights/AH2T5Y-4.mp4.tmp"
	args := highlightReelArgs("/media/movie.mkv", outPath, moments)

	// The output path must be last — ffmpeg treats a trailing bare argument
	// as the output file, and anything after it would be misparsed.
	if got := args[len(args)-1]; got != outPath {
		t.Fatalf("output path must be the final argument, got %q", got)
	}

	// -f mp4 must be present AND positioned before the output path: ffmpeg
	// applies output options only to the output that follows them.
	fIdx := -1
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "-f" {
			if args[i+1] != "mp4" {
				t.Fatalf("-f must select the mp4 muxer, got %q", args[i+1])
			}
			fIdx = i
		}
	}
	if fIdx == -1 {
		t.Fatalf("argv has no explicit -f muxer; a .tmp output path makes ffmpeg's "+
			"extension-based inference fail and the render dies.\nargv: %v", args)
	}
	if fIdx > len(args)-2 {
		t.Fatalf("-f mp4 must precede the output path (found at %d of %d)", fIdx, len(args))
	}
}

// TestHighlightReelArgs_OneInputPerMoment pins the input/filtergraph pairing —
// the concat filter references [N:v:0]/[N:a:0] for every N, so a mismatch
// between input count and concat arity is a silent graph-build failure.
func TestHighlightReelArgs_OneInputPerMoment(t *testing.T) {
	moments := []highlightMoment{{CenterMs: 5000}, {CenterMs: 12000}, {CenterMs: 30000}}
	args := highlightReelArgs("/media/movie.mkv", "/tmp/out.mp4.tmp", moments)

	inputs := 0
	for _, a := range args {
		if a == "-i" {
			inputs++
		}
	}
	if inputs != len(moments) {
		t.Fatalf("expected %d inputs, got %d", len(moments), inputs)
	}

	var fc string
	for i, a := range args {
		if a == "-filter_complex" && i+1 < len(args) {
			fc = args[i+1]
		}
	}
	if want := "concat=n=3:v=1:a=1[outv][outa]"; !strings.Contains(fc, want) {
		t.Fatalf("filtergraph concat arity should match input count\n  want substring: %s\n  got: %s", want, fc)
	}
}

// TestHighlightReelArgs_ClampsNegativeStart guards the -ss floor: a reaction
// in the first 3 seconds would otherwise seek to a negative timestamp.
func TestHighlightReelArgs_ClampsNegativeStart(t *testing.T) {
	args := highlightReelArgs("/media/movie.mkv", "/tmp/out.mp4.tmp",
		[]highlightMoment{{CenterMs: 500, Count: 3}})
	for i, a := range args {
		if a == "-ss" && i+1 < len(args) {
			if strings.HasPrefix(args[i+1], "-") {
				t.Fatalf("-ss must never be negative, got %q", args[i+1])
			}
		}
	}
}

// synthSource writes a short A/V clip to a temp file and returns its path.
// renderHighlightReel's filtergraph references both [N:v:0] and [N:a:0] for
// every input, so the fixture must carry an audio stream or the graph fails
// to build for reasons unrelated to what we're testing.
func synthSource(t *testing.T, ffmpeg string) string {
	t.Helper()
	src := filepath.Join(t.TempDir(), "source.mkv")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc=duration=20:size=320x240:rate=15",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=20",
		"-c:v", "libx264", "-preset", "ultrafast",
		"-c:a", "aac",
		"-shortest",
		src,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("could not synthesize test source (ffmpeg lacks libx264/aac?): %v\n%s", err, out)
	}
	return src
}

// TestRenderHighlightReel_TmpExtension is the regression test for the bug that
// made the highlight-reel feature 100%% dead in production: generateHighlightReel
// renders to "<code>-<id>.mp4.tmp" (atomic-rename staging) and renderHighlightReel
// passed that path to ffmpeg with no -f flag. ffmpeg infers the muxer from the
// extension, ".tmp" matches nothing, and every single render died with:
//
//	Unable to choose an output format for '...mp4.tmp'; use a standard extension
//	for the filename or specify the format manually.
//	Error initializing the muxer ...: Invalid argument
//
// The pre-existing unit tests all exercised the moment-bucketing math and never
// invoked ffmpeg, which is exactly how this shipped and stayed broken. This test
// renders to a .tmp path specifically — a test that wrote to "out.mp4" would
// have passed against the broken code.
func TestRenderHighlightReel_TmpExtension(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not in PATH")
	}
	src := synthSource(t, ffmpeg)

	// Mirror the real staging path shape from generateHighlightReel.
	outPath := filepath.Join(t.TempDir(), "AH2T5Y-4.mp4")
	tmpPath := outPath + ".tmp"

	moments := []highlightMoment{
		{CenterMs: 5000, Count: 9},
		{CenterMs: 12000, Count: 4},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	if rerr := renderHighlightReel(ctx, src, tmpPath, moments); rerr != nil {
		t.Fatalf("render to .tmp path failed: %v", rerr)
	}

	st, serr := os.Stat(tmpPath)
	if serr != nil {
		t.Fatalf("expected output at %s: %v", tmpPath, serr)
	}
	if st.Size() == 0 {
		t.Fatal("rendered reel is empty")
	}

	// The staged file must be a real MP4, not merely non-empty — the muxer
	// flag is the whole point, so assert ffprobe agrees on the container.
	ffprobe, perr := exec.LookPath("ffprobe")
	if perr != nil {
		return // size check above still proves the muxer accepted the path
	}
	probe := exec.CommandContext(ctx, ffprobe, "-hide_banner", "-loglevel", "error",
		"-show_entries", "format=format_name", "-of", "default=nw=1:nk=1", tmpPath)
	out, probeErr := probe.Output()
	if probeErr != nil {
		t.Fatalf("ffprobe rejected the staged reel: %v", probeErr)
	}
	if got := strings.TrimSpace(string(out)); !strings.Contains(got, "mp4") {
		t.Fatalf("staged reel is not an MP4 container: format_name=%q", got)
	}
}

// TestRenderHighlightReel_NoMoments guards the early return — a party with no
// reactions must not shell out to ffmpeg at all.
func TestRenderHighlightReel_NoMoments(t *testing.T) {
	err := renderHighlightReel(context.Background(), "/nonexistent/source.mkv",
		filepath.Join(t.TempDir(), "out.mp4.tmp"), nil)
	if err == nil {
		t.Fatal("expected an error when rendering zero moments")
	}
	if !strings.Contains(err.Error(), "no moments") {
		t.Fatalf("unexpected error: %v", err)
	}
}
