package streaming

// Collapsing a playback decision's prose reason into an aggregatable bucket
// (August 2026 review, item #1).
//
// DecidePlayback produces a human-readable TranscodeReason — "container \"mkv\"
// not natively supported", "compatible audio track 2 is not the default…".
// That prose is exactly right in a log line and useless in aggregate: it
// interpolates track indices and codec names, so no two rows group together.
//
// ReasonCode maps it onto the fixed vocabulary the QoE schema stores, which is
// what answers the question the review actually posed — "is the next bottleneck
// a device family, or an overly conservative capability gate". Bucketing here
// rather than in the client keeps the vocabulary in one place; the SPA reports
// whatever this returns.

import "strings"

// Reason buckets. These MUST stay in sync with the decision_reason CHECK
// constraint in migration 056 and with db.PlaybackQoEDecisionReasons;
// TestReasonCodeVocabularyMatchesSchema pins that.
const (
	ReasonCompatible  = "compatible"  // direct play — nothing to explain
	ReasonContainer   = "container"   // container isn't browser-native
	ReasonVideoCodec  = "video_codec" // client can't decode the video codec
	ReasonAudioCodec  = "audio_codec" // client can't decode the audio codec
	ReasonBitDepth    = "bit_depth"   // >8-bit source the client's profile rejects
	ReasonHDR         = "hdr"         // HDR needing a tonemap
	ReasonAudioTrack  = "audio_track" // compatible audio exists but isn't default
	ReasonClientRetry = "client_retry"
	ReasonUnspecified = "unspecified"
)

// ReasonCode buckets a PlaybackDecision.
//
// Order matters: the checks run most-specific first, because the prose often
// mentions more than one factor and the FIRST cause is the one worth counting.
// A 10-bit HEVC file on a Main-profile decoder reads as both a codec and a
// bit-depth problem, and it is the bit depth that actually forced the
// transcode — counting it as "video_codec" would hide a whole class of
// capability-gate conservatism behind a codec everyone assumes is unsupported.
func ReasonCode(pd PlaybackDecision) string {
	if pd.Decision == "direct_play" {
		return ReasonCompatible
	}
	reason := strings.ToLower(pd.TranscodeReason)
	switch {
	case reason == "":
		return ReasonUnspecified
	case strings.Contains(reason, "10-bit"),
		strings.Contains(reason, "bit depth"),
		strings.Contains(reason, "hi10p"),
		strings.Contains(reason, "main 10"),
		strings.Contains(reason, "main10"):
		return ReasonBitDepth
	case strings.Contains(reason, "hdr"),
		strings.Contains(reason, "tonemap"):
		return ReasonHDR
	case strings.Contains(reason, "not the default"):
		return ReasonAudioTrack
	case strings.Contains(reason, "audio"):
		return ReasonAudioCodec
	case strings.Contains(reason, "container"):
		return ReasonContainer
	case strings.Contains(reason, "codec"),
		strings.Contains(reason, "video"):
		return ReasonVideoCodec
	default:
		return ReasonUnspecified
	}
}
