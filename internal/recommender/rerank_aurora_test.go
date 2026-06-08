package recommender

import (
	"context"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

// TestBuildRerankPromptInjectsAuroraScore: each candidate with a score in the
// map gets an "[Aurora NN]" tag in the prompt (the LLM's quality prior).
func TestBuildRerankPromptInjectsAuroraScore(t *testing.T) {
	anchors := []db.TasteAnchor{{Title: "Severance", Year: 2022, Type: "show"}}
	candidates := []*models.MediaItem{
		{ID: 1, Title: "Counterpart", Year: 2017, Type: models.MediaShow},
		{ID: 2, Title: "Dark", Year: 2017, Type: models.MediaShow},
	}
	scores := map[int64]int{1: 87, 2: 64}
	out := buildRerankPrompt(anchors, candidates, scores)
	if !strings.Contains(out, "[Aurora 87]") || !strings.Contains(out, "[Aurora 64]") {
		t.Errorf("expected both Aurora tags in prompt, got:\n%s", out)
	}
}

// TestBuildRerankPromptOmitsMissingScore: when scores are absent (scoring
// failed), no "[Aurora ...]" tag is printed — degrade to taste-only, not
// "[Aurora 0]".
func TestBuildRerankPromptOmitsMissingScore(t *testing.T) {
	anchors := []db.TasteAnchor{{Title: "X", Year: 2000, Type: "movie"}}
	candidates := []*models.MediaItem{{ID: 9, Title: "Y", Year: 2001, Type: models.MediaMovie}}
	if out := buildRerankPrompt(anchors, candidates, nil); strings.Contains(out, "[Aurora") {
		t.Errorf("expected no Aurora tag when scores absent, got:\n%s", out)
	}
}

// TestCandidateOrderByScoreDesc: indices come back ordered by score desc.
func TestCandidateOrderByScoreDesc(t *testing.T) {
	candidates := []*models.MediaItem{{ID: 1}, {ID: 2}, {ID: 3}}
	scores := map[int64]int{1: 50, 2: 90, 3: 70}
	order := candidateOrderByScore(candidates, scores) // 90→idx1, 70→idx2, 50→idx0
	if want := []int{1, 2, 0}; order[0] != want[0] || order[1] != want[1] || order[2] != want[2] {
		t.Errorf("order = %v, want %v", order, want)
	}
}

// TestTopNScoredPicksHighest: the degraded-path fallback leads with the
// strongest items.
func TestTopNScoredPicksHighest(t *testing.T) {
	candidates := []*models.MediaItem{{ID: 1, Title: "low"}, {ID: 2, Title: "high"}, {ID: 3, Title: "mid"}}
	scores := map[int64]int{1: 10, 2: 95, 3: 50}
	picks := topNScored(candidates, scores, 2)
	if len(picks) != 2 || picks[0].Item.ID != 2 || picks[1].Item.ID != 3 {
		t.Errorf("want picks [2,3], got %+v", picks)
	}
}

// TestTopNScoredStableTies: equal scores preserve original (vector) order.
func TestTopNScoredStableTies(t *testing.T) {
	candidates := []*models.MediaItem{{ID: 1}, {ID: 2}, {ID: 3}}
	scores := map[int64]int{1: 50, 2: 50, 3: 50}
	picks := topNScored(candidates, scores, 3)
	for i, want := range []int64{1, 2, 3} {
		if picks[i].Item.ID != want {
			t.Errorf("tie order picks[%d]=%d want %d", i, picks[i].Item.ID, want)
		}
	}
}

// TestRerankWithBlurbsNilLLMUsesScoreOrder: with no LLM the rerank takes the
// degraded path and returns the top picks ordered by Aurora Score (not vector
// order). Exercises the function's own wiring, not just the helpers. llm==nil
// returns before any q/ctx use, so a bare &Hero is enough.
func TestRerankWithBlurbsNilLLMUsesScoreOrder(t *testing.T) {
	h := &Hero{poolSize: 3}
	candidates := []*models.MediaItem{{ID: 1}, {ID: 2}, {ID: 3}, {ID: 4}}
	candScores := map[int64]int{1: 20, 2: 99, 3: 60, 4: 80}
	picks, q := h.rerankWithBlurbs(context.Background(), 1, candidates, candScores)
	if q != qualityFallback {
		t.Errorf("nil-llm quality = %v, want qualityFallback", q)
	}
	if len(picks) != 3 {
		t.Fatalf("want 3 picks, got %d", len(picks))
	}
	for i, want := range []int64{2, 4, 3} { // top 3 by score desc
		if picks[i].Item.ID != want {
			t.Errorf("picks[%d]=%d want %d", i, picks[i].Item.ID, want)
		}
	}
}

// TestAuroraScoresEmptyItems: empty input returns an empty map without touching
// the DB (q is nil here — must not be dereferenced).
func TestAuroraScoresEmptyItems(t *testing.T) {
	h := &Hero{}
	if got := h.auroraScores(context.Background(), nil); len(got) != 0 {
		t.Errorf("empty items should yield empty map, got %v", got)
	}
}
