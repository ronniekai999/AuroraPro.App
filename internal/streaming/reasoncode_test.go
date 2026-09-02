package streaming

import (
	"os"
	"regexp"
	"sort"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// TestReasonCodeVocabularyMatchesSchema pins the buckets against the CHECK
// constraint that stores them. A code emitted here that the column rejects
// would fail the ingest INSERT and lose the whole row.
func TestReasonCodeVocabularyMatchesSchema(t *testing.T) {
	// Migration 058 replaced the CHECK that 056 created, so the LIVE
	// vocabulary is 058's. Both files are read: 056 must still carry a
	// constraint (the column's origin), and the later definition wins.
	re := regexp.MustCompile(`(?s)CHECK\s*\(\s*decision_reason\s+IN\s*\((.*?)\)\s*\)`)
	var latest string
	for _, file := range []string{
		"../../migrations/056_playback_qoe.up.sql",
		"../../migrations/058_playback_qoe_bitrate_reason.up.sql",
	} {
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		m := re.FindStringSubmatch(string(source))
		if m == nil {
			t.Fatalf("no decision_reason CHECK found in %s", file)
		}
		latest = m[1]
	}
	sqlValues := map[string]bool{}
	for _, v := range regexp.MustCompile(`'([^']*)'`).FindAllStringSubmatch(latest, -1) {
		sqlValues[v[1]] = true
	}

	goValues := []string{
		ReasonCompatible, ReasonContainer, ReasonVideoCodec, ReasonAudioCodec,
		ReasonBitDepth, ReasonAudioTrack, ReasonBitrate, ReasonUnspecified,
	}
	for _, v := range goValues {
		if !sqlValues[v] {
			t.Errorf("ReasonCode may emit %q, which the decision_reason CHECK rejects", v)
		}
	}
	if len(goValues) != len(sqlValues) {
		var sqlList []string
		for v := range sqlValues {
			sqlList = append(sqlList, v)
		}
		sort.Strings(sqlList)
		t.Errorf("bucket counts differ: go has %d, sql has %d (%v)", len(goValues), len(sqlValues), sqlList)
	}
}

// TestReasonCodeBucketsRealDecisions runs the bucketer over reasons produced by
// the actual decision engine rather than hand-written strings.
//
// This is the failure mode worth guarding: TranscodeReason is prose that gets
// reworded during ordinary maintenance, and a substring matcher that silently
// stops matching would send every transcode into "unspecified" — the counters
// would still look healthy while measuring nothing.
func TestReasonCodeBucketsRealDecisions(t *testing.T) {
	chromium := ParseClientCaps("h264,aac,mp4_container,hls_js")
	chromium.FMP4 = true
	noAudio := ParseClientCaps("h264,mp4_container,hls_js")
	noAudio.FMP4 = true

	aac := []models.AudioTrack{{Index: 0, Codec: "aac", Channels: 2, IsDefault: true}}
	dts := []models.AudioTrack{{Index: 0, Codec: "dts", Channels: 6, IsDefault: true}}
	dtsThenAAC := []models.AudioTrack{
		{Index: 0, Codec: "dts", Channels: 6, IsDefault: true},
		{Index: 1, Codec: "aac", Channels: 2},
	}

	cases := []struct {
		name      string
		container string
		codec     string
		pixFmt    string
		tracks    []models.AudioTrack
		caps      *ClientCaps
		want      string
	}{
		{
			name: "direct play", container: "mp4", codec: "h264", pixFmt: "yuv420p",
			tracks: aac, caps: chromium, want: ReasonCompatible,
		},
		{
			name: "mkv container", container: "mkv", codec: "h264", pixFmt: "yuv420p",
			tracks: aac, caps: chromium, want: ReasonContainer,
		},
		{
			name: "undecodable video codec", container: "mp4", codec: "hevc", pixFmt: "yuv420p",
			tracks: aac, caps: chromium, want: ReasonVideoCodec,
		},
		{
			// Hi10P: ffprobe still says "h264", so only the pix_fmt forces the
			// transcode. It must bucket as bit_depth, not video_codec —
			// otherwise a whole class of capability-gate conservatism hides
			// behind a codec everyone assumes is fine.
			name: "h264 10-bit", container: "mp4", codec: "h264", pixFmt: "yuv420p10le",
			tracks: aac, caps: chromium, want: ReasonBitDepth,
		},
		{
			name: "undecodable audio codec", container: "mp4", codec: "h264", pixFmt: "yuv420p",
			tracks: dts, caps: chromium, want: ReasonAudioCodec,
		},
		{
			name: "compatible audio is not default", container: "mp4", codec: "h264", pixFmt: "yuv420p",
			tracks: dtsThenAAC, caps: chromium, want: ReasonAudioTrack,
		},
		{
			name: "no audio support at all", container: "mp4", codec: "h264", pixFmt: "yuv420p",
			tracks: aac, caps: noAudio, want: ReasonAudioCodec,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pd := DecidePlayback(tc.container, tc.codec, tc.tracks, tc.caps, tc.pixFmt)
			got := ReasonCode(pd)
			if got != tc.want {
				t.Errorf("ReasonCode = %q, want %q\n  decision: %s\n  reason:   %q",
					got, tc.want, pd.Decision, pd.TranscodeReason)
			}
		})
	}
}

// TestReasonCodeNeverEmitsUnspecifiedForRealTranscodes is the drift alarm: if
// the decision engine's prose is reworded past the matchers, this fails loudly
// instead of quietly collapsing every bucket into "unspecified".
//
// The shapes below deliberately use clients that CAN decode the codec in
// question. An earlier version of this test fed every case the same
// "h264,aac,mp4_container,hls_js" caps, which meant the client could not decode
// hevc/vp9/av1 and each case took the generic "video codec not supported"
// path — so it never reached the remux-forbidden branches it was written to
// protect, and reported green while three real reasons bucketed as
// "unspecified". A guard test that cannot reach the branch it guards is worse
// than no test, because it is believed.
func TestReasonCodeNeverEmitsUnspecifiedForRealTranscodes(t *testing.T) {
	basic := ParseClientCaps("h264,aac,mp4_container,hls_js")
	basic.FMP4 = true
	// A client that decodes everything modern, so codec-capable-but-
	// unremuxable sources reach the remux-forbidden branches.
	capable := ParseClientCaps("h264,hevc,vp8,vp9,av1,aac,ac3,mp4_container,webm_container,hls_js,hevc_main10")
	capable.FMP4 = true
	// Native-HLS only, no MSE: the client for which HEVC needs fMP4 and there
	// is no hls.js escape hatch.
	nativeOnly := ParseClientCaps("h264,hevc,aac,mp4_container,hls_native,hevc_main10")
	nativeOnly.FMP4 = false

	aac := []models.AudioTrack{{Index: 0, Codec: "aac", Channels: 2, IsDefault: true}}
	mp3 := []models.AudioTrack{{Index: 0, Codec: "mp3", Channels: 2, IsDefault: true}}
	dts := []models.AudioTrack{{Index: 0, Codec: "dts", Channels: 6, IsDefault: true}}
	dtsThenAAC := []models.AudioTrack{
		{Index: 0, Codec: "dts", Channels: 6, IsDefault: true},
		{Index: 1, Codec: "aac", Channels: 2},
	}

	shapes := []struct {
		name                     string
		container, codec, pixFmt string
		tracks                   []models.AudioTrack
		caps                     *ClientCaps
		want                     string
	}{
		{"mkv h264", "mkv", "h264", "yuv420p", aac, basic, ReasonContainer},
		{"undecodable video codec", "mp4", "hevc", "yuv420p", aac, basic, ReasonVideoCodec},
		{"h264 10-bit", "mp4", "h264", "yuv420p10le", aac, basic, ReasonBitDepth},
		{"hevc 10-bit no main10", "mp4", "hevc", "yuv420p10le", aac,
			ParseClientCaps("h264,hevc,aac,mp4_container,hls_js"), ReasonBitDepth},
		{"undecodable audio", "mp4", "h264", "yuv420p", dts, basic, ReasonAudioCodec},
		{"audio not default", "mp4", "h264", "yuv420p", dtsThenAAC, basic, ReasonAudioTrack},
		// The container is the cause; the audio recode is a consequence of it.
		// Whole-string matching used to bucket this as audio_codec.
		{"mkv with non-copy-safe audio", "mkv", "h264", "yuv420p", mp3, basic, ReasonContainer},
		// Remux-forbidden branches — only reachable with a capable client.
		{"av1 mkv capable client", "mkv", "av1", "yuv420p", aac, capable, ReasonVideoCodec},
		{"vp9 mkv capable client", "mkv", "vp9", "yuv420p", aac, capable, ReasonVideoCodec},
		{"hevc native-only no fmp4", "mkv", "hevc", "yuv420p", aac, nativeOnly, ReasonVideoCodec},
	}

	for _, s := range shapes {
		t.Run(s.name, func(t *testing.T) {
			caps := *s.caps
			if s.caps != nativeOnly {
				caps.FMP4 = true
			}
			pd := DecidePlayback(s.container, s.codec, s.tracks, &caps, s.pixFmt)
			if pd.Decision == "direct_play" {
				t.Fatalf("shape produced direct_play; it cannot exercise a reason bucket")
			}
			got := ReasonCode(pd)
			if got == ReasonUnspecified {
				t.Fatalf("unbucketed reason %q — the matchers have drifted from the "+
					"decision engine's wording", pd.TranscodeReason)
			}
			if got != s.want {
				t.Errorf("ReasonCode = %q, want %q\n  reason: %q", got, s.want, pd.TranscodeReason)
			}
		})
	}
}

// TestReasonCodeEveryBucketIsReachable proves no bucket is dead vocabulary.
//
// The schema-drift test only checks that the Go list and the SQL CHECK agree —
// both could list a value nothing can ever emit, and they did: "hdr" and
// "client_retry" were in both lists while no TranscodeReason contained either
// concept. An unreachable bucket makes the aggregate look more granular than it
// is, and quietly invites someone to conclude a real cause "never happens".
func TestReasonCodeEveryBucketIsReachable(t *testing.T) {
	basic := ParseClientCaps("h264,aac,mp4_container,hls_js")
	basic.FMP4 = true
	capable := ParseClientCaps("h264,hevc,vp9,av1,aac,mp4_container,webm_container,hls_js,hevc_main10")
	capable.FMP4 = true

	aac := []models.AudioTrack{{Index: 0, Codec: "aac", Channels: 2, IsDefault: true}}
	dts := []models.AudioTrack{{Index: 0, Codec: "dts", Channels: 6, IsDefault: true}}
	dtsThenAAC := []models.AudioTrack{
		{Index: 0, Codec: "dts", Channels: 6, IsDefault: true},
		{Index: 1, Codec: "aac", Channels: 2},
	}

	produced := map[string]bool{
		// Reached by construction, not by DecidePlayback prose.
		ReasonUnspecified: ReasonCode(PlaybackDecision{Decision: "transcode"}) == ReasonUnspecified,
	}
	// The bitrate ceiling needs the full input form: a playable file whose
	// probed bitrate sits above the client's declared ceiling.
	capped := *basic
	capped.MaxBitrate = 8_000_000
	produced[ReasonCode(DecidePlaybackFor(DecisionInput{
		Container: "mp4", VideoCodec: "h264", PixFmt: "yuv420p",
		AudioTracks: aac, Caps: &capped, SourceBitrate: 40_000_000,
	}))] = true
	for _, s := range []struct {
		container, codec, pixFmt string
		tracks                   []models.AudioTrack
		caps                     *ClientCaps
	}{
		{"mp4", "h264", "yuv420p", aac, basic},        // direct play
		{"mkv", "h264", "yuv420p", aac, basic},        // container
		{"mp4", "hevc", "yuv420p", aac, basic},        // video codec
		{"mp4", "h264", "yuv420p10le", aac, basic},    // bit depth
		{"mp4", "h264", "yuv420p", dts, basic},        // audio codec
		{"mp4", "h264", "yuv420p", dtsThenAAC, basic}, // audio track
		{"mkv", "av1", "yuv420p", aac, capable},       // remux-forbidden
	} {
		produced[ReasonCode(DecidePlayback(s.container, s.codec, s.tracks, s.caps, s.pixFmt))] = true
	}

	for _, bucket := range []string{
		ReasonCompatible, ReasonContainer, ReasonVideoCodec,
		ReasonAudioCodec, ReasonBitDepth, ReasonAudioTrack, ReasonBitrate, ReasonUnspecified,
	} {
		if !produced[bucket] {
			t.Errorf("bucket %q is never produced by any real decision — it is dead "+
				"vocabulary and should be removed from both the Go list and the CHECK "+
				"constraint, or the decision engine should be able to emit it", bucket)
		}
	}
}

func TestReasonCodeEmptyReason(t *testing.T) {
	if got := ReasonCode(PlaybackDecision{Decision: "transcode"}); got != ReasonUnspecified {
		t.Errorf("empty reason = %q, want %q", got, ReasonUnspecified)
	}
	// Direct play short-circuits before the prose is consulted at all.
	if got := ReasonCode(PlaybackDecision{Decision: "direct_play"}); got != ReasonCompatible {
		t.Errorf("direct play = %q, want %q", got, ReasonCompatible)
	}
	// Case-insensitivity, since the prose is not normalized upstream.
	pd := PlaybackDecision{Decision: "transcode", TranscodeReason: "CONTAINER \"MKV\" NOT SUPPORTED"}
	if got := ReasonCode(pd); got != ReasonContainer {
		t.Errorf("uppercase reason = %q, want %q", got, ReasonContainer)
	}
}
