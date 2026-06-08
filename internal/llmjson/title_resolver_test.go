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

// TestResolveByTitle_StripsTrailingTypeTag: gpt-oss:120b (observed
// 2026-05-21 in hero rerank logs) emits picks formatted as
// `"Lizzie McGuire (2001) [show]"` — mirroring buildRerankPrompt's
// candidate-list format verbatim. Before this fix, the trailing
// `[show]` made the lookup fail (index seeds `Title` and
// `Title (YEAR)` only), all picks got dropped, and the hero rail
// silently fell back to vector order with no reasons.
func TestResolveByTitle_StripsTrailingTypeTag(t *testing.T) {
	items := []fakeCand{
		{title: "Lizzie McGuire", year: 2001},
		{title: "The Conjuring", year: 2013},
	}
	idx := BuildCandidateTitleIndex(items, extractFake)

	// Title (year) [type] — the canonical gpt-oss:120b shape.
	got, ok := ResolveByTitle(idx, "Lizzie McGuire (2001) [show]")
	if !ok || got != 0 {
		t.Errorf("'Title (year) [type]' should resolve to 0, got %d ok=%v", got, ok)
	}
	// Title [type] — same pattern without the year.
	got, ok = ResolveByTitle(idx, "The Conjuring [movie]")
	if !ok || got != 1 {
		t.Errorf("'Title [type]' should resolve to 1, got %d ok=%v", got, ok)
	}
	// Case-insensitive after stripping.
	got, ok = ResolveByTitle(idx, "LIZZIE MCGUIRE (2001) [SHOW]")
	if !ok || got != 0 {
		t.Errorf("uppercase tagged title should resolve to 0, got %d ok=%v", got, ok)
	}
}

// TestResolveByTitle_PreservesMidTitleBrackets: a title that legitimately
// contains brackets (mid-string, not trailing) should NOT have those
// brackets stripped. Guards against the resolver going too aggressive on
// the strip step. We don't currently know of media titles with mid-bracket
// content, but the regex deliberately anchors to `$` to keep this safe.
func TestResolveByTitle_PreservesMidTitleBrackets(t *testing.T) {
	items := []fakeCand{
		{title: "Doctor Who", year: 2005},
	}
	idx := BuildCandidateTitleIndex(items, extractFake)
	// Title with a mid-string bracket sequence — should NOT match
	// Doctor Who because we don't strip mid-string brackets.
	if _, ok := ResolveByTitle(idx, "Doctor [Who] (2005)"); ok {
		t.Error("mid-string brackets should NOT be stripped — would cause false positives")
	}
}

// TestResolveByTitle_StripsTagOnTitleWithoutYearInIndex: the index has
// a bare title (no year). LLM emits the title with a tag suffix but no
// year. Stripping the tag should resolve back to the bare title.
func TestResolveByTitle_StripsTagOnTitleWithoutYearInIndex(t *testing.T) {
	items := []fakeCand{{title: "Cosmic Drift", year: 0}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	got, ok := ResolveByTitle(idx, "Cosmic Drift [show]")
	if !ok || got != 0 {
		t.Errorf("bare title with tag should resolve, got %d ok=%v", got, ok)
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

// TestResolveByTitle_LooseSuperscriptDrop: the observed production drift —
// gpt-oss emitted "The Accountant" for the candidate "The Accountant²". The
// loose normalized key recovers it.
func TestResolveByTitle_LooseSuperscriptDrop(t *testing.T) {
	items := []fakeCand{{title: "The Accountant²", year: 2025}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	if got, ok := ResolveByTitle(idx, "The Accountant"); !ok || got != 0 {
		t.Errorf("dropped-superscript title should resolve via loose key, got %d ok=%v", got, ok)
	}
}

// TestResolveByTitle_LooseSubtitleDrop: model drops the subtitle.
func TestResolveByTitle_LooseSubtitleDrop(t *testing.T) {
	items := []fakeCand{{title: "The Conjuring: Last Rites", year: 2025}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	if got, ok := ResolveByTitle(idx, "The Conjuring"); !ok || got != 0 {
		t.Errorf("dropped-subtitle title should resolve via loose key, got %d ok=%v", got, ok)
	}
}

// TestResolveByTitle_LooseAmpersand: "&" vs "and".
func TestResolveByTitle_LooseAmpersand(t *testing.T) {
	items := []fakeCand{{title: "Drake & Josh", year: 2004}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	if got, ok := ResolveByTitle(idx, "Drake and Josh"); !ok || got != 0 {
		t.Errorf("'and' vs '&' should resolve via loose key, got %d ok=%v", got, ok)
	}
}

// TestResolveByTitle_LooseAccentFold: accented candidate, unaccented pick.
func TestResolveByTitle_LooseAccentFold(t *testing.T) {
	items := []fakeCand{{title: "Amélie", year: 2001}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	if got, ok := ResolveByTitle(idx, "Amelie"); !ok || got != 0 {
		t.Errorf("accent-folded title should resolve via loose key, got %d ok=%v", got, ok)
	}
}

// TestResolveByTitle_LooseAmbiguousDropped: two candidates share a pre-colon
// part, so that loose key is ambiguous and must NOT resolve — we never fuzzy
// match into the wrong pick.
func TestResolveByTitle_LooseAmbiguousDropped(t *testing.T) {
	items := []fakeCand{
		{title: "The Thing: Alpha", year: 2020},
		{title: "The Thing: Beta", year: 2021},
	}
	idx := BuildCandidateTitleIndex(items, extractFake)
	if _, ok := ResolveByTitle(idx, "The Thing"); ok {
		t.Error("ambiguous loose key (two subtitled candidates) must NOT resolve")
	}
}

// TestResolveByTitle_ExactBeatsLoose: the loose tier is LAST resort — an exact
// match on one candidate wins even when another candidate has a loose key.
func TestResolveByTitle_ExactBeatsLoose(t *testing.T) {
	items := []fakeCand{
		{title: "Heat", year: 1995},     // exact owner of "Heat"
		{title: "Heaters²", year: 2025}, // loose-normalizes to "heaters"
	}
	idx := BuildCandidateTitleIndex(items, extractFake)
	if got, ok := ResolveByTitle(idx, "Heat"); !ok || got != 0 {
		t.Errorf("exact match must win over any loose key, got %d ok=%v", got, ok)
	}
}

// TestResolveByTitle_ShortPickSkipsLoose: a <3-char pick never reaches the loose
// tier (length-guarded), so it cleanly misses rather than over-matching.
func TestResolveByTitle_ShortPickSkipsLoose(t *testing.T) {
	items := []fakeCand{{title: "Severance", year: 2022}}
	idx := BuildCandidateTitleIndex(items, extractFake)
	if _, ok := ResolveByTitle(idx, "Se"); ok {
		t.Error("2-char pick should not resolve via the loose tier")
	}
}
