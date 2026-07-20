package reasonguard

import (
	"strings"
	"testing"
)

// The two hero blurbs from the 2026-07-20 production screenshots that
// motivated the guard. Both are ~2x the prompted 80-char cap AND contradict
// the candidate's metadata ("The 'Burbs" is genre-tagged Comedy; "The
// Exorcist" is rated R). Each must be dropped.
const (
	screenshotBurbsBlurb = "Because you watched The Day After Tomorrow (2004) — Adventure, Science Fiction, " +
		"Thriller, this supernatural drama blends mystery with a dark, atmospheric tone."
	screenshotExorcistBlurb = "Because you watched The Haunted Mansion (2003) — Comedy, Family, Fantasy, Mystery, " +
		"this R-rated horror matches the supernatural mystery genre with a family-friendly fantasy edge."
)

func TestVet_ScreenshotRegressions(t *testing.T) {
	if got := Vet(screenshotBurbsBlurb, []string{"Comedy"}, ""); got != "" {
		t.Errorf("'Burbs screenshot blurb survived vetting: %q", got)
	}
	if got := Vet(screenshotExorcistBlurb, []string{"Drama", "Horror"}, "R"); got != "" {
		t.Errorf("Exorcist screenshot blurb survived vetting: %q", got)
	}
}

func TestVet_LengthGate(t *testing.T) {
	genres := []string{"Drama"}
	atCap := strings.Repeat("a", maxRunes)
	if got := Vet(atCap, genres, ""); got != atCap {
		t.Errorf("reason at the cap should pass, got %q", got)
	}
	if got := Vet(strings.Repeat("a", maxRunes+1), genres, ""); got != "" {
		t.Errorf("reason past the cap should be dropped, got %q", got)
	}
	// Rune cap, not byte cap: 100 two-byte runes are 200 bytes but only
	// 100 runes — must pass.
	twoByte := strings.Repeat("é", 100)
	if got := Vet(twoByte, genres, ""); got != twoByte {
		t.Errorf("multibyte reason under the rune cap should pass, got %q", got)
	}
}

func TestVet_ToneGates(t *testing.T) {
	cases := []struct {
		name   string
		reason string
		genres []string
		rating string
		drop   bool
	}{
		// --- dark tone vs all-light genres ---
		{
			name:   "dark descriptor on pure comedy dropped",
			reason: "A supernatural drama with a dark, atmospheric tone",
			genres: []string{"Comedy"},
			drop:   true,
		},
		{
			name:   "tense action thriller on comedy+family dropped",
			reason: "Tense action-thriller energy all the way through",
			genres: []string{"Comedy", "Family"},
			drop:   true,
		},
		{
			name: "multibyte punctuation is a word boundary",
			// Em dash glued to "dark": byte-level boundary logic treated the
			// dash's trailing byte as a word byte and let this through — the
			// exact metadata-echo shape from the screenshots. Runes fix it.
			reason: "Supernatural drama—dark, eerie tone",
			genres: []string{"Comedy"},
			drop:   true,
		},
		{
			name: "hybrid genre disables dark-tone gate",
			// "Chilling" would trip the gate, but Horror in the tags means
			// the item isn't unambiguously light — the check must not fire.
			reason: "Chilling slow-burn like The Shining",
			genres: []string{"Comedy", "Horror"},
			drop:   false,
		},
		{
			name:   "unrecognized genre disables dark-tone gate",
			reason: "Haunting frontier tale",
			genres: []string{"Western"},
			drop:   false,
		},
		{
			name:   "no genre metadata disables dark-tone gate",
			reason: "A dark and terrifying descent",
			genres: nil,
			drop:   false,
		},
		{
			name: "word boundary: darkly does not trip dark",
			// "darkly comic" is a legitimate comedy descriptor; only the
			// standalone word "dark" contradicts a pure comedy.
			reason: "Darkly comic caper like Knives Out",
			genres: []string{"Comedy"},
			drop:   false,
		},
		{
			name: "benign phrase: dark comedy survives on pure comedy",
			// "Dark comedy" is a real subgenre, not a contradiction — the
			// benign-phrase pass blanks it before the word scan.
			reason: "Dark comedy like Fargo",
			genres: []string{"Comedy"},
			drop:   false,
		},
		{
			name:   "benign phrase neutralized but other dark word still trips",
			reason: "Dark comedy with a genuinely sinister streak",
			genres: []string{"Comedy"},
			drop:   true,
		},
		{
			name:   "supernatural comedy is not a contradiction",
			reason: "Supernatural comedy like Ghostbusters",
			genres: []string{"Comedy"},
			drop:   false,
		},
		{
			name: "rating words are not genre contradictions",
			// "R-rated comedy" on an R-rated pure comedy is ACCURATE; rating
			// words are policed by the rating gates, not the genre gate.
			reason: "R-rated comedy like The Hangover",
			genres: []string{"Comedy"},
			rating: "R",
			drop:   false,
		},
		// --- family tone vs mature rating ---
		{
			name:   "family-friendly on R dropped",
			reason: "R-rated horror with a family-friendly fantasy edge",
			genres: []string{"Drama", "Horror"},
			rating: "R",
			drop:   true,
		},
		{
			name:   "wholesome on TV-MA dropped",
			reason: "Wholesome fun for a cozy night in",
			genres: []string{"Drama"},
			rating: "TV-MA",
			drop:   true,
		},
		{
			name: "gentle is allowed on mature ratings",
			// An R rating can come from language alone; "gentle character
			// study" is a legitimate descriptor, not a family-audience claim.
			reason: "A gentle, aching character study",
			genres: []string{"Drama"},
			rating: "R",
			drop:   false,
		},
		{
			name:   "family-friendly on PG-13 kept (rating not in mature bucket)",
			reason: "Family-friendly adventure with heart",
			genres: []string{"Adventure"},
			rating: "PG-13",
			drop:   false,
		},
		// --- explicit tone vs kid rating ---
		{
			name:   "gory on G dropped",
			reason: "Gory fun from start to finish",
			genres: []string{"Animation"},
			rating: "G",
			drop:   true,
		},
		{
			name:   "gory on TV-Y7 dropped (ladder-derived kid bucket)",
			reason: "Surprisingly bloody for a cartoon",
			genres: []string{"Animation"},
			rating: "TV-Y7",
			drop:   true,
		},
		{
			name: "benign phrase: graphic novel survives on kid rating",
			// "graphic-novel adaptation" contains "graphic" but is not an
			// explicit-content claim.
			reason: "Charming graphic-novel adaptation",
			genres: []string{"Animation", "Family"},
			rating: "G",
			drop:   false,
		},
		{
			name:   "gory on R kept",
			reason: "Gory practical effects like the classics",
			genres: []string{"Horror"},
			rating: "R",
			drop:   false,
		},
		// --- clean reasons pass untouched ---
		{
			name:   "anchor-grounded reason passes",
			reason: "Because you finished Severance",
			genres: []string{"Drama"},
			rating: "TV-MA",
			drop:   false,
		},
		{
			name:   "genre-grounded reason passes on light item",
			reason: "Suburban comedy like your weekend pick",
			genres: []string{"Comedy"},
			rating: "PG",
			drop:   false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Vet(c.reason, c.genres, c.rating)
			if c.drop && got != "" {
				t.Errorf("Vet(%q, %v, %q) = %q, want dropped", c.reason, c.genres, c.rating, got)
			}
			if !c.drop && got != c.reason {
				t.Errorf("Vet(%q, %v, %q) = %q, want passthrough", c.reason, c.genres, c.rating, got)
			}
		})
	}
}

func TestVet_TrimAndQuoteStrip(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{`"Because you finished Severance"`, "Because you finished Severance"},
		{"  Slow-burn sci-fi like Severance  ", "Slow-burn sci-fi like Severance"},
		{"“If you liked Drake & Josh”", "If you liked Drake & Josh"},
		// Only SYMMETRIC wrappers strip — a boundary apostrophe that is part
		// of the text must survive.
		{"'70s slasher throwback", "'70s slasher throwback"},
		{"'Wrapped in ASCII quotes'", "Wrapped in ASCII quotes"},
		{"", ""},
		{"   ", ""},
		{`""`, ""},
	}
	for _, c := range cases {
		if got := Vet(c.in, []string{"Drama"}, ""); got != c.want {
			t.Errorf("Vet(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestAllLightGenres(t *testing.T) {
	cases := []struct {
		genres []string
		want   bool
	}{
		{[]string{"Comedy"}, true},
		{[]string{"comedy", " Family "}, true}, // normalization
		{[]string{"Comedy", "Horror"}, false},
		{[]string{"Horror"}, false},
		{nil, false},
		{[]string{}, false},
	}
	for _, c := range cases {
		if got := allLightGenres(c.genres); got != c.want {
			t.Errorf("allLightGenres(%v) = %v, want %v", c.genres, got, c.want)
		}
	}
}
