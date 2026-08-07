package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Phase E4 — llm_provider became mechanical (it used to be a log-only label),
// so UpdateLLMSettings now rejects incoherent provider combos at save time
// via the shared llm.CheckProviderCombo policy. These tests cover the
// rejection paths that are decidable from the request body alone — they 400
// before the handler touches queries, so a zero-value AdminHandler (nil
// queries) exercises them cleanly, matching the package's no-DB-mock testing
// stance. Combos that consult stored settings (sparse saves) are integration
// territory; the policy matrix itself is unit-tested in
// internal/llm/provider_test.go.
//
// Every body posts ALL combo-consulted fields (including the hosted-provider
// keys and embed_provider) — an omitted field would make the effective()
// resolver consult the nil queries and panic before validation finishes.

func callUpdateLLM(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := &AdminHandler{}
	req := httptest.NewRequest(http.MethodPut, "/api/admin/llm", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.UpdateLLMSettings(rec, req)
	return rec
}

// allFields merges the given JSON fragment over a base body that posts every
// combo-consulted field as empty, keeping individual tests readable.
func allFields(fragment string) string {
	base := `"provider":"","embed_provider":"","api_key":"","anthropic_api_key":"","openai_api_key":"","ollama_url":"","embed_url":""`
	if fragment == "" {
		return "{" + base + "}"
	}
	// Later keys win in encoding/json decoding, so the fragment overrides.
	return "{" + base + "," + fragment + "}"
}

func TestUpdateLLMSettings_RejectsUnknownProvider(t *testing.T) {
	rec := callUpdateLLM(t, `{"provider":"cloud"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown provider: got %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestUpdateLLMSettings_RejectsUnknownEmbedProvider(t *testing.T) {
	// "anthropic" is a valid CHAT provider but impossible for embeds (no
	// embeddings API) — the error must say so rather than being generic.
	rec := callUpdateLLM(t, `{"embed_provider":"anthropic"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("embed_provider=anthropic: got %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no embeddings API") {
		t.Errorf("error should explain Anthropic has no embeddings API, got: %s", rec.Body.String())
	}
	if rec := callUpdateLLM(t, `{"embed_provider":"voyage"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("embed_provider=voyage: got %d, want 400", rec.Code)
	}
}

func TestUpdateLLMSettings_CloudRequiresAPIKey(t *testing.T) {
	// Explicit empty key + cloud provider must fail loudly — the old cosmetic
	// field let this save and then silently 401 at runtime.
	rec := callUpdateLLM(t, allFields(`"provider":"ollama_cloud","ollama_url":"https://ollama.com","embed_url":"http://localhost:11434"`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("cloud without key: got %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "API key") {
		t.Errorf("error should name the missing API key, got: %s", rec.Body.String())
	}
}

func TestUpdateLLMSettings_CloudRequiresHTTPSURL(t *testing.T) {
	// Flipping to cloud while leaving a local URL is the classic
	// "changed the dropdown, nothing happened" trap.
	rec := callUpdateLLM(t, allFields(`"provider":"ollama_cloud","api_key":"sk-test","ollama_url":"http://localhost:11434"`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("cloud with local URL: got %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "https") {
		t.Errorf("error should point at the https requirement, got: %s", rec.Body.String())
	}
}

func TestUpdateLLMSettings_CloudRejectsCloudEmbedURL(t *testing.T) {
	// Embedding models aren't hosted on Ollama Cloud — pointing embeds at
	// ollama.com would silently break search after restart (review finding).
	rec := callUpdateLLM(t, allFields(`"provider":"ollama_cloud","api_key":"sk-test","ollama_url":"https://ollama.com","embed_url":"https://ollama.com"`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("cloud embed URL: got %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "embed_url") {
		t.Errorf("error should name embed_url, got: %s", rec.Body.String())
	}
}

func TestUpdateLLMSettings_LocalRejectsCloudChatURL(t *testing.T) {
	// The symmetric trap: flipping cloud→local while the URL field still
	// says ollama.com would leave chat pointed at Cloud under a "local"
	// label (and, once any stored key is cleared, 401 on every call).
	rec := callUpdateLLM(t, allFields(`"provider":"local","ollama_url":"https://ollama.com"`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("local with ollama.com URL: got %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestUpdateLLMSettings_AnthropicRequiresKey(t *testing.T) {
	rec := callUpdateLLM(t, allFields(`"provider":"anthropic"`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("anthropic without key: got %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Anthropic API key") {
		t.Errorf("error should name the Anthropic key, got: %s", rec.Body.String())
	}
	// The Ollama Cloud bearer must NOT satisfy the requirement — keys are
	// per-provider.
	rec = callUpdateLLM(t, allFields(`"provider":"anthropic","api_key":"sk-ollama"`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("anthropic with only the ollama key: got %d, want 400", rec.Code)
	}
}

func TestUpdateLLMSettings_OpenAIRequiresKey(t *testing.T) {
	rec := callUpdateLLM(t, allFields(`"provider":"openai"`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("openai without key: got %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "OpenAI API key") {
		t.Errorf("error should name the OpenAI key, got: %s", rec.Body.String())
	}
}

func TestUpdateLLMSettings_OpenAIEmbedsRequireKey(t *testing.T) {
	// Embed provider openai needs the OpenAI key even when chat stays local.
	rec := callUpdateLLM(t, allFields(`"provider":"local","embed_provider":"openai","ollama_url":"http://localhost:11434"`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("openai embeds without key: got %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "embed provider openai") {
		t.Errorf("error should name the embed provider requirement, got: %s", rec.Body.String())
	}
}

func TestUpdateLLMSettings_LocalAllowsAPIKeyValidation(t *testing.T) {
	// provider=local with a key is deliberately permitted (bearer-checking
	// reverse proxies in front of LAN Ollama are legitimate) — the policy
	// check must NOT 400 this combo. The handler proceeds past validation
	// and only then would touch queries; with the zero-value handler that
	// panics, which we catch as proof validation accepted the combo. (An
	// httptest DB harness would be nicer; the package has none by design.)
	defer func() {
		if recover() == nil {
			t.Fatal("expected the nil-queries panic AFTER validation passed; a 400 means the combo was wrongly rejected")
		}
	}()
	callUpdateLLM(t, allFields(`"provider":"local","api_key":"sk-proxy","ollama_url":"http://lan-box:11434"`))
}

func TestUpdateLLMSettings_AnthropicWithKeyAccepted(t *testing.T) {
	// The happy path for a hosted provider: validation passes and the
	// handler proceeds to the save loop, which touches the nil queries.
	defer func() {
		if recover() == nil {
			t.Fatal("expected the nil-queries panic AFTER validation passed; a 400 means the combo was wrongly rejected")
		}
	}()
	callUpdateLLM(t, allFields(`"provider":"anthropic","anthropic_api_key":"sk-ant-x"`))
}

func TestUpdateLLMSettings_AllCloudAccepted(t *testing.T) {
	// anthropic chat + openai embeds with both keys — the zero-Ollama shape.
	defer func() {
		if recover() == nil {
			t.Fatal("expected the nil-queries panic AFTER validation passed; a 400 means the combo was wrongly rejected")
		}
	}()
	callUpdateLLM(t, allFields(`"provider":"anthropic","embed_provider":"openai","anthropic_api_key":"sk-ant-x","openai_api_key":"sk-oai-x"`))
}
