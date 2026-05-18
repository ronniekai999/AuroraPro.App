package streaming

import (
	"testing"
)

func TestVideoEncoderArgs_Software(t *testing.T) {
	hw := HWAccelInfo{Type: HWAccelNone, VideoEncoder: "libx264"}

	args := hw.VideoEncoderArgs(1920, 1080)

	assertContains(t, args, "-c:v", "libx264")
	assertContains(t, args, "-preset", "veryfast")
	assertContains(t, args, "-profile:v", "baseline")
	assertContains(t, args, "-level", "4.0")
	assertContainsVF(t, args, "scale=1920:-2")
}

func TestVideoEncoderArgs_LevelByResolution(t *testing.T) {
	hw := HWAccelInfo{Type: HWAccelNone, VideoEncoder: "libx264"}

	tests := []struct {
		width, height int
		wantLevel     string
	}{
		{854, 480, "3.0"},
		{1280, 720, "3.1"},
		{1920, 1080, "4.0"},
		{3840, 2160, "5.1"},
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
	assertContains(t, args, "-tune", "ll")
	assertContains(t, args, "-rc", "vbr")
	assertContains(t, args, "-profile:v", "baseline")
	assertContains(t, args, "-level", "3.1")
	assertContainsVF(t, args, "scale=1280:-2")
}

func TestVideoEncoderArgs_QSV(t *testing.T) {
	hw := HWAccelInfo{Type: HWAccelQSV, VideoEncoder: "h264_qsv"}

	args := hw.VideoEncoderArgs(854, 480)

	assertContains(t, args, "-c:v", "h264_qsv")
	assertContains(t, args, "-preset", "faster")
	assertContains(t, args, "-profile", "baseline")
	assertContainsVF(t, args, "scale=854:-2")
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
	assertContains(t, args, "-profile:v", "baseline")
	assertContainsVF(t, args, "scale=640:-2")
}

func TestVideoEncoderArgs_BaselineProfile(t *testing.T) {
	// Verify baseline profile is present in all hardware encoder types
	// (except VAAPI which doesn't support it)
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
			hasBaseline := false
			for i, a := range args {
				if (a == "-profile:v" || a == "-profile") && i+1 < len(args) && args[i+1] == "baseline" {
					hasBaseline = true
					break
				}
			}
			if !hasBaseline {
				t.Errorf("%s encoder args missing baseline profile flag: %v", tt.name, args)
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
