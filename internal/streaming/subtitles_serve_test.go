package streaming

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

	if got, want := rec.Header().Get("Cache-Control"), "private, no-cache"; got != want {
		t.Errorf("Cache-Control = %q, want %q — a cached subtitle track must be revalidated, "+
			"or server-side invalidation never reaches the viewer; `private` because this "+
			"URL may carry a ?token= and must not enter a shared cache", got, want)
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

// The fingerprint key lets the served file move BACKWARDS in time, which is
// precisely where Last-Modified fails as a validator: replace media A with B
// (newer track), then restore A preserving size and mtime — the `rsync -a`
// case this whole change exists for — and the key resolves back to A's older
// track. A browser holding B revalidates with B's newer stamp; on
// Last-Modified alone the server answers 304 and the viewer keeps B's
// subtitles over A's video. The ETag has to break that tie.
func TestServeSubtitleETagDistinguishesTracksRegardlessOfMtimeOrder(t *testing.T) {
	dir := t.TempDir()

	// Two cache entries, as the fingerprint key would produce for two
	// versions of one media file. trackA is deliberately the OLDER file.
	trackA := filepath.Join(dir, "movie_aaaaaaaaaaaa_sub0_1111.vtt")
	trackB := filepath.Join(dir, "movie_aaaaaaaaaaaa_sub0_2222.vtt")
	for _, p := range []string{trackA, trackB} {
		if err := os.WriteFile(p, []byte("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n"+filepath.Base(p)+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	older := time.Now().Add(-2 * time.Hour)
	newer := time.Now().Add(-1 * time.Hour)
	if err := os.Chtimes(trackA, older, older); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(trackB, newer, newer); err != nil {
		t.Fatal(err)
	}

	serve := func(p string, hdr map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/subtitles/0", nil)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		ServeSubtitle(rec, req, p)
		return rec
	}

	// Viewer has B cached.
	bResp := serve(trackB, nil)
	bETag := bResp.Header().Get("ETag")
	bLastMod := bResp.Header().Get("Last-Modified")
	if bETag == "" {
		t.Fatal("no ETag on the served track — nothing can break the mtime tie")
	}

	// Media reverts to A. The viewer revalidates with what it holds for B.
	revalidated := serve(trackA, map[string]string{
		"If-None-Match":     bETag,
		"If-Modified-Since": bLastMod,
	})
	if revalidated.Code == http.StatusNotModified {
		t.Error("served 304 for a DIFFERENT track that happens to be older — " +
			"the viewer keeps the previous version's subtitles over the restored media")
	}
	if body := revalidated.Body.String(); !strings.Contains(body, filepath.Base(trackA)) {
		t.Errorf("revalidation did not deliver the restored track; body:\n%s", body)
	}

	// And the unchanged case must still be cheap: same track, same validator.
	same := serve(trackA, map[string]string{"If-None-Match": revalidated.Header().Get("ETag")})
	if same.Code != http.StatusNotModified {
		t.Errorf("unchanged track revalidated to %d, want 304 — revalidation must stay cheap", same.Code)
	}
}
