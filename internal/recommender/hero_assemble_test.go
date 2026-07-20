package recommender

import (
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

// assembleHeroPicks is the LLM-output → hero-pool binding extracted from
// rerankWithBlurbs. These tests pin the two behaviors added for the
// 2026-07-20 hero-blurb regression: reasons are vetted against candidate
// metadata, and a dropped reason keeps the pick (blurbless) rather than
// dropping the pick.

// One of the two production screenshot blurbs (the guard's own tests in
// internal/reasonguard own the full pair) — duplicated here as a literal
// fixture so the hero-binding test exercises the real overlong shape
// end-to-end through assembleHeroPicks.
const screenshotBurbsBlurb = "Because you watched The Day After Tomorrow (2004) — Adventure, Science Fiction, " +
	"Thriller, this supernatural drama blends mystery with a dark, atmospheric tone."

func assembleTestCandidates() []*models.MediaItem {
	return []*models.MediaItem{
		{ID: 1, Title: "The 'Burbs", Year: 2026, Type: models.MediaMovie,
			Genres: []string{"Comedy"}, ContentRating: "PG-13"},
		{ID: 2, Title: "The Exorcist", Year: 1973, Type: models.MediaMovie,
			Genres: []string{"Drama", "Horror"}, ContentRating: "R"},
		{ID: 3, Title: "Severance", Year: 2022, Type: models.MediaShow,
			Genres: []string{"Drama", "Sci-Fi"}, ContentRating: "TV-MA"},
		{ID: 4, Title: "Paddington", Year: 2014, Type: models.MediaMovie,
			Genres: []string{"Comedy", "Family"}, ContentRating: "PG"},
	}
}

func TestAssembleHeroPicks_VetsReasonsButKeepsPicks(t *testing.T) {
	candidates := assembleTestCandidates()
	parsed := []heroRerankPick{
		// Screenshot regression: overlong + tone-contradicting blurb on the
		// pure-comedy candidate — pick must survive with an EMPTY reason.
		{Index: 1, Reason: screenshotBurbsBlurb},
		// Short but contradicting the R rating — same outcome.
		{Index: 2, Reason: "A family-friendly fantasy edge"},
		// Clean, grounded reason — passes through untouched.
		{Index: 3, Reason: "Because you finished Severance"},
	}
	picks := assembleHeroPicks(parsed, candidates, nil, 3)
	if len(picks) != 3 {
		t.Fatalf("got %d picks, want 3", len(picks))
	}
	if picks[0].Item.ID != 1 || picks[0].Reason != "" {
		t.Errorf("pick 0: want item 1 with vetoed (empty) reason, got item %d reason %q",
			picks[0].Item.ID, picks[0].Reason)
	}
	if picks[1].Item.ID != 2 || picks[1].Reason != "" {
		t.Errorf("pick 1: want item 2 with vetoed (empty) reason, got item %d reason %q",
			picks[1].Item.ID, picks[1].Reason)
	}
	if picks[2].Item.ID != 3 || picks[2].Reason != "Because you finished Severance" {
		t.Errorf("pick 2: want item 3 with clean reason, got item %d reason %q",
			picks[2].Item.ID, picks[2].Reason)
	}
}

func TestAssembleHeroPicks_DedupAndScoreOrderedFill(t *testing.T) {
	candidates := assembleTestCandidates()
	scores := map[int64]int{1: 10, 2: 90, 3: 50, 4: 70}
	parsed := []heroRerankPick{
		{Index: 1, Reason: "Suburban comedy pick"},
		{Index: 1, Reason: "duplicate must be ignored"},
	}
	picks := assembleHeroPicks(parsed, candidates, scores, 3)
	if len(picks) != 3 {
		t.Fatalf("got %d picks, want 3", len(picks))
	}
	// First slot: the LLM's pick. Fill slots: unused candidates by Aurora
	// Score descending (2:90 then 4:70), reasons empty.
	wantIDs := []int64{1, 2, 4}
	for i, want := range wantIDs {
		if picks[i].Item.ID != want {
			t.Errorf("pick %d: got item %d, want %d", i, picks[i].Item.ID, want)
		}
	}
	if picks[1].Reason != "" || picks[2].Reason != "" {
		t.Errorf("filler picks must have no reason, got %q / %q", picks[1].Reason, picks[2].Reason)
	}
}

func TestAssembleHeroPicks_TitleFallback(t *testing.T) {
	candidates := assembleTestCandidates()
	parsed := []heroRerankPick{
		// Index missing (0) — resolve by "Title (YEAR)" form, and the clean
		// reason must survive vetting on the hybrid-genre candidate.
		{Index: 0, Title: "The Exorcist (1973)", Reason: "Chilling classic like your late-night picks"},
	}
	picks := assembleHeroPicks(parsed, candidates, nil, 1)
	if len(picks) != 1 {
		t.Fatalf("got %d picks, want 1", len(picks))
	}
	if picks[0].Item.ID != 2 || picks[0].Reason != "Chilling classic like your late-night picks" {
		t.Errorf("title-fallback pick: got item %d reason %q", picks[0].Item.ID, picks[0].Reason)
	}
}

// The hero prompt must surface candidate genres + content rating — the model
// grounds tone in them, and (post 2026-07-20) rerankWithBlurbs attaches
// genres before building this prompt specifically so this block renders.
func TestBuildRerankPrompt_RendersCandidateGenresAndRating(t *testing.T) {
	anchors := []db.TasteAnchor{
		{Title: "The Day After Tomorrow", Year: 2004, Type: "movie", ContentRating: "PG",
			Genres: []string{"Adventure", "Science Fiction", "Thriller"}},
	}
	candidates := assembleTestCandidates()
	out := buildRerankPrompt(anchors, candidates, map[int64]int{1: 48})

	if !strings.Contains(out, "[Comedy]") {
		t.Errorf("prompt missing candidate genre tag [Comedy]:\n%s", out)
	}
	if !strings.Contains(out, "[Drama, Horror]") {
		t.Errorf("prompt missing candidate genre tag [Drama, Horror]:\n%s", out)
	}
	if !strings.Contains(out, "[PG-13]") || !strings.Contains(out, "[R]") {
		t.Errorf("prompt missing candidate content ratings:\n%s", out)
	}
	if !strings.Contains(out, "[Aurora 48]") {
		t.Errorf("prompt missing Aurora score tag:\n%s", out)
	}
	// Anchor rating + genre grounding: the anchor line must carry its content
	// rating (audience-tier baseline for the 2026-07-20 tier-fit fix) between
	// the type and the genre list.
	if !strings.Contains(out, "The Day After Tomorrow (2004) [movie] [PG] — Adventure, Science Fiction, Thriller") {
		t.Errorf("prompt missing anchor rating+genre line:\n%s", out)
	}
}

func TestSuppressWeakMatchReasons(t *testing.T) {
	picks := []HeroPick{
		{Item: &models.MediaItem{ID: 1}, Reason: "strong pick", Match: 48},
		{Item: &models.MediaItem{ID: 2}, Reason: "weak pick", Match: 32},
		{Item: &models.MediaItem{ID: 3}, Reason: "borderline", Match: heroReasonMatchFloor},
		// Cold-start pick: Match 0 means "no personal calibration", not
		// "weak" — its (empty) reason state must not be touched.
		{Item: &models.MediaItem{ID: 4}, Reason: "", Match: 0},
	}
	suppressWeakMatchReasons(picks)
	if picks[0].Reason != "strong pick" {
		t.Errorf("above-floor reason must survive, got %q", picks[0].Reason)
	}
	if picks[1].Reason != "" {
		t.Errorf("below-floor reason must be suppressed, got %q", picks[1].Reason)
	}
	if picks[2].Reason != "borderline" {
		t.Errorf("at-floor reason must survive, got %q", picks[2].Reason)
	}
	if picks[3].Reason != "" {
		t.Errorf("cold-start pick must stay reasonless, got %q", picks[3].Reason)
	}
}
