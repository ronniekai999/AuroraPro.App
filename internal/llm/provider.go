package llm

import (
	"net/url"
	"strings"
)

// Provider values persisted in the llm_provider server setting. Empty means
// "unset" (legacy installs / env-only config) and implies no enforcement.
// anthropic and openai are hosted chat providers with compile-time base URLs
// (see anthropic.go / openai.go) — the Ollama URL settings don't apply to them.
const (
	ProviderLocal     = "local"
	ProviderCloud     = "ollama_cloud"
	ProviderAnthropic = "anthropic"
	ProviderOpenAI    = "openai"
)

// ValidProvider reports whether p is a recognized chat-provider value.
func ValidProvider(p string) bool {
	switch p {
	case "", ProviderLocal, ProviderCloud, ProviderAnthropic, ProviderOpenAI:
		return true
	}
	return false
}

// ValidEmbedProvider reports whether p is a recognized embedding-provider
// value ("" = legacy/unset, behaves as local). The set is deliberately
// narrower than ValidProvider: Anthropic has no embeddings API, and
// ollama_cloud does not host the embedding models Aurora uses — Ollama-family
// embeds always run on the local box (EmbedURL/BaseURL), so "local" covers
// them.
func ValidEmbedProvider(p string) bool {
	switch p {
	case "", ProviderLocal, ProviderOpenAI:
		return true
	}
	return false
}

// isOllamaProvider reports whether p routes chat through an Ollama endpoint
// (the pre-provider-split behavior). Empty means "unset" and has always meant
// Ollama, so it groups here — the hosted-provider branches only engage on an
// explicit anthropic/openai selection.
func isOllamaProvider(p string) bool {
	return p == "" || p == ProviderLocal || p == ProviderCloud
}

// CheckProviderCombo judges a provider + key + endpoint combination and
// returns one human-readable violation per broken rule (empty = coherent).
//
// This is the SINGLE source of the provider policy, shared by the two
// enforcement points so they cannot drift: the admin save path turns any
// violation into a 400 (a flip of the dropdown must never persist a
// silently-broken half-config), while boot logs each violation as a warning
// (a legacy DB row must never brick startup). Coercions — e.g. defaulting
// the Cloud embed endpoint to the local box — are boot's job, not this
// function's: it only judges what it is given.
//
// Rules:
//   - ollama_cloud needs a bearer key and an https chat URL, and must NOT
//     point embeddings at ollama.com (the embedding models Aurora uses are
//     not Cloud-hosted; embeds stay on the local box).
//   - local must not point chat at ollama.com (that's what the Cloud
//     provider is for). A key WITH provider=local is allowed — operators
//     legitimately front LAN Ollama with bearer-checking reverse proxies.
func CheckProviderCombo(provider, apiKey, chatURL, embedURL string) []string {
	var v []string
	switch provider {
	case ProviderCloud:
		if strings.TrimSpace(apiKey) == "" {
			v = append(v, "provider ollama_cloud requires an API key")
		}
		if !strings.HasPrefix(strings.TrimSpace(chatURL), "https://") {
			v = append(v, "provider ollama_cloud requires an https ollama_url (e.g. https://ollama.com)")
		}
		if IsOllamaCloudHost(embedURL) {
			v = append(v, "embed_url must point at a local Ollama — the embedding models are not hosted on Ollama Cloud (leave it empty to use the local box)")
		}
	case ProviderLocal:
		if IsOllamaCloudHost(chatURL) {
			v = append(v, `provider local cannot point ollama_url at ollama.com — select "Ollama Cloud" instead`)
		}
	}
	return v
}

// IsOllamaCloudHost reports whether rawURL's host is ollama.com (any
// subdomain). Host-parsed, not prefix-matched, so "https://ollama.community"
// does not false-positive and "https://ollama.com:443/x" does not slip by.
func IsOllamaCloudHost(rawURL string) bool {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Host == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "ollama.com" || strings.HasSuffix(host, ".ollama.com")
}
