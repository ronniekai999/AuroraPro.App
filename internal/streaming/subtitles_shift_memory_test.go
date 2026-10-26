package streaming

// ServeShiftedSubtitle: the subtitle endpoint's in-memory shift for a
// client-chosen offset (media_start=). Same rewrite as the cached
// ShiftVTTCues, nothing written to disk, served with what ServeSubtitle sends
// for a cached file. A revalidation builds nothing; anything else is charged
// against a byte budget until it has been sent, built a few at a time, for
// sources up to MaxInMemoryShiftSourceBytes; and whatever stops it is
// reported before anything is written.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const memoryShiftFixture = "WEBVTT\n\nSTYLE\n::cue {\n  color: yellow;\n}\n\nNOTE kept\nverbatim\n\n" +
	"1\n00:00:05.000 --> 00:00:08.000\ngone: wholly before the shift\n\n" +
	"cue-2\n00:00:09.000 --> 00:00:12.000 align:start\nstraddles zero\n\n" +
	"00:00:25.000 --> 00:00:27.000\nTwenty-five\n\n\n" +
	"timing only\n00:00:40.000 --> 00:00:41.000\n\n" +
	"00:01:00.500 --> 00:01:02.250line:0\nlater\n"

// shiftFileInMemory is ServeShiftedSubtitle's build of path, without the
// response: what it reads, and the body it would send. It fails the test if
// the body outgrew the buffer it is built in, InMemoryShiftBodyBound of its
// source, the charge the budget took for it.
func shiftFileInMemory(t testing.TB, path string, offset float64) []byte {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	body, err := shiftVTTInMemory(f, info.Size(), offset)
	if err != nil {
		t.Fatalf("in-memory shift of %s: %v", path, err)
	}
	bound := InMemoryShiftBodyBound(info.Size())
	// The allocator rounds a request up (to a size class, or a page past
	// 32 KB); a buffer that grew past the bound doubles instead.
	if int64(len(body)) > bound || int64(cap(body)) > bound+8192 {
		t.Fatalf("%s (%d bytes): body %d bytes in a %d-byte buffer; the charge was %d",
			path, info.Size(), len(body), cap(body), bound)
	}
	return body
}

func TestShiftVTTInMemoryMatchesTheCachedShiftAndWritesNothing(t *testing.T) {
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
		if got := shiftFileInMemory(t, src, offset); string(got) != string(want) {
			t.Errorf("offset %v: in-memory shift differs from the cached one\n got:\n%s\nwant:\n%s", offset, got, want)
		}
		if got, _, _, err := serveShifted(src, offset, http.Header{}, context.Background()); err != nil || got.Body.String() != string(want) {
			t.Errorf("offset %v: served %q, %v; want the cached shift", offset, got.Body.String(), err)
		}
	}
	if entries, _ := os.ReadDir(srcDir); len(entries) != 1 {
		t.Errorf("the in-memory shift wrote beside its source: %v", entries)
	}
}

// serveShifted runs ServeShiftedSubtitle for src.
func serveShifted(src string, offset float64, h http.Header, ctx context.Context) (rr *httptest.ResponseRecorder, revalidated bool, built int64, err error) {
	rr = httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/sub", nil).WithContext(ctx)
	r.Header = h
	revalidated, built, err = ServeShiftedSubtitle(rr, r, src, offset)
	return rr, revalidated, built, err
}

// wroteNothing reports whether ServeShiftedSubtitle left rr untouched,
// headers included, so the endpoint can still serve something else (a stray
// ETag would name the in-memory shift on the fallback's body).
func wroteNothing(rr *httptest.ResponseRecorder) bool {
	return len(rr.Header()) == 0 && rr.Body.Len() == 0 && rr.Code == http.StatusOK && !rr.Flushed
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
	file := serveFile(http.Header{})
	mem, _, _, err := serveShifted(src, 10, http.Header{}, ctx)
	if err != nil || file.Code != http.StatusOK || mem.Code != http.StatusOK {
		t.Fatalf("HTTP file %d, memory %d (%v)", file.Code, mem.Code, err)
	}
	if mem.Body.String() != file.Body.String() {
		t.Errorf("bodies differ:\n%s\nvs\n%s", mem.Body.String(), file.Body.String())
	}
	for _, name := range []string{"Content-Type", "Cache-Control", "Accept-Ranges", "Content-Length"} {
		if got, want := mem.Header().Get(name), file.Header().Get(name); got != want || want == "" {
			t.Errorf("%s: in-memory %q, file %q", name, got, want)
		}
	}
	srcInfo := mustStat(t, src)
	if got := mem.Header().Get("Last-Modified"); got != srcInfo.ModTime().UTC().Format(http.TimeFormat) {
		t.Errorf("Last-Modified %q, want the source's %q", got, srcInfo.ModTime().UTC().Format(http.TimeFormat))
	}
	if etag := mem.Header().Get("ETag"); !strings.HasPrefix(etag, `"`) || etag != shiftedSubtitleETag(src, srcInfo, 10) {
		t.Errorf("ETag %q, want shiftedSubtitleETag's", etag)
	}
	if got, _, _, _ := serveShifted(src, 10, http.Header{"Range": {"bytes=0-5"}}, ctx); got.Code != http.StatusPartialContent || got.Body.String() != "WEBVTT" {
		t.Errorf("Range: HTTP %d %q, want 206 \"WEBVTT\" as the file path gives", got.Code, got.Body.String())
	}
}

// useShiftBudget swaps in a budget of limit bytes for the test.
func useShiftBudget(t *testing.T, limit int64) *shiftBudget {
	t.Helper()
	saved := inMemoryShiftBudget
	b := &shiftBudget{limit: limit}
	inMemoryShiftBudget = b
	t.Cleanup(func() { inMemoryShiftBudget = saved })
	return b
}

// A revalidation pays for nothing: no rewrite and no budget, so it is
// answered even with the budget full (here, one that takes nothing).
func TestServeShiftedSubtitleRevalidatesWithoutRewriting(t *testing.T) {
	ctx := context.Background()
	src := writeTempVTT(t, t.TempDir(), "in.vtt", memoryShiftFixture)
	first, _, _, err := serveShifted(src, 10, http.Header{}, ctx)
	if err != nil {
		t.Fatal(err)
	}
	etag, lastModified := first.Header().Get("ETag"), first.Header().Get("Last-Modified")
	useShiftBudget(t, 0)
	builds := inMemoryShiftBuilds.Load()
	for _, tc := range []struct {
		name string
		h    http.Header
		code int
	}{
		{"If-None-Match", http.Header{"If-None-Match": {etag}}, http.StatusNotModified},
		{"If-None-Match, weak and in a list", http.Header{"If-None-Match": {`"other", W/` + etag}}, http.StatusNotModified},
		{"If-Modified-Since", http.Header{"If-Modified-Since": {lastModified}}, http.StatusNotModified},
		{"a failed If-Match", http.Header{"If-Match": {`"other"`}}, http.StatusPreconditionFailed},
	} {
		got, revalidated, built, err := serveShifted(src, 10, tc.h, ctx)
		if err != nil || got.Code != tc.code || got.Body.Len() != 0 || !revalidated || built != 0 {
			t.Errorf("%s: HTTP %d with %d bytes, revalidated=%v built=%d, %v; want %d, nothing built",
				tc.name, got.Code, got.Body.Len(), revalidated, built, err, tc.code)
		}
		if tc.code == http.StatusNotModified && got.Header().Get("ETag") != etag {
			t.Errorf("%s: the 304 carries ETag %q, want %q", tc.name, got.Header().Get("ETag"), etag)
		}
	}
	if n := inMemoryShiftBuilds.Load() - builds; n != 0 {
		t.Errorf("the revalidations started %d rewrites, want none", n)
	}
	// The control: one that needs the body needs the budget.
	got, revalidated, _, err := serveShifted(src, 10, http.Header{"If-None-Match": {`"another"`}}, ctx)
	if !errors.Is(err, ErrShiftBudgetFull) || revalidated || !wroteNothing(got) {
		t.Errorf("control: a request that needs the body, budget full: %v, revalidated=%v, HTTP %d %v; want ErrShiftBudgetFull, nothing written",
			err, revalidated, got.Code, got.Header())
	}
}

// What ServeShiftedSubtitle reports, for the endpoint's log line, and that it
// writes nothing when it fails.
func TestServeShiftedSubtitleReportsWhatItServed(t *testing.T) {
	src := writeTempVTT(t, t.TempDir(), "in.vtt", memoryShiftFixture)
	ctx := context.Background()
	if rr, revalidated, n, err := serveShifted(src, 10, http.Header{}, ctx); err != nil || revalidated || n != int64(rr.Body.Len()) || n == 0 {
		t.Errorf("a served shift reported %d bytes, revalidated=%v, %v; the body was %d bytes", n, revalidated, err, rr.Body.Len())
	}
	if err := os.Remove(src); err != nil {
		t.Fatal(err)
	}
	if rr, _, n, err := serveShifted(src, 10, http.Header{}, ctx); err == nil || n != 0 || !wroteNothing(rr) {
		t.Errorf("a missing source reported %d bytes, %v (HTTP %d %v); want an error, nothing written", n, err, rr.Code, rr.Header())
	}
}

// The read takes what the stat said and no more: a source that grew after
// it is refused, having read at most one byte past it, so the one allocation
// sized from the stat is all the read takes.
func TestReadVTTSourceStopsAtItsStat(t *testing.T) {
	const size = 1000
	counted := &countingReader{r: strings.NewReader(strings.Repeat("x", 5*size))}
	if _, err := readVTTSource(counted, size, true); !errors.Is(err, errShiftSourceGrew) {
		t.Errorf("5x its stat: %v, want errShiftSourceGrew", err)
	}
	if counted.n > size+1 {
		t.Errorf("read %d bytes of a source that grew; at most %d", counted.n, size+1)
	}
	if got, err := readVTTSource(strings.NewReader(strings.Repeat("x", size)), size, true); err != nil || len(got) != size {
		t.Errorf("exactly its stat: %d bytes, %v", len(got), err)
	}
	if got, err := readVTTSource(strings.NewReader(strings.Repeat("x", size/2)), size, true); err != nil || len(got) != size/2 {
		t.Errorf("shorter than its stat: %d bytes, %v", len(got), err)
	}
	if got, err := readVTTSource(strings.NewReader(strings.Repeat("x", 5*size)), 0, false); err != nil || len(got) != 5*size {
		t.Errorf("not exact (the cached path): %d bytes, %v", len(got), err)
	}
}

type countingReader struct {
	r io.Reader
	n int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	return n, err
}

func TestServeShiftedSubtitleCapsTheSource(t *testing.T) {
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
		rr, _, built, err := serveShifted(p, 10, http.Header{}, context.Background())
		if !errors.Is(err, tc.want) {
			t.Errorf("a %d-byte source: %v, want %v", tc.size, err, tc.want)
		}
		if tc.want != nil && !wroteNothing(rr) {
			t.Errorf("a %d-byte source, refused: HTTP %d %v; want nothing written", tc.size, rr.Code, rr.Header())
		}
		if tc.want == nil && (rr.Code != http.StatusOK || built < tc.size) {
			t.Errorf("a %d-byte source at the cap: HTTP %d, %d bytes built", tc.size, rr.Code, built)
		}
	}
}

// Rewrites take a slot; a request waits for one only as long as its own
// context lasts, and gets one once a slot frees.
func TestServeShiftedSubtitleWaitsForARewriteSlot(t *testing.T) {
	src := writeTempVTT(t, t.TempDir(), "in.vtt", memoryShiftFixture)
	budget := useShiftBudget(t, InMemoryShiftBudgetBytes)
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
	if got, _, _, err := serveShifted(src, 10, http.Header{}, ctx); !errors.Is(err, context.DeadlineExceeded) || !wroteNothing(got) {
		t.Errorf("no free slot, context ended: %v, HTTP %d %v; want its error, nothing written", err, got.Code, got.Header())
	}
	if took := time.Since(began); took < 90*time.Millisecond || took > 2*time.Second {
		t.Errorf("waited %v for a slot; want about the context's 100 ms", took)
	}
	if held := budget.inUse(); held != 0 {
		t.Errorf("a request that gave up waiting still holds %d bytes of the budget", held)
	}
	// A 304 needs no slot at all: it answers at once, well inside a context
	// that a slot wait would run out.
	etag := shiftedSubtitleETag(src, mustStat(t, src), 10)
	revalidate, cancelRevalidate := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelRevalidate()
	began = time.Now()
	if got, _, _, _ := serveShifted(src, 10, http.Header{"If-None-Match": {etag}}, revalidate); got.Code != http.StatusNotModified {
		t.Errorf("a revalidation with every slot taken: HTTP %d, want 304", got.Code)
	}
	if took := time.Since(began); took > 500*time.Millisecond {
		t.Errorf("a revalidation with every slot taken took %v: it waited for a slot", took)
	}

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rr, _, _, _ := serveShifted(src, 10, http.Header{}, context.Background())
		done <- rr
	}()
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

// stalledResponse is a client that reads nothing until told to: its first
// Write blocks until read is closed. It records the write deadline set on it.
type stalledResponse struct {
	header   http.Header
	sending  chan<- *stalledResponse // told once, at the first Write
	read     <-chan struct{}
	once     sync.Once
	deadline time.Time
}

func (s *stalledResponse) Header() http.Header { return s.header }
func (s *stalledResponse) WriteHeader(int)     {}
func (s *stalledResponse) Write(p []byte) (int, error) {
	s.once.Do(func() { s.sending <- s })
	<-s.read
	return len(p), nil
}
func (s *stalledResponse) SetWriteDeadline(d time.Time) error {
	s.deadline = d
	return nil
}

// The budget holds each body's charge from before it is built until its
// response has been sent: responses nobody reads fill it, the next request is
// refused at once with nothing written (the endpoint then uses the
// prediction), a revalidation is still answered, and each charge comes back
// when its response is done.
func TestServeShiftedSubtitleChargesTheBudgetUntilSent(t *testing.T) {
	src := writeTempVTT(t, t.TempDir(), "in.vtt", memoryShiftFixture)
	charge := InMemoryShiftBodyBound(int64(len(memoryShiftFixture)))
	budget := useShiftBudget(t, 2*charge+charge/2) // room for two
	sending := make(chan *stalledResponse, 2)
	reads := []chan struct{}{make(chan struct{}), make(chan struct{})}
	var once [2]sync.Once
	letRead := func(i int) { once[i].Do(func() { close(reads[i]) }) }
	var wg sync.WaitGroup
	t.Cleanup(func() { letRead(0); letRead(1); wg.Wait() })
	finished := make([]chan struct{}, 2)
	sentAt := time.Now()
	for i := range reads {
		finished[i] = make(chan struct{})
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer close(finished[i])
			w := &stalledResponse{header: http.Header{}, sending: sending, read: reads[i]}
			ServeShiftedSubtitle(w, httptest.NewRequest(http.MethodGet, "/sub", nil), src, 10)
		}(i)
	}
	for range reads {
		select {
		case w := <-sending:
			// Sent under the endpoint's ordinary two minutes, not whatever
			// the request had before.
			if want := sentAt.Add(inMemoryShiftSendTimeout); w.deadline.Before(want) || w.deadline.After(want.Add(5*time.Second)) {
				t.Errorf("a body is sent under the write deadline %v, want %v from the send", w.deadline, inMemoryShiftSendTimeout)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("a stalled response never began sending")
		}
	}
	if held := budget.inUse(); held != 2*charge {
		t.Fatalf("two unread responses hold %d bytes of the budget, want %d (two bodies' bound)", held, 2*charge)
	}

	builds := inMemoryShiftBuilds.Load()
	began := time.Now()
	got, _, _, err := serveShifted(src, 10, http.Header{}, context.Background())
	if !errors.Is(err, ErrShiftBudgetFull) || !wroteNothing(got) {
		t.Errorf("a third request, budget full: %v, HTTP %d %v; want ErrShiftBudgetFull, nothing written", err, got.Code, got.Header())
	}
	if took := time.Since(began); took > 500*time.Millisecond {
		t.Errorf("the refusal took %v: it waited", took)
	}
	if n := inMemoryShiftBuilds.Load() - builds; n != 0 {
		t.Errorf("the refused request started %d rewrites", n)
	}
	etag := shiftedSubtitleETag(src, mustStat(t, src), 10)
	if rr, _, _, err := serveShifted(src, 10, http.Header{"If-None-Match": {etag}}, context.Background()); err != nil || rr.Code != http.StatusNotModified {
		t.Errorf("a revalidation, budget full: HTTP %d, %v; want 304", rr.Code, err)
	}

	letRead(0)
	<-finished[0]
	if held := budget.inUse(); held != charge {
		t.Errorf("after one response was read the budget holds %d bytes, want %d", held, charge)
	}
	if rr, _, _, err := serveShifted(src, 10, http.Header{}, context.Background()); err != nil || rr.Code != http.StatusOK {
		t.Errorf("once a response was read: HTTP %d, %v; want the in-memory shift again", rr.Code, err)
	}
	letRead(1)
	<-finished[1]
	if held := budget.inUse(); held != 0 {
		t.Errorf("with every response read the budget holds %d bytes", held)
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

// growthShapes are the sources the rewrite grows most: its smallest cue
// blocks, whose timestamps it writes back at full width with spaces round
// the arrow and before settings. shortFormNoSpaces is a sidecar of timing
// lines alone written that way; smallestBlocks adds one-byte settings, the
// most the rewrite can grow a source (InMemoryShiftBodyBound), and has no
// final newline, so its last block gains two.
func shortFormNoSpaces(size int) string {
	var sb strings.Builder
	sb.WriteString("WEBVTT\n\n")
	for i := 0; sb.Len() < size; i++ {
		fmt.Fprintf(&sb, "%d:%02d.%03d-->%d:%02d.%03d\n\n", i/600%10, i/10%60, i%10*100, i/600%10, i/10%60, i%10*100+50)
	}
	return sb.String()
}

func smallestBlocks(size int) string {
	var sb strings.Builder
	sb.WriteString("WEBVTT\n\n")
	for sb.Len() < size {
		sb.WriteString("0:00.000-->9:59.999x\n\n")
	}
	return strings.TrimSuffix(sb.String(), "\n\n")
}

// The bound is what the budget charges and the buffer the body is built in,
// so no body may outgrow it (shiftFileInMemory checks each against it, here
// and for the oracle's inputs), and the shapes above come close to it.
func TestInMemoryShiftBodyBoundHoldsTheBody(t *testing.T) {
	for _, tc := range []struct {
		name     string
		src      string
		minRatio float64
	}{
		{"short-form, no spaces", shortFormNoSpaces(1 << 20), 1.4},
		{"smallest blocks", smallestBlocks(1 << 20), 1.49},
		{"a header with no newline", "WEBVTT", 1.3},
		{"empty", "", 0},
	} {
		p := writeTempVTT(t, t.TempDir(), "in.vtt", tc.src)
		body := shiftFileInMemory(t, p, 10)
		ratio := 1.0
		if len(tc.src) > 0 {
			ratio = float64(len(body)) / float64(len(tc.src))
		}
		t.Logf("%s: %d bytes from %d (%.3fx); the bound is %d", tc.name, len(body), len(tc.src), ratio, InMemoryShiftBodyBound(int64(len(tc.src))))
		if ratio < tc.minRatio {
			t.Errorf("%s grew %.3fx, want at least %.2fx: not the shape it claims", tc.name, ratio, tc.minRatio)
		}
	}
}

// BenchmarkShiftedVTT is the per-request cost MaxInMemoryShiftSourceBytes
// documents: an in-memory shift of a source just under the cap, read and
// rewritten, in four shapes (body/src is how much the rewrite grew it).
//
//	go test ./internal/streaming/ -run XXX -bench BenchmarkShiftedVTT -benchtime 5x
func BenchmarkShiftedVTT(b *testing.B) {
	const under = MaxInMemoryShiftSourceBytes - 1024 // the last cue must not cross the cap
	cues := func(cue func(i int, s float64) string) string {
		var sb strings.Builder
		sb.WriteString("WEBVTT\n\n")
		for i := 0; sb.Len() < under; i++ {
			sb.WriteString(cue(i, float64(i)*0.25))
		}
		return sb.String()
	}
	typical := cues(func(i int, s float64) string {
		return fmt.Sprintf("%d\n%s --> %s align:start\nLine number %d of the subtitle text, long enough to look real.\nSecond line %d.\n\n",
			i, formatVTTTimestamp(s*10), formatVTTTimestamp(s*10+2), i, i)
	})
	// FFmpeg's WebVTT for a karaoke ASS track: a cue per syllable.
	dense := cues(func(i int, s float64) string {
		return fmt.Sprintf("%s --> %s\n<c.k>ka</c>\n\n", formatVTTTimestamp(s), formatVTTTimestamp(s+0.25))
	})
	// One timing line as long as the cap allows, which the cue-line regex
	// walks to its end.
	longTiming := "WEBVTT\n\n00:01:00.000 --> 00:01:02.000 " + strings.Repeat("x", under) + "\ntext\n"
	for _, tc := range []struct{ name, body string }{
		{"typical", typical},
		{"dense one-line cues", dense},
		{"short-form, no spaces", shortFormNoSpaces(under)},
		{"one long timing line", longTiming},
	} {
		b.Run(tc.name, func(b *testing.B) {
			p := filepath.Join(b.TempDir(), "bench.vtt")
			if err := os.WriteFile(p, []byte(tc.body), 0o644); err != nil {
				b.Fatal(err)
			}
			b.SetBytes(int64(len(tc.body)))
			b.ReportAllocs()
			b.ResetTimer()
			var out []byte
			for i := 0; i < b.N; i++ {
				out = shiftFileInMemory(b, p, 61.25)
			}
			b.ReportMetric(float64(len(out))/float64(len(tc.body)), "body/src")
		})
	}
}
