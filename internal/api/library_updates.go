package api

import (
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	ws "github.com/aurora-media/aurora/internal/websocket"
)

// LibraryUpdateInterval is the least time between two mid-scan library_update
// events from one scan. A scan reports progress every ten files, which during a
// bulk import of already-indexed files is many times a second, and every event
// makes each connected web app refetch whatever catalog view it is showing.
const LibraryUpdateInterval = 10 * time.Second

// Library update actions, the `action` field of a library_update event.
const (
	// libraryUpdateItemsAdded: a scan still running has added files since the
	// last event. new_items is the scan's running total.
	libraryUpdateItemsAdded = "items_added"
	// libraryUpdateScanCompleted: a scan that added files finished. Sent after
	// the deferred TV enrichment, so new shows have their metadata by then.
	libraryUpdateScanCompleted = "scan_completed"
	// libraryUpdateRetypeCompleted: a retype's rescan finished. Sent even when
	// the rescan found nothing, because the purge before it removed titles.
	libraryUpdateRetypeCompleted = "retype_rescan_completed"
)

type libraryUpdateHub interface {
	Broadcast(eventType string, data interface{})
}

// LibraryUpdates turns one scan's progress reports into library_update events,
// so clients can show new titles while the scan is still running rather than
// only after it (or after a page reload).
//
// Every scan entry point (the API's scan and create, a retype's rescan, the
// request monitor and the file watcher in cmd/aurora) makes one per scan and
// passes every progress report to Observe. It is the only sender of
// library_update; TestLibraryUpdateHasOneSender keeps it that way, so the
// throttle cannot be bypassed by a sixth copy of the completion broadcast.
//
// What a mid-scan event can show: a movie is enriched inline before its file
// is counted as new, so it usually arrives with its poster (a worker still
// enriching another movie can leave that one bare until the next event). A new
// show is enriched only after every file is processed, so mid-scan it shows
// the parsed folder title and no artwork until the completion event.
type LibraryUpdates struct {
	hub              libraryUpdateHub
	lib              *models.Library
	interval         time.Duration
	now              func() time.Time
	completedAction  string
	notifyEmptyScans bool

	// Progress reports arrive from the scanner's worker goroutines, several at
	// once, so the claim of an event is serialised.
	mu      sync.Mutex
	sentNew int
	sentAt  time.Time
}

// NewLibraryUpdates returns the library_update sender for one scan of lib.
func NewLibraryUpdates(hub libraryUpdateHub, lib *models.Library) *LibraryUpdates {
	return &LibraryUpdates{
		hub:             hub,
		lib:             lib,
		interval:        LibraryUpdateInterval,
		now:             time.Now,
		completedAction: libraryUpdateScanCompleted,
	}
}

// newRetypeLibraryUpdates is NewLibraryUpdates for a retype's rescan, whose
// completion is announced even when it added nothing.
func newRetypeLibraryUpdates(hub libraryUpdateHub, lib *models.Library) *LibraryUpdates {
	u := NewLibraryUpdates(hub, lib)
	u.completedAction = libraryUpdateRetypeCompleted
	u.notifyEmptyScans = true
	return u
}

// Observe takes one progress report of the scan. While the scan runs it sends
// an items_added event when the scan has added files since the last event and
// the interval has passed since it; the first new file is sent at once. A scan
// that completes having added files (or any retype rescan) sends its
// completion event regardless of the interval, which is what delivers files
// added after the last mid-scan event. A failed or cancelled scan sends
// nothing more: what it added has already been announced or will be found by
// the next scan.
func (u *LibraryUpdates) Observe(p *models.ScanProgress) {
	if u == nil || p == nil {
		return
	}
	switch p.Status {
	case models.ScanRunning:
		if u.claimMidScan(p.NewFiles) {
			u.send(p.NewFiles, libraryUpdateItemsAdded)
		}
	case models.ScanComplete:
		if p.NewFiles > 0 || u.notifyEmptyScans {
			u.send(p.NewFiles, u.completedAction)
		}
	}
}

func (u *LibraryUpdates) claimMidScan(newFiles int) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	if newFiles <= u.sentNew {
		return false
	}
	now := u.now()
	if !u.sentAt.IsZero() && now.Sub(u.sentAt) < u.interval {
		return false
	}
	u.sentNew = newFiles
	u.sentAt = now
	return true
}

func (u *LibraryUpdates) send(newFiles int, action string) {
	u.hub.Broadcast(ws.EventLibraryUpdate, map[string]interface{}{
		"library_id":   u.lib.ID,
		"library_name": u.lib.Name,
		"new_items":    newFiles,
		"action":       action,
	})
}
