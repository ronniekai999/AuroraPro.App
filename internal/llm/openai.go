package llm

// OpenAI (ChatGPT) adapter: chat rides the /v1/chat/completions surface the
// package already speaks for Ollama Cloud (oaiChatRequest in client.go), and
// embeddings ride /v1/embeddings — text-embedding-3 models accept a
// `dimensions` request param, so cfg.Dims (768, matching migration 040's
// vector(768) column) is requested directly and no schema change is needed.

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
