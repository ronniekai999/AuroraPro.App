package streaming

import (
	"testing"
)

func TestVideoEncoderArgs_Software(t *testing.T) {
	hw := HWAccelInfo{Type: HWAccelNone, VideoEncoder: "libx264"}

	args := hw.VideoEncoderArgs(1920, 1080)

	assertContains(t, args, "-c:v", "libx264")
	assertContains(t, args, "-preset", "veryfast")
	assertContains(t, args, "-profile:v", "high")
	assertContains(t, args, "-level", "4.2")
	assertContainsVF(t, args, "scale=1920:-2")
}

func TestVideoEncoderArgs_LevelByResolution(t *testing.T) {
	hw := HWAccelInfo{Type: HWAccelNone, VideoEncoder: "libx264"}

	// One notch above each tier's 30fps minimum (60fps headroom; frame rate
	// is not probed) — must mirror hlsCodecString in streaming.go.
	tests := []struct {
		width, height int
		wantLevel     string
	}{
		{854, 480, "3.1"},
		{1280, 720, "3.2"},
		{1920, 1080, "4.2"},
		{3840, 2160, "5.2"},
	}
	for _, tt := range tests {
		args := hw.VideoEncoderArgs(tt.width, tt.height)
		assertContains(t, args, "-level", tt.wantLevel)
	}
}

func TestVideoEncoderArgs_NVENC(t *testing.T) {
	hw := HWAccelInfo{Type: HWAccelNVENC, VideoEncoder: "h264_nvenc"}

	args := hw.VideoEncoderArgs(1280, 720)

	assertContains(t, args, "-c:v", "h264_nvenc")
	assertContains(t, args, "-preset", "p4")
	assertContains(t, args, "-tune", "hq")
	assertContains(t, args, "-rc", "vbr")
	assertContains(t, args, "-profile:v", "high")
	assertContains(t, args, "-level", "3.2")
	assertContainsVF(t, args, "scale=1280:-2")
}

func TestVideoEncoderArgs_QSV(t *testing.T) {
	hw := HWAccelInfo{Type: HWAccelQSV, VideoEncoder: "h264_qsv"}

	args := hw.VideoEncoderArgs(854, 480)

	assertContains(t, args, "-c:v", "h264_qsv")
	assertContains(t, args, "-preset", "faster")
	// MUST be -profile:v with the explicit stream specifier — bare -profile
	// applies to the audio stream too, and the AAC encoder rejects "high",
	// killing every QSV transcode that re-encodes audio (finding B1).
	assertContains(t, args, "-profile:v", "high")
	// h264_qsv has no named "3.1"-style level constants — the dotted form
	// silently evaluates to the wrong integer. QSV must get numeric
	// level_idc ("31"), unlike libx264/NVENC/VAAPI/AMF (see qsvLevel).
	assertContains(t, args, "-level", "31")
	assertContainsVF(t, args, "scale=854:-2")
	for _, a := range args {
		if a == "-profile" {
			t.Error("bare -profile must not appear in QSV args (applies to all streams; breaks AAC encoder init)")
		}
	}
}

func TestVideoEncoderArgs_VAAPI(t *testing.T) {
	hw := HWAccelInfo{
		Type:         HWAccelVAAPI,
		VideoEncoder: "h264_vaapi",
		DevicePath:   "/dev/dri/renderD128",
	}

	args := hw.VideoEncoderArgs(1920, 1080)

	assertContains(t, args, "-vaapi_device", "/dev/dri/renderD128")
	assertContains(t, args, "-c:v", "h264_vaapi")

	// VAAPI uses hwupload pipeline in the -vf filter
	found := false
	for i, a := range args {
		if a == "-vf" && i+1 < len(args) {
			vf := args[i+1]
			if contains(vf, "hwupload") && contains(vf, "scale_vaapi") {
				found = true
			}
		}
	}
	if !found {
		t.Errorf("VAAPI args should contain -vf with hwupload and scale_vaapi, got %v", args)
	}
}

func TestVideoEncoderArgs_AMF(t *testing.T) {
	hw := HWAccelInfo{Type: HWAccelAMF, VideoEncoder: "h264_amf"}

	args := hw.VideoEncoderArgs(640, 360)

	assertContains(t, args, "-c:v", "h264_amf")
	assertContains(t, args, "-quality", "speed")
	assertContains(t, args, "-profile:v", "high")
	assertContainsVF(t, args, "scale=640:-2")
}

// QA fix 2026-05-24 — without `format=yuv420p` in the filter chain,
// libx264 with an 8-bit profile (now High; High10 is a separate profile)
// fails on 10-bit input (modern HEVC SDR remuxes are commonly 10-bit).
// Asserts the downconvert is part of the -vf for every CPU-side encoder
// pipeline. VAAPI is excluded because it uses `format=nv12` for the
// equivalent downconvert on hardware surfaces.
func TestVideoEncoderArgs_Forces8BitOutput(t *testing.T) {
	types := []struct {
		name string
		hw   HWAccelInfo
	}{
		{"software", HWAccelInfo{Type: HWAccelNone, VideoEncoder: "libx264"}},
		{"nvenc", HWAccelInfo{Type: HWAccelNVENC, VideoEncoder: "h264_nvenc"}},
		{"qsv", HWAccelInfo{Type: HWAccelQSV, VideoEncoder: "h264_qsv"}},
		{"amf", HWAccelInfo{Type: HWAccelAMF, VideoEncoder: "h264_amf"}},
	}
	for _, tt := range types {
		t.Run(tt.name, func(t *testing.T) {
			args := tt.hw.VideoEncoderArgs(1920, 1080)
			assertContainsVF(t, args, "format=yuv420p")
		})
	}
}

func TestVideoEncoderArgs_HighProfile(t *testing.T) {
	// Verify the High profile is present in every CPU-side / hardware encoder
	// type (VAAPI is excluded — it omits an explicit -profile flag and lets the
	// driver choose). High replaced Baseline for ~10-20% better compression at
	// the same bitrate; must stay in sync with h264Profile() and the avc1.6400
	// codec string from hlsCodecString().
	types := []struct {
		name string
		hw   HWAccelInfo
	}{
		{"software", HWAccelInfo{Type: HWAccelNone, VideoEncoder: "libx264"}},
		{"nvenc", HWAccelInfo{Type: HWAccelNVENC, VideoEncoder: "h264_nvenc"}},
		{"qsv", HWAccelInfo{Type: HWAccelQSV, VideoEncoder: "h264_qsv"}},
		{"amf", HWAccelInfo{Type: HWAccelAMF, VideoEncoder: "h264_amf"}},
	}

	for _, tt := range types {
		t.Run(tt.name, func(t *testing.T) {
			args := tt.hw.VideoEncoderArgs(1920, 1080)
			hasHigh := false
			for i, a := range args {
				if (a == "-profile:v" || a == "-profile") && i+1 < len(args) && args[i+1] == "high" {
					hasHigh = true
					break
				}
			}
			if !hasHigh {
				t.Errorf("%s encoder args missing high profile flag: %v", tt.name, args)
			}
		})
	}
}

func TestSoftwareFallback(t *testing.T) {
	info := softwareFallback()

	if info.Type != HWAccelNone {
		t.Errorf("Type = %q, want %q", info.Type, HWAccelNone)
	}
	if info.VideoEncoder != "libx264" {
		t.Errorf("VideoEncoder = %q, want %q", info.VideoEncoder, "libx264")
	}
	if info.DisplayName == "" {
		t.Error("DisplayName should not be empty")
	}
}

func TestHWAccelTypes(t *testing.T) {
	// Verify constant values match expected strings
	tests := []struct {
		accelType HWAccelType
		want      string
	}{
		{HWAccelNone, "none"},
		{HWAccelNVENC, "nvenc"},
		{HWAccelQSV, "qsv"},
		{HWAccelVAAPI, "vaapi"},
		{HWAccelAMF, "amf"},
	}

	for _, tt := range tests {
		if string(tt.accelType) != tt.want {
			t.Errorf("HWAccelType = %q, want %q", string(tt.accelType), tt.want)
		}
	}
}

// --- Test Helpers ---

func assertContains(t *testing.T, args []string, key, value string) {
	t.Helper()
	for i, a := range args {
		if a == key && i+1 < len(args) && args[i+1] == value {
			return
		}
	}
	t.Errorf("args %v should contain %s %s", args, key, value)
}

func assertContainsVF(t *testing.T, args []string, substr string) {
	t.Helper()
	for i, a := range args {
		if a == "-vf" && i+1 < len(args) && contains(args[i+1], substr) {
			return
		}
	}
	t.Errorf("args %v should contain -vf with %q", args, substr)
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsSubstring(s, substr))
}

func containsSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func TestQSVLevelNumericForm(t *testing.T) {
	// h264_qsv has no named dotted-level constants; the generic integer
	// option evaluates "4.2" to 4 (not MFX level_idc 42), silently dropping
	// the constraint. qsvLevel must emit the numeric IDC form.
	tests := map[string]string{"3.1": "31", "3.2": "32", "4.2": "42", "5.2": "52"}
	for in, want := range tests {
		if got := qsvLevel(in); got != want {
			t.Errorf("qsvLevel(%q) = %q, want %q", in, got, want)
		}
	}
}
