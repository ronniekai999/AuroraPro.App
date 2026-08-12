package streaming

// AV1 INPUT handling audit (August 2026 review follow-up).
//
// The review framed AV1 as an OUTPUT opportunity — new encoders, new hardware
// validation, uncertain payoff. The cheaper question is what happens to the AV1
// files a library already contains, because the answer today is shaped by two
// deliberate constraints that interact:
//
//	streaming.go DirectPlayCodecs — AV1 excluded from the no-caps static path,
//	  after a regression that black-screened AV1-incapable browsers.
//	streaming.go DecidePlayback   — AV1 is never remuxed into HLS segments.
//
// Between them, an AV1 source either direct-plays in its native container or
// takes a full transcode. There is no middle path, which makes the direct-play
// door the only cheap one — and worth pinning shut against regression.

import (
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// av1Client is a modern Chromium with AV1 decode: the case that should get the
// original file byte-for-byte.
func av1Client() *ClientCaps {
	c := ParseClientCaps("h264,vp9,av1,aac,opus,mp4_container,webm_container,hls_js")
	c.FMP4 = true
	return c
}

// noAV1Client is the same browser without AV1 decode.
func noAV1Client() *ClientCaps {
	c := ParseClientCaps("h264,aac,opus,mp4_container,webm_container,hls_js")
	c.FMP4 = true
	return c
}

func aacTrack() []models.AudioTrack {
	return []models.AudioTrack{{Index: 0, Codec: "aac", Channels: 2, IsDefault: true}}
}

func opusTrack() []models.AudioTrack {
	return []models.AudioTrack{{Index: 0, Codec: "opus", Channels: 2, IsDefault: true}}
}

// TestAV1Input_DirectPlaysInNativeContainers is the coverage that matters: for a
// client that reports AV1 decode, an AV1 file in a browser-native container must
// take the free path. Falling to transcode here would burn a full software
// AV1 decode plus H.264 encode for a file the browser could have played as-is.
func TestAV1Input_DirectPlaysInNativeContainers(t *testing.T) {
	cases := []struct {
		name      string
		container string
		tracks    []models.AudioTrack
	}{
		{"av1_aac_mp4", "mp4", aacTrack()},
		{"av1_opus_webm", "webm", opusTrack()},
		{"av1_opus_mp4", "mp4", opusTrack()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pd := DecidePlayback(tc.container, "av1", tc.tracks, av1Client(), "yuv420p")
			if pd.Decision != "direct_play" {
				t.Errorf("AV1 in %s on an AV1-capable client = %q (reason %q), want direct_play",
					tc.container, pd.Decision, pd.TranscodeReason)
			}
		})
	}
}

// TestAV1Input_TenBitStillDirectPlays pins a deliberate ASYMMETRY with HEVC that
// is easy to "fix" wrongly.
//
// HEVC has a 10-bit guard (isHEVC10bit) because Main and Main 10 are separate
// profiles: a decoder can support one and reject the other, and the frontend's
// plain "hevc" probe over-reports for 10-bit content. AV1 is not built that way
// — its Main profile mandates BOTH 8-bit and 10-bit 4:2:0, so a decoder that
// answers yes to av01.0.*.08 necessarily handles 10-bit too.
//
// Adding an AV1 10-bit guard by analogy with HEVC would therefore send a large
// share of real AV1 content (most AV1 encodes are 10-bit even when SDR, because
// the format's own guidance recommends it) into needless transcodes.
func TestAV1Input_TenBitStillDirectPlays(t *testing.T) {
	for _, pixFmt := range []string{"yuv420p10le", "yuv420p"} {
		pd := DecidePlayback("mp4", "av1", aacTrack(), av1Client(), pixFmt)
		if pd.Decision != "direct_play" {
			t.Errorf("AV1 pix_fmt %s = %q (reason %q), want direct_play — AV1 Main mandates "+
				"8- and 10-bit alike, unlike HEVC Main vs Main 10",
				pixFmt, pd.Decision, pd.TranscodeReason)
		}
	}
}

// TestAV1Input_TranscodesWithoutClientSupport is the other side of the gate: no
// AV1 cap means no AV1 delivery, on any container. This is the regression the
// DirectPlayCodecs comment records — AV1 was once on the static allowlist and
// black-screened browsers that could not decode it, with no fallback because
// direct play has no error path back to a transcode.
func TestAV1Input_TranscodesWithoutClientSupport(t *testing.T) {
	for _, container := range []string{"mp4", "webm", "mkv"} {
		pd := DecidePlayback(container, "av1", aacTrack(), noAV1Client(), "yuv420p")
		if pd.Decision != "transcode" {
			t.Errorf("AV1 in %s on a client with no AV1 decode = %q, want transcode",
				container, pd.Decision)
		}
	}
}

// TestAV1Input_StaticFallbackNeverGuessesAV1 pins the no-caps path. When the
// client reports nothing, an unknown-capability guess that lands wrong is
// unrecoverable: direct play has no MEDIA_ERROR route back.
func TestAV1Input_StaticFallbackNeverGuessesAV1(t *testing.T) {
	if DirectPlayCodecs["av1"] {
		t.Error("AV1 is on the static DirectPlayCodecs allowlist; a wrong guess here " +
			"black-screens AV1-incapable browsers with no fallback (see the map's comment)")
	}
	for _, container := range []string{"mp4", "webm"} {
		pd := DecidePlayback(container, "av1", aacTrack(), nil, "yuv420p")
		if pd.Decision != "transcode" {
			t.Errorf("AV1 in %s with nil caps = %q, want transcode", container, pd.Decision)
		}
	}
}

// TestAV1Input_MKVAlwaysTranscodes documents the one genuinely expensive case,
// and that it is expensive for reasons that are not fixable at this layer.
//
// MKV is the container most AV1 releases actually ship in, and it is not
// browser-native, so direct play is out. Remux is out too — separately, and for
// its own reasons (see the vp8/vp9/av1 case in DecidePlayback: no standard
// MPEG-TS stream type, and neither AVPlayer nor Cast receivers handle AV1 in
// HLS reliably enough to copy). So every AV1 MKV takes a full AV1-decode +
// H.264-encode transcode even on a client that could decode the source natively.
//
// The remaining option would be an fMP4 remux restricted to hls.js clients,
// which is plausible but not free: the remux ladder deliberately declares no
// CODECS attribute (it copies an unprobed stream), and hls.js needs an accurate
// av01 codec string to admit the source buffer. That is a change worth making
// on evidence — how many sessions this actually costs — rather than on
// reasoning alone, which is what the QoE decision/reason counters are for.
func TestAV1Input_MKVAlwaysTranscodes(t *testing.T) {
	pd := DecidePlayback("mkv", "av1", aacTrack(), av1Client(), "yuv420p")
	if pd.Decision != "transcode" {
		t.Fatalf("AV1 in MKV = %q, want transcode", pd.Decision)
	}
	if pd.Remux {
		t.Error("AV1 must never be remuxed into HLS segments")
	}
	// The reason string is what the QoE telemetry records, so it has to
	// actually explain the cost rather than say something generic.
	if pd.TranscodeReason == "" {
		t.Error("AV1 MKV transcode carries no reason; the decision counters need one to be useful")
	}
}

// TestAV1Input_RealFileDecisions runs the same audit against actual AV1 files
// rather than literals.
//
// The literal-driven tests above assume ffprobe reports AV1's codec_name as
// "av1" and its pix_fmt in the yuv420p family. Those are the strings the whole
// decision path keys on, and unlike HEVC (which arrives as "hevc" or "h265"
// depending on the demuxer) AV1 has had no alias handling written for it — so
// the assumption is worth holding to a real encoder's output.
func TestAV1Input_RealFileDecisions(t *testing.T) {
	requireFFmpeg(t)
	requireFFmpegEncoders(t, "libsvtav1")

	cases := []struct {
		name      string
		fixture   mediaFixture
		caps      *ClientCaps
		want      string
		wantRemux bool
	}{
		{
			name:    "av1_mp4_capable_client_direct_play",
			fixture: mediaFixture{Container: "mp4", VideoCodec: "av1", AudioCodec: "aac"},
			caps:    av1Client(),
			want:    "direct_play",
		},
		{
			name:    "av1_mp4_incapable_client_transcode",
			fixture: mediaFixture{Container: "mp4", VideoCodec: "av1", AudioCodec: "aac"},
			caps:    noAV1Client(),
			want:    "transcode",
		},
		{
			name:    "av1_mkv_capable_client_transcode",
			fixture: mediaFixture{Container: "mkv", VideoCodec: "av1", AudioCodec: "aac"},
			caps:    av1Client(),
			want:    "transcode",
		},
		{
			// 10-bit AV1 from a real encoder, confirming the profile-level
			// reasoning in TestAV1Input_TenBitStillDirectPlays holds against
			// what ffprobe actually reports for such a file.
			name: "av1_10bit_mp4_capable_client_direct_play",
			fixture: mediaFixture{
				Container: "mp4", VideoCodec: "av1", PixFmt: "yuv420p10le", AudioCodec: "aac",
			},
			caps: av1Client(),
			want: "direct_play",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := tc.fixture.build(t)
			streams := probeStreams(t, path)
			video := firstVideoStream(t, streams)
			audio := firstAudioStream(t, streams)

			if video.CodecName != "av1" {
				t.Fatalf("ffprobe reports AV1 codec_name as %q, not \"av1\" — the decision "+
					"engine has no alias handling for AV1 and would not recognize it",
					video.CodecName)
			}

			pd := DecidePlayback(probeFormatName(t, path), video.CodecName,
				[]models.AudioTrack{{Index: 0, Codec: audio.CodecName, Channels: audio.Channels, IsDefault: true}},
				tc.caps, video.PixFmt)

			if pd.Decision != tc.want {
				t.Errorf("decision = %q (reason %q), want %q [pix_fmt %s]",
					pd.Decision, pd.TranscodeReason, tc.want, video.PixFmt)
			}
			if pd.Remux != tc.wantRemux {
				t.Errorf("Remux = %t, want %t", pd.Remux, tc.wantRemux)
			}
		})
	}
}

// TestAV1Input_NeverRemuxed covers every container at once: whatever else
// changes, the no-remux invariant for AV1 holds.
func TestAV1Input_NeverRemuxed(t *testing.T) {
	for _, container := range []string{"mp4", "webm", "mkv", "mov"} {
		for _, caps := range []*ClientCaps{av1Client(), noAV1Client()} {
			for _, fmp4 := range []bool{true, false} {
				c := *caps
				c.FMP4 = fmp4
				pd := DecidePlayback(container, "av1", aacTrack(), &c, "yuv420p")
				if pd.Remux {
					t.Errorf("AV1 in %s (fmp4=%t) produced a remux decision", container, fmp4)
				}
			}
		}
	}
}
