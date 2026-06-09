package recommender

// Phase E1 — multi-centroid taste. A single averaged taste vector blurs a
// profile that likes BOTH horror AND rom-coms into a muddy midpoint that
// recommends neither. This clusters the profile's recency slice (the same one
// BuildProfileVector averages) into K=2-3 centroids, recalls from each, and
// interleaves the results so every taste mode is represented.
//
// Clustering is Go-side: the deployed pgvector lacks `vector * scalar` (see the
// HARD-LEARNED note in queries_recommender.go), so SQL can't do k-means.

import (
	"context"
	"fmt"
	"log/slog"
	"math"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/models"
)

const (
	// tasteCentroidsDefault is the default cap on taste modes per profile. 1
	// disables clustering (single averaged centroid, the pre-Phase-E behavior).
	tasteCentroidsDefault = 3
	// clusterMinItems is the recency-slice floor below which we DON'T split
	// taste — too few points to cluster meaningfully, so one centroid beats
	// splintering noise.
	clusterMinItems = 8
	// kmeansMaxIters bounds the Lloyd refinement loop. Embeddings are L2-
	// normalized and the slice is tiny (≤20 points), so it converges in a few
	// passes; the cap is just a safety stop.
	kmeansMaxIters = 10
	// seedEpsilon is the farthest-first "no point left to seed" threshold.
	// cosineSimilarity is a float64 dot product over float32-normalized inputs,
	// so a point's self-distance (1 - cos(v,v)) lands at a tiny positive roundoff
	// (~3e-8) rather than exactly 0. Without this epsilon the >0 break fails and
	// an already-chosen seed gets re-picked; the empty-cluster filter still drops
	// it (output stays correct + deterministic), but the seed slot is wasted.
	seedEpsilon = 1e-6
)

// kForN maps the recency-slice size to a centroid count, capped by max (the
// recommender_taste_centroids setting). Sparse history → 1 (single centroid,
// unchanged behavior); richer history earns more taste modes.
func kForN(n, max int) int {
	var k int
	switch {
	case n < clusterMinItems:
		k = 1
	case n < 16:
		k = 2
	default:
		k = 3
	}
	if max > 0 && k > max {
		k = max
	}
	if k < 1 {
		k = 1
	}
	return k
}

// computeTasteCentroids clusters a profile's recency slice (un-averaged
// embeddings as pgvector text literals) into up to k centroids via k-means in
// cosine space, returning each centroid as a pgvector text literal.
//
// DETERMINISM IS LOAD-BEARING: hero/discover results are cached and Phase B2
// ROTATES them, so identical history MUST yield byte-identical centroids or
// rebuilds churn. Init is farthest-first traversal (greedy, zero randomness);
// assignment ties break to the lowest centroid index; no map iteration, no
// rand/time. Same input → same output, always.
//
// Returns fewer than k centroids when clusters collapse (a single-taste profile
// legitimately yields 1). Errors only on unparseable rows or k<1; callers fall
// back to the single-centroid path on any error.
func computeTasteCentroids(rows []string, k int) ([]string, error) {
	if k < 1 {
		return nil, fmt.Errorf("k must be >= 1, got %d", k)
	}
	// Parse + L2-normalize: cosineSimilarity is a bare dot product, so
	// normalized inputs make it a true cosine and keep centroids comparable.
	pts := make([][]float32, 0, len(rows))
	for i, r := range rows {
		v, err := llm.ParseVector(r)
		if err != nil {
			return nil, fmt.Errorf("parse embedding %d: %w", i, err)
		}
		if len(v) == 0 {
			continue
		}
		pts = append(pts, normalizeVec(v))
	}
	if len(pts) == 0 {
		return nil, fmt.Errorf("no parseable embeddings")
	}
	if k > len(pts) {
		k = len(pts)
	}
	if k == 1 {
		return []string{llm.FormatVector(meanNormalized(pts))}, nil
	}

	// Deterministic init, then Lloyd refinement.
	seeds := farthestFirstSeeds(pts, k)
	centroids := make([][]float32, len(seeds))
	for i, s := range seeds {
		centroids[i] = append([]float32(nil), pts[s]...)
	}

	assign := make([]int, len(pts))
	for i := range assign {
		assign[i] = -1
	}
	for iter := 0; iter < kmeansMaxIters; iter++ {
		changed := false
		for i, p := range pts {
			best, bestSim := 0, math.Inf(-1)
			for c, cen := range centroids {
				if sim := cosineSimilarity(p, cen); sim > bestSim {
					bestSim, best = sim, c
				}
			}
			if assign[i] != best {
				assign[i] = best
				changed = true
			}
		}
		// Recompute each centroid as the L2-normalized mean of its members.
		sums := make([][]float32, len(centroids))
		counts := make([]int, len(centroids))
		for i, p := range pts {
			c := assign[i]
			if sums[c] == nil {
				sums[c] = make([]float32, len(p))
			}
			for d := range p {
				sums[c][d] += p[d]
			}
			counts[c]++
		}
		for c := range centroids {
			if counts[c] == 0 {
				continue // keep the prior centroid for an empty cluster
			}
			centroids[c] = normalizeVec(sums[c])
		}
		if !changed {
			break
		}
	}

	// Emit centroids for NON-EMPTY clusters only, deduping identical literals
	// (two clusters can converge to the same point). Output order follows the
	// centroid slice (deterministic); the map is membership-only, never ranged.
	used := make([]bool, len(centroids))
	for _, c := range assign {
		if c >= 0 {
			used[c] = true
		}
	}
	seen := make(map[string]struct{}, len(centroids))
	out := make([]string, 0, len(centroids))
	for c, cen := range centroids {
		if !used[c] {
			continue
		}
		lit := llm.FormatVector(cen)
		if _, dup := seen[lit]; dup {
			continue
		}
		seen[lit] = struct{}{}
		out = append(out, lit)
	}
	if len(out) == 0 {
		out = append(out, llm.FormatVector(meanNormalized(pts)))
	}
	return out, nil
}

// farthestFirstSeeds picks k seed indices via deterministic farthest-first
// traversal: seed 0 is point 0; each next seed is the point whose nearest
// already-chosen seed is FARTHEST away (max-min). Ties → lowest index (the
// `>` comparison keeps the first max seen). Distance = 1 - cosine.
func farthestFirstSeeds(pts [][]float32, k int) []int {
	seeds := make([]int, 0, k)
	seeds = append(seeds, 0)
	nearest := make([]float64, len(pts)) // dist from point i to its nearest seed
	for i := range pts {
		nearest[i] = 1 - cosineSimilarity(pts[i], pts[0])
	}
	for len(seeds) < k {
		best, bestDist := -1, math.Inf(-1)
		for i := range pts {
			if nearest[i] > bestDist {
				bestDist, best = nearest[i], i
			}
		}
		if best < 0 || bestDist <= seedEpsilon {
			break // remaining points coincide with an existing seed (epsilon
			// absorbs float32 self-cosine roundoff so a seed can't re-pick itself)
		}
		seeds = append(seeds, best)
		for i := range pts {
			d := 1 - cosineSimilarity(pts[i], pts[best])
			if d < 0 {
				d = 0
			}
			if d < nearest[i] {
				nearest[i] = d
			}
		}
	}
	return seeds
}

// normalizeVec returns the L2-normalized copy of v (v unchanged). A zero vector
// is returned as-is.
func normalizeVec(v []float32) []float32 {
	var sum float64
	for _, x := range v {
		sum += float64(x) * float64(x)
	}
	if sum == 0 {
		return append([]float32(nil), v...)
	}
	inv := float32(1 / math.Sqrt(sum))
	out := make([]float32, len(v))
	for i, x := range v {
		out[i] = x * inv
	}
	return out
}

// meanNormalized returns the L2-normalized mean of pts. Cosine ranking is
// magnitude-invariant, so a normalized mean ranks identically to a raw average
// (the single-centroid fallback) — this is just for the k-collapses-to-1 case.
func meanNormalized(pts [][]float32) []float32 {
	if len(pts) == 0 {
		return nil
	}
	acc := make([]float32, len(pts[0]))
	for _, p := range pts {
		for d := range p {
			acc[d] += p[d]
		}
	}
	return normalizeVec(acc)
}

// interleaveMerge round-robins K ranked candidate lists into one — each list's
// #1, then each list's #2, … — deduping by item ID (first occurrence wins) and
// truncating to limit. This guarantees every taste mode (centroid) is
// represented near the top instead of one cluster dominating. Each input list
// is NearestUnwatched output, so it already carries Phase D 👎-exclusion and
// Phase B2 anti-repetition; the merge preserves them. Deterministic.
func interleaveMerge(lists [][]*models.MediaItem, limit int) []*models.MediaItem {
	seen := make(map[int64]struct{})
	out := make([]*models.MediaItem, 0, limit)
	maxLen := 0
	for _, l := range lists {
		if len(l) > maxLen {
			maxLen = len(l)
		}
	}
	for rank := 0; rank < maxLen && len(out) < limit; rank++ {
		for _, l := range lists {
			if rank >= len(l) {
				continue
			}
			it := l[rank]
			if it == nil {
				continue
			}
			if _, dup := seen[it.ID]; dup {
				continue
			}
			seen[it.ID] = struct{}{}
			out = append(out, it)
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}

// tasteRecall is the Phase E1 entry point that replaces the single
// BuildProfileVector→NearestUnwatched pair in hero.build / discover.buildDiscover.
// It clusters the profile's recency slice into K taste modes and merges
// per-centroid recall, or falls back cleanly to the single averaged centroid on
// any of: the feature being off, sparse history, or any clustering/recall error.
// ErrInsufficientHistory propagates unchanged so cold-start branches still fire.
func (h *Hero) tasteRecall(ctx context.Context, profileID int64, pool int, allowed []string, surface string, within int64) ([]*models.MediaItem, error) {
	if h.tasteCentroids <= 1 {
		return h.singleCentroidRecall(ctx, profileID, pool, allowed, surface, within)
	}
	rows, err := h.q.ProfileEmbeddingSlice(ctx, profileID)
	if err != nil {
		if err == db.ErrInsufficientHistory {
			return nil, err // cold-start — let the caller fall back to popular
		}
		slog.Warn("taste: embedding slice failed, single centroid", "profile", profileID, "error", err)
		return h.singleCentroidRecall(ctx, profileID, pool, allowed, surface, within)
	}
	k := kForN(len(rows), h.tasteCentroids)
	if k <= 1 {
		return h.singleCentroidRecall(ctx, profileID, pool, allowed, surface, within)
	}
	centroids, err := computeTasteCentroids(rows, k)
	if err != nil || len(centroids) == 0 {
		slog.Warn("taste: clustering failed, single centroid", "profile", profileID, "error", err)
		return h.singleCentroidRecall(ctx, profileID, pool, allowed, surface, within)
	}
	// Recall the full pool per centroid (HNSW kNN is sub-ms; full-each maximizes
	// mode coverage), then interleave. A single centroid (taste collapsed) is
	// just a degenerate merge.
	lists := make([][]*models.MediaItem, 0, len(centroids))
	for _, c := range centroids {
		cands, err := h.q.NearestUnwatched(ctx, profileID, c, pool, allowed, surface, within)
		if err != nil {
			slog.Warn("taste: per-centroid recall failed, single centroid", "profile", profileID, "error", err)
			return h.singleCentroidRecall(ctx, profileID, pool, allowed, surface, within)
		}
		lists = append(lists, cands)
	}
	return interleaveMerge(lists, pool), nil
}

// singleCentroidRecall is the pre-Phase-E path: one averaged taste vector →
// NearestUnwatched. Returns ErrInsufficientHistory (cold-start) verbatim.
func (h *Hero) singleCentroidRecall(ctx context.Context, profileID int64, pool int, allowed []string, surface string, within int64) ([]*models.MediaItem, error) {
	vec, err := h.q.BuildProfileVector(ctx, profileID)
	if err != nil {
		return nil, err
	}
	return h.q.NearestUnwatched(ctx, profileID, vec, pool, allowed, surface, within)
}
