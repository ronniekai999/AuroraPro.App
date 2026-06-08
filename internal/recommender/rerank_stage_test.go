package recommender

import (
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

func TestBuildTasteQuery(t *testing.T) {
	if q := buildTasteQuery(nil); q != "" {
		t.Errorf("nil anchors → want empty, got %q", q)
	}
	anchors := []db.TasteAnchor{
		{Title: "Ghost Whisperer", Genres: []string{"Drama", "Mystery", "Sci-Fi & Fantasy"}},
		{Title: "Ghost Whisperer", Genres: []string{"Drama"}}, // repeat — must dedupe
		{Title: "Drake & Josh", Genres: []string{"Comedy"}},
	}
	q := buildTasteQuery(anchors)
	if !strings.HasPrefix(q, "A viewer who enjoys:") {
		t.Errorf("missing prefix: %q", q)
	}
	if c := strings.Count(q, "Ghost Whisperer"); c != 1 {
		t.Errorf("repeated anchor not deduped (appears %d times): %q", c, q)
	}
	if !strings.Contains(q, "Drake & Josh") {
		t.Errorf("second anchor dropped: %q", q)
	}
}

func TestBuildCandidateDoc(t *testing.T) {
	d := buildCandidateDoc(&models.MediaItem{
		Title: "Holland", Year: 2025,
		Genres:   []string{"Mystery", "Thriller"},
		Overview: "A twisted tale of suspicion.",
	})
	for _, want := range []string{"Holland (2025)", "Mystery", "twisted"} {
		if !strings.Contains(d, want) {
			t.Errorf("doc %q missing %q", d, want)
		}
	}
	// Minimal item (no year/genres/overview) still renders the title.
	if got := buildCandidateDoc(&models.MediaItem{Title: "X"}); got != "X" {
		t.Errorf("minimal doc = %q, want %q", got, "X")
	}
}

func TestCapCandidates(t *testing.T) {
	items := make([]*models.MediaItem, 5)
	for i := range items {
		items[i] = &models.MediaItem{ID: int64(i)}
	}
	if got := capCandidates(items, 3); len(got) != 3 {
		t.Errorf("cap to 3: got %d", len(got))
	}
	if got := capCandidates(items, 10); len(got) != 5 {
		t.Errorf("keep>len keeps all: got %d", len(got))
	}
	if got := capCandidates(items, 0); len(got) != 5 {
		t.Errorf("keep<=0 keeps all: got %d", len(got))
	}
}

// TestDebiasOrder verifies the position-bias shuffle is (a) a true permutation
// (no loss/dup), (b) deterministic per profile id (stable within a cache
// window), and (c) non-mutating on the input slice.
func TestDebiasOrder(t *testing.T) {
	items := make([]*models.MediaItem, 8)
	for i := range items {
		items[i] = &models.MediaItem{ID: int64(i + 1)}
	}
	a := debiasOrder(items, 42)
	b := debiasOrder(items, 42)
	if len(a) != 8 {
		t.Fatalf("length changed: %d", len(a))
	}
	// Deterministic for the same profile id.
	for i := range a {
		if a[i].ID != b[i].ID {
			t.Fatalf("non-deterministic at %d: %d vs %d", i, a[i].ID, b[i].ID)
		}
	}
	// Permutation: every original id present exactly once.
	seen := map[int64]int{}
	for _, it := range a {
		seen[it.ID]++
	}
	if len(seen) != 8 {
		t.Errorf("membership changed: %v", seen)
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("id %d appears %d times", id, n)
		}
	}
	// Input not mutated.
	if items[0].ID != 1 {
		t.Errorf("debiasOrder mutated its input slice")
	}
	// Tiny slices returned unchanged.
	if got := debiasOrder(items[:2], 7); len(got) != 2 {
		t.Errorf("tiny slice length = %d", len(got))
	}
}
