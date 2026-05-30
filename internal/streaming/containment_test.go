package streaming

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
)

// TestPathWithinRoot covers the separator-aware containment check used by the
// symlink-escape guards (audit LOW). The root is assumed already canonicalized
// by callers; the target is symlink-resolved here, so every case uses real
// on-disk files/dirs.
func TestPathWithinRoot(t *testing.T) {
	root := t.TempDir()
	// Canonicalize the root the way callers do (e.g. macOS /var -> /private/var).
	canonRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatalf("eval root: %v", err)
	}

	// A normal file inside the root.
	inside := filepath.Join(canonRoot, "ok.txt")
	if err := os.WriteFile(inside, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A file in a nested subdir inside the root.
	sub := filepath.Join(canonRoot, "a", "b")
	if err := os.MkdirAll(sub, 0o750); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(sub, "deep.txt")
	if err := os.WriteFile(nested, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// A sibling directory whose name has the root as a string prefix
	// ("<root>X") — must NOT be considered contained.
	siblingPrefix := canonRoot + "X"
	if err := os.MkdirAll(siblingPrefix, 0o750); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(siblingPrefix)
	siblingFile := filepath.Join(siblingPrefix, "evil.txt")
	if err := os.WriteFile(siblingFile, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// An outside file plus a symlink inside the root that points at it.
	outsideDir := t.TempDir()
	outsideFile := filepath.Join(outsideDir, "secret.txt")
	if err := os.WriteFile(outsideFile, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	escapingLink := filepath.Join(canonRoot, "link.txt")
	if err := os.Symlink(outsideFile, escapingLink); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}

	tests := []struct {
		name   string
		root   string
		target string
		want   bool
	}{
		{"file directly in root", canonRoot, inside, true},
		{"nested file in root", canonRoot, nested, true},
		{"root itself", canonRoot, canonRoot, true},
		{"sibling with shared name prefix is not contained", canonRoot, siblingFile, false},
		{"symlink escaping root resolves outside -> not contained", canonRoot, escapingLink, false},
		{"nonexistent target -> not contained", canonRoot, filepath.Join(canonRoot, "missing.txt"), false},
		{"empty root -> not contained", "", inside, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := pathWithinRoot(tt.root, tt.target); got != tt.want {
				t.Errorf("pathWithinRoot(%q, %q) = %v, want %v", tt.root, tt.target, got, tt.want)
			}
		})
	}
}

// TestServeFile_SymlinkContainment verifies the ServeFile direct-play guard
// (audit LOW), containing against the configured LIBRARY ROOT (not the file's own
// parent dir): a normal file in the root serves 200; a content-pool layout where a
// title symlinks to a sibling dir UNDER THE SAME ROOT also serves 200 (the
// regression the parent-dir-only check caused); a symlink whose target escapes the
// library root yields 404; and empty roots skip containment so a lookup failure
// never breaks playback.
func TestServeFile_SymlinkContainment(t *testing.T) {
	mediaDir := t.TempDir()
	// Resolve the library root the way StreamHandler.mediaRoots does — callers pass
	// EvalSymlinks-resolved roots (e.g. macOS /var -> /private/var).
	root, err := filepath.EvalSymlinks(mediaDir)
	if err != nil {
		t.Fatalf("eval mediaDir: %v", err)
	}
	roots := []string{root}

	// Normal file directly in the library root: serves OK.
	normal := filepath.Join(root, "movie.mp4")
	if err := os.WriteFile(normal, []byte("FAKEMP4DATA"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Content-pool / symlink-dedup layout: a title in a subdir links to a SIBLING
	// pool dir under the SAME library root. This MUST serve — it is exactly what
	// the scanner indexes, and the old parent-dir-only containment 404'd it.
	poolDir := filepath.Join(root, "_pool")
	titleDir := filepath.Join(root, "Inception")
	if err := os.MkdirAll(poolDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(titleDir, 0o750); err != nil {
		t.Fatal(err)
	}
	poolFile := filepath.Join(poolDir, "abc123.mp4")
	if err := os.WriteFile(poolFile, []byte("POOLDATA"), 0o644); err != nil {
		t.Fatal(err)
	}
	pooledLink := filepath.Join(titleDir, "Inception.mp4")
	poolSymlinkOK := os.Symlink(poolFile, pooledLink) == nil

	// Secret outside the library root + an escaping symlink inside it.
	secretDir := t.TempDir()
	secret := filepath.Join(secretDir, "passwd")
	if err := os.WriteFile(secret, []byte("root:x:0:0:"), 0o644); err != nil {
		t.Fatal(err)
	}
	escaping := filepath.Join(root, "evil.mp4")
	escapeSymlinkOK := os.Symlink(secret, escaping) == nil

	t.Run("normal file in root serves 200", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/stream", nil)
		rec := httptest.NewRecorder()
		ServeFile(rec, req, normal, roots)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%q", rec.Code, rec.Body.String())
		}
		if rec.Body.String() != "FAKEMP4DATA" {
			t.Errorf("body = %q, want the file contents", rec.Body.String())
		}
	})

	t.Run("content-pool symlink to sibling under same root serves 200", func(t *testing.T) {
		if !poolSymlinkOK {
			t.Skip("symlink unsupported")
		}
		req := httptest.NewRequest(http.MethodGet, "/stream", nil)
		rec := httptest.NewRecorder()
		ServeFile(rec, req, pooledLink, roots)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (content-pool layout must serve); body=%q", rec.Code, rec.Body.String())
		}
		if rec.Body.String() != "POOLDATA" {
			t.Errorf("body = %q, want the pooled file contents", rec.Body.String())
		}
	})

	t.Run("symlink escaping the library root yields 404", func(t *testing.T) {
		if !escapeSymlinkOK {
			t.Skip("symlink unsupported")
		}
		req := httptest.NewRequest(http.MethodGet, "/stream", nil)
		rec := httptest.NewRecorder()
		ServeFile(rec, req, escaping, roots)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
		if rec.Body.String() == "root:x:0:0:" {
			t.Error("escaping symlink served the target's secret contents")
		}
	})

	t.Run("empty roots skips containment (no regression on lookup failure)", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/stream", nil)
		rec := httptest.NewRecorder()
		ServeFile(rec, req, normal, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (nil roots must still serve)", rec.Code)
		}
	})
}

// TestServeSubtitleSegment_Containment exercises the HLS subtitle-segment guard
// against the canonical transcode base (audit LOW). A legitimate empty segment
// inside the session OutputDir is served (with the injected WEBVTT/X-TIMESTAMP
// header); a symlink-named segment whose target escapes the base yields 404.
func TestServeSubtitleSegment_Containment(t *testing.T) {
	base := t.TempDir()
	tm, err := NewTranscodeManager(base, config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	// Manually register a session whose OutputDir is under the (canonical) base.
	sessID := "testsession"
	outDir := filepath.Join(tm.baseDir, sessID)
	if err := os.MkdirAll(outDir, 0o750); err != nil {
		t.Fatal(err)
	}
	s := &TranscodeSession{
		ID:           sessID,
		OutputDir:    outDir,
		Variants:     make(map[string]*QualityVariant),
		LastAccess:   time.Now(),
		initPTS90kHz: -1,
	}
	tm.mu.Lock()
	tm.sessions[sessID] = s
	tm.mu.Unlock()

	// Legit (empty) subtitle segment file FFmpeg would produce.
	legit := filepath.Join(outDir, "subs_0_0.vtt")
	if err := os.WriteFile(legit, []byte{}, 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("legit segment serves vtt", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/sub", nil)
		rec := httptest.NewRecorder()
		tm.ServeSubtitleSegment(rec, req, sessID, "subs_0_0.vtt")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%q", rec.Code, rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); ct != "text/vtt; charset=utf-8" {
			t.Errorf("content-type = %q", ct)
		}
	})

	// Symlink-named segment escaping the base. The name still has to satisfy
	// reSubsSegment (subs_<n>_<n>.vtt), so use subs_9_9.vtt as the link name.
	t.Run("escaping symlink segment yields 404", func(t *testing.T) {
		secretDir := t.TempDir()
		secret := filepath.Join(secretDir, "secret.vtt")
		if err := os.WriteFile(secret, []byte("WEBVTT\n\n00:00.000 --> 00:01.000\nSECRET\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		escaping := filepath.Join(outDir, "subs_9_9.vtt")
		if err := os.Symlink(secret, escaping); err != nil {
			t.Skipf("symlink unsupported: %v", err)
		}
		req := httptest.NewRequest(http.MethodGet, "/sub", nil)
		rec := httptest.NewRecorder()
		tm.ServeSubtitleSegment(rec, req, sessID, "subs_9_9.vtt")
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404; body=%q", rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "SECRET") {
			t.Error("escaping symlink served the target's secret subtitle contents")
		}
	})

	if runtime.GOOS == "windows" {
		t.Log("note: symlink creation may require elevated privileges on Windows")
	}
}
