package streaming

// Authoritative QoE delivery facts (August 2026 review, adversarial pass).
//
// These describe HOW a session was delivered, and the server is the only party
// that actually knows them. The first version of the telemetry asked the
// browser to report them, and the browser could not: subtitle burn-in is
// configured on a pre-play path the player has no reference to, the encoder
// family is a server-side probe result, and the segment format is a manager
// setting. All five arrived as their zero values on every row, which made
// burn_in_sessions a hardcoded zero — the one column the schema was extended
// for in the first place.
//
// Stamping them here also removes a trust question. Delivery facts are not the
// client's to assert, and a row whose encoder_family says "nvenc" should mean
// the server used NVENC rather than that a browser said so.

// SessionQoEFacts is the delivery description of one transcode/remux session,
// in the vocabularies migration 056 stores.
type SessionQoEFacts struct {
	OutputCodec   string
	EncoderFamily string
	SegmentFormat string
	HDRConversion string
	BurnIn        string
	SubtitleMode  string
}

// DirectPlayQoEFacts is the answer for a direct play: no session exists, no
// encoder runs, and nothing is segmented.
func DirectPlayQoEFacts() SessionQoEFacts {
	return SessionQoEFacts{
		OutputCodec:   "none",
		EncoderFamily: "none",
		SegmentFormat: "none",
		HDRConversion: "none",
		BurnIn:        "none",
		SubtitleMode:  "none",
	}
}

// SessionQoEFacts describes a live session, or reports false when the id is
// unknown (already reaped, or never existed).
func (tm *TranscodeManager) SessionQoEFacts(sessionID string) (SessionQoEFacts, bool) {
	s, ok := tm.peekSession(sessionID)
	if !ok {
		return SessionQoEFacts{}, false
	}

	facts := SessionQoEFacts{
		OutputCodec:   "h264",
		EncoderFamily: "none",
		SegmentFormat: "ts",
		HDRConversion: "none",
		BurnIn:        "none",
		SubtitleMode:  "none",
	}

	if s.FMP4 {
		facts.SegmentFormat = "fmp4"
	}

	switch {
	case s.Remux:
		// Video is copied, so no encoder runs on the video path at all.
		facts.OutputCodec = "copy"
	case s.VideoCodecOut == "hevc":
		facts.OutputCodec = "hevc"
		facts.EncoderFamily = encoderFamilyOf(tm.hwAccel.Type)
	default:
		facts.EncoderFamily = encoderFamilyOf(tm.hwAccel.Type)
	}

	// Burn-in. Bitmap subs (PGS/VOBSUB) take the -filter_complex overlay graph
	// rather than the -vf subtitles filter, and that distinction is the whole
	// reason the column is split three ways instead of being a boolean.
	burning := s.BurnSubIndex >= 0 || s.BurnSubExternal != ""
	if burning {
		facts.BurnIn = "text"
		if s.BurnSubBitmap {
			facts.BurnIn = "bitmap"
		}
	}

	switch {
	case burning:
		// Burned covers both embedded and external sources — once the pixels
		// carry the text there is no separate rendition to describe.
		facts.SubtitleMode = "burned"
	case len(s.SubtitleTracks) > 0:
		// Text tracks extracted into the HLS pipeline as WebVTT renditions.
		facts.SubtitleMode = "embedded"
	}

	// HDR. Burn-in forces the CPU chain regardless of hardware (PlanDecode
	// refuses Tier 2 when a filter cannot run on GPU frames), so the GPU
	// tonemap is only claimed when it could actually have been used.
	if s.HDRTonemap {
		facts.HDRConversion = "tonemap_cpu"
		if !burning && tm.hwAccel.Type == HWAccelVAAPI && tm.decodeCaps().TonemapVAAPI {
			facts.HDRConversion = "tonemap_gpu"
		}
	}

	return facts, true
}

// encoderFamilyOf maps a detected backend onto the telemetry vocabulary.
func encoderFamilyOf(t HWAccelType) string {
	switch t {
	case HWAccelNVENC:
		return "nvenc"
	case HWAccelQSV:
		return "qsv"
	case HWAccelVAAPI:
		return "vaapi"
	case HWAccelAMF:
		return "amf"
	default:
		return "software"
	}
}
