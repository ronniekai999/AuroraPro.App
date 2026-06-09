package embedding

import (
	"strings"
	"testing"
)

func TestAudienceClause(t *testing.T) {
	cases := map[string]string{
		"G":       " For family and general audiences.",
		"TV-Y7":   " For family and general audiences.",
		"tv-g":    " For family and general audiences.", // case-insensitive
		"PG":      " For family and general audiences.",
		"TV-PG":   " For family and general audiences.",
		"PG-13":   " For teen and older audiences.",
		"TV-14":   " For teen and older audiences.",
		"R":       " For mature audiences.",
		"TV-MA":   " For mature audiences.",
		"NC-17":   " For mature audiences.",
		"  R  ":   " For mature audiences.", // trimmed
		"NR":      "",                       // unknown → no signal
		"Unrated": "",
		"":        "",
		"bogus":   "",
	}
	for rating, want := range cases {
		if got := audienceClause(rating); got != want {
			t.Errorf("audienceClause(%q) = %q, want %q", rating, got, want)
		}
	}
}

func TestBuildTextFoldsContentRating(t *testing.T) {
	// A gentle and an intense title with deliberately similar overviews must
	// produce DIFFERENT text via the audience cue (the whole point of E2b).
	gentle := BuildText("Ghost Whisperer", 2005, "show",
		"A woman who can see and communicate with ghosts helps spirits resolve their unfinished business.",
		[]string{"Drama", "Mystery"}, "TV-PG")
	intense := BuildText("The Ritual", 2025, "movie",
		"A haunted soul confronts vengeful ghosts and unfinished business in a terrifying exorcism.",
		[]string{"Horror", "Thriller"}, "R")

	if !strings.HasSuffix(gentle, "For family and general audiences.") {
		t.Errorf("gentle title missing family cue: %q", gentle)
	}
	if !strings.HasSuffix(intense, "For mature audiences.") {
		t.Errorf("intense title missing mature cue: %q", intense)
	}
	// Sanity: genres still present, structure intact.
	if !strings.Contains(gentle, "Genres: Drama, Mystery.") {
		t.Errorf("genres clause malformed: %q", gentle)
	}
}

func TestBuildTextGatesClauseOnEmptyContent(t *testing.T) {
	// A rated item with NO overview and NO genres (pre-enrichment / unmatched)
	// must NOT get the audience clause — otherwise the fixed phrase dominates the
	// vector and clusters by rating tier instead of content.
	got := BuildText("Saw", 2004, "movie", "", nil, "R")
	if strings.Contains(got, "audiences") {
		t.Errorf("title-only item must not get a tone-dominating audience clause: %q", got)
	}
	// But a rated item with just genres (no overview) is rich enough to keep it.
	withGenres := BuildText("Saw", 2004, "movie", "", []string{"Horror"}, "R")
	if !strings.HasSuffix(withGenres, "For mature audiences.") {
		t.Errorf("item with genres should keep the audience clause: %q", withGenres)
	}
}

func TestBuildTextOmitsUnknownRating(t *testing.T) {
	// No rating → no trailing audience clause, no structural noise.
	got := BuildText("Some Film", 2020, "movie", "An overview.", []string{"Drama"}, "")
	if strings.Contains(got, "audiences") {
		t.Errorf("empty rating should add no audience clause: %q", got)
	}
	if !strings.HasSuffix(got, "Genres: Drama.") {
		t.Errorf("want text to end at genres when no rating: %q", got)
	}
}
