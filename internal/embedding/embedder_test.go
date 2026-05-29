package embedding

import (
	"reflect"
	"testing"
)

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
