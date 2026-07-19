package embedding

import (
	"reflect"
	"testing"

	"github.com/aurora-media/aurora/internal/db"
)

// decideMarkerAction is the policy core of the model-space guard; these cases
// document the upgrade matrix it must satisfy.
func TestDecideMarkerAction(t *testing.T) {
	cases := []struct {
		name      string
		marker    string
		exists    bool
		effective string
		pinned    bool
		want      markerAction
	}{
		{"marker matches", "qwen3-embedding:0.6b", true, "qwen3-embedding:0.6b", false, markerKeep},
		{"marker matches pinned", "nomic-embed-text", true, "nomic-embed-text", true, markerKeep},
		{"model changed via UI/env", "embeddinggemma", true, "qwen3-embedding:0.6b", false, markerReset},
		{"model changed while pinned", "nomic-embed-text", true, "bge-m3", true, markerReset},
		{"pre-marker upgrade, default follower", "", false, "qwen3-embedding:0.6b", false, markerReset},
		{"pre-marker upgrade, pinned operator keeps vectors", "", false, "nomic-embed-text", true, markerAdopt},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := decideMarkerAction(c.marker, c.exists, c.effective, c.pinned); got != c.want {
				t.Errorf("decideMarkerAction(%q,%v,%q,pinned=%v) = %v, want %v",
					c.marker, c.exists, c.effective, c.pinned, got, c.want)
			}
		})
	}
}

func TestFilterFailed(t *testing.T) {
	cands := []*db.EmbeddingCandidate{{ID: 1}, {ID: 2}, {ID: 3}, {ID: 4}}
	// Empty set: same slice back, no filtering cost.
	if got := filterFailed(cands, nil); len(got) != 4 {
		t.Fatalf("empty set: want 4, got %d", len(got))
	}
	failed := map[int64]struct{}{2: {}, 4: {}}
	got := filterFailed(cands, failed)
	if len(got) != 2 || got[0].ID != 1 || got[1].ID != 3 {
		t.Fatalf("want [1 3], got %v", ids(got))
	}
	// All poisoned → empty (RunBackfill treats this as terminal).
	all := map[int64]struct{}{1: {}, 2: {}, 3: {}, 4: {}}
	if got := filterFailed(cands, all); len(got) != 0 {
		t.Fatalf("all failed: want 0, got %d", len(got))
	}
}

func ids(cands []*db.EmbeddingCandidate) []int64 {
	out := make([]int64, len(cands))
	for i, c := range cands {
		out[i] = c.ID
	}
	return out
}

// TestChunkRanges verifies the partition logic that runWave uses to split a
// fetched wave into per-worker batches. The ranges must be gap-free,
// non-overlapping, and cover exactly [0,n) — if they don't, the concurrent
// backfill would either skip or double-embed candidates.
func TestChunkRanges(t *testing.T) {
	tests := []struct {
		name  string
		n     int
		batch int
		want  [][2]int
	}{
		{name: "exact multiple", n: 6, batch: 2, want: [][2]int{{0, 2}, {2, 4}, {4, 6}}},
		{name: "ragged remainder", n: 5, batch: 2, want: [][2]int{{0, 2}, {2, 4}, {4, 5}}},
		{name: "batch larger than n", n: 3, batch: 10, want: [][2]int{{0, 3}}},
		{name: "single item", n: 1, batch: 16, want: [][2]int{{0, 1}}},
		{name: "batch of one", n: 3, batch: 1, want: [][2]int{{0, 1}, {1, 2}, {2, 3}}},
		{name: "empty", n: 0, batch: 4, want: nil},
		{name: "negative n", n: -5, batch: 4, want: nil},
		// A non-positive batch must not produce a zero-step infinite loop; it is
		// clamped to 1 (one item per chunk).
		{name: "zero batch clamps to one", n: 2, batch: 0, want: [][2]int{{0, 1}, {1, 2}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := chunkRanges(tt.n, tt.batch)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("chunkRanges(%d, %d) = %v, want %v", tt.n, tt.batch, got, tt.want)
			}
		})
	}
}

// TestChunkRangesCoverage asserts the core invariant across many sizes: the
// ranges tile [0,n) with no gaps and no overlaps, regardless of batch size.
func TestChunkRangesCoverage(t *testing.T) {
	for n := 0; n <= 50; n++ {
		for batch := 1; batch <= 17; batch++ {
			ranges := chunkRanges(n, batch)
			prevEnd := 0
			for i, r := range ranges {
				if r[0] != prevEnd {
					t.Fatalf("n=%d batch=%d: chunk %d starts at %d, expected %d (gap/overlap)", n, batch, i, r[0], prevEnd)
				}
				if r[1] <= r[0] {
					t.Fatalf("n=%d batch=%d: chunk %d is empty/inverted: [%d,%d)", n, batch, i, r[0], r[1])
				}
				if r[1]-r[0] > batch {
					t.Fatalf("n=%d batch=%d: chunk %d size %d exceeds batch", n, batch, i, r[1]-r[0])
				}
				prevEnd = r[1]
			}
			if prevEnd != n {
				t.Fatalf("n=%d batch=%d: ranges cover up to %d, expected %d", n, batch, prevEnd, n)
			}
		}
	}
}
