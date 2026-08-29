package streaming

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// stubExecutable puts a script of the given name at the front of PATH.
func stubExecutable(t *testing.T, name, body string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatalf("write %s stub: %v", name, err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// lingerAndExit runs body, leaves a grandchild holding the inherited stdout and
// stderr, and exits 0. That grandchild is the whole hazard: os/exec copies
// captured output through pipes, so Wait blocks until every holder of those
// descriptors closes them — not until the process exits — and nothing bounds
// how long a grandchild lives.
func lingerAndExit(body string) string {
	return body + "( sleep 5 ) &\nexit 0\n"
}

// A stub listing shaped like the real thing: "<flags> <name> <description>".
const stubEncoderListing = "cat <<'LISTING'\n" +
	"Encoders:\n" +
	" V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC\n" +
	" V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)\n" +
	"LISTING\n"

// The boot path's own version of the hang runProbeFFmpegDiag already guards.
// ffmpegHasEncoder runs from NewTranscodeManager twice over (DetectHWAccel and
// ProbeHEVCEncoder), so an unbounded Wait here is a server that never finishes
// starting.
//
// Both verdicts are asserted against the SAME listing with and without the
// lingering grandchild, because the decision this pins is that the grandchild
// changes nothing: ErrWaitDelay means the process exited 0 and CombinedOutput
// returns what it collected, so the listing is the real listing. Failing the
// probe instead would report every encoder missing on a box whose FFmpeg has
// them all; forcing it true would hand a doomed encoder to the test encode and
// blame the operator's driver for a build that never had it.
func TestFFmpegHasEncoder_ALingeringPipeChangesNeitherVerdictNorWait(t *testing.T) {
	cases := []struct {
		name    string
		encoder string
		want    bool
	}{
		{"listed", "h264_nvenc", true},
		{"absent from the listing", "h264_amf", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stubExecutable(t, "ffmpeg", stubEncoderListing+"exit 0\n")
			if got := ffmpegHasEncoder(tc.encoder); got != tc.want {
				t.Fatalf("control (no lingering pipe): got %v, want %v", got, tc.want)
			}

			stubExecutable(t, "ffmpeg", lingerAndExit(stubEncoderListing))
			start := time.Now()
			got := ffmpegHasEncoder(tc.encoder)
			elapsed := time.Since(start)

			if got != tc.want {
				t.Errorf("a grandchild holding the pipe changed the verdict: got %v, want %v", got, tc.want)
			}
			if elapsed >= 4*time.Second {
				t.Errorf("waited %s for a lingering pipe; WaitDelay is %s — this blocks startup", elapsed, execWaitDelay)
			}
		})
	}
}

// ffmpegSupportsReadrate has no context to lean on, which is the point: the
// WaitDelay timer for a context-less Cmd is started by Wait itself once the
// process is reaped, so the bound holds here too. A context would not have
// helped anyway — cancelling kills the process, and the descriptor is held by
// someone else.
func TestFFmpegSupportsReadrate_BoundedWithoutAContext(t *testing.T) {
	const banner = "echo 'ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers'\n"

	stubExecutable(t, "ffmpeg", banner+"exit 0\n")
	if !ffmpegSupportsReadrate() {
		t.Fatal("control (no lingering pipe): version 6 must enable readrate pacing")
	}

	stubExecutable(t, "ffmpeg", lingerAndExit(banner))
	start := time.Now()
	got := ffmpegSupportsReadrate()
	elapsed := time.Since(start)

	if !got {
		t.Error("a grandchild holding the pipe turned readrate pacing off")
	}
	if elapsed >= 4*time.Second {
		t.Errorf("waited %s for a lingering pipe; WaitDelay is %s — this blocks startup", elapsed, execWaitDelay)
	}
}

// Off the boot path, the same reading has teeth of its own: ErrWaitDelay means
// FFmpeg exited 0, so the .vtt it just wrote is complete. Treating it as a
// failure would delete a good extraction — up to ten minutes of reading through
// a container — and 500 the request that asked for it.
func TestExtractSubtitleVTT_LingeringPipeKeepsTheExtraction(t *testing.T) {
	// Writes WEBVTT to the last argument (ffmpeg's output path), then leaves a
	// grandchild on the pipe.
	stubExecutable(t, "ffmpeg", lingerAndExit(
		"for a in \"$@\"; do out=\"$a\"; done\n"+
			"printf 'WEBVTT\\n\\n' > \"$out\"\n"))

	start := time.Now()
	vtt, err := ExtractSubtitleVTT(context.Background(), "/nonexistent/movie.mkv", 2, t.TempDir())
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("extraction that exited 0 reported failure: %v", err)
	}
	if elapsed >= 4*time.Second {
		t.Errorf("waited %s for a lingering pipe; WaitDelay is %s", elapsed, execWaitDelay)
	}
	info, statErr := os.Stat(vtt)
	if statErr != nil {
		t.Fatalf("the extracted subtitle was deleted: %v", statErr)
	}
	if info.Size() == 0 {
		t.Fatal("the extracted subtitle is empty")
	}
}

// ---------------------------------------------------------------------------
// Source guards. The behavioral tests above pin how ONE captured-output command
// behaves; these pin that every other one in the package goes through the same
// helper, which is the part that silently rots as call sites are added.

// Every non-test file in the package must capture output through the bounded
// helpers. A bare cmd.Output()/cmd.CombinedOutput() is the exact shape of the
// bug: both attach writers, both therefore let Wait outlive the process, and
// neither carries a WaitDelay of its own.
func TestNoUnboundedOutputCapture(t *testing.T) {
	forEachPackageSource(t, func(t *testing.T, file, src string) {
		if file == "execwait.go" {
			return // the helpers themselves
		}
		for i, line := range strings.Split(src, "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "//") {
				continue
			}
			for _, call := range []string{".CombinedOutput()", ".Output()"} {
				if strings.Contains(line, call) {
					t.Errorf("%s:%d captures output with a bare %s — use boundedOutput/boundedCombinedOutput (execwait.go), "+
						"or Wait can block for as long as any subprocess holds the inherited descriptors", file, i+1, call)
				}
			}
		}
	})
}

// The counterpart for the two commands that attach their own writers instead of
// capturing (hwdecode.go's stderr tail, streaming.go's variant FFmpeg): the
// contract is identical, so the file must set a WaitDelay somewhere.
//
// This is a FILE-level check, not a per-command one — it cannot tell which cmd
// in a file got the WaitDelay. It catches a new attaching command in a file
// that has none (the realistic drift), not a second one in streaming.go. The
// bounded helpers are what make the common case unmissable; this is the
// backstop for the two hand-rolled sites.
func TestFilesThatAttachPipesBoundTheWait(t *testing.T) {
	attaches := regexp.MustCompile(`(?m)^\s*\w+\.Std(out|err)\b[^=]*=`)
	// The ASSIGNMENT, not the word: a comment discussing WaitDelay (there are
	// several) must not be able to satisfy this.
	bounds := regexp.MustCompile(`(?m)^\s*\w+\.WaitDelay\s*=`)

	forEachPackageSource(t, func(t *testing.T, file, src string) {
		loc := attaches.FindStringIndex(src)
		if loc == nil {
			return
		}
		if !bounds.MatchString(src) {
			line := 1 + strings.Count(src[:loc[0]], "\n")
			t.Errorf("%s:%d attaches a writer to a command's Stdout/Stderr but the file never sets WaitDelay — "+
				"Wait will block until every holder of those descriptors closes them", file, line)
		}
	})
}

func forEachPackageSource(t *testing.T, check func(t *testing.T, file, src string)) {
	t.Helper()
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob package sources: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("no package sources found; this guard would pass vacuously")
	}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		check(t, file, string(src))
	}
}
