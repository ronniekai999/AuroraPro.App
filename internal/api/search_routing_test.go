package api

import "testing"

// Issue #207 ("Search Not Always Pulling Updated Titles"): exact titles were
// misrouted to the slow, fuzzy semantic LLM path because the old heuristic
// treated any 4+-word query — or any title containing an incidental mood word
// like "dark"/"good"/"with" — as a conversational/vibe query.
//
// These tests lock the routing decision: a query only skips straight to the
// LLM when it carries an explicit recommendation/comparison marker. Everything
// else (including long titles and titles with incidental mood words) is a title
// lookup that hits trigram first; the semantic path is reached only as an
// empty-result fallback inside Search.

func TestWantsRecommendations_TitlesAreNotRecommendations(t *testing.T) {
	// Real titles + marker-less descriptive queries that must NOT be sent
	// straight to semantic. The first entries are the exact #207 regressions.
	titleLookups := []string{
		"A Time to Kill",                        // the reported case: 4 words, no marker
		"a time to kill",                        // case-insensitive
		"  A Time to Kill  ",                    // surrounding whitespace
		"The Dark Knight",                       // "dark" is a mood word — but it's a title
		"Good Will Hunting",                     // "good"
		"Gone with the Wind",                    // "with"
		"From Russia with Love",                 // "with"
		"Eternal Sunshine of the Spotless Mind", // 6 words, no marker
		"The Lord of the Rings",                 // 5 words
		"Once Upon a Time in Hollywood",         // 6 words
		"Everything Everywhere All at Once",     // 5 words
		"Show Me a Hero",                        // "show me" deliberately excluded from markers
		"Inception",
		"the matrix",
		"severance s2",
		"dark gritty thriller", // descriptive but marker-less → trigram-first (empty falls back)
		"feel-good 90s sci-fi", // "good" is no longer a marker
		"",                     // empty
		"   ",                  // whitespace only
	}
	for _, q := range titleLookups {
		if wantsRecommendations(q) {
			t.Errorf("wantsRecommendations(%q) = true; want false (title/marker-less queries must hit trigram first)", q)
		}
	}
}

func TestWantsRecommendations_ExplicitRequestsGoSemantic(t *testing.T) {
	// Queries that explicitly ask the system to reason about taste.
	recommendationQueries := []string{
		"movies like Severance",
		"shows similar to Inception",
		"something like Blade Runner",
		"reminds me of The Matrix",
		"reminds me of Heat",
		"recommend a thriller",
		"suggest a cozy comedy",
		"what should I watch tonight",
		"kind of like Severance",
		"sort of like a western",
		"feels like a Tarantino film",
	}
	for _, q := range recommendationQueries {
		if !wantsRecommendations(q) {
			t.Errorf("wantsRecommendations(%q) = false; want true (explicit recommendation marker)", q)
		}
	}
}

func TestSemanticFirst_Routing(t *testing.T) {
	cases := []struct {
		name               string
		mode               string
		query              string
		semanticConfigured bool
		want               bool
	}{
		// No LLM configured → always trigram, regardless of query/mode.
		{"no LLM, title", "", "A Time to Kill", false, false},
		{"no LLM, recommendation", "", "movies like X", false, false},
		{"no LLM, force semantic", "semantic", "anything", false, false},

		// Auto mode (no ?mode=) — the production default.
		{"auto, reported title", "", "A Time to Kill", true, false},
		{"auto, mood-word title", "", "The Dark Knight", true, false},
		{"auto, descriptive marker-less", "", "dark gritty thriller", true, false},
		{"auto, recommendation", "", "movies like Severance", true, true},

		// ?mode=literal forces trigram even for an obvious recommendation query.
		{"force literal beats marker", "literal", "movies like Severance", true, false},
		{"force literal, plain title", "literal", "Inception", true, false},

		// ?mode=semantic forces the LLM even for a plain title (test/debug knob).
		{"force semantic, plain title", "semantic", "Inception", true, true},
	}
	for _, c := range cases {
		if got := semanticFirst(c.mode, c.query, c.semanticConfigured); got != c.want {
			t.Errorf("%s: semanticFirst(mode=%q, query=%q, configured=%v) = %v; want %v",
				c.name, c.mode, c.query, c.semanticConfigured, got, c.want)
		}
	}
}
