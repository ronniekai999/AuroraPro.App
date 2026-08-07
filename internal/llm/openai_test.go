package llm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const openaiOKBody = `{"choices":[{"message":{"role":"assistant","content":"{\"ok\":1}"}}]}`

// newOpenAIClient wires a Client at the fake server with all three keys
// populated, so bearer assertions double as key-isolation checks.
func newOpenAIClient(srvURL string, effort string) *Client {
	return NewClient(Config{
		Provider:        ProviderOpenAI,
		EmbedProvider:   ProviderOpenAI,
		OpenAIBaseURL:   srvURL,
		OpenAIAPIKey:    "sk-openai-test",
		AnthropicAPIKey: "sk-ant-test",
		APIKey:          "sk-ollama-test",
		ReasoningEffort: effort,
	})
}

// TestChatOpenAIRequestShape pins the wire contract: path, bearer carries the
// OPENAI key (not the Ollama Cloud key sharing the header name), temperature
// fully omitted (gpt-5-family rejects non-default values), reasoning_effort
// passthrough, response_format only with a schema.
func TestChatOpenAIRequestShape(t *testing.T) {
	var gotPath, gotAuthz string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuthz = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		_, _ = io.WriteString(w, openaiOKBody)
	}))
	defer srv.Close()

	c := newOpenAIClient(srv.URL, "low")
	out, err := c.ChatJSONWith(context.Background(), "gpt-5.6-terra", "sys", "usr", nil, false)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.Contains(out, "ok") {
		t.Errorf("content = %q", out)
	}
	if gotPath != "/v1/chat/completions" {
		t.Errorf("path = %q, want /v1/chat/completions", gotPath)
	}
	if gotAuthz != "Bearer sk-openai-test" {
		t.Errorf("Authorization = %q, want the OpenAI key — never the Ollama Cloud bearer", gotAuthz)
	}
	if _, present := body["temperature"]; present {
		t.Errorf("temperature must be fully omitted on api.openai.com (gpt-5 family rejects it); body=%v", body)
	}
	if got, _ := body["reasoning_effort"].(string); got != "low" {
		t.Errorf("reasoning_effort = %q, want passthrough of the setting", got)
	}
	if _, present := body["response_format"]; present {
		t.Errorf("nil schema must omit response_format; body=%v", body)
	}
}

// TestChatOpenAISchemaOnWire: schema non-nil → response_format json_schema
// with the SANITIZED schema (strict stays false; tolerant parser is the net).
func TestChatOpenAISchemaOnWire(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		_, _ = io.WriteString(w, openaiOKBody)
	}))
	defer srv.Close()

	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"reason": map[string]any{"type": "string", "maxLength": 200},
		},
	}
	c := newOpenAIClient(srv.URL, "")
	if _, err := c.ChatJSONWith(context.Background(), "m", "s", "u", schema, true); err != nil {
		t.Fatalf("err: %v", err)
	}
	rf, _ := body["response_format"].(map[string]any)
	if rt, _ := rf["type"].(string); rt != "json_schema" {
		t.Fatalf("response_format.type = %v, want json_schema", rf["type"])
	}
	js, _ := rf["json_schema"].(map[string]any)
	if strict, _ := js["strict"].(bool); strict {
		t.Errorf("strict must stay false (guidance, not hard validation)")
	}
	wire, _ := js["schema"].(map[string]any)
	if wire["additionalProperties"] != false {
		t.Errorf("sanitized schema must carry additionalProperties:false: %v", wire)
	}
	reason := wire["properties"].(map[string]any)["reason"].(map[string]any)
	if _, present := reason["maxLength"]; present {
		t.Errorf("maxLength must be stripped on the wire: %v", reason)
	}
}

// TestEmbedOpenAI: /v1/embeddings with model+input+dimensions, out-of-order
// index reassembly, empty-input nil vector, and the shared shaping tail
// (normalize to cfg.Dims).
func TestEmbedOpenAI(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/embeddings" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-openai-test" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		// Deliberately out of order: index 1 first. 4-dim vectors (test Dims).
		_, _ = io.WriteString(w, `{"data":[{"index":1,"embedding":[0,1,0,0]},{"index":0,"embedding":[1,0,0,0]},{"index":2,"embedding":[0,0,1,0]}]}`)
	}))
	defer srv.Close()

	c := NewClient(Config{
		EmbedProvider: ProviderOpenAI,
		OpenAIBaseURL: srv.URL,
		OpenAIAPIKey:  "sk-openai-test",
		Dims:          4,
	})
	got, err := c.EmbedBatch(context.Background(), []string{"first", "", "third"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if body["model"] != openaiDefaultEmbedModel {
		t.Errorf("model = %v, want default %q", body["model"], openaiDefaultEmbedModel)
	}
	if dims, _ := body["dimensions"].(float64); int(dims) != 4 {
		t.Errorf("dimensions = %v, want cfg.Dims", body["dimensions"])
	}
	if len(got) != 3 {
		t.Fatalf("want 3 vectors, got %d", len(got))
	}
	if got[0] == nil || got[0][0] != 1 {
		t.Errorf("index reassembly broken: got[0] = %v, want the index:0 vector", got[0])
	}
	if got[1] != nil {
		t.Errorf("empty input must map to nil vector, got %v", got[1])
	}
	if got[2] == nil || got[2][2] != 1 {
		t.Errorf("index reassembly broken: got[2] = %v, want the index:2 vector", got[2])
	}
}

// TestEmbedOpenAIDimsMismatch: a model narrower than cfg.Dims fails loudly
// via the shared shaping guard (prevents the backfill hot-spin).
func TestEmbedOpenAIDimsMismatch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"data":[{"index":0,"embedding":[1,0]}]}`)
	}))
	defer srv.Close()
	c := NewClient(Config{EmbedProvider: ProviderOpenAI, OpenAIBaseURL: srv.URL, OpenAIAPIKey: "k", Dims: 4})
	_, err := c.EmbedBatch(context.Background(), []string{"x"})
	if err == nil || !strings.Contains(err.Error(), "openai embed") || !strings.Contains(err.Error(), "dims") {
		t.Errorf("want openai-embed dims error, got %v", err)
	}
}

// TestEmbedOpenAICountMismatch: fewer vectors than inputs is an error, not a
// silent partial batch.
func TestEmbedOpenAICountMismatch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"data":[{"index":0,"embedding":[1,0,0,0]}]}`)
	}))
	defer srv.Close()
	c := NewClient(Config{EmbedProvider: ProviderOpenAI, OpenAIBaseURL: srv.URL, OpenAIAPIKey: "k", Dims: 4})
	if _, err := c.EmbedBatch(context.Background(), []string{"a", "b"}); err == nil || !strings.Contains(err.Error(), "vectors for") {
		t.Errorf("want count-mismatch error, got %v", err)
	}
}

// TestOpenAIStatusErrors: 401 maps to a non-retryable typed error with a
// backend-truthful message.
func TestOpenAIStatusErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":{"message":"bad key"}}`)
	}))
	defer srv.Close()
	c := newOpenAIClient(srv.URL, "")
	_, err := c.ChatJSONWith(context.Background(), "m", "s", "u", nil, false)
	var se *StatusError
	if !errors.As(err, &se) || se.Status != http.StatusUnauthorized || se.IsRetryable() {
		t.Fatalf("want non-retryable 401 *StatusError, got %v", err)
	}
	if !strings.Contains(err.Error(), "openai chat") || strings.Contains(err.Error(), "ollama") {
		t.Errorf("openai error must name its backend without an 'ollama' prefix: %v", err)
	}
}

// TestListOpenAIModels: GET /v1/models with the bearer, {data:[{id}]} decode.
func TestListOpenAIModels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-openai-test" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		_, _ = io.WriteString(w, `{"data":[{"id":"gpt-5.6-sol"},{"id":"text-embedding-3-small"}]}`)
	}))
	defer srv.Close()
	c := newOpenAIClient(srv.URL, "")
	ids, err := c.ListOpenAIModels(context.Background())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(ids) != 2 {
		t.Errorf("ids = %v", ids)
	}
}

// TestPingOpenAIEmbedProvider: with EmbedProvider=openai, Ping probes
// api.openai.com's models endpoint — never an Ollama URL — so an all-cloud
// box with no Ollama boots cleanly.
func TestPingOpenAIEmbedProvider(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = io.WriteString(w, `{"data":[]}`)
	}))
	defer srv.Close()
	c := NewClient(Config{
		Provider:      ProviderAnthropic, // chat elsewhere — ping still follows embeds
		EmbedProvider: ProviderOpenAI,
		OpenAIBaseURL: srv.URL,
		OpenAIAPIKey:  "sk-openai-test",
		BaseURL:       "http://127.0.0.1:1", // unreachable Ollama — must never be dialed
	})
	if err := c.Ping(context.Background()); err != nil {
		t.Fatalf("ping err: %v", err)
	}
	if gotPath != "/v1/models" {
		t.Errorf("ping path = %q, want /v1/models", gotPath)
	}
}
