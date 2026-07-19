package llm

import (
	"strings"
	"testing"
)

func TestValidProvider(t *testing.T) {
	for _, ok := range []string{"", ProviderLocal, ProviderCloud} {
		if !ValidProvider(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"cloud", "LOCAL", "ollama", "openai"} {
		if ValidProvider(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}

func TestCheckProviderCombo(t *testing.T) {
	cases := []struct {
		name             string
		provider         string
		key, chat, embed string
		wantSubstr       string // "" = no violations expected
	}{
		{"unset provider judges nothing", "", "", "http://localhost:11434", "", ""},
		{"local coherent", ProviderLocal, "", "http://localhost:11434", "", ""},
		{"local with key allowed (auth proxy)", ProviderLocal, "sk-x", "https://ollama.lan.example", "", ""},
		{"local pointing at cloud rejected", ProviderLocal, "", "https://ollama.com", "", "ollama.com"},
		{"cloud coherent", ProviderCloud, "sk-x", "https://ollama.com", "http://localhost:11434", ""},
		{"cloud coherent empty embed", ProviderCloud, "sk-x", "https://ollama.com", "", ""},
		{"cloud missing key", ProviderCloud, "", "https://ollama.com", "", "API key"},
		{"cloud non-https chat", ProviderCloud, "sk-x", "http://localhost:11434", "", "https"},
		{"cloud embed on cloud", ProviderCloud, "sk-x", "https://ollama.com", "https://ollama.com", "embed_url"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := CheckProviderCombo(c.provider, c.key, c.chat, c.embed)
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
