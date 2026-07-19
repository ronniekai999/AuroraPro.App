package streaming

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// HWAccelType represents a hardware acceleration backend.
type HWAccelType string

const (
	HWAccelNone  HWAccelType = "none"
	HWAccelNVENC HWAccelType = "nvenc"
	HWAccelQSV   HWAccelType = "qsv"
	HWAccelVAAPI HWAccelType = "vaapi"
	HWAccelAMF   HWAccelType = "amf"
)

// HWAccelInfo describes the detected hardware acceleration capability.
type HWAccelInfo struct {
	Type         HWAccelType `json:"type"`
	VideoEncoder string      `json:"video_encoder"` // e.g. "h264_nvenc"
	DevicePath   string      `json:"device_path,omitempty"`
	DisplayName  string      `json:"display_name"`

	// Decode-side capabilities, probed at startup by ProbeHWDecode
	// (hwdecode.go). Zero values = decode stays on the CPU (the pre-2026-07
	// pipeline), which is also the `hw_decode: off` rollback state.
	DecodeType   HWAccelType     `json:"decode_type,omitempty"`    // cuda (nvenc) or vaapi (vaapi/qsv/amf boxes)
	DecodeCodecs map[string]bool `json:"decode_codecs,omitempty"`  // decodeKey* entries that passed the probe
	FullGPU      bool            `json:"full_gpu,omitempty"`       // Tier-2 zero-copy cycle proven (8-bit NV12 pipeline)
	FullGPU10    bool            `json:"full_gpu_10bit,omitempty"` // Tier-2 cycle proven for 10-bit P010 sources
	TonemapVAAPI bool            `json:"tonemap_vaapi,omitempty"`  // GPU HDR→SDR chain proven (VAAPI only)
}

type hwProbe struct {
	accelType   HWAccelType
	encoder     string
	displayName string
	detectFn    func() bool
	testArgsFn  func() ([]string, string) // (extra ffmpeg args, device path)
}

// DetectHWAccel probes for available hardware encoders.
// Priority: NVENC > QSV > VAAPI > AMF > Software.
// forceType can be "auto", "none", or a specific backend name.
func DetectHWAccel(forceType string) HWAccelInfo {
	if forceType == "" || forceType == string(HWAccelNone) {
		slog.Info("hardware acceleration disabled by config")
		return softwareFallback()
	}

	probes := []hwProbe{
		{HWAccelNVENC, "h264_nvenc", "NVIDIA NVENC", detectNVIDIA, nvencTestArgs},
		{HWAccelQSV, "h264_qsv", "Intel Quick Sync", detectQSV, qsvTestArgs},
		{HWAccelVAAPI, "h264_vaapi", "VA-API", detectVAAPI, vaapiTestArgs},
		{HWAccelAMF, "h264_amf", "AMD AMF", detectAMF, amfTestArgs},
	}

	if forceType != "auto" {
		for _, p := range probes {
			if string(p.accelType) == forceType {
				if info, ok := tryProbe(p); ok {
					return info
				}
				slog.Warn("forced hardware encoder failed test encode, falling back to software", "requested", forceType)
				return softwareFallback()
			}
		}
		slog.Warn("unknown hardware encoder type", "requested", forceType)
		return softwareFallback()
	}

	for _, p := range probes {
		if info, ok := tryProbe(p); ok {
			return info
		}
	}

	slog.Info("no hardware acceleration detected, using software encoding")
	return softwareFallback()
}

func softwareFallback() HWAccelInfo {
	return HWAccelInfo{Type: HWAccelNone, VideoEncoder: "libx264", DisplayName: "Software (libx264)"}
}

func tryProbe(p hwProbe) (HWAccelInfo, bool) {
	if !p.detectFn() {
		slog.Debug("device not detected", "encoder", p.displayName)
		return HWAccelInfo{}, false
	}
	slog.Info("device detected, running test encode...", "encoder", p.displayName)
	args, devPath := p.testArgsFn()
	if runTestEncode(args) {
		info := HWAccelInfo{Type: p.accelType, VideoEncoder: p.encoder, DevicePath: devPath, DisplayName: p.displayName}
		slog.Info("hardware acceleration available", "encoder", p.displayName, "ffmpeg_encoder", p.encoder)
		return info, true
	}
	slog.Debug("test encode failed", "encoder", p.displayName)
	return HWAccelInfo{}, false
}

// runTestEncode generates 1 frame of synthetic video and encodes it.
// Thin wrapper over runProbeFFmpeg (hwdecode.go) so encode and decode
// probes share one bounded runner and can't drift in hardening behavior.
func runTestEncode(extraArgs []string) bool {
	args := append([]string{"-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=1"}, extraArgs...)
	args = append(args, "-frames:v", "1", "-f", "null", "-")
	return runProbeFFmpeg(args)
}

// ============================================================
// Device Detection
// ============================================================

func detectNVIDIA() bool {
	if _, err := exec.LookPath("nvidia-smi"); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "nvidia-smi", "--query-gpu=name", "--format=csv,noheader").Output()
	if err == nil && len(strings.TrimSpace(string(out))) > 0 {
		slog.Debug("NVIDIA GPU found", "gpu", strings.TrimSpace(string(out)))
		return true
	}
	return false
}

func detectQSV() bool   { return driDeviceExists() }
func detectVAAPI() bool { return driDeviceExists() }

func detectAMF() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "lspci").Output()
	if err != nil {
		return false
	}
	lower := strings.ToLower(string(out))
	return strings.Contains(lower, "amd") && (strings.Contains(lower, "vga") || strings.Contains(lower, "display"))
}

func driDeviceExists() bool {
	for _, d := range []string{"/dev/dri/renderD128", "/dev/dri/renderD129"} {
		if info, err := os.Stat(d); err == nil && !info.IsDir() {
			return true
		}
	}
	return false
}

func findDRIDevice() string {
	for _, d := range []string{"/dev/dri/renderD128", "/dev/dri/renderD129"} {
		if _, err := os.Stat(d); err == nil {
			return d
		}
	}
	return "/dev/dri/renderD128"
}

// ============================================================
// Test Encode Builders
// ============================================================

func nvencTestArgs() ([]string, string) { return []string{"-c:v", "h264_nvenc", "-preset", "p4"}, "" }
func qsvTestArgs() ([]string, string)   { return []string{"-c:v", "h264_qsv", "-preset", "faster"}, "" }
func amfTestArgs() ([]string, string)   { return []string{"-c:v", "h264_amf", "-quality", "speed"}, "" }

func vaapiTestArgs() ([]string, string) {
	dev := findDRIDevice()
	return []string{"-vaapi_device", dev, "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi"}, dev
}

// ============================================================
// Encoder Arguments for Transcode Pipeline
// ============================================================

// VideoEncoderArgs builds the FFmpeg video encoder flags for a target resolution.
// The height parameter is used for H.264 level and profile selection, and the
// scale filter uses -2 to let FFmpeg auto-calculate the exact height from the
// source aspect ratio (rounded to even, as required by H.264).
//
// Profile selection: High at every resolution (see h264Profile) — it enables
// CABAC, 8x8 transform, and B-frames, and every supported playback target
// decodes High. Must stay in sync with hlsCodecString in streaming.go.
func (h HWAccelInfo) VideoEncoderArgs(width, height int) []string {
	// scale=W:-2 preserves source aspect ratio with even-number rounding.
	// This prevents distortion of ultrawide (2.4:1), 4:3, or other non-16:9 content.
	//
	// `format=yuv420p` is appended to force the filter graph to produce
	// 8-bit 4:2:0 output, regardless of the source pixel format. Without
	// this, a 10-bit source (yuv420p10le — common for modern HEVC SDR
	// remuxes) flows straight into libx264 with the "baseline" H.264
	// profile, which is 8-bit-only. libx264 then errors with:
	//   "file doesn't support a bit depth of 10
	//    Error setting profile baseline."
	// and the variant exits before producing any segments. The
	// alternative (using profile=high10) would produce 10-bit H.264
	// output that browsers + MSE don't reliably support. 2026-05-24 fix.
	scale := fmt.Sprintf("scale=%d:-2,format=yuv420p", width)
	level := h264Level(height)
	profile := h264Profile(height)
	switch h.Type {
	case HWAccelNVENC:
		// h264_nvenc handles 10-bit input internally but still respects
		// the profile constraint. Adding format=yuv420p to the filter
		// graph guarantees 8-bit input arrives at the encoder, matching
		// the libx264 path's contract.
		//
		// -tune hq (high quality), NOT ll (low latency): this is on-demand
		// VOD transcoding, not a real-time capture/conferencing stream. The
		// `ll` tune trades compression efficiency for latency (shallower
		// lookahead, fewer B-frames), which made transcodes look worse at the
		// same bitrate budget for zero benefit here — segments are served from
		// disk, so encode latency never reaches the viewer. `hq` restores the
		// lookahead/B-frame quality NVENC is capable of.
		return []string{"-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr",
			"-profile:v", profile, "-level", level, "-vf", scale}
	case HWAccelQSV:
		// `-profile:v` with the explicit :v stream specifier — NOT bare
		// `-profile`. An empty stream specifier applies the option to ALL
		// output streams, including audio: when the session re-encodes audio
		// (the default `-c:a aac`), the AAC encoder is asked to set
		// profile=high, which is not a valid AAC profile constant
		// (aac_low/aac_main/…), and FFmpeg aborts at encoder init before
		// producing a single segment. Review 2026-06 finding B1.
		return []string{"-c:v", "h264_qsv", "-preset", "faster",
			"-profile:v", profile, "-level", strconv.Itoa(h264LevelIDC(height)), "-vf", scale}
	case HWAccelVAAPI:
		// VAAPI does not support explicit baseline profile constraint — leave as-is.
		// The format=nv12 step here is the equivalent 8-bit downconvert.
		dev := h.DevicePath
		if dev == "" {
			dev = findDRIDevice()
		}
		vf := fmt.Sprintf("format=nv12,hwupload,scale_vaapi=w=%d:h=-2", width)
		return []string{"-vaapi_device", dev, "-vf", vf, "-c:v", "h264_vaapi", "-level", level}
	case HWAccelAMF:
		return []string{"-c:v", "h264_amf", "-quality", "speed",
			"-profile:v", profile, "-level", level, "-vf", scale}
	default:
		return []string{"-c:v", "libx264", "-preset", "veryfast",
			"-profile:v", profile, "-level", level, "-vf", scale}
	}
}

// h264Profile returns the H.264 profile for the encoder. We use High at every
// resolution: it enables CABAC, the 8x8 transform, and B-frames for ~10-20%
// better quality at the same bitrate than Baseline, and every target the
// player runs on (modern browsers / MSE, Chromecast, AirPlay) decodes High up
// to Level 5.1. Baseline was needlessly conservative for a browser-based
// server. MUST stay in sync with hlsCodecString() in streaming.go, which
// advertises avc1.6400.. (High) to match. The height arg is retained for
// call-site symmetry with h264Level and any future per-tier tuning.
func h264Profile(height int) string {
	return "high"
}

// h264LevelIDC returns the H.264 level_idc for a given output height — the
// SINGLE source of truth from which every rendering derives: the dotted form
// for libx264/NVENC/VAAPI/AMF (-level "4.0"), the numeric form for h264_qsv
// (level_idc integer — QSV has no named dotted constants; "4.0" silently
// evaluates to 4 there), and the two-hex-digit form for the master
// playlist's CODECS attribute (hlsCodecString). One table means the encoder
// constraint and the advertised capability can never drift apart.
//
// Level choice per tier (2026-07 review, Chromecast-verified):
//
//	480p and below → 3.1 (31): covers 854x480@60; ≤ every receiver ceiling.
//	720p           → 3.2 (32): covers 1280x720@60; ≤ every receiver ceiling.
//	1080p          → 4.0 (40): Chromecast gen-1/2 and Nest Hub enforce an
//	                 H.264 High ceiling of Level 4.1 via canDisplayType, so
//	                 the 1080p rung must declare ≤ 4.1 or those receivers
//	                 filter it out and silently cap casts at 720p. 4.0 keeps
//	                 the historical value. 1080p60 technically needs 4.2 —
//	                 libx264 logs "MB rate > level limit" and proceeds, and
//	                 no supported player enforces the stamped level for
//	                 local playback — a per-client CODECS split needs frame-
//	                 rate probing (scanner doesn't record fps yet).
//	2160p          → 5.1 (51): Chromecast with Google TV's H.264 ceiling is
//	                 exactly 5.1; declaring 5.2 loses its 4K rung. Same
//	                 60fps caveat as 1080p.
func h264LevelIDC(height int) int {
	switch {
	case height > 1080:
		return 51
	case height > 720:
		return 40
	case height > 480:
		return 32
	default:
		return 31
	}
}

// h264Level renders the level in the dotted form ("4.0") accepted by
// libx264 (string option) and by NVENC/VAAPI/AMF (named constants).
func h264Level(height int) string {
	idc := h264LevelIDC(height)
	return fmt.Sprintf("%d.%d", idc/10, idc%10)
}

// h264LevelHex renders level_idc as the two hex digits used in the
// avc1.PPCC LL CODECS attribute (e.g. 40 → "28").
func h264LevelHex(height int) string {
	return fmt.Sprintf("%02x", h264LevelIDC(height))
}
