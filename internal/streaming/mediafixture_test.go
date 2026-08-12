package streaming

// Synthetic media fixtures for the playback matrix (August 2026 review item
// #1). Every fixture is generated on demand from ffmpeg's lavfi sources, so
// nothing binary is checked into the repo and the corpus always matches
// whatever ffmpeg the host actually ships. Files are tiny (a few hundred KB,
// ~4s at 320x240) and the whole corpus builds in a couple of seconds.
//
// Why this exists: before this file the streaming package's tests were
// exclusively ARGUMENT tests — given codec X and caps Y, assert decision Z, or
// assert that some flag lands in the FFmpeg argv. Nothing asserted that a
// decision produces a stream that actually plays. The matrix in
// playback_matrix_test.go closes that gap by running real FFmpeg over these
// fixtures and probing what comes out.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// requireMediaToolingEnv is the CI switch that turns "ffmpeg is missing, skip
// this test" into a hard failure.
//
// Every pre-existing ffmpeg-dependent test in this package guards itself with
// `t.Skip("ffmpeg not in PATH")`. That is correct for a developer laptop
// without media tooling, but in CI it is a silent no-op: the job goes green
// having exercised nothing. Setting AURORA_REQUIRE_MEDIA_TESTS=1 (the CI
// workflow does) makes the absence of ffmpeg fail the build instead.
const requireMediaToolingEnv = "AURORA_REQUIRE_MEDIA_TESTS"

// mediaToolingRequired reports whether missing ffmpeg/ffprobe must fail rather
// than skip.
func mediaToolingRequired() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(requireMediaToolingEnv))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// requireFFmpeg returns the resolved ffmpeg and ffprobe paths. It skips the
// test when either is absent — unless AURORA_REQUIRE_MEDIA_TESTS is set, in
// which case it fails.
func requireFFmpeg(t *testing.T) (ffmpeg, ffprobe string) {
	t.Helper()
	var err error
	if ffmpeg, err = exec.LookPath("ffmpeg"); err != nil {
		failOrSkipMedia(t, "ffmpeg not in PATH")
	}
	if ffprobe, err = exec.LookPath("ffprobe"); err != nil {
		failOrSkipMedia(t, "ffprobe not in PATH")
	}
	return ffmpeg, ffprobe
}

// requireFFmpegEncoders skips (or fails under CI) unless every named encoder is
// compiled into the local ffmpeg. Distro builds differ in what is enabled —
// the August 2026 review's point that capability probes matter more than
// version numbers applies to the test corpus too.
func requireFFmpegEncoders(t *testing.T, names ...string) {
	t.Helper()
	out, err := exec.Command("ffmpeg", "-hide_banner", "-encoders").Output()
	if err != nil {
		failOrSkipMedia(t, fmt.Sprintf("cannot list ffmpeg encoders: %v", err))
	}
	have := string(out)
	for _, n := range names {
		// encoderListed is the production helper from hwaccel.go — the same
		// whole-field match the encoder probes use, so the corpus is gated by
		// exactly the rule Aurora itself applies.
		if !encoderListed(have, n) {
			failOrSkipMedia(t, fmt.Sprintf("ffmpeg lacks encoder %q", n))
		}
	}
}

func failOrSkipMedia(t *testing.T, reason string) {
	t.Helper()
	if mediaToolingRequired() {
		t.Fatalf("%s (%s is set: media tooling is mandatory in this environment)",
			reason, requireMediaToolingEnv)
	}
	t.Skip(reason)
}

// --- Fixture specification ---

type subsKind int

const (
	subsNone subsKind = iota
	// subsText muxes a real SRT track — the text burn-in path (`subtitles`
	// filter via -vf) and the WebVTT sidecar extraction path.
	subsText
	// subsASS muxes an ASS track — same filter, different demuxer, and the
	// format most likely to carry styling that libass must resolve.
	subsASS
	// subsBitmapOverlay stands in for PGS/VOBSUB. FFmpeg cannot ENCODE a
	// bitmap subtitle stream from text ("Subtitle encoding currently only
	// possible from text to text or bitmap to bitmap"), so no lavfi-generated
	// fixture can carry a genuine PGS track. What this fixture does carry is a
	// second VIDEO stream, which exercises the thing that actually breaks in
	// Aurora's bitmap path: injectBurnInFilter swaps -vf for a -filter_complex
	// `[0:v][0:N]overlay,...` graph, and a malformed graph there kills the
	// encoder at init. The overlay graph shape is what we assert; PGS bitmap
	// DECODING is ffmpeg's concern, not Aurora's.
	subsBitmapOverlay
)

// mediaFixture describes one synthetic source file.
type mediaFixture struct {
	Name          string
	Container     string // "mp4" | "mkv"
	VideoCodec    string // "h264" | "hevc"
	PixFmt        string // "yuv420p" | "yuv420p10le"
	HDR           bool   // tag BT.2020 primaries + SMPTE2084 (PQ) transfer
	AudioCodec    string // "aac" | "ac3" | "eac3"
	AudioChannels int
	Subs          subsKind
	Width         int
	Height        int
	FPS           int
	GOP           int // keyframe interval in frames
	DurationSec   float64
}

// key is the fixture's cache identity — every field that changes the bytes.
func (f mediaFixture) key() string {
	return fmt.Sprintf("%s_%s_%s_hdr%t_%s%dch_subs%d_%dx%d_fps%d_gop%d_%.1fs",
		f.Container, f.VideoCodec, f.PixFmt, f.HDR,
		f.AudioCodec, f.AudioChannels, f.Subs,
		f.Width, f.Height, f.FPS, f.GOP, f.DurationSec)
}

// encoderFor maps a fixture's codec name to the ffmpeg software encoder.
func (f mediaFixture) encoderFor() string {
	switch f.VideoCodec {
	case "hevc", "h265":
		return "libx265"
	case "av1":
		// SVT-AV1 rather than libaom: at preset 12 it encodes these fixtures
		// in well under a second, where libaom takes tens of seconds. The
		// review is right that SVT-AV1 has no place in interactive playback,
		// but generating a 4-second test clip is exactly the offline job it is
		// good at.
		return "libsvtav1"
	default:
		return "libx264"
	}
}

// defaults fills the fields most cases don't care about. 320x240 at 24fps for
// 4s keeps every fixture well under a megabyte while still giving the HLS
// pipeline multiple GOPs to segment on.
func (f mediaFixture) defaults() mediaFixture {
	if f.Width == 0 {
		f.Width = 320
	}
	if f.Height == 0 {
		f.Height = 240
	}
	if f.FPS == 0 {
		f.FPS = 24
	}
	if f.GOP == 0 {
		f.GOP = f.FPS // one keyframe per second
	}
	if f.DurationSec == 0 {
		f.DurationSec = 4
	}
	if f.PixFmt == "" {
		f.PixFmt = "yuv420p"
	}
	if f.AudioCodec == "" {
		f.AudioCodec = "aac"
	}
	if f.AudioChannels == 0 {
		f.AudioChannels = 2
	}
	if f.Container == "" {
		f.Container = "mp4"
	}
	if f.VideoCodec == "" {
		f.VideoCodec = "h264"
	}
	return f
}

// --- Fixture cache ---
//
// Fixtures are generated once per `go test` invocation and shared across every
// subtest that asks for the same spec. Without this the HEVC 10-bit cases
// (~0.8s of x265 each) would dominate the matrix's runtime.

var (
	fixtureCacheMu  sync.Mutex
	fixtureCacheDir string
	fixtureCache    = map[string]string{}
)

// TestMain cleans up the shared fixture corpus after the package's tests run.
func TestMain(m *testing.M) {
	code := m.Run()
	fixtureCacheMu.Lock()
	if fixtureCacheDir != "" {
		os.RemoveAll(fixtureCacheDir)
	}
	fixtureCacheMu.Unlock()
	os.Exit(code)
}

// build materializes the fixture and returns its path, generating it on first
// request and reusing it thereafter.
func (f mediaFixture) build(t *testing.T) string {
	t.Helper()
	f = f.defaults()
	requireFFmpeg(t)
	requireFFmpegEncoders(t, f.encoderFor(), f.AudioCodec)

	fixtureCacheMu.Lock()
	defer fixtureCacheMu.Unlock()

	if path, ok := fixtureCache[f.key()]; ok {
		return path
	}
	if fixtureCacheDir == "" {
		dir, err := os.MkdirTemp("", "aurora-fixtures-")
		if err != nil {
			t.Fatalf("create fixture cache dir: %v", err)
		}
		fixtureCacheDir = dir
	}

	name := f.Name
	if name == "" {
		name = f.key()
	}
	out := filepath.Join(fixtureCacheDir, name+"."+f.Container)
	if err := f.generate(out); err != nil {
		t.Fatalf("generate fixture %s: %v", f.key(), err)
	}
	fixtureCache[f.key()] = out
	return out
}

// generate runs the ffmpeg command that synthesizes the fixture.
func (f mediaFixture) generate(outPath string) error {
	dur := strconv.FormatFloat(f.DurationSec, 'f', -1, 64)

	args := []string{"-hide_banner", "-loglevel", "error", "-y"}

	// Input 0: video. testsrc2 gives moving content with scene detail, so the
	// encoder produces realistic (non-degenerate) bitrates — which matters for
	// the ABR ladder measurement in ladder_bitrate_test.go.
	args = append(args, "-f", "lavfi", "-i",
		fmt.Sprintf("testsrc2=size=%dx%d:rate=%d:duration=%s", f.Width, f.Height, f.FPS, dur))
	// Input 1: audio.
	args = append(args, "-f", "lavfi", "-i",
		fmt.Sprintf("sine=frequency=440:duration=%s", dur))

	// Input 2 (bitmap-overlay fixtures): the stand-in "subtitle" video stream.
	if f.Subs == subsBitmapOverlay {
		args = append(args, "-f", "lavfi", "-i",
			fmt.Sprintf("color=c=white@0.5:size=%dx%d:rate=%d:duration=%s",
				f.Width/2, f.Height/6, f.FPS, dur))
	}

	// Input 2/3 (text subtitle fixtures): a sidecar written next to the output.
	var subPath string
	if f.Subs == subsText || f.Subs == subsASS {
		var err error
		if subPath, err = f.writeSidecar(outPath); err != nil {
			return err
		}
		args = append(args, "-i", subPath)
	}

	args = append(args, "-map", "0:v", "-map", "1:a")
	switch f.Subs {
	case subsBitmapOverlay:
		args = append(args, "-map", "2:v")
	case subsText, subsASS:
		args = append(args, "-map", "2:s")
	}

	args = append(args,
		"-c:v", f.encoderFor(),
		"-pix_fmt", f.PixFmt,
		"-g", strconv.Itoa(f.GOP),
	)
	if f.encoderFor() != "libsvtav1" {
		// Deterministic-ish output: no scene-cut keyframes, so segment
		// boundaries land exactly on the GOP grid and the seek assertions have
		// a known keyframe cadence to aim at. SVT-AV1 rejects the option.
		args = append(args, "-sc_threshold", "0")
	}
	switch f.encoderFor() {
	case "libx265":
		// x265 takes its keyframe interval through the param blob, and prints
		// a banner per run without log-level:none.
		args = append(args, "-x265-params",
			fmt.Sprintf("keyint=%d:min-keyint=%d:scenecut=0:log-level=none", f.GOP, f.GOP))
		args = append(args, "-tag:v", "hvc1")
	case "libsvtav1":
		// Preset 12 is SVT-AV1's fastest; fixtures are about existing, not
		// about compression. -sc_threshold is an x264/x265 option that SVT
		// rejects, so the keyframe interval goes through its own param blob.
		args = append(args, "-preset", "12",
			"-svtav1-params", fmt.Sprintf("keyint=%d", f.GOP))
	}
	if f.HDR {
		// HDR10 signalling. Aurora keys HDR off color_transfer
		// (IsHDRColorTransfer), so smpte2084 is the load-bearing tag; the
		// primaries/matrix keep the file internally consistent.
		args = append(args,
			"-color_primaries", "bt2020",
			"-color_trc", "smpte2084",
			"-colorspace", "bt2020nc")
	}

	args = append(args, "-c:a", f.AudioCodec, "-ac", strconv.Itoa(f.AudioChannels))
	if f.Subs == subsText {
		args = append(args, "-c:s", "srt")
	}
	if f.Subs == subsASS {
		args = append(args, "-c:s", "ass")
	}

	args = append(args, outPath)

	cmd := exec.Command("ffmpeg", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg %s: %w\n%s", strings.Join(args, " "), err, out)
	}
	if subPath != "" {
		os.Remove(subPath)
	}
	return nil
}

// writeSidecar emits the subtitle file that generate() muxes in.
func (f mediaFixture) writeSidecar(outPath string) (string, error) {
	base := strings.TrimSuffix(outPath, filepath.Ext(outPath))
	if f.Subs == subsASS {
		p := base + ".ass"
		body := "[Script Info]\nScriptType: v4.00+\nPlayResX: 384\nPlayResY: 288\n\n" +
			"[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Bold\n" +
			"Style: Default,Arial,16,&H00FFFFFF,0\n\n" +
			"[Events]\nFormat: Layer, Start, End, Style, Text\n" +
			"Dialogue: 0,0:00:00.00,0:00:02.00,Default,First cue\n" +
			"Dialogue: 0,0:00:02.00,0:00:04.00,Default,Second cue\n"
		return p, os.WriteFile(p, []byte(body), 0o644)
	}
	p := base + ".srt"
	body := "1\n00:00:00,000 --> 00:00:02,000\nFirst cue\n\n" +
		"2\n00:00:02,000 --> 00:00:04,000\nSecond cue\n"
	return p, os.WriteFile(p, []byte(body), 0o644)
}

// --- Probing helpers ---

// probedStream is the subset of ffprobe's stream output the matrix asserts on.
type probedStream struct {
	CodecName     string
	CodecType     string
	PixFmt        string
	ColorTransfer string
	Width         int
	Height        int
	Channels      int
	Profile       string
}

// probeStreams runs ffprobe and returns every stream in the file.
func probeStreams(t *testing.T, path string) []probedStream {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error",
		"-print_format", "json", "-show_streams", path).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", path, err)
	}
	var parsed struct {
		Streams []struct {
			CodecName     string `json:"codec_name"`
			CodecType     string `json:"codec_type"`
			PixFmt        string `json:"pix_fmt"`
			ColorTransfer string `json:"color_transfer"`
			Width         int    `json:"width"`
			Height        int    `json:"height"`
			Channels      int    `json:"channels"`
			Profile       string `json:"profile"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse ffprobe stream output for %s: %v", path, err)
	}
	streams := make([]probedStream, 0, len(parsed.Streams))
	for _, s := range parsed.Streams {
		streams = append(streams, probedStream{
			CodecName:     s.CodecName,
			CodecType:     s.CodecType,
			PixFmt:        s.PixFmt,
			ColorTransfer: s.ColorTransfer,
			Width:         s.Width,
			Height:        s.Height,
			Channels:      s.Channels,
			Profile:       s.Profile,
		})
	}
	return streams
}

// probeFormatName returns ffprobe's format_name for a file (e.g.
// "mov,mp4,m4a,3gp,3g2,mj2" or "matroska,webm") — the raw string Aurora's
// NormalizeContainer is written to consume.
func probeFormatName(t *testing.T, path string) string {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error",
		"-print_format", "json", "-show_format", path).Output()
	if err != nil {
		t.Fatalf("ffprobe format %s: %v", path, err)
	}
	var parsed struct {
		Format struct {
			FormatName string `json:"format_name"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse ffprobe format output: %v", err)
	}
	return parsed.Format.FormatName
}

// firstVideoStream returns the file's first video stream, failing if absent.
func firstVideoStream(t *testing.T, streams []probedStream) probedStream {
	t.Helper()
	for _, s := range streams {
		if s.CodecType == "video" {
			return s
		}
	}
	t.Fatal("no video stream in probe output")
	return probedStream{}
}

// firstAudioStream returns the file's first audio stream, failing if absent.
func firstAudioStream(t *testing.T, streams []probedStream) probedStream {
	t.Helper()
	for _, s := range streams {
		if s.CodecType == "audio" {
			return s
		}
	}
	t.Fatal("no audio stream in probe output")
	return probedStream{}
}

// segmentDurationOf returns a media file's duration in seconds.
func segmentDurationOf(t *testing.T, path string) float64 {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error",
		"-show_entries", "format=duration",
		"-print_format", "default=noprint_wrappers=1:nokey=1", path).Output()
	if err != nil {
		t.Fatalf("ffprobe duration %s: %v", path, err)
	}
	d, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if err != nil {
		t.Fatalf("parse duration %q: %v", out, err)
	}
	return d
}

// waitForFile polls until path exists and is non-empty, or the deadline passes.
// FFmpeg writes segments asynchronously; the variant's Ready channel closes at
// first-segment publication, but init.mp4 and the playlist land around the same
// moment and this keeps the assertions from racing them.
func waitForFile(t *testing.T, path string, within time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if fi, err := os.Stat(path); err == nil && fi.Size() > 0 {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}
