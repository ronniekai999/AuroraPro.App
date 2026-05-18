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
