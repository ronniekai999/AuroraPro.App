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

// anthropicOKBody is a minimal Messages API success payload.
const anthropicOKBody = `{"content":[{"type":"text","text":"{\"ok\":1}"}],"stop_reason":"end_turn"}`

// newAnthropicClient wires a Client at the fake server with all three keys
// populated, so header assertions double as key-isolation checks.
func newAnthropicClient(srvURL string, effort string) *Client {
	return NewClient(Config{
		Provider:         ProviderAnthropic,
		AnthropicBaseURL: srvURL,
		AnthropicAPIKey:  "sk-ant-test",
		OpenAIAPIKey:     "sk-openai-test",
		APIKey:           "sk-ollama-test",
		ReasoningEffort:  effort,
	})
}

// TestChatAnthropicRequestShape pins the wire contract: path, auth headers
// (x-api-key + anthropic-version, never Authorization), required max_tokens,
// top-level system, single user message, and NO sampling parameters — current
// Claude models reject temperature/top_p/top_k with a 400.
func TestChatAnthropicRequestShape(t *testing.T) {
	var gotPath, gotAPIKey, gotVersion, gotAuthz string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAPIKey = r.Header.Get("x-api-key")
		gotVersion = r.Header.Get("anthropic-version")
		gotAuthz = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		_, _ = io.WriteString(w, anthropicOKBody)
	}))
	defer srv.Close()

	c := newAnthropicClient(srv.URL, "")
	out, err := c.ChatJSONWith(context.Background(), "claude-sonnet-5", "sys", "usr", nil, false)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.Contains(out, "ok") {
		t.Errorf("content = %q", out)
	}
	if gotPath != "/v1/messages" {
		t.Errorf("path = %q, want /v1/messages", gotPath)
	}
	if gotAPIKey != "sk-ant-test" {
		t.Errorf("x-api-key = %q, want the Anthropic key", gotAPIKey)
	}
	if gotVersion != anthropicVersion {
		t.Errorf("anthropic-version = %q, want %q", gotVersion, anthropicVersion)
	}
	if gotAuthz != "" {
		t.Errorf("Authorization must never be sent to Anthropic (got %q) — that header carries other providers' bearers", gotAuthz)
	}
	if mt, _ := body["max_tokens"].(float64); int(mt) != anthropicMaxTokens {
		t.Errorf("max_tokens = %v, want %d (REQUIRED by the Messages API)", body["max_tokens"], anthropicMaxTokens)
	}
	if sys, _ := body["system"].(string); sys != "sys" {
		t.Errorf("system = %q, want top-level string", body["system"])
	}
	msgs, _ := body["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("messages = %v, want a single user turn", body["messages"])
	}
	if role, _ := msgs[0].(map[string]any)["role"].(string); role != "user" {
		t.Errorf("messages[0].role = %q, want user", role)
	}
	for _, banned := range []string{"temperature", "top_p", "top_k", "thinking"} {
		if _, present := body[banned]; present {
			t.Errorf("request must not carry %q (current Claude models reject it); body=%v", banned, body)
		}
	}
}

// TestChatAnthropicEffortMapping: low/medium/high ride output_config.effort;
// "none" and "" omit it (adaptive thinking self-regulates).
func TestChatAnthropicEffortMapping(t *testing.T) {
	cases := []struct {
		effort     string
		wantEffort string // "" = output_config.effort absent
	}{
		{"low", "low"},
		{"medium", "medium"},
		{"high", "high"},
		{"none", ""},
		{"", ""},
	}
	for _, cse := range cases {
		t.Run("effort="+cse.effort, func(t *testing.T) {
			var body map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				_ = json.Unmarshal(b, &body)
				_, _ = io.WriteString(w, anthropicOKBody)
			}))
			defer srv.Close()
			c := newAnthropicClient(srv.URL, cse.effort)
			if _, err := c.ChatJSONWith(context.Background(), "m", "s", "u", nil, true); err != nil {
				t.Fatalf("err: %v", err)
			}
			oc, _ := body["output_config"].(map[string]any)
			gotEffort, _ := oc["effort"].(string)
			if gotEffort != cse.wantEffort {
				t.Errorf("output_config.effort = %q, want %q (body=%v)", gotEffort, cse.wantEffort, body)
			}
		})
	}
}

// TestChatAnthropicSchema: a non-nil schema rides output_config.format as
// json_schema, sanitized — additionalProperties:false injected, unsupported
// keywords stripped.
func TestChatAnthropicSchema(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		_, _ = io.WriteString(w, anthropicOKBody)
	}))
	defer srv.Close()

	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"score": map[string]any{"type": "integer", "minimum": 0},
		},
		"required": []string{"score"},
	}
	c := newAnthropicClient(srv.URL, "")
	if _, err := c.ChatJSONWith(context.Background(), "m", "s", "u", schema, false); err != nil {
		t.Fatalf("err: %v", err)
	}
	oc, _ := body["output_config"].(map[string]any)
	format, _ := oc["format"].(map[string]any)
	if ft, _ := format["type"].(string); ft != "json_schema" {
		t.Fatalf("output_config.format.type = %q, want json_schema (body=%v)", ft, body)
	}
	wire, _ := format["schema"].(map[string]any)
	if wire["additionalProperties"] != false {
		t.Errorf("sanitized schema must carry additionalProperties:false, got %v", wire)
	}
	score := wire["properties"].(map[string]any)["score"].(map[string]any)
	if _, present := score["minimum"]; present {
		t.Errorf("unsupported keyword `minimum` must be stripped on the wire: %v", score)
	}
	// The caller's schema var must be untouched.
	if _, present := schema["additionalProperties"]; present {
		t.Errorf("caller schema was mutated: %v", schema)
	}
}

// TestChatAnthropicTextExtraction: text blocks are concatenated and non-text
// blocks (thinking) are skipped.
func TestChatAnthropicTextExtraction(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"{\"a\":"},{"type":"text","text":"1}"}],"stop_reason":"end_turn"}`)
	}))
	defer srv.Close()
	c := newAnthropicClient(srv.URL, "")
	out, err := c.ChatJSONWith(context.Background(), "m", "s", "u", nil, false)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out != `{"a":1}` {
		t.Errorf("concatenated text = %q, want {\"a\":1}", out)
	}
}

// TestChatAnthropicStopReasons: refusal and max_tokens surface as errors —
// and NOT as *StatusError, so the discover retry (retryable-only) never
// replays them.
func TestChatAnthropicStopReasons(t *testing.T) {
	cases := []struct {
		name, body, wantSubstr string
	}{
		{"refusal", `{"content":[],"stop_reason":"refusal"}`, "refused"},
		{"max_tokens", `{"content":[{"type":"text","text":"{\"partial\":"}],"stop_reason":"max_tokens"}`, "truncated"},
		{"empty content", `{"content":[],"stop_reason":"end_turn"}`, "empty content"},
	}
	for _, cse := range cases {
		t.Run(cse.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, cse.body)
			}))
			defer srv.Close()
			c := newAnthropicClient(srv.URL, "")
			_, err := c.ChatJSONWith(context.Background(), "m", "s", "u", nil, false)
			if err == nil || !strings.Contains(err.Error(), cse.wantSubstr) {
				t.Fatalf("want error containing %q, got %v", cse.wantSubstr, err)
			}
			var se *StatusError
			if errors.As(err, &se) {
				t.Errorf("stop-reason outcomes must not be *StatusError (they are not retryable transport failures): %v", err)
			}
		})
	}
}

// TestChatAnthropicStatusErrors: non-2xx maps to *StatusError with the right
// status and retryability class (401 no, 429 yes, 529 yes), rendering a
// backend-truthful message (no misleading "ollama" prefix).
func TestChatAnthropicStatusErrors(t *testing.T) {
	cases := []struct {
		status        int
		wantRetryable bool
	}{
		{http.StatusUnauthorized, false},
		{http.StatusTooManyRequests, true},
		{529, true},
	}
	for _, cse := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(cse.status)
			_, _ = io.WriteString(w, `{"type":"error","error":{"type":"x","message":"y"}}`)
		}))
		c := newAnthropicClient(srv.URL, "")
		_, err := c.ChatJSONWith(context.Background(), "m", "s", "u", nil, false)
		srv.Close()
		var se *StatusError
		if !errors.As(err, &se) || se.Status != cse.status {
			t.Fatalf("status %d: want typed *StatusError, got %v", cse.status, err)
		}
		if se.IsRetryable() != cse.wantRetryable {
			t.Errorf("status %d: IsRetryable = %v, want %v", cse.status, se.IsRetryable(), cse.wantRetryable)
		}
		if strings.Contains(err.Error(), "ollama") {
			t.Errorf("anthropic error must not render an 'ollama' prefix: %v", err)
		}
		if !strings.Contains(err.Error(), "anthropic chat") {
			t.Errorf("anthropic error should name its backend: %v", err)
		}
	}
}

// TestListAnthropicModels: GET /v1/models with auth headers, {data:[{id}]}
// decode, pagination collapsed via limit=1000.
func TestListAnthropicModels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.URL.Query().Get("limit") != "1000" {
			t.Errorf("limit = %q, want 1000 (collapse pagination)", r.URL.Query().Get("limit"))
		}
		if r.Header.Get("x-api-key") != "sk-ant-test" || r.Header.Get("anthropic-version") == "" {
			t.Errorf("missing auth headers")
		}
		_, _ = io.WriteString(w, `{"data":[{"id":"claude-opus-5"},{"id":"claude-sonnet-5"},{"id":""}]}`)
	}))
	defer srv.Close()
	c := newAnthropicClient(srv.URL, "")
	ids, err := c.ListAnthropicModels(context.Background())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(ids) != 2 || ids[0] != "claude-opus-5" || ids[1] != "claude-sonnet-5" {
		t.Errorf("ids = %v", ids)
	}
}

// TestCrossHostRedirectRefused pins credential containment on redirects:
// Go's http.Client strips Authorization on a cross-host hop but FORWARDS
// custom headers like x-api-key, so the guarded client must refuse the hop
// outright. The attacker host must never be dialed with the key.
func TestCrossHostRedirectRefused(t *testing.T) {
	var attackerHit bool
	var attackerSawKey string
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attackerHit = true
		attackerSawKey = r.Header.Get("x-api-key")
		_, _ = io.WriteString(w, anthropicOKBody)
	}))
	defer attacker.Close()
	// Different host:port than the attacker server → cross-host redirect.
	vendor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, attacker.URL+"/v1/messages", http.StatusFound)
	}))
	defer vendor.Close()

	c := newAnthropicClient(vendor.URL, "")
	_, err := c.ChatJSONWith(context.Background(), "m", "s", "u", nil, false)
	if err == nil || !strings.Contains(err.Error(), "cross-host redirect") {
		t.Fatalf("want cross-host-redirect refusal, got %v", err)
	}
	if attackerHit {
		t.Fatalf("redirect target was dialed (x-api-key seen: %q) — credential containment broken", attackerSawKey)
	}
}
