package streaming

// Tests for the fMP4 E-AC-3 audio-passthrough widening (follow-up to the
// 2026-06 streaming review, item M1's deferred audio work): with fMP4
// segments hls.js does not transmux, so MSE support — not the TS demuxer —
// is the audio gate, and E-AC-3 can be COPIED instead of being re-encoded to
// stereo AAC / AC-3 5.1.

import (
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// hlsjsDolbyCaps models a Dolby-capable hls.js client (macOS Safari, Windows
// Edge): MSE reports AC-3 and E-AC-3, so the frontend sends ac3 + eac3 +
// eac3_mse. fmp4 toggles the server-set segment-format field.
func hlsjsDolbyCaps(fmp4 bool) *ClientCaps {
	return &ClientCaps{
		VideoCodecs: map[string]bool{"h264": true, "h265": true, "hevc": true},
		AudioCodecs: map[string]bool{"aac": true, "mp3": true, "ac3": true, "eac3": true, "eac3_mse": true},
		Containers:  map[string]bool{"mp4_container": true},
		HLSNative:   true,
		HLSJS:       true,
		FMP4:        fmp4,
	}
}

// nativeDolbyCaps models a native-HLS-only client (pre-MSE iOS Safari) whose
// eac3 cap came from canPlayType — no eac3_mse, no hls_js.
func nativeDolbyCaps(fmp4 bool) *ClientCaps {
	return &ClientCaps{
		VideoCodecs: map[string]bool{"h264": true, "h265": true, "hevc": true},
		AudioCodecs: map[string]bool{"aac": true, "mp3": true, "ac3": true, "eac3": true},
		Containers:  map[string]bool{"mp4_container": true},
		HLSNative:   true,
		FMP4:        fmp4,
	}
}

func TestDecidePlayback_EAC3FMP4Passthrough(t *testing.T) {
	eac3Track := []models.AudioTrack{{Codec: "eac3", Channels: 6, IsDefault: true}}
	ac3Track := []models.AudioTrack{{Codec: "ac3", Channels: 6, IsDefault: true}}

	tests := []struct {
		name       string
		container  string
		videoCodec string
		audio      []models.AudioTrack
		caps       *ClientCaps
		wantDec    string
		wantCopy   bool
		wantCodec  string
	}{
		{
			// The headline case: MKV h264+eac3 on a Dolby-MSE client with
			// fMP4 segments → remux with the ORIGINAL surround track copied.
			name:      "hls.js Dolby + fMP4 + mkv h264 eac3 = remux, eac3 copied",
			container: "mkv", videoCodec: "h264", audio: eac3Track, caps: hlsjsDolbyCaps(true),
			wantDec: "direct_stream", wantCopy: true, wantCodec: "eac3",
		},
		{
			// Same client in TS mode: unchanged legacy behavior — hls.js
			// cannot demux E-AC-3 from MPEG-TS, so audio is re-encoded.
			name:      "hls.js Dolby + TS + mkv h264 eac3 = remux, audio recoded",
			container: "mkv", videoCodec: "h264", audio: eac3Track, caps: hlsjsDolbyCaps(false),
			wantDec: "direct_stream", wantCopy: false, wantCodec: "eac3",
		},
		{
			// eac3 cap WITHOUT eac3_mse (canPlayType-only, e.g. a browser
			// with a native Dolby decoder but no MSE support for it): the
			// hls.js fMP4 path feeds MSE, so copy must NOT happen.
			name:      "hls.js eac3-without-MSE + fMP4 = remux, audio recoded",
			container: "mkv", videoCodec: "h264", audio: eac3Track,
			caps: &ClientCaps{
				VideoCodecs: map[string]bool{"h264": true},
				AudioCodecs: map[string]bool{"aac": true, "eac3": true}, // no eac3_mse
				Containers:  map[string]bool{"mp4_container": true},
				HLSJS:       true,
				FMP4:        true,
			},
			wantDec: "direct_stream", wantCopy: false,
			// findBestAudioTrack under the restricted hls caps finds no
			// compatible track (eac3 dropped without eac3_mse) → the chosen
			// codec is still the default track's.
			wantCodec: "eac3",
		},
		{
			// Native-HLS-only client + fMP4: full caps apply (the native
			// player decodes, canPlayType is the right probe) → copy.
			name:      "native Dolby + fMP4 + mkv h264 eac3 = remux, eac3 copied",
			container: "mkv", videoCodec: "h264", audio: eac3Track, caps: nativeDolbyCaps(true),
			wantDec: "direct_stream", wantCopy: true, wantCodec: "eac3",
		},
		{
			// Native-HLS-only client in TS mode: E-AC-3 stays out of TS.
			name:      "native Dolby + TS + mkv h264 eac3 = remux, audio recoded",
			container: "mkv", videoCodec: "h264", audio: eac3Track, caps: nativeDolbyCaps(false),
			wantDec: "direct_stream", wantCopy: false, wantCodec: "eac3",
		},
		{
			// Full-transcode path (video unsupported → mkv VP9 forces a
			// transcode) + fMP4 + AC-3 source on an AC-3 client: the audio
			// rides along as a copy instead of a decode→re-encode cycle.
			name:      "hls.js Dolby + fMP4 + mkv vp9 ac3 = transcode, ac3 copied",
			container: "mkv", videoCodec: "vp9", audio: ac3Track, caps: hlsjsDolbyCaps(true),
			wantDec: "transcode", wantCopy: true, wantCodec: "ac3",
		},
		{
			// Same in TS mode: transcode masters advertise CODECS and the
			// historical TS pairing is AAC-only → re-encode (unchanged).
			name:      "hls.js Dolby + TS + mkv vp9 ac3 = transcode, audio recoded",
			container: "mkv", videoCodec: "vp9", audio: ac3Track, caps: hlsjsDolbyCaps(false),
			wantDec: "transcode", wantCopy: false, wantCodec: "ac3",
		},
		{
			// Direct play is untouched by the widening: mp4 h264+eac3 on a
			// Dolby client plays the file natively.
			name:      "hls.js Dolby + fMP4 + mp4 h264 eac3 = direct play",
			container: "mp4", videoCodec: "h264", audio: eac3Track, caps: hlsjsDolbyCaps(true),
			wantDec: "direct_play", wantCopy: true, wantCodec: "eac3",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pd := DecidePlayback(tt.container, tt.videoCodec, tt.audio, tt.caps)
			if pd.Decision != tt.wantDec {
				t.Errorf("Decision = %q, want %q (reason: %s)", pd.Decision, tt.wantDec, pd.TranscodeReason)
			}
			if pd.AudioPassthrough != tt.wantCopy {
				t.Errorf("AudioPassthrough = %v, want %v (reason: %s)", pd.AudioPassthrough, tt.wantCopy, pd.TranscodeReason)
			}
			if pd.AudioNeedsRecode == tt.wantCopy {
				t.Errorf("AudioNeedsRecode = %v inconsistent with passthrough %v", pd.AudioNeedsRecode, tt.wantCopy)
			}
			if pd.AudioCodec != tt.wantCodec {
				t.Errorf("AudioCodec = %q, want %q", pd.AudioCodec, tt.wantCodec)
			}
		})
	}
}

func TestParseClientCaps_EAC3MSE(t *testing.T) {
	caps := ParseClientCaps("h264,aac,eac3,eac3_mse,hls_js")
	if !caps.AudioCodecs["eac3"] {
		t.Error("eac3 cap not parsed")
	}
	if !caps.AudioCodecs["eac3_mse"] {
		t.Error("eac3_mse cap not parsed")
	}
	// Old-style caps string without the new key must not imply it.
	caps = ParseClientCaps("h264,aac,eac3")
	if caps.AudioCodecs["eac3_mse"] {
		t.Error("eac3_mse must not be inferred from eac3")
	}
}

func TestHLSCodecStringEAC3(t *testing.T) {
	got := hlsCodecString(1080, "eac3")
	if !strings.Contains(got, "ec-3") {
		t.Errorf("hlsCodecString(1080, eac3) = %q, want ec-3 audio part", got)
	}
	if strings.Contains(got, "mp4a") {
		t.Errorf("hlsCodecString(1080, eac3) = %q must not advertise AAC", got)
	}
	// ac3 and default mappings unchanged.
	if got := hlsCodecString(720, "ac3"); !strings.Contains(got, "ac-3") {
		t.Errorf("hlsCodecString(720, ac3) = %q, want ac-3", got)
	}
	if got := hlsCodecString(720, ""); !strings.Contains(got, "mp4a.40.2") {
		t.Errorf("hlsCodecString(720, \"\") = %q, want mp4a.40.2", got)
	}
}

func TestCastNeedsStereoCloneDolby(t *testing.T) {
	for codec, want := range map[string]bool{
		"ac3": true, "eac3": true, // Dolby — receiver support unprobeable
		"aac": false, "": false, // cast-safe
	} {
		if got := CastNeedsStereoClone(codec); got != want {
			t.Errorf("CastNeedsStereoClone(%q) = %v, want %v", codec, got, want)
		}
	}
}

// TestDecideStatic_TranscodeBranchMP3Recode pins the follow-up to review
// finding B3: the static TRANSCODE branches (plain + Hi10P) used to copy mp3
// while the remux branch re-encoded it — now every static HLS branch shares
// the AAC-only copy policy.
func TestDecideStatic_TranscodeBranchMP3Recode(t *testing.T) {
	// Unsupported video codec → static transcode branch, mp3 audio.
	pd := DecidePlayback("matroska", "mpeg4", aacLikeTracks("mp3"), nil)
	if pd.Decision != "transcode" {
		t.Fatalf("Decision = %q, want transcode", pd.Decision)
	}
	if pd.AudioPassthrough || !pd.AudioNeedsRecode {
		t.Error("static transcode must re-encode mp3, not copy it")
	}
	// Hi10P branch with mp3.
	pd = DecidePlayback("mp4", "h264", aacLikeTracks("mp3"), nil, "yuv420p10le")
	if pd.Decision != "transcode" {
		t.Fatalf("Hi10P Decision = %q, want transcode", pd.Decision)
	}
	if pd.AudioPassthrough || !pd.AudioNeedsRecode {
		t.Error("static Hi10P transcode must re-encode mp3, not copy it")
	}
	// AAC still copies on both branches.
	pd = DecidePlayback("matroska", "mpeg4", aacLikeTracks("aac"), nil)
	if !pd.AudioPassthrough {
		t.Error("static transcode should still copy AAC")
	}
}
