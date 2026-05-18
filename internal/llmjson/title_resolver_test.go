package llmjson

import (
	"testing"
)

// fakeCand is a minimal test type matching the (title, year) extractor
// signature. Avoids depending on internal/models from the test.
type fakeCand struct {
	title string
	year  int
}

func extractFake(c fakeCand) (string, int) { return c.title, c.year }

// TestBuildCandidateTitleIndex_BareSeed locks in the most basic invariant:
// every candidate's bare title gets indexed at its position.
func TestBuildCandidateTitleIndex_BareSeed(t *testing.T) {
	items := []fakeCand{
		{title: "The Conjuring", year: 2013},
		{title: "Severance", year: 2022},
	}
	idx := BuildCandidateTitleIndex(items, extractFake)
	if got, ok := idx["The Conjuring"]; !ok || got != 0 {
		t.Errorf("bare title 'The Conjuring' should map to 0, got %d ok=%v", got, ok)
	}
	if got, ok := idx["Severance"]; !ok || got != 1 {
		t.Errorf("bare title 'Severance' should map to 1, got %d ok=%v", got, ok)
	}
}

// TestBuildCandidateTitleIndex_LowercaseSeed locks in that the lowercase
// form is also seeded so case-insensitive lookups hit on the first pass.
func TestBuildCandidateTitleIndex_LowercaseSeed(t *testing.T) {
	items := []fakeCand{{title: "The Conjuring", year: 2013}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	if _, ok := idx["the conjuring"]; !ok {
		t.Errorf("lowercase form should be seeded, idx has %v", idx)
	}
}

// TestBuildCandidateTitleIndex_WithYearSeed covers the gemma3:12b shape:
// the model echoes titles back as "Title (YEAR)" because that's how
// candidates appear in the prompt. The index must include this form.
func TestBuildCandidateTitleIndex_WithYearSeed(t *testing.T) {
	items := []fakeCand{{title: "The Conjuring", year: 2013}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	if _, ok := idx["The Conjuring (2013)"]; !ok {
		t.Errorf("with-year form should be seeded, idx has %v", idx)
	}
	if _, ok := idx["the conjuring (2013)"]; !ok {
		t.Errorf("with-year lowercase form should be seeded, idx has %v", idx)
	}
}

// TestBuildCandidateTitleIndex_NoYearSkipsWithYear: candidates with
// Year=0 (or negative) should NOT get a "Title (0)" entry — that would
// be junk and could collide with a real "Title (0)" string.
func TestBuildCandidateTitleIndex_NoYearSkipsWithYear(t *testing.T) {
	items := []fakeCand{{title: "Untitled Project", year: 0}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	if _, ok := idx["Untitled Project (0)"]; ok {
		t.Errorf("Year=0 should NOT seed 'Title (0)', idx has %v", idx)
	}
	if _, ok := idx["Untitled Project"]; !ok {
		t.Errorf("bare title should still be seeded with Year=0, idx has %v", idx)
	}
}

// TestBuildCandidateTitleIndex_EmptyTitleSkipped: defensively skip items
// with empty titles (couldn't be meaningfully matched anyway).
func TestBuildCandidateTitleIndex_EmptyTitleSkipped(t *testing.T) {
	items := []fakeCand{
		{title: "", year: 2020},
		{title: "Real Movie", year: 2020},
	}
	idx := BuildCandidateTitleIndex(items, extractFake)
	if got, ok := idx["Real Movie"]; !ok || got != 1 {
		t.Errorf("Real Movie should map to 1 (index 0 skipped), got %d ok=%v", got, ok)
	}
}

// TestBuildCandidateTitleIndex_DuplicateLastWriteWins documents the
// known semantic: if two candidates share a title (and year), the
// later one in the slice wins. This is rare in practice — SQL dedup
// via tmdb_id collapses true duplicates — but un-enriched items
// (tmdb_id=0) survive dedup independently. The behavior is consistent
// across all three call sites since they now share this helper.
func TestBuildCandidateTitleIndex_DuplicateLastWriteWins(t *testing.T) {
	items := []fakeCand{
		{title: "It", year: 2017},
		{title: "It", year: 2017}, // unenriched dup
	}
	idx := BuildCandidateTitleIndex(items, extractFake)
	if got := idx["It"]; got != 1 {
		t.Errorf("duplicate title should map to LAST index (1), got %d", got)
	}
}

// TestResolveByTitle_ExactMatch is the happy path — gemma emits the
// exact bare title.
func TestResolveByTitle_ExactMatch(t *testing.T) {
	items := []fakeCand{{title: "The Conjuring", year: 2013}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	got, ok := ResolveByTitle(idx, "The Conjuring")
	if !ok || got != 0 {
		t.Errorf("exact match should resolve, got %d ok=%v", got, ok)
	}
}

// TestResolveByTitle_CaseInsensitive: gemma occasionally uppercases or
// lowercases titles. The second-pass case-insensitive lookup catches it.
func TestResolveByTitle_CaseInsensitive(t *testing.T) {
	items := []fakeCand{{title: "The Conjuring", year: 2013}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	got, ok := ResolveByTitle(idx, "THE CONJURING")
	if !ok || got != 0 {
		t.Errorf("uppercased title should resolve via lowercase pass, got %d ok=%v", got, ok)
	}
}

// TestResolveByTitle_WithYear: gemma's most common production shape.
func TestResolveByTitle_WithYear(t *testing.T) {
	items := []fakeCand{{title: "The Conjuring", year: 2013}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	got, ok := ResolveByTitle(idx, "The Conjuring (2013)")
	if !ok || got != 0 {
		t.Errorf("with-year title should resolve, got %d ok=%v", got, ok)
	}
}

// TestResolveByTitle_WithYearCaseInsensitive: a year-suffixed title in
// the wrong case still resolves via the seeded lowercase-with-year form.
func TestResolveByTitle_WithYearCaseInsensitive(t *testing.T) {
	items := []fakeCand{{title: "The Conjuring", year: 2013}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	got, ok := ResolveByTitle(idx, "THE CONJURING (2013)")
	if !ok || got != 0 {
		t.Errorf("upper-cased with-year should resolve, got %d ok=%v", got, ok)
	}
}

// TestResolveByTitle_NoMatch: a title not in the index returns
// (0, false). Critically, callers must check the bool — returning
// false should mean "skip this pick", not "pick index 0".
func TestResolveByTitle_NoMatch(t *testing.T) {
	items := []fakeCand{{title: "The Conjuring", year: 2013}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	got, ok := ResolveByTitle(idx, "Some Other Movie")
	if ok {
		t.Errorf("missing title should NOT resolve, got %d ok=%v", got, ok)
	}
}

// TestResolveByTitle_EmptyTitle: empty input is treated as miss, not
// silently resolved to position 0. Guards against a pick with no
// title/index leaking into the result list.
func TestResolveByTitle_EmptyTitle(t *testing.T) {
	items := []fakeCand{{title: "The Conjuring", year: 2013}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	_, ok := ResolveByTitle(idx, "")
	if ok {
		t.Error("empty title should NOT resolve")
	}
	_, ok = ResolveByTitle(idx, "   ")
	if ok {
		t.Error("whitespace-only title should NOT resolve")
	}
}

// TestResolveByTitle_TrimsWhitespace: a model that pads the title with
// surrounding whitespace should still resolve. Generous parsing.
func TestResolveByTitle_TrimsWhitespace(t *testing.T) {
	items := []fakeCand{{title: "The Conjuring", year: 2013}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	got, ok := ResolveByTitle(idx, "  The Conjuring  ")
	if !ok || got != 0 {
		t.Errorf("padded title should resolve, got %d ok=%v", got, ok)
	}
}

// TestBuildCandidateTitleIndexWithCollisions_NoCollisions: the unique
// case — collision count is 0 for distinct titles + years.
func TestBuildCandidateTitleIndexWithCollisions_NoCollisions(t *testing.T) {
	items := []fakeCand{
		{title: "The Conjuring", year: 2013},
		{title: "Severance", year: 2022},
	}
	_, count := BuildCandidateTitleIndexWithCollisions(items, extractFake)
	if count != 0 {
		t.Errorf("expected 0 collisions for distinct titles, got %d", count)
	}
}

// TestBuildCandidateTitleIndexWithCollisions_DetectsCollision: two
// items with same title + year produce 4 collisions (one per seeded
// form). Diagnostic value: any non-zero count means the resolver
// can't disambiguate via title alone, which is the bug-class L14
// asked to surface.
func TestBuildCandidateTitleIndexWithCollisions_DetectsCollision(t *testing.T) {
	items := []fakeCand{
		{title: "It", year: 2017},
		{title: "It", year: 2017},
	}
	_, count := BuildCandidateTitleIndexWithCollisions(items, extractFake)
	if count != 4 {
		t.Errorf("expected 4 collisions (bare + lower + with-year + with-year-lower), got %d", count)
	}
}

// TestBuildCandidateTitleIndexWithCollisions_CaseCollision: a title
// that's lowercase-identical to another (e.g. "It" and "it") collides
// on the lowercase-seed step only — count=1, not 4.
func TestBuildCandidateTitleIndexWithCollisions_CaseCollision(t *testing.T) {
	items := []fakeCand{
		{title: "It", year: 2017},
		{title: "it", year: 2020}, // different year + case → only lowercase collides
	}
	_, count := BuildCandidateTitleIndexWithCollisions(items, extractFake)
	if count != 1 {
		t.Errorf("expected 1 collision (lowercase only), got %d", count)
	}
}
