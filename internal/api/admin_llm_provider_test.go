package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Phase E4 — llm_provider became mechanical (it used to be a log-only label),
// so UpdateLLMSettings now rejects incoherent provider combos at save time.
// These tests cover the rejection paths that are decidable from the request
// body alone — they 400 before the handler touches queries, so a zero-value
// AdminHandler (nil queries) exercises them cleanly, matching the package's
// no-DB-mock testing stance. Combos that consult stored settings (e.g.
// provider=ollama_cloud with the key omitted but present in the DB) are
// integration territory.

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
	rec := callUpdateLLM(t, `{"provider":"ollama_cloud","api_key":"","ollama_url":"https://ollama.com"}`)
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
	rec := callUpdateLLM(t, `{"provider":"ollama_cloud","api_key":"sk-test","ollama_url":"http://localhost:11434"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("cloud with local URL: got %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "https") {
		t.Errorf("error should point at the https requirement, got: %s", rec.Body.String())
	}
}

func TestUpdateLLMSettings_LocalRejectsAPIKey(t *testing.T) {
	rec := callUpdateLLM(t, `{"provider":"local","api_key":"sk-test"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("local with key: got %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
}
