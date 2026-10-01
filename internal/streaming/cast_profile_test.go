package streaming

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
)

func TestCastProfileLimits(t *testing.T) {
	for _, tc := range []struct {
		width, height int
		fps           float64
	}{
		{3840, 2160, 60}, {1920, 1080, 120}, {1080, 1920, 30},
		{320, 240, 24}, {3840, 1600, 30}, {1920, 1080, math.NaN()},
	} {
		t.Run(fmt.Sprintf("%dx%d-%.0f", tc.width, tc.height, tc.fps), func(t *testing.T) {
			fps := castOutputFPS(tc.fps)
			p, err := resolveCastProfile(ResolveProfiles(nil, tc.width, tc.height), tc.width, tc.height, fps)
			if err != nil {
				t.Fatal(err)
			}
			if p.Width > 1920 || p.Height > 1080 || p.Width > tc.width || p.Height > tc.height || fps > 30 {
				t.Fatalf("unsupported/upscaled output: %+v @ %v", p, fps)
			}
			if _, supported := castH264Level(p, fps); !supported {
				t.Fatalf("rung exceeds H264 limits: %+v", p)
			}
		})
	}
	for _, size := range [][2]int{{0, 0}, {0, 1080}, {1920, 0}} {
		if _, err := resolveCastProfile(nil, size[0], size[1], 30); err == nil {
			t.Fatalf("unknown geometry %v must fail closed", size)
		}
	}
}

func TestCastH264LevelUsesGeometryFrameRateAndVBV(t *testing.T) {
	p := AllProfiles["720p"]
	if level, _ := castH264Level(p, 30); level != 31 {
		t.Fatalf("720p30 level=%d, want 31", level)
	}
	p.Height = 960 // same rung name, different frame macroblocks
	if level, _ := castH264Level(p, 30); level != 32 {
		t.Fatalf("1280x960 level=%d, want 32", level)
	}
	p = AllProfiles["1080p"]
	p.MaxRate, p.BufSize = "30M", "60M"
	if level, _ := castH264Level(p, 30); level != 41 {
		t.Fatalf("higher VBV level=%d, want 41", level)
	}
	if _, ok := castH264Level(p, 60); ok {
		t.Fatal("shared 1080p60 must not bypass the receiver output cap")
	}
}

func TestCloneForCast_SharedOutputMustMeetItsSignallingAndGeometry(t *testing.T) {
	for _, tc := range []struct {
		name          string
		width, height int
		mutate        func(*QualityProfile)
		wantClone     bool
	}{
		{"known 1080p", 1920, 1080, nil, false},
		{"wide 720 crop exceeds level 3.2 frame size", 1920, 720, nil, true},
		{"portrait height exceeds receiver bounds", 640, 1280, nil, true},
		{"scaler rounds above declared height", 1920, 721, nil, true},
		{"VBV exceeds height-derived level", 1920, 1080, func(p *QualityProfile) { p.MaxRate, p.BufSize = "30M", "60M" }, true},
		{"missing codec provenance", 1920, 1080, func(p *QualityProfile) { p.CodecString = "" }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fakeFFmpegOnPath(t)
			tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4", Profiles: []string{"1080p"}, HWAccel: "none", HWDecode: "off"})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(tm.Close)
			src, err := tm.CreateSession(1, "viewer", "/library/movie.mkv", tc.width, tc.height, SessionOpts{SourceVideoCodec: "h264", SourceFPS: 30, StartSec: 600})
			if err != nil {
				t.Fatal(err)
			}
			if tc.mutate != nil {
				tc.mutate(&src.Profiles[0])
			}
			before := append([]QualityProfile(nil), src.Profiles...)
			got, err := tm.CloneForCast(1, "viewer", src.ID, 610)
			if err != nil {
				t.Fatal(err)
			}
			if (got != src) != tc.wantClone {
				t.Fatalf("clone=%v want %v: %+v", got != src, tc.wantClone, src.Profiles)
			}
			if src.StartSec != 600 || fmt.Sprint(src.Profiles) != fmt.Sprint(before) {
				t.Fatalf("cast altered local output: %+v", src.Profiles)
			}
			if tc.wantClone && (!castSharedProfileSupported(got) || got.StartSec != 595) {
				t.Fatalf("private output not supported/anchored: %+v", got.Profiles)
			}
		})
	}
}

func TestCloneForCast_UnknownSourceDimensionsDoNotBecomeBrowserFallbackFacts(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{Profiles: []string{"360p"}, HWAccel: "none", HWDecode: "off"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tm.Close)
	src, err := tm.CreateSession(1, "viewer", "/library/portrait.mkv", 0, 0, SessionOpts{SourceVideoCodec: "h264", SourceFPS: 30})
	if err != nil {
		t.Fatalf("browser fallback must remain usable: %v", err)
	}
	if src.SourceWidth != 0 || src.SourceHeight != 0 || len(src.Profiles) != 1 || src.Profiles[0].Width != 640 || src.Profiles[0].Height != 360 {
		t.Fatalf("source facts and browser fallback conflated: %+v", src)
	}
	if _, err := tm.CloneForCast(1, "viewer", src.ID, 0); err == nil {
		t.Fatal("unknown real aspect ratio was accepted as 640x360")
	}
	if len(tm.ListSessions()) != 1 {
		t.Fatal("unknown dimensions leaked an unpublished copy")
	}
}

func TestCastEncoderArgsAgreeWithDeclaredOutput(t *testing.T) {
	p, err := resolveCastProfile(ResolveProfiles(nil, 1080, 1920), 1080, 1920, 30)
	if err != nil {
		t.Fatal(err)
	}
	for _, accel := range []HWAccelType{HWAccelNone, HWAccelVAAPI, HWAccelNVENC, HWAccelQSV, HWAccelAMF} {
		t.Run(string(accel), func(t *testing.T) {
			hw := HWAccelInfo{Type: accel}
			args := castEncoderArgs(hw.VideoEncoderArgs(p.Width, p.Height, 30), p, 30, accel)
			assertContains(t, args, "-profile:v", "high")
			assertContains(t, args, "-r:v", "30")
			if strings.Contains(strings.Join(args, " "), ":-2") || strings.Contains(strings.Join(args, " "), "h=-2") {
				t.Fatalf("cast scaler must use declared geometry: %v", args)
			}
			level := fmt.Sprintf("%d.%d", p.CastH264LevelIDC/10, p.CastH264LevelIDC%10)
			if accel == HWAccelQSV || accel == HWAccelVAAPI {
				level = fmt.Sprint(p.CastH264LevelIDC)
			}
			assertContains(t, args, "-level", level)
		})
	}
}

func TestCastCopyDoesNotNarrowLocalLadderAndKeepsDecodeFacts(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4", HWAccel: "none", HWDecode: "off"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tm.Close)
	src, err := tm.CreateSession(1, "viewer", "/library/hevc.mkv", 3840, 2160,
		SessionOpts{SourceVideoCodec: "hevc", SourceVideoPixFmt: "yuv420p", SourceFPS: 60})
	if err != nil {
		t.Fatal(err)
	}
	clone, err := tm.CloneForCast(1, "viewer", src.ID, 1800)
	if err != nil {
		t.Fatal(err)
	}
	if len(clone.Profiles) != 1 || len(clone.Variants) != 1 || len(src.Profiles) != 5 || src.Profiles[0].Name != "2160p" || src.StartSec != 0 {
		t.Fatalf("copy/local ladders changed incorrectly: copy=%+v local=%+v", clone.Profiles, src.Profiles)
	}
	if clone.SourceVideoCodec != "hevc" || clone.SourceFPS != 60 || clone.CastOutputFPS != 30 || clone.FMP4 {
		t.Fatalf("copy facts/output=%+v", clone)
	}
	// The retained source codec now enables the already-probed decode path.
	hw := nvencFull()
	args, _ := hw.PlanDecode(clone.SourceVideoCodec, clone.SourceVideoPixFmt, clone.HDRTonemap, false, clone.swDecodeFallback)
	if len(args) == 0 {
		t.Fatal("cast copy lost hardware-decode eligibility")
	}
}

// Produced media, rather than an argv-only assertion: the private ladder,
// emitted codec/level/frame rate/dimensions, and readiness seen by the sender.
func TestCastCopyPlaybackProducesOneSupportedRung(t *testing.T) {
	requireFFmpeg(t)
	for _, tc := range []struct{ width, height, fps int }{{640, 360, 60}, {360, 640, 30}, {640, 1280, 30}, {1920, 720, 30}} {
		t.Run(fmt.Sprintf("%dx%d", tc.width, tc.height), func(t *testing.T) {
			path := (mediaFixture{Container: "mkv", VideoCodec: "h264", AudioCodec: "aac", Width: tc.width, Height: tc.height, FPS: tc.fps, DurationSec: 4}).build(t)
			tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4", Profiles: []string{"1080p"}, HWAccel: "none", HWDecode: "off", HEVCOutput: "off"})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(tm.Close)
			// The wide 720-high crop must get a copy even though its shared
			// encoder's height policy picks 3.2: it needs Level 4.0 MaxFS.
			src, err := tm.CreateSession(1, "viewer", path, tc.width, tc.height, SessionOpts{SourceVideoCodec: "h264", SourceFPS: float64(tc.fps)})
			if err != nil {
				t.Fatal(err)
			}
			clone, err := tm.CloneForCast(1, "viewer", src.ID, 0)
			if err != nil {
				t.Fatal(err)
			}
			if clone == src {
				t.Fatalf("unsafe shared output was reused: %+v", src.Profiles)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if err := tm.WarmCastSession(ctx, clone); err != nil {
				t.Fatal(err)
			}
			if len(clone.Profiles) != 1 || len(clone.Variants) != 1 || src.StartSec != 0 {
				t.Fatalf("unexpected ladder: %+v", clone.Profiles)
			}
			p := clone.Profiles[0]
			if !castSharedProfileSupported(clone) || p.CodecString != fmt.Sprintf("avc1.6400%02x,mp4a.40.2", p.CastH264LevelIDC) {
				t.Fatalf("unsupported/misdeclared copy: %+v", p)
			}
			segment := firstMediaSegment(t, filepath.Join(clone.OutputDir, p.Name))
			data, err := exec.Command("ffprobe", "-v", "error", "-show_streams", "-of", "json", segment).Output()
			if err != nil {
				t.Fatal(err)
			}
			var probe struct {
				Streams []struct {
					CodecName            string `json:"codec_name"`
					CodecType            string `json:"codec_type"`
					Width, Height, Level int
					Rate                 string `json:"r_frame_rate"`
					Channels             int
				}
			}
			if err := json.Unmarshal(data, &probe); err != nil {
				t.Fatal(err)
			}
			video, audio := false, false
			for _, s := range probe.Streams {
				if s.CodecType == "video" {
					video = true
					if s.CodecName != "h264" || s.Width != p.Width || s.Height != p.Height || s.Level != p.CastH264LevelIDC || s.Rate != "30/1" {
						t.Fatalf("produced video disagrees with receiver output: %+v / %+v", s, p)
					}
				}
				if s.CodecType == "audio" {
					audio = true
					if s.CodecName != "aac" || s.Channels != 2 {
						t.Fatalf("produced cast audio: %+v", s)
					}
				}
			}
			if !video || !audio {
				t.Fatalf("missing cast streams: %s", data)
			}
		})
	}
}

func TestCastCopyUnknownPortraitCanPlayLocallyButCannotMintForReceiver(t *testing.T) {
	requireFFmpeg(t)
	path := (mediaFixture{Container: "mkv", VideoCodec: "h264", AudioCodec: "aac", Width: 640, Height: 1280, FPS: 30, DurationSec: 2}).build(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "ts", Profiles: []string{"360p"}, HWAccel: "none", HWDecode: "off", HEVCOutput: "off"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tm.Close)
	src, err := tm.CreateSession(1, "viewer", path, 0, 0, SessionOpts{SourceVideoCodec: "h264", SourceFPS: 30})
	if err != nil {
		t.Fatal(err)
	}
	v, err := tm.EnsureVariant(src, src.Profiles[0].Name, 0)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-v.Ready:
	case <-time.After(20 * time.Second):
		t.Fatal("ordinary browser fallback failed to produce media")
	}
	src.variantMu.Lock()
	err = v.Err
	src.variantMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	segment := firstMediaSegment(t, v.OutputDir)
	probe, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", segment).Output()
	if err != nil || !strings.Contains(string(probe), "1280") {
		t.Fatalf("fixture must reproduce taller-than-declared output: %s (%v)", probe, err)
	}
	if _, err := tm.CloneForCast(1, "viewer", src.ID, 0); err == nil {
		t.Fatal("unknown source passed the nominal 360p shared path")
	}
}

func TestCastWarmRetriesSameCopyWithinExistingBudget(t *testing.T) {
	for _, tc := range []struct {
		name       string
		hardware   bool
		alwaysFail bool
		launches   int
		restarts   int
	}{
		{"hardware init falls back before sender LOAD", true, false, 2, 0},
		{"transient software crash uses ordinary budget", false, false, 2, 1},
		{"persistent hardware and software failure is bounded", true, true, 3, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fakeFFmpegOnPath(t)
			tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4", HWAccel: "none", HWDecode: "off"})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(tm.Close)
			if tc.hardware {
				caps := nvencFull()
				tm.hwDecodeCaps.Store(&caps)
			}
			src, err := tm.CreateSession(1, "viewer", "/library/movie.mkv", 1920, 1080, SessionOpts{Remux: true, RemuxAudioCopy: true, SourceVideoCodec: "h264", SourceVideoPixFmt: "yuv420p", SourceFPS: 30})
			if err != nil {
				t.Fatal(err)
			}
			committed, err := tm.CloneForCast(1, "viewer", src.ID, 0)
			if err != nil {
				t.Fatal(err)
			}
			candidate, err := tm.CloneForCast(1, "viewer", src.ID, 120)
			if err != nil {
				t.Fatal(err)
			}
			counter := filepath.Join(t.TempDir(), "launches")
			t.Setenv("CAST_WARM_COUNTER", counter)
			script := `#!/bin/sh
playlist=
for arg do
 case "$arg" in */stream.m3u8) playlist="$arg" ;; esac
done
[ -n "$playlist" ] || exit 1
count=0
[ ! -f "$CAST_WARM_COUNTER" ] || read count < "$CAST_WARM_COUNTER"
count=$((count+1))
printf '%s\n' "$count" > "$CAST_WARM_COUNTER"
[ "$count" -ne 1 ] || exit 1
`
			if tc.alwaysFail {
				script += "exit 1\n"
			} else {
				script += `printf '#EXTM3U\n#EXTINF:6,\nseg_00000.ts\n#EXT-X-ENDLIST\n' > "$playlist"
dd if=/dev/zero of="${playlist%/*}/seg_00000.ts" bs=4096 count=2 2>/dev/null
exit 0
`
			}
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "ffmpeg"), []byte(script), 0755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err = tm.WarmCastSession(ctx, candidate)
			if (err != nil) != tc.alwaysFail {
				t.Fatalf("warm error=%v, want failure=%v", err, tc.alwaysFail)
			}
			counts, readErr := os.ReadFile(counter)
			if readErr != nil || strings.TrimSpace(string(counts)) != fmt.Sprint(tc.launches) {
				t.Fatalf("launch count=%q (%v), want %d", counts, readErr, tc.launches)
			}
			candidate.variantMu.Lock()
			fallback, restarts := candidate.swDecodeFallback, candidate.Variants[candidate.Profiles[0].Name].restartAttempts
			candidate.variantMu.Unlock()
			if fallback != tc.hardware || restarts != tc.restarts {
				t.Fatalf("fallback=%v restarts=%d want %v/%d", fallback, restarts, tc.hardware, tc.restarts)
			}
			src.variantMu.Lock()
			sourceFallback := src.swDecodeFallback
			src.variantMu.Unlock()
			if sourceFallback {
				t.Fatal("copy startup altered healthy remux source decode state")
			}
			for _, kept := range []*TranscodeSession{src, committed, candidate} {
				if got, ok := tm.GetSession(kept.ID); !ok || got != kept {
					t.Fatalf("startup replaced/deleted session %s", kept.ID)
				}
			}
		})
	}
}

func TestCastWarmRetryHasOneOverallStartupDeadline(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{HWAccel: "none", HWDecode: "off"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tm.Close)
	src, err := tm.CreateSession(1, "viewer", "/library/movie.mkv", 1920, 1080, SessionOpts{SourceVideoCodec: "h264", SourceFPS: 30})
	if err != nil {
		t.Fatal(err)
	}
	clone, err := tm.CloneForCast(1, "viewer", src.ID, 120)
	if err != nil {
		t.Fatal(err)
	}
	countPath := filepath.Join(t.TempDir(), "launches")
	t.Setenv("CAST_WARM_COUNTER", countPath)
	dir := t.TempDir()
	script := `#!/bin/sh
count=0
[ ! -f "$CAST_WARM_COUNTER" ] || read count < "$CAST_WARM_COUNTER"
count=$((count+1))
printf '%s\n' "$count" > "$CAST_WARM_COUNTER"
if [ "$count" -eq 1 ]; then sleep .15; exit 1; fi
sleep 2
exit 1
`
	if err := os.WriteFile(filepath.Join(dir, "ffmpeg"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	started := time.Now()
	if err := tm.WarmCastSession(ctx, clone); err == nil {
		t.Fatal("retry outlived startup deadline")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("startup timeout reset after first crash: %v", elapsed)
	}
	counts, err := os.ReadFile(countPath)
	if err != nil || strings.TrimSpace(string(counts)) != "2" {
		t.Fatalf("deadline must cover second attempt: %q (%v)", counts, err)
	}
}

func TestCastWarmStoppedCopyDoesNotStartDetachedEncoder(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{HWAccel: "none", HWDecode: "off"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tm.Close)
	src, err := tm.CreateSession(1, "viewer", "/library/movie.mkv", 1920, 1080, SessionOpts{SourceVideoCodec: "h264", SourceFPS: 30})
	if err != nil {
		t.Fatal(err)
	}
	clone, err := tm.CloneForCast(1, "viewer", src.ID, 120)
	if err != nil {
		t.Fatal(err)
	}
	tm.StopSession(clone.ID)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := tm.WarmCastSession(ctx, clone); err == nil {
		t.Fatal("deleted candidate was treated as ready")
	}
	clone.variantMu.Lock()
	started := clone.Variants[clone.Profiles[0].Name].started
	clone.variantMu.Unlock()
	if started {
		t.Fatal("warming started an encoder outside the session manager")
	}
	if _, ok := tm.GetSession(src.ID); !ok {
		t.Fatal("stopping the candidate altered the source")
	}
}
