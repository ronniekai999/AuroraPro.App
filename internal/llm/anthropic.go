package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Anthropic (Claude) chat adapter: the native Messages API, never the
// OpenAI-compat shim — that surface is a compatibility layer Anthropic
// documents as second-class, and the native API is what carries structured
// outputs (output_config.format) and effort. Chat only: Anthropic has no
// embeddings API, which is why EmbedProvider can never be "anthropic"
// (ValidEmbedProvider).
//
// Deliberate omissions, both load-bearing:
//   - temperature/top_p/top_k are never sent — current Claude models reject
//     them with a 400 (determinism comes from the prompts, as everywhere else).
//   - no `thinking` parameter — current models default to adaptive thinking;
//     depth is steered via output_config.effort, mapped from the same
//     llm_reasoning_effort setting the Ollama /v1 path uses.

const (
	// anthropicDefaultBaseURL is the compile-time chat host. Overridable via
	// Config.AnthropicBaseURL (env/tests only — never admin-editable, so the
	// stored key cannot be steered to an arbitrary host from the UI).
	anthropicDefaultBaseURL = "https://api.anthropic.com"

	// anthropicVersion is the required anthropic-version header value.
	anthropicVersion = "2023-06-01"

	// Quality-first default models (feature decision 2026-08): fast surfaces
	// ride Sonnet via the ChatModelFast() fallback, the heavy 24h-cached
	// Discover curation gets Opus. Aliases are stable (no date suffixes).
	anthropicDefaultChatModel  = "claude-sonnet-5"
	anthropicDefaultSmartModel = "claude-opus-5"

	// anthropicMaxTokens is sent as max_tokens, which the Messages API
	// REQUIRES. 8192 comfortably covers the largest JSON surface (flat
	// Discover rails). One place to raise if a surface ever truncates —
	// truncation is surfaced as a named error, not silent parse garbage.
	anthropicMaxTokens = 8192
)

// anthropicBaseURL returns the effective Anthropic endpoint.
func (c *Client) anthropicBaseURL() string {
	if c.cfg.AnthropicBaseURL != "" {
		return c.cfg.AnthropicBaseURL
	}
	return anthropicDefaultBaseURL
}

// setAnthropicAuth attaches the Messages API headers. Anthropic auth is
// x-api-key (NOT Authorization: Bearer — that header is never set on this
// host), plus the mandatory anthropic-version. Only the Anthropic key ever
// rides here: key-per-host isolation is structural because this helper is the
// single place Anthropic requests get credentials.
func (c *Client) setAnthropicAuth(req *http.Request) {
	req.Header.Set("x-api-key", c.cfg.AnthropicAPIKey)
	req.Header.Set("anthropic-version", anthropicVersion)
}

// anthropicEffort maps the shared llm_reasoning_effort setting onto
// output_config.effort. "none" means "suppress reasoning" in Aurora's Ollama
// vocabulary; the closest Messages-API equivalent is omitting the field and
// letting adaptive thinking self-regulate, same as unset.
func anthropicEffort(v string) string {
	switch v {
	case "low", "medium", "high":
		return v
	}
	return ""
}

// Wire shapes for POST /v1/messages (request) and its response. Only the
// fields Aurora uses — the tolerant llmjson parser downstream means we never
// need the full response surface.
type anthropicRequest struct {
	Model        string                 `json:"model"`
	MaxTokens    int                    `json:"max_tokens"`
	System       string                 `json:"system,omitempty"`
	Messages     []ChatMessage          `json:"messages"`
	OutputConfig *anthropicOutputConfig `json:"output_config,omitempty"`
}

type anthropicOutputConfig struct {
	Effort string                 `json:"effort,omitempty"`
	Format *anthropicOutputFormat `json:"format,omitempty"`
}

type anthropicOutputFormat struct {
	Type   string `json:"type"` // "json_schema"
	Schema any    `json:"schema"`
}

type anthropicResponse struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	StopReason string `json:"stop_reason"`
}

// chatAnthropic sends one system+user exchange to the Messages API and
// returns the text content. Mirrors the contract of chatNative /
// chatOpenAISchema: schema != nil requests enforced JSON via
// output_config.format (sanitized — the strict dialect rejects our loose
// keywords), non-2xx surfaces as *StatusError, and empty content is an error
// rather than a silent "".
func (c *Client) chatAnthropic(ctx context.Context, model, system, user string, schema any) (string, error) {
	var outputCfg *anthropicOutputConfig
	effort := anthropicEffort(c.cfg.ReasoningEffort)
	if schema != nil || effort != "" {
		outputCfg = &anthropicOutputConfig{Effort: effort}
		if schema != nil {
			outputCfg.Format = &anthropicOutputFormat{
				Type:   "json_schema",
				Schema: sanitizeStructuredSchema(schema),
			}
		}
	}
	body, err := json.Marshal(anthropicRequest{
		Model:     model,
		MaxTokens: anthropicMaxTokens,
		System:    system,
		Messages: []ChatMessage{
			{Role: "user", Content: user},
		},
		OutputConfig: outputCfg,
	})
	if err != nil {
		return "", err
	}
	url := c.anthropicBaseURL() + "/v1/messages"
	reqID := c.newReqID()
	start := time.Now()
	c.logRequest(ctx, reqID, url, model, body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	c.setAnthropicAuth(req)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("anthropic chat: %w", err)
	}
	defer resp.Body.Close()

	raw, capErr := readCappedBody(resp.Body)
	c.logResponseChat(ctx, reqID, resp.StatusCode, time.Since(start), raw)

	if resp.StatusCode != http.StatusOK {
		return "", &StatusError{Op: "anthropic chat", Status: resp.StatusCode, Body: snippet(raw, 512)}
	}
	if capErr != nil {
		return "", fmt.Errorf("anthropic chat: %w", capErr)
	}

	var out anthropicResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("anthropic chat: decode: %w", err)
	}
	switch out.StopReason {
	case "refusal":
		// Safety classifiers declined; content is empty or partial. A retry
		// with the same prompt would just repeat it — deliberately NOT a
		// StatusError so no retry-on-retryable path fires.
		return "", fmt.Errorf("anthropic chat: model refused the request (stop_reason=refusal)")
	case "max_tokens":
		// The JSON is almost certainly cut mid-structure — fail loudly with
		// the knob to turn instead of letting the parser chew on a fragment.
		return "", fmt.Errorf("anthropic chat: response truncated at max_tokens=%d — raise anthropicMaxTokens if a surface legitimately needs more", anthropicMaxTokens)
	}
	var b strings.Builder
	for _, block := range out.Content {
		if block.Type == "text" {
			b.WriteString(block.Text)
		}
	}
	content := b.String()
	if strings.TrimSpace(content) == "" {
		return "", fmt.Errorf("anthropic chat: empty content (stop_reason=%s)", out.StopReason)
	}
	return content, nil
}

// ListAnthropicModels returns the model IDs visible to the configured key —
// the admin Test-connection probe (key validation + datalist source).
// limit=1000 collapses pagination: the catalog is far smaller than that, and
// a truncated page would silently hide models from the admin UI.
func (c *Client) ListAnthropicModels(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.anthropicBaseURL()+"/v1/models?limit=1000", nil)
	if err != nil {
		return nil, err
	}
	c.setAnthropicAuth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("anthropic models: %w", err)
	}
	defer resp.Body.Close()
	raw, capErr := readCappedBody(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, &StatusError{Op: "anthropic models", Status: resp.StatusCode, Body: snippet(raw, 512)}
	}
	if capErr != nil {
		return nil, fmt.Errorf("anthropic models: %w", capErr)
	}
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("anthropic models: decode: %w", err)
	}
	ids := make([]string, 0, len(out.Data))
	for _, m := range out.Data {
		if m.ID != "" {
			ids = append(ids, m.ID)
		}
	}
	return ids, nil
}
