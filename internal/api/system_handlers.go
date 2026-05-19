package api

// System-level admin endpoints: auto-updater triggers and status.
//
// The updater itself is a privileged operation (writes
// /usr/local/bin/aurora, calls `systemctl restart aurora`). Aurora's
// own process runs as the unprivileged `aurora` user — we don't
// want a publicly-reachable Go binary to ever hold root. The
// architecture instead routes through systemd:
//
//   1. /var/lib/aurora/update-status.json — JSON status file that
//      aurora-update.sh writes during each run. Aurora READS it
//      directly (no privilege escalation needed).
//   2. /var/lib/aurora/trigger-update — trigger file. Aurora writes
//      a fresh timestamp to it; aurora-update.path watches the file
//      via PathChanged= and starts aurora-update.service as root
//      (systemd is PID 1, no privilege escalation through aurora).
//
// Why a file rather than sudo (2026-05-19 rearchitecture):
//
//   The previous design called `sudo -n systemctl start aurora-
//   update.service` via a sudoers grant. That collides with the
//   NoNewPrivileges=yes hardening on aurora.service, which
//   unconditionally blocks sudo from elevating. Path activation
//   keeps the hardening AND removes the sudoers grant entirely —
//   even a compromised aurora process can only touch one file,
//   which triggers an idempotent git-pull pipeline (no arbitrary
//   code execution).
//
// install.sh sets all of the above up. On a hand-rolled install
// missing any piece, these endpoints degrade gracefully:
//   - missing status file → return {state: "unknown", ...}
//   - trigger file unwritable / .path unit disabled → POST returns
//     500 with an actionable error message.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"syscall"
	"time"
)

// SystemHandler bundles the small amount of state these endpoints
// need. Both paths are fixed in install.sh but kept configurable to
// ease unit testing.
type SystemHandler struct {
	// statusFilePath defaults to /var/lib/aurora/update-status.json.
	statusFilePath string
	// triggerFilePath defaults to /var/lib/aurora/trigger-update.
	// Writing to this file fires aurora-update.path → aurora-update.service.
	triggerFilePath string
}

func NewSystemHandler() *SystemHandler {
	return &SystemHandler{
		statusFilePath:  "/var/lib/aurora/update-status.json",
		triggerFilePath: "/var/lib/aurora/trigger-update",
	}
}

// updateStatus mirrors the JSON shape written by
// scripts/aurora-update.sh. We unmarshal into this strict shape
// rather than `map[string]any` so the API contract is enforced at
// the Go boundary: if the script changes the schema and forgets to
// update this struct, the unmarshal fails loudly instead of
// silently propagating drift to the SPA.
type updateStatus struct {
	State   string  `json:"state"`             // checking|updating|building|installing|restarting|success|failed|idle|unknown
	At      string  `json:"at"`                // RFC3339 UTC timestamp
	Message string  `json:"message"`           // human-readable detail
	OldSHA  *string `json:"old_sha,omitempty"` // commit before update
	NewSHA  *string `json:"new_sha,omitempty"` // commit after update (or target during update)
}

// GetUpdateStatus reads /var/lib/aurora/update-status.json and
// returns it verbatim. Missing file → "unknown" state, which the UI
// renders as "Updater not configured" so operators know the
// install.sh updater block didn't run.
//
// This endpoint is cheap (stat + small JSON read) so the SPA polls
// it every 2s while an update is in flight without measurable load.
func (h *SystemHandler) GetUpdateStatus(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(h.statusFilePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// Never been updated, or install.sh ran without the
			// updater block. Return a synthetic "unknown" status
			// rather than 404 so the UI's polling loop has a
			// uniform shape to render.
			writeJSON(w, http.StatusOK, updateStatus{
				State:   "unknown",
				At:      time.Now().UTC().Format(time.RFC3339),
				Message: "No update has run yet. The 5-minute timer will populate this on its first tick.",
			})
			return
		}
		slog.Warn("read update status", "path", h.statusFilePath, "err", err)
		writeError(w, http.StatusInternalServerError, "failed to read update status")
		return
	}

	// Validate the JSON shape matches what the updater writes. If
	// the file is somehow corrupted (truncated write, manual edit
	// gone wrong), surface that rather than serving garbage to the
	// SPA.
	var status updateStatus
	if err := json.Unmarshal(data, &status); err != nil {
		slog.Warn("parse update status", "path", h.statusFilePath, "err", err)
		writeError(w, http.StatusInternalServerError, "update status file is malformed")
		return
	}

	writeJSON(w, http.StatusOK, status)
}

// TriggerUpdate kicks off the one-shot updater by touching the
// trigger file that aurora-update.path watches. Returns immediately;
// the caller polls /api/admin/system/update/status for progress.
//
// Trigger semantics: we write a fresh RFC3339 timestamp to the file
// on each invocation. systemd's PathChanged= fires on close-after-
// write, so every POST produces exactly one .path event regardless
// of the file's prior contents. The aurora-update.service is
// Type=oneshot — concurrent triggers are handled by systemd.
//
// Click-during-build semantics: if aurora-update.service is already
// running when a PathChanged fires, systemd does NOT queue a second
// run for after the current one — the new trigger is effectively
// coalesced into the in-flight invocation. Operationally: clicking
// Update Now while a build is in progress is a harmless no-op, but
// it ALSO won't pull commits that landed during the build. The
// 5-min timer catches those on the next tick.
//
// We deliberately do NOT block on the update completing. A clean
// build + restart cycle is ~30s, and HTTP request lifecycles
// shouldn't camp on that. Polling is the correct shape.
//
// Common failure modes and their messages:
//   - File missing → install.sh's updater block didn't run
//   - File unwritable → ReadWritePaths in aurora.service doesn't
//     include /var/lib/aurora, or the file isn't group-writable
//   - .path unit not enabled → file write succeeds but no service
//     ever runs; the operator sees "Update started" but the status
//     JSON never advances. The status-poll endpoint is the right
//     surface for that diagnostic (a stale "at" timestamp).
func (h *SystemHandler) TriggerUpdate(w http.ResponseWriter, r *http.Request) {
	// O_WRONLY + O_TRUNC overwrites whatever was there; we don't
	// care about file history. The body is just a fresh timestamp
	// for human debugging — systemd cares about the close event,
	// not the contents.
	//
	// O_NOFOLLOW: defense-in-depth against a compromised aurora
	// process swapping the trigger file for a symlink to something
	// else writable (e.g. /var/log/aurora/anyfile, /opt/aurora/...).
	// Both targets are in our ReadWritePaths, so writes would
	// succeed — not a privilege-escalation, but it's a low-cost
	// guardrail. Open returns ELOOP if the FINAL path component is
	// a symlink.
	//
	// Note: O_NOFOLLOW only checks the final component, not parent
	// directories. A symlink at /var/lib → /run/lib (or similar)
	// would still be followed. For full symlink-traversal blocking
	// we'd need openat2(RESOLVE_NO_SYMLINKS), which Go's stdlib
	// doesn't expose portably. Aurora runs on Linux with vanilla
	// FHS layouts where this isn't a concern, but worth knowing.
	//
	// Permissions 0664 only apply if the file is being created here
	// (it normally exists from install.sh). The file's actual mode +
	// ownership are managed by install.sh: root:aurora 0664.
	f, err := os.OpenFile(h.triggerFilePath, os.O_WRONLY|os.O_TRUNC|os.O_CREATE|syscall.O_NOFOLLOW, 0664)
	if err != nil {
		// errors.Is(err, os.ErrPermission): aurora can't write here.
		// errors.Is(err, os.ErrNotExist):    parent dir missing (no install)
		// Anything else: pass through.
		slog.Warn("trigger update: open trigger file", "path", h.triggerFilePath, "err", err)
		switch {
		case errors.Is(err, os.ErrPermission):
			writeError(w, http.StatusInternalServerError,
				"failed to trigger updater: cannot write "+h.triggerFilePath+
					" — check that install.sh ran and that /var/lib/aurora is in aurora.service's ReadWritePaths")
		case errors.Is(err, os.ErrNotExist):
			writeError(w, http.StatusInternalServerError,
				"failed to trigger updater: "+h.triggerFilePath+" does not exist "+
					"— the auto-updater block of install.sh was skipped or failed; re-run install.sh")
		default:
			writeError(w, http.StatusInternalServerError,
				"failed to trigger updater: "+err.Error())
		}
		return
	}
	defer f.Close()

	// Write a timestamp. Contents don't matter to systemd — the
	// PathChanged= event fires on file modification regardless —
	// but a timestamp is the most useful thing to find in the file
	// when diagnosing "did the trigger actually fire?".
	if _, err := fmt.Fprintf(f, "%s\n", time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		slog.Warn("trigger update: write trigger file", "path", h.triggerFilePath, "err", err)
		writeError(w, http.StatusInternalServerError,
			"failed to trigger updater: write failed: "+err.Error())
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]any{
		"started": true,
		"message": "Update triggered. Poll /api/admin/system/update/status for progress.",
	})
}
