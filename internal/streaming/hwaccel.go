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

	// SWPreset is the libx264 preset used when Type == HWAccelNone
	// (transcode.software_preset). Empty means "veryfast". Not part of the
	// admin-facing JSON: it's a config knob, not a detected capability.
	SWPreset string `json:"-"`

	// Policy is the operator's speed/quality preference
	// (transcode.quality_policy), resolved per encoder family by
	// qualitypolicy.go. Like SWPreset it's config, not a detected
	// capability, so it stays out of the admin capability JSON — the
	// policy is reported separately via HWAccelStatus's sibling fields.
	//
	// The ZERO VALUE must behave as PolicyBalanced: HWAccelInfo literals
	// are constructed directly all over the probe and test code, and a
	// zero-value struct has to keep producing the historical arguments.
	// Read it through policy(), never directly.
	Policy QualityPolicy `json:"-"`

	// HEVCEncoder is the probed HEVC encoder for OUTPUT transcodes
	// (2026-08, review item #5): hevc_nvenc / hevc_qsv / hevc_vaapi /
	// hevc_amf for the detected hardware, libx265 for software boxes.
	// Empty = HEVC output unavailable (encoder missing from the FFmpeg
	// build, test encode failed, or transcode.hevc_output: off) — the
	// decision engine then keeps every transcode on H.264. Probed by
	// ProbeHEVCEncoder at TranscodeManager construction.
	HEVCEncoder string `json:"hevc_encoder,omitempty"`
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
				// Deliberately vague about which step failed: tryProbe now
				// logs the reason itself when a test encode fails, and this
				// path is also reached when the device was never detected —
				// where the old "failed test encode" wording was simply wrong.
				slog.Warn("forced hardware encoder is unavailable, falling back to software", "requested", forceType)
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
	// Ask FFmpeg whether it even has this encoder before asking it to run one.
	// Without this the test encode fails with "Unknown encoder 'h264_amf'",
	// which tryProbe then reports as a failed test encode — pointing an
	// operator at their driver or their permissions when the truth is that
	// their FFmpeg was never built with the encoder. Distro builds routinely
	// omit AMF; VA-API is the Linux path for both AMD and Intel silicon.
	if !encoderAvailable(p.encoder) {
		slog.Warn("hardware device detected but this FFmpeg build has no encoder for it — this box will transcode on the CPU",
			"encoder", p.displayName,
			"ffmpeg_encoder", p.encoder,
			"hint", "check `ffmpeg -encoders`; a build without this encoder cannot use the device however it is configured")
		return HWAccelInfo{}, false
	}

	slog.Info("device detected, running test encode...", "encoder", p.displayName)
	args, devPath := p.testArgsFn()
	reason, err := runTestEncode(args)
	if err == nil {
		info := HWAccelInfo{Type: p.accelType, VideoEncoder: p.encoder, DevicePath: devPath, DisplayName: p.displayName}
		slog.Info("hardware acceleration available", "encoder", p.displayName, "ffmpeg_encoder", p.encoder)
		return info, true
	}

	// Warn, not Debug. The hardware IS present — detectFn just said so — and
	// its encoder still didn't work, so every transcode on this box silently
	// runs on the CPU. At Debug the operator's only trace is "no hardware
	// acceleration detected", which cannot distinguish a missing driver from
	// no permission on the render node from an FFmpeg built without the
	// encoder. Machines with no such hardware never reach this line, so it
	// stays quiet where it would have nothing to offer.
	attrs := []any{
		"encoder", p.displayName,
		"ffmpeg_encoder", p.encoder,
		"error", err,
		"ffmpeg_stderr", reason,
	}
	if devPath != "" {
		attrs = append(attrs, "device", devPath)
	}
	slog.Warn("hardware encoder detected but its test encode failed — this box will transcode on the CPU", attrs...)
	return HWAccelInfo{}, false
}

// The capability probes deliberately use FIXED presets rather than the
// configured quality policy.
//
// They run inside DetectHWAccel, before NewTranscodeManager has resolved the
// policy onto HWAccelInfo, so the policy is genuinely unavailable here. That is
// acceptable because of what the probe actually answers: "does this encoder
// exist and run on this device at all". Preset names are universal within an
// encoder family — every h264_nvenc build accepts p1..p7, every h264_qsv build
// accepts the x264-style names — so a probe that succeeds at one preset
// succeeds at the others. Threading the policy in would validate a marginally
// more specific argv at the cost of an initialisation-order dependency, for a
// failure mode that does not exist.
//
// (The Tier-2 decode probe in hwdecode.go DOES see the policy, because it runs
// asynchronously after the manager is built. The asymmetry is a consequence of
// when each probe runs, not a decision about what to validate.)

// runTestEncode generates 1 frame of synthetic video and encodes it, and
// returns FFmpeg's reason when that fails (see tryProbe). Thin wrapper over
// runProbeFFmpegDiag (hwdecode.go) so encode and decode probes share one
// bounded runner and can't drift in hardening behavior.
func runTestEncode(extraArgs []string) (string, error) {
	args := append([]string{"-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=1"}, extraArgs...)
	args = append(args, "-frames:v", "1", "-f", "null", "-")
	return runProbeFFmpegDiag(args)
}

// encoderAvailable reports whether the FFmpeg on PATH was built with the named
// encoder. Indirected through a variable so tests can drive tryProbe without a
// real FFmpeg; production always uses ffmpegHasEncoder.
var encoderAvailable = ffmpegHasEncoder

// ffmpegHasEncoder parses `ffmpeg -encoders` for an exact encoder name.
//
// Answers TRUE when FFmpeg cannot be run at all. The test encode is the real
// gate — this check exists only to tell "the build lacks the encoder" apart
// from "the encoder failed", and if we cannot ask, the honest move is to let
// the test encode produce its own verdict rather than invent one here.
func ffmpegHasEncoder(name string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), hwProbeTimeout)
	defer cancel()
	// CombinedOutput, not Output: FFmpeg routes informational listings through
	// av_log, and which stream that lands on has varied across builds. Reading
	// stdout alone would report EVERY encoder missing on a build that logs to
	// stderr — silently disabling working hardware acceleration and warning
	// that the build has no encoder, on a box where it does.
	//
	// Folding stderr in can only cost a false POSITIVE (some diagnostic line
	// whose second field happens to be an encoder name), and a false positive
	// just means we run the test encode — which is the real gate. Every
	// ambiguous case should land there rather than be decided here.
	//
	// Bounded because capturing output is what makes Wait able to outlive the
	// process (runBounded, execwait.go): this runs from NewTranscodeManager,
	// via both DetectHWAccel and ProbeHEVCEncoder, so an unbounded wait here
	// is a server that never finishes starting. runBounded also decides what
	// ErrWaitDelay means — the process exited 0 and this listing is its real
	// listing, so the name check below stands rather than being failed over
	// descriptor hygiene.
	out, err := boundedCombinedOutput(exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-encoders"))
	if err != nil {
		slog.Debug("could not list FFmpeg encoders; leaving the verdict to the test encode", "error", err)
		return true
	}
	return encoderListed(string(out), name)
}

// encoderListed scans `ffmpeg -encoders` output for an exact name.
//
// The listing is "<flags> <name> <description>", and descriptions mention
// other encoders freely ("codec h264", "Intel Quick Sync Video acceleration"),
// so a substring search over the whole output would match nearly anything.
// Only the second field is the encoder's name.
func encoderListed(encodersOut, name string) bool {
	for _, line := range strings.Split(encodersOut, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == name {
			return true
		}
	}
	return false
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
	// Bounded: like every captured-output command on the startup path, Wait
	// here can outlive the process itself (runBounded, execwait.go).
	out, err := boundedOutput(exec.CommandContext(ctx, "nvidia-smi", "--query-gpu=name", "--format=csv,noheader"))
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
	// Bounded: see detectNVIDIA and runBounded (execwait.go).
	out, err := boundedOutput(exec.CommandContext(ctx, "lspci"))
	if err != nil {
		return false
	}
	return hasAMDDisplayDevice(string(out))
}

// hasAMDDisplayDevice reports whether lspci lists an AMD/ATI DISPLAY adapter.
//
// This used to search the whole output for "amd" and, separately, for "vga" or
// "display" — which matches when those words are on DIFFERENT lines. Every
// Ryzen and EPYC box says "Advanced Micro Devices, Inc. [AMD]" on its
// host-bridge lines, so any AMD-CPU machine with any display adapter at all
// looked like AMD encode hardware.
//
// The 2026-08-02 production box is the case in point: an AMD CPU whose only
// display device is an ASPEED BMC console chip — display-only silicon with no
// video engine at all. It was reported as "AMD AMF", ran a doomed test encode,
// and (once probe failures became visible) raised a warning about hardware
// that does not exist.
//
// Matching per line, and only on lines lspci classifies as graphics, is what
// makes the answer mean anything.
func hasAMDDisplayDevice(lspciOut string) bool {
	for _, line := range strings.Split(lspciOut, "\n") {
		lower := strings.ToLower(line)
		if !isDisplayControllerLine(lower) {
			continue
		}
		// "[AMD/ATI]" is how modern lspci labels Radeon parts; the older
		// "ATI Technologies" and product-name "Radeon" forms still appear on
		// long-lived installs.
		for _, vendor := range []string{"amd", "ati technologies", "radeon"} {
			if strings.Contains(lower, vendor) {
				return true
			}
		}
	}
	return false
}

// isDisplayControllerLine matches the PCI class names lspci prints for
// graphics devices, so a host bridge or audio controller from the same vendor
// cannot stand in for a GPU.
func isDisplayControllerLine(lowerLine string) bool {
	// PCI classes 0300 / 0301 / 0302 / 0380. XGA is vanishingly rare but
	// costs one string, and omitting it would miss the device entirely.
	for _, class := range []string{
		"vga compatible controller",
		"xga compatible controller",
		"3d controller",
		"display controller",
	} {
		if strings.Contains(lowerLine, class) {
			return true
		}
	}
	return false
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
func (h HWAccelInfo) VideoEncoderArgs(width, height int, fps float64) []string {
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
	level := h264Level(height, fps)
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
		return []string{"-c:v", "h264_nvenc", "-preset", h.policy().nvencPreset(), "-tune", "hq", "-rc", "vbr",
			"-profile:v", profile, "-level", level, "-vf", scale}
	case HWAccelQSV:
		// `-profile:v` with the explicit :v stream specifier — NOT bare
		// `-profile`. An empty stream specifier applies the option to ALL
		// output streams, including audio: when the session re-encodes audio
		// (the default `-c:a aac`), the AAC encoder is asked to set
		// profile=high, which is not a valid AAC profile constant
		// (aac_low/aac_main/…), and FFmpeg aborts at encoder init before
		// producing a single segment. Review 2026-06 finding B1.
		return []string{"-c:v", "h264_qsv", "-preset", h.policy().qsvPreset(),
			"-profile:v", profile, "-level", strconv.Itoa(h264LevelIDC(height, fps)), "-vf", scale}
	case HWAccelVAAPI:
		// VAAPI does not support explicit baseline profile constraint — leave as-is.
		// The format=nv12 step here is the equivalent 8-bit downconvert.
		dev := h.DevicePath
		if dev == "" {
			dev = findDRIDevice()
		}
		vf := fmt.Sprintf("format=nv12,hwupload,scale_vaapi=w=%d:h=-2", width)
		args := []string{"-vaapi_device", dev, "-vf", vf, "-c:v", "h264_vaapi", "-level", level}
		// Until the quality policy existed this family had no quality knob at
		// all — on the most common self-hosted GPU. Balanced still emits
		// nothing (driver default), so the default path is unchanged.
		return append(args, h.policy().vaapiCompressionArgs()...)
	case HWAccelAMF:
		return []string{"-c:v", "h264_amf", "-quality", h.policy().amfQuality(),
			"-profile:v", profile, "-level", level, "-vf", scale}
	default:
		// Software (libx264). Preset comes from transcode.software_preset when
		// set (validated in NewTranscodeManager) and otherwise from the
		// quality policy; empty defends the zero-value struct used by
		// tests/probes.
		preset := h.policy().softwarePresetFor(h.SWPreset)
		return []string{"-c:v", "libx264", "-preset", preset,
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

// h264LevelIDC returns the H.264 level_idc for a given output height and
// source frame rate — the SINGLE source of truth from which every rendering
// derives: the dotted form for libx264/NVENC/VAAPI/AMF (-level "4.0"), the
// numeric form for h264_qsv (level_idc integer — QSV has no named dotted
// constants; "4.0" silently evaluates to 4 there), and the two-hex-digit
// form for the master playlist's CODECS attribute (hlsCodecString). One
// table means the encoder constraint and the advertised capability can
// never drift apart.
//
// Level choice per tier (2026-07 review, Chromecast-verified; fps-awareness
// added 2026-08):
//
//	480p and below → 3.1 (31): covers 854x480@60; ≤ every receiver ceiling.
//	720p           → 3.2 (32): covers 1280x720@60 exactly (216,000 MB/s =
//	                 the L3.2 macroblock-rate limit); ≤ every receiver ceiling.
//	1080p ≤30fps   → 4.0 (40): Chromecast gen-1/2 and Nest Hub enforce an
//	                 H.264 High ceiling of Level 4.1 via canDisplayType, so
//	                 the 1080p rung must declare ≤ 4.1 or those receivers
//	                 filter it out and silently cap casts at 720p. 4.0 keeps
//	                 the historical value.
//	1080p >30fps   → 4.2 (42): 1080p60 (489,600 MB/s) exceeds the L4.0/4.1
//	                 macroblock-rate limit (245,760); stamping 4.0 under-
//	                 declares. Truthful 4.2 lets capability-filtering
//	                 receivers correctly fall to the 720p rung (which they
//	                 CAN decode at 60fps) instead of failing on a 1080p60
//	                 stream they cannot decode anyway. x264/NVENC/QSV all
//	                 satisfy 4.2 without complaint.
//	2160p ≤30fps   → 5.1 (51): Chromecast with Google TV's H.264 ceiling is
//	                 exactly 5.1; declaring 5.2 loses its 4K rung for ≤30fps
//	                 content it can genuinely decode.
//	2160p >30fps   → 5.2 (52): 2160p60 (1,944,000 MB/s) exceeds L5.1
//	                 (983,040); same truthful-declaration logic as 1080p60.
//
// fps <= 0 means "unknown" (files scanned before migration 053, or probes
// that report 0/0): keep the ≤30fps choice — the pre-fps-awareness behavior,
// so an unprobed library never regresses. The 30.1/60.1 thresholds
// deliberately ignore 24/25/30 and 50/60 boundary noise (23.976/29.97/59.94
// all round below them).
func h264LevelIDC(height int, fps float64) int {
	switch {
	case height > 1080:
		if fps > 30.1 {
			return 52
		}
		return 51
	case height > 720:
		if fps > 30.1 {
			return 42
		}
		return 40
	case height > 480:
		// 720p60 fits L3.2's 216,000 MB/s limit exactly; 720p120
		// (432,000 MB/s) needs L4.2 (522,240 — L4.0/4.1 cap at 245,760).
		if fps > 60.1 {
			return 42
		}
		return 32
	default:
		// 480p60 fits L3.1; 480p120 (194,400 MB/s) exceeds it → L3.2.
		if fps > 60.1 {
			return 32
		}
		return 31
	}
}

// h264Level renders the level in the dotted form ("4.0") accepted by
// libx264 (string option) and by NVENC/VAAPI/AMF (named constants).
func h264Level(height int, fps float64) string {
	idc := h264LevelIDC(height, fps)
	return fmt.Sprintf("%d.%d", idc/10, idc%10)
}

// h264LevelHex renders level_idc as the two hex digits used in the
// avc1.PPCC LL CODECS attribute (e.g. 40 → "28").
func h264LevelHex(height int, fps float64) string {
	return fmt.Sprintf("%02x", h264LevelIDC(height, fps))
}

// ============================================================
// HEVC Output (2026-08, review item #5)
// ============================================================

// hevcEncoderForType maps a detected HW accel backend to its HEVC encoder
// candidate. Software boxes get libx265.
func hevcEncoderForType(t HWAccelType) string {
	switch t {
	case HWAccelNVENC:
		return "hevc_nvenc"
	case HWAccelQSV:
		return "hevc_qsv"
	case HWAccelVAAPI:
		return "hevc_vaapi"
	case HWAccelAMF:
		return "hevc_amf"
	default:
		return "libx265"
	}
}

// ProbeHEVCEncoder determines the HEVC OUTPUT encoder for this host,
// mirroring the H.264 ladder's gating: the FFmpeg build must LIST the
// encoder (so a missing build feature is distinguished from a broken
// device) and a 1-frame test encode must succeed. Returns "" when
// unavailable — the decision engine then never selects HEVC output and
// every transcode stays on the H.264 path.
//
// forceType "off"/"none"/"disabled" (transcode.hevc_output) skips probing
// entirely — the operator rollback knob.
func ProbeHEVCEncoder(h HWAccelInfo, forceType string) string {
	switch strings.ToLower(strings.TrimSpace(forceType)) {
	case "off", "none", "disabled", "false", "0":
		slog.Info("HEVC output disabled by config")
		return ""
	}
	enc := hevcEncoderForType(h.Type)
	if !encoderAvailable(enc) {
		slog.Info("HEVC output unavailable: FFmpeg build lacks the encoder — transcodes stay on H.264",
			"ffmpeg_encoder", enc)
		return ""
	}
	var args []string
	if h.Type == HWAccelVAAPI {
		dev := h.DevicePath
		if dev == "" {
			dev = findDRIDevice()
		}
		args = []string{"-vaapi_device", dev, "-vf", "format=nv12,hwupload", "-c:v", enc}
	} else {
		args = []string{"-c:v", enc}
	}
	if reason, err := runTestEncode(args); err != nil {
		slog.Warn("HEVC encoder present but its test encode failed — transcodes stay on H.264",
			"ffmpeg_encoder", enc, "error", err, "ffmpeg_stderr", reason)
		return ""
	}
	slog.Info("HEVC output available", "ffmpeg_encoder", enc)
	return enc
}

// hevcLevelIDC returns the HEVC level_idc (level × 30) for a given output
// height and source frame rate — the HEVC counterpart of h264LevelIDC,
// feeding both the encoder -level flags and the master playlist's
// hvc1.1.6.L{idc}.B0 CODECS attribute (one table, no drift).
//
// HEVC levels have far more macroblock-rate headroom than H.264's, so the
// mapping is coarser:
//
//	480p and below → 3.0 (90):  covers 480p60 (~25 Mluma/s vs L3.0's 27.6M).
//	720p           → 3.1 (93):  covers past 720p100 (L3.1 = 98.3 Mluma/s).
//	1080p          → 4.0 (120): covers 1080p63; >60fps bumps to 4.1 (123)
//	                 for the truthful-stamp principle (see h264LevelIDC).
//	2160p          → 5.1 (153): covers 2160p60 (L5.1 = 534.6 Mluma/s);
//	                 >60fps bumps to 5.2 (156).
//
// fps <= 0 = unknown (unscanned library): pick the ≤60fps tier, which is
// what virtually all content needs — HEVC levels rarely constrain.
func hevcLevelIDC(height int, fps float64) int {
	switch {
	case height > 1080:
		if fps > 60.1 {
			return 156 // 5.2
		}
		return 153 // 5.1
	case height > 720:
		if fps > 60.1 {
			return 123 // 4.1
		}
		return 120 // 4.0
	case height > 480:
		return 93 // 3.1
	default:
		return 90 // 3.0
	}
}

// hevcLevel renders the level in the dotted form ("4.0") accepted by
// libx265/NVENC/VAAPI/AMF. QSV gets the raw idc integer (no named dotted
// constants — same quirk as h264_qsv).
func hevcLevel(height int, fps float64) string {
	idc := hevcLevelIDC(height, fps)
	return fmt.Sprintf("%d.%d", idc/30, (idc%30)/3)
}

// HEVCEncoderArgs builds the FFmpeg video encoder flags for an HEVC OUTPUT
// transcode (8-bit Main profile — HDR sources are tonemapped to SDR by the
// same filter chain the H.264 path uses; 10-bit/HDR-preserving output is a
// documented follow-up). Mirrors VideoEncoderArgs per backend, with two
// HEVC-specific requirements:
//
//   - `-tag:v hvc1`: Apple's players reject FFmpeg's default hev1 sample
//     entry (parameter sets in-band); the HLS Authoring Specification
//     requires hvc1. Same rule the HEVC remux path already follows.
//   - HEVC output is only ever selected in fMP4 segment mode (the
//     DecidePlayback / CreateSession gates), so no Annex B concerns apply.
func (h HWAccelInfo) HEVCEncoderArgs(width, height int, fps float64) []string {
	scale := fmt.Sprintf("scale=%d:-2,format=yuv420p", width)
	level := hevcLevel(height, fps)
	switch h.Type {
	case HWAccelNVENC:
		return []string{"-c:v", "hevc_nvenc", "-preset", h.policy().nvencPreset(), "-tune", "hq", "-rc", "vbr",
			"-profile:v", "main", "-level", level, "-vf", scale, "-tag:v", "hvc1"}
	case HWAccelQSV:
		return []string{"-c:v", "hevc_qsv", "-preset", h.policy().qsvPreset(),
			"-profile:v", "main", "-level", strconv.Itoa(hevcLevelIDC(height, fps)), "-vf", scale, "-tag:v", "hvc1"}
	case HWAccelVAAPI:
		dev := h.DevicePath
		if dev == "" {
			dev = findDRIDevice()
		}
		vf := fmt.Sprintf("format=nv12,hwupload,scale_vaapi=w=%d:h=-2", width)
		args := []string{"-vaapi_device", dev, "-vf", vf, "-c:v", "hevc_vaapi",
			"-level", level, "-tag:v", "hvc1"}
		return append(args, h.policy().vaapiCompressionArgs()...)
	case HWAccelAMF:
		return []string{"-c:v", "hevc_amf", "-quality", h.policy().amfQuality(),
			"-profile:v", "main", "-level", level, "-vf", scale, "-tag:v", "hvc1"}
	default:
		// libx265: no explicit -profile — the forced yuv420p (8-bit) input
		// makes x265 emit Main automatically, and the wrapper's profile
		// option naming differs from x264's. Preset honors
		// transcode.software_preset (or the quality policy when unset) like
		// the H.264 path. x265 picks its own level from the input
		// dimensions/rate.
		preset := h.policy().softwarePresetForEncoder(h.SWPreset, true)
		return []string{"-c:v", "libx265", "-preset", preset,
			"-vf", scale, "-tag:v", "hvc1"}
	}
}
