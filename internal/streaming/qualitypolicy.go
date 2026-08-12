package streaming

// Operator-facing speed/quality policy (August 2026 playback review, item #2).
//
// Before this file, Aurora exposed exactly one encoder quality knob:
// transcode.software_preset. That knob reaches libx264 and libx265 — two of the
// ten encoder paths the tree actually has (five hardware families x H.264/HEVC).
// The other eight carried hardcoded values:
//
//	NVENC  -preset p4 -tune hq -rc vbr    (both codecs)
//	QSV    -preset faster                 (both codecs)
//	AMF    -quality speed                 (both codecs)
//	VAAPI  no quality knob at all         (both codecs)
//
// The VAAPI gap is the one that mattered most in practice: VAAPI is the default
// backend on Intel iGPU boxes, the most common self-hosted Linux configuration,
// and those operators had no way to ask for better output at any price.
//
// QualityPolicy resolves one operator intent into the right knob for whichever
// encoder the host actually probed. It deliberately does NOT expose raw
// per-family presets — the vocabularies are mutually unintelligible (p1..p7 vs
// veryfast..veryslow vs speed/balanced/quality vs compression_level 0..7) and an
// operator should not have to learn four of them to say "I care about quality
// more than about warmup".
//
// Compatibility invariant: PolicyBalanced reproduces the pre-policy arguments
// byte-for-byte on every family. Upgrading an install without setting the knob
// changes nothing about what FFmpeg is asked to do.

import (
	"fmt"
	"strings"
)

// QualityPolicy is the operator's speed/quality preference for transcodes.
type QualityPolicy string

const (
	// PolicyFastStart favours time-to-first-frame. Chosen when the operator
	// would rather the movie start now than look marginally better.
	PolicyFastStart QualityPolicy = "fast_start"
	// PolicyBalanced is the default and reproduces Aurora's historical
	// encoder arguments exactly.
	PolicyBalanced QualityPolicy = "balanced"
	// PolicyQuality spends more encode time for better compression at the
	// same bitrate budget. Costs startup latency, which is why it is opt-in
	// and why the review pairs it with first-segment measurement.
	PolicyQuality QualityPolicy = "quality"
)

// ParseQualityPolicy normalizes a configured value. ok=false means the value
// was not recognized; callers warn and fall back to PolicyBalanced rather than
// letting an unknown string reach an encoder as a misspelled preset (which
// kills the transcode at encoder init — the same fail-safe posture
// software_preset already had).
func ParseQualityPolicy(raw string) (QualityPolicy, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "balanced":
		return PolicyBalanced, true
	case "fast_start", "faststart", "fast":
		return PolicyFastStart, true
	case "quality", "hq":
		return PolicyQuality, true
	}
	return PolicyBalanced, false
}

// policy returns the effective policy for this backend, mapping the struct's
// zero value onto PolicyBalanced.
//
// HWAccelInfo literals are built directly in the hardware probes and across the
// test suite, and every one of those zero-valued Policy fields must keep
// producing the historical encoder arguments. Reading the field through this
// accessor is what makes the compatibility invariant hold by construction
// rather than by remembering to set it everywhere.
func (h HWAccelInfo) policy() QualityPolicy {
	switch h.Policy {
	case PolicyFastStart, PolicyQuality:
		return h.Policy
	default:
		return PolicyBalanced
	}
}

// softwarePresetFor returns the x264/x265 preset this policy implies.
//
// An explicitly configured transcode.software_preset still wins: it predates
// the policy knob, operators have it set, and it is strictly more specific.
// The policy only fills in the value when software_preset is empty.
//
// Every preset here stays inside the realtime-capable set NewTranscodeManager
// validates (ultrafast..medium) — a policy must never select a preset that
// cannot keep up with on-demand transcoding.
func (p QualityPolicy) softwarePresetFor(configured string) string {
	if configured != "" {
		return configured
	}
	switch p {
	case PolicyFastStart:
		return "superfast"
	case PolicyQuality:
		// Two steps slower than the default. x264's compression gain per step
		// is largest at the fast end of the curve, and "fast" is still
		// comfortably realtime on the hardware class this project targets.
		return "fast"
	default:
		return "veryfast"
	}
}

// nvencPreset maps the policy onto NVENC's p1..p7 scale (p1 fastest, p7 best).
func (p QualityPolicy) nvencPreset() string {
	switch p {
	case PolicyFastStart:
		return "p2"
	case PolicyQuality:
		return "p6"
	default:
		return "p4"
	}
}

// qsvPreset maps the policy onto QSV's x264-style preset names.
func (p QualityPolicy) qsvPreset() string {
	switch p {
	case PolicyFastStart:
		return "veryfast"
	case PolicyQuality:
		return "slow"
	default:
		return "faster"
	}
}

// amfQuality maps the policy onto AMF's speed|balanced|quality scale.
//
// Balanced resolves to "speed", not to AMF's own "balanced": that is what the
// hardcoded argument was before this knob existed, and the compatibility
// invariant above outranks the naming coincidence. Operators who want AMF's
// mid-point should select the quality policy.
func (p QualityPolicy) amfQuality() string {
	if p == PolicyQuality {
		return "quality"
	}
	return "speed"
}

// vaapiCompressionArgs returns the VAAPI quality flag for this policy, or nil.
//
// VAAPI encoders expose -compression_level, where the meaning of the scale is
// DRIVER-DEFINED (i965, iHD and radeonsi do not agree on the range, and 0 means
// "driver default" on all of them). Lower is better quality on the drivers that
// implement it.
//
// Because the semantics vary by driver and cannot be probed cheaply, balanced
// emits NO flag at all — byte-identical to the pre-policy arguments, so the
// default path carries zero risk on hardware this project cannot test against.
// The non-default policies opt in explicitly.
func (p QualityPolicy) vaapiCompressionArgs() []string {
	// The :v stream specifier is load-bearing. -compression_level is flagged
	// E..VA in ffmpeg — it applies to audio encoders too, so a bare form is
	// also handed to the AAC/AC-3 encoder. Neither reads it today so the bare
	// form was inert rather than broken, but an encoder that starts honoring
	// it would silently take a video quality knob as an audio one.
	switch p {
	case PolicyFastStart:
		return []string{"-compression_level:v", "7"}
	case PolicyQuality:
		return []string{"-compression_level:v", "1"}
	default:
		return nil
	}
}

// Describe renders the policy and the arguments it resolves to for a given
// encoder backend, for the admin diagnostics surface. The review's item #2 asks
// for "the active encoder, policy and measured first-segment time in admin";
// this is the first two.
func (p QualityPolicy) Describe(backend HWAccelType, softwarePreset string) string {
	switch backend {
	case HWAccelNVENC:
		return fmt.Sprintf("%s (nvenc preset %s)", p, p.nvencPreset())
	case HWAccelQSV:
		return fmt.Sprintf("%s (qsv preset %s)", p, p.qsvPreset())
	case HWAccelAMF:
		return fmt.Sprintf("%s (amf quality %s)", p, p.amfQuality())
	case HWAccelVAAPI:
		if args := p.vaapiCompressionArgs(); len(args) == 2 {
			return fmt.Sprintf("%s (vaapi compression_level %s)", p, args[1])
		}
		return fmt.Sprintf("%s (vaapi driver default)", p)
	default:
		return fmt.Sprintf("%s (x264/x265 preset %s)", p, p.softwarePresetFor(softwarePreset))
	}
}
