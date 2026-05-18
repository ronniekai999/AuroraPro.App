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
//   2. /usr/bin/sudo -n systemctl start aurora-update.service —
//      authorized via /etc/sudoers.d/aurora-update for the aurora
//      user. Starts the one-shot updater service, which runs as
//      root via its systemd unit. Returns immediately; the caller
//      polls the status JSON for progress.
//
// install.sh sets all of the above up. On a hand-rolled install
// missing any piece, these endpoints degrade gracefully:
//   - missing status file → return {state: "unknown", ...}
//   - sudo grant absent → POST returns 500 with the actual stderr
//     so the operator can diagnose.

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"time"
)

// SystemHandler bundles the small amount of state these endpoints
// need. Currently just the path to the status file, which is fixed
// in install.sh but kept configurable to ease unit testing.
type SystemHandler struct {
	// statusFilePath defaults to /var/lib/aurora/update-status.json.
	// Tests can override it.
	statusFilePath string
	// updaterUnitName is the systemd unit name we ask sudo to start.
	// Constant in prod; constructor parameter keeps tests honest.
	updaterUnitName string
}

func NewSystemHandler() *SystemHandler {
	return &SystemHandler{
		statusFilePath:  "/var/lib/aurora/update-status.json",
		updaterUnitName: "aurora-update.service",
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

// TriggerUpdate kicks off the one-shot updater service via the
// sudoers-permitted `sudo -n systemctl start aurora-update.service`.
// Returns immediately (the service runs asynchronously). The
// caller polls /api/admin/system/update/status for progress.
//
// We deliberately do NOT block on the update completing — a clean
// build + restart cycle is ~30s, and HTTP request lifecycles
// shouldn't camp on that. Polling is the correct shape.
//
// Idempotency: systemd's Type=oneshot serializes invocations.
// `systemctl start` on an already-running oneshot returns 0
// without spawning a second instance, so a frantic double-click on
// the button is harmless.
func (h *SystemHandler) TriggerUpdate(w http.ResponseWriter, r *http.Request) {
	// `sudo -n` = non-interactive; fail immediately if the sudoers
	// grant isn't present rather than hanging waiting for a
	// password prompt that will never be answered.
	cmd := exec.CommandContext(r.Context(), "sudo", "-n", "systemctl", "start", h.updaterUnitName)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// sudo's stderr is usually the most actionable diagnostic
		// ("a password is required" → sudoers missing; "command
		// not allowed" → wrong NOPASSWD target). Forward it.
		slog.Warn("trigger update", "err", err, "output", string(out))
		writeError(w, http.StatusInternalServerError,
			"failed to trigger updater: "+string(out))
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]any{
		"started": true,
		"message": "Update started. Poll /api/admin/system/update/status for progress.",
	})
}
