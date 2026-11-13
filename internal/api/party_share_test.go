package api

import (
	"bytes"
	"image"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"
)

// ── Poster URL for path-style media_poster values ───────────────────

// The stored value comes with a leading slash from enrichment (TMDB's own
// form) and can come without one from a client (change-media, a room's
// party start). Both must name the same TMDB file: the bare form appended
// to ".../w780" asked for ".../w780abc.jpg", so the share image and the
// share card were drawn without a poster.
func TestShareTMDBPosterURL(t *testing.T) {
	const want = "https://image.tmdb.org/t/p/w780/abc.jpg"
	for _, in := range []string{"abc.jpg", "/abc.jpg", "//abc.jpg"} {
		if got := shareTMDBPosterURL(in); got != want {
			t.Errorf("shareTMDBPosterURL(%q) = %q, want %q", in, got, want)
		}
	}
}

// posterRecorder answers every request with a small PNG and keeps the URL
// it was asked for, so a test sees what fetchPosterImage requests without
// a network call.
type posterRecorder struct {
	t      *testing.T
	body   []byte
	status int // 0 answers 200
	got    []*http.Request
}

func newPosterRecorder(t *testing.T) *posterRecorder {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 3))); err != nil {
		t.Fatalf("encode test poster: %v", err)
	}
	return &posterRecorder{t: t, body: buf.Bytes()}
}

func (p *posterRecorder) RoundTrip(req *http.Request) (*http.Response, error) {
	p.got = append(p.got, req)
	status := p.status
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"image/png"}},
		Body:       io.NopCloser(bytes.NewReader(p.body)),
		Request:    req,
	}, nil
}

// fetchOne runs fetchPosterImage on one value and returns the one request
// it made.
func (p *posterRecorder) fetchOne(poster string) *http.Request {
	p.t.Helper()
	p.got = nil
	h := newCardTestHandler(p.t, &fakeCardManager{}, &fakeCardQueries{})
	h.posterTransport = p
	img, err := h.fetchPosterImage(poster)
	if err != nil {
		p.t.Fatalf("fetchPosterImage(%q): %v", poster, err)
	}
	if b := img.Bounds(); b.Dx() != 2 || b.Dy() != 3 {
		p.t.Fatalf("fetchPosterImage(%q) decoded %v, want the 2x3 test poster", poster, b)
	}
	if len(p.got) != 1 {
		p.t.Fatalf("fetchPosterImage(%q) made %d requests, want 1", poster, len(p.got))
	}
	return p.got[0]
}

// The fetch itself, not only the helper: either form of a TMDB path is
// requested at the same address.
func TestFetchPosterImage_PathFormsRequestTMDB(t *testing.T) {
	rec := newPosterRecorder(t)
	const want = "https://image.tmdb.org/t/p/w780/abc.jpg"
	for _, in := range []string{"abc.jpg", "/abc.jpg"} {
		if got := rec.fetchOne(in).URL.String(); got != want {
			t.Errorf("fetchPosterImage(%q) requested %q, want %q", in, got, want)
		}
	}

	// A path-style value cannot move the request off TMDB, whatever it
	// holds: the trimmed slashes, a userinfo-looking "@" and a query all
	// stay inside an image.tmdb.org URL.
	for _, in := range []string{
		"//evil.example.com/a.jpg",
		"@evil.example.com/a.jpg",
		"/@evil.example.com/a.jpg",
		"?u=https://evil.example.com/a.jpg",
	} {
		req := rec.fetchOne(in)
		if req.URL.Scheme != "https" || req.URL.Hostname() != "image.tmdb.org" || req.URL.User != nil {
			t.Errorf("fetchPosterImage(%q) requested %q; a path must stay on https://image.tmdb.org", in, req.URL)
		}
	}
}

// A refused fetch names the URL it asked for: the stored value alone did
// not show that "abc.jpg" had been requested as ".../w780abc.jpg".
func TestFetchPosterImage_StatusErrorNamesTheURL(t *testing.T) {
	rec := newPosterRecorder(t)
	rec.status = http.StatusNotFound
	h := newCardTestHandler(t, &fakeCardManager{}, &fakeCardQueries{})
	h.posterTransport = rec
	_, err := h.fetchPosterImage("abc.jpg")
	if err == nil {
		t.Fatal("a 404 decoded as a poster")
	}
	for _, want := range []string{"https://image.tmdb.org/t/p/w780/abc.jpg", "404"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error = %q; want it to name %q", err, want)
		}
	}
}

// Full URLs (TVDB enrichment) take the other branch and are requested as
// stored, once the allowlist passes them.
func TestFetchPosterImage_FullURLRequestedAsStored(t *testing.T) {
	rec := newPosterRecorder(t)
	const in = "https://artworks.thetvdb.com/banners/posters/a.jpg"
	if got := rec.fetchOne(in).URL.String(); got != in {
		t.Errorf("fetchPosterImage(%q) requested %q, want it unchanged", in, got)
	}
}
