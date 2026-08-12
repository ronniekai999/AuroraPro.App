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
	source, err := os.ReadFile("../../migrations/056_playback_qoe.up.sql")
	if err != nil {
		t.Fatalf("read migration 056: %v", err)
	}
	re := regexp.MustCompile(`(?s)CHECK\s*\(\s*decision_reason\s+IN\s*\((.*?)\)\s*\)`)
	m := re.FindStringSubmatch(string(source))
	if m == nil {
		t.Fatal("no decision_reason CHECK found in migration 056")
	}
	sqlValues := map[string]bool{}
	for _, v := range regexp.MustCompile(`'([^']*)'`).FindAllStringSubmatch(m[1], -1) {
		sqlValues[v[1]] = true
	}

	goValues := []string{
		ReasonCompatible, ReasonContainer, ReasonVideoCodec, ReasonAudioCodec,
		ReasonBitDepth, ReasonHDR, ReasonAudioTrack, ReasonClientRetry, ReasonUnspecified,
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
func TestReasonCodeNeverEmitsUnspecifiedForRealTranscodes(t *testing.T) {
	caps := ParseClientCaps("h264,aac,mp4_container,hls_js")
	caps.FMP4 = true
	aac := []models.AudioTrack{{Index: 0, Codec: "aac", Channels: 2, IsDefault: true}}

	// Every shape that should produce a non-direct-play decision.
	shapes := []struct{ container, codec, pixFmt string }{
		{"mkv", "h264", "yuv420p"},
		{"mp4", "hevc", "yuv420p"},
		{"mp4", "h264", "yuv420p10le"},
		{"mkv", "hevc", "yuv420p10le"},
		{"avi", "mpeg4", "yuv420p"},
		{"webm", "vp9", "yuv420p"},
	}
	for _, s := range shapes {
		pd := DecidePlayback(s.container, s.codec, aac, caps, s.pixFmt)
		if pd.Decision == "direct_play" {
			continue
		}
		if got := ReasonCode(pd); got == ReasonUnspecified {
			t.Errorf("%s/%s/%s produced an unbucketed reason %q — the matchers have "+
				"drifted from the decision engine's wording",
				s.container, s.codec, s.pixFmt, pd.TranscodeReason)
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
