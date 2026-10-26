package main

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"time"
)

// Serving record — telling the deploy script where THIS process is listening.
//
// scripts/aurora-update.sh used to prove a deploy healthy with
// `curl http://localhost:8484/api/health`. That hard-coded the port, so an
// install with AURORA_PORT (or a config-file port) failed every update's health
// check and rolled back; it hard-coded plain HTTP, so a server with its own TLS
// certificate failed the same way; and it bound the answer to nothing, so it
// could not say WHICH process had answered.
//
// The record is written once, after migrations have run and the listener is
// bound, and names the process (pid) and the address the kernel actually gave
// it. The updater only believes a record whose pid is aurora.service's current
// main process, so a record left behind by the previous process is never
// mistaken for the new one. It is a root-readable file rather than an HTTP
// endpoint for the reason drainstate.go gives: behind the nginx proxy every
// internet request arrives from 127.0.0.1, so a "localhost only" route would be
// reachable from anywhere.
//
// The record names no version. Which binary is running is proved by the
// updater itself (it hashes /proc/<pid>/exe against the file it installed), so
// nothing here needs to be trusted for identity, and the anonymous health route
// still does not disclose the build.

// defaultServingRecordFile matches the state dir aurora.service grants in
// ReadWritePaths. scripts/aurora-update.sh reads the same path (SERVING_FILE);
// TestServingRecordContractMatchesUpdater pins the two together.
const defaultServingRecordFile = "/var/lib/aurora/serving.json"

// servingRecord is the on-disk shape consumed by scripts/aurora-update.sh.
type servingRecord struct {
	// PID is the process that bound the listener. The updater compares it with
	// `systemctl show -p MainPID` and ignores the record on any mismatch.
	PID int `json:"pid"`
	// Addr is net.Listener.Addr(): the bound address, e.g. "[::]:8484" for a
	// wildcard bind. The updater maps an unspecified host to loopback.
	Addr string `json:"addr"`
	// Scheme is "https" when this listener terminates TLS itself, else "http".
	Scheme string `json:"scheme"`
	// ServerName is the TLS name to present (SNI) when the certificate is only
	// served for a configured domain — autocert refuses a handshake without
	// it. Empty for plain HTTP.
	ServerName string `json:"server_name,omitempty"`
	// UnixTime is when the record was written, for diagnosis only.
	UnixTime int64 `json:"unix_time"`
}

// newServingRecord describes listener ln for this process.
func newServingRecord(ln net.Listener, tlsEnabled bool, serverName string) servingRecord {
	rec := servingRecord{
		PID:      os.Getpid(),
		Addr:     ln.Addr().String(),
		Scheme:   "http",
		UnixTime: time.Now().Unix(),
	}
	if tlsEnabled {
		rec.Scheme = "https"
		rec.ServerName = serverName
	}
	return rec
}

// writeServingRecord publishes rec at path, atomically (temp file + rename) so
// the updater never parses half a record. A missing parent directory is not an
// error: a source checkout or dev box has no /var/lib/aurora, and the updater
// falls back to the configured address when no record names the process.
func writeServingRecord(path string, rec servingRecord) error {
	if _, err := os.Stat(filepath.Dir(path)); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	blob, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	blob = append(blob, '\n')
	tmp := path + ".tmp"
	// 0644: the updater runs as root and could read any mode; the contents are
	// a pid and the bound address, both visible to any local user already.
	if err := os.WriteFile(tmp, blob, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// clearServingRecord removes the record at path if, and only if, it is this
// process's. Best-effort: the updater ignores a record whose pid is not the
// current main process anyway, so a leftover file is harmless; removing only
// our own keeps a slow shutdown from deleting a successor's record.
func clearServingRecord(path string) {
	blob, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var rec servingRecord
	if json.Unmarshal(blob, &rec) != nil || rec.PID != os.Getpid() {
		return
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Debug("serving record: remove failed", "path", path, "error", err)
	}
}
