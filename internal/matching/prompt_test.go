package matching

import (
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/metadata"
)

// candidates returns a fixed candidate set used across parser tests.
// 27205 = Inception, 157336 = Interstellar — well-known TMDB IDs that
// also appear in any LLM's pretraining, which is exactly what makes
// hallucination defenses worth testing.
func candidates() []metadata.TMDBMovieTV {
	return []metadata.TMDBMovieTV{
		{ID: 27205, Title: "Inception", ReleaseDate: "2010-07-16"},
		{ID: 157336, Title: "Interstellar", ReleaseDate: "2014-11-05"},
		{ID: 49026, Title: "The Dark Knight Rises", ReleaseDate: "2012-07-16"},
	}
}

func TestParseMatchResponse_HappyPath(t *testing.T) {
	raw := `{"tmdb_id": 27205, "confidence": 95, "reasoning": "Title and year both match Inception (2010)."}`
	sug, err := parseMatchResponse(raw, candidates())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sug.TMDBID != 27205 {
		t.Errorf("TMDBID = %d, want 27205", sug.TMDBID)
	}
	if sug.Confidence != 95 {
		t.Errorf("Confidence = %d, want 95", sug.Confidence)
	}
	if sug.Title != "Inception" {
		t.Errorf("Title = %q, want Inception", sug.Title)
	}
	if sug.Year != 2010 {
		t.Errorf("Year = %d, want 2010", sug.Year)
	}
}

func TestParseMatchResponse_MarkdownFences(t *testing.T) {
	raw := "```json\n{\"tmdb_id\": 157336, \"confidence\": 80, \"reasoning\": \"ok\"}\n```"
	sug, err := parseMatchResponse(raw, candidates())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sug.TMDBID != 157336 {
		t.Errorf("TMDBID = %d, want 157336", sug.TMDBID)
	}
}

func TestParseMatchResponse_UppercaseKeys(t *testing.T) {
	raw := `{"TMDB_ID": 27205, "Confidence": 70, "Reasoning": "case-insensitive"}`
	sug, err := parseMatchResponse(raw, candidates())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sug.TMDBID != 27205 {
		t.Errorf("TMDBID = %d, want 27205", sug.TMDBID)
	}
	if sug.Confidence != 70 {
		t.Errorf("Confidence = %d, want 70", sug.Confidence)
	}
}

func TestParseMatchResponse_IDFallback(t *testing.T) {
	// gpt-oss sometimes emits "id" instead of "tmdb_id"
	raw := `{"id": 27205, "confidence": 60, "reasoning": "id alias"}`
	sug, err := parseMatchResponse(raw, candidates())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sug.TMDBID != 27205 {
		t.Errorf("TMDBID = %d, want 27205", sug.TMDBID)
	}
}

func TestParseMatchResponse_HallucinatedID(t *testing.T) {
	// 99999 is not in candidates() — the parser must reject this
	// regardless of how confident the model claims to be.
	raw := `{"tmdb_id": 99999, "confidence": 99, "reasoning": "model memory"}`
	_, err := parseMatchResponse(raw, candidates())
	if err == nil {
		t.Fatal("expected error for hallucinated tmdb_id, got nil")
	}
	if !strings.Contains(err.Error(), "99999") {
		t.Errorf("error should mention the bad id; got: %v", err)
	}
}

func TestParseMatchResponse_NoCandidateFits(t *testing.T) {
	// tmdb_id=0 is the documented "explicitly nothing fits" signal.
	// Should return a Suggestion with TMDBID=0 and confidence forced to 0
	// (parser clamps even if model emitted >0).
	raw := `{"tmdb_id": 0, "confidence": 95, "reasoning": "Nothing in candidates matches the local title."}`
	sug, err := parseMatchResponse(raw, candidates())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sug.TMDBID != 0 {
		t.Errorf("TMDBID = %d, want 0", sug.TMDBID)
	}
	if sug.Confidence != 0 {
		t.Errorf("Confidence = %d, want 0 (forced for tmdb_id=0)", sug.Confidence)
	}
	if sug.Reasoning == "" {
		t.Error("Reasoning should be preserved on no-fit response")
	}
}

func TestParseMatchResponse_ConfidenceClamped(t *testing.T) {
	cases := []struct {
		raw  string
		want int
	}{
		{`{"tmdb_id":27205,"confidence":150,"reasoning":"x"}`, 100},
		{`{"tmdb_id":27205,"confidence":-50,"reasoning":"x"}`, 0},
		// Note: confidence=0 with tmdb_id>0 is a model glitch but valid;
		// the matcher's suggestionToUpdate will store it and skip auto-promote.
		{`{"tmdb_id":27205,"confidence":0,"reasoning":"x"}`, 0},
	}
	for _, c := range cases {
		sug, err := parseMatchResponse(c.raw, candidates())
		if err != nil {
			t.Errorf("raw=%s unexpected error: %v", c.raw, err)
			continue
		}
		if sug.Confidence != c.want {
			t.Errorf("raw=%s Confidence = %d, want %d", c.raw, sug.Confidence, c.want)
		}
	}
}

func TestParseMatchResponse_TMDBIDAsString(t *testing.T) {
	// Some hosted models emit ints as JSON strings. PickInt handles this.
	raw := `{"tmdb_id": "27205", "confidence": "75", "reasoning": "stringy"}`
	sug, err := parseMatchResponse(raw, candidates())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sug.TMDBID != 27205 || sug.Confidence != 75 {
		t.Errorf("got TMDBID=%d Confidence=%d", sug.TMDBID, sug.Confidence)
	}
}

func TestParseMatchResponse_MalformedJSON(t *testing.T) {
	_, err := parseMatchResponse("not json at all", candidates())
	if err == nil {
		t.Fatal("expected decode error, got nil")
	}
}

func TestSanitizePromptText_UnicodeLineBreaks(t *testing.T) {
	// The deep-debugger pass flagged that the original newline-only
	// sanitizer was bypassed by U+2028 / U+2029 / NEL. A malicious
	// filename embedding these would otherwise let an attacker introduce
	// what looks like a new instruction to the model.
	cases := []struct {
		name string
		in   string
		bad  rune
	}{
		{"newline", "Movie\nIgnore prior", '\n'},
		{"carriage_return", "Movie\rIgnore prior", '\r'},
		{"tab", "Movie\tIgnore prior", '\t'},
		{"nel", "MovieIgnore prior", 0x0085},
		{"line_sep", "Movie Ignore prior", 0x2028},
		{"para_sep", "Movie Ignore prior", 0x2029},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := sanitizePromptText(c.in, 0)
			if strings.ContainsRune(got, c.bad) {
				t.Errorf("sanitized %q still contains bad rune %U: %q", c.in, c.bad, got)
			}
			if !strings.Contains(got, "Movie") || !strings.Contains(got, "Ignore prior") {
				t.Errorf("sanitizer corrupted legitimate text: %q", got)
			}
		})
	}
}

func TestSanitizePromptText_BacktickStripping(t *testing.T) {
	got := sanitizePromptText("Title ```evil``` more", 0)
	if strings.Contains(got, "```") {
		t.Errorf("triple-backtick not stripped: %q", got)
	}
}

func TestSanitizePromptText_TruncationAppendsEllipsis(t *testing.T) {
	long := strings.Repeat("a", 500)
	got := sanitizePromptText(long, 100)
	if !strings.HasSuffix(got, "...") {
		t.Errorf("truncated text should end with ...: %q", got[len(got)-10:])
	}
	if len(got) != 103 { // 100 + len("...")
		t.Errorf("truncated length = %d, want 103", len(got))
	}
}

func TestSanitizePromptText_QuotesPreserved(t *testing.T) {
	// Legitimate titles contain quotes/apostrophes — must not strip them.
	in := `She's Out of My League "The Director's Cut"`
	got := sanitizePromptText(in, 0)
	if got != in {
		t.Errorf("got %q, want %q (no chars should be removed)", got, in)
	}
}

func TestSuggestionToUpdate_NilInput(t *testing.T) {
	if u := suggestionToUpdate(nil); u != nil {
		t.Errorf("nil Suggestion should map to nil update, got %+v", u)
	}
}

func TestSuggestionToUpdate_TMDBIDZero(t *testing.T) {
	// "No fit" suggestion: no TMDB fields populated, but confidence and
	// reasoning ARE persisted so the operator sees the rejection rationale.
	u := suggestionToUpdate(&Suggestion{TMDBID: 0, Confidence: 0, Reasoning: "no fit"})
	if u == nil {
		t.Fatal("nil update for non-nil suggestion")
	}
	if u.TMDBID != nil {
		t.Errorf("TMDBID should be nil for tmdb_id=0, got %v", *u.TMDBID)
	}
	if u.Title != nil {
		t.Errorf("Title should be nil for tmdb_id=0")
	}
	if u.Confidence == nil || *u.Confidence != 0 {
		t.Errorf("Confidence should always be populated (incl 0), got %v", u.Confidence)
	}
	if u.Reasoning == nil || *u.Reasoning != "no fit" {
		t.Errorf("Reasoning should be preserved, got %v", u.Reasoning)
	}
}

func TestSuggestionToUpdate_YearClamp(t *testing.T) {
	// SMALLINT range is -32768..32767; clamp defends against model glitches
	// that emit out-of-range years. Real TMDB years are 1880-2030ish.
	cases := []struct {
		in, want int
	}{
		{2010, 2010},
		{-50, 0},
		{999999, 32767},
	}
	for _, c := range cases {
		u := suggestionToUpdate(&Suggestion{TMDBID: 27205, Year: c.in, Confidence: 90, Title: "x"})
		if u.Year == nil {
			t.Errorf("year=%d: Year should be populated when TMDBID>0", c.in)
			continue
		}
		if *u.Year != c.want {
			t.Errorf("year=%d clamped to %d, want %d", c.in, *u.Year, c.want)
		}
	}
}

func TestSuggestionToUpdate_ReasoningTruncated(t *testing.T) {
	long := strings.Repeat("x", 500)
	u := suggestionToUpdate(&Suggestion{TMDBID: 27205, Reasoning: long, Confidence: 50, Title: "x"})
	if u.Reasoning == nil {
		t.Fatal("Reasoning should be populated")
	}
	if len(*u.Reasoning) > 280 {
		t.Errorf("Reasoning length %d > 280 (not truncated)", len(*u.Reasoning))
	}
}
