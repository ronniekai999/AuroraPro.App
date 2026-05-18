package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// TestSafeFileServer verifies that the static file handler blocks dotfiles,
// directory listings, and backup files while still serving legitimate content.
func TestSafeFileServer(t *testing.T) {
	// Create a temporary static directory with test files
	tmpDir := t.TempDir()

	// Create legitimate files.
	// Note: http.FileServer redirects /index.html -> / (301), so we use a
	// different filename to test normal serving without redirect interference.
	if err := os.WriteFile(filepath.Join(tmpDir, "app.html"), []byte("<html>ok</html>"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "style.css"), []byte("body{}"), 0644); err != nil {
		t.Fatal(err)
	}

	// Create dotfiles that should NOT be served
	if err := os.WriteFile(filepath.Join(tmpDir, ".env"), []byte("SECRET=hunter2"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, ".htaccess"), []byte("deny all"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, ".DS_Store"), []byte("\x00\x00"), 0644); err != nil {
		t.Fatal(err)
	}

	// Create a .git directory
	gitDir := filepath.Join(tmpDir, ".git")
	if err := os.Mkdir(gitDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gitDir, "config"), []byte("[remote]\nurl=https://secret"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gitDir, "HEAD"), []byte("ref: refs/heads/main"), 0644); err != nil {
		t.Fatal(err)
	}

	// Create backup files that should NOT be served
	if err := os.WriteFile(filepath.Join(tmpDir, "config.bak"), []byte("secret config"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "data.old"), []byte("old data"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "file.orig"), []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "file.swp"), []byte("vim swap"), 0644); err != nil {
		t.Fatal(err)
	}

	handler := safeFileServer(http.Dir(tmpDir))

	tests := []struct {
		name       string
		path       string
		wantStatus int
		desc       string
	}{
		// Legitimate files should be served
		{
			name:       "serve normal HTML file",
			path:       "/app.html",
			wantStatus: http.StatusOK,
			desc:       "legitimate file should be served",
		},
		{
			name:       "serve CSS file",
			path:       "/style.css",
			wantStatus: http.StatusOK,
			desc:       "legitimate file should be served",
		},

		// Dotfiles must be blocked
		{
			name:       "block .env",
			path:       "/.env",
			wantStatus: http.StatusNotFound,
			desc:       "dotfiles must not be served",
		},
		{
			name:       "block .htaccess",
			path:       "/.htaccess",
			wantStatus: http.StatusNotFound,
			desc:       "dotfiles must not be served",
		},
		{
			name:       "block .DS_Store",
			path:       "/.DS_Store",
			wantStatus: http.StatusNotFound,
			desc:       "dotfiles must not be served",
		},
		{
			name:       "block .git/config",
			path:       "/.git/config",
			wantStatus: http.StatusNotFound,
			desc:       "dot-directories must not be traversed",
		},
		{
			name:       "block .git/HEAD",
			path:       "/.git/HEAD",
			wantStatus: http.StatusNotFound,
			desc:       "dot-directories must not be traversed",
		},

		// Backup files must be blocked
		{
			name:       "block .bak file",
			path:       "/config.bak",
			wantStatus: http.StatusNotFound,
			desc:       "backup files must not be served",
		},
		{
			name:       "block .old file",
			path:       "/data.old",
			wantStatus: http.StatusNotFound,
			desc:       "backup files must not be served",
		},
		{
			name:       "block .orig file",
			path:       "/file.orig",
			wantStatus: http.StatusNotFound,
			desc:       "backup files must not be served",
		},
		{
			name:       "block .swp file",
			path:       "/file.swp",
			wantStatus: http.StatusNotFound,
			desc:       "vim swap files must not be served",
		},
		{
			name:       "block .BAK case-insensitive",
			path:       "/config.BAK",
			wantStatus: http.StatusNotFound,
			desc:       "extension blocking must be case-insensitive",
		},

		// Directory listings must be blocked
		{
			name:       "block root directory listing",
			path:       "/",
			wantStatus: http.StatusNotFound,
			desc:       "directory listing must not be generated",
		},
		{
			name:       "block trailing-slash directory listing",
			path:       "/subdir/",
			wantStatus: http.StatusNotFound,
			desc:       "directory listing must not be generated",
		},

		// Non-existent files should still 404
		{
			name:       "404 for non-existent file",
			path:       "/nonexistent.html",
			wantStatus: http.StatusNotFound,
			desc:       "non-existent files should 404",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tt.path, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("%s: got status %d, want %d (%s)",
					tt.path, rec.Code, tt.wantStatus, tt.desc)
			}
		})
	}
}

// TestSafeFileServerPathTraversal verifies that path traversal attempts
// are blocked (this is handled by Go's http.Dir, but we verify it).
func TestSafeFileServerPathTraversal(t *testing.T) {
	tmpDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmpDir, "safe.txt"), []byte("safe"), 0644); err != nil {
		t.Fatal(err)
	}

	handler := safeFileServer(http.Dir(tmpDir))

	traversalPaths := []string{
		"/../../../etc/passwd",
		"/..%2f..%2f..%2fetc/passwd",
		"/subfolder/../../etc/passwd",
	}

	for _, path := range traversalPaths {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest("GET", path, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code == http.StatusOK {
				t.Errorf("path traversal attempt %q returned 200 OK (should be blocked)", path)
			}
		})
	}
}
