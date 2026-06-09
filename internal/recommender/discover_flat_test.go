package recommender

import "testing"

// Covers parseDiscoverFlat — the Phase F flat-shape parser that groups a single
// rail-tagged picks array back into rails, with a fall-through to nil so the
// caller can use the legacy nested parser.

func TestParseDiscoverFlatGroups(t *testing.T) {
	raw := `{"picks":[
		{"rail_title":"Slow-burn Dread","rail_description":"Quiet horror","index":3,"reason":"r3"},
		{"rail_title":"Slow-burn Dread","rail_description":"","index":7,"reason":"r7"},
		{"rail_title":"Whodunit Puzzlers","rail_description":"Twisty mysteries","index":1,"reason":"r1"}
	]}`
	specs := parseDiscoverFlat(raw)
	if len(specs) != 2 {
		t.Fatalf("want 2 rails, got %d: %+v", len(specs), specs)
	}
	if specs[0].Title != "Slow-burn Dread" || specs[0].Description != "Quiet horror" {
		t.Errorf("rail 0 title/desc wrong: %+v", specs[0])
	}
	if len(specs[0].Picks) != 2 || specs[0].Picks[0].Index != 3 || specs[0].Picks[1].Index != 7 {
		t.Errorf("rail 0 picks wrong: %+v", specs[0].Picks)
	}
	if specs[0].Picks[0].Reason != "r3" {
		t.Errorf("reason not carried: %+v", specs[0].Picks[0])
	}
	// Rail order follows first appearance.
	if specs[1].Title != "Whodunit Puzzlers" || len(specs[1].Picks) != 1 || specs[1].Picks[0].Index != 1 {
		t.Errorf("rail 1 wrong: %+v", specs[1])
	}
}

func TestParseDiscoverFlatCaseInsensitiveMerge(t *testing.T) {
	// Same rail name with differing case/whitespace collapses into one rail;
	// the first-seen display title and first non-empty description win.
	raw := `{"picks":[
		{"rail_title":"Cozy Nights","rail_description":"","index":1,"reason":"a"},
		{"rail_title":"  cozy nights ","rail_description":"Warm picks","index":2,"reason":"b"}
	]}`
	specs := parseDiscoverFlat(raw)
	if len(specs) != 1 {
		t.Fatalf("want 1 merged rail, got %d", len(specs))
	}
	if specs[0].Title != "Cozy Nights" {
		t.Errorf("want first-seen display title, got %q", specs[0].Title)
	}
	if specs[0].Description != "Warm picks" {
		t.Errorf("want first NON-EMPTY description, got %q", specs[0].Description)
	}
	if len(specs[0].Picks) != 2 {
		t.Errorf("want 2 picks merged, got %d", len(specs[0].Picks))
	}
}

func TestParseDiscoverFlatSkipAndFallthrough(t *testing.T) {
	// A pick with no rail_title can't be grouped → skipped.
	withEmpty := `{"picks":[{"rail_title":"","index":1,"reason":"x"},{"rail_title":"Real","index":2,"reason":"y"}]}`
	specs := parseDiscoverFlat(withEmpty)
	if len(specs) != 1 || specs[0].Title != "Real" {
		t.Errorf("empty-rail pick should be skipped: %+v", specs)
	}
	// The OLD nested shape has no top-level "picks" array → nil so the caller
	// falls back to parseDiscoverResponse (no regression).
	nested := `{"rails":[{"title":"X","picks":[{"index":1,"reason":"r"}]}]}`
	if got := parseDiscoverFlat(nested); got != nil {
		t.Errorf("nested shape must not parse as flat (want nil), got %+v", got)
	}
	// Garbage → nil.
	if got := parseDiscoverFlat("not json at all"); got != nil {
		t.Errorf("garbage should return nil, got %+v", got)
	}
}
