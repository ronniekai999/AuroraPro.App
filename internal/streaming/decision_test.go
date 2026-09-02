package streaming

import (
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

func TestNormalizeContainer(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"matroska", "mkv"},
		{"MATROSKA", "mkv"},
		{"mov", "mp4"},
		{"mp4", "mp4"},
		{"webm", "webm"},
		{"avi", "avi"},
		{"mpegts", "ts"},
		{"ogg", "ogg"},
		{"flv", "flv"},                     // unknown → as-is
		{"  Mov  ", "mp4"},                 // whitespace trimmed
		{"", ""},                           // empty
		{"mov,mp4,m4a,3gp,3g2,mj2", "mp4"}, // comma-separated FFprobe format → first element
		{"matroska,webm", "mkv"},           // comma-separated with known alias
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := NormalizeContainer(tt.input)
			if got != tt.want {
				t.Errorf("NormalizeContainer(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestParseClientCaps(t *testing.T) {
	t.Run("full chrome profile", func(t *testing.T) {
		caps := ParseClientCaps("h264,vp9,av1,aac,mp3,opus,mp4_container,webm_container,hls_js")
		if !caps.VideoCodecs["h264"] {
			t.Error("expected h264 video support")
		}
		if !caps.VideoCodecs["vp9"] {
			t.Error("expected vp9 video support")
		}
		if !caps.AudioCodecs["aac"] {
			t.Error("expected aac audio support")
		}
		if !caps.Containers["mp4_container"] {
			t.Error("expected mp4_container support")
		}
		if !caps.HLSJS {
			t.Error("expected hls_js support")
		}
		if caps.HLSNative {
			t.Error("expected no hls_native for Chrome")
		}
	})

	t.Run("safari profile with hevc", func(t *testing.T) {
		caps := ParseClientCaps("h264,h265,aac,ac3,eac3,mp4_container,hls_native")
		if !caps.VideoCodecs["h265"] {
			t.Error("expected h265 video support")
		}
		// h265 and hevc should be synced
		if !caps.VideoCodecs["hevc"] {
			t.Error("expected hevc alias synced from h265")
		}
		if !caps.AudioCodecs["ac3"] {
			t.Error("expected ac3 audio support")
		}
		if !caps.HLSNative {
			t.Error("expected hls_native for Safari")
		}
	})

	t.Run("empty string", func(t *testing.T) {
		caps := ParseClientCaps("")
		if len(caps.VideoCodecs) != 0 || len(caps.AudioCodecs) != 0 {
			t.Error("expected empty caps from empty string")
		}
	})

	t.Run("unknown keys ignored", func(t *testing.T) {
		caps := ParseClientCaps("h264,unknowncodec,future_feature,aac")
		if !caps.VideoCodecs["h264"] {
			t.Error("expected h264")
		}
		if !caps.AudioCodecs["aac"] {
			t.Error("expected aac")
		}
		if len(caps.VideoCodecs) != 1 {
			t.Errorf("expected 1 video codec, got %d", len(caps.VideoCodecs))
		}
	})
}

func TestDecidePlayback(t *testing.T) {
	// Helper to build client caps
	chromeCaps := &ClientCaps{
		VideoCodecs: map[string]bool{"h264": true, "vp9": true, "av1": true},
		AudioCodecs: map[string]bool{"aac": true, "mp3": true, "opus": true},
		Containers:  map[string]bool{"mp4_container": true, "webm_container": true},
		HLSJS:       true,
	}
	// Chrome on macOS with hardware HEVC decoding — reports h265 support via
	// MediaSource.isTypeSupported and uses HLS.js for HLS playback. HLS.js v1.6+
	// can demux HEVC NAL units from .ts segments, so HEVC remux (copy + BSF) is safe.
	chromeHEVCCaps := &ClientCaps{
		VideoCodecs: map[string]bool{"h264": true, "h265": true, "hevc": true, "vp9": true, "av1": true},
		AudioCodecs: map[string]bool{"aac": true, "mp3": true, "opus": true},
		Containers:  map[string]bool{"mp4_container": true, "webm_container": true},
		HLSJS:       true,
	}
	// iOS Safari (pre-17.1): only native HLS, no HLS.js (Hls.isSupported()
	// = false, no MSE/ManagedMediaSource). Apple's HLS Authoring Spec
	// requires HEVC to be in fMP4 segments — AVPlayer does NOT play
	// HEVC-in-TS — so HEVC remux for this client is only legal when the
	// server emits fMP4 (ClientCaps.FMP4, set server-side).
	safariCaps := &ClientCaps{
		VideoCodecs: map[string]bool{"h264": true, "h265": true, "hevc": true},
		AudioCodecs: map[string]bool{"aac": true, "mp3": true, "ac3": true, "eac3": true},
		Containers:  map[string]bool{"mp4_container": true},
		HLSNative:   true,
	}
	// Same client, but the server is in fMP4 (CMAF) segment mode — the
	// default since the 2026-06 review. HEVC remux becomes legal.
	safariFMP4Caps := &ClientCaps{
		VideoCodecs: map[string]bool{"h264": true, "h265": true, "hevc": true},
		AudioCodecs: map[string]bool{"aac": true, "mp3": true, "ac3": true, "eac3": true},
		Containers:  map[string]bool{"mp4_container": true},
		HLSNative:   true,
		FMP4:        true,
	}
	// macOS Safari: BOTH HLS.js and native HLS available. The frontend uses
	// HLS.js whenever Hls.isSupported() is true, so remux/transcode paths
	// go through HLS.js. HLS.js v1.6+ can demux HEVC and AAC/MP3 from .ts;
	// AC-3 demux is CONDITIONAL on MediaSource.isTypeSupported('audio/mp4;
	// codecs="ac-3"') — hls.js silently drops AC-3 otherwise — which is why the
	// frontend derives the "ac3" cap from isTypeSupported only (not canPlayType).
	// EAC3 passthrough is unsafe for HLS.js paths, but direct play (MP4 served
	// natively) is fine.
	macSafariCaps := &ClientCaps{
		VideoCodecs: map[string]bool{"h264": true, "h265": true, "hevc": true},
		AudioCodecs: map[string]bool{"aac": true, "mp3": true, "ac3": true, "eac3": true},
		Containers:  map[string]bool{"mp4_container": true},
		HLSNative:   true,
		HLSJS:       true,
	}

	aacTrack := []models.AudioTrack{{Codec: "aac", Channels: 2, IsDefault: true}}
	// AAC track with no explicit default flag (common from mkvmerge).
	// Should be treated as effectively default since it's the only/first track.
	aacTrackNoDefault := []models.AudioTrack{{Codec: "aac", Channels: 2, IsDefault: false}}
	dtsTrack := []models.AudioTrack{{Codec: "dts", Channels: 6, IsDefault: true}}
	dtsAndAac := []models.AudioTrack{
		{Codec: "dts", Channels: 6, IsDefault: true},
		{Codec: "aac", Channels: 2, IsDefault: false},
	}
	ac3Track := []models.AudioTrack{{Codec: "ac3", Channels: 6, IsDefault: true}}
	eac3AndAac := []models.AudioTrack{
		{Codec: "eac3", Channels: 6, IsDefault: true},
		{Codec: "aac", Channels: 2, IsDefault: false},
	}
	eac3Only := []models.AudioTrack{{Codec: "eac3", Channels: 6, IsDefault: true}}
	mp3Track := []models.AudioTrack{{Codec: "mp3", Channels: 2, IsDefault: true}}

	tests := []struct {
		name       string
		container  string
		videoCodec string
		audio      []models.AudioTrack
		caps       *ClientCaps
		pixFmt     string // optional: video pixel format for 10-bit detection
		wantDec    string
		wantRemux  bool
		wantAudioP bool
		wantIdx    int
	}{
		{
			name:      "nil caps backward compat - mp4 h264 aac",
			container: "mp4", videoCodec: "h264", audio: aacTrack, caps: nil,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: -1,
		},
		{
			name:      "nil caps backward compat - mkv h264 aac",
			container: "mkv", videoCodec: "h264", audio: aacTrack, caps: nil,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: -1,
		},
		{
			name:      "nil caps backward compat - mp4 hevc aac",
			container: "mp4", videoCodec: "hevc", audio: aacTrack, caps: nil,
			wantDec: "transcode", wantRemux: false, wantAudioP: true, wantIdx: -1,
		},
		{
			name:      "chrome + mp4 h264 aac = direct play",
			container: "mp4", videoCodec: "h264", audio: aacTrack, caps: chromeCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			name:      "chrome + mkv h264 aac = remux",
			container: "mkv", videoCodec: "h264", audio: aacTrack, caps: chromeCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 0,
		},
		{
			name:      "chrome + mp4 hevc aac = transcode",
			container: "mp4", videoCodec: "hevc", audio: aacTrack, caps: chromeCaps,
			wantDec: "transcode", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			name:      "safari + mp4 hevc aac = direct play (HEVC on Safari!)",
			container: "mp4", videoCodec: "hevc", audio: aacTrack, caps: safariCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			name:      "safari + mp4 h265 aac = direct play (h265 alias)",
			container: "mp4", videoCodec: "h265", audio: aacTrack, caps: safariCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// fMP4 caps: HEVC remux for a native-HLS client is only legal
			// with fMP4 segments (B2) — this case exercises the container-
			// remux mechanics, not the segment-format gate.
			name:      "safari + mkv hevc aac = remux (container not supported)",
			container: "mkv", videoCodec: "hevc", audio: aacTrack, caps: safariFMP4Caps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 0,
		},
		{
			name:      "chrome + mp4 h264 dts = remux for audio",
			container: "mp4", videoCodec: "h264", audio: dtsTrack, caps: chromeCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: false, wantIdx: 0,
		},
		{
			// BUG FIX: was incorrectly "direct_play" — browser always plays the
			// default track (DTS, index 0). It can't select the AAC track at
			// index 1. Must remux with -map to select the compatible track.
			name:      "chrome + mp4 h264 dts+aac = remux to select aac track",
			container: "mp4", videoCodec: "h264", audio: dtsAndAac, caps: chromeCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 1,
		},
		{
			name:      "safari + mp4 h264 ac3 = direct play (Safari supports AC3)",
			container: "mp4", videoCodec: "h264", audio: ac3Track, caps: safariCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			name:      "chrome + mp4 h264 ac3 = remux for audio (Chrome no AC3)",
			container: "mp4", videoCodec: "h264", audio: ac3Track, caps: chromeCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: false, wantIdx: 0,
		},
		{
			name:      "matroska container normalized to mkv",
			container: "matroska", videoCodec: "h264", audio: aacTrack, caps: chromeCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 0,
		},
		{
			name:      "mov container normalized to mp4",
			container: "mov", videoCodec: "h264", audio: aacTrack, caps: chromeCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			name:      "chrome + webm vp9 opus = direct play",
			container: "webm", videoCodec: "vp9", audio: []models.AudioTrack{{Codec: "opus", IsDefault: true}}, caps: chromeCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		// Edge cases for audit coverage
		{
			// Silent video (no audio tracks) should direct play when video+container are OK.
			name:      "empty audio tracks with caps = direct play (silent video)",
			container: "mp4", videoCodec: "h264", audio: nil, caps: chromeCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: -1,
		},
		{
			name:      "nil caps backward compat - empty audio = direct play",
			container: "mp4", videoCodec: "h264", audio: nil, caps: nil,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: -1,
		},
		{
			name:      "avc video codec alias with caps",
			container: "mp4", videoCodec: "avc", audio: aacTrack, caps: chromeCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			name:      "avc1 video codec alias with caps",
			container: "mp4", videoCodec: "avc1", audio: aacTrack, caps: chromeCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			name:      "unknown container with caps = remux",
			container: "avi", videoCodec: "h264", audio: aacTrack, caps: chromeCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 0,
		},
		{
			// fMP4 caps: see the B2 gate — HEVC remux needs fMP4 for a
			// native-only client; this case tests audio-track selection.
			name:      "safari + mkv hevc dts+aac = remux, picks aac track",
			container: "mkv", videoCodec: "hevc", audio: dtsAndAac, caps: safariFMP4Caps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 1,
		},
		{
			name:      "chrome + mp4 h264 multiple incompatible tracks",
			container: "mp4", videoCodec: "h264",
			audio: []models.AudioTrack{
				{Codec: "dts", Channels: 6, IsDefault: true},
				{Codec: "truehd", Channels: 8, IsDefault: false},
			}, caps: chromeCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: false, wantIdx: 0,
		},
		{
			name:      "chrome + mkv h264 dts+aac = remux, picks compatible aac",
			container: "mkv", videoCodec: "h264", audio: dtsAndAac, caps: chromeCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 1,
		},
		// EAC3-specific test cases (Chrome EAC3 bug fix)
		{
			// Chrome doesn't support EAC3. Single EAC3 track → remux + transcode audio to AAC.
			name:      "chrome + mp4 h264 eac3 = remux for audio (Chrome no EAC3)",
			container: "mp4", videoCodec: "h264", audio: eac3Only, caps: chromeCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: false, wantIdx: 0,
		},
		{
			// Chrome doesn't support EAC3. EAC3 is default, AAC is secondary.
			// Browser would play default EAC3 track in direct play → garbled audio.
			// Must remux to select AAC track via -map.
			name:      "chrome + mp4 h264 eac3+aac = remux to select aac (not direct play)",
			container: "mp4", videoCodec: "h264", audio: eac3AndAac, caps: chromeCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 1,
		},
		{
			// Safari supports EAC3 natively. Single EAC3 default track → direct play.
			name:      "safari + mp4 h264 eac3 = direct play (Safari supports EAC3)",
			container: "mp4", videoCodec: "h264", audio: eac3Only, caps: safariCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// Safari supports EAC3. EAC3 is default → direct play (browser picks it).
			name:      "safari + mp4 h264 eac3+aac = direct play (default eac3 ok on Safari)",
			container: "mp4", videoCodec: "h264", audio: eac3AndAac, caps: safariCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		// ── H.264 10-bit (Hi10P) guard: browsers reject via MSE ──
		{
			// H.264 10-bit in MKV: normally would be remux (h264 in MKV), but 10-bit
			// pixel format forces full transcode to 8-bit H.264.
			name:      "chrome + mkv h264 10-bit aac = transcode (Hi10P guard)",
			container: "mkv", videoCodec: "h264", audio: aacTrack, caps: chromeCaps,
			pixFmt:  "yuv420p10le",
			wantDec: "transcode", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// H.264 10-bit in MP4: normally would be direct play, but 10-bit forces transcode.
			name:      "chrome + mp4 h264 10-bit aac = transcode (Hi10P guard, even in MP4)",
			container: "mp4", videoCodec: "h264", audio: aacTrack, caps: chromeCaps,
			pixFmt:  "yuv420p10le",
			wantDec: "transcode", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// H.264 8-bit (normal yuv420p): should still direct play normally.
			name:      "chrome + mp4 h264 8-bit aac = direct play (normal, yuv420p)",
			container: "mp4", videoCodec: "h264", audio: aacTrack, caps: chromeCaps,
			pixFmt:  "yuv420p",
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// H.264 with empty pixFmt (legacy data): should still work as before.
			name:      "chrome + mp4 h264 empty pixfmt aac = direct play (backward compat)",
			container: "mp4", videoCodec: "h264", audio: aacTrack, caps: chromeCaps,
			pixFmt:  "",
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// H.264 10-bit with nil caps (static fallback): should still force transcode.
			name:      "nil caps + mp4 h264 10-bit aac = transcode (static fallback Hi10P guard)",
			container: "mp4", videoCodec: "h264", audio: aacTrack, caps: nil,
			pixFmt:  "yuv420p10le",
			wantDec: "transcode", wantRemux: false, wantAudioP: true, wantIdx: -1,
		},
		{
			// H.264 10-bit with 422 chroma: also 10-bit, should transcode.
			name:      "chrome + mkv h264 yuv422p10le aac = transcode (Hi10P 4:2:2)",
			container: "mkv", videoCodec: "h264", audio: aacTrack, caps: chromeCaps,
			pixFmt:  "yuv422p10le",
			wantDec: "transcode", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// Safari + H.264 10-bit: Safari also cannot play H.264 10-bit via MSE.
			name:      "safari + mp4 h264 10-bit aac = transcode (Hi10P on Safari too)",
			container: "mp4", videoCodec: "h264", audio: aacTrack, caps: safariCaps,
			pixFmt:  "yuv420p10le",
			wantDec: "transcode", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		// ── HEVC remux: HLS.js v1.6+ can demux HEVC from .ts segments ──
		{
			// Chrome with HEVC support + MKV HEVC: remux with hevc_mp4toannexb BSF.
			// HLS.js v1.6+ transmuxes HEVC .ts → fMP4 for MSE. Near-zero CPU.
			name:      "chromeHEVC + mkv hevc aac = remux (HEVC .ts via HLS.js v1.6+)",
			container: "mkv", videoCodec: "hevc", audio: aacTrack, caps: chromeHEVCCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 0,
		},
		{
			// Chrome with HEVC support + MP4 HEVC AAC: direct play is fine (no HLS.js
			// involved — browser plays MP4 natively via MSE).
			name:      "chromeHEVC + mp4 hevc aac = direct play (no HLS.js needed)",
			container: "mp4", videoCodec: "hevc", audio: aacTrack, caps: chromeHEVCCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// Chrome with HEVC support + MKV HEVC EAC3: remux with audio transcode.
			// Video is copied (HEVC in .ts works with HLS.js v1.6+), audio EAC3→AAC.
			name:      "chromeHEVC + mkv hevc eac3 = remux, audio transcode",
			container: "mkv", videoCodec: "hevc", audio: eac3Only, caps: chromeHEVCCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: false, wantIdx: 0,
		},
		{
			// Chrome with HEVC support + MP4 HEVC, non-default audio track: remux
			// to select compatible AAC track via -map.
			name:      "chromeHEVC + mp4 hevc dts+aac = remux to select aac track",
			container: "mp4", videoCodec: "hevc", audio: dtsAndAac, caps: chromeHEVCCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 1,
		},
		{
			// Safari (native HLS only) + MKV HEVC in MPEG-TS mode: Apple's
			// authoring spec requires HEVC in fMP4 — AVPlayer rejects
			// HEVC-in-TS, and with no hls.js there is no error-fallback.
			// Must transcode. (Review 2026-06 finding B2 — this case
			// previously asserted remux.)
			name:      "safari + mkv hevc aac + TS segments = transcode (HEVC-in-TS illegal for native HLS)",
			container: "mkv", videoCodec: "hevc", audio: aacTrack, caps: safariCaps,
			wantDec: "transcode", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// Same client, fMP4 segment mode: HEVC remux is legal and cheap.
			name:      "safari + mkv hevc aac + fMP4 segments = remux",
			container: "mkv", videoCodec: "hevc", audio: aacTrack, caps: safariFMP4Caps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 0,
		},
		{
			// Chrome WITHOUT HEVC support + MKV HEVC: videoOK is false →
			// transcode to H.264 (client can't play HEVC at all).
			name:      "chrome (no HEVC) + mkv hevc aac = transcode (no HEVC support)",
			container: "mkv", videoCodec: "hevc", audio: aacTrack, caps: chromeCaps,
			wantDec: "transcode", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// h265 alias: same behavior as hevc — remux with BSF.
			name:      "chromeHEVC + mkv h265 aac = remux (h265 alias)",
			container: "mkv", videoCodec: "h265", audio: aacTrack, caps: chromeHEVCCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 0,
		},
		{
			// Chrome HEVC + MP4 HEVC + EAC3 audio: can't direct play (EAC3 not
			// supported on Chrome). Must remux for audio transcode.
			name:      "chromeHEVC + mp4 hevc eac3 = remux, audio recode",
			container: "mp4", videoCodec: "hevc", audio: eac3Only, caps: chromeHEVCCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: false, wantIdx: 0,
		},
		// ── No explicit default track: treat first track as effective default ──
		{
			// MP4 + H.264 + AAC (no default flag): should still direct play.
			// Before fix, this forced an unnecessary remux.
			name:      "chrome + mp4 h264 aac (no default flag) = direct play",
			container: "mp4", videoCodec: "h264", audio: aacTrackNoDefault, caps: chromeCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// MKV + H.264 + AAC (no default flag): remux for container, audio passthrough.
			name:      "chrome + mkv h264 aac (no default flag) = remux",
			container: "mkv", videoCodec: "h264", audio: aacTrackNoDefault, caps: chromeCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 0,
		},
		// ── macOS Safari: HLSJS=true + HLSNative=true ──
		// The frontend uses HLS.js (not native) for remux/transcode. HLS.js v1.6+
		// can demux HEVC from .ts, but cannot demux EAC3 from .ts.
		// Direct play bypasses HLS.js entirely.
		{
			// macOS Safari + MP4 H.264 + EAC3: direct play is fine (browser plays natively).
			name:      "macSafari + mp4 h264 eac3 = direct play (native, no HLS.js)",
			container: "mp4", videoCodec: "h264", audio: eac3Only, caps: macSafariCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// macOS Safari + MKV H.264 + EAC3: must remux (MKV container), but EAC3
			// cannot be passthrough into .ts for HLS.js → audio transcoded to AAC.
			name:      "macSafari + mkv h264 eac3 = remux, audio transcode (HLS.js can't demux EAC3 from .ts)",
			container: "mkv", videoCodec: "h264", audio: eac3Only, caps: macSafariCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: false, wantIdx: 0,
		},
		{
			// macOS Safari + MKV HEVC + AAC: HLSJS=true, HLS.js v1.6+ handles HEVC .ts
			// → remux with hevc_mp4toannexb BSF. Near-zero CPU.
			name:      "macSafari + mkv hevc aac = remux (HLS.js v1.6+ handles HEVC .ts)",
			container: "mkv", videoCodec: "hevc", audio: aacTrack, caps: macSafariCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 0,
		},
		{
			// macOS Safari + MP4 HEVC + AAC: direct play (no HLS.js involved).
			name:      "macSafari + mp4 hevc aac = direct play (native, no HLS.js)",
			container: "mp4", videoCodec: "hevc", audio: aacTrack, caps: macSafariCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// macOS Safari + MKV H.264 + EAC3+AAC: remux (MKV container), picks AAC
			// track (the only one HLS.js can handle in .ts), passthrough.
			name:      "macSafari + mkv h264 eac3+aac = remux, picks aac track (HLS.js safe)",
			container: "mkv", videoCodec: "h264", audio: eac3AndAac, caps: macSafariCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: true, wantIdx: 1,
		},
		{
			// macOS Safari + MP4 H.264 + EAC3+AAC: direct play (EAC3 is default, browser handles it natively).
			name:      "macSafari + mp4 h264 eac3+aac = direct play (default eac3 ok natively)",
			container: "mp4", videoCodec: "h264", audio: eac3AndAac, caps: macSafariCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// macOS Safari + MKV HEVC + EAC3: HEVC remux is fine (HLS.js v1.6+), but
			// EAC3 is not HLS.js-safe → remux with audio transcode (EAC3→AAC).
			name:      "macSafari + mkv hevc eac3 = remux, audio transcode (EAC3 unsafe for HLS.js)",
			container: "mkv", videoCodec: "hevc", audio: eac3Only, caps: macSafariCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: false, wantIdx: 0,
		},
		// ── VP9/AV1 remux guard: HLS.js TS demuxer cannot handle these codecs ──
		{
			// Chrome + MKV VP9 + AAC: VP9 in .ts is unplayable by HLS.js → full transcode.
			name:      "chrome + mkv vp9 aac = transcode (VP9 not viable in .ts)",
			container: "mkv", videoCodec: "vp9", audio: aacTrack, caps: chromeCaps,
			wantDec: "transcode", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// Chrome + MKV AV1 + AAC: AV1 in .ts is unplayable by HLS.js → full transcode.
			name:      "chrome + mkv av1 aac = transcode (AV1 not viable in .ts)",
			container: "mkv", videoCodec: "av1", audio: aacTrack, caps: chromeCaps,
			wantDec: "transcode", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// Chrome + WebM VP9 + Opus: native WebM → direct play (no .ts involved).
			name:      "chrome + webm vp9 opus = direct play (native WebM, no .ts)",
			container: "webm", videoCodec: "vp9", audio: []models.AudioTrack{{Codec: "opus", IsDefault: true}}, caps: chromeCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// Chrome + MKV VP8 + AAC: VP8 in .ts also unplayable → full transcode.
			name:      "chrome + mkv vp8 aac = transcode (VP8 not viable in .ts)",
			container: "mkv", videoCodec: "vp8", audio: aacTrack,
			caps: &ClientCaps{
				VideoCodecs: map[string]bool{"h264": true, "vp8": true, "vp9": true},
				AudioCodecs: map[string]bool{"aac": true, "mp3": true},
				Containers:  map[string]bool{"mp4_container": true, "webm_container": true},
				HLSJS:       true,
			},
			wantDec: "transcode", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// Safari iOS (no HLS.js) + MKV VP9: VP9 not in Safari caps → transcode
			// (but importantly, the .ts guard is irrelevant since HLSJS=false).
			name:      "safari + mkv vp9 aac = transcode (Safari has no VP9 support)",
			container: "mkv", videoCodec: "vp9", audio: aacTrack, caps: safariCaps,
			wantDec: "transcode", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		// ── MP3-source safety: mp3-in-.ts passthrough was causing HLS.js
		// `bufferAppendError` because the master playlist advertises
		// mp4a.40.2 (AAC-LC). Force AAC re-encode whenever the source is MP3
		// in any HLS path (remux or transcode). Direct play is fine because
		// the browser plays the original file natively and sees real headers.
		{
			// Gangland repro: MPEG-4 Part 2 video + MP3 audio in MKV. Video
			// forces full transcode (Chrome can't decode mpeg4), and audio
			// MUST be re-encoded to AAC to match the advertised codec string.
			name:      "chrome + mkv mpeg4 mp3 = transcode, audio recoded (Gangland bug)",
			container: "mkv", videoCodec: "mpeg4", audio: mp3Track, caps: chromeCaps,
			wantDec: "transcode", wantRemux: false, wantAudioP: false, wantIdx: 0,
		},
		{
			// H.264 + MP3 in MKV: video could be remuxed, but MP3 passthrough
			// into .ts is unsafe (Safari decode, hls.js framing). Remux+recode.
			name:      "chrome + mkv h264 mp3 = remux, audio recoded (mp3 not ts-safe)",
			container: "mkv", videoCodec: "h264", audio: mp3Track, caps: chromeCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: false, wantIdx: 0,
		},
		{
			// H.264 + MP3 in MP4 on Chrome (browser has MP3 caps): direct play
			// is still correct — the browser plays the MP4 natively, no HLS
			// pipeline involved, so the ts-safety concern doesn't apply.
			name:      "chrome + mp4 h264 mp3 = direct play (native, no HLS)",
			container: "mp4", videoCodec: "h264", audio: mp3Track, caps: chromeCaps,
			wantDec: "direct_play", wantRemux: false, wantAudioP: true, wantIdx: 0,
		},
		{
			// HEVC + MP3 on a client without HEVC support: full transcode.
			// Audio MP3 → AAC recode to match manifest.
			name:      "chrome (no HEVC) + mkv hevc mp3 = transcode, audio recoded",
			container: "mkv", videoCodec: "hevc", audio: mp3Track, caps: chromeCaps,
			wantDec: "transcode", wantRemux: false, wantAudioP: false, wantIdx: 0,
		},
		{
			// Safari (native HLS, HLSJS=false) + MKV H.264 + MP3: HLSNative
			// path also benefits from AAC recode — Safari's native HLS is
			// strict about mp3-in-ts depending on OS version.
			name:      "safari + mkv h264 mp3 = remux, audio recoded (mp3 unsafe in .ts)",
			container: "mkv", videoCodec: "h264", audio: mp3Track, caps: safariCaps,
			wantDec: "direct_stream", wantRemux: true, wantAudioP: false, wantIdx: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pd := DecidePlayback(tt.container, tt.videoCodec, tt.audio, tt.caps, tt.pixFmt)
			if pd.Decision != tt.wantDec {
				t.Errorf("Decision = %q, want %q (reason: %s)", pd.Decision, tt.wantDec, pd.TranscodeReason)
			}
			if pd.Remux != tt.wantRemux {
				t.Errorf("Remux = %v, want %v", pd.Remux, tt.wantRemux)
			}
			if pd.AudioPassthrough != tt.wantAudioP {
				t.Errorf("AudioPassthrough = %v, want %v", pd.AudioPassthrough, tt.wantAudioP)
			}
			if pd.AudioTrackIndex != tt.wantIdx {
				t.Errorf("AudioTrackIndex = %d, want %d", pd.AudioTrackIndex, tt.wantIdx)
			}
		})
	}
}

func TestFindBestAudioTrack(t *testing.T) {
	caps := &ClientCaps{
		AudioCodecs: map[string]bool{"aac": true, "mp3": true, "opus": true},
	}

	tests := []struct {
		name        string
		tracks      []models.AudioTrack
		wantIdx     int
		wantCodec   string
		wantCompat  bool
		wantDefault bool
	}{
		{
			name:       "empty tracks (silent video = compatible)",
			tracks:     nil,
			wantIdx:    -1,
			wantCodec:  "",
			wantCompat: true, wantDefault: true,
		},
		{
			name:    "single compatible default",
			tracks:  []models.AudioTrack{{Codec: "aac", IsDefault: true}},
			wantIdx: 0, wantCodec: "aac", wantCompat: true, wantDefault: true,
		},
		{
			name: "incompatible default, compatible secondary",
			tracks: []models.AudioTrack{
				{Codec: "dts", IsDefault: true},
				{Codec: "aac", IsDefault: false},
			},
			wantIdx: 1, wantCodec: "aac", wantCompat: true, wantDefault: false,
		},
		{
			name: "all incompatible, returns default",
			tracks: []models.AudioTrack{
				{Codec: "dts", IsDefault: true},
				{Codec: "truehd", IsDefault: false},
			},
			wantIdx: 0, wantCodec: "dts", wantCompat: false, wantDefault: true,
		},
		{
			name: "all incompatible no default, returns first",
			tracks: []models.AudioTrack{
				{Codec: "dts", IsDefault: false},
				{Codec: "truehd", IsDefault: false},
			},
			wantIdx: 0, wantCodec: "dts", wantCompat: false, wantDefault: true,
		},
		{
			name: "compatible default preferred over compatible non-default",
			tracks: []models.AudioTrack{
				{Codec: "opus", IsDefault: false},
				{Codec: "aac", IsDefault: true},
			},
			wantIdx: 1, wantCodec: "aac", wantCompat: true, wantDefault: true,
		},
		{
			// EAC3 default + AAC secondary on Chrome caps (no EAC3 support)
			name: "eac3 default + aac secondary on Chrome",
			tracks: []models.AudioTrack{
				{Codec: "eac3", IsDefault: true},
				{Codec: "aac", IsDefault: false},
			},
			wantIdx: 1, wantCodec: "aac", wantCompat: true, wantDefault: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			idx, codec, compat, isDef := findBestAudioTrack(tt.tracks, caps, "")
			if idx != tt.wantIdx {
				t.Errorf("index = %d, want %d", idx, tt.wantIdx)
			}
			if codec != tt.wantCodec {
				t.Errorf("codec = %q, want %q", codec, tt.wantCodec)
			}
			if compat != tt.wantCompat {
				t.Errorf("compatible = %v, want %v", compat, tt.wantCompat)
			}
			if isDef != tt.wantDefault {
				t.Errorf("isDefault = %v, want %v", isDef, tt.wantDefault)
			}
		})
	}
}

func TestAudioBitrate(t *testing.T) {
	tests := []struct {
		channels int
		want     string
	}{
		{0, "128k"},  // default to stereo
		{1, "128k"},  // mono, minimum 128k
		{2, "128k"},  // stereo
		{6, "384k"},  // 5.1
		{8, "512k"},  // 7.1
		{-1, "128k"}, // invalid, default to stereo
	}
	for _, tt := range tests {
		got := audioBitrate(tt.channels)
		if got != tt.want {
			t.Errorf("audioBitrate(%d) = %q, want %q", tt.channels, got, tt.want)
		}
	}
}

func TestGenerateMasterPlaylistCODECS(t *testing.T) {
	t.Run("with codec string", func(t *testing.T) {
		profiles := []QualityProfile{
			{Name: "720p", Width: 1280, Height: 720, HLSBandwidth: 3200000, CodecString: "avc1.42001f,mp4a.40.2"},
		}
		playlist := GenerateMasterPlaylist(profiles, "/api/stream/hls/abc", "")
		if !stringContains(playlist, `CODECS="avc1.42001f,mp4a.40.2"`) {
			t.Errorf("expected CODECS attribute in playlist:\n%s", playlist)
		}
	})

	t.Run("without codec string (remux)", func(t *testing.T) {
		profiles := []QualityProfile{
			{Name: "source", Width: 1920, Height: 1080, HLSBandwidth: 20000000},
		}
		playlist := GenerateMasterPlaylist(profiles, "/api/stream/hls/abc", "")
		if stringContains(playlist, "CODECS=") {
			t.Errorf("expected no CODECS attribute in playlist:\n%s", playlist)
		}
	})

	t.Run("with query token", func(t *testing.T) {
		profiles := []QualityProfile{
			{Name: "720p", Width: 1280, Height: 720, HLSBandwidth: 3200000, CodecString: "avc1.42001f,mp4a.40.2"},
		}
		playlist := GenerateMasterPlaylist(profiles, "/api/stream/hls/abc", "mytoken")
		if !stringContains(playlist, "?token=mytoken") {
			t.Errorf("expected token in playlist URLs:\n%s", playlist)
		}
		if !stringContains(playlist, `CODECS="avc1.42001f,mp4a.40.2"`) {
			t.Errorf("expected CODECS attribute in playlist:\n%s", playlist)
		}
	})

	t.Run("multi-profile with per-resolution codecs", func(t *testing.T) {
		profiles := []QualityProfile{
			{Name: "1080p", Width: 1920, Height: 1080, HLSBandwidth: 5500000, CodecString: "avc1.420028,mp4a.40.2"},
			{Name: "720p", Width: 1280, Height: 720, HLSBandwidth: 3200000, CodecString: "avc1.42001f,mp4a.40.2"},
			{Name: "480p", Width: 854, Height: 480, HLSBandwidth: 1700000, CodecString: "avc1.42001e,mp4a.40.2"},
		}
		playlist := GenerateMasterPlaylist(profiles, "/api/stream/hls/abc", "")
		if !stringContains(playlist, `CODECS="avc1.420028,mp4a.40.2"`) {
			t.Errorf("expected Level 4.0 CODECS for 1080p:\n%s", playlist)
		}
		if !stringContains(playlist, `CODECS="avc1.42001f,mp4a.40.2"`) {
			t.Errorf("expected Level 3.1 CODECS for 720p:\n%s", playlist)
		}
		if !stringContains(playlist, `CODECS="avc1.42001e,mp4a.40.2"`) {
			t.Errorf("expected Level 3.0 CODECS for 480p:\n%s", playlist)
		}
	})
}

func TestHlsCodecString(t *testing.T) {
	tests := []struct {
		height int
		audio  string
		fps    float64
		want   string
	}{
		// Values derive from h264LevelIDC (hwaccel.go): 60fps headroom on
		// the low rungs; ≤30fps 1080p/2160p pinned to 4.0/5.1 by Chromecast
		// receiver ceilings (gen-1/2 filter out >4.1, Google TV >5.1).
		{360, "aac", 0, "avc1.64001f,mp4a.40.2"},  // High, Level 3.1
		{480, "aac", 0, "avc1.64001f,mp4a.40.2"},  // High, Level 3.1
		{720, "aac", 0, "avc1.640020,mp4a.40.2"},  // High, Level 3.2
		{1080, "aac", 0, "avc1.640028,mp4a.40.2"}, // High, Level 4.0
		{2160, "aac", 0, "avc1.640033,mp4a.40.2"}, // High, Level 5.1 (4K)
		{1080, "ac3", 0, "avc1.640028,ac-3"},      // High + AC-3 surround
		{720, "", 0, "avc1.640020,mp4a.40.2"},     // empty audio defaults to AAC
		// fps-aware levels (2026-08): >30fps stamps truthful levels.
		{1080, "aac", 23.976, "avc1.640028,mp4a.40.2"}, // film rate stays 4.0
		{1080, "aac", 29.97, "avc1.640028,mp4a.40.2"},  // NTSC 30 stays 4.0
		{1080, "aac", 59.94, "avc1.64002a,mp4a.40.2"},  // 1080p60 → Level 4.2
		{2160, "aac", 60, "avc1.640034,mp4a.40.2"},     // 2160p60 → Level 5.2
		{720, "aac", 60, "avc1.640020,mp4a.40.2"},      // 720p60 fits L3.2 exactly
		{480, "aac", 60, "avc1.64001f,mp4a.40.2"},      // 480p60 fits L3.1
	}
	for _, tt := range tests {
		got := hlsCodecString(tt.height, tt.audio, tt.fps)
		if got != tt.want {
			t.Errorf("hlsCodecString(%d, %q, %v) = %q, want %q", tt.height, tt.audio, tt.fps, got, tt.want)
		}
	}
}

func TestSelectAudioCodecOut(t *testing.T) {
	// "ac3" cap here means MSE/hls.js can genuinely decode AC-3 (the frontend
	// derives it from MediaSource.isTypeSupported only). So AC-3 surround is
	// chosen ONLY for a re-encode of a multichannel source on such a client.
	withAC3 := &ClientCaps{AudioCodecs: map[string]bool{"aac": true, "ac3": true}}
	noAC3 := &ClientCaps{AudioCodecs: map[string]bool{"aac": true}}

	tests := []struct {
		name     string
		recode   bool
		caps     *ClientCaps
		channels int
		want     string
	}{
		{"recode + ac3 + 5.1 => ac3", true, withAC3, 6, "ac3"},
		{"recode + ac3 + 7.1 => ac3", true, withAC3, 8, "ac3"},
		{"recode + ac3 + stereo => aac", true, withAC3, 2, "aac"},
		{"recode + no-ac3 + 5.1 => aac", true, noAC3, 6, "aac"},
		{"copy (no recode) + ac3 + 5.1 => aac", false, withAC3, 6, "aac"},
		{"nil caps (no client caps) => aac", true, nil, 6, "aac"},
		{"unknown channel count => aac", true, withAC3, 0, "aac"},
	}
	for _, tt := range tests {
		if got := SelectAudioCodecOut(tt.recode, tt.caps, tt.channels); got != tt.want {
			t.Errorf("%s: SelectAudioCodecOut(%v, caps, %d) = %q, want %q",
				tt.name, tt.recode, tt.channels, got, tt.want)
		}
	}
}

func TestCastNeedsStereoClone(t *testing.T) {
	// AC-3 sessions need a stereo clone for cast (receiver AC-3 unknowable);
	// everything else is reused as-is.
	cases := map[string]bool{
		"ac3": true,
		"aac": false,
		"":    false,
	}
	for codec, want := range cases {
		if got := CastNeedsStereoClone(codec); got != want {
			t.Errorf("CastNeedsStereoClone(%q) = %v, want %v", codec, got, want)
		}
	}
}

func TestCastCloneOpts(t *testing.T) {
	src := &TranscodeSession{
		FilePath:         "/media/movie.mkv",
		Remux:            true,
		RemuxAudioCopy:   true, // source was copying AC-3
		AudioPassthrough: true,
		AudioCodecOut:    "ac3",
		AudioTrackIndex:  2,
		AudioChannels:    6,
		HDRTonemap:       true,
		SourceVideoCodec: "hevc",
		StartSec:         120,
		SubtitleTracks:   []HLSSubtitleTrack{{AbsoluteIndex: 3, Language: "eng"}},
		BurnSubIndex:     -1,
	}
	opts := castCloneOpts(src, false, false)

	// Audio is forced to a stereo AAC re-encode — never AC-3, never copy.
	if opts.AudioCodecOut != "aac" {
		t.Errorf("AudioCodecOut = %q, want aac", opts.AudioCodecOut)
	}
	if opts.RemuxAudioCopy {
		t.Error("RemuxAudioCopy must be false (force stereo re-encode)")
	}
	if opts.AudioPassthrough {
		t.Error("AudioPassthrough must be false (force stereo re-encode)")
	}

	// Video / resume handling must carry over unchanged.
	if !opts.Remux || opts.AudioTrackIndex != 2 || opts.AudioChannels != 6 ||
		!opts.HDRTonemap || opts.SourceVideoCodec != "hevc" || opts.StartSec != 120 {
		t.Errorf("non-audio opts not preserved: %+v", opts)
	}
	// SubtitleTracks must NOT be carried into the cast clone. When they are
	// present, GenerateMasterPlaylist emits a SUBTITLES rendition group that
	// causes the Chromecast Default Media Receiver (Shaka) to stall silently
	// after loadMedia resolves (issue #328).
	if len(opts.SubtitleTracks) != 0 {
		t.Errorf("SubtitleTracks must be empty in cast clone opts (issue #328), got %+v", opts.SubtitleTracks)
	}
	if opts.BurnIn != nil {
		t.Errorf("BurnIn should be nil when source had none, got %+v", opts.BurnIn)
	}

	// When the source had burn-in configured, it carries into the clone.
	src.BurnSubIndex = 4
	src.BurnSubRelIndex = 1
	src.BurnSubBitmap = true
	if bo := castCloneOpts(src, false, false).BurnIn; bo == nil || bo.SubIndex != 4 || bo.RelIndex != 1 || !bo.IsBitmap {
		t.Errorf("BurnIn not preserved: %+v", bo)
	}
}

func stringContains(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// 2026-07 review — the plain "hevc" cap is probed with an 8-bit Main codec
// string and over-reports for 10-bit content on Main-only decoders. 10-bit
// HEVC (virtually all 4K/HDR HEVC) must be gated on the separate
// "hevc_main10" cap.
func TestDecidePlayback_HEVC10BitRequiresMain10Cap(t *testing.T) {
	tracks := []models.AudioTrack{{Codec: "aac", IsDefault: true}}

	capsWithout := ParseClientCaps("h264,hevc,aac,mp4_container,hls_js")
	capsWith := ParseClientCaps("h264,hevc,hevc_main10,aac,mp4_container,hls_js")

	// Without the main10 cap: 10-bit HEVC must fully transcode — no direct
	// play, no remux (the browser can't decode the copied bits either way).
	pd := DecidePlayback("mp4", "hevc", tracks, capsWithout, "yuv420p10le")
	if pd.Decision != "transcode" {
		t.Fatalf("10-bit HEVC without hevc_main10: decision = %q, want transcode (reason %q)", pd.Decision, pd.TranscodeReason)
	}
	if !strings.Contains(pd.TranscodeReason, "Main 10") {
		t.Errorf("transcode reason should name Main 10, got %q", pd.TranscodeReason)
	}

	// With the main10 cap: 10-bit HEVC in mp4 direct-plays as before.
	pd = DecidePlayback("mp4", "hevc", tracks, capsWith, "yuv420p10le")
	if pd.Decision != "direct_play" {
		t.Errorf("10-bit HEVC with hevc_main10: decision = %q, want direct_play (reason %q)", pd.Decision, pd.TranscodeReason)
	}

	// 8-bit HEVC must be unaffected by the absence of the main10 cap.
	pd = DecidePlayback("mp4", "hevc", tracks, capsWithout, "yuv420p")
	if pd.Decision != "direct_play" {
		t.Errorf("8-bit HEVC without hevc_main10: decision = %q, want direct_play (reason %q)", pd.Decision, pd.TranscodeReason)
	}

	// 10-bit HEVC in an MKV with the main10 cap: remux (container swap only),
	// video still copied — Main10 decode ability covers the copied bits.
	pd = DecidePlayback("matroska", "hevc", tracks, capsWith, "yuv420p10le")
	if pd.Decision != "direct_stream" {
		t.Errorf("10-bit HEVC MKV with hevc_main10: decision = %q, want direct_stream (reason %q)", pd.Decision, pd.TranscodeReason)
	}

	// Same MKV without the cap: full transcode, not remux.
	pd = DecidePlayback("matroska", "hevc", tracks, capsWithout, "yuv420p10le")
	if pd.Decision != "transcode" {
		t.Errorf("10-bit HEVC MKV without hevc_main10: decision = %q, want transcode (reason %q)", pd.Decision, pd.TranscodeReason)
	}
}

func TestParseClientCaps_HEVCMain10(t *testing.T) {
	// hevc_main10 is a dedicated ClientCaps field, NOT a VideoCodecs entry —
	// same design as EAC3MSE: it is a profile capability, not an ffprobe
	// codec name, and the VideoCodecs namespace is matched against ffprobe
	// names.
	caps := ParseClientCaps("hevc,hevc_main10")
	if !caps.VideoCodecs["hevc"] || !caps.HEVCMain10 {
		t.Errorf("hevc_main10 cap not parsed: HEVCMain10=%v videoCodecs=%v", caps.HEVCMain10, caps.VideoCodecs)
	}
	if caps.VideoCodecs["hevc_main10"] {
		t.Error("hevc_main10 must not leak into the VideoCodecs codec namespace")
	}
	// The main10 key alone must NOT imply plain hevc support.
	solo := ParseClientCaps("hevc_main10")
	if solo.VideoCodecs["hevc"] || solo.VideoCodecs["h265"] {
		t.Errorf("hevc_main10 alone must not set hevc/h265: %v", solo.VideoCodecs)
	}
}
