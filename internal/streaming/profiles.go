package streaming

import (
	"fmt"
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
	CRF          int    `json:"-"`           // Software encoder quality (ignored by HW encoders)
	HLSBandwidth int    `json:"bandwidth"`   // Declared bandwidth in master playlist (bits/sec)
	CodecString  string `json:"-"`           // HLS CODECS attribute (e.g., "avc1.420028,mp4a.40.2"); empty = omitted
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
var AllProfiles = map[string]QualityProfile{
	"2160p": {Name: "2160p", Width: 3840, Height: 2160, VideoBitrate: "16M", MaxRate: "18M", BufSize: "36M", CRF: 18, HLSBandwidth: 18000000},
	"1080p": {Name: "1080p", Width: 1920, Height: 1080, VideoBitrate: "7M", MaxRate: "8M", BufSize: "16M", CRF: 20, HLSBandwidth: 7500000},
	"720p":  {Name: "720p", Width: 1280, Height: 720, VideoBitrate: "4M", MaxRate: "5M", BufSize: "9M", CRF: 21, HLSBandwidth: 4500000},
	"480p":  {Name: "480p", Width: 854, Height: 480, VideoBitrate: "2M", MaxRate: "2.5M", BufSize: "5M", CRF: 22, HLSBandwidth: 2200000},
	"360p":  {Name: "360p", Width: 640, Height: 360, VideoBitrate: "1.2M", MaxRate: "1.5M", BufSize: "3M", CRF: 24, HLSBandwidth: 1400000},
}

// ProfileOrder is highest to lowest quality.
var ProfileOrder = []string{"2160p", "1080p", "720p", "480p", "360p"}

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
		if p.Width > sourceWidth {
			continue
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
