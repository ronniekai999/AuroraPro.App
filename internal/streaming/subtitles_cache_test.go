// Regression tests for subtitle cache freshness.
//
// A derived cache file is always written AFTER its source is read, so a
// valid cache has mtime >= source mtime. The three cache checks in
// subtitles.go once required the output to be STRICTLY newer, which made
// a same-tick write look stale: such an entry was rebuilt on the next
// request rather than reused, and TestShiftVTTCuesCachesResult failed
// intermittently in CI whenever the runner was fast enough — or the
// filesystem's mtime granularity coarse enough — for source and output
// to land on one timestamp.
//
// These tests force that tie with os.Chtimes rather than racing the
// clock, and detect an unwanted rebuild by sentinel CONTENT rather than
// by mtime: a rebuild landing in the same tick leaves the mtime
// unchanged, which is the very ambiguity under test.
//
// Each site is covered in BOTH directions. The tie cases alone would be
// direction-blind — cacheIsFresh takes two same-typed os.FileInfo
// parameters, so a swapped call compiles silently, and under a tie both
// orderings answer "fresh". The paired source-is-newer cases pin that a
// genuinely stale entry is still rebuilt, which is what makes a swapped
// or deleted guard fail here rather than in production.
package streaming

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// cacheSentinel is written over a cached file so that a rebuild is
// visible in the content. It is deliberately non-empty: cacheIsFresh
// rejects zero-length output.
const cacheSentinel = "WEBVTT\n\nNOTE sentinel written by the test to detect a cache rebuild\n"

func setMTime(t *testing.T, path string, mt time.Time) {
	t.Helper()
	if err := os.Chtimes(path, mt, mt); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
}

// mtimeBase is a fixed instant in the past, truncated to a whole second
// so no filesystem's granularity can round these stamps back into an
// ordering the test did not ask for.
func mtimeBase() time.Time {
	return time.Now().Add(-time.Hour).Truncate(time.Second)
}

// tieMTimes stamps every path with one identical mtime, reproducing the
// coarse-granularity case deterministically.
func tieMTimes(t *testing.T, paths ...string) {
	t.Helper()
	base := mtimeBase()
	for _, p := range paths {
		setMTime(t, p, base)
	}
}

// staleMTimes makes the source strictly newer than the cache — the one
// ordering that must invalidate. Only a correctly oriented check rejects
// the entry, so this is what catches a swapped or missing guard.
func staleMTimes(t *testing.T, outPath, srcPath string) {
	t.Helper()
	base := mtimeBase()
	setMTime(t, outPath, base)
	setMTime(t, srcPath, base.Add(2*time.Second))
}

func seedSentinel(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(cacheSentinel), 0o644); err != nil {
		t.Fatalf("seed sentinel: %v", err)
	}
}

// assertCacheReused fails when the cached file no longer holds the
// sentinel, i.e. the call rebuilt it.
func assertCacheReused(t *testing.T, path string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read cached file: %v", err)
	}
	if string(got) != cacheSentinel {
		t.Errorf("cache whose mtime equals the source's was rebuilt; a tie means current, not stale.\ncontent now:\n%s", got)
	}
}

// assertCacheRebuilt fails when the sentinel survived, i.e. a cache
// older than its source was served as if it were fresh.
func assertCacheRebuilt(t *testing.T, path string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		return // rebuilt away entirely — also a rebuild
	}
	if string(got) == cacheSentinel {
		t.Errorf("cache older than its source was served as fresh; it must be rebuilt")
	}
}

// --- ShiftVTTCues (subtitles.go cache hit) ---

func TestShiftVTTCuesCacheHitOnEqualMTime(t *testing.T) {
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nhi\n")

	first, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	seedSentinel(t, first)
	tieMTimes(t, src, first)

	second, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if second != first {
		t.Fatalf("expected the same cached path, got %q want %q", second, first)
	}
	assertCacheReused(t, second)
}

func TestShiftVTTCuesRebuildsWhenSourceIsNewer(t *testing.T) {
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nhi\n")

	first, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	seedSentinel(t, first)
	staleMTimes(t, first, src)

	second, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	assertCacheRebuilt(t, second)
}

// --- ConvertSRTtoVTT ---

func TestConvertSRTtoVTTCacheHitOnEqualMTime(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")
	srtPath := writeTempSRT(t, dir, "test.srt")

	first, err := ConvertSRTtoVTT(srtPath, cacheDir)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	seedSentinel(t, first)
	tieMTimes(t, srtPath, first)

	second, err := ConvertSRTtoVTT(srtPath, cacheDir)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if second != first {
		t.Fatalf("expected the same cached path, got %q want %q", second, first)
	}
	assertCacheReused(t, second)
}

func TestConvertSRTtoVTTRebuildsWhenSourceIsNewer(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")
	srtPath := writeTempSRT(t, dir, "test.srt")

	first, err := ConvertSRTtoVTT(srtPath, cacheDir)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	seedSentinel(t, first)
	staleMTimes(t, first, srtPath)

	second, err := ConvertSRTtoVTT(srtPath, cacheDir)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	assertCacheRebuilt(t, second)
}

// TestConvertSRTtoVTTRebuildsZeroLengthCache pins the non-empty half of
// the freshness check at this site specifically. ConvertSRTtoVTT was the
// one site without that guard: a conversion killed mid-write leaves a
// 0-byte file, which used to be served forever as an empty subtitle
// track. The cache mtime here is NEWER than the source, so the mtime
// comparison alone would accept it and only the size guard can reject.
//
// The 0-byte file is made by truncating the entry the function itself
// returned, not by seeding a path computed here. A hand-mirrored path
// would stop matching if the cache naming ever changed, and this test
// would then pass vacuously against a file production never reads.
func TestConvertSRTtoVTTRebuildsZeroLengthCache(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")
	srtPath := writeTempSRT(t, dir, "test.srt")

	vttPath, err := ConvertSRTtoVTT(srtPath, cacheDir)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	if err := os.Truncate(vttPath, 0); err != nil {
		t.Fatalf("truncate cache entry: %v", err)
	}
	base := mtimeBase()
	setMTime(t, srtPath, base)
	setMTime(t, vttPath, base.Add(2*time.Second))

	got, err := ConvertSRTtoVTT(srtPath, cacheDir)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if got != vttPath {
		t.Fatalf("expected the same cached path, got %q want %q", got, vttPath)
	}
	data, err := os.ReadFile(got)
	if err != nil {
		t.Fatalf("read converted: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("a 0-byte cache entry was served; a truncated write is not a cache entry")
	}
	if !strings.HasPrefix(string(data), "WEBVTT") {
		t.Errorf("rebuilt file is not a VTT; got:\n%s", data)
	}
}

// --- ConvertSubtitleToVTT ---

// The ffmpeg-backed converter is covered by seeding the cache entry
// directly rather than calling the function twice, because a miss shells
// out to ffmpeg, which is not installed everywhere the suite runs. That
// makes a miss unmistakable in either environment: without ffmpeg it
// surfaces as an error, and with ffmpeg it overwrites the sentinel. The
// cache path is computed the same way ConvertSubtitleToVTT computes it,
// so a change to that naming scheme fails these tests loudly rather than
// quietly turning them into no-ops.

func TestConvertSubtitleToVTTCacheHitOnEqualMTime(t *testing.T) {
	dir := t.TempDir()
	cacheDir := mkCacheDir(t, dir)
	subPath := writeTempASS(t, dir, "test.ass")

	vttPath := subCachePath(subPath, cacheDir)
	seedSentinel(t, vttPath)
	tieMTimes(t, subPath, vttPath)

	got, err := ConvertSubtitleToVTT(context.Background(), subPath, cacheDir)
	if err != nil {
		t.Fatalf("cache whose mtime equals the source's was treated as stale, so the call fell through to ffmpeg: %v", err)
	}
	if got != vttPath {
		t.Fatalf("expected the seeded cache path, got %q want %q", got, vttPath)
	}
	assertCacheReused(t, got)
}

func TestConvertSubtitleToVTTRebuildsWhenSourceIsNewer(t *testing.T) {
	dir := t.TempDir()
	cacheDir := mkCacheDir(t, dir)
	subPath := writeTempASS(t, dir, "test.ass")

	vttPath := subCachePath(subPath, cacheDir)
	seedSentinel(t, vttPath)
	staleMTimes(t, vttPath, subPath)

	// A rebuild here means reaching ffmpeg. Where ffmpeg is absent that
	// surfaces as an error, which is itself proof the stale entry was
	// rejected; where it is present the sentinel is overwritten. Serving
	// the sentinel back intact is the only failing outcome — so the
	// error path still asserts the sentinel is gone rather than passing
	// on any error at all.
	got, err := ConvertSubtitleToVTT(context.Background(), subPath, cacheDir)
	if err != nil {
		assertCacheRebuilt(t, vttPath)
		return
	}
	assertCacheRebuilt(t, got)
}

// --- the helper itself ---

func TestCacheIsFresh(t *testing.T) {
	dir := t.TempDir()
	base := mtimeBase()

	mk := func(name, body string, mt time.Time) os.FileInfo {
		t.Helper()
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		setMTime(t, p, mt)
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatalf("stat %s: %v", name, err)
		}
		return fi
	}

	srcInfo := mk("src", "source", base)

	tests := []struct {
		name    string
		outInfo os.FileInfo
		want    bool
	}{
		{"equal mtime is fresh", mk("equal", "out", base), true},
		{"newer output is fresh", mk("newer", "out", base.Add(time.Second)), true},
		{"older output is stale", mk("older", "out", base.Add(-time.Second)), false},
		{"empty output is never fresh", mk("empty", "", base.Add(time.Second)), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cacheIsFresh(tt.outInfo, srcInfo); got != tt.want {
				t.Errorf("cacheIsFresh() = %v, want %v", got, tt.want)
			}
		})
	}
}

// --- fixtures ---

func mkCacheDir(t *testing.T, dir string) string {
	t.Helper()
	cacheDir := filepath.Join(dir, "cache")
	if err := os.MkdirAll(cacheDir, 0o750); err != nil {
		t.Fatalf("mkdir cache: %v", err)
	}
	return cacheDir
}

func writeTempSRT(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("1\n00:00:01,000 --> 00:00:02,000\nHello\n"), 0o644); err != nil {
		t.Fatalf("write srt: %v", err)
	}
	return p
}

func writeTempASS(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("[Script Info]\nScriptType: v4.00+\n"), 0o644); err != nil {
		t.Fatalf("write ass: %v", err)
	}
	return p
}

// subCachePath mirrors the cache naming in ConvertSubtitleToVTT so the
// entry can be seeded without running ffmpeg. It does not go stale
// silently: TestConvertSubtitleToVTTCacheHitOnEqualMTime asserts the
// function returns exactly this path, so a change to the naming scheme
// fails there loudly rather than leaving these tests vacuous.
func subCachePath(subPath, cacheDir string) string {
	h := sha256.Sum256([]byte(subPath))
	stem := strings.TrimSuffix(filepath.Base(subPath), filepath.Ext(subPath))
	return filepath.Join(cacheDir, fmt.Sprintf("%s_%x.vtt", stem, h[:6]))
}
