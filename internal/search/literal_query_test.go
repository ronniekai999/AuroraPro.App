package search

import "testing"

// IsLiteralQuery is the public mirror of the api package's routing heuristic.
// Issue #207: word count must NOT flip a long title to the semantic path.
// IsLiteralQuery returns true when a query should hit trigram first.

func TestIsLiteralQuery(t *testing.T) {
	literal := []string{
		"Inception",
		"the matrix",
		"severance s2",
		"A Time to Kill",                        // #207: 4-word title
		"The Dark Knight",                       // incidental mood word
		"Good Will Hunting",                     // incidental mood word
		"Gone with the Wind",                    // incidental preposition
		"Eternal Sunshine of the Spotless Mind", // long title
		"dark gritty thriller",                  // descriptive, marker-less → trigram first, falls back if empty
		"",                                      // empty
	}
	for _, q := range literal {
		if !IsLiteralQuery(q) {
			t.Errorf("IsLiteralQuery(%q) = false; want true (should hit trigram first)", q)
		}
	}

	semantic := []string{
		"movies like Severance",
		"similar to Inception",
		"reminds me of The Matrix",
		"recommend a thriller",
		"suggest a cozy comedy",
		"what should I watch tonight",
	}
	for _, q := range semantic {
		if IsLiteralQuery(q) {
			t.Errorf("IsLiteralQuery(%q) = true; want false (explicit recommendation marker)", q)
		}
	}
}
