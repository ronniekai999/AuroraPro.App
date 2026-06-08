package recommender

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand"
	"sort"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

// Phase B — cross-encoder reranking + position-bias correction.
//
// When a reranker model is configured we recall a LARGER pool from vector
// search (so the cross-encoder has room to surface better candidates than the
// bi-encoder cosine order), score every candidate against the user's taste with
// the reranker, then keep the top-K for the existing Aurora + listwise-LLM
// blend. With no reranker configured the recall pool stays the prior size and
// the rerank step is skipped — behavior is unchanged except for the position
// debias below, which applies on both paths.
const (
	rerankHeroRecall     = 40 // hero recall pool when reranking (narrowed to candidatePool)
	rerankDiscoverRecall = 50 // discover recall pool when reranking (narrowed to discoverPoolSize)
	rerankAnchorCount    = 12 // recent anchors summarized into the reranker's taste query
	rerankBudget         = 8 * time.Second
)

// rerankEnabled reports whether a cross-encoder reranker is configured.
func (h *Hero) rerankEnabled() bool {
	return h.llm != nil && h.llm.RerankModelName() != ""
}

// heroRecallPool / discoverRecallPool return how many candidates to pull from
// vector search: a larger pool when reranking is on (the cross-encoder narrows
// it back down), otherwise the existing pool size (unchanged behavior).
func (h *Hero) heroRecallPool() int {
	if h.rerankEnabled() {
		return rerankHeroRecall
	}
	return h.candidatePool
}

func (h *Hero) discoverRecallPool() int {
	if h.rerankEnabled() {
		return rerankDiscoverRecall
	}
	return discoverPoolSize
}

// rerankCandidates reorders candidates by cross-encoder relevance to the user's
// taste (built from anchors) and returns the top `keep`. Graceful in every
// failure mode: if reranking is disabled, the taste query is empty (cold start),
// the reranker errors/unreachable, or the score count mismatches, it returns the
// first `keep` candidates unchanged — i.e. the existing vector order.
func (h *Hero) rerankCandidates(ctx context.Context, anchors []db.TasteAnchor, candidates []*models.MediaItem, keep int) []*models.MediaItem {
	if !h.rerankEnabled() || len(candidates) <= 1 {
		return capCandidates(candidates, keep)
	}
	query := buildTasteQuery(anchors)
	if query == "" {
		return capCandidates(candidates, keep)
	}
	docs := make([]string, len(candidates))
	for i, c := range candidates {
		docs[i] = buildCandidateDoc(c)
	}
	rctx, cancel := context.WithTimeout(ctx, rerankBudget)
	defer cancel()
	scores, err := h.llm.Rerank(rctx, query, docs)
	if err != nil || len(scores) != len(candidates) {
		if err != nil {
			slog.Warn("rerank: cross-encoder failed, keeping vector order",
				"error", err, "candidates", len(candidates))
		}
		return capCandidates(candidates, keep)
	}
	order := make([]int, len(candidates))
	for i := range order {
		order[i] = i
	}
	// Stable sort: ties (and the degenerate all-equal case) preserve the
	// original vector order, so a flat reranker never scrambles a good pool.
	sort.SliceStable(order, func(a, b int) bool { return scores[order[a]] > scores[order[b]] })
	out := make([]*models.MediaItem, len(candidates))
	for rank, i := range order {
		out[rank] = candidates[i]
	}
	return capCandidates(out, keep)
}

// capCandidates returns the first keep items (or all, if fewer / keep<=0).
func capCandidates(items []*models.MediaItem, keep int) []*models.MediaItem {
	if keep > 0 && len(items) > keep {
		return items[:keep]
	}
	return items
}

// buildTasteQuery turns the recent watch anchors into a one-line taste
// description for the cross-encoder query. Anchors repeat the same title many
// times (one row per play), so we dedupe by title and cap the breadth. Returns
// "" when there are no usable anchors (cold start) so the caller skips reranking.
func buildTasteQuery(anchors []db.TasteAnchor) string {
	if len(anchors) == 0 {
		return ""
	}
	seen := make(map[string]bool, len(anchors))
	parts := make([]string, 0, 6)
	for _, a := range anchors {
		t := strings.TrimSpace(a.Title)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		p := t
		if len(a.Genres) > 0 {
			gs := a.Genres
			if len(gs) > 3 {
				gs = gs[:3]
			}
			p += " (" + strings.Join(gs, ", ") + ")"
		}
		parts = append(parts, p)
		if len(parts) >= 6 {
			break
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "A viewer who enjoys: " + strings.Join(parts, "; ")
}

// buildCandidateDoc renders a candidate as the cross-encoder "document":
// title (year), genres (when annotated), and a clipped overview.
func buildCandidateDoc(c *models.MediaItem) string {
	var b strings.Builder
	b.WriteString(c.Title)
	if c.Year > 0 {
		fmt.Fprintf(&b, " (%d)", c.Year)
	}
	if len(c.Genres) > 0 {
		gs := c.Genres
		if len(gs) > 4 {
			gs = gs[:4]
		}
		b.WriteString(" — ")
		b.WriteString(strings.Join(gs, ", "))
	}
	if c.Overview != "" {
		ov := c.Overview
		if len(ov) > 300 {
			ov = ov[:300]
		}
		b.WriteString(". ")
		b.WriteString(ov)
	}
	return b.String()
}

// debiasOrder returns a deterministically-shuffled COPY of candidates so the
// downstream listwise LLM judges on merit, not input position. LLMs over-weight
// earlier-listed items, and after cross-encoder reranking the input arrives
// sorted best-first — which would compound that bias into "just take the top
// few." Shuffling breaks the position↔pre-rank correlation while the Aurora
// score (in the prompt) and the overview still let the model judge quality.
//
// The shuffle is seeded by profileID so it's stable within a cache window and
// reproducible in tests. Downstream pick resolution is index-based over THIS
// returned slice, so reordering is safe.
func debiasOrder(candidates []*models.MediaItem, profileID int64) []*models.MediaItem {
	if len(candidates) <= 2 {
		return candidates
	}
	out := make([]*models.MediaItem, len(candidates))
	copy(out, candidates)
	// Mix the profile id with a fixed odd constant so adjacent profile ids don't
	// produce near-identical permutations.
	r := rand.New(rand.NewSource(profileID*0x9E3779B1 + 0x632BE5AB))
	r.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}
