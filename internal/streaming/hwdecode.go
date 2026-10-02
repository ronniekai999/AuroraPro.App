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
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
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
// source (unknown codec, AV1 — not probed, Hi10P H.264, or 12-bit).
// depthKnown reports whether the bit depth was actually recorded: rows
// scanned before the video_pix_fmt column existed have pixFmt == "", and
// for those the caller must stay on Tier 1 (whose in-process software
// fallback tolerates a wrong guess) — Tier 2 would crash outright on a
// 10-bit file decoded by 8-bit-only hardware.
func decodeKeyFor(codec, pixFmt string) (key string, depthKnown bool) {
	pf := strings.ToLower(pixFmt)
	depthKnown = pf != ""
	highBit := pixFmtIsHighBitDepth(pf)
	is10bit := strings.Contains(pf, "10")
	switch strings.ToLower(codec) {
	case "h264", "avc", "avc1":
		if highBit {
			return "", depthKnown // Hi10P family: no hardware decoder exists, anywhere
		}
		return decodeKeyH264, depthKnown
	case "hevc", "h265":
		if is10bit {
			return decodeKeyHEVC10, depthKnown
		}
		if highBit {
			return "", depthKnown // Main 12 / 9-bit: not probed, not assumed
		}
		return decodeKeyHEVC, depthKnown
	case "vp9":
		if highBit {
			return "", depthKnown // VP9 profile-2 hardware decode is too patchy to assume
		}
		return decodeKeyVP9, depthKnown
	}
	return "", depthKnown
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
	key, depthKnown := decodeKeyFor(codec, pixFmt)
	if key == "" || !h.DecodeCodecs[key] {
		return nil, false
	}
	// Tier 2: the whole filter chain must be expressible on the GPU, the
	// bit depth must be KNOWN (an unrecorded pix_fmt could hide a 10-bit
	// file whose decode init would kill the command — Tier 1's in-process
	// fallback tolerates that, Tier 2 doesn't), and the tier-2 cycle for
	// this bit depth must have been probed: FullGPU covers the 8-bit NV12
	// pipeline, FullGPU10 the P010 pipeline (10-bit sources exercise a
	// different scale conversion — e.g. scale_cuda P010→yuv420p).
	tier2Proven := h.FullGPU
	if key == decodeKeyHEVC10 {
		tier2Proven = h.FullGPU10
	}
	if tier2Proven && depthKnown && !burnIn {
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
func (h HWAccelInfo) FullGPUEncoderArgs(width, height int, hdrTonemap bool, fps float64) []string {
	level := h264Level(height, fps)
	profile := h264Profile(height)
	switch h.Type {
	case HWAccelNVENC:
		// scale_cuda's format=yuv420p also performs the P010→8-bit
		// conversion for 10-bit HEVC sources, mirroring the CPU chain's
		// format=yuv420p contract. HDR never reaches here (PlanDecode
		// keeps NVENC HDR on Tier 1's CPU zscale chain).
		vf := fmt.Sprintf("scale_cuda=%d:-2:format=yuv420p", width)
		return []string{"-c:v", "h264_nvenc", "-preset", h.policy().nvencPreset(), "-tune", "hq", "-rc", "vbr",
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
		args := []string{"-c:v", "h264_vaapi", "-level", strconv.Itoa(h264LevelIDC(height, fps)), "-vf", vf}
		return append(args, h.policy().vaapiCompressionArgs()...)
	}
	return nil
}

// FullGPUHEVCEncoderArgs is the Tier-2 zero-copy counterpart of
// HEVCEncoderArgs (2026-08): decode, scale (and VAAPI HDR tonemap) all run
// on GPU frames. HEVC output sessions carry the same -tag:v hvc1
// requirement as the CPU chain (Apple rejects the default hev1 brand).
func (h HWAccelInfo) FullGPUHEVCEncoderArgs(width, height int, hdrTonemap bool, fps float64) []string {
	level := hevcLevel(height, fps)
	switch h.Type {
	case HWAccelNVENC:
		vf := fmt.Sprintf("scale_cuda=%d:-2:format=yuv420p", width)
		return []string{"-c:v", "hevc_nvenc", "-preset", h.policy().nvencPreset(), "-tune", "hq", "-rc", "vbr",
			"-profile:v", "main", "-level", level, "-vf", vf, "-tag:v", "hvc1"}
	case HWAccelVAAPI:
		vf := fmt.Sprintf("scale_vaapi=w=%d:h=-2:format=nv12", width)
		if hdrTonemap {
			vf = fmt.Sprintf("tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709,scale_vaapi=w=%d:h=-2", width)
		}
		args := []string{"-c:v", "hevc_vaapi", "-level", strconv.Itoa(hevcLevelIDC(height, fps)), "-vf", vf, "-tag:v", "hvc1"}
		return append(args, h.policy().vaapiCompressionArgs()...)
	}
	return nil
}

// ============================================================
// Startup probing
// ============================================================

// hwProbeTimeout bounds each individual probe FFmpeg run. Generous — these
// are 5-frame 192x108 jobs; anything slower than this is effectively broken.
//
// It also bounds the two startup FFmpeg runs that are not encodes at all (the
// encoder listing and the version banner, hwaccel.go and streaming.go): both
// return in milliseconds on any working build, so the same generous ceiling
// costs them nothing and one number keeps the startup path's worst case
// legible. What it buys there is that a wrapper which never returns cannot
// hang the boot — a WaitDelay cannot do that job, since Wait never reaches the
// drain until the process is reaped.
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
	// the hardware decoder actually engaged. The flags come from the SAME
	// builder sessions use (decodeInputArgs) so probe and production can
	// never validate different invocations.
	base := info.decodeInputArgs(true) // -hwaccel X [-hwaccel_device dev] -hwaccel_output_format X
	info.DecodeCodecs = map[string]bool{}
	downloadFmt := map[string]string{
		decodeKeyH264:   "nv12",
		decodeKeyHEVC:   "nv12",
		decodeKeyHEVC10: "p010le",
		decodeKeyVP9:    "nv12",
	}
	for key, sample := range samples {
		args := append(append([]string{"-hide_banner"}, base...),
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

	// Tier-2 cycle probes: the EXACT zero-copy shapes startVariantImpl will
	// run (decode → GPU scale → GPU encode). Only NVENC/VAAPI encoders can
	// consume GPU frames; QSV/AMF stay Tier 1. The 8-bit (NV12) and 10-bit
	// (P010) pipelines exercise different scale conversions, so each gets
	// its own probe and its own capability bit.
	tier2Cycle := func(sample string, hdr bool) bool {
		args := append(append([]string{"-hide_banner"}, base...), "-i", sample)
		args = append(args, info.FullGPUEncoderArgs(96, 54, hdr, 0)...)
		args = append(args, "-frames:v", "2", "-f", "null", "-")
		return runProbeFFmpeg(args)
	}
	if (info.Type == HWAccelNVENC || info.Type == HWAccelVAAPI) && info.DecodeCodecs[decodeKeyH264] {
		info.FullGPU = tier2Cycle(samples[decodeKeyH264], false)
	}
	if info.FullGPU && info.DecodeCodecs[decodeKeyHEVC10] {
		if sample, ok := samples[decodeKeyHEVC10]; ok {
			info.FullGPU10 = tier2Cycle(sample, false)
		}
	}

	// GPU tonemap probe (VAAPI only): decode the HDR sample and run the
	// exact tonemap_vaapi chain. Requires the 10-bit decode to have passed.
	if info.Type == HWAccelVAAPI && info.FullGPU && info.DecodeCodecs[decodeKeyHEVC10] {
		if sample, ok := samples[decodeKeyHEVC10]; ok {
			info.TonemapVAAPI = tier2Cycle(sample, true)
		}
	}

	slog.Info("hardware decode probed",
		"decode_backend", string(info.DecodeType),
		"codecs", slices.Sorted(maps.Keys(info.DecodeCodecs)),
		"zero_copy", info.FullGPU,
		"zero_copy_10bit", info.FullGPU10,
		"gpu_tonemap", info.TonemapVAAPI,
	)
}

// runProbeFFmpeg runs one bounded probe invocation; any non-zero exit or
// timeout is "capability absent".
func runProbeFFmpeg(args []string) bool {
	_, err := runProbeFFmpegDiag(args)
	return err == nil
}

// runProbeFFmpegDiag is runProbeFFmpeg plus the reason: FFmpeg's own stderr,
// reduced to the few trailing lines that name the cause.
//
// Decode probes stay on runProbeFFmpeg — there are a dozen of them, most
// legitimately fail on most hardware, and their absence is a tier the code
// already degrades through. This exists for the one probe whose failure an
// operator has to act on (encoder detection, see tryProbe), where the only
// other trace is "no hardware acceleration detected" and that names nothing
// to fix.
func runProbeFFmpegDiag(args []string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hwProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	stderr := &tailBuffer{limit: probeStderrLimit}
	cmd.Stdout, cmd.Stderr = nil, stderr
	// Attaching a writer to Stderr changes Wait's contract: os/exec now copies
	// through a pipe and Wait blocks until that pipe closes, which a process
	// holding the descriptor open can stretch past the context deadline. These
	// probes run in the startup path, so a hang here is a server that never
	// finishes booting. WaitDelay bounds the wait; the previous nil Stderr had
	// no pipe and so could not stall this way. (Same contract, same bound, and
	// the same ErrWaitDelay reading as every captured-output command in the
	// package — see runBounded in execwait.go. This one stays hand-rolled
	// because it needs the stderr tail, not the whole capture.)
	cmd.WaitDelay = execWaitDelay
	err := cmd.Run()
	// WaitDelay's own failure mode: when the process exits SUCCESSFULLY but
	// leaves a pipe open past the delay, Wait reports ErrWaitDelay instead of
	// nil. Treating that as a failed probe would disable hardware acceleration
	// on a box whose encoder actually works — and log a "test encode failed"
	// warning quoting stderr from an encode that succeeded. The probe's
	// verdict comes from the exit status, not from how tidily it closed.
	if err == nil || errors.Is(err, exec.ErrWaitDelay) {
		return "", nil
	}
	if ctx.Err() != nil {
		// A killed process reports "signal: killed", which reads like a
		// crash. Say which of the two it was.
		err = fmt.Errorf("%w (probe exceeded %s)", err, hwProbeTimeout)
	}
	return probeErrorSummary(stderr.String()), err
}

// probeStderrLimit caps how much of a probe's stderr we hold. FFmpeg's banner
// alone is ~2 KB, and a probe that fails by looping on a driver error can
// print without bound inside the timeout — so we keep a window, not a stream.
const probeStderrLimit = 8 << 10

// probeSummaryLines is how many meaningful trailing stderr lines reach the
// log. FFmpeg prints the real error last; past a few lines the entry stops
// being readable, which defeats the point.
const probeSummaryLines = 4

// tailBuffer keeps only the last `limit` bytes written to it. The useful end
// of FFmpeg's stderr is the end.
type tailBuffer struct {
	buf   []byte
	limit int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	// Report the full length regardless of how much we keep — a short write
	// would be an io.ErrShortWrite to the caller, i.e. os/exec would fail
	// the command we are only trying to observe.
	n := len(p)
	if t.limit > 0 {
		if len(p) > t.limit {
			p = p[len(p)-t.limit:]
		}
		t.buf = append(t.buf, p...)
		if len(t.buf) > t.limit {
			t.buf = t.buf[len(t.buf)-t.limit:]
		}
		return n, nil
	}
	t.buf = append(t.buf, p...)
	return n, nil
}

func (t *tailBuffer) String() string { return string(t.buf) }

// probeErrorSummary reduces a probe's stderr to the lines that say why it
// failed. FFmpeg's fixed preamble (version, build flags, library versions) is
// most of the output and never the reason.
func probeErrorSummary(stderr string) string {
	var keep []string
	for _, line := range strings.Split(stderr, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || isFFmpegBannerLine(line) {
			continue
		}
		keep = append(keep, line)
	}
	if len(keep) > probeSummaryLines {
		keep = keep[len(keep)-probeSummaryLines:]
	}
	return strings.Join(keep, " | ")
}

// isFFmpegBannerLine matches the version/build preamble FFmpeg writes to
// stderr before doing any work. Dropping it is what lets the summary fit on
// one log line.
func isFFmpegBannerLine(line string) bool {
	for _, p := range []string{"ffmpeg version", "built with", "configuration:", "Copyright (c)"} {
		if strings.HasPrefix(line, p) {
			return true
		}
	}
	// Library versions: "libavutil      58. 29.100 / 58. 29.100".
	return strings.HasPrefix(line, "lib") && strings.Contains(line, " / ")
}
