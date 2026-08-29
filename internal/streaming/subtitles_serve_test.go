package streaming

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// ServeSubtitle must revalidate rather than let a browser hold a track for a
// day. The subtitle URL is not content-addressed — the SPA keys it on
// (fileId, index, type, start, remux) and nothing else churns it — so a
// long max-age meant a viewer kept the OLD cues for up to 24h after the
// media was replaced in place, which is precisely the staleness
// ExtractSubtitleVTT's fingerprint key exists to fix. The server-side fix
// only reaches a viewer if the response asks the browser to check back.
func TestServeSubtitleRevalidates(t *testing.T) {
	vtt := filepath.Join(t.TempDir(), "track.vtt")
	if err := os.WriteFile(vtt, []byte("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	ServeSubtitle(rec, httptest.NewRequest(http.MethodGet, "/subtitles/0", nil), vtt)

	if got, want := rec.Header().Get("Cache-Control"), "no-cache"; got != want {
		t.Errorf("Cache-Control = %q, want %q — a cached subtitle track must be revalidated, "+
			"or server-side invalidation never reaches the viewer", got, want)
	}
	if got, want := rec.Header().Get("Content-Type"), "text/vtt; charset=utf-8"; got != want {
		t.Errorf("Content-Type = %q, want %q", got, want)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	// Revalidation must be CHEAP: http.ServeFile stamps Last-Modified and
	// answers a conditional request with an empty 304, so the cost of
	// no-cache over a long max-age is one headers-only round trip per track
	// load, not re-sending the body.
	lastMod := rec.Header().Get("Last-Modified")
	if lastMod == "" {
		t.Fatal("no Last-Modified — nothing for the browser to revalidate against, " +
			"so no-cache would re-send the whole track every time")
	}

	req := httptest.NewRequest(http.MethodGet, "/subtitles/0", nil)
	req.Header.Set("If-Modified-Since", lastMod)
	rec2 := httptest.NewRecorder()
	ServeSubtitle(rec2, req, vtt)

	if rec2.Code != http.StatusNotModified {
		t.Errorf("conditional GET status = %d, want 304", rec2.Code)
	}
	if n := rec2.Body.Len(); n != 0 {
		t.Errorf("304 response carried %d bytes of body, want 0", n)
	}
}
