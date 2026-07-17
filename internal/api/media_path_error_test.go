package api

// Unit tests for pathAccessError — the library-create path validator's
// error classifier. The permission-denied and not-found cases produce
// different remediation guidance (2026-07-17 install report: a 0750
// home dir made a perfectly real path report as "does not exist").
// Errors are injected as fs.PathError values wrapping real syscall
// errnos — the same shape filepath.EvalSymlinks and os.Lstat return —
// rather than via chmod tricks, which don't work when tests run as
// root (root bypasses mode bits).

import (
	"io/fs"
	"strings"
	"syscall"
	"testing"
)

func TestPathAccessErrorPermissionDenied(t *testing.T) {
	err := &fs.PathError{Op: "lstat", Path: "/home/user/media", Err: syscall.EACCES}
	msg := pathAccessError("/home/user/media/movies", err)

	for _, want := range []string{
		"Aurora service user",
		"permission denied",
		"setfacl",
		"AURORA_MEDIA_DIR=/home/user/media/movies",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("permission-denied message missing %q; got: %s", want, msg)
		}
	}
	if strings.Contains(msg, "does not exist") {
		t.Errorf("permission-denied must not be reported as nonexistence; got: %s", msg)
	}
}

func TestPathAccessErrorNotFound(t *testing.T) {
	err := &fs.PathError{Op: "lstat", Path: "/srv/nope", Err: syscall.ENOENT}
	msg := pathAccessError("/srv/nope", err)

	if !strings.Contains(msg, "does not exist on the server: /srv/nope") {
		t.Errorf("not-found message wrong; got: %s", msg)
	}
	if strings.Contains(msg, "setfacl") {
		t.Errorf("not-found message must not suggest permission fixes; got: %s", msg)
	}
}

// ENOTDIR (a path component is a file, e.g. /srv/file.mkv/movies) is
// neither ENOENT nor EACCES; it must fall through to the not-found
// wording rather than the permission guidance.
func TestPathAccessErrorOtherErrno(t *testing.T) {
	err := &fs.PathError{Op: "lstat", Path: "/srv/file.mkv/movies", Err: syscall.ENOTDIR}
	msg := pathAccessError("/srv/file.mkv/movies", err)
	if strings.Contains(msg, "setfacl") {
		t.Errorf("non-permission errno must not produce permission guidance; got: %s", msg)
	}
}
