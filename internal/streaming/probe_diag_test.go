package streaming

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// stubFFmpeg puts a script named ffmpeg at the front of PATH.
func stubFFmpeg(t *testing.T, body string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ffmpeg"), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatalf("write ffmpeg stub: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// Covers the seam the unit tests above can't: stderr actually arriving through
// os/exec into the tail buffer and out as a summary.
func TestRunProbeFFmpegDiag_CarriesTheReasonThroughExec(t *testing.T) {
	stubFFmpeg(t, strings.Join([]string{
		"echo 'ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers' >&2",
		"echo '  libavutil      58. 29.100 / 58. 29.100' >&2",
		"echo '[h264_amf @ 0x1] AMF failed to initialise: no compatible device found' >&2",
		"exit 1",
	}, "\n")+"\n")

	reason, err := runProbeFFmpegDiag([]string{"-hide_banner"})
	if err == nil {
		t.Fatal("a stub exiting 1 must report failure")
	}
	if !strings.Contains(reason, "no compatible device found") {
		t.Fatalf("the reason did not survive the exec path: %q", reason)
	}
	if strings.Contains(reason, "libavutil") {
		t.Fatalf("banner leaked into the reason: %q", reason)
	}
}

// The failure mode WaitDelay introduces. os/exec returns ErrWaitDelay — not
// nil — when a process exits SUCCESSFULLY but leaves a pipe open past the
// delay. Reading that as a failed probe would disable hardware acceleration on
// a box whose encoder works, and raise a "test encode failed" warning quoting
// stderr from an encode that succeeded. The verdict comes from the exit
// status, not from how tidily the process closed its descriptors.
//
// Unreachable before this change: a nil Stderr has no pipe to leave open.
func TestRunProbeFFmpegDiag_SuccessWithALingeringPipeIsStillSuccess(t *testing.T) {
	// The grandchild inherits stderr and outlives its parent, so the pipe
	// stays open well after the stub itself exits 0.
	stubFFmpeg(t, "( sleep 5 ) &\nexit 0\n")

	start := time.Now()
	reason, err := runProbeFFmpegDiag([]string{"-hide_banner"})
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("a probe that exited 0 was reported as failed: %v (reason %q)", err, reason)
	}
	// It must also have stopped waiting, rather than blocking until the
	// grandchild finished — that is the hang WaitDelay is here to prevent.
	if elapsed >= 4*time.Second {
		t.Fatalf("probe waited %s for a lingering pipe; WaitDelay is %s", elapsed, probeWaitDelay)
	}
}

// Every decode probe still rides on runProbeFFmpeg's bool. Rewiring it through
// the diagnostic runner must not have changed what it reports.
func TestRunProbeFFmpeg_BoolContractUnchanged(t *testing.T) {
	stubFFmpeg(t, "exit 0\n")
	if !runProbeFFmpeg([]string{"-hide_banner"}) {
		t.Fatal("a probe that exits 0 must report success")
	}

	stubFFmpeg(t, "echo 'Unknown encoder' >&2\nexit 1\n")
	if runProbeFFmpeg([]string{"-hide_banner"}) {
		t.Fatal("a probe that exits 1 must report failure")
	}
}

// The point of capturing probe stderr is that the operator can act on it. A
// summary that keeps FFmpeg's banner and drops the error is worse than no
// summary at all — it fills the log line with version noise and still doesn't
// say why the encoder failed.

func TestProbeErrorSummary_DropsBannerKeepsError(t *testing.T) {
	stderr := strings.Join([]string{
		"ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers",
		"  built with gcc 13 (Ubuntu 13.2.0-23ubuntu4)",
		"  configuration: --prefix=/usr --extra-version=3ubuntu5 --enable-libx264",
		"  libavutil      58. 29.100 / 58. 29.100",
		"  libavcodec     60. 31.102 / 60. 31.102",
		"  libavformat    60. 16.100 / 60. 16.100",
		"Stream mapping:",
		"  Stream #0:0 -> #0:0 (wrapped_avframe (native) -> h264 (h264_amf))",
		"[h264_amf @ 0x5f0e4a] AMF failed to initialise: no compatible device found",
		"Error initializing output stream 0:0 -- Error while opening encoder",
	}, "\n")

	got := probeErrorSummary(stderr)

	if !strings.Contains(got, "no compatible device found") {
		t.Fatalf("summary lost the actual reason: %q", got)
	}
	for _, banner := range []string{"ffmpeg version", "built with", "configuration:", "libavutil", "libavcodec"} {
		if strings.Contains(got, banner) {
			t.Fatalf("summary kept banner line %q: %q", banner, got)
		}
	}
	if lines := strings.Count(got, " | ") + 1; lines > probeSummaryLines {
		t.Fatalf("summary kept %d lines, cap is %d: %q", lines, probeSummaryLines, got)
	}
}

func TestProbeErrorSummary_KeepsTheTailNotTheHead(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 40; i++ {
		b.WriteString("noise line\n")
	}
	b.WriteString("Cannot open /dev/dri/renderD128: Permission denied\n")

	got := probeErrorSummary(b.String())
	if !strings.Contains(got, "Permission denied") {
		t.Fatalf("kept the head instead of the tail; FFmpeg reports the reason last: %q", got)
	}
}

func TestProbeErrorSummary_EmptyStderr(t *testing.T) {
	// A probe can fail with nothing on stderr (exec: "ffmpeg": not found).
	// The caller still logs; an empty summary must not become " | " noise.
	if got := probeErrorSummary(""); got != "" {
		t.Fatalf("want empty summary, got %q", got)
	}
	if got := probeErrorSummary("\n  \n\n"); got != "" {
		t.Fatalf("whitespace-only stderr produced %q", got)
	}
}

func TestTailBuffer_KeepsLastBytesAndReportsFullWrite(t *testing.T) {
	tb := &tailBuffer{limit: 16}

	// os/exec treats a short write as io.ErrShortWrite and fails the command
	// — which would break the very probe we are only trying to observe.
	n, err := tb.Write([]byte(strings.Repeat("a", 100)))
	if err != nil {
		t.Fatalf("Write returned %v", err)
	}
	if n != 100 {
		t.Fatalf("Write reported %d of 100 bytes; os/exec would call that a short write", n)
	}
	if got := len(tb.String()); got != 16 {
		t.Fatalf("buffered %d bytes, limit is 16", got)
	}

	tb.Write([]byte("TAIL"))
	if got := tb.String(); !strings.HasSuffix(got, "TAIL") {
		t.Fatalf("lost the most recent write: %q", got)
	}
	if got := len(tb.String()); got != 16 {
		t.Fatalf("buffer grew past its limit to %d bytes", got)
	}
}

func TestTailBuffer_AccumulatesAcrossWritesUnderLimit(t *testing.T) {
	tb := &tailBuffer{limit: 1024}
	tb.Write([]byte("first "))
	tb.Write([]byte("second"))
	if got := tb.String(); got != "first second" {
		t.Fatalf("got %q, want %q", got, "first second")
	}
}
