package search

import (
	"sort"
	"strings"
)

// Phase E3 — HYBRID RETRIEVAL. Vector recall (pgvector cosine over the HyDE
// embedding) is strong on vibe/semantics but weak on exact title/keyword
// matches; a lexical (trigram) recall is the inverse. We run both and fuse the
// two rank lists with weighted Reciprocal Rank Fusion, then hand the merged pool
// to the existing dedup → cap → LLM-rerank stages. The rerank is the final
// quality gate, so fusion only needs to ensure good candidates are PRESENT.
const (
	// lexicalRecallSize is how many trigram hits to pull per lexical query.
	lexicalRecallSize = 20
	// maxLexicalQueries bounds the trigram DB round-trips per search (one per
	// referenced title, e.g. "movies like Inception and Interstellar").
	maxLexicalQueries = 3
	// rrfK is the standard Reciprocal Rank Fusion damping constant. Larger →
	// flatter contribution from deep ranks; 60 is the canonical default.
	rrfK = 60.0
	// Vector is weighted above lexical so vibe queries stay vector-dominated and
	// a spurious trigram match can't outrank a strong semantic one; an item that
	// ranks well in BOTH (the hybrid win — e.g. an on-vibe exact-title match)
	// still sums to the top.
	hybridVectorWeight  = 1.0
	hybridLexicalWeight = 0.5
)

// lexicalQueries picks the text(s) to run through the trigram leg. Explicit
// referenced titles ("movies like Harry Potter" → "Harry Potter") are the
// strongest lexical anchors; absent those, the raw query is used (its low weight
// + the rerank backstop keep vibe queries from being polluted). Returns nil when
// there's nothing useful to search lexically.
func lexicalQueries(similarTitles []string, raw string) []string {
	var qs []string
	for _, t := range similarTitles {
		if t = strings.TrimSpace(t); t != "" {
			qs = append(qs, t)
		}
	}
	if len(qs) == 0 {
		if r := strings.TrimSpace(raw); r != "" {
			qs = append(qs, r)
		}
	}
	if len(qs) > maxLexicalQueries {
		qs = qs[:maxLexicalQueries]
	}
	return qs
}

// rrfFuse merges ranked ID lists via weighted Reciprocal Rank Fusion:
//
//	score(id) = Σ_lists weight_l / (rrfK + rank)   (rank is 1-based)
//
// It returns the IDs sorted by descending fused score. Determinism is
// load-bearing (the search result feeds a cache and the LLM rerank), so ties are
// broken by first appearance across the lists — firstSeen is unique per id, so
// the comparator is a total order independent of map iteration. len(lists) must
// equal len(weights).
func rrfFuse(lists [][]int64, weights []float64) []int64 {
	score := make(map[int64]float64)
	firstSeen := make(map[int64]int)
	seq := 0
	for li, list := range lists {
		w := weights[li]
		for rank, id := range list {
			score[id] += w / (rrfK + float64(rank+1))
			if _, ok := firstSeen[id]; !ok {
				firstSeen[id] = seq
				seq++
			}
		}
	}
	ids := make([]int64, 0, len(score))
	for id := range score {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(a, b int) bool {
		if score[ids[a]] != score[ids[b]] {
			return score[ids[a]] > score[ids[b]]
		}
		return firstSeen[ids[a]] < firstSeen[ids[b]]
	})
	return ids
}
