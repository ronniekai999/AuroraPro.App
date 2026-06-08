// Package llm wraps a local Ollama runtime (or Ollama Cloud) for embedding
// generation and natural-language chat. Splitting these concerns into one
// package keeps the HTTP wiring, retry logic, and request shaping in a single
// place — the rest of the codebase only sees Embed / EmbedBatch / ChatJSON.
package llm

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// maxLoggedBody caps the bytes we capture for debug logging. Some chat
// responses (especially gpt-oss with thinking traces) can be tens of KB — we
// don't want to OOM journald or blow up our slog handler. 8 MiB is generous
// enough to capture everything we've seen in practice.
const maxLoggedBody = 8 * 1024 * 1024

// Config controls how the client talks to Ollama. All fields have sensible
// defaults applied by NewClient when zero — callers only set what they want.
type Config struct {
	BaseURL    string // e.g. "http://ollama:11434" or "https://ollama.com"
	EmbedURL   string // optional; override for embeddings only (used when chat is on Cloud but embed is local)
	APIKey     string // optional bearer token for Ollama Cloud
	EmbedModel string // e.g. "nomic-embed-text"
	ChatModel  string // e.g. "gemma3:12b", "gpt-oss:20b", "qwen2.5:1.5b-instruct"
	// Per-surface routing (Phase A). Empty → fall back to ChatModel, so a
	// deployment that sets none behaves exactly as before. Fast = frequent,
	// latency-sensitive surfaces (hero rerank, rail reasons); Smart = the
	// heavy, 24h-cached Discover curation.
	ChatModelFast     string
	ChatModelSmart    string
	StructuredOutputs bool          // use the OpenAI-compatible response_format=json_schema path (hero pilot); default false → native /api/chat
	Dims              int           // target embedding dimensionality (truncated if model is wider)
	HTTPTimeout       time.Duration // per-request budget; embedding is fast, chat is not
	Debug             bool          // initial debug-logging state; hot-swap later via SetDebug
}

// Client is safe for concurrent use; the underlying http.Client handles pooling
// and the debug toggle is an atomic.Bool so admin-UI flips don't tear.
type Client struct {
	cfg   Config
	http  *http.Client
	debug atomic.Bool
}

// NewClient applies defaults and returns a ready-to-use client. It does NOT
// dial Ollama — call Ping if you want a startup-time liveness check.
func NewClient(cfg Config) *Client {
	if cfg.BaseURL == "" {
		cfg.BaseURL = "http://ollama:11434"
	}
	if cfg.EmbedModel == "" {
		cfg.EmbedModel = "nomic-embed-text"
	}
	if cfg.ChatModel == "" {
		cfg.ChatModel = "qwen2.5:1.5b-instruct"
	}
	if cfg.Dims == 0 {
		cfg.Dims = 384
	}
	if cfg.HTTPTimeout == 0 {
		// 70s default = 10s margin over the longest per-call ctx budget
		// in the recommender stack (discoverBudget = 60s). Keeping
		// HTTPTimeout strictly larger ensures the per-call ctx is
		// always the deterministic cancellation source — at HTTPTimeout
		// == discoverBudget exactly, a slow body at t=59.9 could trip
		// either timer first. Bug-bash May 14 flagged the equal-timeout
		// sharp edge.
		cfg.HTTPTimeout = 70 * time.Second
	}
	c := &Client{
		cfg:  cfg,
		http: newGuardedHTTPClient(cfg.HTTPTimeout),
	}
	c.debug.Store(cfg.Debug)
	return c
}

func newGuardedHTTPClient(timeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	dialer := &net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	resolver := net.DefaultResolver

	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		ips, err := resolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("llm target %q did not resolve", host)
		}
		for _, resolved := range ips {
			if isBlockedLLMTargetIP(resolved.IP) {
				return nil, fmt.Errorf("llm target %q resolves to restricted address %s", host, resolved.IP)
			}
		}

		// Dial vetted addresses directly so DNS cannot resolve to a different
		// destination between validation and connect. Try each safe address in
		// order so localhost works whether Ollama binds IPv4, IPv6, or both.
		var lastErr error
		for _, resolved := range ips {
			target := net.JoinHostPort(resolved.IP.String(), port)
			conn, err := dialer.DialContext(ctx, network, target)
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
		return nil, lastErr
	}

	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
	}
}

func isBlockedLLMTargetIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	return ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() ||
		ip.IsUnspecified() ||
		ip.Equal(net.IPv4(169, 254, 169, 254))
}

// SetDebug toggles request/response logging at runtime. Safe to call from any
// goroutine — the admin handler flips this when the operator toggles the
// Diagnostics switch in the UI, no restart needed.
func (c *Client) SetDebug(on bool) { c.debug.Store(on) }

// Debug reports the current debug-logging state. Exposed so the admin UI can
// show a "live" indicator distinct from the persisted DB setting.
func (c *Client) Debug() bool { return c.debug.Load() }

// ChatModel returns the currently configured chat model name. Admin UI reads
// this to display which model is in use without exposing the full Config.
func (c *Client) ChatModel() string { return c.cfg.ChatModel }

// EmbedModel returns the currently configured embedding model name.
func (c *Client) EmbedModel() string { return c.cfg.EmbedModel }

// Dims reports the target embedding dimensionality — used by callers (e.g. the
// pgvector formatter) to validate they're inserting the right shape.
func (c *Client) Dims() int { return c.cfg.Dims }

// Ping verifies Ollama is reachable. Use this from main.go to fail fast or to
// degrade gracefully (skip embedding init) if the sidecar is down. We use
// /api/tags on the embed URL (local Ollama) so a Cloud-only chat config still
// pings the local box where embeddings actually live.
func (c *Client) Ping(ctx context.Context) error {
	url := c.embedURL() + "/api/tags"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("ollama ping: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("ollama ping: status %d", resp.StatusCode)
	}
	return nil
}

// embedURL returns the URL to hit for /api/embed. When EmbedURL is set
// (hybrid Cloud-chat + local-embed setup) we route embeddings there; otherwise
// we use BaseURL.
func (c *Client) embedURL() string {
	if c.cfg.EmbedURL != "" {
		return c.cfg.EmbedURL
	}
	return c.cfg.BaseURL
}

// embedRequest matches Ollama's /api/embed schema. `input` accepts a single
// string or an array of strings; we always send an array for uniform parsing.
type embedRequest struct {
	Model string   `json:"model"`
	Input []string `json:"input"`
}

type embedResponse struct {
	Embeddings [][]float32 `json:"embeddings"`
}

// EmbedBatch returns one vector per input text, in the same order. Each vector
// is truncated to c.cfg.Dims and L2-normalized so pgvector's cosine distance
// reduces to a dot product.
//
// Empty inputs are returned as nil vectors at the corresponding index — the
// caller decides whether that's an error.
func (c *Client) EmbedBatch(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}

	cleaned := make([]string, len(texts))
	for i, t := range texts {
		if t == "" {
			cleaned[i] = " "
		} else {
			cleaned[i] = t
		}
	}

	body, err := json.Marshal(embedRequest{Model: c.cfg.EmbedModel, Input: cleaned})
	if err != nil {
		return nil, err
	}
	url := c.embedURL() + "/api/embed"
	reqID := c.newReqID()
	c.logRequest(reqID, url, c.cfg.EmbedModel, body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	// Embeddings always hit the local URL; no bearer needed even on hybrid setups.

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ollama embed: %w", err)
	}
	defer resp.Body.Close()

	raw, capErr := readCappedBody(resp.Body)
	c.logResponseEmbed(reqID, resp.StatusCode, raw)

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ollama embed: status %d: %s", resp.StatusCode, snippet(raw, 512))
	}
	if capErr != nil {
		// Surface truncation explicitly so the operator sees "body exceeds cap"
		// instead of a confusing JSON decode error downstream.
		return nil, fmt.Errorf("ollama embed: %w", capErr)
	}

	var out embedResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("ollama embed: decode: %w", err)
	}
	if len(out.Embeddings) != len(texts) {
		return nil, fmt.Errorf("ollama embed: got %d vectors for %d inputs", len(out.Embeddings), len(texts))
	}

	result := make([][]float32, len(out.Embeddings))
	for i, v := range out.Embeddings {
		if texts[i] == "" {
			result[i] = nil
			continue
		}
		result[i] = normalize(truncate(v, c.cfg.Dims))
	}
	return result, nil
}

// Embed is a single-input convenience wrapper around EmbedBatch.
func (c *Client) Embed(ctx context.Context, text string) ([]float32, error) {
	out, err := c.EmbedBatch(ctx, []string{text})
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out[0], nil
}

// ChatMessage is one turn in a /api/chat conversation. Use Role "system" for
// instructions, "user" for the query, and (for few-shot prompting) "assistant"
// for prior model responses.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model    string         `json:"model"`
	Messages []ChatMessage  `json:"messages"`
	Stream   bool           `json:"stream"`
	Format   any            `json:"format,omitempty"`
	Think    bool           `json:"think"` // gpt-oss / cloud models default to true; force off
	Options  map[string]any `json:"options,omitempty"`
}

type chatResponse struct {
	Message ChatMessage `json:"message"`
}

// OpenAI-compatible request/response shapes for the /v1/chat/completions path
// used by ChatJSONWith when structured outputs are enabled. Ollama exposes this
// endpoint alongside /api/chat; newer cloud models honor response_format=
// json_schema there more reliably than Ollama's native `format` field (which
// 500s on nested schemas — see discover.go). This is the foundation Phase C
// will reuse to re-enable enforced schemas on Discover.
type oaiChatRequest struct {
	Model          string             `json:"model"`
	Messages       []ChatMessage      `json:"messages"`
	Temperature    float64            `json:"temperature"`
	ResponseFormat *oaiResponseFormat `json:"response_format,omitempty"`
}
type oaiResponseFormat struct {
	Type       string        `json:"type"` // "json_schema"
	JSONSchema oaiJSONSchema `json:"json_schema"`
}
type oaiJSONSchema struct {
	Name   string `json:"name"`
	Schema any    `json:"schema"`
	Strict bool   `json:"strict"`
}
type oaiChatResponse struct {
	Choices []struct {
		Message ChatMessage `json:"message"`
	} `json:"choices"`
}

// ChatModelFast returns the model for high-frequency, latency-sensitive
// surfaces (hero rerank, rail reasons), falling back to the default chat model
// when unset.
func (c *Client) ChatModelFast() string {
	if c.cfg.ChatModelFast != "" {
		return c.cfg.ChatModelFast
	}
	return c.cfg.ChatModel
}

// ChatModelSmart returns the model for the heavy, 24h-cached Discover curation,
// falling back to the default chat model when unset.
func (c *Client) ChatModelSmart() string {
	if c.cfg.ChatModelSmart != "" {
		return c.cfg.ChatModelSmart
	}
	return c.cfg.ChatModel
}

// UseStructured reports whether the OpenAI-compatible json_schema path is
// enabled (llm_structured_outputs). Off by default → native /api/chat, i.e.
// unchanged behavior.
func (c *Client) UseStructured() bool { return c.cfg.StructuredOutputs }

// ChatJSON is the back-compatible entry point: native structured output on the
// default chat model. Equivalent to ChatJSONWith(ctx, "", system, user, schema,
// false).
func (c *Client) ChatJSON(ctx context.Context, system, user string, schema any) (string, error) {
	return c.ChatJSONWith(ctx, c.cfg.ChatModel, system, user, schema, false)
}

// ChatJSONWith sends a structured-output chat request on an explicit model.
// When structured && schema != nil it uses the OpenAI-compatible
// /v1/chat/completions response_format=json_schema path; otherwise Ollama's
// native /api/chat `format` field. An empty model falls back to the configured
// default. Cloud models can ignore the schema on EITHER path, so callers MUST
// still run a tolerant parser on the returned string.
//
// Temperature is fixed low (0.1) — curation/parsing should be deterministic,
// not creative.
func (c *Client) ChatJSONWith(ctx context.Context, model, system, user string, schema any, structured bool) (string, error) {
	if model == "" {
		model = c.cfg.ChatModel
	}
	if structured && schema != nil {
		return c.chatOpenAISchema(ctx, model, system, user, schema)
	}
	return c.chatNative(ctx, model, system, user, schema)
}

// chatNative is the Ollama-native /api/chat path (the original ChatJSON body,
// now parameterized by model).
func (c *Client) chatNative(ctx context.Context, model, system, user string, schema any) (string, error) {
	body, err := json.Marshal(chatRequest{
		Model: model,
		Messages: []ChatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Stream:  false,
		Format:  schema,
		Think:   false,
		Options: map[string]any{"temperature": 0.1},
	})
	if err != nil {
		return "", err
	}
	url := c.cfg.BaseURL + "/api/chat"
	reqID := c.newReqID()
	start := time.Now()
	c.logRequest(reqID, url, model, body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("ollama chat: %w", err)
	}
	defer resp.Body.Close()

	raw, capErr := readCappedBody(resp.Body)
	c.logResponseChat(reqID, resp.StatusCode, time.Since(start), raw)

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("ollama chat: status %d: %s", resp.StatusCode, snippet(raw, 512))
	}
	if capErr != nil {
		return "", fmt.Errorf("ollama chat: %w", capErr)
	}

	var out chatResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("ollama chat: decode: %w", err)
	}
	return out.Message.Content, nil
}

// chatOpenAISchema uses the OpenAI-compatible endpoint with a json_schema
// response_format. strict is false on purpose: our schemas use keywords
// (minItems/maxItems) that strict mode rejects on some providers, and the
// tolerant parser is the real safety net — we want strong guidance, not hard
// validation that 400s the request. The error string keeps the
// "ollama chat: status N" shape so isLLMServerError (discover.go) still matches
// for the 5xx retry.
//
// Caveat: unlike chatNative this path sends no thinking-suppression signal, so a
// reasoning model/gateway that folds its trace into `content` can defeat the
// tolerant parser (degrading to the score-ordered fallback). Until Phase C adds
// reasoning suppression here, pair llm_structured_outputs with a non-thinking
// fast model.
func (c *Client) chatOpenAISchema(ctx context.Context, model, system, user string, schema any) (string, error) {
	body, err := json.Marshal(oaiChatRequest{
		Model: model,
		Messages: []ChatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Temperature: 0.1,
		ResponseFormat: &oaiResponseFormat{
			Type:       "json_schema",
			JSONSchema: oaiJSONSchema{Name: "result", Schema: schema, Strict: false},
		},
	})
	if err != nil {
		return "", err
	}
	url := c.cfg.BaseURL + "/v1/chat/completions"
	reqID := c.newReqID()
	start := time.Now()
	c.logRequest(reqID, url, model, body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("ollama chat: %w", err)
	}
	defer resp.Body.Close()

	raw, capErr := readCappedBody(resp.Body)
	c.logResponseChat(reqID, resp.StatusCode, time.Since(start), raw)

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("ollama chat: status %d: %s", resp.StatusCode, snippet(raw, 512))
	}
	if capErr != nil {
		return "", fmt.Errorf("ollama chat: %w", capErr)
	}

	var out oaiChatResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("ollama chat: decode: %w", err)
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("ollama chat: empty choices")
	}
	return out.Choices[0].Message.Content, nil
}

// newReqID returns a short correlation ID for matching → / ← log lines.
// Short-circuits when debug is off so we don't pay 4 bytes of crypto/rand
// per LLM call in production.
func (c *Client) newReqID() string {
	if !c.debug.Load() {
		return ""
	}
	var b [4]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (c *Client) logRequest(reqID, url, model string, body []byte) {
	if !c.debug.Load() {
		return
	}
	slog.Info("ollama →", "req_id", reqID, "endpoint", url, "model", model,
		"body", string(body))
}

func (c *Client) logResponseChat(reqID string, status int, elapsed time.Duration, body []byte) {
	if !c.debug.Load() {
		return
	}
	slog.Info("ollama ←", "req_id", reqID, "status", status,
		"latency_ms", elapsed.Milliseconds(), "body", string(body))
}

// logResponseEmbed redacts the vector dump to a short prefix/suffix so debug
// logs don't balloon — a 768-dim float32 array prints to ~10 KB and we'd be
// scrolling for an hour. The model echoes the request shape, so seeing dims +
// first/last values is enough to confirm "the embedding came back."
func (c *Client) logResponseEmbed(reqID string, status int, body []byte) {
	if !c.debug.Load() {
		return
	}
	slog.Info("ollama ←", "req_id", reqID, "status", status,
		"body", redactEmbeddings(body))
}

// redactEmbeddings rewrites the inner `[[...]]` array to a one-line summary.
// Best-effort: on parse failure we just return the raw bytes so debug logs
// don't disappear silently.
func redactEmbeddings(body []byte) string {
	var parsed struct {
		Embeddings [][]float32 `json:"embeddings"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || len(parsed.Embeddings) == 0 {
		return snippet(body, 512)
	}
	var b strings.Builder
	b.WriteString(`{"embeddings":[`)
	for i, v := range parsed.Embeddings {
		if i > 0 {
			b.WriteString(",")
		}
		dim := len(v)
		first := v
		last := v
		if dim > 5 {
			first = v[:5]
			last = v[dim-5:]
		}
		fmt.Fprintf(&b, "<dims=%d first=%v last=%v>", dim, first, last)
	}
	b.WriteString("]}")
	return b.String()
}

// readCappedBody is io.ReadAll with a hard ceiling. If the upstream body
// exceeds the cap we return a clear error rather than silently truncating —
// without this, oversized Cloud chat responses (gpt-oss with long thinking
// traces) produced a misleading "unexpected end of JSON input" downstream
// with no hint that the real cause was a giant body. Reading cap+1 bytes
// and detecting the over-cap byte is the canonical idiom.
func readCappedBody(r io.Reader) ([]byte, error) {
	buf, err := io.ReadAll(io.LimitReader(r, maxLoggedBody+1))
	if err != nil {
		return buf, err
	}
	if len(buf) > maxLoggedBody {
		return buf[:maxLoggedBody], fmt.Errorf("response body exceeds %d-byte cap", maxLoggedBody)
	}
	return buf, nil
}

// snippet returns at most n bytes of body for error messages. Avoids dumping
// a 4 MiB HTML error page into a Go error string.
func snippet(body []byte, n int) string {
	if len(body) <= n {
		return string(body)
	}
	return string(body[:n]) + "...(truncated)"
}

// truncate keeps the leading n dimensions of a Matryoshka-trained embedding.
// nomic-embed-text and bge are both trained this way; the leading dims carry
// the most signal, so 768 → 384 loses very little retrieval quality at half
// the storage cost.
func truncate(v []float32, n int) []float32 {
	if n <= 0 || n >= len(v) {
		return v
	}
	return v[:n:n]
}

// normalize scales v to unit length so cosine distance == 1 - dot(v1, v2).
// pgvector still computes cosine correctly without normalization, but
// pre-normalizing once on insert avoids an extra sqrt per query.
func normalize(v []float32) []float32 {
	var sum float64
	for _, x := range v {
		sum += float64(x) * float64(x)
	}
	if sum == 0 {
		return v
	}
	inv := float32(1.0 / math.Sqrt(sum))
	out := make([]float32, len(v))
	for i, x := range v {
		out[i] = x * inv
	}
	return out
}
