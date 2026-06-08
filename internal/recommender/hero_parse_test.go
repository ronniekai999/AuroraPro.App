package recommender

import "testing"

func TestParseRerankResponse(t *testing.T) {
	cases := []struct {
		name      string
		raw       string
		wantLen   int
		wantFirst heroRerankPick
	}{
		{
			name:      "schema-conformant picks wrapper",
			raw:       `{"picks":[{"index":1,"reason":"because Severance"}]}`,
			wantLen:   1,
			wantFirst: heroRerankPick{Index: 1, Reason: "because Severance"},
		},
		{
			name:      "bare top-level array",
			raw:       `[{"index":2,"reason":"slow-burn sci-fi"}]`,
			wantLen:   1,
			wantFirst: heroRerankPick{Index: 2, Reason: "slow-burn sci-fi"},
		},
		{
			name: "selected wrapper + id field (gpt-oss:20b real fixture)",
			raw: `{"selected":[
				{"id":6,"reason":"Because you loved Scooby-Doo!"},
				{"id":3,"reason":"Paranormal mystery like Dead Boy Detectives."},
				{"id":2,"reason":"Cult horror vibes like Rocky Horror."}
			]}`,
			wantLen:   3,
			wantFirst: heroRerankPick{Index: 6, Reason: "Because you loved Scooby-Doo!"},
		},
		{
			name:      "markdown-fenced",
			raw:       "```json\n{\"picks\":[{\"index\":4,\"reason\":\"fenced\"}]}\n```",
			wantLen:   1,
			wantFirst: heroRerankPick{Index: 4, Reason: "fenced"},
		},
		{
			// deepseek-v4-flash real fixture (2026-06-08): "candidates" wrapper +
			// title-only picks (with year suffix). Before the alias was added this
			// failed to parse and the hero fell back to score order.
			name:      "candidates wrapper + title-only (deepseek-v4-flash)",
			raw:       `{"candidates":[{"title":"The Conjuring: Last Rites (2025)","reason":"Paranormal mystery like Ghost Whisperer."},{"title":"Holland (2025)","reason":"Mystery thriller."}]}`,
			wantLen:   2,
			wantFirst: heroRerankPick{Index: 0, Title: "The Conjuring: Last Rites (2025)", Reason: "Paranormal mystery like Ghost Whisperer."},
		},
		{
			// deepseek-v4-flash rotated to "selections" the next run — NOT in the
			// alias list. The generic array-of-objects fallback in ExtractArrayLoose
			// (NOT strict ExtractArray — strict must keep MISSING so Discover's
			// flat-title-map path triggers) recovers it, so the hero stops playing
			// wrapper-key whack-a-mole.
			name:      "selections wrapper via generic fallback (deepseek-v4-flash)",
			raw:       `{"selections":[{"title":"The Conjuring: Last Rites (2025)","reason":"Supernatural mystery like Ghost Whisperer"}]}`,
			wantLen:   1,
			wantFirst: heroRerankPick{Index: 0, Title: "The Conjuring: Last Rites (2025)", Reason: "Supernatural mystery like Ghost Whisperer"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseRerankResponse(tc.raw)
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
