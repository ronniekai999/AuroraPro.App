package streaming

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
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
func runTestEncode(extraArgs []string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	args := append([]string{"-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=1"}, extraArgs...)
	args = append(args, "-frames:v", "1", "-f", "null", "-")
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	cmd.Stdout, cmd.Stderr = nil, nil
	return cmd.Run() == nil
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
// Profile selection: High for resolutions above 1080p (enables B-frames + CABAC
// for better quality at the tight 4K bitrate budget), Baseline for 1080p and below
// (maximum browser/device compatibility).
func (h HWAccelInfo) VideoEncoderArgs(width, height int) []string {
	// scale=W:-2 preserves source aspect ratio with even-number rounding.
	// This prevents distortion of ultrawide (2.4:1), 4:3, or other non-16:9 content.
	scale := fmt.Sprintf("scale=%d:-2", width)
	level := h264Level(height)
	profile := h264Profile(height)
	switch h.Type {
	case HWAccelNVENC:
		return []string{"-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-rc", "vbr",
			"-profile:v", profile, "-level", level, "-vf", scale}
	case HWAccelQSV:
		return []string{"-c:v", "h264_qsv", "-preset", "faster",
			"-profile", profile, "-level", level, "-vf", scale}
	case HWAccelVAAPI:
		// VAAPI does not support explicit baseline profile constraint — leave as-is.
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

// h264Profile returns the appropriate H.264 profile for a given output height.
// High profile for resolutions above 1080p (4K) enables B-frames and CABAC
// entropy coding, which provides ~25% better compression — critical at tight
// 4K bitrate budgets. Baseline profile for 1080p and below maximises
// compatibility with low-power devices and older browsers.
func h264Profile(height int) string {
	if height > 1080 {
		return "high"
	}
	return "baseline"
}

// h264Level returns the appropriate H.264 level string for a given output height.
// Must match hlsCodecString() in streaming.go so the CODECS attribute in the
// master playlist agrees with the actual encoded level.
func h264Level(height int) string {
	switch {
	case height > 1080:
		return "5.1" // 4K
	case height > 720:
		return "4.0" // 1080p
	case height > 480:
		return "3.1" // 720p
	default:
		return "3.0" // 480p and below
	}
}
