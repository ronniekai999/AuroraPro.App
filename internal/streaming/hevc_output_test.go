package streaming

// 2026-08 review item #5 — HEVC transcode OUTPUT. Pins the decision gate
// (server encoder + fMP4 + client HEVC decode), the codec-string/level
// tables, the per-backend encoder args, and the CreateSession clamp that
// keeps stale/crafted "hevc" requests off hosts without an encoder.

import (
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/models"
)

// hevcCaps builds caps for a client that decodes 8-bit Main HEVC through
// hls.js, with the server-side delivery fields set as GetStreamInfo sets
// them.
func hevcCaps(fmp4, hevcEncode bool) *ClientCaps {
	return &ClientCaps{
		VideoCodecs: map[string]bool{"hevc": true, "h265": true, "aac": false},
		AudioCodecs: map[string]bool{"aac": true},
		Containers:  map[string]bool{},
		HLSJS:       true,
		FMP4:        fmp4,
		HEVCEncode:  hevcEncode,
	}
}

var av1Source = []models.AudioTrack{{Codec: "aac", IsDefault: true, Channels: 2}}

func TestDecidePlayback_HEVCOutputGate(t *testing.T) {
	// AV1 source on a client without AV1 → full transcode either way; the
	// interesting axis is the OUTPUT codec.
	for _, tt := range []struct {
		name       string
		fmp4       bool
		hevcEncode bool
		want       string
	}{
		{"encoder + fmp4 + hevc client → hevc", true, true, "hevc"},
		{"no server encoder → h264", true, false, "h264"},
		{"TS segments → h264 (HEVC-in-TS output buys nothing)", false, true, "h264"},
		{"neither → h264", false, false, "h264"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			caps := hevcCaps(tt.fmp4, tt.hevcEncode)
			pd := DecidePlayback("matroska", "av1", av1Source, caps, "yuv420p")
			if pd.Decision != "transcode" {
				t.Fatalf("Decision = %q, want transcode", pd.Decision)
			}
			if pd.VideoCodecOut != tt.want {
				t.Errorf("VideoCodecOut = %q, want %q", pd.VideoCodecOut, tt.want)
			}
		})
	}

	// Client WITHOUT HEVC decode: always H.264 output.
	caps := hevcCaps(true, true)
	delete(caps.VideoCodecs, "hevc")
	delete(caps.VideoCodecs, "h265")
	pd := DecidePlayback("matroska", "av1", av1Source, caps, "yuv420p")
	if pd.VideoCodecOut != "h264" {
		t.Errorf("non-HEVC client: VideoCodecOut = %q, want h264", pd.VideoCodecOut)
	}
}

// TestDecidePlayback_HEVCOutputMainOnlyDecoder pins the 10-bit-HEVC-on-
// Main-only-decoder case: the source transcodes (Main 10 undecodable) but
// the OUTPUT can still be 8-bit Main HEVC — the client decodes that fine.
func TestDecidePlayback_HEVCOutputMainOnlyDecoder(t *testing.T) {
	caps := hevcCaps(true, true) // hevc cap, NO HEVCMain10
	pd := DecidePlayback("matroska", "hevc", av1Source, caps, "yuv420p10le")
	if pd.Decision != "transcode" {
		t.Fatalf("10-bit HEVC on Main-only decoder: Decision = %q, want transcode", pd.Decision)
	}
	if pd.VideoCodecOut != "hevc" {
		t.Errorf("VideoCodecOut = %q, want hevc (8-bit Main output decodes on Main-only hardware)", pd.VideoCodecOut)
	}
}

func TestHlsCodecStringHEVC(t *testing.T) {
	for _, tt := range []struct {
		height int
		fps    float64
		want   string
	}{
		{360, 0, "hvc1.1.6.L90.B0,mp4a.40.2"},
		{480, 0, "hvc1.1.6.L90.B0,mp4a.40.2"},
		{720, 0, "hvc1.1.6.L93.B0,mp4a.40.2"},
		{1080, 0, "hvc1.1.6.L120.B0,mp4a.40.2"},
		{1080, 60, "hvc1.1.6.L120.B0,mp4a.40.2"}, // L4.0 covers 1080p63
		{1080, 120, "hvc1.1.6.L123.B0,mp4a.40.2"},
		{2160, 0, "hvc1.1.6.L153.B0,mp4a.40.2"},
		{2160, 60, "hvc1.1.6.L153.B0,mp4a.40.2"}, // L5.1 covers 2160p60
		{2160, 120, "hvc1.1.6.L156.B0,mp4a.40.2"},
	} {
		if got := hlsCodecString(tt.height, "aac", tt.fps, "hevc"); got != tt.want {
			t.Errorf("hlsCodecString(%d, aac, %v, hevc) = %q, want %q", tt.height, tt.fps, got, tt.want)
		}
	}
	// Audio part composes identically to the H.264 path.
	if got := hlsCodecString(1080, "eac3", 0, "hevc"); !strings.Contains(got, "hvc1.1.6.L120.B0,ec-3") {
		t.Errorf("hevc+ec-3 = %q, want hvc1.1.6.L120.B0,ec-3", got)
	}
	// Default (no videoOut arg) stays H.264 — backward compatible.
	if got := hlsCodecString(1080, "aac", 0); !strings.HasPrefix(got, "avc1.") {
		t.Errorf("hlsCodecString default = %q, want avc1.*", got)
	}
	// Unknown videoOut values fall back to H.264.
	if got := hlsCodecString(1080, "aac", 0, "vp9"); !strings.HasPrefix(got, "avc1.") {
		t.Errorf("hlsCodecString(vp9) = %q, want avc1.* fallback", got)
	}
}

func TestHEVCEncoderArgs_Backends(t *testing.T) {
	// Every backend must emit its hevc_* encoder, the hvc1 tag (Apple
	// rejects hev1), and never an x264/x265-in-wrong-place mixup.
	nv := HWAccelInfo{Type: HWAccelNVENC}
	args := nv.HEVCEncoderArgs(1920, 1080, 0)
	assertContains(t, args, "-c:v", "hevc_nvenc")
	assertContains(t, args, "-profile:v", "main")
	assertContains(t, args, "-level", "4.0")
	assertContains(t, args, "-tag:v", "hvc1")

	qsv := HWAccelInfo{Type: HWAccelQSV}
	args = qsv.HEVCEncoderArgs(1920, 1080, 0)
	assertContains(t, args, "-c:v", "hevc_qsv")
	assertContains(t, args, "-level", "120") // numeric idc, like h264_qsv
	assertContains(t, args, "-tag:v", "hvc1")

	va := HWAccelInfo{Type: HWAccelVAAPI, DevicePath: "/dev/dri/renderD128"}
	args = va.HEVCEncoderArgs(1920, 1080, 0)
	assertContains(t, args, "-c:v", "hevc_vaapi")
	assertContains(t, args, "-tag:v", "hvc1")

	amf := HWAccelInfo{Type: HWAccelAMF}
	args = amf.HEVCEncoderArgs(1280, 720, 0)
	assertContains(t, args, "-c:v", "hevc_amf")
	assertContains(t, args, "-level", "3.1")
	assertContains(t, args, "-tag:v", "hvc1")

	// Software: libx265, honors SWPreset, forced 8-bit (x265 then emits
	// Main automatically — no -profile flag by design).
	sw := HWAccelInfo{Type: HWAccelNone, SWPreset: "faster"}
	args = sw.HEVCEncoderArgs(1920, 1080, 0)
	assertContains(t, args, "-c:v", "libx265")
	assertContains(t, args, "-preset", "faster")
	assertContains(t, args, "-tag:v", "hvc1")
	assertContainsVF(t, args, "format=yuv420p")
	for i, a := range args {
		if a == "-profile:v" {
			t.Errorf("libx265 args must not set -profile:v (8-bit input implies Main): %v", args[i:])
		}
	}
}

func TestFullGPUHEVCEncoderArgs(t *testing.T) {
	nv := HWAccelInfo{Type: HWAccelNVENC}
	args := nv.FullGPUHEVCEncoderArgs(1280, 720, false, 0)
	assertContains(t, args, "-c:v", "hevc_nvenc")
	assertContains(t, args, "-tag:v", "hvc1")
	assertContainsVF(t, args, "scale_cuda=1280:-2:format=yuv420p")

	va := HWAccelInfo{Type: HWAccelVAAPI, DevicePath: "/dev/dri/renderD128"}
	hdr := va.FullGPUHEVCEncoderArgs(1920, 1080, true, 0)
	assertContains(t, hdr, "-c:v", "hevc_vaapi")
	assertContains(t, hdr, "-tag:v", "hvc1")
	assertContainsVF(t, hdr, "tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709")
}

// TestCreateSession_VideoCodecOutClamp pins the trust boundary: "hevc"
// sticks only with a probed encoder + fMP4 segments; every other
// combination — including unknown values and TS-forced sessions —
// normalizes to H.264, and the master-playlist CODECS follows.
func TestCreateSession_VideoCodecOutClamp(t *testing.T) {
	newTM := func(t *testing.T) *TranscodeManager {
		t.Helper()
		tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4", HEVCOutput: "off"})
		if err != nil {
			t.Fatalf("new transcode manager: %v", err)
		}
		t.Cleanup(tm.Close)
		return tm
	}
	mkOpts := func(codecOut string) SessionOpts {
		return SessionOpts{VideoCodecOut: codecOut, AudioTrackIndex: -1}
	}

	// Encoder probed + fMP4: hevc honored, CODECS advertises hvc1.
	tm := newTM(t)
	tm.hwAccel.HEVCEncoder = "libx265" // simulate a successful probe (hermetic)
	s, err := tm.CreateSession(1, "u", "/library/x.mkv", 1920, 1080, mkOpts("hevc"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if s.VideoCodecOut != "hevc" {
		t.Errorf("VideoCodecOut = %q, want hevc", s.VideoCodecOut)
	}
	for _, p := range s.Profiles {
		if !strings.HasPrefix(p.CodecString, "hvc1.") {
			t.Errorf("profile %s CodecString = %q, want hvc1.*", p.Name, p.CodecString)
		}
	}

	// No encoder: forced h264.
	tm2 := newTM(t)
	tm2.hwAccel.HEVCEncoder = ""
	s2, err := tm2.CreateSession(1, "u", "/library/x.mkv", 1920, 1080, mkOpts("hevc"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if s2.VideoCodecOut != "h264" {
		t.Errorf("no encoder: VideoCodecOut = %q, want h264", s2.VideoCodecOut)
	}
	for _, p := range s2.Profiles {
		if !strings.HasPrefix(p.CodecString, "avc1.") {
			t.Errorf("profile %s CodecString = %q, want avc1.*", p.Name, p.CodecString)
		}
	}

	// ForceTS: HEVC-in-TS output buys nothing → h264 even with an encoder.
	tm3 := newTM(t)
	tm3.hwAccel.HEVCEncoder = "libx265"
	o := mkOpts("hevc")
	o.ForceTS = true
	s3, err := tm3.CreateSession(1, "u", "/library/x.mkv", 1920, 1080, o)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if s3.VideoCodecOut != "h264" {
		t.Errorf("ForceTS: VideoCodecOut = %q, want h264", s3.VideoCodecOut)
	}

	// Unknown values normalize to h264.
	tm4 := newTM(t)
	tm4.hwAccel.HEVCEncoder = "libx265"
	s4, err := tm4.CreateSession(1, "u", "/library/x.mkv", 1920, 1080, mkOpts("vp9"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if s4.VideoCodecOut != "h264" {
		t.Errorf("unknown value: VideoCodecOut = %q, want h264", s4.VideoCodecOut)
	}
}

// TestProbeHEVCEncoder_OffKnob is the only hermetic probe assertion: the
// config off-switch must skip probing entirely regardless of host.
func TestProbeHEVCEncoder_OffKnob(t *testing.T) {
	if got := ProbeHEVCEncoder(HWAccelInfo{Type: HWAccelNone}, "off"); got != "" {
		t.Errorf("ProbeHEVCEncoder(off) = %q, want empty", got)
	}
}
