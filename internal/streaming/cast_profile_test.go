package streaming

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
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
	for _, tc := range []struct{ width, height, fps int }{{640, 360, 60}, {360, 640, 30}} {
		t.Run(fmt.Sprintf("%dx%d", tc.width, tc.height), func(t *testing.T) {
			path := (mediaFixture{Container: "mkv", VideoCodec: "h264", AudioCodec: "aac", Width: tc.width, Height: tc.height, FPS: tc.fps, DurationSec: 4}).build(t)
			tm := newMatrixManager(t)
			src, err := tm.CreateSession(1, "viewer", path, tc.width, tc.height, SessionOpts{Remux: true, RemuxAudioCopy: true, SourceVideoCodec: "h264", SourceFPS: float64(tc.fps)})
			if err != nil {
				t.Fatal(err)
			}
			clone, err := tm.CloneForCast(1, "viewer", src.ID, 0)
			if err != nil {
				t.Fatal(err)
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
