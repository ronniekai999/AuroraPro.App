package streaming

// ABR ladder bandwidth validation (August 2026 review follow-up).
//
// The declared BANDWIDTH attribute is the number hls.js uses to decide whether
// it can afford a rendition. Aurora's ladder used to carry hand-set values that
// sat below the encoder's own -maxrate on every rung and ignored audio
// entirely, which meant the client believed each rung was cheaper than it is
// and over-selected on marginal connections — at startup especially, since that
// is when findBestLevel consults BANDWIDTH rather than AVERAGE-BANDWIDTH.
//
// Two layers of test here:
//
//   - arithmetic invariants over the ladder, which run everywhere and catch a
//     future retune that changes -maxrate without changing the declaration;
//   - a real encode that measures actual peak segment bitrate and asserts the
//     declaration bounds it, which catches the case where the encoder overshoots
//     its own configured ceiling.

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

// TestLadder_DeclaredBandwidthCoversEncoderCeiling is the invariant that was
// violated before this change: every rung's declared BANDWIDTH must be at least
// the encoder's own -maxrate plus the audio it will carry.
//
// RFC 8216 §4.3.4.2 defines BANDWIDTH as the PEAK segment bit rate. A rendition
// capped at 8 Mbps of video plus a 192 kbps AAC track cannot honestly declare
// 7.5 Mbps, and a client that budgets 7.5 will stall on it.
func TestLadder_DeclaredBandwidthCoversEncoderCeiling(t *testing.T) {
	// Every audio output shape a session can resolve to.
	audioCases := []struct {
		name        string
		codecOut    string
		passthrough bool
	}{
		{"aac_reencode", "aac", false},
		{"ac3_reencode", "ac3", false},
		{"ac3_passthrough", "ac3", true},
		{"eac3_passthrough", "eac3", true},
	}

	for _, name := range ProfileOrder {
		p := AllProfiles[name]
		maxRate, ok := parseBitrateSpec(p.MaxRate)
		if !ok {
			t.Fatalf("profile %s has unparseable MaxRate %q", name, p.MaxRate)
		}
		target, ok := parseBitrateSpec(p.VideoBitrate)
		if !ok {
			t.Fatalf("profile %s has unparseable VideoBitrate %q", name, p.VideoBitrate)
		}

		for _, ac := range audioCases {
			t.Run(name+"/"+ac.name, func(t *testing.T) {
				audioBits := AudioDeclaredBitrate(ac.codecOut, ac.passthrough)
				peak, avg := p.LadderBandwidth(audioBits)

				if want := int(float64(maxRate)*vbvPeakHeadroom) + audioBits; peak != want {
					t.Errorf("BANDWIDTH = %d, want %d (-maxrate %d x %.2f VBV headroom + audio %d)",
						peak, want, maxRate, vbvPeakHeadroom, audioBits)
				}
				// The floor that actually matters: a declaration below the
				// bare rate cap plus audio is under-declaring by construction.
				if floor := maxRate + audioBits; peak < floor {
					t.Errorf("BANDWIDTH %d is below -maxrate + audio (%d) — under-declared", peak, floor)
				}
				if want := target + audioBits; avg != want {
					t.Errorf("AVERAGE-BANDWIDTH = %d, want %d (-b:v %d + audio %d)",
						avg, want, target, audioBits)
				}
				// AVERAGE-BANDWIDTH above BANDWIDTH is self-contradictory and
				// makes a player's two estimates disagree about which
				// direction is safer.
				if avg > peak {
					t.Errorf("AVERAGE-BANDWIDTH %d exceeds BANDWIDTH %d", avg, peak)
				}
			})
		}
	}
}

// TestLadder_StaticConstantsMatchDerivedAACValues keeps the checked-in
// HLSBandwidth constants honest. They are the fallback for any path that
// renders a playlist without a resolved session, so they must agree with what
// LadderBandwidth would produce for the default stereo-AAC case — otherwise the
// two disagree and only one of them is ever tested.
func TestLadder_StaticConstantsMatchDerivedAACValues(t *testing.T) {
	audioBits := AudioDeclaredBitrate("aac", false)
	for _, name := range ProfileOrder {
		p := AllProfiles[name]
		peak, avg := p.LadderBandwidth(audioBits)
		if p.HLSBandwidth != peak {
			t.Errorf("%s: checked-in HLSBandwidth %d disagrees with derived peak %d",
				name, p.HLSBandwidth, peak)
		}
		if p.HLSAvgBandwidth != avg {
			t.Errorf("%s: checked-in HLSAvgBandwidth %d disagrees with derived average %d",
				name, p.HLSAvgBandwidth, avg)
		}
	}
}

// TestLadder_RungsAreStrictlyOrdered guards the property ABR depends on: rungs
// must be monotonically cheaper as quality drops. A ladder where two rungs
// cross gives the client no reason to prefer the smaller one.
func TestLadder_RungsAreStrictlyOrdered(t *testing.T) {
	var prevPeak, prevAvg int
	for i, name := range ProfileOrder {
		p := AllProfiles[name]
		if i > 0 {
			if p.HLSBandwidth >= prevPeak {
				t.Errorf("%s BANDWIDTH %d is not below the rung above (%d)", name, p.HLSBandwidth, prevPeak)
			}
			if p.HLSAvgBandwidth >= prevAvg {
				t.Errorf("%s AVERAGE-BANDWIDTH %d is not below the rung above (%d)", name, p.HLSAvgBandwidth, prevAvg)
			}
		}
		prevPeak, prevAvg = p.HLSBandwidth, p.HLSAvgBandwidth
	}
}

// TestLadder_MasterPlaylistCarriesBothAttributes checks the playlist rendering,
// including the remux case that legitimately has neither rate target.
func TestLadder_MasterPlaylistCarriesBothAttributes(t *testing.T) {
	profiles := []QualityProfile{
		{Name: "720p", Width: 1280, Height: 720, HLSBandwidth: 5192000, HLSAvgBandwidth: 4192000, CodecString: "avc1.64001f,mp4a.40.2"},
	}
	master := GenerateMasterPlaylist(profiles, "/base", "")
	if !strings.Contains(master, "BANDWIDTH=5192000") {
		t.Errorf("master playlist missing BANDWIDTH:\n%s", master)
	}
	if !strings.Contains(master, "AVERAGE-BANDWIDTH=4192000") {
		t.Errorf("master playlist missing AVERAGE-BANDWIDTH:\n%s", master)
	}

	// The synthetic remux profile has no rate targets, so AVERAGE-BANDWIDTH
	// must be omitted rather than declared as 0 (which a player would read as
	// a free rendition).
	remux := []QualityProfile{{Name: "source", Width: 1920, Height: 1080, HLSBandwidth: 20000000}}
	masterRemux := GenerateMasterPlaylist(remux, "/base", "")
	if strings.Contains(masterRemux, "AVERAGE-BANDWIDTH") {
		t.Errorf("remux master should omit AVERAGE-BANDWIDTH entirely:\n%s", masterRemux)
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
	waitForFFmpegExit(t, variant, 120*time.Second)

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

	t.Logf("%s: declared BANDWIDTH %d bps, measured peak %d bps across %d segments (%.0f%% of declared)",
		profileName, declared, peak, segCount, float64(peak)/float64(declared)*100)

	if peak > declared {
		t.Errorf("measured peak segment bitrate %d bps EXCEEDS declared BANDWIDTH %d bps. "+
			"A client that budgets the declared value will stall on this rendition.", peak, declared)
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
		info, ierr := e.Info()
		if ierr != nil || info.Size() == 0 {
			continue
		}
		if idx >= len(durations) {
			break
		}
		d := durations[idx]
		idx++
		if d <= 0 {
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
