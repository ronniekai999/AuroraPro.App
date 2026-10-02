package streaming

import (
	"testing"
)

func TestVideoEncoderArgs_Software(t *testing.T) {
	hw := HWAccelInfo{Type: HWAccelNone, VideoEncoder: "libx264"}

	args := hw.VideoEncoderArgs(1920, 1080, 0)

	assertContains(t, args, "-c:v", "libx264")
	assertContains(t, args, "-preset", "veryfast")
	assertContains(t, args, "-profile:v", "high")
	assertContains(t, args, "-level", "4.0")
	assertContainsVF(t, args, "scale=1920:-2")
}

func TestVideoEncoderArgs_LevelByResolution(t *testing.T) {
	hw := HWAccelInfo{Type: HWAccelNone, VideoEncoder: "libx264"}

	// Low rungs carry 60fps headroom (3.1/3.2 — safe under every receiver
	// ceiling); the 1080p/2160p rungs are pinned to 4.0/5.1 by Chromecast
	// capability filtering — see h264LevelIDC for the per-device ceilings.
	tests := []struct {
		width, height int
		wantLevel     string
	}{
		{854, 480, "3.1"},
		{1280, 720, "3.2"},
		{1920, 1080, "4.0"},
		{3840, 2160, "5.1"},
	}
	for _, tt := range tests {
		args := hw.VideoEncoderArgs(tt.width, tt.height, 0)
		assertContains(t, args, "-level", tt.wantLevel)
	}
}

func TestVideoEncoderArgs_NVENC(t *testing.T) {
	hw := HWAccelInfo{Type: HWAccelNVENC, VideoEncoder: "h264_nvenc"}

	args := hw.VideoEncoderArgs(1280, 720, 0)

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

	args := hw.VideoEncoderArgs(854, 480, 0)

	assertContains(t, args, "-c:v", "h264_qsv")
	assertContains(t, args, "-preset", "faster")
	// MUST be -profile:v with the explicit stream specifier — bare -profile
	// applies to the audio stream too, and the AAC encoder rejects "high",
	// killing every QSV transcode that re-encodes audio (finding B1).
	assertContains(t, args, "-profile:v", "high")
	// h264_qsv has no named "3.1"-style level constants — the dotted form
	// silently evaluates to the wrong integer. QSV must get numeric
	// level_idc ("31"), as VAAPI does; libx264/NVENC/AMF use dotted levels.
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

	args := hw.VideoEncoderArgs(1920, 1080, 0)

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

	args := hw.VideoEncoderArgs(640, 360, 0)

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
			args := tt.hw.VideoEncoderArgs(1920, 1080, 0)
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
			args := tt.hw.VideoEncoderArgs(1920, 1080, 0)
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

func TestH264LevelRenderings(t *testing.T) {
	// One level_idc table (h264LevelIDC) feeds three renderings that MUST
	// agree: dotted for libx264/NVENC/AMF, numeric for h264_qsv/VAAPI (no
	// named dotted constants — "4.0" silently evaluates to the integer 4
	// there), and two hex digits for the CODECS attribute.
	tests := []struct {
		height     int
		fps        float64
		wantIDC    int
		wantDotted string
		wantHex    string
	}{
		{480, 0, 31, "3.1", "1f"},
		{720, 0, 32, "3.2", "20"},
		{1080, 0, 40, "4.0", "28"},
		{2160, 0, 51, "5.1", "33"},
		// fps-aware (2026-08): >30fps bumps the two top rungs to truthful
		// levels; unknown (0) and ≤30fps keep the Chromecast-pinned choice.
		{1080, 24, 40, "4.0", "28"},
		{1080, 29.97, 40, "4.0", "28"},
		{1080, 59.94, 42, "4.2", "2a"},
		{1080, 60, 42, "4.2", "2a"},
		{2160, 30, 51, "5.1", "33"},
		{2160, 59.94, 52, "5.2", "34"},
		{720, 60, 32, "3.2", "20"},  // 720p60 fits L3.2's MB/s limit exactly
		{720, 120, 42, "4.2", "2a"}, // 720p120 exceeds L3.2 → 4.2
		{480, 120, 32, "3.2", "20"}, // 480p120 exceeds L3.1 → 3.2
	}
	for _, tt := range tests {
		if got := h264LevelIDC(tt.height, tt.fps); got != tt.wantIDC {
			t.Errorf("h264LevelIDC(%d, %v) = %d, want %d", tt.height, tt.fps, got, tt.wantIDC)
		}
		if got := h264Level(tt.height, tt.fps); got != tt.wantDotted {
			t.Errorf("h264Level(%d, %v) = %q, want %q", tt.height, tt.fps, got, tt.wantDotted)
		}
		if got := h264LevelHex(tt.height, tt.fps); got != tt.wantHex {
			t.Errorf("h264LevelHex(%d, %v) = %q, want %q", tt.height, tt.fps, got, tt.wantHex)
		}
	}
}

func TestVideoEncoderArgs_SoftwarePresetConfigurable(t *testing.T) {
	// transcode.software_preset (2026-08): the configured preset reaches the
	// libx264 args; empty keeps the "veryfast" default; hardware encoders
	// ignore SWPreset entirely.
	fast := HWAccelInfo{Type: HWAccelNone, VideoEncoder: "libx264", SWPreset: "faster"}
	assertContains(t, fast.VideoEncoderArgs(1920, 1080, 0), "-preset", "faster")

	def := HWAccelInfo{Type: HWAccelNone, VideoEncoder: "libx264"}
	assertContains(t, def.VideoEncoderArgs(1920, 1080, 0), "-preset", "veryfast")

	nv := HWAccelInfo{Type: HWAccelNVENC, VideoEncoder: "h264_nvenc", SWPreset: "medium"}
	assertContains(t, nv.VideoEncoderArgs(1280, 720, 0), "-preset", "p4") // NVENC keeps its own preset
}
