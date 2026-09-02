package streaming

// Stereo downmix policy (September 2026 playback pass).
//
// Every re-encode of a multichannel source on a client without the
// MSE-strict AC-3 cap — Linux, Firefox, Windows 11 24H2 and the
// Chromium-derived browsers all report it false (lib/streaming.ts) — ends in
// stereo AAC, and until this file that fold was a bare `-ac 2`. What the bare
// form does is decided inside libswresample's auto_matrix (rematrix.c):
//
//   - front centre and the surrounds are mixed into each front at -3 dB
//     (0.707), the ITU-R BS.775 Lo/Ro coefficients;
//   - the LFE channel is discarded (lfe_mix_level defaults to 0);
//   - the matrix is rescaled to prevent clipping ONLY when the intermediate
//     sample format is integer. The AAC encoder takes float, so on this path
//     the intermediate is float and nothing is rescaled: a loud passage whose
//     front, centre and surround peak together sums past full scale and
//     clips, because there is no limiter either.
//
// There was also no dialogue-forward option at all, which is the thing people
// actually reach for on laptop and TV speakers and which every peer server
// ships (Plex "boost voices", Jellyfin's DownMixStereoAlgorithm plus a 2x
// DownMixAudioBoost by default, Emby's equivalent).
//
// The policies here write the matrix out explicitly with `pan`, indexed by
// CHANNEL POSITION rather than channel name. ffprobe reports 6-channel tracks
// as either 5.1 (back surrounds) or 5.1(side), and `pan` rejects a named
// channel the input layout does not carry — an index form covers both layouts
// with one expression, which is also how Jellyfin writes its matrices.
//
//	6 channels: c0 FL, c1 FR, c2 FC, c3 LFE, c4 BL|SL, c5 BR|SR
//	8 channels: c0 FL, c1 FR, c2 FC, c3 LFE, c4 BL, c5 BR, c6 SL, c7 SR
//
// Anything else (mono, 3.0, 4.0, 5.0, 6.1, the odd 22.2) keeps the bare
// swresample fold. `pan` does not fail on a wrong-shaped matrix — an input
// index the layout lacks is silently dropped from the expression, an input
// channel the expression never names is silently discarded — so the cost of
// a wrong count is a quietly wrong mix, not a dead launch. Those layouts are
// rare enough that the generic fold is the right answer, and the channel
// count that selects a matrix comes from the library's per-track probe
// (internal/api CreateSession), never from the client's echo.

import "strings"

// StereoDownmix is the operator's policy for folding multichannel audio into
// the stereo AAC the re-encode path emits.
type StereoDownmix string

const (
	// DownmixStandard is the default: the same ITU coefficients swresample
	// uses, written out explicitly and followed by a look-ahead limiter, so
	// the sound is unchanged and loud passages no longer clip.
	DownmixStandard StereoDownmix = "standard"
	// DownmixDialogue is centre-forward: the centre at unity (+3 dB against
	// standard), fronts at -3 dB, surrounds at -6 dB. Speech stays on top of
	// music and effects on small speakers.
	DownmixDialogue StereoDownmix = "dialogue"
	// DownmixNight is dialogue-forward with heavy dynamic-range compression
	// for late-night viewing at low volume. Coefficients and compressor
	// settings follow Jellyfin's NightmodeDialogue algorithm.
	DownmixNight StereoDownmix = "night"
	// DownmixLegacy is the byte-identical rollback: the bare `-ac 2` fold
	// every Aurora install used before this policy existed.
	DownmixLegacy StereoDownmix = "legacy"
)

// ParseStereoDownmix normalizes a configured value. ok=false means the value
// was not recognized; callers warn and fall back to DownmixStandard rather
// than letting a typo reach FFmpeg.
func ParseStereoDownmix(raw string) (StereoDownmix, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "standard", "itu":
		return DownmixStandard, true
	case "dialogue", "dialog", "voice":
		return DownmixDialogue, true
	case "night", "nightmode", "night_mode":
		return DownmixNight, true
	case "legacy", "off", "none":
		return DownmixLegacy, true
	}
	return DownmixStandard, false
}

// downmixLimiter caps peaks just under full scale. A look-ahead limiter
// rather than a rescaled matrix: rescaling is what swresample does on its
// integer path and it is exactly the "downmix is too quiet" complaint every
// peer ends up compensating with a fixed boost. level=false keeps the limiter
// from applying its own make-up gain, so below the ceiling it is a no-op.
//
// Known limit: alimiter's look-ahead is not latency-compensated by default,
// so the two limiter policies carry a fixed audio delay of the attack window
// (5 ms) — far below any lip-sync threshold. Its `latency` option would
// compensate, but it is not on every 5.x build and an unknown option is fatal
// at filter init, so adding it needs the same kind of version gate the
// readrate burst has.
const downmixLimiter = "alimiter=limit=0.98:attack=5:release=50:level=false"

// downmixNightCompressor is the dynamic-range compression the night policy
// adds after its pan. Frame/window/target values are Jellyfin's; the peak
// target is 0.95 instead of their 1.0 so the compressor itself never lands a
// sample on full scale.
const downmixNightCompressor = "dynaudnorm=f=200:g=3:r=0.9:p=0.95:m=100:s=12"

// stereoDownmixFilter returns the `-af` chain that folds `channels` source
// channels into stereo under policy, or "" when the caller should keep the
// bare `-ac 2`: the legacy policy, a source already at or below stereo, or a
// channel count the matrices do not cover.
func stereoDownmixFilter(policy StereoDownmix, channels int) string {
	if policy == DownmixLegacy || channels <= 2 {
		return ""
	}
	var pan string
	switch policy {
	case DownmixDialogue:
		switch channels {
		case 6:
			pan = "pan=stereo|c0=0.707*c0+c2+0.5*c4|c1=0.707*c1+c2+0.5*c5"
		case 8:
			pan = "pan=stereo|c0=0.707*c0+c2+0.354*c4+0.5*c6|c1=0.707*c1+c2+0.354*c5+0.5*c7"
		}
	case DownmixNight:
		switch channels {
		case 6:
			pan = "pan=stereo|c0=c2+0.3*c0+0.3*c4|c1=c2+0.3*c1+0.3*c5"
		case 8:
			pan = "pan=stereo|c0=c2+0.3*c0+0.2*c4+0.3*c6|c1=c2+0.3*c1+0.2*c5+0.3*c7"
		}
		if pan == "" {
			return ""
		}
		return pan + "," + downmixNightCompressor
	default: // DownmixStandard, and the fail-safe for anything unrecognized
		switch channels {
		case 6:
			pan = "pan=stereo|c0=c0+0.707*c2+0.707*c4|c1=c1+0.707*c2+0.707*c5"
		case 8:
			// swresample folds BOTH surround pairs into the fronts at the
			// surround level: rematrix.c adds BACK_LEFT and SIDE_LEFT to
			// FRONT_LEFT at slev (0.707) independently, with no 7.1-specific
			// rule. Measured on 7.0.2 (second review): a tone on BL alone and
			// on SL alone come through the bare fold at the same level.
			// Mirrored here so standard stays the sound people have today.
			pan = "pan=stereo|c0=c0+0.707*c2+0.707*c4+0.707*c6|c1=c1+0.707*c2+0.707*c5+0.707*c7"
		}
	}
	if pan == "" {
		return ""
	}
	return pan + "," + downmixLimiter
}
