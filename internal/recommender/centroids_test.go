package recommender

import (
	"testing"

	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/models"
)

func TestKForN(t *testing.T) {
	cases := []struct{ n, max, want int }{
		{0, 3, 1}, {3, 3, 1}, {7, 3, 1}, // sparse → single centroid
		{8, 3, 2}, {15, 3, 2}, // mid → 2
		{16, 3, 3}, {20, 3, 3}, // rich → 3
		{20, 2, 2}, {20, 1, 1}, // capped by the setting
		{16, 0, 3}, // max<=0 → uncapped (defensive)
	}
	for _, c := range cases {
		if got := kForN(c.n, c.max); got != c.want {
			t.Errorf("kForN(%d, %d) = %d, want %d", c.n, c.max, got, c.want)
		}
	}
}

// vecLit builds a pgvector text literal from raw components (computeTasteCentroids
// normalizes internally).
func vecLit(xs ...float32) string { return llm.FormatVector(xs) }

func TestComputeTasteCentroidsTwoClusters(t *testing.T) {
	// Two well-separated groups: one near axis e0, one near e1.
	rows := []string{
		vecLit(1, 0, 0, 0), vecLit(0.9, 0.1, 0, 0), vecLit(0.95, 0.05, 0, 0), vecLit(0.92, 0.08, 0, 0),
		vecLit(0, 1, 0, 0), vecLit(0.1, 0.9, 0, 0), vecLit(0.05, 0.95, 0, 0), vecLit(0.08, 0.92, 0, 0),
	}
	cents, err := computeTasteCentroids(rows, 2)
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	if len(cents) != 2 {
		t.Fatalf("want 2 centroids, got %d", len(cents))
	}
	// Each centroid should clearly lean toward one axis — the two must separate.
	var lean0, lean1 bool
	for _, c := range cents {
		v, err := llm.ParseVector(c)
		if err != nil {
			t.Fatalf("parse centroid: %v", err)
		}
		if v[0] > v[1] {
			lean0 = true
		}
		if v[1] > v[0] {
			lean1 = true
		}
	}
	if !lean0 || !lean1 {
		t.Errorf("centroids did not separate the two clusters: %v", cents)
	}
}

func TestComputeTasteCentroidsDeterministic(t *testing.T) {
	rows := []string{
		vecLit(1, 0, 0, 0), vecLit(0.9, 0.1, 0, 0), vecLit(0.7, 0.3, 0.1, 0),
		vecLit(0, 1, 0, 0), vecLit(0.1, 0.9, 0, 0), vecLit(0, 0.8, 0.2, 0),
		vecLit(0, 0, 1, 0), vecLit(0.1, 0, 0.9, 0),
	}
	first, err := computeTasteCentroids(rows, 3)
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	// Same input, many times → byte-identical output (no rand/map-order/time).
	for i := 0; i < 5; i++ {
		again, err := computeTasteCentroids(rows, 3)
		if err != nil {
			t.Fatalf("compute again: %v", err)
		}
		if len(again) != len(first) {
			t.Fatalf("non-deterministic length: %d vs %d", len(again), len(first))
		}
		for j := range first {
			if again[j] != first[j] {
				t.Errorf("non-deterministic centroid %d:\n  %s\n  %s", j, first[j], again[j])
			}
		}
	}
}

func TestComputeTasteCentroidsThreeClusters(t *testing.T) {
	// Three well-separated groups (axes e0, e1, e2). With the seedEpsilon fix,
	// farthest-first seeds one point per group → exactly 3 centroids. (The
	// pre-fix float roundoff re-picked a seed and yielded only 2.)
	rows := []string{
		vecLit(1, 0, 0, 0), vecLit(0.95, 0.05, 0, 0), vecLit(0.9, 0.1, 0, 0),
		vecLit(0, 1, 0, 0), vecLit(0.05, 0.95, 0, 0), vecLit(0, 0.9, 0.1, 0),
		vecLit(0, 0, 1, 0), vecLit(0, 0.05, 0.95, 0), vecLit(0.1, 0, 0.9, 0),
	}
	cents, err := computeTasteCentroids(rows, 3)
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	if len(cents) != 3 {
		t.Errorf("three separated clusters should yield 3 centroids, got %d: %v", len(cents), cents)
	}
}

func TestComputeTasteCentroidsCollapse(t *testing.T) {
	// All points identical → one taste mode, even when asked for 3.
	same := vecLit(1, 0, 0, 0)
	rows := []string{same, same, same, same, same, same, same, same}
	cents, err := computeTasteCentroids(rows, 3)
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	if len(cents) != 1 {
		t.Errorf("identical points should collapse to 1 centroid, got %d", len(cents))
	}
}

func TestInterleaveMerge(t *testing.T) {
	item := func(id int64) *models.MediaItem { return &models.MediaItem{ID: id} }
	listA := []*models.MediaItem{item(1), item(2), item(3)}
	listB := []*models.MediaItem{item(2), item(4), item(5)} // shares #1 (id=2) with A's #2

	got := interleaveMerge([][]*models.MediaItem{listA, listB}, 10)
	// Round-robin by rank with first-wins dedupe: A0=1, B0=2, A1=2(dup), B1=4,
	// A2=3, B2=5 → [1,2,4,3,5].
	want := []int64{1, 2, 4, 3, 5}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d (%v)", len(got), len(want), ids(got))
	}
	for i := range want {
		if got[i].ID != want[i] {
			t.Errorf("merge[%d] = %d, want %d (full: %v)", i, got[i].ID, want[i], ids(got))
		}
	}

	// Truncation to the limit.
	if trunc := interleaveMerge([][]*models.MediaItem{listA, listB}, 2); len(trunc) != 2 {
		t.Errorf("truncate to 2 → got %d", len(trunc))
	}
}

func ids(items []*models.MediaItem) []int64 {
	out := make([]int64, len(items))
	for i, it := range items {
		out[i] = it.ID
	}
	return out
}
