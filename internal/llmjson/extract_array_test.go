package llmjson

import "testing"

// TestExtractArray pins the STRICT extractor: bare array, known alias, and
// markdown-fenced all work; an UNKNOWN wrapper key must ERROR. That strict miss
// is load-bearing — Discover's parseDiscoverFlatTitleMap relies on it to trigger,
// so the loose fallback must NOT live here.
func TestExtractArray(t *testing.T) {
	aliases := []string{"picks", "selected", "rails"}

	if a, err := ExtractArray(`[{"index":1}]`, aliases); err != nil || len(a) != 1 {
		t.Errorf("bare array: a=%v err=%v", a, err)
	}
	if a, err := ExtractArray(`{"picks":[{"index":1},{"index":2}]}`, aliases); err != nil || len(a) != 2 {
		t.Errorf("alias: a=%v err=%v", a, err)
	}
	if a, err := ExtractArray("```json\n{\"selected\":[{\"id\":3}]}\n```", aliases); err != nil || len(a) != 1 {
		t.Errorf("fenced+alias: a=%v err=%v", a, err)
	}
	// Unknown wrapper → strict MISS (must error, so Discover's flat-map path runs).
	if _, err := ExtractArray(`{"selections":[{"title":"A"}]}`, aliases); err == nil {
		t.Errorf("strict ExtractArray must error on an unknown wrapper key")
	}
}

// TestExtractArrayLoose pins the LOOSE extractor (hero rerank): everything strict
// does, PLUS recovery of any single array-of-objects under an unknown wrapper key
// (deepseek's selected → candidates → selections rotation).
func TestExtractArrayLoose(t *testing.T) {
	aliases := []string{"picks", "selected", "rails"}

	// Delegates to strict for the known shapes.
	if a, err := ExtractArrayLoose(`{"picks":[{"index":1}]}`, aliases); err != nil || len(a) != 1 {
		t.Errorf("alias passthrough: a=%v err=%v", a, err)
	}
	// Recovers unknown wrapper keys.
	for _, raw := range []string{
		`{"selections":[{"title":"A"},{"title":"B"}]}`,
		`{"candidates":[{"title":"A"}]}`,
		`{"some_future_key_2027":[{"title":"A"}]}`,
	} {
		if a, err := ExtractArrayLoose(raw, aliases); err != nil || len(a) == 0 {
			t.Errorf("loose recovery failed for %s: a=%v err=%v", raw, a, err)
		}
	}
	// A string array under an unknown key must NOT be grabbed.
	if _, err := ExtractArrayLoose(`{"tags":["a","b","c"]}`, aliases); err == nil {
		t.Errorf("a string array must not satisfy the array-of-objects fallback")
	}
	// Multiple unknown arrays → longest array-of-objects wins (deterministic).
	if a, err := ExtractArrayLoose(`{"meta":[{"x":1}],"results_v2":[{"a":1},{"a":2},{"a":3}]}`, aliases); err != nil || len(a) != 3 {
		t.Errorf("longest array-of-objects should win: a=%v err=%v", a, err)
	}
	// No array present → error.
	if _, err := ExtractArrayLoose(`{"foo":"bar","n":5}`, aliases); err == nil {
		t.Errorf("expected error when no array present")
	}
}
