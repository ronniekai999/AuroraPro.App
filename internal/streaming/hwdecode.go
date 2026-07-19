package streaming

// Hardware DECODE pipeline (2026-07 review item 7).
//
// The encoder side has been GPU-accelerated since Phase 3 (hwaccel.go), but
// every session still DECODED in software — for the dominant heavy job
// (4K HEVC → H.264 ladder) the CPU HEVC decode is most of the cost. This
// module adds two probed, per-session-gated tiers:
//
//	Tier 1 — decode offload. `-hwaccel cuda|vaapi` input flags with frames
//	returned to SYSTEM memory, so every existing CPU filter chain (zscale
//	tonemap, subtitle burn-in, scale=…,format=yuv420p) runs byte-for-byte
//	unchanged. This flag form is best-effort inside FFmpeg itself: an
//	unsupported profile logs a warning and falls back to software decode
//	in-process, so Tier 1 introduces no new failure mode.
//
//	Tier 2 — zero-copy. `-hwaccel_output_format cuda|vaapi` keeps frames on
//	the GPU through scale_cuda / scale_vaapi (and tonemap_vaapi for HDR on
//	Intel) into the GPU encoder. Chosen ONLY when the whole chain can live
//	on the GPU: no subtitle burn-in, and HDR only when tonemap_vaapi
//	probed. Unlike Tier 1 a decode-init failure here kills the command, so
//	Tier 2 is gated on (a) a startup probe of the EXACT pipeline shape and
//	(b) the per-variant software-decode crash fallback in EnsureVariant.
//
// Backend mapping: NVENC boxes decode via CUDA/NVDEC; VAAPI, QSV and AMF
// boxes all decode via VAAPI (same silicon, one battle-tested path — QSV
// and AMF still ENCODE with their own encoders, fed from system memory).
//
// Probing philosophy matches DetectHWAccel: run tiny real FFmpeg jobs at
// startup, treat any failure as "capability off". Samples are generated
// once with the software encoders; a distro ffmpeg without libx265 simply
// yields no HEVC decode offload (conservative, never wrong).
//
// Rollback: `transcode.hw_decode: off` (config) restores the encode-only
// pipeline, mirroring the segment_format rollback knob.

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Decode-capability keys in HWAccelInfo.DecodeCodecs. hevc10 is separate
// because 10-bit support diverges from 8-bit on real hardware (e.g. Intel
// Gen9/Skylake VAAPI decodes HEVC Main but not Main 10), and H.264 10-bit
// (Hi10P) has NO hardware decoder anywhere — decodeKeyFor never maps it.
const (
	decodeKeyH264   = "h264"
	decodeKeyHEVC   = "hevc"
	decodeKeyHEVC10 = "hevc10"
	decodeKeyVP9    = "vp9"
)

// decodeKeyFor maps a source codec + pixel format to the DecodeCodecs
// capability key, or "" when hardware decode must not be attempted for this
// source (unknown codec, AV1 — not probed, or Hi10P H.264).
func decodeKeyFor(codec, pixFmt string) string {
	is10bit := strings.Contains(strings.ToLower(pixFmt), "10")
	switch strings.ToLower(codec) {
	case "h264", "avc", "avc1":
		if is10bit {
			return "" // Hi10P: no hardware decoder exists, anywhere
		}
		return decodeKeyH264
	case "hevc", "h265":
		if is10bit {
			return decodeKeyHEVC10
		}
		return decodeKeyHEVC
	case "vp9":
		if is10bit {
			return "" // VP9 profile-2 hardware decode is too patchy to assume
		}
		return decodeKeyVP9
	}
	return ""
}

// PlanDecode decides the decode pipeline for one transcode variant. Returns
// the input-side FFmpeg flags (to place before -i) and whether the Tier-2
// zero-copy pipeline is active (in which case the caller must use
// FullGPUEncoderArgs and skip the CPU tonemap/burn-in injectors).
//
// forceSoftware is the per-variant crash fallback (QualityVariant.
// swDecodeFallback): after a mid-stream FFmpeg crash the restart runs
// without any hardware decode so an exotic file that slipped past the
// probes can never permanently wedge a title.
func (h HWAccelInfo) PlanDecode(codec, pixFmt string, hdrTonemap, burnIn, forceSoftware bool) ([]string, bool) {
	if forceSoftware || h.DecodeType == "" || h.DecodeType == HWAccelNone || len(h.DecodeCodecs) == 0 {
		return nil, false
	}
	key := decodeKeyFor(codec, pixFmt)
	if key == "" || !h.DecodeCodecs[key] {
		return nil, false
	}
	// Tier 2: the whole filter chain must be expressible on the GPU.
	if h.FullGPU && !burnIn {
		if !hdrTonemap {
			return h.decodeInputArgs(true), true
		}
		if h.Type == HWAccelVAAPI && h.TonemapVAAPI {
			return h.decodeInputArgs(true), true
		}
	}
	// Tier 1: decode offload only; frames come back to system memory and
	// the existing CPU chains (zscale tonemap, burn-in, scale) apply.
	return h.decodeInputArgs(false), false
}

// decodeInputArgs builds the input-side flags for the probed decode backend.
func (h HWAccelInfo) decodeInputArgs(fullGPU bool) []string {
	switch h.DecodeType {
	case HWAccelNVENC: // NVDEC, addressed through the CUDA hwaccel
		a := []string{"-hwaccel", "cuda"}
		if fullGPU {
			a = append(a, "-hwaccel_output_format", "cuda")
		}
		return a
	case HWAccelVAAPI:
		dev := h.DevicePath
		if dev == "" {
			dev = findDRIDevice()
		}
		a := []string{"-hwaccel", "vaapi", "-hwaccel_device", dev}
		if fullGPU {
			a = append(a, "-hwaccel_output_format", "vaapi")
		}
		return a
	}
	return nil
}

// FullGPUEncoderArgs is the Tier-2 counterpart of VideoEncoderArgs: the
// scale (and for VAAPI-HDR, tonemap) runs on GPU frames delivered by
// -hwaccel_output_format. Bitrate control, keyframe forcing and audio args
// are appended by the caller exactly as for the CPU-chain path. Only NVENC
// and VAAPI have a Tier 2 (QSV/AMF encode from system memory).
func (h HWAccelInfo) FullGPUEncoderArgs(width, height int, hdrTonemap bool) []string {
	level := h264Level(height)
	profile := h264Profile(height)
	switch h.Type {
	case HWAccelNVENC:
		// scale_cuda's format=yuv420p also performs the P010→8-bit
		// conversion for 10-bit HEVC sources, mirroring the CPU chain's
		// format=yuv420p contract. HDR never reaches here (PlanDecode
		// keeps NVENC HDR on Tier 1's CPU zscale chain).
		vf := fmt.Sprintf("scale_cuda=%d:-2:format=yuv420p", width)
		return []string{"-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr",
			"-profile:v", profile, "-level", level, "-vf", vf}
	case HWAccelVAAPI:
		vf := fmt.Sprintf("scale_vaapi=w=%d:h=-2:format=nv12", width)
		if hdrTonemap {
			// GPU HDR→SDR: tonemap first (matches the CPU chain's
			// correctness posture — tonemap at source resolution), then
			// scale. tonemap_vaapi reads the frames' colour metadata and
			// outputs bt709 nv12.
			vf = fmt.Sprintf("tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709,scale_vaapi=w=%d:h=-2", width)
		}
		return []string{"-c:v", "h264_vaapi", "-level", level, "-vf", vf}
	}
	return nil
}

// ============================================================
// Startup probing
// ============================================================

// hwProbeTimeout bounds each individual probe FFmpeg run. Generous — these
// are 5-frame 192x108 jobs; anything slower than this is effectively broken.
const hwProbeTimeout = 20 * time.Second

// ProbeHWDecode augments a detected HWAccelInfo with decode-side
// capabilities. Call once at TranscodeManager construction, after
// DetectHWAccel, unless hw_decode is configured off. Any failure —
// missing ffmpeg, missing software encoders for the samples, hwaccel init
// errors — degrades to "that capability stays off" and is logged at Debug.
func ProbeHWDecode(info *HWAccelInfo, workDir string) {
	if info == nil || info.Type == HWAccelNone {
		return
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return
	}

	switch info.Type {
	case HWAccelNVENC:
		info.DecodeType = HWAccelNVENC
	case HWAccelVAAPI, HWAccelQSV, HWAccelAMF:
		// Intel and AMD silicon expose decode through VAAPI regardless of
		// which encode API is in use; one decode path to probe and trust.
		info.DecodeType = HWAccelVAAPI
	default:
		return
	}

	dir, err := os.MkdirTemp(workDir, ".hwprobe-*")
	if err != nil {
		slog.Debug("hw decode probe: temp dir", "error", err)
		info.DecodeType = HWAccelNone
		return
	}
	defer os.RemoveAll(dir)

	// Generate tiny samples with the software encoders. A missing encoder
	// (no libx265 on this ffmpeg) skips that codec's probes.
	samples := map[string]string{}
	type sampleSpec struct {
		key  string
		file string
		args []string
	}
	specs := []sampleSpec{
		{decodeKeyH264, "s264.mp4", []string{"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"}},
		{decodeKeyHEVC, "s265.mp4", []string{"-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=none", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"}},
		// 10-bit HEVC tagged as PQ/BT.2020 so the tonemap_vaapi probe sees
		// real HDR frame metadata.
		{decodeKeyHEVC10, "s265hdr.mp4", []string{"-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=none", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
			"-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc"}},
		{decodeKeyVP9, "svp9.webm", []string{"-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p"}},
	}
	for _, s := range specs {
		out := filepath.Join(dir, s.file)
		args := append([]string{"-hide_banner", "-f", "lavfi", "-i", "testsrc=duration=0.5:size=192x108:rate=10"}, s.args...)
		args = append(args, "-frames:v", "5", "-y", out)
		if runProbeFFmpeg(args) {
			samples[s.key] = out
		} else {
			slog.Debug("hw decode probe: sample generation failed (codec probe skipped)", "codec", s.key)
		}
	}
	if len(samples) == 0 {
		info.DecodeType = HWAccelNone
		return
	}

	// Tier-1 decode probes. `-hwaccel X` alone exits 0 even when it falls
	// back to software, so force the frames THROUGH the hardware path with
	// -hwaccel_output_format + hwdownload: that pipeline only succeeds when
	// the hardware decoder actually engaged.
	base, outFmt := probeDecodeFlags(info)
	info.DecodeCodecs = map[string]bool{}
	downloadFmt := map[string]string{
		decodeKeyH264:   "nv12",
		decodeKeyHEVC:   "nv12",
		decodeKeyHEVC10: "p010le",
		decodeKeyVP9:    "nv12",
	}
	for key, sample := range samples {
		args := append(append([]string{"-hide_banner"}, base...),
			"-hwaccel_output_format", outFmt,
			"-i", sample,
			"-vf", "hwdownload,format="+downloadFmt[key],
			"-f", "null", "-")
		if runProbeFFmpeg(args) {
			info.DecodeCodecs[key] = true
		}
	}
	if len(info.DecodeCodecs) == 0 {
		slog.Info("hardware decode: no codec passed the probe; decode stays on CPU",
			"decode_backend", string(info.DecodeType))
		info.DecodeType = HWAccelNone
		info.DecodeCodecs = nil
		return
	}

	// Tier-2 cycle probe: the EXACT zero-copy shape startVariantImpl will
	// run (decode → GPU scale → GPU encode). Only NVENC/VAAPI encoders can
	// consume GPU frames; QSV/AMF stay Tier 1.
	if (info.Type == HWAccelNVENC || info.Type == HWAccelVAAPI) && info.DecodeCodecs[decodeKeyH264] {
		enc := info.FullGPUEncoderArgs(96, 54, false)
		args := append(append([]string{"-hide_banner"}, base...),
			"-hwaccel_output_format", outFmt,
			"-i", samples[decodeKeyH264])
		args = append(args, enc...)
		args = append(args, "-frames:v", "2", "-f", "null", "-")
		info.FullGPU = runProbeFFmpeg(args)
	}

	// GPU tonemap probe (VAAPI only): decode the HDR sample and run the
	// exact tonemap_vaapi chain. Requires the 10-bit decode to have passed.
	if info.Type == HWAccelVAAPI && info.FullGPU && info.DecodeCodecs[decodeKeyHEVC10] {
		if sample, ok := samples[decodeKeyHEVC10]; ok {
			enc := info.FullGPUEncoderArgs(96, 54, true)
			args := append(append([]string{"-hide_banner"}, base...),
				"-hwaccel_output_format", outFmt,
				"-i", sample)
			args = append(args, enc...)
			args = append(args, "-frames:v", "2", "-f", "null", "-")
			info.TonemapVAAPI = runProbeFFmpeg(args)
		}
	}

	slog.Info("hardware decode probed",
		"decode_backend", string(info.DecodeType),
		"codecs", decodeCodecList(info.DecodeCodecs),
		"zero_copy", info.FullGPU,
		"gpu_tonemap", info.TonemapVAAPI,
	)
}

// probeDecodeFlags returns the input flags and the GPU frame format name
// used by the probe pipelines for info's decode backend.
func probeDecodeFlags(info *HWAccelInfo) ([]string, string) {
	if info.DecodeType == HWAccelNVENC {
		return []string{"-hwaccel", "cuda"}, "cuda"
	}
	dev := info.DevicePath
	if dev == "" {
		dev = findDRIDevice()
	}
	return []string{"-hwaccel", "vaapi", "-hwaccel_device", dev}, "vaapi"
}

// runProbeFFmpeg runs one bounded probe invocation; any non-zero exit or
// timeout is "capability absent".
func runProbeFFmpeg(args []string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), hwProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	cmd.Stdout, cmd.Stderr = nil, nil
	return cmd.Run() == nil
}

func decodeCodecList(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
