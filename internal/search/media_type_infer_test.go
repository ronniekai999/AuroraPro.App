package search

import "testing"

// Covers inferMediaTypeFromQuery — the deterministic type override that backs
// up the HyDE parse (which left "movie like harry potter" as media_type:null,
// leaking TV shows into a movie query).
func TestInferMediaTypeFromQuery(t *testing.T) {
	cases := []struct {
		query string
		want  string
	}{
		// The observed bug: an explicit "movie" must win.
		{"movie like harry potter", "movie"},
		{"action movies from the 90s", "movie"},
		{"a good film noir", "movie"},
		{"sci fi films", "movie"},

		// Clear TV signals.
		{"shows like the office", "tv"},
		{"funny tv to watch tonight", "tv"},
		{"best sitcoms", "tv"},
		{"a good miniseries", "tv"},
		{"television dramas", "tv"},

		// False-positive guards: "show me X" is the verb, not the noun — must
		// NOT be read as TV, so the movie keyword still wins.
		{"show me movies like harry potter", "movie"},
		{"show me something funny", ""}, // singular verb, no other signal → defer

		// Ambiguous / absent → defer to the LLM.
		{"something like breaking bad", ""},
		{"the movie that spawned the tv series", ""}, // both classes named
		{"harry potter", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := inferMediaTypeFromQuery(c.query); got != c.want {
			t.Errorf("inferMediaTypeFromQuery(%q) = %q, want %q", c.query, got, c.want)
		}
	}
}
