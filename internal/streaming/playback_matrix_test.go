package streaming

// The playback matrix (August 2026 review item #1).
//
// Everything else in this package's test suite asserts ARGUMENTS: given these
// inputs, does the decision engine return the expected verdict, does this flag
// reach the FFmpeg argv. Those tests are fast and worth keeping, but they share
// a blind spot — they never run FFmpeg, so nothing catches the case where a
// perfectly-reasoned decision produces a stream that will not play.
//
// This file runs the real pipeline over synthetic fixtures (mediafixture_test.go)
// and asserts the properties a player actually depends on:
//
//   - the decision engine's verdict against the file's REAL probe output,
//     not a hand-written probe fixture that can drift from what ffprobe says;
//   - the master playlist's CODECS attribute against the codecs actually
//     present in the emitted segments — a mismatch here is the classic silent
//     failure (Chrome rejects the MSE source buffer, Safari plays audio over a
//     black frame) and no argument-level test can see it;
//   - that FFmpeg starts, publishes a first segment, and that the segment is
//     structurally intact (init + media fragment demux cleanly together);
//   - that a seek-anchored session produces a usable first segment.
//
// Runtime is a few seconds: the fixtures are 4-second 320x240 clips, cached
// across subtests, and each session is stopped as soon as its first segment
// lands.

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/models"
)

// matrixConfig is the manager config the matrix runs under: software encoding
// only (CI has no GPU), fMP4 segments (the production default), short segments
// so a 4-second fixture still yields several.
func matrixConfig() config.TranscodeConfig {
	return config.TranscodeConfig{
		MaxSessions:        8,
		MaxSessionsPerUser: 8,
		HWAccel:            "none",
		HWDecode:           "off",
		SegmentDuration:    2,
		SegmentFormat:      "fmp4",
		Profiles:           []string{"360p"},
		SoftwarePreset:     "ultrafast",
	}
}

// --- Decision layer ---

// TestPlaybackMatrix_DecisionsAgainstRealProbes runs DecidePlayback over probe
// data taken from real files rather than hand-written literals. The hand-written
// tables in decision_test.go are still the exhaustive coverage; this asserts the
// narrower but load-bearing property that the strings ffprobe actually emits for
// each container/codec shape are the strings the decision engine understands.
func TestPlaybackMatrix_DecisionsAgainstRealProbes(t *testing.T) {
	requireFFmpeg(t)

	// A modern Chromium: H.264 + AAC/AC-3 in MP4, hls.js, no HEVC.
	chromium := ParseClientCaps("h264,aac,mp3,ac3,mp4_container,webm_container,hls_js")
	// Desktop Safari: HEVC, native HLS *and* MSE (so hls.js is available too).
	// eac3_mse is a distinct cap key from eac3 — the HLS paths gate E-AC-3 on
	// the MSE-strict probe, not the generic canPlayType answer.
	safari := ParseClientCaps("h264,hevc,aac,ac3,eac3,eac3_mse,mp4_container,hls_native,hls_js,hevc_main10")
	// Old iOS Safari (< 17.1): native HLS with NO MSE, so no hls.js fallback.
	// This is the client for which HEVC-in-MPEG-TS is unplayable *and*
	// unrecoverable — AVPlayer can't decode it and there is no MEDIA_ERROR
	// path back to a transcode.
	safariNativeOnly := ParseClientCaps("h264,hevc,aac,ac3,mp4_container,hls_native,hevc_main10")

	cases := []struct {
		name         string
		fixture      mediaFixture
		caps         *ClientCaps
		fmp4         bool
		wantDecision string
		// wantAudioPassthrough is only asserted when wantDecision != "transcode"
		// or the field is explicitly relevant to the case.
		wantAudioPassthrough bool
	}{
		{
			name:                 "h264_aac_mp4_chromium_direct_play",
			fixture:              mediaFixture{Container: "mp4", VideoCodec: "h264", AudioCodec: "aac"},
			caps:                 chromium,
			fmp4:                 true,
			wantDecision:         "direct_play",
			wantAudioPassthrough: true,
		},
		{
			// MKV is not a browser-native container, so a fully-compatible
			// H.264/AAC file still has to be remuxed into HLS.
			name:                 "h264_aac_mkv_chromium_remux",
			fixture:              mediaFixture{Container: "mkv", VideoCodec: "h264", AudioCodec: "aac"},
			caps:                 chromium,
			fmp4:                 true,
			wantDecision:         "direct_stream",
			wantAudioPassthrough: true,
		},
		{
			// HEVC on a client with no HEVC decode: full transcode.
			name:         "hevc_aac_mkv_chromium_transcode",
			fixture:      mediaFixture{Container: "mkv", VideoCodec: "hevc", AudioCodec: "aac"},
			caps:         chromium,
			fmp4:         true,
			wantDecision: "transcode",
		},
		{
			// HEVC on Safari with fMP4 available: remux is legal (Apple's HLS
			// authoring spec requires HEVC in fMP4, which is why fmp4 matters).
			name:         "hevc_aac_mkv_safari_fmp4_remux",
			fixture:      mediaFixture{Container: "mkv", VideoCodec: "hevc", AudioCodec: "aac"},
			caps:         safari,
			fmp4:         true,
			wantDecision: "direct_stream",
		},
		{
			// Same file, TS segments, native-HLS-only client: HEVC-in-TS is
			// the forbidden combination (review 2026-06 finding B2). Note the
			// guard is `!FMP4 && !HLSJS` — a client that HAS hls.js can still
			// take an HEVC-in-TS remux, because hls.js demuxes HEVC from TS
			// and its MEDIA_ERROR handler can fall back to transcode. Only the
			// no-MSE client has neither escape.
			name:         "hevc_aac_mkv_native_only_ts_no_remux",
			fixture:      mediaFixture{Container: "mkv", VideoCodec: "hevc", AudioCodec: "aac"},
			caps:         safariNativeOnly,
			fmp4:         false,
			wantDecision: "transcode",
		},
		{
			// The same client/file WITH hls.js present: the TS remux is legal.
			// Pinned so a future tightening of the B2 guard can't silently
			// promote every hls.js HEVC session to a full transcode.
			name:         "hevc_aac_mkv_hlsjs_ts_remux_allowed",
			fixture:      mediaFixture{Container: "mkv", VideoCodec: "hevc", AudioCodec: "aac"},
			caps:         safari,
			fmp4:         false,
			wantDecision: "direct_stream",
		},
		{
			// H.264 Hi10P: ffprobe reports plain "h264", but browsers reject
			// 10-bit H.264 through MSE. The pix_fmt is the only signal, which
			// is exactly why this case needs a real file behind it.
			name:         "h264_10bit_mp4_chromium_transcode",
			fixture:      mediaFixture{Container: "mp4", VideoCodec: "h264", PixFmt: "yuv420p10le", AudioCodec: "aac"},
			caps:         chromium,
			fmp4:         true,
			wantDecision: "transcode",
		},
		{
			// E-AC-3 surround in MKV on Safari: video copies, and the audio
			// rides through as E-AC-3 because fMP4 passthrough is safe.
			name: "hevc_eac3_mkv_safari_remux_audio_copy",
			fixture: mediaFixture{
				Container: "mkv", VideoCodec: "hevc", AudioCodec: "eac3", AudioChannels: 6,
			},
			caps:                 safari,
			fmp4:                 true,
			wantDecision:         "direct_stream",
			wantAudioPassthrough: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := tc.fixture.build(t)

			streams := probeStreams(t, path)
			video := firstVideoStream(t, streams)
			audio := firstAudioStream(t, streams)
			format := probeFormatName(t, path)

			// Copy the caps so the per-case FMP4 flag doesn't leak between
			// subtests (ParseClientCaps results are shared above).
			caps := *tc.caps
			caps.FMP4 = tc.fmp4

			tracks := []models.AudioTrack{{
				Index:     0,
				Codec:     audio.CodecName,
				Channels:  audio.Channels,
				IsDefault: true,
			}}

			pd := DecidePlayback(format, video.CodecName, tracks, &caps, video.PixFmt)

			if pd.Decision != tc.wantDecision {
				t.Errorf("DecidePlayback(%s/%s/%s pix=%s fmp4=%t) = %q (reason %q), want %q",
					format, video.CodecName, audio.CodecName, video.PixFmt, tc.fmp4,
					pd.Decision, pd.TranscodeReason, tc.wantDecision)
			}
			if tc.wantAudioPassthrough && !pd.AudioPassthrough {
				t.Errorf("AudioPassthrough = false, want true (audio codec %q, fmp4 %t)",
					audio.CodecName, tc.fmp4)
			}
		})
	}
}

// --- Pipeline layer ---

var codecsAttrRe = regexp.MustCompile(`CODECS="([^"]+)"`)

// TestPlaybackMatrix_MasterCodecsMatchSegments is the assertion that argument
// tests structurally cannot make: run a real transcode, then compare what the
// master playlist DECLARES against what the segments actually CONTAIN.
//
// A mismatch is the classic silent playback failure. Chrome checks the CODECS
// attribute against MediaSource.isTypeSupported before it will even open a
// source buffer, and Safari will happily play the audio of a stream whose video
// codec string is wrong while showing a black frame. Neither surfaces as an
// FFmpeg error, so nothing upstream of the player notices.
func TestPlaybackMatrix_MasterCodecsMatchSegments(t *testing.T) {
	requireFFmpeg(t)
	requireFFmpegEncoders(t, "libx264", "aac")

	cases := []struct {
		name      string
		fixture   mediaFixture
		opts      SessionOpts
		wantVideo string // codec_name ffprobe should report in the segment
		wantAudio string
		// wantNoCodecsAttr marks the profiles that deliberately omit CODECS.
		// The remux ladder is a single synthetic "source" profile with an
		// empty CodecString: the server copies the source stream without
		// probing its exact profile/level, and QualityProfile documents
		// "empty = omitted". That is the safe choice — Chrome refuses to open
		// a source buffer whose CODECS disagrees with the bytes, so declaring
		// a GUESSED avc1 level is strictly worse than declaring nothing.
		// (Apple's HLS Authoring Spec does ask for CODECS on every variant, so
		// this is a known, deliberate deviation rather than an oversight.)
		wantNoCodecsAttr bool
	}{
		{
			name:      "transcode_h264_aac",
			fixture:   mediaFixture{Container: "mkv", VideoCodec: "hevc", AudioCodec: "aac"},
			opts:      SessionOpts{SourceVideoCodec: "hevc", AudioTrackIndex: -1, AudioChannels: 2},
			wantVideo: "h264",
			wantAudio: "aac",
		},
		{
			name:    "remux_h264_copy_aac_copy",
			fixture: mediaFixture{Container: "mkv", VideoCodec: "h264", AudioCodec: "aac"},
			opts: SessionOpts{
				Remux: true, RemuxAudioCopy: true,
				SourceVideoCodec: "h264", AudioTrackIndex: -1, AudioChannels: 2,
			},
			wantVideo:        "h264",
			wantAudio:        "aac",
			wantNoCodecsAttr: true,
		},
		{
			// HDR source through a transcode: the tonemap chain must run and
			// the output must come out 8-bit SDR H.264, not washed-out 10-bit.
			name: "transcode_hdr_tonemapped_to_sdr",
			fixture: mediaFixture{
				Container: "mkv", VideoCodec: "hevc", PixFmt: "yuv420p10le", HDR: true, AudioCodec: "aac",
			},
			opts: SessionOpts{
				SourceVideoCodec: "hevc", SourceVideoPixFmt: "yuv420p10le",
				SourceHDR: true, HDRTonemap: true,
				AudioTrackIndex: -1, AudioChannels: 2,
			},
			wantVideo: "h264",
			wantAudio: "aac",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.fixture.encoderFor() == "libx265" {
				requireFFmpegEncoders(t, "libx265")
			}
			path := tc.fixture.build(t)

			tm := newMatrixManager(t)
			session, variant := startFirstVariant(t, tm, path, tc.opts)

			// What the master playlist declares.
			master := GenerateMasterPlaylist(session.Profiles,
				"/api/stream/hls/"+session.ID, "", session.SubtitleTracks)
			declared := codecsAttrRe.FindStringSubmatch(master)

			// What the segments actually contain.
			merged := mergeInitAndSegment(t, variant.OutputDir)
			streams := probeStreams(t, merged)
			gotVideo := firstVideoStream(t, streams)
			gotAudio := firstAudioStream(t, streams)

			if gotVideo.CodecName != tc.wantVideo {
				t.Errorf("segment video codec = %q, want %q", gotVideo.CodecName, tc.wantVideo)
			}
			if gotAudio.CodecName != tc.wantAudio {
				t.Errorf("segment audio codec = %q, want %q", gotAudio.CodecName, tc.wantAudio)
			}

			switch {
			case tc.wantNoCodecsAttr:
				// Pin the deliberate omission. If a future change starts
				// emitting CODECS on the remux ladder it must be a considered
				// decision with a real probe behind it, not a guessed string.
				if declared != nil {
					t.Errorf("remux master declares CODECS=%q; the source profile copies an "+
						"unprobed stream, so a guessed codec string would risk a source-buffer "+
						"rejection. Emit CODECS here only with probed profile/level data.",
						declared[1])
				}
			case declared == nil:
				t.Errorf("master playlist carries no CODECS attribute:\n%s", master)
			default:
				assertCodecsAttrMatches(t, declared[1], gotVideo.CodecName, gotAudio.CodecName)
			}

			// An HDR source that transcodes must come out SDR 8-bit; otherwise
			// the tonemap silently did nothing and the picture is washed out.
			if tc.fixture.HDR {
				if gotVideo.PixFmt != "yuv420p" {
					t.Errorf("tonemapped output pix_fmt = %q, want yuv420p (8-bit SDR)", gotVideo.PixFmt)
				}
				if IsHDRColorTransfer(gotVideo.ColorTransfer) {
					t.Errorf("tonemapped output still carries HDR transfer %q", gotVideo.ColorTransfer)
				}
			}
		})
	}
}

// assertCodecsAttrMatches checks that the master playlist's CODECS attribute
// describes the codecs that actually came out. It compares FAMILIES (avc1/hvc1,
// mp4a/ac-3/ec-3) rather than exact profile-level strings — the level digits
// are covered by the unit tests in profiles_test.go, and what breaks players in
// practice is declaring the wrong codec family entirely.
func assertCodecsAttrMatches(t *testing.T, codecsAttr, actualVideo, actualAudio string) {
	t.Helper()

	videoPrefix := map[string]string{"h264": "avc1", "hevc": "hvc1"}[actualVideo]
	if videoPrefix == "" {
		t.Fatalf("unhandled segment video codec %q — extend assertCodecsAttrMatches", actualVideo)
	}
	audioTag := map[string]string{"aac": "mp4a", "ac3": "ac-3", "eac3": "ec-3"}[actualAudio]
	if audioTag == "" {
		t.Fatalf("unhandled segment audio codec %q — extend assertCodecsAttrMatches", actualAudio)
	}

	parts := strings.Split(codecsAttr, ",")
	var sawVideo, sawAudio bool
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if strings.HasPrefix(p, videoPrefix) {
			sawVideo = true
		}
		if strings.HasPrefix(p, audioTag) {
			sawAudio = true
		}
	}
	if !sawVideo {
		t.Errorf("CODECS=%q declares no %q entry, but segments carry %s",
			codecsAttr, videoPrefix, actualVideo)
	}
	if !sawAudio {
		t.Errorf("CODECS=%q declares no %q entry, but segments carry %s",
			codecsAttr, audioTag, actualAudio)
	}
}

// TestPlaybackMatrix_SubtitleBurnInProducesFrames covers the axis the August
// 2026 review omitted entirely.
//
// Burn-in is not a cosmetic add-on: injectBurnInFilter rewrites the whole
// filter chain, and for bitmap subtitles it swaps -vf out for a -filter_complex
// overlay graph. A malformed graph kills FFmpeg at encoder init, which surfaces
// to the user as a title that simply never starts. It also has a performance
// consequence the review's telemetry schema had no field for: PlanDecode
// refuses the Tier-2 zero-copy GPU pipeline whenever burnIn is set, so every
// burn-in session falls back to CPU filters.
func TestPlaybackMatrix_SubtitleBurnInProducesFrames(t *testing.T) {
	requireFFmpeg(t)
	requireFFmpegEncoders(t, "libx264", "aac")
	requireSubtitlesFilter(t)

	cases := []struct {
		name    string
		fixture mediaFixture
		bitmap  bool
	}{
		{
			name:    "text_srt_burn_in",
			fixture: mediaFixture{Container: "mkv", VideoCodec: "h264", AudioCodec: "aac", Subs: subsText},
		},
		{
			name:    "ass_burn_in",
			fixture: mediaFixture{Container: "mkv", VideoCodec: "h264", AudioCodec: "aac", Subs: subsASS},
		},
		{
			name:    "bitmap_overlay_graph",
			fixture: mediaFixture{Container: "mkv", VideoCodec: "h264", AudioCodec: "aac", Subs: subsBitmapOverlay},
			bitmap:  true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := tc.fixture.build(t)

			// Stream 2 in every one of these fixtures is the subtitle-ish
			// stream (video=0, audio=1, subs/overlay=2).
			opts := SessionOpts{
				SourceVideoCodec: "h264",
				AudioTrackIndex:  -1,
				AudioChannels:    2,
				BurnIn: &BurnInOpts{
					SubIndex: 2,
					RelIndex: 0,
					IsBitmap: tc.bitmap,
				},
			}

			// Encode the SAME fixture twice — once with burn-in, once without —
			// and require the pixels to differ.
			//
			// The earlier version of this test asserted only "output is h264"
			// and "duration > 0", both of which hold whether or not the
			// subtitle filter ran at all: an adversarial review disabled
			// injectBurnInFilter entirely and every subtest still passed. That
			// caught the malformed-graph-kills-ffmpeg failure but not the
			// user-visible one — subtitles requested, none rendered — which is
			// the whole point of the axis.
			withBurn := encodeAndHashFirstFrames(t, path, opts)
			plain := opts
			plain.BurnIn = nil
			withoutBurn := encodeAndHashFirstFrames(t, path, plain)

			if withBurn == withoutBurn {
				t.Errorf("burn-in produced pixel-identical output to no burn-in (framehash %s) — "+
					"the subtitle filter did not reach the frames", withBurn)
			}
		})
	}
}

// TestPlaybackMatrix_BurnInForcesCPUDecodePath pins the interaction above at the
// planner level, on every hardware family, without needing a GPU: no matter how
// capable the probed hardware claims to be, a burn-in session must never be
// planned onto the Tier-2 zero-copy pipeline (its filter graph cannot be
// expressed on GPU frames).
func TestPlaybackMatrix_BurnInForcesCPUDecodePath(t *testing.T) {
	for _, backend := range []HWAccelType{HWAccelNVENC, HWAccelQSV, HWAccelVAAPI} {
		t.Run(string(backend), func(t *testing.T) {
			// A maximally-capable box: every decode cycle probed, both Tier-2
			// pipelines proven, GPU tonemap available.
			info := HWAccelInfo{
				Type:       backend,
				DecodeType: backend,
				DecodeCodecs: map[string]bool{
					decodeKeyH264:   true,
					decodeKeyHEVC:   true,
					decodeKeyHEVC10: true,
				},
				FullGPU:      true,
				FullGPU10:    true,
				TonemapVAAPI: true,
			}

			// Without burn-in the planner takes Tier 2 (zero-copy).
			if _, fullGPU := info.PlanDecode("h264", "yuv420p", false, false, false); !fullGPU {
				t.Fatal("fully-probed hardware did not plan Tier-2 without burn-in — " +
					"the precondition for this test no longer holds")
			}

			// With burn-in it must drop to Tier 1 regardless of capability:
			// the subtitles/overlay filters cannot run on GPU frames.
			for _, hdr := range []bool{false, true} {
				if _, fullGPU := info.PlanDecode("h264", "yuv420p", hdr, true, false); fullGPU {
					t.Errorf("PlanDecode(burnIn=true, hdrTonemap=%t) planned Tier-2 zero-copy; "+
						"burn-in needs CPU frames", hdr)
				}
			}
		})
	}
}

// TestPlaybackMatrix_EveryQualityPolicyEncodes runs each speed/quality policy
// through a real software transcode.
//
// The unit tests in qualitypolicy_test.go assert the resolved argv; this asserts
// that FFmpeg accepts it. A policy that selects a preset name the local encoder
// build does not recognize fails at encoder init, before a single segment — the
// exact failure mode the fail-safe parsing exists to prevent, and one that only
// a real encode can catch. Software-only here because CI has no GPU; the
// hardware families need the hardware-in-the-loop runs documented in
// docs/server-testing.md.
func TestPlaybackMatrix_EveryQualityPolicyEncodes(t *testing.T) {
	requireFFmpeg(t)
	requireFFmpegEncoders(t, "libx264", "aac")

	fixture := mediaFixture{Container: "mkv", VideoCodec: "h264", AudioCodec: "aac"}
	path := fixture.build(t)

	for _, policy := range []QualityPolicy{PolicyFastStart, PolicyBalanced, PolicyQuality} {
		t.Run(string(policy), func(t *testing.T) {
			cfg := matrixConfig()
			cfg.QualityPolicy = string(policy)
			// Clear the preset so the POLICY picks it — otherwise
			// software_preset wins by design and every case would encode
			// identically, testing nothing.
			cfg.SoftwarePreset = ""

			tm, err := NewTranscodeManager(t.TempDir(), cfg)
			if err != nil {
				t.Fatalf("new transcode manager: %v", err)
			}
			t.Cleanup(tm.Close)

			if got := tm.hwAccel.policy(); got != policy {
				t.Fatalf("manager resolved policy %q, want %q", got, policy)
			}

			_, variant := startFirstVariant(t, tm, path,
				SessionOpts{SourceVideoCodec: "h264", AudioTrackIndex: -1, AudioChannels: 2})

			merged := mergeInitAndSegment(t, variant.OutputDir)
			if got := firstVideoStream(t, probeStreams(t, merged)).CodecName; got != "h264" {
				t.Errorf("policy %q produced video codec %q, want h264", policy, got)
			}
			if d := segmentDurationOf(t, merged); d <= 0 {
				t.Errorf("policy %q produced a segment with no media (%v)", policy, d)
			}
		})
	}
}

// TestPlaybackMatrix_SeekAnchoredSessionEncodesOnlyTheRemainder asserts that a
// seek actually moves FFmpeg's input position rather than silently re-encoding
// from zero.
//
// This is invisible to argument tests: `-ss` lands in the argv either way, and a
// session that ignored it would still produce perfectly valid segments — the
// user would just see the movie restart from the beginning after every seek,
// and the server would burn full-length encodes for every scrub. Measuring the
// PUBLISHED duration is the only way to tell the two apart.
func TestPlaybackMatrix_SeekAnchoredSessionEncodesOnlyTheRemainder(t *testing.T) {
	requireFFmpeg(t)
	requireFFmpegEncoders(t, "libx264", "aac")

	const (
		fixtureDuration = 8.0
		seekTo          = 6 // seconds
	)
	fixture := mediaFixture{
		Container: "mkv", VideoCodec: "h264", AudioCodec: "aac",
		DurationSec: fixtureDuration,
	}
	path := fixture.build(t)

	tm := newMatrixManager(t)
	opts := SessionOpts{
		SourceVideoCodec: "h264",
		AudioTrackIndex:  -1,
		AudioChannels:    2,
		StartSec:         seekTo,
	}
	session, variant := startFirstVariant(t, tm, path, opts)

	// Let the (short) encode run to completion so the playlist holds every
	// segment the seek produced.
	waitForFFmpegExit(t, session, variant, 90*time.Second)

	published := publishedPlaylistDuration(t, filepath.Join(variant.OutputDir, "stream.m3u8"))
	remaining := fixtureDuration - seekTo

	// Generous tolerance: the encoder starts at the keyframe at or before the
	// requested offset, and the final segment is padded to the GOP boundary.
	// The assertion that matters is "~2s of output, not ~8s" — an ignored seek
	// overshoots by the whole seek distance, far outside this band.
	if published > remaining+2.0 {
		t.Errorf("seek to %ds on a %.0fs source published %.2fs of media; expected roughly %.0fs. "+
			"An over-long output means -ss did not move the input position and the session "+
			"re-encoded from the start.", seekTo, fixtureDuration, published, remaining)
	}
	if published <= 0 {
		t.Errorf("seek to %ds published no media at all (%.2fs)", seekTo, published)
	}
}

// waitForFFmpegExit blocks until the variant's FFmpeg process has exited.
//
// `exited` and StderrTail are written by the cmd.Wait goroutine under
// variantMu, so both reads take the lock — ffmpegDone's contract, and the
// difference between this passing and tripping -race on a box that has a real
// ffmpeg (these tests skip without one).
func waitForFFmpegExit(t *testing.T, s *TranscodeSession, v *QualityVariant, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		s.variantMu.Lock()
		done := ffmpegDone(v)
		s.variantMu.Unlock()
		if done {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	s.variantMu.Lock()
	tail := v.StderrTail
	s.variantMu.Unlock()
	t.Fatalf("ffmpeg did not exit within %v\nstderr tail:\n%s", within, tail)
}

var extinfRe = regexp.MustCompile(`(?m)^#EXTINF:([0-9.]+)`)

// publishedPlaylistDuration sums the EXTINF durations in a variant playlist —
// the amount of media the session actually made available to a player.
func publishedPlaylistDuration(t *testing.T, playlistPath string) float64 {
	t.Helper()
	if !waitForFile(t, playlistPath, 30*time.Second) {
		t.Fatalf("variant playlist never appeared at %s", playlistPath)
	}
	body, err := os.ReadFile(playlistPath)
	if err != nil {
		t.Fatalf("read variant playlist: %v", err)
	}
	var total float64
	for _, m := range extinfRe.FindAllStringSubmatch(string(body), -1) {
		d, perr := strconv.ParseFloat(m[1], 64)
		if perr != nil {
			t.Fatalf("parse EXTINF %q: %v", m[1], perr)
		}
		total += d
	}
	return total
}

// encodeAndHashFirstFrames runs a session and returns a hash of the decoded
// frames of its first segment, so two encodes of the same source can be
// compared for an actual visual difference.
//
// It decodes rather than hashing the segment bytes: two encodes of identical
// input are not byte-identical (timestamps, encoder state), so a byte hash
// would differ even when nothing was drawn.
func encodeAndHashFirstFrames(t *testing.T, path string, opts SessionOpts) string {
	t.Helper()

	tm := newMatrixManager(t)
	_, variant := startFirstVariant(t, tm, path, opts)
	merged := mergeInitAndSegment(t, variant.OutputDir)

	// framehash over the decoded frames of the segment. Deterministic for a
	// given set of decoded pixels and independent of container framing.
	out, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error",
		"-i", merged, "-frames:v", "12", "-f", "framehash", "-").Output()
	if err != nil {
		t.Fatalf("framehash %s: %v", merged, err)
	}
	var hashes []string
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		hashes = append(hashes, line)
	}
	if len(hashes) == 0 {
		t.Fatalf("framehash produced no frame rows for %s — nothing decoded", merged)
	}
	return strings.Join(hashes, "|")
}

// requireSubtitlesFilter skips (or fails under CI) when ffmpeg was built without
// libass, so the burn-in cases don't report a build-configuration difference as
// an Aurora regression.
func requireSubtitlesFilter(t *testing.T) {
	t.Helper()
	out, err := exec.Command("ffmpeg", "-hide_banner", "-filters").Output()
	if err != nil {
		failOrSkipMedia(t, "cannot list ffmpeg filters")
	}
	if !strings.Contains(string(out), " subtitles ") {
		failOrSkipMedia(t, "ffmpeg lacks the subtitles filter (built without libass)")
	}
}

// --- Session helpers ---

// newMatrixManager builds a TranscodeManager rooted in a per-test temp dir.
func newMatrixManager(t *testing.T) *TranscodeManager {
	t.Helper()
	tm, err := NewTranscodeManager(t.TempDir(), matrixConfig())
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	t.Cleanup(tm.Close)
	return tm
}

// startFirstVariant creates a session for the fixture, starts its only quality
// variant, and blocks until FFmpeg publishes the first segment. It fails the
// test with FFmpeg's stderr tail when the variant dies instead — the failure
// mode that matters, and the one an argument test can't see.
func startFirstVariant(t *testing.T, tm *TranscodeManager, path string, opts SessionOpts) (*TranscodeSession, *QualityVariant) {
	t.Helper()

	session, err := tm.CreateSession(1, "matrix", path, 320, 240, opts)
	if err != nil {
		t.Fatalf("create session for %s: %v", filepath.Base(path), err)
	}
	t.Cleanup(func() { tm.StopSession(session.ID) })

	profile := tm.primaryProfileName(session)
	variant, err := tm.EnsureVariant(session, profile, opts.StartSec)
	if err != nil {
		t.Fatalf("ensure variant %q: %v", profile, err)
	}

	// Ready, Err and StderrTail are all written under variantMu by the
	// lifecycle goroutines (Ready is replaced wholesale on relaunch), and
	// closing Ready gives no happens-before with the Err/StderrTail writes
	// when it happens through the playlist-found branch — so snapshot each
	// under the lock rather than reading the fields directly.
	session.variantMu.Lock()
	ready := variant.Ready
	session.variantMu.Unlock()

	timedOut := false
	select {
	case <-ready:
	case <-time.After(90 * time.Second):
		timedOut = true
	}
	session.variantMu.Lock()
	vErr, tail := variant.Err, variant.StderrTail
	session.variantMu.Unlock()
	if timedOut {
		t.Fatalf("variant %q never became ready\nffmpeg stderr tail:\n%s", profile, tail)
	}
	if vErr != nil {
		t.Fatalf("variant %q failed: %v\nffmpeg stderr tail:\n%s", profile, vErr, tail)
	}
	return session, variant
}

// mergeInitAndSegment concatenates the CMAF init segment with the first media
// fragment into a single probe-able file.
//
// An fMP4 media segment is not independently demuxable: the moov box with every
// codec parameter lives in init.mp4, and the .m4s carries only moof+mdat.
// ffprobe on the fragment alone reports no streams at all. Byte-concatenating
// the two is exactly what a player's source buffer does, so probing the result
// tells us what the client will actually see.
func mergeInitAndSegment(t *testing.T, variantDir string) string {
	t.Helper()

	initPath := filepath.Join(variantDir, "init.mp4")
	if !waitForFile(t, initPath, 30*time.Second) {
		t.Fatalf("init.mp4 never appeared in %s (contents: %v)", variantDir, dirEntries(t, variantDir))
	}

	segPath := firstMediaSegment(t, variantDir)

	initBytes, err := os.ReadFile(initPath)
	if err != nil {
		t.Fatalf("read init.mp4: %v", err)
	}
	segBytes, err := os.ReadFile(segPath)
	if err != nil {
		t.Fatalf("read %s: %v", segPath, err)
	}

	merged := filepath.Join(t.TempDir(), "merged.mp4")
	if err := os.WriteFile(merged, append(initBytes, segBytes...), 0o644); err != nil {
		t.Fatalf("write merged segment: %v", err)
	}
	return merged
}

// firstMediaSegment returns the lowest-numbered complete media segment in a
// variant directory, waiting briefly for one to appear.
func firstMediaSegment(t *testing.T, variantDir string) string {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		entries, err := os.ReadDir(variantDir)
		if err == nil {
			var best string
			for _, e := range entries {
				name := e.Name()
				if !strings.HasPrefix(name, "seg_") {
					continue
				}
				if !strings.HasSuffix(name, ".m4s") && !strings.HasSuffix(name, ".ts") {
					continue
				}
				if info, ierr := e.Info(); ierr != nil || info.Size() == 0 {
					continue
				}
				if best == "" || name < best {
					best = name
				}
			}
			if best != "" {
				return filepath.Join(variantDir, best)
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("no media segment appeared in %s (contents: %v)", variantDir, dirEntries(t, variantDir))
	return ""
}

func dirEntries(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []string{"<unreadable: " + err.Error() + ">"}
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}
