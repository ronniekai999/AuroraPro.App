package skipmarkers

import (
	"context"
	"errors"
	"math/rand"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// seasonFixture builds synthetic per-file signatures for a season:
// every episode embeds the SAME intro words at a per-episode offset
// (and optionally a shared recap segment), surrounded by unrelated
// noise. Returns the SeasonFile list and a signatureFn serving the
// fixture.
type seasonFixture struct {
	files []SeasonFile
	sigs  map[int64][]uint32
	calls map[int64]int
}

func (f *seasonFixture) sigFor(_ context.Context, sf SeasonFile) ([]uint32, error) {
	f.calls[sf.FileID]++
	s, ok := f.sigs[sf.FileID]
	if !ok {
		return nil, errors.New("no signature for file")
	}
	return s, nil
}

func buildSeason(rng *rand.Rand, introFrames int, introOffsets map[int]int, recapFrames int, recapOffsets map[int]int) *seasonFixture {
	intro := randSig(rng, introFrames)
	var recap []uint32
	if recapFrames > 0 {
		recap = randSig(rng, recapFrames)
	}
	f := &seasonFixture{sigs: map[int64][]uint32{}, calls: map[int64]int{}}
	fileID := int64(100)
	// Deterministic episode order.
	maxEp := 0
	for ep := range introOffsets {
		if ep > maxEp {
			maxEp = ep
		}
	}
	for ep := 1; ep <= maxEp; ep++ {
		off, ok := introOffsets[ep]
		if !ok {
			continue
		}
		sig := randSig(rng, 2000)
		copy(sig[off:], intro)
		if recap != nil {
			if roff, ok := recapOffsets[ep]; ok {
				copy(sig[roff:], recap)
			}
		}
		fileID++
		f.files = append(f.files, SeasonFile{
			FileID:        fileID,
			EpisodeNumber: ep,
			Path:          "/fake",
			DurationMs:    45 * 60 * 1000,
			Pending:       true,
		})
		f.sigs[fileID] = sig
	}
	return f
}

func markerByKind(markers []models.SkipMarker, kind string) *models.SkipMarker {
	for i := range markers {
		if markers[i].Kind == kind {
			return &markers[i]
		}
	}
	return nil
}

func TestAnalyzeSeasonIntros(t *testing.T) {
	rng := rand.New(rand.NewSource(20))
	const introFrames = 300 // ~19 s
	offsets := map[int]int{1: 100, 2: 50, 3: 150, 4: 80}
	fix := buildSeason(rng, introFrames, offsets, 0, nil)

	out := analyzeSeasonIntros(context.Background(), fix.files, fix.sigFor)
	if len(out) != 4 {
		t.Fatalf("expected results for 4 files, got %d", len(out))
	}
	for _, f := range fix.files {
		markers := out[f.FileID]
		intro := markerByKind(markers, "intro")
		if intro == nil {
			t.Fatalf("episode %d: no intro marker (markers=%+v)", f.EpisodeNumber, markers)
		}
		wantStart := sigFrameToMs(offsets[f.EpisodeNumber])
		wantEnd := sigFrameToMs(offsets[f.EpisodeNumber]+introFrames) + endPadMs
		if abs64(intro.StartMs-wantStart) > 200 || abs64(intro.EndMs-wantEnd) > 200 {
			t.Fatalf("episode %d: intro [%d,%d]ms, want ~[%d,%d]ms",
				f.EpisodeNumber, intro.StartMs, intro.EndMs, wantStart, wantEnd)
		}
		if intro.Detector != Detector {
			t.Fatalf("detector = %q, want %q", intro.Detector, Detector)
		}
		// Middle episodes are corroborated by both neighbors.
		wantConf := confidenceSinglePair
		if f.EpisodeNumber == 2 || f.EpisodeNumber == 3 {
			wantConf = confidenceCorroborated
		}
		if intro.Confidence != wantConf {
			t.Fatalf("episode %d: confidence = %f, want %f", f.EpisodeNumber, intro.Confidence, wantConf)
		}
	}
	// Each file decoded exactly once (signature cache).
	for id, n := range fix.calls {
		if n != 1 {
			t.Fatalf("file %d decoded %d times, want 1", id, n)
		}
	}
}

func TestAnalyzeSeasonRecapSplit(t *testing.T) {
	rng := rand.New(rand.NewSource(21))
	// Recap segment (~14 s) well before the intro, with a gap larger
	// than mergeGapSec so it stays a separate marker. Recap offsets
	// drift more than intro offsets between episodes (recap length
	// varies), so each pair sees the recap at a clearly distinct lag.
	introOff := map[int]int{1: 600, 2: 650, 3: 600, 4: 700}
	recapOff := map[int]int{1: 30, 2: 140, 3: 20, 4: 200}
	fix := buildSeason(rng, 300, introOff, 220, recapOff)

	out := analyzeSeasonIntros(context.Background(), fix.files, fix.sigFor)
	for _, f := range fix.files {
		markers := out[f.FileID]
		if markerByKind(markers, "intro") == nil {
			t.Fatalf("episode %d: missing intro", f.EpisodeNumber)
		}
		recap := markerByKind(markers, "recap")
		if recap == nil {
			t.Fatalf("episode %d: missing recap (markers=%+v)", f.EpisodeNumber, markers)
		}
		wantStart := sigFrameToMs(recapOff[f.EpisodeNumber])
		if abs64(recap.StartMs-wantStart) > 200 {
			t.Fatalf("episode %d: recap starts %dms, want ~%dms", f.EpisodeNumber, recap.StartMs, wantStart)
		}
	}
}

func TestAnalyzeSeasonMergesContiguousRecapIntro(t *testing.T) {
	rng := rand.New(rand.NewSource(22))
	// Recap ends 1 frame before the intro starts -> folded into one
	// intro marker spanning both.
	introOff := map[int]int{1: 251, 2: 251, 3: 251}
	recapOff := map[int]int{1: 30, 2: 30, 3: 30}
	fix := buildSeason(rng, 300, introOff, 220, recapOff)

	out := analyzeSeasonIntros(context.Background(), fix.files, fix.sigFor)
	for _, f := range fix.files {
		markers := out[f.FileID]
		if len(markers) != 1 || markers[0].Kind != "intro" {
			t.Fatalf("episode %d: markers = %+v, want single merged intro", f.EpisodeNumber, markers)
		}
		if got, want := markers[0].StartMs, sigFrameToMs(30); abs64(got-want) > 200 {
			t.Fatalf("episode %d: merged intro starts %dms, want ~%dms", f.EpisodeNumber, got, want)
		}
	}
}

func TestAnalyzeSeasonTooFewEpisodes(t *testing.T) {
	rng := rand.New(rand.NewSource(23))
	fix := buildSeason(rng, 300, map[int]int{1: 100, 2: 100}, 0, nil)
	out := analyzeSeasonIntros(context.Background(), fix.files, fix.sigFor)
	for id, markers := range out {
		if markers != nil {
			t.Fatalf("file %d: got markers %+v from a 2-episode season (single pair must not validate)", id, markers)
		}
	}
	if len(fix.calls) != 0 {
		t.Fatalf("signatures decoded for an unvalidatable season: %v", fix.calls)
	}
}

func TestAnalyzeSeasonNoSharedAudio(t *testing.T) {
	rng := rand.New(rand.NewSource(24))
	f := &seasonFixture{sigs: map[int64][]uint32{}, calls: map[int64]int{}}
	for ep := 1; ep <= 4; ep++ {
		id := int64(200 + ep)
		f.files = append(f.files, SeasonFile{FileID: id, EpisodeNumber: ep, DurationMs: 45 * 60 * 1000, Pending: true})
		f.sigs[id] = randSig(rng, 2000)
	}
	out := analyzeSeasonIntros(context.Background(), f.files, f.sigFor)
	for id, markers := range out {
		if markers != nil {
			t.Fatalf("file %d: phantom markers %+v on unrelated episodes", id, markers)
		}
	}
}

func TestAnalyzeSeasonSecondaryVersionGetsOwnOffsets(t *testing.T) {
	rng := rand.New(rand.NewSource(25))
	offsets := map[int]int{1: 100, 2: 50, 3: 150}
	fix := buildSeason(rng, 300, offsets, 0, nil)

	// Add a second file for episode 2 whose cut shifts the intro by
	// ~32 s (e.g. an extended edition).
	intro := fix.sigs[fix.files[1].FileID][50 : 50+300]
	secondary := randSig(rng, 2000)
	const secOff = 550
	copy(secondary[secOff:], intro)
	secFile := SeasonFile{FileID: 999, EpisodeNumber: 2, DurationMs: 45 * 60 * 1000, Pending: true}
	files := append(append([]SeasonFile{}, fix.files...), secFile)
	fix.sigs[999] = secondary

	out := analyzeSeasonIntros(context.Background(), files, fix.sigFor)
	m := markerByKind(out[999], "intro")
	if m == nil {
		t.Fatalf("secondary file got no intro marker: %+v", out[999])
	}
	if want := sigFrameToMs(secOff); abs64(m.StartMs-want) > 200 {
		t.Fatalf("secondary intro at %dms, want ~%dms (own-timeline offsets)", m.StartMs, want)
	}
}

func TestAnalyzeSeasonPendingOnlyWritten(t *testing.T) {
	rng := rand.New(rand.NewSource(26))
	fix := buildSeason(rng, 300, map[int]int{1: 100, 2: 50, 3: 150}, 0, nil)
	fix.files[0].Pending = false // episode 1 already analyzed

	out := analyzeSeasonIntros(context.Background(), fix.files, fix.sigFor)
	if _, present := out[fix.files[0].FileID]; present {
		t.Fatal("non-pending file present in result map")
	}
	if len(out) != 2 {
		t.Fatalf("expected 2 pending results, got %d", len(out))
	}
}

func TestAnalyzeSeasonDecodeFailureDegrades(t *testing.T) {
	rng := rand.New(rand.NewSource(27))
	fix := buildSeason(rng, 300, map[int]int{1: 100, 2: 50, 3: 150, 4: 80}, 0, nil)
	// Episode 1's file is undecodable: pairs (1,2) is lost but (2,3)
	// and (3,4) still validate the season; episodes 2-4 keep markers.
	delete(fix.sigs, fix.files[0].FileID)

	out := analyzeSeasonIntros(context.Background(), fix.files, fix.sigFor)
	if markers := out[fix.files[0].FileID]; markers != nil {
		t.Fatalf("undecodable file got markers: %+v", markers)
	}
	for _, f := range fix.files[1:] {
		if markerByKind(out[f.FileID], "intro") == nil {
			t.Fatalf("episode %d lost its intro to a neighbor's decode failure", f.EpisodeNumber)
		}
	}
}

func abs64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}
