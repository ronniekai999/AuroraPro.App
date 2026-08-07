package llm

import (
	"strings"
	"testing"
)

func TestValidProvider(t *testing.T) {
	// "openai"/"anthropic" moved from the invalid list to the valid one when
	// hosted providers landed — a deliberate contract flip, not an accident.
	for _, ok := range []string{"", ProviderLocal, ProviderCloud, ProviderAnthropic, ProviderOpenAI} {
		if !ValidProvider(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"cloud", "LOCAL", "ollama", "OpenAI", "claude", "chatgpt"} {
		if ValidProvider(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}

func TestValidEmbedProvider(t *testing.T) {
	for _, ok := range []string{"", ProviderLocal, ProviderOpenAI} {
		if !ValidEmbedProvider(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	// anthropic is a valid CHAT provider but can never embed (no embeddings
	// API); ollama_cloud embeds are already forbidden by the combo rules and
	// the selector never offers it.
	for _, bad := range []string{ProviderAnthropic, ProviderCloud, "OpenAI", "voyage"} {
		if ValidEmbedProvider(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}

func TestIsOllamaProvider(t *testing.T) {
	for _, ok := range []string{"", ProviderLocal, ProviderCloud} {
		if !isOllamaProvider(ok) {
			t.Errorf("%q should be ollama-family", ok)
		}
	}
	for _, not := range []string{ProviderAnthropic, ProviderOpenAI} {
		if isOllamaProvider(not) {
			t.Errorf("%q should not be ollama-family", not)
		}
	}
}

func TestCheckProviderCombo(t *testing.T) {
	cases := []struct {
		name       string
		combo      ProviderCombo
		wantSubstr string // "" = no violations expected
	}{
		// Pre-provider-split rows, preserved verbatim (EmbedProvider "").
		{"unset provider judges nothing", ProviderCombo{ChatURL: "http://localhost:11434"}, ""},
		{"local coherent", ProviderCombo{Provider: ProviderLocal, ChatURL: "http://localhost:11434"}, ""},
		{"local with key allowed (auth proxy)", ProviderCombo{Provider: ProviderLocal, APIKey: "sk-x", ChatURL: "https://ollama.lan.example"}, ""},
		{"local pointing at cloud rejected", ProviderCombo{Provider: ProviderLocal, ChatURL: "https://ollama.com"}, "ollama.com"},
		{"cloud coherent", ProviderCombo{Provider: ProviderCloud, APIKey: "sk-x", ChatURL: "https://ollama.com", EmbedURL: "http://localhost:11434"}, ""},
		{"cloud coherent empty embed", ProviderCombo{Provider: ProviderCloud, APIKey: "sk-x", ChatURL: "https://ollama.com"}, ""},
		{"cloud missing key", ProviderCombo{Provider: ProviderCloud, ChatURL: "https://ollama.com"}, "API key"},
		{"cloud non-https chat", ProviderCombo{Provider: ProviderCloud, APIKey: "sk-x", ChatURL: "http://localhost:11434"}, "https"},
		{"cloud embed on cloud", ProviderCombo{Provider: ProviderCloud, APIKey: "sk-x", ChatURL: "https://ollama.com", EmbedURL: "https://ollama.com"}, "embed_url"},

		// Hosted chat providers.
		{"anthropic coherent", ProviderCombo{Provider: ProviderAnthropic, AnthropicKey: "sk-ant-x"}, ""},
		{"anthropic missing key", ProviderCombo{Provider: ProviderAnthropic}, "Anthropic API key"},
		{"anthropic ignores ollama key", ProviderCombo{Provider: ProviderAnthropic, APIKey: "sk-x"}, "Anthropic API key"},
		{"anthropic with local embeds needs no ollama key", ProviderCombo{Provider: ProviderAnthropic, AnthropicKey: "sk-ant-x", EmbedProvider: ProviderLocal, EmbedURL: "http://localhost:11434"}, ""},
		{"openai coherent", ProviderCombo{Provider: ProviderOpenAI, OpenAIKey: "sk-oai-x"}, ""},
		{"openai missing key", ProviderCombo{Provider: ProviderOpenAI}, "OpenAI API key"},

		// Embed provider rules — independent of the chat provider.
		{"openai embeds with key", ProviderCombo{Provider: ProviderLocal, ChatURL: "http://localhost:11434", EmbedProvider: ProviderOpenAI, OpenAIKey: "sk-oai-x"}, ""},
		{"openai embeds missing key", ProviderCombo{Provider: ProviderLocal, ChatURL: "http://localhost:11434", EmbedProvider: ProviderOpenAI}, "embed provider openai requires"},
		{"anthropic chat + openai embeds needs both keys", ProviderCombo{Provider: ProviderAnthropic, AnthropicKey: "sk-ant-x", EmbedProvider: ProviderOpenAI}, "embed provider openai requires"},
		{"all-cloud coherent", ProviderCombo{Provider: ProviderAnthropic, AnthropicKey: "sk-ant-x", EmbedProvider: ProviderOpenAI, OpenAIKey: "sk-oai-x"}, ""},
		{"embed provider anthropic impossible", ProviderCombo{EmbedProvider: ProviderAnthropic}, "no embeddings API"},
		{"embed provider unknown", ProviderCombo{EmbedProvider: "voyage"}, "unknown embed provider"},
		{"chat provider unknown (env typo)", ProviderCombo{Provider: "antropic", AnthropicKey: "sk-ant-x"}, "unknown provider"},
		{"openai embeds skip the ollama.com embed rule", ProviderCombo{Provider: ProviderCloud, APIKey: "sk-x", ChatURL: "https://ollama.com", EmbedProvider: ProviderOpenAI, OpenAIKey: "sk-oai-x", EmbedURL: "https://ollama.com"}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := CheckProviderCombo(c.combo)
			if c.wantSubstr == "" {
				if len(got) != 0 {
					t.Fatalf("want no violations, got %v", got)
				}
				return
			}
			joined := strings.Join(got, " | ")
			if !strings.Contains(joined, c.wantSubstr) {
				t.Fatalf("want violation containing %q, got %v", c.wantSubstr, got)
			}
		})
	}
}

func TestIsOllamaCloudHost(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"https://ollama.com", true},
		{"https://ollama.com:443/api", true},
		{"https://api.ollama.com", true},
		{"https://OLLAMA.COM", true},
		{"https://ollama.community", false}, // prefix lookalike must not match
		{"https://myollama.com.evil.example", false},
		{"http://localhost:11434", false},
		{"", false},
		{"not a url", false},
	}
	for _, c := range cases {
		if got := IsOllamaCloudHost(c.url); got != c.want {
			t.Errorf("IsOllamaCloudHost(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}
