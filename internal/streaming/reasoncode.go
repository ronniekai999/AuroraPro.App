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
// constraint in migration 056 and with db.PlaybackQoEDecisionReasons.
// TestReasonCodeVocabularyMatchesSchema pins the lists against each other, and
// TestReasonCodeEveryBucketIsReachable pins that each one can actually be
// PRODUCED by the decision engine — a bucket nothing emits is dead weight that
// makes the aggregate look more granular than it is.
//
// There is deliberately no "hdr" bucket. HDR never appears in a
// TranscodeReason — an HDR source transcodes because of its BIT DEPTH, and the
// tonemap is a consequence of that decision rather than its cause. The HDR
// dimension is captured properly by the separate hdr_conversion column, which
// records what the pipeline actually did rather than guessing from prose.
const (
	ReasonCompatible  = "compatible"  // direct play — nothing to explain
	ReasonContainer   = "container"   // container isn't browser-native
	ReasonVideoCodec  = "video_codec" // client can't decode/carry the video codec
	ReasonAudioCodec  = "audio_codec" // client can't decode the audio codec
	ReasonBitDepth    = "bit_depth"   // >8-bit source the client's profile rejects
	ReasonAudioTrack  = "audio_track" // compatible audio exists but isn't default
	ReasonUnspecified = "unspecified"
)

// ReasonCode buckets a PlaybackDecision.
//
// It buckets the FIRST SEMICOLON-DELIMITED CLAUSE, not the whole string.
// DecidePlayback composes its prose as "<primary cause>; <consequence>", so the
// clause boundary is exactly where the cause ends. Matching the whole string
// instead let a consequence outrank its own cause: an MKV whose audio also
// needs re-encoding produces
//
//	container "mkv" not natively supported; audio "mp3" not copy-safe …
//
// which a whole-string matcher bucketed as audio_codec, hiding a container
// problem — the single most common shape in an MKV library — behind an audio
// one. Splitting first makes "the first cause is the one worth counting" true
// by construction rather than by careful ordering of the checks below.
//
// Within a clause the checks still run most-specific first. A 10-bit HEVC file
// on a Main-profile decoder reads as both a codec and a bit-depth problem, and
// it is the bit depth that forced the transcode; counting it as video_codec
// would hide a whole class of capability-gate conservatism behind a codec
// everyone assumes is unsupported.
func ReasonCode(pd PlaybackDecision) string {
	if pd.Decision == "direct_play" {
		return ReasonCompatible
	}
	full := strings.ToLower(strings.TrimSpace(pd.TranscodeReason))
	if full == "" {
		return ReasonUnspecified
	}
	if code := bucketClause(firstClause(full)); code != ReasonUnspecified {
		return code
	}
	// Fall back to the whole string: a future reason that puts its cause after
	// the first clause still lands somewhere useful rather than in the
	// catch-all.
	return bucketClause(full)
}

// firstClause returns everything before the first semicolon.
func firstClause(reason string) string {
	if i := strings.IndexByte(reason, ';'); i >= 0 {
		return reason[:i]
	}
	return reason
}

// bucketClause maps one lowercase clause onto a bucket.
func bucketClause(clause string) string {
	switch {
	case strings.Contains(clause, "10-bit"),
		strings.Contains(clause, "bit depth"),
		strings.Contains(clause, "hi10p"),
		strings.Contains(clause, "main 10"),
		strings.Contains(clause, "main10"):
		return ReasonBitDepth

	case strings.Contains(clause, "not the default"):
		return ReasonAudioTrack

	case strings.Contains(clause, "container"):
		return ReasonContainer

	// The remux-forbidden branches. These are video-codec decisions whose prose
	// names neither "codec" nor "video" — VP8/VP9/AV1 that cannot be carried in
	// HLS segments at all, and HEVC that needs fMP4 on a client without it.
	// They previously fell through to the catch-all, which meant the two
	// capability-gate cases the column exists to expose were the two it could
	// not see.
	case strings.Contains(clause, "cannot be remuxed"),
		strings.Contains(clause, "requires fmp4"),
		strings.Contains(clause, "hls spec"):
		return ReasonVideoCodec

	case strings.Contains(clause, "audio"):
		return ReasonAudioCodec

	case strings.Contains(clause, "codec"),
		strings.Contains(clause, "video"):
		return ReasonVideoCodec

	default:
		return ReasonUnspecified
	}
}
