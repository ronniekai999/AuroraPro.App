// eval_test.go — golden-set regression check for the LLM query parser.
//
// Runs only when OLLAMA_URL is set in the environment, so this is a no-op in
// vanilla `go test ./...` runs. To execute against your local Ollama:
//
//	OLLAMA_URL=http://localhost:11434 go test ./internal/search/... -run Eval -v
//
// The cases assert on the *parser's structured output*, not on retrieval
// rankings — retrieval depends on which items happen to be in the library,
// which varies. Parser output is what we control: if the LLM correctly
// extracts year_min=1990, year_max=1999, and comedy from "feel-good 90s
// comedies", retrieval will line up.
//
// Add cases when you encounter real-world failures, not preemptively. A
// 12-case set is plenty to catch model-swap regressions; growing it for its
// own sake just makes maintenance painful.
package search

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/llm"
)

// evalCase is one row of the golden set. Each predicate is optional: leave a
// field empty/zero to skip that assertion.
type evalCase struct {
	name        string
	query       string
	wantIntent  string   // exact match if non-empty
	wantGenres  []string // each must appear in parsed.Genres (case-insensitive)
	wantYearMin int      // if >0, parsed.YearMin must equal this
	wantYearMax int      // if >0, parsed.YearMax must equal this
	wantMedia   string   // exact match if non-empty
	wantSimTo   []string // titles that must appear in similar_to_titles
	hydeNonEmpty bool    // require a non-empty hyde_overview (default true)
}

var evalCases = []evalCase{
	{
		name: "literal title", query: "Inception",
		wantIntent: "title_lookup", hydeNonEmpty: true,
	},
	{
		name: "decade comedy mood", query: "feel-good 90s comedies",
		wantGenres: []string{"comedy"}, wantYearMin: 1990, wantYearMax: 1999,
		hydeNonEmpty: true,
	},
	{
		name: "similar-to anchor", query: "movies like Severance",
		wantSimTo: []string{"Severance"}, wantIntent: "similar_to",
		hydeNonEmpty: true,
	},
	{
		name: "media-type tv", query: "binge-worthy tv shows about hackers",
		wantMedia: "tv", hydeNonEmpty: true,
	},
	{
		name: "media-type movie", query: "movies about heists",
		wantMedia: "movie", hydeNonEmpty: true,
	},
	{
		name: "runtime constraint", query: "short comedies under 90 minutes",
		wantGenres: []string{"comedy"}, hydeNonEmpty: true,
	},
	{
		name: "vibe sci-fi", query: "dark cerebral sci-fi",
		wantGenres: []string{"sci-fi"}, hydeNonEmpty: true,
	},
	{
		name: "horror exclusion", query: "scary movies but nothing too gory",
		wantGenres: []string{"horror"}, hydeNonEmpty: true,
	},
	{
		name: "documentary", query: "documentaries about food",
		wantGenres: []string{"documentary"}, hydeNonEmpty: true,
	},
	{
		name: "recency", query: "recent thrillers",
		wantGenres: []string{"thriller"}, hydeNonEmpty: true,
	},
	{
		name: "classic era", query: "classic film noir",
		wantYearMax: 1979, hydeNonEmpty: true,
	},
	{
		name: "vague mood", query: "something cozy for a rainy sunday",
		wantIntent: "mood", hydeNonEmpty: true,
	},
}

// TestEvalGoldenSet exercises the LLM parser against a curated set. Skips
// when OLLAMA_URL is unset so CI doesn't fail in environments without a
// local Ollama.
func TestEvalGoldenSet(t *testing.T) {
	url := os.Getenv("OLLAMA_URL")
	if url == "" {
		t.Skip("OLLAMA_URL not set; skipping LLM eval (run with OLLAMA_URL=http://localhost:11434 go test -v -run Eval ./internal/search/...)")
	}

	model := os.Getenv("OLLAMA_CHAT_MODEL")
	if model == "" {
		model = "qwen2.5:3b-instruct"
	}

	client := llm.NewClient(llm.Config{
		BaseURL:     url,
		ChatModel:   model,
		HTTPTimeout: 30 * time.Second,
	})

	pingCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx); err != nil {
		t.Skipf("ollama unreachable at %s: %v", url, err)
	}

	s := New(client, nil) // queries is nil — eval only exercises parseQuery

	var passed, failed int
	for _, tc := range evalCases {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			parsed, err := s.parseQuery(ctx, tc.query)
			if err != nil {
				failed++
				t.Fatalf("parseQuery(%q) error: %v", tc.query, err)
			}

			if tc.wantIntent != "" && parsed.Intent != tc.wantIntent {
				t.Errorf("intent: got %q, want %q", parsed.Intent, tc.wantIntent)
			}
			if tc.wantMedia != "" && parsed.MediaType != tc.wantMedia {
				t.Errorf("media_type: got %q, want %q", parsed.MediaType, tc.wantMedia)
			}
			if tc.wantYearMin > 0 && parsed.YearMin != tc.wantYearMin {
				t.Errorf("year_min: got %d, want %d", parsed.YearMin, tc.wantYearMin)
			}
			if tc.wantYearMax > 0 && parsed.YearMax != tc.wantYearMax {
				t.Errorf("year_max: got %d, want %d", parsed.YearMax, tc.wantYearMax)
			}
			for _, g := range tc.wantGenres {
				if !containsCI(parsed.Genres, g) {
					t.Errorf("genres: want %q in %v", g, parsed.Genres)
				}
			}
			for _, ttl := range tc.wantSimTo {
				if !containsCI(parsed.SimilarToTitles, ttl) {
					t.Errorf("similar_to_titles: want %q in %v", ttl, parsed.SimilarToTitles)
				}
			}
			if tc.hydeNonEmpty && strings.TrimSpace(parsed.HydeOverview) == "" {
				t.Errorf("hyde_overview is empty (parser must always produce one)")
			}

			if !t.Failed() {
				passed++
			} else {
				failed++
			}
		})
	}

	t.Logf("eval summary: %d/%d passed", passed, passed+failed)
}

func containsCI(haystack []string, needle string) bool {
	n := strings.ToLower(needle)
	for _, h := range haystack {
		if strings.Contains(strings.ToLower(h), n) {
			return true
		}
	}
	return false
}
