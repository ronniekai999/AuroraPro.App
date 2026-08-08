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

// OpenAI (ChatGPT) adapter: chat rides the /v1/chat/completions surface the
// package already speaks for Ollama Cloud (oaiChatRequest in client.go), and
// embeddings ride /v1/embeddings — text-embedding-3 models accept a
// `dimensions` request param, so cfg.Dims (768, matching migration 040's
// vector(768) column) is requested directly and no schema change is needed.
//
// One deliberate divergence from the Ollama /v1 path: temperature is OMITTED
// entirely. The Ollama path pins 0.1 for determinism, but gpt-5-family
// reasoning models reject non-default temperature values with a 400 —
// determinism comes from the prompts here, same as on the Anthropic adapter.

const (
	// openaiDefaultBaseURL is the compile-time host. Overridable via
	// Config.OpenAIBaseURL (env/tests only — never admin-editable, so the
	// stored key cannot be steered to an arbitrary host from the UI).
	openaiDefaultBaseURL = "https://api.openai.com"

	// Quality-first default models (feature decision 2026-08): fast surfaces
	// ride the balanced tier via the ChatModelFast() fallback, the heavy
	// 24h-cached Discover curation gets the flagship. IDs verified against
	// the GPT-5.6 launch docs 2026-08; the admin UI's Test connection lists
	// the live /v1/models catalog, so these only govern empty model fields.
	openaiDefaultChatModel  = "gpt-5.6-terra"
	openaiDefaultSmartModel = "gpt-5.6-sol"

	// openaiDefaultEmbedModel at dimensions=768 fits the existing pgvector
	// column exactly (see EmbedSpaceID for the re-embed contract when the
	// embedding space changes).
	openaiDefaultEmbedModel = "text-embedding-3-small"
)

// openaiBaseURL returns the effective OpenAI endpoint.
func (c *Client) openaiBaseURL() string {
	if c.cfg.OpenAIBaseURL != "" {
		return c.cfg.OpenAIBaseURL
	}
	return openaiDefaultBaseURL
}

// setOpenAIAuth attaches the OpenAI bearer. Only the OpenAI key ever rides
// here — never cfg.APIKey (the Ollama Cloud bearer) — mirroring
// setAnthropicAuth's structural key-per-host isolation.
func (c *Client) setOpenAIAuth(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.cfg.OpenAIAPIKey)
}

// chatOpenAI sends one system+user exchange to api.openai.com. Parallel in
// structure to chatOpenAISchema (the Ollama /v1 path) rather than shared with
// it — the ~40 duplicated lines keep the battle-tested Ollama path
// byte-identical while this one drops temperature and swaps auth.
func (c *Client) chatOpenAI(ctx context.Context, model, system, user string, schema any) (string, error) {
	var responseFormat *oaiResponseFormat
	if schema != nil {
		// strict:false on purpose, same reasoning as the Ollama /v1 path:
		// strong guidance without hard validation, the tolerant llmjson
		// parser is the real safety net. The sanitizer still runs so the
		// schema never carries keywords the dialect rejects outright.
		responseFormat = &oaiResponseFormat{
			Type:       "json_schema",
			JSONSchema: oaiJSONSchema{Name: "result", Schema: sanitizeStructuredSchema(schema), Strict: false},
		}
	}
	body, err := json.Marshal(oaiChatRequest{
		Model: model,
		Messages: []ChatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		// Temperature deliberately nil → omitted (see package comment).
		ReasoningEffort: c.cfg.ReasoningEffort, // omitempty when unset; valid values pass through
		ResponseFormat:  responseFormat,
	})
	if err != nil {
		return "", err
	}
	url := c.openaiBaseURL() + "/v1/chat/completions"
	reqID := c.newReqID()
	start := time.Now()
	c.logRequest(ctx, reqID, url, model, body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	c.setOpenAIAuth(req)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("openai chat: %w", err)
	}
	defer resp.Body.Close()

	raw, capErr := readCappedBody(resp.Body)
	c.logResponseChat(ctx, reqID, resp.StatusCode, time.Since(start), raw)

	if resp.StatusCode != http.StatusOK {
		return "", &StatusError{Op: "openai chat", Status: resp.StatusCode, Body: snippet(raw, 512)}
	}
	if capErr != nil {
		return "", fmt.Errorf("openai chat: %w", capErr)
	}

	var out oaiChatResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("openai chat: decode: %w", err)
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("openai chat: empty choices")
	}
	content := out.Choices[0].Message.Content
	if strings.TrimSpace(content) == "" {
		return "", fmt.Errorf("openai chat: empty content (reasoning ran long — try llm_reasoning_effort=low)")
	}
	return content, nil
}

// Wire shapes for POST /v1/embeddings. The response's data entries carry an
// index — placement goes by it, never by array order, which the API does not
// guarantee.
type oaiEmbedRequest struct {
	Model      string   `json:"model"`
	Input      []string `json:"input"`
	Dimensions int      `json:"dimensions,omitempty"`
}

type oaiEmbedResponse struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
}

// embedOpenAI returns one raw vector per input, in input order. Post-shaping
// (truncate/normalize/dims guard) is the caller's job — EmbedBatch runs the
// same shapeEmbeddings tail over both providers.
func (c *Client) embedOpenAI(ctx context.Context, cleaned []string) ([][]float32, error) {
	body, err := json.Marshal(oaiEmbedRequest{
		Model:      c.cfg.EmbedModel,
		Input:      cleaned,
		Dimensions: c.cfg.Dims, // text-embedding-3 emits exactly this many dims
	})
	if err != nil {
		return nil, err
	}
	url := c.openaiBaseURL() + "/v1/embeddings"
	reqID := c.newReqID()
	c.logRequest(ctx, reqID, url, c.cfg.EmbedModel, body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	c.setOpenAIAuth(req)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openai embed: %w", err)
	}
	defer resp.Body.Close()

	raw, capErr := readCappedBody(resp.Body)
	c.logResponseEmbed(reqID, resp.StatusCode, raw)

	if resp.StatusCode != http.StatusOK {
		return nil, &StatusError{Op: "openai embed", Status: resp.StatusCode, Body: snippet(raw, 512)}
	}
	if capErr != nil {
		return nil, fmt.Errorf("openai embed: %w", capErr)
	}

	var out oaiEmbedResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("openai embed: decode: %w", err)
	}
	if len(out.Data) != len(cleaned) {
		return nil, fmt.Errorf("openai embed: got %d vectors for %d inputs", len(out.Data), len(cleaned))
	}
	vectors := make([][]float32, len(cleaned))
	for _, d := range out.Data {
		if d.Index < 0 || d.Index >= len(vectors) {
			return nil, fmt.Errorf("openai embed: vector index %d out of range for %d inputs", d.Index, len(cleaned))
		}
		if vectors[d.Index] != nil {
			return nil, fmt.Errorf("openai embed: duplicate vector index %d", d.Index)
		}
		vectors[d.Index] = d.Embedding
	}
	return vectors, nil
}

// ListOpenAIModels returns the model IDs visible to the configured key — the
// admin Test-connection probe (key validation + datalist source) and the
// all-cloud Ping target.
func (c *Client) ListOpenAIModels(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.openaiBaseURL()+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	c.setOpenAIAuth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openai models: %w", err)
	}
	defer resp.Body.Close()
	raw, capErr := readCappedBody(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, &StatusError{Op: "openai models", Status: resp.StatusCode, Body: snippet(raw, 512)}
	}
	if capErr != nil {
		return nil, fmt.Errorf("openai models: %w", capErr)
	}
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("openai models: decode: %w", err)
	}
	ids := make([]string, 0, len(out.Data))
	for _, m := range out.Data {
		if m.ID != "" {
			ids = append(ids, m.ID)
		}
	}
	return ids, nil
}
