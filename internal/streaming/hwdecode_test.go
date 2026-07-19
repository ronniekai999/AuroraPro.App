package streaming

import (
	"os/exec"
	"strings"
	"testing"
)

// The hardware-decode plan is pure argument construction over probed
// capabilities, so the full gating matrix is unit-testable without any GPU:
// backend × codec × bit depth × HDR × burn-in × crash-fallback.

func nvencFull() HWAccelInfo {
	return HWAccelInfo{
		Type: HWAccelNVENC, VideoEncoder: "h264_nvenc",
		DecodeType: HWAccelNVENC,
		DecodeCodecs: map[string]bool{
			decodeKeyH264: true, decodeKeyHEVC: true, decodeKeyHEVC10: true, decodeKeyVP9: true,
		},
		FullGPU: true,
	}
}

func vaapiFull() HWAccelInfo {
	return HWAccelInfo{
		Type: HWAccelVAAPI, VideoEncoder: "h264_vaapi", DevicePath: "/dev/dri/renderD128",
		DecodeType: HWAccelVAAPI,
		DecodeCodecs: map[string]bool{
			decodeKeyH264: true, decodeKeyHEVC: true, decodeKeyHEVC10: true,
		},
		FullGPU: true, TonemapVAAPI: true,
	}
}

func TestDecodeKeyFor(t *testing.T) {
	tests := []struct {
		codec, pixFmt, want string
	}{
		{"h264", "yuv420p", decodeKeyH264},
		{"avc1", "yuv420p", decodeKeyH264},
		{"h264", "yuv420p10le", ""}, // Hi10P: no hardware decoder exists
		{"hevc", "yuv420p", decodeKeyHEVC},
		{"h265", "yuv420p10le", decodeKeyHEVC10},
		{"hevc", "yuv422p10le", decodeKeyHEVC10},
		{"vp9", "yuv420p", decodeKeyVP9},
		{"vp9", "yuv420p10le", ""}, // profile-2 support too patchy
		{"av1", "yuv420p", ""},     // not probed → never hw-decoded
		{"mpeg2video", "yuv420p", ""},
		{"", "", ""},
	}
	for _, tt := range tests {
		if got := decodeKeyFor(tt.codec, tt.pixFmt); got != tt.want {
			t.Errorf("decodeKeyFor(%q, %q) = %q, want %q", tt.codec, tt.pixFmt, got, tt.want)
		}
	}
}

func TestPlanDecode_Tiers(t *testing.T) {
	nv := nvencFull()
	va := vaapiFull()

	tests := []struct {
		name       string
		hw         HWAccelInfo
		codec      string
		pixFmt     string
		hdr        bool
		burnIn     bool
		swFallback bool
		wantArgs   []string // exact input args; nil = software decode
		wantTier2  bool
	}{
		{
			name: "nvenc h264 SDR → tier2 zero-copy",
			hw:   nv, codec: "h264", pixFmt: "yuv420p",
			wantArgs:  []string{"-hwaccel", "cuda", "-hwaccel_output_format", "cuda"},
			wantTier2: true,
		},
		{
			name: "nvenc hevc 10-bit SDR → tier2 (scale_cuda converts P010)",
			hw:   nv, codec: "hevc", pixFmt: "yuv420p10le",
			wantArgs:  []string{"-hwaccel", "cuda", "-hwaccel_output_format", "cuda"},
			wantTier2: true,
		},
		{
			name: "nvenc HDR → tier1 (CPU zscale tonemap keeps working)",
			hw:   nv, codec: "hevc", pixFmt: "yuv420p10le", hdr: true,
			wantArgs:  []string{"-hwaccel", "cuda"},
			wantTier2: false,
		},
		{
			name: "nvenc burn-in → tier1 (subtitles filter is CPU-only)",
			hw:   nv, codec: "h264", pixFmt: "yuv420p", burnIn: true,
			wantArgs:  []string{"-hwaccel", "cuda"},
			wantTier2: false,
		},
		{
			name: "nvenc Hi10P h264 → pure software (no hw decoder exists)",
			hw:   nv, codec: "h264", pixFmt: "yuv420p10le",
			wantArgs: nil, wantTier2: false,
		},
		{
			name: "nvenc crash fallback → pure software",
			hw:   nv, codec: "h264", pixFmt: "yuv420p", swFallback: true,
			wantArgs: nil, wantTier2: false,
		},
		{
			name: "vaapi HDR with tonemap_vaapi → tier2 GPU tonemap",
			hw:   va, codec: "hevc", pixFmt: "yuv420p10le", hdr: true,
			wantArgs:  []string{"-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128", "-hwaccel_output_format", "vaapi"},
			wantTier2: true,
		},
		{
			name: "vaapi HDR without tonemap_vaapi → tier1 CPU tonemap",
			hw: func() HWAccelInfo {
				h := vaapiFull()
				h.TonemapVAAPI = false
				return h
			}(), codec: "hevc", pixFmt: "yuv420p10le", hdr: true,
			wantArgs:  []string{"-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128"},
			wantTier2: false,
		},
		{
			name: "vaapi hevc10 on 8-bit-only hardware (Skylake) → software",
			hw: func() HWAccelInfo {
				h := vaapiFull()
				h.DecodeCodecs = map[string]bool{decodeKeyH264: true, decodeKeyHEVC: true}
				return h
			}(), codec: "hevc", pixFmt: "yuv420p10le",
			wantArgs: nil, wantTier2: false,
		},
		{
			name: "qsv box: vaapi tier1 decode, no tier2 (encoder eats system frames)",
			hw: HWAccelInfo{
				Type: HWAccelQSV, VideoEncoder: "h264_qsv",
				DecodeType:   HWAccelVAAPI,
				DecodeCodecs: map[string]bool{decodeKeyHEVC: true},
			}, codec: "hevc", pixFmt: "yuv420p",
			wantArgs:  []string{"-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128"},
			wantTier2: false,
		},
		{
			name: "no probe results → software",
			hw:   HWAccelInfo{Type: HWAccelNVENC, VideoEncoder: "h264_nvenc"},
			codec: "h264", pixFmt: "yuv420p",
			wantArgs: nil, wantTier2: false,
		},
		{
			name: "software encoder box → software decode",
			hw:   HWAccelInfo{Type: HWAccelNone, VideoEncoder: "libx264"},
			codec: "h264", pixFmt: "yuv420p",
			wantArgs: nil, wantTier2: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args, tier2 := tt.hw.PlanDecode(tt.codec, tt.pixFmt, tt.hdr, tt.burnIn, tt.swFallback)
			if tier2 != tt.wantTier2 {
				t.Errorf("tier2 = %v, want %v (args %v)", tier2, tt.wantTier2, args)
			}
			if len(args) != len(tt.wantArgs) {
				t.Fatalf("args = %v, want %v", args, tt.wantArgs)
			}
			for i := range args {
				if args[i] != tt.wantArgs[i] {
					t.Fatalf("args = %v, want %v", args, tt.wantArgs)
				}
			}
		})
	}

	// The QSV tier-1 case above uses findDRIDevice() when DevicePath is
	// empty; pin that the device flag is always present for vaapi decode.
	qsvNoDev := HWAccelInfo{
		Type: HWAccelQSV, DecodeType: HWAccelVAAPI,
		DecodeCodecs: map[string]bool{decodeKeyH264: true},
	}
	args, _ := qsvNoDev.PlanDecode("h264", "yuv420p", false, false, false)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-hwaccel_device /dev/dri/") {
		t.Errorf("vaapi decode without DevicePath must fall back to a DRI device: %v", args)
	}
}

func TestFullGPUEncoderArgs(t *testing.T) {
	nv := nvencFull()
	args := nv.FullGPUEncoderArgs(1280, 720, false)
	assertContains(t, args, "-c:v", "h264_nvenc")
	assertContains(t, args, "-profile:v", "high")
	assertContains(t, args, "-level", "3.2")
	assertContainsVF(t, args, "scale_cuda=1280:-2:format=yuv420p")
	for _, a := range args {
		if strings.Contains(a, "format=nv12,hwupload") || strings.HasPrefix(a, "scale=") {
			t.Errorf("tier-2 NVENC chain must not contain CPU filters: %v", args)
		}
	}

	va := vaapiFull()
	sdr := va.FullGPUEncoderArgs(1920, 1080, false)
	assertContains(t, sdr, "-c:v", "h264_vaapi")
	assertContains(t, sdr, "-level", "4.2")
	assertContainsVF(t, sdr, "scale_vaapi=w=1920:h=-2:format=nv12")

	hdr := va.FullGPUEncoderArgs(1920, 1080, true)
	assertContainsVF(t, hdr, "tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709")
	assertContainsVF(t, hdr, "scale_vaapi=w=1920:h=-2")
	for _, a := range hdr {
		if strings.Contains(a, "zscale") || strings.Contains(a, "hwupload") {
			t.Errorf("tier-2 VAAPI HDR chain must not contain CPU tonemap or upload: %v", hdr)
		}
	}
}

// TestProbeHWDecode_NoHardwareDegradesToOff runs the real probe pipeline
// against a real ffmpeg on a machine with no GPU: sample generation
// succeeds, every hardware decode probe fails, and the result must be a
// clean "decode stays on CPU" state — never a false positive. Skipped when
// ffmpeg is absent. (On a real GPU box the probes flip capabilities on;
// that path is validated by construction via the exact-shape probe args.)
func TestProbeHWDecode_NoHardwareDegradesToOff(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not in PATH")
	}
	// Pretend an NVENC encoder was detected; on this GPU-less machine the
	// cuda hwaccel probes must all fail.
	info := HWAccelInfo{Type: HWAccelNVENC, VideoEncoder: "h264_nvenc"}
	ProbeHWDecode(&info, t.TempDir())
	if info.DecodeType != HWAccelNone || len(info.DecodeCodecs) != 0 || info.FullGPU || info.TonemapVAAPI {
		t.Errorf("no-GPU probe must degrade to off, got %+v", info)
	}
	// And the session planner must consequently choose pure software.
	if args, tier2 := info.PlanDecode("h264", "yuv420p", false, false, false); args != nil || tier2 {
		t.Errorf("PlanDecode after failed probe = (%v, %v), want (nil, false)", args, tier2)
	}
}
