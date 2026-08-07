package llm

// Anthropic (Claude) chat adapter: the native Messages API, never the
// OpenAI-compat shim — that surface is a compatibility layer Anthropic
// documents as second-class, and the native API is what carries structured
// outputs (output_config.format) and effort. Chat only: Anthropic has no
// embeddings API, which is why EmbedProvider can never be "anthropic"
// (ValidEmbedProvider).

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
