package skipmarkers

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// FFmpeg execution for the background analyzer. Everything here runs
// niced and one-at-a-time (the worker is sequential by construction)
// so analysis never competes with live transcodes for CPU — the same
// posture the embedding backfill takes toward the LLM.

// backgroundNice is the niceness applied to analyzer FFmpeg processes.
const backgroundNice = 10

// Per-invocation hard timeouts: a wedged FFmpeg (corrupt file, dead
// NFS mount) must not stall the sweep forever.
const (
	decodeTimeout  = 3 * time.Minute
	detectTimeout  = 5 * time.Minute
	introScanSec   = 420.0                                             // decode this much of each episode's head
	maxDecodeBytes = int(introScanSec)*sigSampleRate*2 + sigSampleRate // s16le + 0.5s slack
)

var (
	ffmpegOnce  sync.Once
	ffmpegFound bool
)

// ffmpegAvailable memoizes the PATH lookup; the binary's presence
// doesn't change over a process lifetime (same rationale as the
// router's health-check cache).
func ffmpegAvailable() bool {
	ffmpegOnce.Do(func() {
		_, err := exec.LookPath("ffmpeg")
		ffmpegFound = err == nil
	})
	return ffmpegFound
}

// reniceProcess lowers a child's scheduling priority. Best-effort:
// failure (already-exited child, unusual kernel policy) only costs us
// the niceness, never the analysis.
func reniceProcess(pid int) {
	if err := syscall.Setpriority(syscall.PRIO_PROCESS, pid, backgroundNice); err != nil {
		slog.Debug("skipmarkers: renice failed", "pid", pid, "error", err)
	}
}

// decodeIntroPCM decodes the first introScanSec seconds of the file's
// first audio stream to mono 16 kHz s16le samples.
func decodeIntroPCM(ctx context.Context, path string) ([]int16, error) {
	ctx, cancel := context.WithTimeout(ctx, decodeTimeout)
	defer cancel()

	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-t", strconv.FormatFloat(introScanSec, 'f', 0, 64),
		"-i", path,
		"-map", "0:a:0",
		"-ac", "1",
		"-ar", strconv.Itoa(sigSampleRate),
		"-f", "s16le",
		"-",
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	var stdout, stderr bytes.Buffer
	// Pre-size for the full expected output (introScanSec of s16le) —
	// the size is known up front, so one allocation instead of a
	// doubling crawl through ~13 MB of redundant copies per episode.
	stdout.Grow(maxDecodeBytes)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	hardenCmd(cmd) // die with the parent — never orphan on OOM/crash
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start ffmpeg decode: %w", err)
	}
	reniceProcess(cmd.Process.Pid)
	if err := cmd.Wait(); err != nil {
		return nil, fmt.Errorf("ffmpeg decode: %w (%s)", err, truncateErr(stderr.String()))
	}

	raw := stdout.Bytes()
	if len(raw) > maxDecodeBytes {
		raw = raw[:maxDecodeBytes]
	}
	samples := make([]int16, len(raw)/2)
	for i := range samples {
		samples[i] = int16(uint16(raw[2*i]) | uint16(raw[2*i+1])<<8)
	}
	return samples, nil
}

// runCreditsDetect runs blackdetect and silencedetect over the file's
// tail and returns the detected intervals in ABSOLUTE source seconds.
// tailStartSec uses input seeking (-ss before -i) so FFmpeg jumps
// straight to the tail instead of decoding the whole file; detect
// timestamps then restart near zero and get the offset added back.
//
// The two detectors run as SEPARATE single-stream passes (video-only
// blackdetect, audio-only silencedetect) rather than one combined
// invocation. Muxing a video filter and an audio filter into a single
// `-f null` output forces FFmpeg to buffer raw decoded frames to
// interleave the two streams; with input seeking desyncing their start
// times, that buffer grows across the whole (up to creditsTailMaxSec)
// tail and balloons RSS into the tens of GB — enough to OOM the host.
// One stream per pass has nothing to interleave, so memory stays bounded
// to a few in-flight frames. Detection itself is unchanged: the same two
// filters, just no longer sharing an output.
func runCreditsDetect(ctx context.Context, path string, tailStartSec float64) (black, silence []timeRange, err error) {
	blackStderr, err := runDetectPass(ctx, blackDetectArgs(path, tailStartSec))
	if err != nil {
		return nil, nil, err
	}
	silenceStderr, err := runDetectPass(ctx, silenceDetectArgs(path, tailStartSec))
	if err != nil {
		return nil, nil, err
	}

	// Each pass carries only its own filter's stream, so each stderr
	// holds only its own detector's lines.
	black, _ = parseDetectOutput(blackStderr)
	_, silence = parseDetectOutput(silenceStderr)
	for i := range black {
		black[i].start += tailStartSec
		black[i].end += tailStartSec
	}
	for i := range silence {
		silence[i].start += tailStartSec
		silence[i].end += tailStartSec // +Inf stays +Inf; coverage clamps it
	}
	return black, silence, nil
}

// blackDetectArgs builds the video-only black-frame pass. -an drops
// audio so the output carries a single stream (no A/V interleave buffer).
func blackDetectArgs(path string, tailStartSec float64) []string {
	return []string{
		"-hide_banner", "-nostats", "-nostdin",
		"-ss", strconv.FormatFloat(tailStartSec, 'f', 2, 64),
		"-i", path,
		"-an",
		"-vf", "blackdetect=d=0.5:pix_th=0.10",
		"-f", "null", "-",
	}
}

// silenceDetectArgs builds the audio-only silence pass. -vn drops video
// so the output carries a single stream (no A/V interleave buffer).
func silenceDetectArgs(path string, tailStartSec float64) []string {
	return []string{
		"-hide_banner", "-nostats", "-nostdin",
		"-ss", strconv.FormatFloat(tailStartSec, 'f', 2, 64),
		"-i", path,
		"-vn",
		"-af", "silencedetect=n=-40dB:d=1.5",
		"-f", "null", "-",
	}
}

// runDetectPass runs one niced, timeout- and parent-death-bounded FFmpeg
// detect invocation and returns its stderr, where blackdetect /
// silencedetect emit their findings.
func runDetectPass(ctx context.Context, args []string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, detectTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	hardenCmd(cmd) // die with the parent — never orphan on OOM/crash
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("start ffmpeg detect: %w", err)
	}
	reniceProcess(cmd.Process.Pid)
	if err := cmd.Wait(); err != nil {
		return "", fmt.Errorf("ffmpeg detect: %w (%s)", err, truncateErr(stderr.String()))
	}
	return stderr.String(), nil
}

// truncateErr keeps FFmpeg stderr noise out of the logs while
// preserving the (usually first-line) diagnosis.
func truncateErr(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}
