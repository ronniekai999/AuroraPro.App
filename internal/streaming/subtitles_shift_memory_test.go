package streaming

// ShiftedVTT and ServeShiftedSubtitle: the subtitle endpoint's in-memory
// shift for a client-chosen offset (media_start=). Same rewrite as the
// cached ShiftVTTCues, nothing written, and served with what ServeSubtitle
// sends for a cached file.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const memoryShiftFixture = "WEBVTT\n\nSTYLE\n::cue {\n  color: yellow;\n}\n\nNOTE kept\nverbatim\n\n" +
	"1\n00:00:05.000 --> 00:00:08.000\ngone: wholly before the shift\n\n" +
	"cue-2\n00:00:09.000 --> 00:00:12.000 align:start\nstraddles zero\n\n" +
	"00:00:25.000 --> 00:00:27.000\nTwenty-five\n\n\n" +
	"00:01:00.500 --> 00:01:02.250\nlater\n"

func TestShiftedVTTMatchesTheCachedShiftAndWritesNothing(t *testing.T) {
	srcDir := t.TempDir()
	src := writeTempVTT(t, srcDir, "in.vtt", memoryShiftFixture)
	for _, offset := range []float64{9.946009, 10, 0.25, 61} {
		cached, err := ShiftVTTCues(src, offset, t.TempDir())
		if err != nil {
			t.Fatalf("offset %v: cached shift: %v", offset, err)
		}
		want, err := os.ReadFile(cached)
		if err != nil {
			t.Fatal(err)
		}
		got, info, err := ShiftedVTT(src, offset)
		if err != nil {
			t.Fatalf("offset %v: in-memory shift: %v", offset, err)
		}
		if string(got) != string(want) {
			t.Errorf("offset %v: in-memory shift differs from the cached one\n got:\n%s\nwant:\n%s", offset, got, want)
		}
		if srcInfo, _ := os.Stat(src); info == nil || !info.ModTime().Equal(srcInfo.ModTime()) || info.Size() != srcInfo.Size() {
			t.Errorf("offset %v: ShiftedVTT returned %v, want the source's FileInfo", offset, info)
		}
	}
	if entries, _ := os.ReadDir(srcDir); len(entries) != 1 {
		t.Errorf("the in-memory shift wrote beside its source: %v", entries)
	}
	if _, _, err := ShiftedVTT(filepath.Join(srcDir, "missing.vtt"), 10); err == nil {
		t.Error("a missing source must be an error, so the endpoint can serve unshifted")
	}
}

func TestServeShiftedSubtitleSendsWhatTheFilePathSends(t *testing.T) {
	src := writeTempVTT(t, t.TempDir(), "in.vtt", memoryShiftFixture)
	cached, err := ShiftVTTCues(src, 10, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	serveFile := func(h http.Header) *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/sub", nil)
		r.Header = h
		ServeSubtitle(rr, r, cached)
		return rr
	}
	serveMemory := func(offset float64, h http.Header) *httptest.ResponseRecorder {
		body, info, err := ShiftedVTT(src, offset)
		if err != nil {
			t.Fatal(err)
		}
		rr := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/sub", nil)
		r.Header = h
		ServeShiftedSubtitle(rr, r, src, offset, body, info)
		return rr
	}
	file, mem := serveFile(http.Header{}), serveMemory(10, http.Header{})
	if file.Code != http.StatusOK || mem.Code != http.StatusOK {
		t.Fatalf("HTTP file %d, memory %d", file.Code, mem.Code)
	}
	if mem.Body.String() != file.Body.String() {
		t.Errorf("bodies differ:\n%s\nvs\n%s", mem.Body.String(), file.Body.String())
	}
	for _, name := range []string{"Content-Type", "Cache-Control", "Accept-Ranges", "Content-Length"} {
		if got, want := mem.Header().Get(name), file.Header().Get(name); got != want || want == "" {
			t.Errorf("%s: in-memory %q, file %q", name, got, want)
		}
	}
	srcInfo, _ := os.Stat(src)
	if got := mem.Header().Get("Last-Modified"); got != srcInfo.ModTime().UTC().Format(http.TimeFormat) {
		t.Errorf("Last-Modified %q, want the source's %q", got, srcInfo.ModTime().UTC().Format(http.TimeFormat))
	}
	etag := mem.Header().Get("ETag")
	if !strings.HasPrefix(etag, `"`) || etag == serveMemory(10.5, http.Header{}).Header().Get("ETag") {
		t.Errorf("ETag %q: want a quoted tag that differs per shift", etag)
	}
	if got := serveMemory(10, http.Header{"If-None-Match": {etag}}); got.Code != http.StatusNotModified {
		t.Errorf("If-None-Match on the same shift: HTTP %d, want 304", got.Code)
	}
	if got := serveMemory(10, http.Header{"Range": {"bytes=0-5"}}); got.Code != http.StatusPartialContent || got.Body.String() != "WEBVTT" {
		t.Errorf("Range: HTTP %d %q, want 206 \"WEBVTT\" as the file path gives", got.Code, got.Body.String())
	}
}
