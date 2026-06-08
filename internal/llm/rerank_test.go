package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// score decodes a /v1 rerank reply body and runs the pure scorer over it — this
// exercises both the JSON shape and the yes/no extraction.
func score(t *testing.T, body string) float64 {
	t.Helper()
	var out rerankResponse
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return scoreFromRerankResponse(&out)
}

func TestScoreFromRerankResponse(t *testing.T) {
	// Graded path: "yes" much more likely than "no" → high score.
	yesHigh := `{"choices":[{"message":{"content":"yes"},"logprobs":{"content":[{"token":"yes","top_logprobs":[{"token":"yes","logprob":-0.1},{"token":"no","logprob":-2.3}]}]}}]}`
	if s := score(t, yesHigh); s <= 0.8 {
		t.Errorf("yes-dominant: want > 0.8, got %v", s)
	}
	// "no" dominant → low score.
	noHigh := `{"choices":[{"message":{"content":"no"},"logprobs":{"content":[{"token":"no","top_logprobs":[{"token":"no","logprob":-0.05},{"token":"yes","logprob":-3.0}]}]}}]}`
	if s := score(t, noHigh); s >= 0.2 {
		t.Errorf("no-dominant: want < 0.2, got %v", s)
	}
	// Only "yes" present in top_logprobs → still high (absent side treated as far less likely).
	onlyYes := `{"choices":[{"message":{"content":"yes"},"logprobs":{"content":[{"token":" Yes","logprob":-0.2}]}}]}`
	if s := score(t, onlyYes); s <= 0.9 {
		t.Errorf("only-yes (with leading space + caps): want > 0.9, got %v", s)
	}
	// No logprobs at all (Ollama build without support) → text fallback.
	if s := score(t, `{"choices":[{"message":{"content":"Yes, relevant"}}]}`); s != 1.0 {
		t.Errorf("text-yes fallback: want 1.0, got %v", s)
	}
	if s := score(t, `{"choices":[{"message":{"content":"no"}}]}`); s != 0.0 {
		t.Errorf("text-no fallback: want 0.0, got %v", s)
	}
	// Degenerate: no choices → 0.
	if s := score(t, `{"choices":[]}`); s != 0 {
		t.Errorf("empty choices: want 0, got %v", s)
	}
}

// TestNewClientTrimsConfig: stray whitespace on operator-entered names/URLs is
// trimmed at construction, so a pasted trailing space can't silently break model
// lookup (the reranker "unreachable" footgun). A spaces-only value still falls
// back to the default.
func TestNewClientTrimsConfig(t *testing.T) {
	c := NewClient(Config{
		RerankModel: " dengcao/Qwen3-Reranker-0.6B ",
		ChatModel:   " gpt-oss:20b ",
		RerankURL:   "  http://127.0.0.1:11434 ",
	})
	if got := c.RerankModelName(); got != "dengcao/Qwen3-Reranker-0.6B" {
		t.Errorf("RerankModel not trimmed: %q", got)
	}
	if got := c.ChatModel(); got != "gpt-oss:20b" {
		t.Errorf("ChatModel not trimmed: %q", got)
	}
	if got := c.rerankBaseURL(); got != "http://127.0.0.1:11434" {
		t.Errorf("RerankURL not trimmed: %q", got)
	}
	// Spaces-only model still defaults (trim happens before the default check).
	if got := NewClient(Config{ChatModel: "   "}).ChatModel(); got != "qwen2.5:1.5b-instruct" {
		t.Errorf("spaces-only ChatModel should default, got %q", got)
	}
}

// TestRerankDisabled: no reranker model configured → (nil, nil), so callers skip.
func TestRerankDisabled(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://x"})
	got, scored, err := c.Rerank(context.Background(), "q", []string{"d"})
	if err != nil || got != nil || scored != 0 {
		t.Errorf("disabled reranker: want (nil, 0, nil), got (%v, %d, %v)", got, scored, err)
	}
}

// TestRerankScores: with a reranker configured it POSTs to /v1/chat/completions on
// the reranker URL and returns one score per doc.
func TestRerankScores(t *testing.T) {
	// Rerank fans out one goroutine per doc, so the handler runs concurrently —
	// guard the captured path to keep `go test -race` clean.
	var mu sync.Mutex
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotPath = r.URL.Path
		mu.Unlock()
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"yes"},"logprobs":{"content":[{"token":"yes","top_logprobs":[{"token":"yes","logprob":-0.1},{"token":"no","logprob":-3}]}]}}]}`)
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: "http://unused", RerankModel: "rr", RerankURL: srv.URL})
	scores, scored, err := c.Rerank(context.Background(), "taste", []string{"a", "b", "c"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	mu.Lock()
	gp := gotPath
	mu.Unlock()
	if gp != "/v1/chat/completions" {
		t.Errorf("path = %q, want /v1/chat/completions", gp)
	}
	if len(scores) != 3 || scored != 3 {
		t.Fatalf("want 3 scores + scored=3, got len=%d scored=%d", len(scores), scored)
	}
	for i, s := range scores {
		if s <= 0.5 {
			t.Errorf("score[%d] = %v, want > 0.5 (yes-dominant)", i, s)
		}
	}
}

// TestRerankAllFail: when every pair errors (reranker down), Rerank returns an
// error so the caller can fall back wholesale to the un-reranked order rather
// than trusting an all-zero ranking.
func TestRerankAllFail(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer bad.Close()
	c := NewClient(Config{BaseURL: "http://unused", RerankModel: "rr", RerankURL: bad.URL})
	if _, _, err := c.Rerank(context.Background(), "q", []string{"a", "b"}); err == nil {
		t.Errorf("all pairs failing should return an error")
	}
}
