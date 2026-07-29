package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Serving + source contract for the PWA entry files (do/pwa-push/
// IMPLEMENTATION.md, Phase 1).
//
// The SPA fallback answers 200 with index.html for ANY missing /v2/* path,
// so a bare status assertion on /v2/sw.js or the manifest proves nothing —
// every test here pins content type or body, the properties that actually
// fail when a file is missing or served wrong.

// v2Fixture builds a fake StaticDir with a v2 bundle and returns a GET
// helper against the handler under test.
func v2Fixture(t *testing.T) func(path string) *httptest.ResponseRecorder {
	t.Helper()
	staticDir := t.TempDir()
	v2 := filepath.Join(staticDir, "v2")
	if err := os.MkdirAll(v2, 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"index.html":           "<html><body>aurora-index</body></html>",
		"sw.js":                "// aurora-sw fixture",
		"manifest.webmanifest": `{"name":"Aurora Pro"}`,
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(v2, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h := newV2Handler(staticDir, filepath.Join(v2, "index.html"))
	return func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		return rec
	}
}

func TestV2HandlerServesManifestWithRegisteredType(t *testing.T) {
	get := v2Fixture(t)
	rec := get("/v2/manifest.webmanifest")
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	// The explicit header, NOT a host-mime lookup: Go's extension table is
	// host-dependent (XDG DB / /etc/mime.types) and commonly lacks
	// .webmanifest, in which case ServeFile would sniff text/plain.
	if ct := rec.Header().Get("Content-Type"); ct != "application/manifest+json" {
		t.Errorf("Content-Type = %q, want application/manifest+json", ct)
	}
	if !strings.Contains(rec.Body.String(), "Aurora Pro") {
		t.Errorf("body = %q, want the manifest fixture, not an SPA fallback", rec.Body.String())
	}
}

func TestV2HandlerServesServiceWorkerAsJS(t *testing.T) {
	get := v2Fixture(t)
	rec := get("/v2/sw.js")
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Errorf("Content-Type = %q, want a javascript type — a non-script type makes register() fail", ct)
	}
	if !strings.Contains(rec.Body.String(), "aurora-sw") {
		t.Errorf("body = %q, want the sw fixture, not an SPA fallback", rec.Body.String())
	}

	// Document WHY the assertions above are body/type based: a missing file
	// comes back 200 text/html via the SPA fallback — the failure mode a
	// status-only test would wave through.
	fallback := get("/v2/definitely-not-a-file.js")
	if fallback.Code != 200 || !strings.Contains(fallback.Body.String(), "aurora-index") {
		t.Errorf("expected the SPA fallback for a missing path, got %d %q", fallback.Code, fallback.Body.String())
	}
}

func TestFrontendHeadersPermitServiceWorkerRegistration(t *testing.T) {
	rec := httptest.NewRecorder()
	noop := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	frontendHeaders(noop).ServeHTTP(rec, httptest.NewRequest("GET", "/v2/", nil))

	csp := rec.Header().Get("Content-Security-Policy")
	// SW registration is governed by worker-src; without 'self' the browser
	// refuses register('/v2/sw.js') outright. blob: must survive alongside it
	// for hls.js's transmux worker.
	if !strings.Contains(csp, "worker-src 'self' blob:") {
		t.Errorf("CSP worker-src must allow 'self' and blob:, got %q", csp)
	}
	// no-cache is what makes sw.js updates take effect within one navigation
	// of a deploy — load-bearing for the auto-update story.
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-cache") {
		t.Errorf("Cache-Control = %q, want no-cache", cc)
	}
}

// TestPWASourceContract pins the committed source files themselves — the
// invariants that make the whole design safe, enforced where a refactor
// can't dodge them.
func TestPWASourceContract(t *testing.T) {
	pub := filepath.Join("..", "..", "static", "redesign", "app", "public")

	sw, err := os.ReadFile(filepath.Join(pub, "sw.js"))
	if err != nil {
		t.Fatalf("public/sw.js must exist — installability and Phase 2 push depend on it: %v", err)
	}
	// D1: the service worker must NEVER intercept fetches. The box deletes
	// old bundles on every deploy, so any SW-held asset would go stale or
	// 404. This grep guard is deliberately blunt — if it fires, read
	// do/pwa-push/IMPLEMENTATION.md before "fixing" the test.
	if regexp.MustCompile(`addEventListener\(\s*['"]fetch['"]`).Match(sw) {
		t.Error("sw.js registers a 'fetch' listener — forbidden by design (D1): the auto-updater replaces the bundle in place, so a caching/intercepting worker will serve a stale site")
	}
	// Pin the lifecycle CALLS, not the listener names: the review's mutation
	// pass emptied both handlers and every check stayed green when this
	// looked for `'install'`/`'activate'` only. skipWaiting is what replaces
	// an old worker without a second reload; clients.claim is what makes the
	// FIRST visit controlled (verify-pwa.mjs binds that end-to-end).
	for _, want := range []string{"skipWaiting", "clients.claim"} {
		if !strings.Contains(string(sw), want) {
			t.Errorf("sw.js no longer calls %s — worker updates/first-visit control regress silently without it", want)
		}
	}

	rawManifest, err := os.ReadFile(filepath.Join(pub, "manifest.webmanifest"))
	if err != nil {
		t.Fatalf("public/manifest.webmanifest must exist: %v", err)
	}
	var manifest struct {
		ID         string `json:"id"`
		StartURL   string `json:"start_url"`
		Scope      string `json:"scope"`
		Display    string `json:"display"`
		ThemeColor string `json:"theme_color"`
		Icons      []struct {
			Src   string `json:"src"`
			Sizes string `json:"sizes"`
		} `json:"icons"`
	}
	if err := json.Unmarshal(rawManifest, &manifest); err != nil {
		t.Fatalf("manifest.webmanifest is not valid JSON: %v", err)
	}
	// The SPA is mounted at /v2/ (vite base + the /v2/* route). A manifest
	// pointing anywhere else installs an app whose scope doesn't cover the
	// app. These are literals that do NOT follow vite `base` — if the SPA
	// ever moves to the root, they move by hand, together.
	for name, got := range map[string]string{"id": manifest.ID, "start_url": manifest.StartURL, "scope": manifest.Scope} {
		if got != "/v2/" {
			t.Errorf("manifest %s = %q, want \"/v2/\"", name, got)
		}
	}
	if manifest.Display != "standalone" {
		t.Errorf("manifest display = %q, want standalone", manifest.Display)
	}
	if len(manifest.Icons) < 4 {
		t.Errorf("manifest lists %d icons, want at least 192/512 in any+maskable", len(manifest.Icons))
	}
	for _, icon := range manifest.Icons {
		rel := strings.TrimPrefix(icon.Src, "/v2/")
		if rel == icon.Src {
			t.Errorf("icon src %q must be under /v2/", icon.Src)
			continue
		}
		if _, err := os.Stat(filepath.Join(pub, rel)); err != nil {
			t.Errorf("manifest icon %s is not in public/: %v", icon.Src, err)
		}
	}

	index, err := os.ReadFile(filepath.Join(pub, "..", "index.html"))
	if err != nil {
		t.Fatalf("reading index.html: %v", err)
	}
	for _, want := range []string{
		`rel="manifest" href="/v2/manifest.webmanifest"`,
		`name="theme-color"`,
		`rel="apple-touch-icon"`,
	} {
		if !strings.Contains(string(index), want) {
			t.Errorf("index.html is missing %s — the PWA head tags must survive edits", want)
		}
	}
}
