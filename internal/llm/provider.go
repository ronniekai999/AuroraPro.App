package llm

import (
	"net/url"
	"strconv"
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

// ProviderCombo is the full provider-relevant configuration CheckProviderCombo
// judges. A struct rather than positional args: at seven fields, call sites
// silently swapping two same-typed strings is a matter of time.
type ProviderCombo struct {
	Provider      string // chat provider: "" | local | ollama_cloud | anthropic | openai
	EmbedProvider string // "" | local | openai
	APIKey        string // the Ollama Cloud bearer (llm_api_key)
	AnthropicKey  string // llm_anthropic_api_key
	OpenAIKey     string // llm_openai_api_key
	ChatURL       string // llm_ollama_url (Ollama-family chat only)
	EmbedURL      string // llm_embed_url (Ollama-family embeds only)
}

// CheckProviderCombo judges a provider configuration and returns one
// human-readable violation per broken rule (empty = coherent).
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
//     not Cloud-hosted; Ollama-family embeds stay on the local box).
//   - local must not point chat at ollama.com (that's what the Cloud
//     provider is for). A key WITH provider=local is allowed — operators
//     legitimately front LAN Ollama with bearer-checking reverse proxies.
//   - anthropic / openai chat require their own API key (the vendor URLs are
//     compile-time constants, so there is no URL rule to check).
//   - embed provider openai requires the OpenAI key INDEPENDENTLY of the
//     chat provider — local chat + openai embeds is a legal shape.
//   - embed provider must be a ValidEmbedProvider value; "anthropic"
//     specifically is named (no embeddings API) so a hand-edited row gets a
//     useful message instead of a generic one.
func CheckProviderCombo(c ProviderCombo) []string {
	var v []string
	switch c.Provider {
	case ProviderCloud:
		if strings.TrimSpace(c.APIKey) == "" {
			v = append(v, "provider ollama_cloud requires an API key")
		}
		if !strings.HasPrefix(strings.TrimSpace(c.ChatURL), "https://") {
			v = append(v, "provider ollama_cloud requires an https ollama_url (e.g. https://ollama.com)")
		}
	case ProviderLocal:
		if IsOllamaCloudHost(c.ChatURL) {
			v = append(v, `provider local cannot point ollama_url at ollama.com — select "Ollama Cloud" instead`)
		}
	case ProviderAnthropic:
		if strings.TrimSpace(c.AnthropicKey) == "" {
			v = append(v, "provider anthropic requires an Anthropic API key")
		}
	case ProviderOpenAI:
		if strings.TrimSpace(c.OpenAIKey) == "" {
			v = append(v, "provider openai requires an OpenAI API key")
		}
	default:
		// "" = unset, judges nothing. Anything else is a typo'd env/row
		// (LLM_PROVIDER=antropic): chat would silently fall back to Ollama
		// while rerank errors "not routable" — name it here so boot's
		// warn-only pass surfaces the half-degraded state (admin saves
		// already 400 earlier via ValidProvider).
		if c.Provider != "" {
			v = append(v, "unknown provider "+strconv.Quote(c.Provider))
		}
	}
	switch c.EmbedProvider {
	case "", ProviderLocal:
		// Ollama-family embeds: the no-embeds-on-ollama.com rule applies only
		// when embeddings actually route through an Ollama URL, and only the
		// Cloud chat provider can steer them there implicitly.
		if c.Provider == ProviderCloud && IsOllamaCloudHost(c.EmbedURL) {
			v = append(v, "embed_url must point at a local Ollama — the embedding models are not hosted on Ollama Cloud (leave it empty to use the local box)")
		}
	case ProviderOpenAI:
		if strings.TrimSpace(c.OpenAIKey) == "" {
			v = append(v, "embed provider openai requires an OpenAI API key")
		}
	case ProviderAnthropic:
		v = append(v, "embed provider cannot be anthropic — Anthropic has no embeddings API; use local (Ollama) or openai")
	default:
		v = append(v, "unknown embed provider "+strconv.Quote(c.EmbedProvider))
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
