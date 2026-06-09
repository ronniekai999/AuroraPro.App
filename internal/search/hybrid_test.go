package search

import (
	"reflect"
	"testing"
)

func TestRRFFuseSingleList(t *testing.T) {
	got := rrfFuse([][]int64{{1, 2, 3}}, []float64{1.0})
	if want := []int64{1, 2, 3}; !reflect.DeepEqual(got, want) {
		t.Errorf("single list should preserve order: got %v want %v", got, want)
	}
}

func TestRRFFuseBoostsItemInBothLists(t *testing.T) {
	// 3 appears in both the vector and lexical lists — its summed RRF score should
	// lift it above items that appear in only one (the hybrid win).
	got := rrfFuse(
		[][]int64{{1, 2, 3}, {3, 4}},
		[]float64{hybridVectorWeight, hybridLexicalWeight},
	)
	if len(got) == 0 || got[0] != 3 {
		t.Errorf("item present in both lists should rank first: got %v", got)
	}
	// 4 is lexical-only at the bottom; 1 and 2 (vector) outrank it.
	if want := []int64{3, 1, 2, 4}; !reflect.DeepEqual(got, want) {
		t.Errorf("fused order: got %v want %v", got, want)
	}
}

func TestRRFFuseVectorOutweighsLexicalAtSameRank(t *testing.T) {
	// Same rank (1) in each list, but the vector leg is weighted higher.
	got := rrfFuse(
		[][]int64{{5}, {6}},
		[]float64{hybridVectorWeight, hybridLexicalWeight},
	)
	if want := []int64{5, 6}; !reflect.DeepEqual(got, want) {
		t.Errorf("vector-weighted item should win at equal rank: got %v want %v", got, want)
	}
}

func TestRRFFuseDeterministicTieBreak(t *testing.T) {
	// Equal weights + equal rank → exact score tie, broken by first appearance.
	// Must be identical across runs (map iteration must not leak in).
	for i := 0; i < 8; i++ {
		got := rrfFuse([][]int64{{7}, {8}}, []float64{0.5, 0.5})
		if want := []int64{7, 8}; !reflect.DeepEqual(got, want) {
			t.Fatalf("tie-break should be stable by first appearance: got %v want %v", got, want)
		}
	}
}

func TestLexicalQueries(t *testing.T) {
	cases := []struct {
		name   string
		titles []string
		raw    string
		want   []string
	}{
		{"referenced titles win", []string{"Harry Potter", "  "}, "movie like harry potter", []string{"Harry Potter"}},
		{"falls back to raw query", nil, "something cozy and warm", []string{"something cozy and warm"}},
		{"both empty → nil", []string{"  "}, "   ", nil},
		{"caps at maxLexicalQueries", []string{"a", "b", "c", "d"}, "raw", []string{"a", "b", "c"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := lexicalQueries(c.titles, c.raw)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("lexicalQueries(%v, %q) = %v, want %v", c.titles, c.raw, got, c.want)
			}
		})
	}
}
