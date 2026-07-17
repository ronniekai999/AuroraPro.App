package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestServeInstallerScript(t *testing.T) {
	tmpDir := t.TempDir()
	path := filepath.Join(tmpDir, "install.sh")
	body := "#!/usr/bin/env bash\nprintf 'aurora bootstrap\\n'\n"
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}

	handler := serveInstallerScript(path)

	for _, method := range []string{http.MethodGet, http.MethodHead} {
		t.Run(method, func(t *testing.T) {
			req := httptest.NewRequest(method, "/install.sh", nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
			}
			if got := rec.Header().Get("Content-Type"); got != "text/x-shellscript; charset=utf-8" {
				t.Errorf("Content-Type = %q", got)
			}
			if got := rec.Header().Get("Content-Disposition"); got != `inline; filename="aurora-install.sh"` {
				t.Errorf("Content-Disposition = %q", got)
			}
			if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
				t.Errorf("Cache-Control = %q, want no-store", got)
			}
			if method == http.MethodGet && rec.Body.String() != body {
				t.Errorf("body = %q, want %q", rec.Body.String(), body)
			}
			if method == http.MethodHead && rec.Body.Len() != 0 {
				t.Errorf("HEAD returned %d body bytes", rec.Body.Len())
			}
		})
	}
}

func TestServeInstallerScriptMissing(t *testing.T) {
	handler := serveInstallerScript(filepath.Join(t.TempDir(), "missing.sh"))
	req := httptest.NewRequest(http.MethodGet, "/install.sh", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestServeInstallerScriptFallsBack(t *testing.T) {
	tmpDir := t.TempDir()
	fallback := filepath.Join(tmpDir, "fallback.sh")
	if err := os.WriteFile(fallback, []byte("#!/bin/bash\n"), 0644); err != nil {
		t.Fatal(err)
	}

	handler := serveInstallerScript(filepath.Join(tmpDir, "missing.sh"), fallback)
	req := httptest.NewRequest(http.MethodGet, "/install.sh", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec.Body.String() != "#!/bin/bash\n" {
		t.Fatalf("unexpected fallback body %q", rec.Body.String())
	}
}

func TestServeInstallerScriptRejectsSymlink(t *testing.T) {
	tmpDir := t.TempDir()
	target := filepath.Join(tmpDir, "target")
	path := filepath.Join(tmpDir, "install.sh")
	if err := os.WriteFile(target, []byte("sensitive\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}

	handler := serveInstallerScript(path)
	req := httptest.NewRequest(http.MethodGet, "/install.sh", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}
