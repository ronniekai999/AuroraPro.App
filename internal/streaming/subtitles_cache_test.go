// Tests for subtitle cache invalidation.
//
// Every cache in subtitles.go derives a .vtt from something on disk and must
// notice when that something changes. The sibling conversions (ShiftVTTCues,
// ConvertSRTtoVTT, ConvertSubtitleToVTT) compare mtimes through cacheIsFresh;
// ExtractSubtitleVTT puts a (size, mtime) fingerprint of the MEDIA file in its
// cache key instead, because an mtime comparison cannot see a replacement that
// preserves or restores an older timestamp (`rsync -a`, `cp -p`, a restore
// from backup) — see extractedVTTPath.
//
// Two conventions keep these deterministic:
//
//   - os.Chtimes, never a sleep. Real elapsed time makes the outcome depend on
//     the filesystem's mtime granularity (1s on ext3, 2s on FAT/SMB), which is
//     how cache tests turn flaky.
//   - Sentinel content. A cache hit is detected by planting a recognizable body
//     in the cached file and checking whether it survived the call, rather than
//     by comparing mtimes — which would depend on that same granularity, and
//     would not distinguish "reused" from "rewritten identically".
//
// The ExtractSubtitleVTT tests never reach ffmpeg on the hit path (the cache
// check returns first) and assert nothing that requires it on the miss path,
// so they run everywhere.
package streaming

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

const cacheSentinel = "WEBVTT\n\nNOTE sentinel-do-not-rebuild\n"

// writeSentinel plants recognizable content at path so a later call can be
// classified as reuse (sentinel survives) or rebuild (sentinel replaced).
func writeSentinel(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatalf("mkdir cache dir: %v", err)
	}
	if err := os.WriteFile(path, []byte(cacheSentinel), 0o644); err != nil {
		t.Fatalf("write sentinel: %v", err)
	}
}

// sentinelSurvived reports whether path still holds the sentinel body.
func sentinelSurvived(t *testing.T, path string) bool {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return string(b) == cacheSentinel
}

// setMtime pins a file's mtime exactly, so freshness comparisons are decided
// by the test rather than by wall-clock timing.
func setMtime(t *testing.T, path string, mt time.Time) {
	t.Helper()
	if err := os.Chtimes(path, mt, mt); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
}

func mustStat(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return info
}

// writeMedia creates a stand-in "media file". Its bytes are never decoded —
// only its size and mtime feed the fingerprint — so no ffmpeg is needed.
func writeMedia(t *testing.T, dir, name, body string, mt time.Time) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatalf("write media: %v", err)
	}
	setMtime(t, p, mt)
	return p
}

// ============================================================
// cacheIsFresh — the sibling caches' freshness predicate
// ============================================================

func TestCacheIsFresh(t *testing.T) {
	dir := t.TempDir()
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

	src := filepath.Join(dir, "src")
	if err := os.WriteFile(src, []byte("source"), 0o644); err != nil {
		t.Fatal(err)
	}
	setMtime(t, src, base)
	srcInfo := mustStat(t, src)

	tests := []struct {
		name  string
		body  string
		mtime time.Time
		want  bool
	}{
		{"newer than source", "cached", base.Add(time.Minute), true},
		// Equal mtimes must count as fresh. A conversion that finishes
		// inside the filesystem's mtime granularity records the same
		// timestamp as its source; under a strict After() it would be
		// rebuilt on every request forever.
		{"same mtime as source", "cached", base, true},
		{"older than source", "cached", base.Add(-time.Minute), false},
		// Non-empty guard: an extraction killed mid-write leaves a 0-byte
		// file that would otherwise be served as an empty subtitle track.
		{"empty but newer", "", base.Add(time.Minute), false},
		{"empty and same mtime", "", base, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			out := filepath.Join(dir, "out-"+tc.name)
			if err := os.WriteFile(out, []byte(tc.body), 0o644); err != nil {
				t.Fatal(err)
			}
			setMtime(t, out, tc.mtime)
			if got := cacheIsFresh(mustStat(t, out), srcInfo); got != tc.want {
				t.Errorf("cacheIsFresh() = %v, want %v", got, tc.want)
			}
		})
	}
}

// ============================================================
// ExtractSubtitleVTT — fingerprint-keyed invalidation
// ============================================================

func TestExtractSubtitleVTTServesCachedTrack(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")
	media := writeMedia(t, dir, "movie.mkv", "original-bytes", time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC))

	cached := extractedVTTPath(media, 2, cacheDir)
	writeSentinel(t, cached)

	got, err := ExtractSubtitleVTT(context.Background(), media, 2, cacheDir)
	if err != nil {
		t.Fatalf("ExtractSubtitleVTT() error: %v", err)
	}
	if got != cached {
		t.Errorf("returned %q, want the cached track %q", got, cached)
	}
	if !sentinelSurvived(t, cached) {
		t.Error("cached track was rebuilt even though the media file did not change")
	}
}

// TestExtractSubtitleVTTInvalidatesOnMediaChange is the regression this policy
// exists for: a media file replaced in place must retire its extracted track.
//
// The "older mtime" case is the one an mtime COMPARISON cannot catch — the
// cached .vtt is newer than the replacement, so cacheIsFresh would report it
// fresh and the wrong subtitles would be served indefinitely.
func TestExtractSubtitleVTTInvalidatesOnMediaChange(t *testing.T) {
	orig := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name    string
		replace func(t *testing.T, media string)
	}{
		{
			"newer mtime, same size",
			func(t *testing.T, media string) { setMtime(t, media, orig.Add(48*time.Hour)) },
		},
		{
			// rsync -a / cp -p / restore-from-backup: the replacement
			// carries the ORIGINAL file's older timestamp.
			"older mtime, same size",
			func(t *testing.T, media string) { setMtime(t, media, orig.Add(-48*time.Hour)) },
		},
		{
			// Same timestamp, different content: an mtime comparison in
			// either direction is blind to this.
			"same mtime, different size",
			func(t *testing.T, media string) {
				if err := os.WriteFile(media, []byte("a-much-longer-re-encoded-body"), 0o644); err != nil {
					t.Fatal(err)
				}
				setMtime(t, media, orig)
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			cacheDir := filepath.Join(dir, "cache")
			media := writeMedia(t, dir, "movie.mkv", "original-bytes", orig)

			stale := extractedVTTPath(media, 0, cacheDir)
			writeSentinel(t, stale)

			tc.replace(t, media)

			fresh := extractedVTTPath(media, 0, cacheDir)
			if fresh == stale {
				t.Fatalf("cache key did not change after the media file was replaced (%q)", stale)
			}

			// The extraction itself always fails here — without ffmpeg it
			// cannot exec, and with ffmpeg the fixture "media" is a text
			// string — so this asserts only what holds regardless: the
			// stale track is never the returned path (a failure returns
			// ""), and it is not overwritten in place.
			got, _ := ExtractSubtitleVTT(context.Background(), media, 0, cacheDir)
			if got == stale {
				t.Errorf("stale extracted track served after the media file changed: %q", got)
			}
			if !sentinelSurvived(t, stale) {
				t.Error("the superseded entry was overwritten; it should have been left for the cache reaper")
			}
		})
	}
}

func TestExtractSubtitleVTTKeyStableWhenMediaUnchanged(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")
	media := writeMedia(t, dir, "movie.mkv", "original-bytes", time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC))

	first := extractedVTTPath(media, 0, cacheDir)
	second := extractedVTTPath(media, 0, cacheDir)
	if first != second {
		t.Errorf("cache key churns across calls: %q vs %q", first, second)
	}
}

// A track's fingerprint must be part of the filename, not merely consulted:
// that is what makes a superseded entry unreachable rather than overwritten.
func TestExtractedVTTPathCarriesFingerprint(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")
	media := writeMedia(t, dir, "movie.mkv", "original-bytes", time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC))

	name := filepath.Base(extractedVTTPath(media, 3, cacheDir))
	fp, ok := mediaFingerprint(media)
	if !ok {
		t.Fatal("mediaFingerprint failed on a file that exists")
	}
	// <stem>_<pathhash>_sub<idx>_<fingerprint>.vtt. Matched as a suffix
	// rather than by splitting on "_": a realistic release name
	// ("Movie_2024_1080p") contains separators of its own, and a component
	// count would break on the fixture name alone.
	if want := "_sub3_" + fp + ".vtt"; !strings.HasSuffix(name, want) {
		t.Errorf("cache filename %q does not end in %q — the fingerprint must be part of the key", name, want)
	}
	if !strings.HasPrefix(name, "movie_") {
		t.Errorf("cache filename %q lost its human-readable stem", name)
	}
}

// Different tracks of the same file stay in separate entries — a re-key must
// retire the whole (path, index) family without merging tracks.
func TestExtractedVTTPathPerTrack(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")
	media := writeMedia(t, dir, "movie.mkv", "original-bytes", time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC))

	if a, b := extractedVTTPath(media, 0, cacheDir), extractedVTTPath(media, 1, cacheDir); a == b {
		t.Errorf("tracks 0 and 1 share a cache path: %q", a)
	}
}

// An unstattable media file falls back to the legacy fingerprint-less key
// rather than to a fabricated fingerprint. That key is the one pre-upgrade
// builds wrote, so it can still hit a stale entry — see extractedVTTPath for
// why that is accepted. What must hold here is the SHAPE: no fingerprint
// term, and the path hash still present.
func TestExtractedVTTPathFallsBackWhenMediaUnstattable(t *testing.T) {
	cacheDir := t.TempDir()
	missing := filepath.Join(t.TempDir(), "gone.mkv")

	name := filepath.Base(extractedVTTPath(missing, 1, cacheDir))
	// Matched by prefix/suffix rather than by splitting on "_" (a realistic
	// release name carries its own separators), but the path hash between
	// them is pinned too: without it, every same-basename file in a
	// different directory collapses onto one cache entry — the collision
	// the hash exists to prevent.
	const prefix, suffix = "gone_", "_sub1.vtt"
	if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) {
		t.Fatalf("cache filename %q is not the legacy stem_pathhash_subN key", name)
	}
	hash := strings.TrimSuffix(strings.TrimPrefix(name, prefix), suffix)
	if len(hash) != 12 {
		t.Errorf("path-hash component of %q is %q (%d chars), want 12 hex", name, hash, len(hash))
	}
	if strings.Trim(hash, "0123456789abcdef") != "" {
		t.Errorf("path-hash component of %q is not lowercase hex: %q", name, hash)
	}
}

// The fingerprint lengthened the cache filename, and ShiftVTTCues derives its
// own filename from this one. A long release name must not push either past
// NAME_MAX (255 bytes), where os.Create fails with ENAMETOOLONG and subtitles
// break for exactly the files with the longest names.
func TestExtractedVTTPathBoundsFilenameLength(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")

	// 224 chars: comfortably legal as a filename on ext4/XFS/tmpfs (NAME_MAX
	// 255), but long enough that the unbounded stem plus both suffixes would
	// overrun it.
	long := strings.Repeat("Some.Very.Long.Release.Name.", 8) // 224 chars
	media := writeMedia(t, dir, long+".mkv", "bytes", time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC))

	extracted := extractedVTTPath(media, 0, cacheDir)
	if n := len(filepath.Base(extracted)); n > 255 {
		t.Errorf("extracted cache filename is %d bytes, over NAME_MAX", n)
	}

	// The shifted name is the one that actually has to be created on disk.
	shifted, err := shiftedNameProbe(t, cacheDir, extracted)
	if err != nil {
		t.Fatalf("derive shifted name: %v", err)
	}
	if n := len(shifted); n > 255 {
		t.Errorf("shifted cache filename is %d bytes, over NAME_MAX", n)
	}
}

// shiftedNameProbe runs a real shift over a stand-in VTT placed at the
// extracted track's path and returns the resulting filename, so the length
// bound is asserted against what ShiftVTTCues actually creates rather than a
// re-implementation of its naming.
func shiftedNameProbe(t *testing.T, cacheDir, extractedPath string) (string, error) {
	t.Helper()
	writeSentinelVTT := "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nhi\n"
	if err := os.MkdirAll(cacheDir, 0o750); err != nil {
		return "", err
	}
	if err := os.WriteFile(extractedPath, []byte(writeSentinelVTT), 0o644); err != nil {
		return "", err
	}
	out, err := ShiftVTTCues(extractedPath, 5, cacheDir)
	if err != nil {
		return "", err
	}
	return filepath.Base(out), nil
}

func TestCacheStem(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"short stem passes through", "Movie.2024", "Movie.2024"},
		{"exactly at the bound", strings.Repeat("a", cacheStemMax), strings.Repeat("a", cacheStemMax)},
		{"over the bound is truncated", strings.Repeat("a", cacheStemMax+50), strings.Repeat("a", cacheStemMax)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := cacheStem(tc.in); got != tc.want {
				t.Errorf("cacheStem() = %q (%d bytes), want %d bytes", got, len(got), len(tc.want))
			}
		})
	}

	// A truncation must never split a rune: "日" is 3 bytes, so a cut at
	// cacheStemMax lands mid-rune and must back up to the boundary.
	multibyte := strings.Repeat("日", cacheStemMax) // 3*cacheStemMax bytes
	got := cacheStem(multibyte)
	if len(got) > cacheStemMax {
		t.Errorf("cacheStem() returned %d bytes, over the %d bound", len(got), cacheStemMax)
	}
	if !utf8.ValidString(got) {
		t.Errorf("cacheStem() split a UTF-8 rune: %q", got)
	}
}

// A 0-byte cached track (extraction killed mid-write) must not be served.
func TestExtractSubtitleVTTIgnoresEmptyCachedTrack(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")
	media := writeMedia(t, dir, "movie.mkv", "original-bytes", time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC))

	cached := extractedVTTPath(media, 0, cacheDir)
	if err := os.MkdirAll(cacheDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cached, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := ExtractSubtitleVTT(context.Background(), media, 0, cacheDir)
	if err == nil {
		if info := mustStat(t, got); info.Size() == 0 {
			t.Error("served a 0-byte cached track instead of re-extracting")
		}
		return
	}
	// Re-extraction was attempted and failed (no ffmpeg here). The truncated
	// entry must have been cleaned up rather than left to be served by the
	// next request.
	if info, sErr := os.Stat(cached); sErr == nil && info.Size() == 0 {
		t.Error("0-byte cache entry left in place after a failed re-extraction")
	}
}

// ============================================================
// Sibling caches — mtime-comparison freshness
// ============================================================

func TestShiftVTTCuesReusesCacheAtEqualMtime(t *testing.T) {
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nhi\n")

	out, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}

	// Pin source and output to the SAME instant, as a filesystem with
	// coarse mtime granularity would. Under a strict After() this entry
	// would be rebuilt on every request forever.
	writeSentinel(t, out)
	same := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	setMtime(t, src, same)
	setMtime(t, out, same)

	again, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if again != out {
		t.Fatalf("cached path changed: %q vs %q", out, again)
	}
	if !sentinelSurvived(t, out) {
		t.Error("shifted VTT was rebuilt at equal mtimes")
	}
}

func TestShiftVTTCuesRebuildsWhenSourceIsNewer(t *testing.T) {
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nhi\n")

	out, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}

	writeSentinel(t, out)
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	setMtime(t, out, base)
	setMtime(t, src, base.Add(time.Hour))

	again, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if sentinelSurvived(t, again) {
		t.Fatal("stale shifted VTT served after the source changed")
	}
	body, err := os.ReadFile(again)
	if err != nil {
		t.Fatalf("read rebuilt vtt: %v", err)
	}
	if !strings.Contains(string(body), "00:00:05.000 --> 00:00:07.000") {
		t.Errorf("rebuilt VTT missing the shifted cue:\n%s", body)
	}
}

func TestShiftVTTCuesRebuildsEmptyCacheFile(t *testing.T) {
	dir := t.TempDir()
	src := writeTempVTT(t, dir, "in.vtt", "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nhi\n")

	out, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}

	// A shift killed mid-write leaves a 0-byte file NEWER than its source.
	if err := os.WriteFile(out, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	setMtime(t, src, base)
	setMtime(t, out, base.Add(time.Hour))

	again, err := ShiftVTTCues(src, 5, dir)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if info := mustStat(t, again); info.Size() == 0 {
		t.Error("served a 0-byte shifted VTT instead of rebuilding it")
	}
}

func TestConvertSRTtoVTTRebuildsWhenSourceIsNewer(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")
	srt := filepath.Join(dir, "test.srt")
	if err := os.WriteFile(srt, []byte("1\n00:00:01,000 --> 00:00:02,000\nHello\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	out, err := ConvertSRTtoVTT(srt, cacheDir)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}

	// The sidecar is corrected in place; the cached VTT must not survive it.
	writeSentinel(t, out)
	if err := os.WriteFile(srt, []byte("1\n00:00:01,000 --> 00:00:02,000\nCorrected\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	setMtime(t, out, base)
	setMtime(t, srt, base.Add(time.Hour))

	again, err := ConvertSRTtoVTT(srt, cacheDir)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	body, err := os.ReadFile(again)
	if err != nil {
		t.Fatalf("read rebuilt vtt: %v", err)
	}
	if !strings.Contains(string(body), "Corrected") {
		t.Errorf("stale VTT served after the SRT changed:\n%s", body)
	}
}

// ConvertSRTtoVTT had no non-empty guard before cacheIsFresh: a conversion
// killed mid-write left a 0-byte VTT that was served as an empty track for as
// long as the sidecar sat untouched.
func TestConvertSRTtoVTTRebuildsEmptyCacheFile(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")
	srt := filepath.Join(dir, "test.srt")
	if err := os.WriteFile(srt, []byte("1\n00:00:01,000 --> 00:00:02,000\nHello\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	out, err := ConvertSRTtoVTT(srt, cacheDir)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	if err := os.WriteFile(out, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	setMtime(t, srt, base)
	setMtime(t, out, base.Add(time.Hour))

	again, err := ConvertSRTtoVTT(srt, cacheDir)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if info := mustStat(t, again); info.Size() == 0 {
		t.Error("served a 0-byte converted VTT instead of rebuilding it")
	}
}

// ConvertSubtitleToVTT shells out to ffmpeg for every rebuild, so unlike the
// pure-Go siblings its cache behavior can only be exercised with real media
// tooling. Gated the same way as the rest of the package: skipped on a laptop
// without ffmpeg, a hard failure under AURORA_REQUIRE_MEDIA_TESTS in CI.
func TestConvertSubtitleToVTTCacheFreshness(t *testing.T) {
	requireFFmpeg(t)

	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")
	sub := filepath.Join(dir, "test.srt")
	if err := os.WriteFile(sub, []byte("1\n00:00:01,000 --> 00:00:02,000\nHello\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	out, err := ConvertSubtitleToVTT(context.Background(), sub, cacheDir)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}

	// Equal mtimes must count as a hit (coarse-granularity filesystems).
	writeSentinel(t, out)
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	setMtime(t, sub, base)
	setMtime(t, out, base)

	again, err := ConvertSubtitleToVTT(context.Background(), sub, cacheDir)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if !sentinelSurvived(t, again) {
		t.Error("cached conversion was rebuilt at equal mtimes")
	}

	// A newer source must retire it.
	setMtime(t, sub, base.Add(time.Hour))
	third, err := ConvertSubtitleToVTT(context.Background(), sub, cacheDir)
	if err != nil {
		t.Fatalf("third call: %v", err)
	}
	if sentinelSurvived(t, third) {
		t.Error("stale conversion served after the source changed")
	}
}
