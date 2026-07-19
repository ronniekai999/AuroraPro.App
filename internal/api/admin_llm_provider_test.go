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

func callUpdateLLM(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := &AdminHandler{}
	req := httptest.NewRequest(http.MethodPut, "/api/admin/llm", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.UpdateLLMSettings(rec, req)
	return rec
}

func TestUpdateLLMSettings_RejectsUnknownProvider(t *testing.T) {
	rec := callUpdateLLM(t, `{"provider":"cloud"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown provider: got %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestUpdateLLMSettings_CloudRequiresAPIKey(t *testing.T) {
	// Explicit empty key + cloud provider must fail loudly — the old cosmetic
	// field let this save and then silently 401 at runtime.
	rec := callUpdateLLM(t, `{"provider":"ollama_cloud","api_key":"","ollama_url":"https://ollama.com","embed_url":"http://localhost:11434"}`)
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
	rec := callUpdateLLM(t, `{"provider":"ollama_cloud","api_key":"sk-test","ollama_url":"http://localhost:11434","embed_url":""}`)
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
	rec := callUpdateLLM(t, `{"provider":"ollama_cloud","api_key":"sk-test","ollama_url":"https://ollama.com","embed_url":"https://ollama.com"}`)
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
	rec := callUpdateLLM(t, `{"provider":"local","api_key":"","ollama_url":"https://ollama.com","embed_url":""}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("local with ollama.com URL: got %d, want 400 (body: %s)", rec.Code, rec.Body.String())
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
	callUpdateLLM(t, `{"provider":"local","api_key":"sk-proxy","ollama_url":"http://lan-box:11434","embed_url":""}`)
}
