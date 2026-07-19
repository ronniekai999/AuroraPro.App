package llm

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func approxEq(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 1e-9
}

// TestParseListwiseScores pins the pure listwise parser: wrapper-key recovery,
// 1-based→0 index mapping, missing/out-of-range/duplicate handling, score
// clamping, and the zero-parsed error contract.
func TestParseListwiseScores(t *testing.T) {
	t.Run("scores wrapper, aligned + clamped", func(t *testing.T) {
		raw := `{"scores":[{"index":1,"score":90},{"index":3,"score":150},{"index":2,"score":-10}]}`
		got, scored, err := parseListwiseScores(raw, 3)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if scored != 3 {
			t.Fatalf("scored=%d, want 3", scored)
		}
		want := []float64{0.9, 0.0, 1.0} // idx1=0.9, idx2=-10→clamp 0, idx3=150→clamp 1
		for i := range want {
			if !approxEq(got[i], want[i]) {
				t.Errorf("score[%d]=%v, want %v", i, got[i], want[i])
			}
		}
	})

	t.Run("missing index stays 0, count is distinct", func(t *testing.T) {
		raw := `{"scores":[{"index":1,"score":80}]}`
		got, scored, err := parseListwiseScores(raw, 3)
		if err != nil || scored != 1 {
			t.Fatalf("scored=%d err=%v, want 1, nil", scored, err)
		}
		if !approxEq(got[0], 0.8) || got[1] != 0 || got[2] != 0 {
			t.Errorf("got %v, want [0.8 0 0]", got)
		}
	})

	t.Run("out-of-range and duplicate indices ignored", func(t *testing.T) {
		raw := `{"scores":[{"index":1,"score":50},{"index":9,"score":99},{"index":1,"score":10}]}`
		got, scored, err := parseListwiseScores(raw, 2)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if scored != 1 { // only index 1 valid; the dup and the OOR index are dropped
			t.Fatalf("scored=%d, want 1", scored)
		}
		if !approxEq(got[0], 0.5) { // first write wins; dup 10 ignored
			t.Errorf("score[0]=%v, want 0.5", got[0])
		}
	})

	t.Run("unknown wrapper key recovered via loose fallback", func(t *testing.T) {
		raw := `{"relevance_v2":[{"index":1,"score":70},{"index":2,"score":30}]}`
		_, scored, err := parseListwiseScores(raw, 2)
		if err != nil || scored != 2 {
			t.Fatalf("loose recovery: scored=%d err=%v, want 2, nil", scored, err)
		}
	})

	t.Run("bare array + string score", func(t *testing.T) {
		raw := `[{"index":1,"score":"75"}]`
		got, scored, err := parseListwiseScores(raw, 1)
		if err != nil || scored != 1 || !approxEq(got[0], 0.75) {
			t.Fatalf("got=%v scored=%d err=%v, want [0.75] 1 nil", got, scored, err)
		}
	})

	t.Run("empty array → error so caller falls back", func(t *testing.T) {
		if _, _, err := parseListwiseScores(`{"scores":[]}`, 3); err == nil {
			t.Errorf("empty scores array should error")
		}
	})

	t.Run("no array present → error", func(t *testing.T) {
		if _, _, err := parseListwiseScores(`{"foo":"bar"}`, 3); err == nil {
			t.Errorf("no array should error")
		}
	})
}

// TestRerankDisabled: no reranker model configured → (nil, 0, nil), so callers skip.
func TestRerankDisabled(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://x"})
	got, scored, err := c.Rerank(context.Background(), "q", []string{"d"})
	if err != nil || got != nil || scored != 0 {
		t.Errorf("disabled reranker: want (nil, 0, nil), got (%v, %d, %v)", got, scored, err)
	}
}

// TestRerankListwise: with a reranker configured it makes ONE native /api/chat
// call (structured off by default) to rerankBaseURL() and returns one [0,1]
// score per doc, aligned to input order.
func TestRerankListwise(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		// Native /api/chat reply: the model content is the JSON scores object.
		_, _ = io.WriteString(w, `{"message":{"content":"{\"scores\":[{\"index\":1,\"score\":90},{\"index\":2,\"score\":20},{\"index\":3,\"score\":70}]}"}}`)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, RerankModel: "rr"})
	scores, scored, err := c.Rerank(context.Background(), "taste", []string{"a", "b", "c"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if gotPath != "/api/chat" {
		t.Errorf("path = %q, want /api/chat (structured off → native)", gotPath)
	}
	if scored != 3 {
		t.Fatalf("scored=%d, want 3", scored)
	}
	// Contract rerankCandidates depends on: one score per doc (it bails on a
	// len mismatch). Assert it explicitly.
	if len(scores) != 3 {
		t.Fatalf("len(scores)=%d, want 3 (must equal len(docs))", len(scores))
	}
	want := []float64{0.9, 0.2, 0.7}
	for i := range want {
		if !approxEq(scores[i], want[i]) {
			t.Errorf("score[%d]=%v, want %v", i, scores[i], want[i])
		}
	}
}

// TestRerankListwiseStructured: with structured outputs ON + a reasoning_effort
// set, the rerank takes the OpenAI /v1 path (oaiChatResponse shape) and still
// returns aligned scores.
func TestRerankListwiseStructured(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"{\"scores\":[{\"index\":1,\"score\":40},{\"index\":2,\"score\":95}]}"}}]}`)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, RerankModel: "rr", StructuredOutputs: true, ReasoningEffort: "low"})
	scores, scored, err := c.Rerank(context.Background(), "taste", []string{"a", "b"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if gotPath != "/v1/chat/completions" {
		t.Errorf("path = %q, want /v1/chat/completions (structured on + effort set)", gotPath)
	}
	if scored != 2 || len(scores) != 2 {
		t.Fatalf("scored=%d len=%d, want 2,2", scored, len(scores))
	}
	if !approxEq(scores[0], 0.4) || !approxEq(scores[1], 0.95) {
		t.Errorf("scores=%v, want [0.4 0.95]", scores)
	}
}

// TestRerankCallFails: when the rerank call errors (model/endpoint down), Rerank
// returns an error so the caller falls back wholesale to the un-reranked order
// rather than trusting an empty ranking.
func TestRerankCallFails(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer bad.Close()
	c := NewClient(Config{BaseURL: bad.URL, RerankModel: "rr"})
	if _, _, err := c.Rerank(context.Background(), "q", []string{"a", "b"}); err == nil {
		t.Errorf("a failing rerank call should return an error")
	}
}

// TestNewClientTrimsConfig: stray whitespace on operator-entered names/URLs is
// trimmed at construction, so a pasted trailing space can't silently break model
// lookup. A spaces-only value still falls back to the default.
func TestNewClientTrimsConfig(t *testing.T) {
	c := NewClient(Config{
		RerankModel: " gpt-oss:20b ",
		ChatModel:   " deepseek-v4-pro:cloud ",
		RerankURL:   "  http://127.0.0.1:11434 ",
	})
	if got := c.RerankModelName(); got != "gpt-oss:20b" {
		t.Errorf("RerankModel not trimmed: %q", got)
	}
	if got := c.ChatModel(); got != "deepseek-v4-pro:cloud" {
		t.Errorf("ChatModel not trimmed: %q", got)
	}
	if got := c.rerankBaseURL(); got != "http://127.0.0.1:11434" {
		t.Errorf("RerankURL not trimmed: %q", got)
	}
	// Spaces-only model still defaults (trim happens before the default check).
	if got := NewClient(Config{ChatModel: "   "}).ChatModel(); got != "qwen3:4b-instruct" {
		t.Errorf("spaces-only ChatModel should default, got %q", got)
	}
}
