package streaming

// ABR ladder bandwidth validation (August 2026 review follow-up).
//
// The declared BANDWIDTH attribute is the number hls.js uses to decide whether
// it can afford a rendition, and — because Level.maxBitrate resolves as
// max(realBitrate, bitrate) — a declaration it will never revise downward. The
// ladder's real defect was that it counted no audio at all; the figures
// themselves are left alone, since an under-declaration self-heals from
// measured fragments while an over-declaration permanently costs a rung on
// every first play.
//
// Two layers of test here:
//
//   - arithmetic invariants over the ladder, which run everywhere and catch a
//     future retune that drops the audio term or pushes 1080p past the
//     first-play bandwidth estimate;
//   - a real encode that MEASURES actual peak segment bitrate, which is what
//     caught an earlier, wrong version of this change. It reports the ratio and
//     fails only on a sanity rail, because the declaration is deliberately below
//     the encoder's rate cap rather than above it.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseBitrateSpec(t *testing.T) {
	cases := []struct {
		in   string
		want int
		ok   bool
	}{
		{"18M", 18_000_000, true},
		{"1.2M", 1_200_000, true},
		{"2.5M", 2_500_000, true},
		{"448k", 448_000, true},
		{"192K", 192_000, true},
		{"5000", 5000, true},
		{"", 0, false},
		{"fast", 0, false},
		{"-3M", 0, false},
		{"0", 0, false},
	}
	for _, tc := range cases {
		got, ok := parseBitrateSpec(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Errorf("parseBitrateSpec(%q) = (%d, %t), want (%d, %t)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

// TestLadder_DeclaredBandwidthCountsAudio is the defect the ladder actually
// had: the hand-tuned figures counted video only, so a session carrying a
// copied surround track declared hundreds of kbps less than it costs.
func TestLadder_DeclaredBandwidthCountsAudio(t *testing.T) {
	audioCases := []struct {
		name        string
		codecOut    string
		passthrough bool
	}{
		{"aac_reencode", "aac", false},
		{"aac_passthrough", "aac", true},
		{"ac3_reencode", "ac3", false},
		{"ac3_passthrough", "ac3", true},
		{"eac3_passthrough", "eac3", true},
	}

	for _, name := range ProfileOrder {
		p := AllProfiles[name]
		if p.DeclaredVideoBPS <= 0 {
			t.Fatalf("profile %s has no declared video bandwidth", name)
		}
		for _, ac := range audioCases {
			t.Run(name+"/"+ac.name, func(t *testing.T) {
				audioBits := AudioDeclaredBitrate(ac.codecOut, ac.passthrough)
				got := p.LadderBandwidth(audioBits)
				if want := p.DeclaredVideoBPS + audioBits; got != want {
					t.Errorf("BANDWIDTH = %d, want %d (video %d + audio %d)",
						got, want, p.DeclaredVideoBPS, audioBits)
				}
				if got <= p.DeclaredVideoBPS {
					t.Errorf("BANDWIDTH %d does not account for audio at all", got)
				}
			})
		}
	}
}

// TestLadder_FirstPlayStartRungIsPreserved pins the property the inflation
// broke, and the reason this change stayed conservative.
//
// hls.js is seeded with abrEwmaDefaultEstimate on a first-ever play — 8 Mbps,
// from BW_ESTIMATE_DEFAULT in lib/streaming.ts — and start-level selection
// compares that against each level's maxBitrate, which is the declared
// BANDWIDTH until fragments have been measured. A 1080p rung declared above the
// seed therefore drops every first play, every private window, and every play
// after a storage clear to 720p. Because maxBitrate is max(realBitrate,
// bitrate), a too-high declaration is never revised back down.
func TestLadder_FirstPlayStartRungIsPreserved(t *testing.T) {
	// Keep in sync with BW_ESTIMATE_DEFAULT in static/redesign/app/src/lib/streaming.ts.
	const firstPlayEstimateBPS = 8_000_000

	// EVERY audio shape, not just the default. An earlier version of this test
	// checked only re-encoded stereo AAC, so it stayed green while a
	// passthrough ceiling pushed the same rung to 8,140,000 — above the seed —
	// for the most common transcode shape there is.
	for _, ac := range []struct {
		name        string
		codecOut    string
		passthrough bool
	}{
		{"aac_reencode", "aac", false},
		{"aac_passthrough", "aac", true},
		{"ac3_reencode", "ac3", false},
		{"ac3_passthrough", "ac3", true},
		{"eac3_passthrough", "eac3", true},
		{"unset_codec", "", false},
		{"unset_codec_passthrough", "", true},
	} {
		t.Run(ac.name, func(t *testing.T) {
			p := AllProfiles["1080p"]
			got := p.LadderBandwidth(AudioDeclaredBitrate(ac.codecOut, ac.passthrough))
			if got > firstPlayEstimateBPS {
				t.Errorf("1080p with %s declares %d bps, above the %d bps first-play "+
					"estimate — every first play would start at 720p instead, and "+
					"hls.js never revises a declared peak downward",
					ac.name, got, firstPlayEstimateBPS)
			}
		})
	}
}

// TestLadder_NoAverageBandwidthIsEmitted pins a deliberate omission.
//
// hls.js resolves averageBitrate as `_avgBitrate || realBitrate || bitrate`, so
// declaring AVERAGE-BANDWIDTH sets _avgBitrate and SUPPRESSES the measured
// realBitrate the player derives from fragments it has already downloaded.
// Emitting it would replace a measurement with a guess — and for software
// transcodes the guess would be badly wrong, since those are CRF-driven and
// never receive the -b:v the guess would be derived from.
func TestLadder_NoAverageBandwidthIsEmitted(t *testing.T) {
	profiles := ResolveProfiles(nil, 1920, 1080)
	for i := range profiles {
		profiles[i].CodecString = "avc1.640028,mp4a.40.2"
	}
	master := GenerateMasterPlaylist(profiles, "/base", "")
	if strings.Contains(master, "AVERAGE-BANDWIDTH") {
		t.Errorf("master playlist declares AVERAGE-BANDWIDTH, which suppresses "+
			"hls.js's measured realBitrate:\n%s", master)
	}
}

// TestLadder_StaticConstantsMatchDerivedAACValues keeps the checked-in
// HLSBandwidth constants honest against the default stereo-AAC resolution.
func TestLadder_StaticConstantsMatchDerivedAACValues(t *testing.T) {
	audioBits := AudioDeclaredBitrate("aac", false)
	for _, name := range ProfileOrder {
		p := AllProfiles[name]
		if got := p.LadderBandwidth(audioBits); p.HLSBandwidth != got {
			t.Errorf("%s: checked-in HLSBandwidth %d disagrees with derived %d",
				name, p.HLSBandwidth, got)
		}
	}
}

// TestLadder_DeclaredVideoStaysWithinItsRateEnvelope ties DeclaredVideoBPS back
// to the encoder settings beside it.
//
// The declaration is hand-maintained now that it is no longer derived from
// MaxRate, so nothing structurally stops a future ladder retune from moving
// -maxrate and leaving the declared figure behind. It should sit between the
// rate-control target and the cap: below -maxrate is deliberate (hls.js raises
// maxBitrate from measured fragments, so under-declaring self-heals while
// over-declaring is permanent), but below the -b:v target would under-declare
// even the encoder's own aim, and above the cap would reintroduce the
// first-play rung demotion.
func TestLadder_DeclaredVideoStaysWithinItsRateEnvelope(t *testing.T) {
	for _, name := range ProfileOrder {
		p := AllProfiles[name]
		target, ok := parseBitrateSpec(p.VideoBitrate)
		if !ok {
			t.Fatalf("%s has unparseable VideoBitrate %q", name, p.VideoBitrate)
		}
		maxRate, ok := parseBitrateSpec(p.MaxRate)
		if !ok {
			t.Fatalf("%s has unparseable MaxRate %q", name, p.MaxRate)
		}
		if p.DeclaredVideoBPS < target {
			t.Errorf("%s declares %d bps, below its own -b:v target of %d",
				name, p.DeclaredVideoBPS, target)
		}
		if p.DeclaredVideoBPS > maxRate {
			t.Errorf("%s declares %d bps, above its -maxrate cap of %d — that is what "+
				"pushed the 1080p rung past the first-play estimate",
				name, p.DeclaredVideoBPS, maxRate)
		}
	}
}

// TestLadder_RungsAreStrictlyOrdered guards the property ABR depends on.
func TestLadder_RungsAreStrictlyOrdered(t *testing.T) {
	var prev int
	for i, name := range ProfileOrder {
		p := AllProfiles[name]
		if i > 0 && p.HLSBandwidth >= prev {
			t.Errorf("%s BANDWIDTH %d is not below the rung above (%d)", name, p.HLSBandwidth, prev)
		}
		prev = p.HLSBandwidth
	}
}

// TestLadder_DeclaredBandwidthBoundsMeasuredPeak is the empirical half: encode a
// real fixture and confirm the declaration actually bounds what came out.
//
// The arithmetic tests prove the declaration matches the CONFIGURED ceiling;
// only a real encode can show whether the encoder respects that ceiling. The
// fixture is deliberately high-entropy — a flat synthetic pattern compresses to
// near nothing and would pass this test no matter how wrong the ladder was.
func TestLadder_DeclaredBandwidthBoundsMeasuredPeak(t *testing.T) {
	requireFFmpeg(t)
	requireFFmpegEncoders(t, "libx264", "aac")

	// 360p is the ladder's tightest rung (1.5 Mbps cap), so it is the one an
	// overshooting encoder breaches first.
	const profileName = "360p"

	fixture := mediaFixture{
		Container: "mkv", VideoCodec: "h264", AudioCodec: "aac",
		Width: 640, Height: 360, DurationSec: 6,
	}
	path := fixture.build(t)

	cfg := matrixConfig()
	cfg.Profiles = []string{profileName}
	cfg.SegmentDuration = 2
	tm, err := NewTranscodeManager(t.TempDir(), cfg)
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	t.Cleanup(tm.Close)

	session, variant := startFirstVariant(t, tm, path,
		SessionOpts{SourceVideoCodec: "h264", AudioTrackIndex: -1, AudioChannels: 2})
	waitForFFmpegExit(t, session, variant, 120*time.Second)

	var declared int
	for _, p := range session.Profiles {
		if p.Name == profileName {
			declared = p.HLSBandwidth
		}
	}
	if declared == 0 {
		t.Fatalf("session declared no bandwidth for profile %s", profileName)
	}

	peak, segCount := measurePeakSegmentBitrate(t, variant.OutputDir)
	if segCount == 0 {
		t.Fatal("no segments to measure")
	}

	ratio := float64(peak) / float64(declared)
	t.Logf("%s: declared BANDWIDTH %d bps, measured peak %d bps across %d segments (%.0f%% of declared)",
		profileName, declared, peak, segCount, ratio*100)

	// This is a MEASUREMENT, not a ceiling assertion. The declared figures are
	// deliberately below the encoder's -maxrate (see the block comment above
	// AllProfiles): hls.js raises maxBitrate from observed fragment sizes, so an
	// under-declaration self-heals, while an over-declaration is permanent and
	// costs a rung on every first play.
	//
	// The bound here is a sanity rail, not the spec's peak rule. A segment that
	// reaches several times the declared value would mean the rate cap is not
	// binding at all and the ladder needs retuning — that is worth failing on;
	// modest overshoot is expected and fine.
	const sanityRail = 2.0
	if ratio > sanityRail {
		t.Errorf("measured peak %d bps is %.1fx the declared BANDWIDTH %d bps. "+
			"The rate cap is not binding; the rung needs retuning.", peak, ratio, declared)
	}
}

// measurePeakSegmentBitrate returns the highest per-segment bitrate in a variant
// directory, in bits/sec, and the number of segments measured.
//
// Bitrate is computed from the segment's own size and duration rather than from
// ffprobe's reported bit_rate: for a CMAF fragment the latter needs the init
// segment for context, while size/duration is exactly the cost a client pays to
// fetch it — which is what BANDWIDTH is supposed to describe.
func measurePeakSegmentBitrate(t *testing.T, variantDir string) (peakBitsPerSec, segments int) {
	t.Helper()

	entries, err := os.ReadDir(variantDir)
	if err != nil {
		t.Fatalf("read variant dir: %v", err)
	}

	// Segment durations come from the playlist's EXTINF values — the muxer's
	// own account of each segment, and what the player uses too.
	durations := segmentDurations(t, filepath.Join(variantDir, "stream.m3u8"))

	var idx int
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "seg_") {
			continue
		}
		if !strings.HasSuffix(name, ".m4s") && !strings.HasSuffix(name, ".ts") {
			continue
		}
		if idx >= len(durations) {
			break
		}
		// Advance the EXTINF cursor for EVERY segment file, including a
		// zero-size one. `continue`-ing without advancing shifted every
		// subsequent file/duration pairing by one and silently measured the
		// wrong bitrates.
		d := durations[idx]
		idx++
		info, ierr := e.Info()
		if ierr != nil || info.Size() == 0 || d <= 0 {
			continue
		}
		bps := int(float64(info.Size()) * 8 / d)
		if bps > peakBitsPerSec {
			peakBitsPerSec = bps
		}
		segments++
	}
	return peakBitsPerSec, segments
}

// segmentDurations returns each EXTINF duration from a media playlist, in order.
func segmentDurations(t *testing.T, playlistPath string) []float64 {
	t.Helper()
	if !waitForFile(t, playlistPath, 30*time.Second) {
		t.Fatalf("variant playlist never appeared at %s", playlistPath)
	}
	body, err := os.ReadFile(playlistPath)
	if err != nil {
		t.Fatalf("read playlist: %v", err)
	}
	var out []float64
	for _, m := range extinfRe.FindAllStringSubmatch(string(body), -1) {
		var d float64
		if _, err := fmt.Sscanf(m[1], "%f", &d); err == nil {
			out = append(out, d)
		}
	}
	return out
}
