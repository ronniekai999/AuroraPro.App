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
	// Provider selects the CHAT backend: "" | "local" | "ollama_cloud" (Ollama
	// endpoints at BaseURL, the pre-split behavior) or "anthropic" | "openai"
	// (hosted APIs at compile-time base URLs; BaseURL is not consulted for
	// chat). EmbedProvider selects the EMBEDDING backend independently — "" |
	// "local" keeps Ollama at EmbedURL/BaseURL, "openai" uses the OpenAI
	// embeddings API — because Anthropic has no embeddings API, so a Claude
	// chat setup still needs Ollama or OpenAI for vectors.
	Provider      string
	EmbedProvider string
	BaseURL       string // e.g. "http://localhost:11434" or "https://ollama.com"
	EmbedURL      string // optional; override for embeddings only (used when chat is on Cloud but embed is local)
	APIKey        string // optional bearer token for Ollama Cloud
	// Per-provider credentials. Key isolation is structural: each key is only
	// ever attached by its own provider's adapter to that provider's fixed
	// host — APIKey (Ollama Cloud) never reaches api.anthropic.com/api.openai.com
	// and vice versa, extending the sendAuth discipline in rerank.go.
	AnthropicAPIKey string
	OpenAIAPIKey    string
	// Base-URL escape hatches for the hosted providers, for gateway/proxy
	// deployments and httptest fakes. Env/test only — deliberately NOT
	// admin-editable, so a stored key can never be steered to an
	// attacker-supplied host from the settings UI.
	AnthropicBaseURL string
	OpenAIBaseURL    string
	EmbedModel       string // e.g. "qwen3-embedding:0.6b"
	ChatModel        string // e.g. "qwen3:4b-instruct", "gemma3:12b", "gpt-oss:20b"
	// Per-surface routing (Phase A). Empty → fall back to ChatModel, so a
	// deployment that sets none behaves exactly as before. Fast = frequent,
	// latency-sensitive surfaces (hero rerank, rail reasons); Smart = the
	// heavy, 24h-cached Discover curation.
	ChatModelFast     string
	ChatModelSmart    string
	StructuredOutputs bool // use the OpenAI-compatible response_format=json_schema path (hero pilot); default false → native /api/chat
	// ReasoningEffort sets the gpt-oss reasoning level on the /v1 path:
	// "low" | "medium" | "high" | "none" | "" (unset → omitted). gpt-oss
	// ignores `think:false` on Cloud and can burn its whole budget on the hidden
	// reasoning trace (37s + empty content on the hero surface); "low" keeps it
	// brief and reliable. Only applied on the OpenAI /v1 path.
	ReasoningEffort string
	// Reranker (Phase B). RerankModel is a fast chat/instruct model used for a
	// single LISTWISE rerank pass (e.g. "gpt-oss:20b") — it reads all candidates
	// in one call and scores each, so it works on a GPU-less box where the old
	// per-pair cross-encoder couldn't. Empty → reranking disabled (graceful no-op,
	// callers keep their vector order). RerankURL is where to run that call; empty
	// → the chat BaseURL (rerank rides the chat endpoint, Cloud or local). Set it
	// only to run rerank on a separate/local Ollama. When RerankURL points away
	// from BaseURL the Cloud APIKey is NOT sent to it (no key leak to a local
	// box). See rerank.go.
	RerankModel string
	RerankURL   string
	Dims        int           // target embedding dimensionality (truncated if model is wider)
	HTTPTimeout time.Duration // per-request budget; embedding is fast, chat is not
	// NumCtx, when > 0, is sent as options.num_ctx on native /api/chat
	// requests so prompts larger than Ollama's default context (4096) are
	// not silently truncated. Not applied on the OpenAI-compat /v1 path
	// (no options field there — model defaults govern).
	NumCtx int
	Debug  bool // initial debug-logging state; hot-swap later via SetDebug
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
	// Trim stray whitespace on operator-entered names/URLs BEFORE defaulting, so
	// a value that's all spaces still falls back to the default. A trailing space
	// (trivially pasted into the admin form) otherwise silently breaks model
	// lookup with a confusing "model not found" / reranker "unreachable" error —
	// observed 2026-06-08 with "dengcao/Qwen3-Reranker-8B:Q3_K_M ".
	cfg.Provider = strings.TrimSpace(cfg.Provider)
	cfg.EmbedProvider = strings.TrimSpace(cfg.EmbedProvider)
	cfg.BaseURL = strings.TrimSpace(cfg.BaseURL)
	cfg.EmbedURL = strings.TrimSpace(cfg.EmbedURL)
	cfg.AnthropicBaseURL = strings.TrimSpace(cfg.AnthropicBaseURL)
	cfg.OpenAIBaseURL = strings.TrimSpace(cfg.OpenAIBaseURL)
	cfg.RerankURL = strings.TrimSpace(cfg.RerankURL)
	cfg.ChatModel = strings.TrimSpace(cfg.ChatModel)
	cfg.ChatModelFast = strings.TrimSpace(cfg.ChatModelFast)
	cfg.ChatModelSmart = strings.TrimSpace(cfg.ChatModelSmart)
	cfg.EmbedModel = strings.TrimSpace(cfg.EmbedModel)
	cfg.RerankModel = strings.TrimSpace(cfg.RerankModel)

	// Provider-aware model defaults, applied BEFORE the generic Ollama
	// fallbacks below so a hosted-provider Config with empty model fields
	// lands on that provider's models, not on qwen. Quality-first tiers per
	// the feature decision: fast rides ChatModel via the ChatModelFast()
	// fallback; smart gets the flagship.
	switch cfg.Provider {
	case ProviderAnthropic:
		if cfg.ChatModel == "" {
			cfg.ChatModel = anthropicDefaultChatModel
		}
		if cfg.ChatModelSmart == "" {
			cfg.ChatModelSmart = anthropicDefaultSmartModel
		}
	case ProviderOpenAI:
		if cfg.ChatModel == "" {
			cfg.ChatModel = openaiDefaultChatModel
		}
		if cfg.ChatModelSmart == "" {
			cfg.ChatModelSmart = openaiDefaultSmartModel
		}
	}
	if cfg.EmbedProvider == ProviderOpenAI && cfg.EmbedModel == "" {
		cfg.EmbedModel = openaiDefaultEmbedModel
	}

	// Fallback defaults for a zero Config. Keep these IN SYNC with the
	// canonical defaults in internal/config (Load's LLMConfig block) — the
	// two drifted once (qwen2.5:1.5b here vs 3b there) and the config-layer
	// value silently won because main.go always passes it through.
	if cfg.BaseURL == "" {
		cfg.BaseURL = "http://localhost:11434"
	}
	if cfg.EmbedModel == "" {
		cfg.EmbedModel = "qwen3-embedding:0.6b" // Phase E4 default (1024-dim MRL, truncated to Dims)
	}
	if cfg.ChatModel == "" {
		cfg.ChatModel = "qwen3:4b-instruct"
	}
	if cfg.Dims == 0 {
		cfg.Dims = 768 // must match migration 040's vector(768)
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
		// Credential containment on redirects (same pattern as the imageproxy
		// and party_share clients): Go's client strips Authorization on a
		// cross-host redirect but FORWARDS custom headers — including the
		// Anthropic x-api-key — so an endpoint 302ing to another host would
		// otherwise carry the key along. LLM endpoints (Ollama boxes, vendor
		// APIs) have no legitimate cross-host redirects; refuse them outright.
		// Same-host redirects (http→https, path moves) stay allowed, capped.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("llm: too many redirects")
			}
			if req.URL.Host != via[0].URL.Host {
				return fmt.Errorf("llm: refusing cross-host redirect from %s to %s (credential containment)", via[0].URL.Host, req.URL.Host)
			}
			return nil
		},
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

// Provider returns the configured chat provider ("" = unset/legacy Ollama).
func (c *Client) Provider() string { return c.cfg.Provider }

// EmbedProviderName returns the configured embedding provider ("" = local
// Ollama, the legacy behavior).
func (c *Client) EmbedProviderName() string { return c.cfg.EmbedProvider }

// EmbedSpaceID identifies the embedding vector space for the model-space
// marker (embedding.ensureModelSpace): vectors from different spaces must
// never share the pgvector column, and a space change nulls + re-embeds the
// whole library.
//
// FORMAT IS LOAD-BEARING: for Ollama-family embeds this returns the bare
// model name because that is what every existing install's marker row
// (llm_embed_model_active) already holds — qualifying it would make marker !=
// effective on first boot after upgrade and spuriously null every install's
// vectors. Only non-Ollama spaces get a provider prefix; the "/" is
// unambiguous because Ollama model tags use ":" not "/" for variants.
func (c *Client) EmbedSpaceID() string {
	if c.cfg.EmbedProvider == ProviderOpenAI {
		return "openai/" + c.cfg.EmbedModel
	}
	return c.cfg.EmbedModel
}

// Dims reports the target embedding dimensionality — used by callers (e.g. the
// pgvector formatter) to validate they're inserting the right shape.
func (c *Client) Dims() int { return c.cfg.Dims }

// Ping verifies the EMBEDDING backend is reachable — that's the dependency
// main.go degrades on (skip embedding init) when it's down. For Ollama-family
// embeds we use /api/tags on the embed URL (local Ollama) so a Cloud-only
// chat config still pings the local box where embeddings actually live,
// delegating to ListModels (probe.go) so there is exactly one /api/tags
// implementation. With EmbedProvider=openai the probe goes to api.openai.com
// instead — an all-cloud config (anthropic/openai chat + openai embeds) must
// boot cleanly on a box with no Ollama at all.
func (c *Client) Ping(ctx context.Context) error {
	if c.cfg.EmbedProvider == ProviderOpenAI {
		if _, err := c.ListOpenAIModels(ctx); err != nil {
			return fmt.Errorf("openai ping: %w", err)
		}
		return nil
	}
	if _, err := c.ListModels(ctx, c.embedURL(), false); err != nil {
		return fmt.Errorf("ollama ping: %w", err)
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

	// Hosted embedding provider takes over the transport; the shaping tail
	// (truncate/normalize/dims guard) is shared so both paths enforce the
	// same pgvector contract.
	if c.cfg.EmbedProvider == ProviderOpenAI {
		vectors, err := c.embedOpenAI(ctx, cleaned)
		if err != nil {
			return nil, err
		}
		return c.shapeEmbeddings(texts, vectors, "openai embed")
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
		return nil, &StatusError{Op: "embed", Status: resp.StatusCode, Body: snippet(raw, 512)}
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

	return c.shapeEmbeddings(texts, out.Embeddings, "ollama embed")
}

// shapeEmbeddings is the provider-neutral tail of EmbedBatch: empty inputs
// map to nil vectors, everything else is truncated to cfg.Dims and
// L2-normalized so pgvector's cosine distance reduces to a dot product. op
// prefixes errors so an operator can tell which backend produced them.
func (c *Client) shapeEmbeddings(texts []string, embeddings [][]float32, op string) ([][]float32, error) {
	result := make([][]float32, len(embeddings))
	for i, v := range embeddings {
		if texts[i] == "" {
			result[i] = nil
			continue
		}
		result[i] = normalize(truncate(v, c.cfg.Dims))
		// Guard a model/dimension mismatch. truncate() only SHORTENS, so a model
		// NARROWER than cfg.Dims (e.g. a stale llm_embed_model=nomic at 384 against
		// the Phase E2 vector(768) column) yields a too-short vector that pgvector
		// rejects on write — and the backfill swallows that write error, so it
		// would re-fetch and hot-spin the same rows forever. Fail loudly here
		// instead: the backfill wave errors → backs off → gives up cleanly.
		if len(result[i]) != c.cfg.Dims {
			return nil, fmt.Errorf("%s: model %q produced %d dims, want %d (llm_embed_model / EmbedDims must match the embedding column)", op, c.cfg.EmbedModel, len(result[i]), c.cfg.Dims)
		}
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
	Model    string        `json:"model"`
	Messages []ChatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
	Format   any           `json:"format,omitempty"`
	// Think is always serialized (no omitempty) and always false: thinking
	// models (gpt-oss, hybrid qwen3) default it to true and would burn the
	// budget on hidden traces. Sending `think:false` to a model WITHOUT the
	// thinking capability is safe — Ollama only rejects `think:true` there —
	// verified in production against qwen2.5/gemma3 and by the current
	// non-thinking default (qwen3:4b-instruct).
	Think   bool           `json:"think"`
	Options map[string]any `json:"options,omitempty"`
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
	Model    string        `json:"model"`
	Messages []ChatMessage `json:"messages"`
	// Temperature is a pointer so the two consumers of this shape can differ
	// on the wire: the Ollama /v1 path pins 0.1 (deterministic curation, the
	// historical bytes), while the api.openai.com path leaves it nil/omitted —
	// gpt-5-family reasoning models 400 on non-default temperature values.
	Temperature     *float64           `json:"temperature,omitempty"`
	ReasoningEffort string             `json:"reasoning_effort,omitempty"`
	ResponseFormat  *oaiResponseFormat `json:"response_format,omitempty"`
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

// ReasoningEffort returns the configured gpt-oss reasoning level for the /v1
// path ("low"|"medium"|"high"|"none", or "" when unset). Callers use it to
// decide whether taking the /v1 path actually buys reasoning suppression: an
// empty value means gpt-oss runs its full default reasoning on /v1 — the
// runaway / empty-content case — so a surface like Discover should prefer the
// native path unless this is set. See shouldUseStructuredV1 in the recommender.
func (c *Client) ReasoningEffort() string { return c.cfg.ReasoningEffort }

// ChatJSON is the back-compatible entry point: native structured output on the
// default chat model. Equivalent to ChatJSONWith(ctx, "", system, user, schema,
// false).
func (c *Client) ChatJSON(ctx context.Context, system, user string, schema any) (string, error) {
	return c.ChatJSONWith(ctx, c.cfg.ChatModel, system, user, schema, false)
}

// ChatJSONWith sends a structured-output chat request on an explicit model.
//
// Hosted providers (anthropic/openai) are routed first and IGNORE the
// structured flag — each always takes its own native schema path
// (output_config.format / response_format), because the flag only exists to
// pick between two Ollama transports. Consumers that hardcode structured=false
// (rail reasons, recaps) therefore still get real schema enforcement on a
// hosted provider, with the tolerant parser unchanged as the safety net.
//
// For Ollama-family providers: when structured it uses the OpenAI-compatible
// /v1/chat/completions path (response_format=json_schema when schema != nil,
// otherwise a plain /v1 call); when not structured it uses Ollama's native
// /api/chat `format` field. The /v1 path is also where reasoning_effort is
// applied, so a *schemaless* /v1 call is how Discover suppresses gpt-oss's
// runaway reasoning. An empty model falls back to the configured default.
// Cloud models can ignore the schema on EITHER path, so callers MUST still
// run a tolerant parser on the returned string.
//
// Temperature on the Ollama paths is fixed low (0.1) — curation/parsing
// should be deterministic, not creative. The hosted providers omit it (their
// current models reject explicit sampling parameters).
func (c *Client) ChatJSONWith(ctx context.Context, model, system, user string, schema any, structured bool) (string, error) {
	if model == "" {
		model = c.cfg.ChatModel
	}
	if out, handled, err := c.chatViaProvider(ctx, model, system, user, schema); handled {
		return out, err
	}
	if structured {
		// OpenAI-compatible /v1 path. The schema is OPTIONAL here: when it's nil
		// we omit response_format entirely but still take this path — that's how
		// Discover gets reasoning_effort applied (the only lever that stops
		// gpt-oss's runaway hidden reasoning) WITHOUT sending its nested
		// rails→picks schema, which 500s on Ollama Cloud. Hero passes a flat
		// schema, which the model honors-ish; either way the tolerant parser is
		// the real safety net.
		return c.chatOpenAISchema(ctx, c.cfg.BaseURL, true, model, system, user, schema)
	}
	return c.chatNative(ctx, c.cfg.BaseURL, true, model, system, user, schema)
}

// chatViaProvider routes a chat call to the configured hosted provider.
// handled=false means an Ollama-family provider is configured and the caller
// should run the existing native-vs-/v1 selection. Shared by ChatJSONWith and
// Rerank so a hosted provider carries every chat surface, reranking included.
func (c *Client) chatViaProvider(ctx context.Context, model, system, user string, schema any) (out string, handled bool, err error) {
	switch c.cfg.Provider {
	case ProviderAnthropic:
		out, err = c.chatAnthropic(ctx, model, system, user, schema)
		return out, true, err
	case ProviderOpenAI:
		out, err = c.chatOpenAI(ctx, model, system, user, schema)
		return out, true, err
	}
	return "", false, nil
}

// chatNative is the Ollama-native /api/chat path (the original ChatJSON body,
// now parameterized by baseURL + model so the reranker can reuse it against a
// different endpoint). sendAuth gates the bearer header — callers pass false to
// avoid shipping the Cloud API key to a non-chat endpoint (e.g. a local
// reranker URL); see Rerank.
func (c *Client) chatNative(ctx context.Context, baseURL string, sendAuth bool, model, system, user string, schema any) (string, error) {
	options := map[string]any{"temperature": 0.1}
	if c.cfg.NumCtx > 0 {
		options["num_ctx"] = c.cfg.NumCtx
	}
	body, err := json.Marshal(chatRequest{
		Model: model,
		Messages: []ChatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Stream:  false,
		Format:  schema,
		Think:   false,
		Options: options,
	})
	if err != nil {
		return "", err
	}
	url := baseURL + "/api/chat"
	reqID := c.newReqID()
	start := time.Now()
	c.logRequest(reqID, url, model, body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.APIKey != "" && sendAuth {
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
		return "", &StatusError{Op: "chat", Status: resp.StatusCode, Body: snippet(raw, 512)}
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

// chatOpenAISchema uses the OpenAI-compatible /v1/chat/completions endpoint.
// When schema != nil it sends a json_schema response_format; when schema == nil
// it sends a plain chat request (no response_format) — Discover takes the latter
// to dodge the nested rails→picks schema that 500s on Ollama Cloud while still
// reaching this path for reasoning_effort. strict is false on purpose: our
// schemas use keywords (minItems/maxItems) that strict mode rejects on some
// providers, and the tolerant parser is the real safety net — we want strong
// guidance, not hard validation that 400s the request. Non-2xx responses come
// back as *StatusError so callers (discover's 5xx retry) can errors.As on the
// status instead of string-matching.
//
// Thinking suppression on this path comes from ReasoningEffort (the gpt-oss
// reasoning_effort field), NOT the native `think:false` — gpt-oss ignores the
// latter on Cloud. With reasoning_effort unset a reasoning model can still burn
// its budget on the hidden trace and return empty content (guarded below); set
// llm_reasoning_effort=low to keep it brief.
func (c *Client) chatOpenAISchema(ctx context.Context, baseURL string, sendAuth bool, model, system, user string, schema any) (string, error) {
	// Schema is optional: nil → omit response_format (omitempty on the pointer)
	// so the request is a plain /v1 chat. Discover relies on this to avoid the
	// nested-schema 500 while still getting reasoning_effort applied below.
	var responseFormat *oaiResponseFormat
	if schema != nil {
		responseFormat = &oaiResponseFormat{
			Type:       "json_schema",
			JSONSchema: oaiJSONSchema{Name: "result", Schema: schema, Strict: false},
		}
	}
	temp := 0.1
	body, err := json.Marshal(oaiChatRequest{
		Model: model,
		Messages: []ChatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Temperature:     &temp,                 // pinned 0.1 on the Ollama /v1 path — historical wire bytes
		ReasoningEffort: c.cfg.ReasoningEffort, // omitempty when unset
		ResponseFormat:  responseFormat,        // nil → omitted; Discover sends no schema
	})
	if err != nil {
		return "", err
	}
	url := baseURL + "/v1/chat/completions"
	reqID := c.newReqID()
	start := time.Now()
	c.logRequest(reqID, url, model, body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.APIKey != "" && sendAuth {
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
		return "", &StatusError{Op: "chat", Status: resp.StatusCode, Body: snippet(raw, 512)}
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
	content := out.Choices[0].Message.Content
	if strings.TrimSpace(content) == "" {
		// Reasoning models (gpt-oss) sometimes spend their whole token budget on
		// the hidden reasoning trace and return EMPTY content. Surface that as an
		// error so the caller logs it and falls back cleanly, instead of the
		// downstream parser failing on "" with an opaque message. Setting
		// llm_reasoning_effort=low prevents the runaway reasoning.
		return "", fmt.Errorf("ollama chat: empty content (reasoning ran long — try llm_reasoning_effort=low)")
	}
	return content, nil
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

// redactEmbeddings rewrites the vector payload to a one-line summary —
// handling both the Ollama shape ({"embeddings":[[...]]}) and the OpenAI
// shape ({"data":[{"index","embedding":[...]}]}). Best-effort: on parse
// failure we just return the raw bytes so debug logs don't disappear
// silently.
func redactEmbeddings(body []byte) string {
	var parsed struct {
		Embeddings [][]float32 `json:"embeddings"`
		Data       []struct {
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || (len(parsed.Embeddings) == 0 && len(parsed.Data) == 0) {
		return snippet(body, 512)
	}
	if len(parsed.Embeddings) == 0 {
		for _, d := range parsed.Data {
			parsed.Embeddings = append(parsed.Embeddings, d.Embedding)
		}
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
// nomic-embed-text, bge, embeddinggemma, and qwen3-embedding are all trained
// this way; the leading dims carry the most signal, so a prefix loses very
// little retrieval quality. As of Phase E4 the default model
// (qwen3-embedding:0.6b) is 1024-dim native and this truncates it to the
// vector(768) column from migration 040 — which is exactly the future-wider-
// model case this helper was kept around for in Phase E2.
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
