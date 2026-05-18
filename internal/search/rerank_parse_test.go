package search

import "testing"

// TestParseSearchRerank covers every output shape we've seen Cloud chat
// models emit in production. Each fixture is a copy-pasted body from a real
// /api/chat response.
func TestParseSearchRerank(t *testing.T) {
	cases := []struct {
		name      string
		raw       string
		wantLen   int
		wantFirst rerankPick
	}{
		{
			name:      "schema-conformant picks wrapper",
			raw:       `{"picks":[{"index":1,"reason":"perfect"},{"index":2,"reason":"close"}]}`,
			wantLen:   2,
			wantFirst: rerankPick{Index: 1, Reason: "perfect"},
		},
		{
			name:      "bare top-level array (gemma3:12b)",
			raw:       `[{"index":3,"reason":"matches the vibe"},{"index":5,"reason":"close enough"}]`,
			wantLen:   2,
			wantFirst: rerankPick{Index: 3, Reason: "matches the vibe"},
		},
		{
			name:      "markdown-fenced JSON",
			raw:       "```json\n{\"picks\":[{\"index\":7,\"reason\":\"fenced\"}]}\n```",
			wantLen:   1,
			wantFirst: rerankPick{Index: 7, Reason: "fenced"},
		},
		{
			name:      "selected wrapper key (gpt-oss:20b)",
			raw:       `{"selected":[{"index":4,"reason":"good fit"}]}`,
			wantLen:   1,
			wantFirst: rerankPick{Index: 4, Reason: "good fit"},
		},
		{
			name:      "id field instead of index",
			raw:       `{"picks":[{"id":9,"reason":"id alias"}]}`,
			wantLen:   1,
			wantFirst: rerankPick{Index: 9, Reason: "id alias"},
		},
		{
			name:    "empty picks is valid (nothing matched)",
			raw:     `{"picks":[]}`,
			wantLen: 0,
		},
		{
			name:      "title-only pick (gpt-oss:20b dropped index)",
			raw:       `{"picks":[{"title":"Buffy the Vampire Slayer","reason":"vampire slayer drama"}]}`,
			wantLen:   1,
			wantFirst: rerankPick{Index: 0, Reason: "vampire slayer drama", Title: "Buffy the Vampire Slayer"},
		},
		{
			name:      "id + title (both present)",
			raw:       `{"picks":[{"id":8,"title":"Buffy the Vampire Slayer","reason":"classic"}]}`,
			wantLen:   1,
			wantFirst: rerankPick{Index: 8, Reason: "classic", Title: "Buffy the Vampire Slayer"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseSearchRerankResponse(tc.raw)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != tc.wantLen {
				t.Fatalf("len=%d, want %d (got=%+v)", len(got), tc.wantLen, got)
			}
			if tc.wantLen > 0 && got[0] != tc.wantFirst {
				t.Fatalf("first=%+v, want %+v", got[0], tc.wantFirst)
			}
		})
	}
}

func TestParseSearchRerank_BadInput(t *testing.T) {
	cases := []string{
		``,
		`not json`,
		`{"foo": "bar"}`, // valid JSON, no array under any alias
	}
	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			if _, err := parseSearchRerankResponse(raw); err == nil {
				t.Fatalf("expected error for %q, got nil", raw)
			}
		})
	}
}

func TestValidMediaType(t *testing.T) {
	cases := map[string]string{
		"movie":     "movie",
		"tv":        "tv",
		"TV":        "tv",
		"tv_series": "", // common gemma3 hallucination
		"show":      "",
		"":          "",
	}
	for in, want := range cases {
		if got := validMediaType(in); got != want {
			t.Errorf("validMediaType(%q) = %q, want %q", in, got, want)
		}
	}
}
