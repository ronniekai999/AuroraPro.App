package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestChatJSONWithNative: structured=false hits Ollama's native /api/chat and
// uses the explicitly-passed model.
func TestChatJSONWithNative(t *testing.T) {
	var gotPath, gotModel string
	var gotHasFormat bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		var body map[string]any
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		gotModel, _ = body["model"].(string)
		_, gotHasFormat = body["format"]
		_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"{\"ok\":true}"}}`)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, ChatModel: "default-model"})
	out, err := c.ChatJSONWith(context.Background(), "fast-model", "sys", "usr", map[string]any{"type": "object"}, false)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if gotPath != "/api/chat" {
		t.Errorf("native path = %q, want /api/chat", gotPath)
	}
	if gotModel != "fast-model" {
		t.Errorf("model = %q, want fast-model", gotModel)
	}
	if !gotHasFormat {
		t.Errorf("native request must serialize the schema into the `format` field")
	}
	if !strings.Contains(out, "ok") {
		t.Errorf("content = %q", out)
	}
}

// TestChatJSONWithStructured: structured=true (with a schema) hits the
// OpenAI-compatible /v1/chat/completions endpoint with response_format, and an
// empty model falls back to the configured default.
func TestChatJSONWithStructured(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &gotBody)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"{\"ok\":1}"}}]}`)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, ChatModel: "default-model"})
	out, err := c.ChatJSONWith(context.Background(), "", "sys", "usr", map[string]any{"type": "object"}, true)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if gotPath != "/v1/chat/completions" {
		t.Errorf("structured path = %q, want /v1/chat/completions", gotPath)
	}
	if _, ok := gotBody["response_format"]; !ok {
		t.Errorf("structured request missing response_format: %v", gotBody)
	}
	if m, _ := gotBody["model"].(string); m != "default-model" {
		t.Errorf("empty model should fall back to default; got %q", m)
	}
	if !strings.Contains(out, "ok") {
		t.Errorf("content = %q", out)
	}
}

// TestChatJSONWithStructuredNilSchemaStaysNative: structured=true but schema==nil
// must NOT use the OpenAI path (Discover passes nil today).
func TestChatJSONWithStructuredNilSchemaStaysNative(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = io.WriteString(w, `{"message":{"content":"{}"}}`)
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, ChatModel: "m"})
	if _, err := c.ChatJSONWith(context.Background(), "m", "s", "u", nil, true); err != nil {
		t.Fatalf("err: %v", err)
	}
	if gotPath != "/api/chat" {
		t.Errorf("nil-schema structured path = %q, want /api/chat", gotPath)
	}
}

// TestChatJSONBackCompat: the legacy ChatJSON entry point still uses native
// /api/chat on the default model.
func TestChatJSONBackCompat(t *testing.T) {
	var gotPath, gotModel string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		var body map[string]any
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		gotModel, _ = body["model"].(string)
		_, _ = io.WriteString(w, `{"message":{"content":"{}"}}`)
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, ChatModel: "default-model"})
	if _, err := c.ChatJSON(context.Background(), "s", "u", nil); err != nil {
		t.Fatalf("err: %v", err)
	}
	if gotPath != "/api/chat" || gotModel != "default-model" {
		t.Errorf("ChatJSON path=%q model=%q, want /api/chat default-model", gotPath, gotModel)
	}
}

// TestChatModelAccessorsFallback: fast/smart fall back to ChatModel when unset;
// honored when set.
func TestChatModelAccessorsFallback(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://x", ChatModel: "base"})
	if c.ChatModelFast() != "base" || c.ChatModelSmart() != "base" || c.UseStructured() {
		t.Errorf("unset: fast=%q smart=%q structured=%v", c.ChatModelFast(), c.ChatModelSmart(), c.UseStructured())
	}
	c2 := NewClient(Config{BaseURL: "http://x", ChatModel: "base", ChatModelFast: "f", ChatModelSmart: "s", StructuredOutputs: true})
	if c2.ChatModelFast() != "f" || c2.ChatModelSmart() != "s" || !c2.UseStructured() {
		t.Errorf("set: fast=%q smart=%q structured=%v", c2.ChatModelFast(), c2.ChatModelSmart(), c2.UseStructured())
	}
}

// TestChatJSONWithStructured500: a 5xx on the OpenAI path must keep the
// "ollama chat: status 5..." error shape — that exact substring is the
// cross-package contract isLLMServerError (recommender/discover.go) matches to
// fire the 5xx retry. A reworded error would silently disable that retry.
func TestChatJSONWithStructured500(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{"error":"boom"}`)
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, ChatModel: "m"})
	_, err := c.ChatJSONWith(context.Background(), "m", "s", "u", map[string]any{"type": "object"}, true)
	if err == nil || !strings.Contains(err.Error(), "ollama chat: status 5") {
		t.Errorf("want error containing 'ollama chat: status 5', got %v", err)
	}
}

// TestChatJSONWithStructuredEmptyChoices: a 200 with no choices is an error,
// not a silent empty string.
func TestChatJSONWithStructuredEmptyChoices(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"choices":[]}`)
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, ChatModel: "m"})
	if _, err := c.ChatJSONWith(context.Background(), "m", "s", "u", map[string]any{"type": "object"}, true); err == nil || !strings.Contains(err.Error(), "empty choices") {
		t.Errorf("want 'empty choices' error, got %v", err)
	}
}

// TestChatJSONWithStructuredDecodeError: a non-JSON 200 body surfaces a decode
// error rather than panicking or returning garbage.
func TestChatJSONWithStructuredDecodeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `not json at all`)
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, ChatModel: "m"})
	if _, err := c.ChatJSONWith(context.Background(), "m", "s", "u", map[string]any{"type": "object"}, true); err == nil || !strings.Contains(err.Error(), "decode") {
		t.Errorf("want decode error, got %v", err)
	}
}

// TestChatJSONWithStructuredReasoningEffort: when ReasoningEffort is configured,
// the /v1 request carries reasoning_effort (the knob that stops gpt-oss runaway
// reasoning / empty content on the hero surface).
func TestChatJSONWithStructuredReasoningEffort(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"{\"ok\":1}"}}]}`)
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, ChatModel: "m", ReasoningEffort: "low"})
	if _, err := c.ChatJSONWith(context.Background(), "m", "s", "u", map[string]any{"type": "object"}, true); err != nil {
		t.Fatalf("err: %v", err)
	}
	if got, _ := body["reasoning_effort"].(string); got != "low" {
		t.Errorf("reasoning_effort = %q, want low; body=%v", got, body)
	}
}

// TestChatJSONWithStructuredNoReasoningEffortWhenUnset: unset → field omitted.
func TestChatJSONWithStructuredNoReasoningEffortWhenUnset(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"{}"}}]}`)
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, ChatModel: "m"})
	if _, err := c.ChatJSONWith(context.Background(), "m", "s", "u", map[string]any{"type": "object"}, true); err != nil {
		t.Fatalf("err: %v", err)
	}
	if _, present := body["reasoning_effort"]; present {
		t.Errorf("reasoning_effort should be omitted when unset; body=%v", body)
	}
}

// TestChatJSONWithStructuredEmptyContent: a 200 with empty content (reasoning ran
// long) is surfaced as an error so the caller falls back cleanly — not handed an
// empty string the downstream parser chokes on.
func TestChatJSONWithStructuredEmptyContent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":""}}]}`)
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, ChatModel: "m"})
	if _, err := c.ChatJSONWith(context.Background(), "m", "s", "u", map[string]any{"type": "object"}, true); err == nil || !strings.Contains(err.Error(), "empty content") {
		t.Errorf("want 'empty content' error, got %v", err)
	}
}

// TestChatJSONNativeOmitsReasoningEffort pins the invariant that reasoning_effort
// is a /v1-only field: even with ReasoningEffort configured, the native
// /api/chat request must NOT carry it (a future struct-unification could
// regress this silently).
func TestChatJSONNativeOmitsReasoningEffort(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		_, _ = io.WriteString(w, `{"message":{"content":"{}"}}`)
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, ChatModel: "m", ReasoningEffort: "low"})
	if _, err := c.ChatJSONWith(context.Background(), "m", "s", "u", map[string]any{"type": "object"}, false); err != nil {
		t.Fatalf("err: %v", err)
	}
	if _, present := body["reasoning_effort"]; present {
		t.Errorf("native /api/chat must NOT carry reasoning_effort; body=%v", body)
	}
}
