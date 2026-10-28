package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func listenLoopback(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	return ln
}

func readRecord(t *testing.T, path string) servingRecord {
	t.Helper()
	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var rec servingRecord
	if err := json.Unmarshal(blob, &rec); err != nil {
		t.Fatalf("record is not JSON: %v (%q)", err, blob)
	}
	return rec
}

// TestServingRecordNamesThisProcessAndItsBoundAddress: the updater trusts a
// record only when its pid is the unit's main process, and connects to the
// address in it, so both must be the real ones — the bound port, not the
// configured ":0".
func TestServingRecordNamesThisProcessAndItsBoundAddress(t *testing.T) {
	ln := listenLoopback(t)
	path := filepath.Join(t.TempDir(), "serving.json")
	if err := writeServingRecord(path, newServingRecord(ln, false, "media.example")); err != nil {
		t.Fatal(err)
	}
	rec := readRecord(t, path)
	if rec.PID != os.Getpid() {
		t.Errorf("pid = %d, want %d", rec.PID, os.Getpid())
	}
	if rec.Addr != ln.Addr().String() || strings.HasSuffix(rec.Addr, ":0") {
		t.Errorf("addr = %q, want the bound %q", rec.Addr, ln.Addr())
	}
	if rec.Scheme != "http" || rec.ServerName != "" {
		t.Errorf("plain listener recorded as %q with server name %q", rec.Scheme, rec.ServerName)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("temp file left behind: %v", err)
	}
}

func TestServingRecordReportsTLSAndItsServerName(t *testing.T) {
	ln := listenLoopback(t)
	rec := newServingRecord(ln, true, "media.example")
	if rec.Scheme != "https" || rec.ServerName != "media.example" {
		t.Errorf("TLS listener recorded as %q with server name %q", rec.Scheme, rec.ServerName)
	}
}

// TestServingRecordSkipsAMissingStateDir: a dev box has no /var/lib/aurora.
func TestServingRecordSkipsAMissingStateDir(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent", "serving.json")
	if err := writeServingRecord(path, newServingRecord(listenLoopback(t), false, "")); err != nil {
		t.Fatalf("missing state dir must not be an error: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("record written into a missing dir: %v", err)
	}
}

// TestClearServingRecordRemovesOnlyItsOwn: a slow shutdown must not delete a
// successor's record.
func TestClearServingRecordRemovesOnlyItsOwn(t *testing.T) {
	dir := t.TempDir()
	own := filepath.Join(dir, "own.json")
	other := filepath.Join(dir, "other.json")
	if err := writeServingRecord(own, newServingRecord(listenLoopback(t), false, "")); err != nil {
		t.Fatal(err)
	}
	successor := newServingRecord(listenLoopback(t), false, "")
	successor.PID = os.Getpid() + 1
	if err := writeServingRecord(other, successor); err != nil {
		t.Fatal(err)
	}
	clearServingRecord(own)
	clearServingRecord(other)
	if _, err := os.Stat(own); !os.IsNotExist(err) {
		t.Errorf("own record survived shutdown: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Errorf("another process's record was removed: %v", err)
	}
}

// TestServingRecordContractMatchesUpdater pins the file the server writes to
// the one scripts/aurora-update.sh reads, and the JSON keys it reads to the
// ones the server emits. Either side renamed alone would leave the updater
// falling back to the configured address forever, failing every update on a
// non-default port or a TLS listener, while every Go and updater test passed.
func TestServingRecordContractMatchesUpdater(t *testing.T) {
	script, err := os.ReadFile(filepath.Join("..", "..", "scripts", "aurora-update.sh"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(script)
	if !strings.Contains(text, "SERVING_FILE="+defaultServingRecordFile+"\n") {
		t.Errorf("scripts/aurora-update.sh does not read the serving record at %s", defaultServingRecordFile)
	}
	blob, err := json.Marshal(newServingRecord(listenLoopback(t), true, "media.example"))
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(blob, &fields); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"pid", "addr", "scheme", "server_name"} {
		if _, ok := fields[key]; !ok {
			t.Errorf("serving record has no %q field", key)
		}
		if !strings.Contains(text, `rec.get("`+key+`")`) {
			t.Errorf("scripts/aurora-update.sh does not read the record's %q field", key)
		}
	}
}
