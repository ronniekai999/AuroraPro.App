package streaming

// ShiftedVTT and ServeShiftedSubtitle: the subtitle endpoint's in-memory
// shift for a client-chosen offset (media_start=). Same rewrite as the
// cached ShiftVTTCues, nothing written, served with what ServeSubtitle sends
// for a cached file, built only when a request needs the body, for sources
// up to MaxInMemoryShiftSourceBytes, a few at a time.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const memoryShiftFixture = "WEBVTT\n\nSTYLE\n::cue {\n  color: yellow;\n}\n\nNOTE kept\nverbatim\n\n" +
	"1\n00:00:05.000 --> 00:00:08.000\ngone: wholly before the shift\n\n" +
	"cue-2\n00:00:09.000 --> 00:00:12.000 align:start\nstraddles zero\n\n" +
	"00:00:25.000 --> 00:00:27.000\nTwenty-five\n\n\n" +
	"timing only\n00:00:40.000 --> 00:00:41.000\n\n" +
	"00:01:00.500 --> 00:01:02.250line:0\nlater\n"

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

// serveShifted runs ServeShiftedSubtitle for src the way the endpoint does:
// InMemoryShiftSource first, then the response.
func serveShifted(t *testing.T, src string, offset float64, h http.Header, ctx context.Context) *httptest.ResponseRecorder {
	t.Helper()
	info, err := InMemoryShiftSource(src)
	if err != nil {
		t.Fatalf("InMemoryShiftSource: %v", err)
	}
	return serveShiftedWith(src, offset, info, h, ctx)
}

func serveShiftedWith(src string, offset float64, info os.FileInfo, h http.Header, ctx context.Context) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/sub", nil).WithContext(ctx)
	r.Header = h
	ServeShiftedSubtitle(rr, r, src, offset, info)
	return rr
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
	ctx := context.Background()
	file, mem := serveFile(http.Header{}), serveShifted(t, src, 10, http.Header{}, ctx)
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
	if etag := mem.Header().Get("ETag"); !strings.HasPrefix(etag, `"`) || etag != shiftedSubtitleETag(src, srcInfo, 10) {
		t.Errorf("ETag %q, want shiftedSubtitleETag's", etag)
	}
	if got := serveShifted(t, src, 10, http.Header{"Range": {"bytes=0-5"}}, ctx); got.Code != http.StatusPartialContent || got.Body.String() != "WEBVTT" {
		t.Errorf("Range: HTTP %d %q, want 206 \"WEBVTT\" as the file path gives", got.Code, got.Body.String())
	}
}

// A revalidation must not pay for the rewrite: the source is removed after
// the endpoint's stat, so a request that rewrote would fail (the control),
// and a 304 shows nothing read it.
func TestServeShiftedSubtitleRevalidatesWithoutRewriting(t *testing.T) {
	ctx := context.Background()
	src := writeTempVTT(t, t.TempDir(), "in.vtt", memoryShiftFixture)
	first := serveShifted(t, src, 10, http.Header{}, ctx)
	etag, lastModified := first.Header().Get("ETag"), first.Header().Get("Last-Modified")
	info, err := InMemoryShiftSource(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(src); err != nil {
		t.Fatal(err)
	}
	for name, h := range map[string]http.Header{
		"If-None-Match":     {"If-None-Match": {etag}},
		"If-Modified-Since": {"If-Modified-Since": {lastModified}},
	} {
		if got := serveShiftedWith(src, 10, info, h, ctx); got.Code != http.StatusNotModified || got.Body.Len() != 0 {
			t.Errorf("%s: HTTP %d with %d bytes, want 304 and no rewrite", name, got.Code, got.Body.Len())
		}
	}
	if got := serveShiftedWith(src, 10, info, http.Header{"If-None-Match": {`"another"`}}, ctx); got.Code != http.StatusInternalServerError {
		t.Errorf("control: a request that needs the body got HTTP %d; it should have tried the (removed) source", got.Code)
	}
}

func TestInMemoryShiftSourceCapsTheSize(t *testing.T) {
	dir := t.TempDir()
	for _, tc := range []struct {
		size int64
		want error
	}{
		{MaxInMemoryShiftSourceBytes, nil},
		{MaxInMemoryShiftSourceBytes + 1, ErrShiftSourceTooLarge},
	} {
		p := filepath.Join(dir, "sized.vtt")
		if err := os.WriteFile(p, []byte("WEBVTT\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Truncate(p, tc.size); err != nil { // sparse: no 8 MB write
			t.Fatal(err)
		}
		if _, err := InMemoryShiftSource(p); !errors.Is(err, tc.want) {
			t.Errorf("a %d-byte source: %v, want %v", tc.size, err, tc.want)
		}
	}
	if _, err := InMemoryShiftSource(filepath.Join(dir, "missing.vtt")); err == nil || errors.Is(err, ErrShiftSourceTooLarge) {
		t.Errorf("a missing source: %v, want the stat error", err)
	}
}

// Rewrites take a slot; a request waits for one only as long as its own
// context lasts, and gets one once a slot frees.
func TestServeShiftedSubtitleWaitsForARewriteSlot(t *testing.T) {
	src := writeTempVTT(t, t.TempDir(), "in.vtt", memoryShiftFixture)
	for i := 0; i < cap(inMemoryShiftSlots); i++ {
		inMemoryShiftSlots <- struct{}{}
	}
	released := false
	release := func() {
		if !released {
			for i := 0; i < cap(inMemoryShiftSlots); i++ {
				<-inMemoryShiftSlots
			}
			released = true
		}
	}
	t.Cleanup(release)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	began := time.Now()
	if got := serveShifted(t, src, 10, http.Header{}, ctx); got.Code != http.StatusInternalServerError {
		t.Errorf("no free slot, context ended: HTTP %d, want 500", got.Code)
	}
	if took := time.Since(began); took < 90*time.Millisecond || took > 2*time.Second {
		t.Errorf("waited %v for a slot; want about the context's 100 ms", took)
	}
	// A 304 needs no slot at all.
	etag := shiftedSubtitleETag(src, mustStat(t, src), 10)
	if got := serveShifted(t, src, 10, http.Header{"If-None-Match": {etag}}, context.Background()); got.Code != http.StatusNotModified {
		t.Errorf("a revalidation with every slot taken: HTTP %d, want 304", got.Code)
	}

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- serveShifted(t, src, 10, http.Header{}, context.Background()) }()
	select {
	case <-done:
		t.Fatal("a request got a rewrite slot while all were taken")
	case <-time.After(100 * time.Millisecond):
	}
	release()
	select {
	case got := <-done:
		if got.Code != http.StatusOK || !strings.Contains(got.Body.String(), "00:00:15.000 --> 00:00:17.000") {
			t.Errorf("after a slot freed: HTTP %d\n%s", got.Code, got.Body.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a waiting request never got the freed slot")
	}
}

// The ETag names the exact shift of one source: the full path (two tracks
// with one file name in different folders), and the shift unrounded.
func TestShiftedSubtitleETagNamesTheExactShiftOfOneSource(t *testing.T) {
	a := writeTempVTT(t, t.TempDir(), "same.vtt", memoryShiftFixture)
	b := writeTempVTT(t, t.TempDir(), "same.vtt", memoryShiftFixture)
	when := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	for _, p := range []string{a, b} {
		if err := os.Chtimes(p, when, when); err != nil {
			t.Fatal(err)
		}
	}
	ia, ib := mustStat(t, a), mustStat(t, b)
	if shiftedSubtitleETag(a, ia, 10) == shiftedSubtitleETag(b, ib, 10) {
		t.Error("two sources with one name, size and mtime share an ETag")
	}
	if shiftedSubtitleETag(a, ia, 10.0001) == shiftedSubtitleETag(a, ia, 10.0002) {
		t.Error("shifts 0.1 ms apart share an ETag")
	}
	if shiftedSubtitleETag(a, ia, 10) != shiftedSubtitleETag(a, ia, 10) {
		t.Error("the same shift of the same source changed its ETag")
	}
}

// BenchmarkShiftedVTT is the per-request cost MaxInMemoryShiftSourceBytes
// documents: an in-memory shift of a source at the cap.
//
//	go test ./internal/streaming/ -run XXX -bench BenchmarkShiftedVTT -benchtime 5x
func BenchmarkShiftedVTT(b *testing.B) {
	var sb strings.Builder
	sb.WriteString("WEBVTT\n\n")
	for i := 0; sb.Len() < MaxInMemoryShiftSourceBytes; i++ {
		s := float64(i) * 2.5
		fmt.Fprintf(&sb, "%d\n%s --> %s align:start\nLine number %d of the subtitle text, long enough to look real.\nSecond line %d.\n\n",
			i, formatVTTTimestamp(s), formatVTTTimestamp(s+2), i, i)
	}
	p := filepath.Join(b.TempDir(), "bench.vtt")
	if err := os.WriteFile(p, []byte(sb.String()), 0o644); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, err := ShiftedVTT(p, 61.25); err != nil {
			b.Fatal(err)
		}
	}
}
