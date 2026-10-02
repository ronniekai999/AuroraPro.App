package streaming

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

type encoderLevelOption struct {
	Args  []string `json:"args"`
	Level int      `json:"level"`
	Tier  *int     `json:"tier,omitempty"`
}

func hardwareLevelOptions(t *testing.T) []encoderLevelOption {
	t.Helper()
	var options []encoderLevelOption
	for _, tc := range []struct {
		height     int
		fps        float64
		h264, hevc int
	}{
		{480, 24, 31, 90}, {720, 59.94, 32, 93},
		{1080, 29.97, 40, 120}, {1080, 59.94, 42, 120},
		{1080, 120, 42, 123}, {2160, 24, 51, 153}, {2160, 120, 52, 156},
	} {
		for _, codec := range []string{"h264", "hevc"} {
			idc := tc.h264
			wantCodec := fmt.Sprintf("avc1.6400%02x,mp4a.40.2", idc)
			if codec == "hevc" {
				idc = tc.hevc
				wantCodec = fmt.Sprintf("hvc1.1.6.L%d.B0,mp4a.40.2", idc)
			}
			if got := hlsCodecString(tc.height, "aac", tc.fps, codec); got != wantCodec {
				t.Fatalf("playlist CODECS = %s, want %s", got, wantCodec)
			}
			for _, backend := range []HWAccelType{HWAccelVAAPI, HWAccelQSV} {
				h := HWAccelInfo{Type: backend, DevicePath: "/dev/dri/renderD128"}
				var paths [][]string
				level := idc
				var tier *int
				if codec == "h264" {
					paths = append(paths, h.VideoEncoderArgs(1920, tc.height, tc.fps))
					if backend == HWAccelVAAPI {
						paths = append(paths, h.FullGPUEncoderArgs(1920, tc.height, false, tc.fps), h.FullGPUEncoderArgs(1920, tc.height, true, tc.fps))
					}
				} else {
					paths = append(paths, h.HEVCEncoderArgs(1920, tc.height, tc.fps))
					if backend == HWAccelVAAPI {
						paths = append(paths, h.FullGPUHEVCEncoderArgs(1920, tc.height, false, tc.fps), h.FullGPUHEVCEncoderArgs(1920, tc.height, true, tc.fps))
					}
					if backend == HWAccelQSV {
						level /= 3
						mainTier := 0
						tier = &mainTier
					}
				}
				for _, args := range paths {
					assertContains(t, args, "-level", strconv.Itoa(level))
					if tier != nil {
						assertContains(t, args, "-tier", "main")
					}
					options = append(options, encoderLevelOption{Args: args, Level: level, Tier: tier})
				}
			}
		}
	}
	return options
}

func TestHardwareEncoderLevelsMatchPlaylist(t *testing.T) {
	hardwareLevelOptions(t)
}

// Ask the installed libavcodec to parse our emitted options. No GPU is needed
// to allocate a codec context and bind AVOptions, so this catches the exact
// dotted-x.0→integer-x failure that an argv-only test would merely bless.
// Device-produced SPS/decode validation remains a separate hardware check.
func TestHardwareEncoderLevelOptionSemantics(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		failOrSkipMedia(t, "python3 unavailable for libavcodec AVOption regression")
	}
	body, err := json.Marshal(hardwareLevelOptions(t))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("python3", "testdata/encoder_level_options.py")
	cmd.Stdin = bytes.NewReader(body)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if strings.Contains(string(out), "LIBAVCODEC_UNAVAILABLE") {
			failOrSkipMedia(t, string(out))
		}
		t.Fatalf("native encoder level options: %v\n%s", err, out)
	}
}
