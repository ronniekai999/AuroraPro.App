package streaming

import (
	"fmt"
	"strconv"
	"strings"
)

// QualityProfile defines a transcoding quality tier for adaptive HLS.
type QualityProfile struct {
	Name         string `json:"name"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	VideoBitrate string `json:"-"`
	MaxRate      string `json:"-"`
	BufSize      string `json:"-"`
	CRF          int    `json:"-"`         // Software encoder quality (ignored by HW encoders)
	HLSBandwidth int    `json:"bandwidth"` // BANDWIDTH attribute: PEAK bits/sec (video + audio)
	// HLSAvgBandwidth is the AVERAGE-BANDWIDTH attribute: the rendition's
	// expected average bits/sec (target video bitrate + audio). 0 = omitted.
	//
	// It is not decoration. hls.js's findBestLevel picks between the two:
	// it uses maxBitrate (BANDWIDTH) while the buffer is shallow — startup,
	// after a seek, when rebuffering is a live risk — and averageBitrate
	// (AVERAGE-BANDWIDTH) once the buffer is at least two segments deep.
	// Declaring only a peak therefore pins a healthy player to the
	// conservative number forever.
	HLSAvgBandwidth int    `json:"average_bandwidth,omitempty"`
	CodecString     string `json:"-"` // HLS CODECS attribute (e.g., "avc1.640028,mp4a.40.2"); empty = omitted
}

// AllProfiles defines all supported quality tiers.
// Audio bitrate is determined dynamically by audioBitrate() based on source channel count.
// Height values are nominal maximums — actual output height is computed from source
// aspect ratio via AdjustProfileHeight to avoid distortion.
//
// 2026-05-16 quality bump: CRF dropped by 2 across the ladder (software
// encoder) and VideoBitrate/MaxRate/BufSize raised ~30% (hardware
// encoders use bitrate-based mode and ignore CRF). User trade-off:
// ~1-2s extra transcode warmup for visibly better quality. The
// HLSBandwidth declared in the master playlist is also bumped so
// HLS.js's ABR picks variants correctly under the new bitrates.
//
// CRF reference: -2 ≈ one perceptual quality step. CRF 18 is widely
// considered "visually transparent" for 1080p+. CRF 20 is "near
// transparent" for 4K where the source pixel density absorbs more
// compression artifacts.
// 2026-08 ladder-bandwidth correction (August 2026 review follow-up). The
// declared HLSBandwidth values used to be hand-set numbers that sat BELOW the
// encoder's own -maxrate on every rung — 1080p declared 7.5 Mbps against an
// 8 Mbps cap, 720p declared 4.5 against 5, and none of them counted the audio
// track at all (a re-encoded AAC stream adds 192 kbps; AC-3 surround adds 448).
//
// RFC 8216 §4.3.4.2 is explicit that BANDWIDTH is the PEAK segment bit rate of
// the variant, which the client uses to decide whether it can sustain the
// rendition. Under-declaring it makes hls.js believe each rung is cheaper than
// it is, so on a marginal connection it selects a rung it cannot actually
// sustain — and it does so precisely when the buffer is emptiest, because that
// is when findBestLevel consults BANDWIDTH rather than AVERAGE-BANDWIDTH.
// (hls.js does self-correct later from observed fragment sizes via realBitrate;
// the damage lands at startup, before it has any observations.)
//
// The values are now DERIVED rather than hand-maintained: peak from MaxRate,
// average from VideoBitrate, both plus the session's real audio bitrate. See
// LadderBandwidth. The constants below are the AAC-stereo resolution of that
// same arithmetic, used by any path that renders a playlist without a resolved
// session.
var AllProfiles = map[string]QualityProfile{
	"2160p": {Name: "2160p", Width: 3840, Height: 2160, VideoBitrate: "16M", MaxRate: "18M", BufSize: "36M", CRF: 18, HLSBandwidth: 24492000, HLSAvgBandwidth: 16192000},
	"1080p": {Name: "1080p", Width: 1920, Height: 1080, VideoBitrate: "7M", MaxRate: "8M", BufSize: "16M", CRF: 20, HLSBandwidth: 10992000, HLSAvgBandwidth: 7192000},
	"720p":  {Name: "720p", Width: 1280, Height: 720, VideoBitrate: "4M", MaxRate: "5M", BufSize: "9M", CRF: 21, HLSBandwidth: 6942000, HLSAvgBandwidth: 4192000},
	"480p":  {Name: "480p", Width: 854, Height: 480, VideoBitrate: "2M", MaxRate: "2.5M", BufSize: "5M", CRF: 22, HLSBandwidth: 3567000, HLSAvgBandwidth: 2192000},
	"360p":  {Name: "360p", Width: 640, Height: 360, VideoBitrate: "1.2M", MaxRate: "1.5M", BufSize: "3M", CRF: 24, HLSBandwidth: 2217000, HLSAvgBandwidth: 1392000},
}

// --- Declared-bandwidth arithmetic ---

// Re-encode audio bitrates, mirroring audioEncodeArgs in streaming.go: stereo
// AAC at 192k, AC-3 surround at 448k. Kept as constants here so the declared
// bandwidth and the actual encoder flags cannot drift apart silently.
const (
	aacReencodeBitsPerSec = 192_000
	ac3ReencodeBitsPerSec = 448_000
)

// Passthrough ceilings for copied audio, whose real bitrate the server never
// probes. These match the assumptions hls.js itself makes when it estimates an
// audio track's cost, so an over-declaration here can't be worse than what the
// client already budgets for.
const (
	ac3PassthroughCeilingBitsPerSec  = 640_000
	eac3PassthroughCeilingBitsPerSec = 768_000
)

// vbvPeakHeadroom scales -maxrate up to the peak a SEGMENT can actually reach.
//
// -maxrate/-bufsize is a VBV rate-control constraint averaged over the buffer
// window, not a hard per-segment ceiling: with bufsize at 2x maxrate, a segment
// shorter than the buffer window can legitimately exceed maxrate and still
// satisfy the encoder's constraint. Declaring bare maxrate as BANDWIDTH is
// therefore under-declaring by construction, which is what
// TestLadder_DeclaredBandwidthBoundsMeasuredPeak caught on a real encode.
//
// Measured against high-entropy content (testsrc2, libx264, the ladder's own
// CRF/maxrate/bufsize values) at 2-second segments — the tightest configuration
// the server supports, where overshoot is worst because the buffer window
// spans more than one segment:
//
//	360p  1.25x    480p  1.19x    720p  1.01x    1080p  1.22x
//
// At the 6-second production default every rung measured well BELOW maxrate
// (0.26x-0.73x) — CRF binds before the rate cap does — so this factor is
// headroom for the worst supported configuration, not a typical-case estimate.
//
// 1.35 clears the worst observation with margin. The theoretical VBV bound is
// higher still (maxrate + bufsize/segment_duration, ~2x at 2s segments), but
// declaring that would overstate every rung by a factor no real content
// reaches. The asymmetry justifies erring high rather than low: an
// over-declaration costs a conservative rung choice for the first segment or
// two, after which hls.js switches to AVERAGE-BANDWIDTH and its own measured
// realBitrate; an under-declaration costs a stall.
const vbvPeakHeadroom = 1.35

// AudioDeclaredBitrate returns the bits/sec to attribute to a session's audio
// when declaring playlist bandwidth. codecOut is the session's AudioCodecOut
// ("", "aac", "ac3", "eac3"); passthrough marks copied rather than re-encoded
// audio, whose true bitrate is unknown and therefore bounded from above.
func AudioDeclaredBitrate(codecOut string, passthrough bool) int {
	switch strings.ToLower(codecOut) {
	case "ac3":
		if passthrough {
			return ac3PassthroughCeilingBitsPerSec
		}
		return ac3ReencodeBitsPerSec
	case "eac3":
		// E-AC-3 is never a re-encode target — it only reaches output via
		// fMP4 passthrough — so the ceiling applies either way.
		return eac3PassthroughCeilingBitsPerSec
	default:
		return aacReencodeBitsPerSec
	}
}

// LadderBandwidth returns the BANDWIDTH (peak) and AVERAGE-BANDWIDTH values to
// declare for this profile, given the session's audio cost in bits/sec.
//
// Peak comes from MaxRate scaled by vbvPeakHeadroom — the rate cap is a VBV
// constraint, not a per-segment ceiling — and average from VideoBitrate, the
// target the rate controller aims at. Deriving both from the same fields the
// encoder is configured with is the point: a future ladder retune changes one
// number and the declared bandwidth follows, instead of the two drifting apart
// the way they had.
//
// A profile with no parseable rates (the synthetic "source" profile used for
// remux) returns its existing values unchanged.
func (p QualityProfile) LadderBandwidth(audioBitsPerSec int) (peak, average int) {
	maxRate, okPeak := parseBitrateSpec(p.MaxRate)
	avgVideo, okAvg := parseBitrateSpec(p.VideoBitrate)
	if !okPeak || !okAvg {
		return p.HLSBandwidth, p.HLSAvgBandwidth
	}
	if audioBitsPerSec < 0 {
		audioBitsPerSec = 0
	}
	peak = int(float64(maxRate)*vbvPeakHeadroom) + audioBitsPerSec
	return peak, avgVideo + audioBitsPerSec
}

// parseBitrateSpec converts an FFmpeg bitrate string ("18M", "1.2M", "448k")
// into bits per second. ok=false for anything unparseable, so callers keep
// whatever value they already had rather than declaring a zero — a BANDWIDTH
// of 0 would make hls.js treat the rendition as free and always select it.
func parseBitrateSpec(spec string) (int, bool) {
	s := strings.TrimSpace(spec)
	if s == "" {
		return 0, false
	}
	mult := 1.0
	switch s[len(s)-1] {
	case 'M', 'm':
		mult, s = 1_000_000, s[:len(s)-1]
	case 'K', 'k':
		mult, s = 1_000, s[:len(s)-1]
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v <= 0 {
		return 0, false
	}
	return int(v * mult), true
}

// ProfileOrder is highest to lowest quality.
var ProfileOrder = []string{"2160p", "1080p", "720p", "480p", "360p"}

// nearWidthTolerance is how far a profile's nominal width may exceed the
// source width before the profile is dropped from the ladder. 4% comfortably
// covers real-world crop-encoded widths (1912, 1904, 1888 for nominal 1920;
// 3832/3808 for nominal 3840) without ever bridging the gap to the next rung
// down (1920 → 1280 is a 33% step). Kept-but-clamped profiles encode at the
// source width, so no upscaling ever happens.
const nearWidthTolerance = 1.04

// ResolveProfiles returns the profiles that are both enabled and don't exceed source width.
// Each profile's Height is adjusted to preserve the source aspect ratio — the nominal
// height in AllProfiles is just a label. This prevents stretching ultrawide (2.4:1),
// 4:3, or other non-16:9 content into the wrong aspect ratio.
func ResolveProfiles(enabled []string, sourceWidth, sourceHeight int) []QualityProfile {
	if len(enabled) == 0 {
		enabled = ProfileOrder
	}

	var result []QualityProfile
	for _, name := range ProfileOrder {
		found := false
		for _, e := range enabled {
			if e == name {
				found = true
				break
			}
		}
		if !found {
			continue
		}
		p, ok := AllProfiles[name]
		if !ok {
			continue
		}
		// Don't upscale: skip profiles whose width exceeds the source.
		// Height is computed from the source aspect ratio, so only width matters.
		//
		// Near-miss tolerance (2026-07 review): plenty of "1080p" releases are
		// crop-encoded a few pixels narrow (1912/1916 wide after black-bar
		// cropping). A hard `p.Width > sourceWidth` cutoff silently dropped the
		// 1080p rung for those files and capped the ladder at 720p — a large,
		// invisible quality loss. Within nearWidthTolerance the profile is KEPT
		// and clamped to the source width (never upscaled): the 1912-wide file
		// gets a 1912-wide top rung labeled 1080p.
		if p.Width > sourceWidth {
			if float64(p.Width) > float64(sourceWidth)*nearWidthTolerance {
				continue
			}
			// Clamp to source width, rounded down to even (required by
			// H.264 encoders, same constraint as AdjustProfileHeight).
			// No lower-bound guard needed: this branch is only reachable
			// when sourceWidth ≥ p.Width/1.04, and the narrowest ladder
			// width is 640.
			p.Width = sourceWidth &^ 1
		}
		// Adjust height to preserve source aspect ratio.
		p.Height = AdjustProfileHeight(p.Width, sourceWidth, sourceHeight)
		result = append(result, p)
	}

	if len(result) == 0 {
		p := AllProfiles["360p"]
		p.Height = AdjustProfileHeight(p.Width, sourceWidth, sourceHeight)
		result = append(result, p)
	}
	return result
}

// AdjustProfileHeight computes the correct output height for a target width
// while preserving the source aspect ratio. The result is always even
// (required by H.264 encoders).
func AdjustProfileHeight(targetWidth, sourceWidth, sourceHeight int) int {
	if sourceWidth <= 0 {
		return targetWidth * 9 / 16 // fallback to 16:9
	}
	h := targetWidth * sourceHeight / sourceWidth
	// H.264 requires even dimensions
	if h%2 != 0 {
		h--
	}
	if h < 2 {
		h = 2
	}
	return h
}

// GenerateMasterPlaylist builds an HLS master playlist referencing variant streams.
// If queryToken is non-empty, it is appended as ?token= to each variant URL
// so that Safari's native HLS player (which cannot set Authorization headers)
// can authenticate subsequent requests.
//
// If subtitleTracks is provided (variadic for backward compat), #EXT-X-MEDIA
// entries of TYPE=SUBTITLES are added and each #EXT-X-STREAM-INF includes
// SUBTITLES="subs". This enables HLS.js to natively discover and select
// subtitle tracks from the master playlist.
func GenerateMasterPlaylist(profiles []QualityProfile, baseURL, queryToken string, subtitleTracks ...[]HLSSubtitleTrack) string {
	suffix := ""
	if queryToken != "" {
		suffix = "?token=" + queryToken
	}

	// Flatten the variadic subtitle tracks (expect at most one slice)
	var subs []HLSSubtitleTrack
	if len(subtitleTracks) > 0 {
		subs = subtitleTracks[0]
	}
	hasSubs := len(subs) > 0

	out := "#EXTM3U\n"

	// Subtitle rendition entries (EXT-X-MEDIA TYPE=SUBTITLES)
	// Each entry points to a segmented WebVTT playlist produced by the
	// inline subtitle extraction in startVariant.
	for i, st := range subs {
		isDefault := "NO"
		isAutoSelect := "NO"
		if st.Default {
			isDefault = "YES"
			isAutoSelect = "YES"
		}
		if st.Forced {
			isAutoSelect = "YES"
		}
		lang := sanitizeHLSAttr(st.Language)
		if lang == "" {
			lang = "und"
		}
		name := sanitizeHLSAttr(st.Title)
		if name == "" {
			name = lang
		}
		if st.Forced {
			name += " (Forced)"
		}
		subURL := fmt.Sprintf("%s/subs_%d.m3u8%s", baseURL, i, suffix)
		out += fmt.Sprintf("#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"%s\",LANGUAGE=\"%s\",DEFAULT=%s,AUTOSELECT=%s,FORCED=%s,URI=\"%s\"\n",
			name, lang, isDefault, isAutoSelect, boolYesNo(st.Forced), subURL)
	}

	// Variant streams
	for _, p := range profiles {
		subsAttr := ""
		if hasSubs {
			subsAttr = ",SUBTITLES=\"subs\""
		}
		// AVERAGE-BANDWIDTH is optional per RFC 8216 and omitted when unknown
		// (the remux "source" profile has no rate targets to derive it from).
		// A value that exceeded the declared peak would be self-contradictory,
		// so it is only emitted when it is genuinely below BANDWIDTH.
		avgAttr := ""
		if p.HLSAvgBandwidth > 0 && p.HLSAvgBandwidth <= p.HLSBandwidth {
			avgAttr = fmt.Sprintf(",AVERAGE-BANDWIDTH=%d", p.HLSAvgBandwidth)
		}
		if p.CodecString != "" {
			out += fmt.Sprintf("#EXT-X-STREAM-INF:BANDWIDTH=%d%s,RESOLUTION=%dx%d,CODECS=\"%s\",NAME=\"%s\"%s\n",
				p.HLSBandwidth, avgAttr, p.Width, p.Height, p.CodecString, p.Name, subsAttr)
		} else {
			out += fmt.Sprintf("#EXT-X-STREAM-INF:BANDWIDTH=%d%s,RESOLUTION=%dx%d,NAME=\"%s\"%s\n",
				p.HLSBandwidth, avgAttr, p.Width, p.Height, p.Name, subsAttr)
		}
		out += fmt.Sprintf("%s/%s/stream.m3u8%s\n", baseURL, p.Name, suffix)
	}
	return out
}

// sanitizeHLSAttr strips characters that would break HLS playlist attribute syntax.
// Double quotes would close the NAME="..." or LANGUAGE="..." attribute prematurely,
// and newlines would inject new playlist lines. Track metadata comes from FFprobe
// parsing container tags, which is usually clean, but defense-in-depth against
// malformed MKV/MP4 metadata.
func sanitizeHLSAttr(s string) string {
	// `,` and `=` would mid-stream HLS attribute parsers that don't honor
	// quote boundaries (HLS.js has historically been brittle here). MKV
	// metadata like NAME="English, SDH" or NAME="format=cc" technically
	// validates as quoted but breaks naive splitters — strip defensively.
	s = strings.ReplaceAll(s, "\"", "")
	s = strings.ReplaceAll(s, "\n", "")
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, ",", " ")
	s = strings.ReplaceAll(s, "=", " ")
	return s
}

// boolYesNo returns "YES" or "NO" for HLS playlist attributes.
func boolYesNo(b bool) string {
	if b {
		return "YES"
	}
	return "NO"
}
