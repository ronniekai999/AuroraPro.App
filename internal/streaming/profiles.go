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
	CRF          int    `json:"-"` // Software encoder quality (ignored by HW encoders)
	// DeclaredVideoBPS is the hand-tuned VIDEO bits/sec this rung declares.
	// LadderBandwidth adds the session's audio cost to produce HLSBandwidth.
	DeclaredVideoBPS int    `json:"-"`
	HLSBandwidth     int    `json:"bandwidth"` // BANDWIDTH attribute: video + audio
	CodecString      string `json:"-"`         // HLS CODECS attribute; empty = omitted
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
// 2026-08 declared-bandwidth correction (August 2026 review follow-up).
//
// The rung figures below are unchanged and deliberately so. The one real defect
// was that they counted no audio at all — a re-encoded AAC stream adds 192 kbps
// and a copied surround track far more — so LadderBandwidth now adds the
// session's actual audio cost on top of them.
//
// An earlier version of this change also inflated the video figures to
// -maxrate x a VBV headroom factor, on the theory that BANDWIDTH must bound the
// true peak (RFC 8216 4.3.4.2) and that over-declaring was the safe direction.
// Reviewing the vendored hls.js showed both halves of that were wrong:
//
//	Level.maxBitrate  = max(realBitrate, bitrate)
//	Level.averageBitrate = _avgBitrate || realBitrate || bitrate
//
// The measured realBitrate can only RAISE maxBitrate, never lower it, so an
// under-declaration self-heals from the fragments the player has already
// downloaded while an over-declaration is permanent. And declaring
// AVERAGE-BANDWIDTH sets _avgBitrate, which SUPPRESSES realBitrate on the
// average path — so emitting it actively removes hls.js's ability to learn the
// real cost. It is therefore not emitted at all.
//
// The inflation also had a concrete cost. Aurora seeds hls.js with
// abrEwmaDefaultEstimate = 8 Mbps on a first-ever play (lib/streaming.ts), and
// start-level selection compares against maxBitrate. At 7.5M + 192k the 1080p
// rung still fits under that seed; at the inflated 10.99M it did not, so every
// first play, every private window and every play after a storage clear
// dropped a full rung.
//
// The empirical check in ladder_bitrate_test.go is kept: it is what caught the
// inflation being wrong in the first place, and it documents the real
// relationship between the rate cap and what segments actually reach.
var AllProfiles = map[string]QualityProfile{
	"2160p": {Name: "2160p", Width: 3840, Height: 2160, VideoBitrate: "16M", MaxRate: "18M", BufSize: "36M", CRF: 18, DeclaredVideoBPS: 18000000, HLSBandwidth: 18192000},
	"1080p": {Name: "1080p", Width: 1920, Height: 1080, VideoBitrate: "7M", MaxRate: "8M", BufSize: "16M", CRF: 20, DeclaredVideoBPS: 7500000, HLSBandwidth: 7692000},
	"720p":  {Name: "720p", Width: 1280, Height: 720, VideoBitrate: "4M", MaxRate: "5M", BufSize: "9M", CRF: 21, DeclaredVideoBPS: 4500000, HLSBandwidth: 4692000},
	"480p":  {Name: "480p", Width: 854, Height: 480, VideoBitrate: "2M", MaxRate: "2.5M", BufSize: "5M", CRF: 22, DeclaredVideoBPS: 2200000, HLSBandwidth: 2392000},
	"360p":  {Name: "360p", Width: 640, Height: 360, VideoBitrate: "1.2M", MaxRate: "1.5M", BufSize: "3M", CRF: 24, DeclaredVideoBPS: 1400000, HLSBandwidth: 1592000},
}

// --- Declared-bandwidth arithmetic ---

// Re-encode audio bitrates, mirroring audioEncodeArgs in streaming.go: stereo
// AAC at 192k, AC-3 surround at 448k. Kept as constants here so the declared
// bandwidth and the actual encoder flags cannot drift apart silently.
const (
	aacReencodeBitsPerSec = 192_000
	ac3ReencodeBitsPerSec = 448_000
)

// Copied audio has no separately declared figure.
//
// An earlier version used per-codec passthrough CEILINGS (AAC/AC-3 640k,
// E-AC-3 768k) on a "never under-declare" instinct. That instinct is wrong
// here, and the ceilings reintroduced the exact regression the ladder revert
// existed to undo: 1080p + 640k is 8,140,000, above the 8 Mbps first-play
// bandwidth estimate, so every first play of the most common transcode shape
// there is — non-H.264 video with a copied AAC track — dropped to 720p and,
// because Level.maxBitrate only ever rises, never came back.
//
// Under-declaring is the safe direction: hls.js raises maxBitrate from the
// fragments it has already fetched, so a low figure self-corrects within a few
// segments, while a high one is permanent. Copied audio therefore declares the
// same figure its re-encoded equivalent would.

// AudioDeclaredBitrate returns the bits/sec to attribute to a session's audio
// when declaring playlist bandwidth. codecOut is the session's AudioCodecOut
// ("", "aac", "ac3", "eac3").
//
// passthrough is accepted but does not change the answer — see the constants
// above for why a copied track is not declared higher than a re-encoded one.
func AudioDeclaredBitrate(codecOut string, passthrough bool) int {
	switch strings.ToLower(codecOut) {
	case "ac3", "eac3":
		return ac3ReencodeBitsPerSec
	default:
		return aacReencodeBitsPerSec
	}
}

// LadderBandwidth returns the BANDWIDTH value to declare for this profile,
// given the session's audio cost in bits/sec.
//
// Only a peak is returned; AVERAGE-BANDWIDTH is deliberately not emitted (see
// the block comment above AllProfiles — declaring it suppresses hls.js's own
// measured realBitrate).
//
// A profile with no declared video figure (the synthetic "source" profile used
// for remux) keeps whatever it already had.
func (p QualityProfile) LadderBandwidth(audioBitsPerSec int) int {
	if p.DeclaredVideoBPS <= 0 {
		return p.HLSBandwidth
	}
	if audioBitsPerSec < 0 {
		audioBitsPerSec = 0
	}
	return p.DeclaredVideoBPS + audioBitsPerSec
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

// capLadder drops the rungs whose declared bandwidth (video plus the session's
// audio cost) exceeds the client's bitrate ceiling. maxBitrate <= 0 means no
// ceiling. At least the lowest rung is always kept: a ceiling below the whole
// ladder still has to play something, and the smallest rung is the best the
// server can do for it. Profiles arrive highest-first (ProfileOrder), so the
// lowest rung is the last entry.
func capLadder(profiles []QualityProfile, maxBitrate int64, audioBitsPerSec int) []QualityProfile {
	if maxBitrate <= 0 || len(profiles) == 0 {
		return profiles
	}
	kept := make([]QualityProfile, 0, len(profiles))
	for _, p := range profiles {
		if int64(p.LadderBandwidth(audioBitsPerSec)) <= maxBitrate {
			kept = append(kept, p)
		}
	}
	if len(kept) == 0 {
		kept = append(kept, profiles[len(profiles)-1])
	}
	return kept
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
		if p.CodecString != "" {
			out += fmt.Sprintf("#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d,CODECS=\"%s\",NAME=\"%s\"%s\n",
				p.HLSBandwidth, p.Width, p.Height, p.CodecString, p.Name, subsAttr)
		} else {
			out += fmt.Sprintf("#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d,NAME=\"%s\"%s\n",
				p.HLSBandwidth, p.Width, p.Height, p.Name, subsAttr)
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
