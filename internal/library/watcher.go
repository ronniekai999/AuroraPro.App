package library

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/fsnotify/fsnotify"
)

// Watcher monitors library directories for filesystem changes between scans.
// It debounces rapid changes (e.g., bulk copy operations) and triggers
// a callback with the affected library when changes settle.
//
// Additionally, the Watcher can run periodic full-library scans at a
// configurable interval (controlled via the scan_interval_default admin
// setting). The interval can be updated at runtime via SetScanInterval.
type Watcher struct {
	cfg      config.ScannerConfig
	scanner  *Scanner
	onChange func(lib *models.Library)

	mu             sync.Mutex
	watching       map[int64]*libraryWatch
	scanInterval   time.Duration // periodic scan interval (0 = disabled)
	scanTicker     *time.Ticker  // periodic scan ticker (nil when disabled)
	scanDone       chan struct{} // signals the periodic scan goroutine to stop
	fsWatchEnabled atomic.Bool   // when false, fsnotify events are silently discarded
	lastScanTime   sync.Map      // map[int64]time.Time — dedup scan triggers from periodic + fsnotify
}

type libraryWatch struct {
	library  *models.Library
	cancel   context.CancelFunc
	debounce *time.Timer
	// generation is bumped each time WatchLibrary creates a new entry
	// for a given library ID. The debounce closure captures the
	// generation it was scheduled under and only fires the scan if
	// it still matches. Defends against the race where a library is
	// unwatched and re-watched (same ID, new entry) while an old
	// debounce timer is still in flight — without this, the old
	// timer's closure would scan the NEW library, potentially
	// triggering ghost scans against a brand-new entry.
	// 2026-05-19 audit (BE-H2).
	generation uint64
}

func NewWatcher(cfg config.ScannerConfig, scanner *Scanner, onChange func(lib *models.Library)) *Watcher {
	w := &Watcher{
		cfg:      cfg,
		scanner:  scanner,
		watching: make(map[int64]*libraryWatch),
		onChange: onChange,
		scanDone: make(chan struct{}),
	}
	w.fsWatchEnabled.Store(true) // filesystem watching on by default
	return w
}

// SetFSWatchEnabled controls whether fsnotify events trigger scans.
// When disabled, the watcher goroutines stay alive but silently discard events.
// This avoids complex teardown/restart logic.
func (w *Watcher) SetFSWatchEnabled(enabled bool) {
	w.fsWatchEnabled.Store(enabled)
	if enabled {
		slog.Info("filesystem watching enabled")
	} else {
		slog.Info("filesystem watching disabled")
	}
}

// SetScanInterval updates the periodic scan interval at runtime.
// A duration of 0 disables periodic scanning. This is called by the admin
// API when the scan_interval_default setting is changed, providing hot-reload
// without restarting the server.
func (w *Watcher) SetScanInterval(d time.Duration) {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.scanInterval = d

	// Stop existing ticker if any
	if w.scanTicker != nil {
		w.scanTicker.Stop()
		w.scanTicker = nil
	}

	if d > 0 {
		w.scanTicker = time.NewTicker(d)
		go w.periodicScanLoop(w.scanTicker)
		slog.Info("periodic scan interval updated", "interval", d)
	} else {
		slog.Info("periodic scanning disabled")
	}
}

// NoteExternalScan records that an out-of-band scan was started for this
// library (e.g. a library-creation API handler calling scanner.ScanLibrary
// directly). Future periodic-timer or fsnotify triggers within the 30-second
// dedup window will be suppressed by triggerScan, avoiding redundant work
// stacking up on top of a just-launched scan.
func (w *Watcher) NoteExternalScan(libraryID int64) {
	w.lastScanTime.Store(libraryID, time.Now())
}

// triggerScan fires the onChange callback for a library, but suppresses
// duplicate triggers within 30 seconds. This prevents both the periodic
// timer and fsnotify debounce from firing scans nearly simultaneously,
// and also catches scans launched externally via NoteExternalScan.
func (w *Watcher) triggerScan(lib *models.Library) {
	now := time.Now()
	if last, ok := w.lastScanTime.Load(lib.ID); ok {
		if now.Sub(last.(time.Time)) < 30*time.Second {
			slog.Debug("scan trigger suppressed (recent trigger)", "library", lib.Name)
			return
		}
	}
	w.lastScanTime.Store(lib.ID, now)
	if w.onChange != nil {
		w.onChange(lib)
	}
}

// periodicScanLoop triggers onChange for all watched libraries on each tick.
// It exits when the ticker is stopped or when scanDone is closed.
//
// DESIGN NOTE — periodic scans do NOT proactively bust recommender
// caches. The scanner adds/updates media_items rows but the hero pool,
// Discover rails, and reason cache continue serving their 24h-cached
// snapshots until natural TTL expiry. This is intentional: a periodic
// scan that finds zero new items shouldn't thrash caches that are
// otherwise valid, and a scan that DOES find new items can wait up
// to 24h to enter rotation (recommendations are inherently a slow-
// changing surface — a freshly-added title in someone's library
// doesn't need to appear in their hero rail within minutes).
//
// The watch-progress handler is the explicit cache-bust trigger
// (calls hero.Invalidate when the user marks something watched).
// That's the right axis for cache freshness — taste changes faster
// than catalog changes, and the user expects "what I just watched"
// to influence "what gets recommended next." Bug-bash May 14 noted
// this asymmetry; documented here so a future maintainer doesn't
// "fix" by adding an Invalidate call from periodic scan completion.
func (w *Watcher) periodicScanLoop(ticker *time.Ticker) {
	for {
		select {
		case <-ticker.C:
			w.mu.Lock()
			// Verify this ticker is still the active one (SetScanInterval
			// may have replaced it with a new ticker while we were waiting).
			if w.scanTicker != ticker {
				w.mu.Unlock()
				return
			}
			libs := make([]*models.Library, 0, len(w.watching))
			for _, lw := range w.watching {
				libs = append(libs, lw.library)
			}
			w.mu.Unlock()

			for _, lib := range libs {
				slog.Info("periodic scan triggered", "library", lib.Name)
				w.triggerScan(lib)
			}
		case <-w.scanDone:
			return
		}
	}
}

// WatchLibrary starts watching all paths for a library.
//
// Concurrency: the slow filesystem walk + per-directory inotify registration
// runs WITHOUT holding w.mu so multiple WatchLibrary calls can proceed in
// parallel (this matters at boot when each library's walk takes minutes on
// large trees). The lock is taken only to atomically swap the new watch
// entry in, evicting any previous entry for the same library ID.
func (w *Watcher) WatchLibrary(ctx context.Context, lib *models.Library) error {
	// Build the fsnotify watcher and register all directories first — no
	// shared state is touched here, so no lock is needed.
	//
	// A failure here does NOT abandon the library. w.watching is also what
	// periodicScanLoop iterates, so returning early left the library out of the
	// periodic tick as well as out of file watching — and for a caller replacing
	// an existing entry (the retype), the choice was between keeping a stale
	// snapshot that rescans under the wrong type and dropping the library from
	// automatic scanning entirely. Neither is right. The entry is installed with
	// the CURRENT value either way; only the fsnotify half is lost, and the
	// sentinel says exactly that.
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		w.installWatch(ctx, lib, nil)
		slog.Warn("file-event watching unavailable; library still scans on the periodic tick",
			"library", lib.Name, "id", lib.ID, "error", err)
		return fmt.Errorf("%w: %v", ErrFSWatchUnavailable, err)
	}
	for _, rootPath := range lib.Paths {
		if err := addDirRecursive(watcher, rootPath); err != nil {
			slog.Warn("watch path failed", "path", rootPath, "error", err)
		}
	}

	watchCtx, lw := w.installWatch(ctx, lib, watcher)
	slog.Info("file watcher started", "library", lib.Name, "id", lib.ID)
	go w.watchLoop(watchCtx, watcher, lw)

	return nil
}

// ErrFSWatchUnavailable means file-event watching could not be started, but the
// library IS registered and will still be scanned on the periodic tick with the
// value passed in. Callers should not treat it as "not watched".
var ErrFSWatchUnavailable = errors.New("file-event watching unavailable")

// installWatch atomically swaps this library's watch entry. Split out so the
// fsnotify-less path registers the library exactly the same way, which is what
// keeps the periodic tick working when file watching cannot start.
func (w *Watcher) installWatch(ctx context.Context, lib *models.Library, _ *fsnotify.Watcher) (context.Context, *libraryWatch) {
	watchCtx, cancel := context.WithCancel(ctx)
	lw := &libraryWatch{
		library: lib,
		cancel:  cancel,
	}

	// Atomic swap: evict any existing entry for this library, install the new one.
	// 2026-05-19 audit (BE-H2) — new generation per install. The
	// previous entry's debounce closures captured the old generation
	// and now skip when they fire (see watchLoop's generation check).
	w.mu.Lock()
	if existing, ok := w.watching[lib.ID]; ok {
		existing.cancel()
		if existing.debounce != nil {
			existing.debounce.Stop()
		}
		lw.generation = existing.generation + 1
	}
	w.watching[lib.ID] = lw
	w.mu.Unlock()
	return watchCtx, lw
}

// WatchedLibrary returns a COPY of the library value the watcher currently holds
// for this id, or nil when it is not watched.
//
// The copy matters and so does the existence of this accessor. WatchLibrary
// stores the *models.Library it is handed as a snapshot, and that snapshot is
// what periodicScanLoop and the fsnotify debounce hand to ScanLibrary — which
// branches on lib.Type rather than re-reading the database. So an operation that
// changes a library's type has to re-point the watcher, and until this existed
// there was no way to assert from outside the package that it had.
func (w *Watcher) WatchedLibrary(libraryID int64) *models.Library {
	w.mu.Lock()
	defer w.mu.Unlock()
	lw, ok := w.watching[libraryID]
	if !ok || lw.library == nil {
		return nil
	}
	cp := *lw.library
	// Paths is a slice: a shallow copy aliases the watcher's live snapshot, so a
	// caller writing cp.Paths[i] would corrupt what periodicScanLoop hands
	// ScanLibrary. Cheap to clone, and it makes "COPY" true rather than
	// true-of-the-scalars.
	cp.Paths = slices.Clone(lw.library.Paths)
	return &cp
}

// UnwatchLibrary stops watching a library.
func (w *Watcher) UnwatchLibrary(libraryID int64) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if lw, ok := w.watching[libraryID]; ok {
		lw.cancel()
		if lw.debounce != nil {
			lw.debounce.Stop()
		}
		delete(w.watching, libraryID)
		w.lastScanTime.Delete(libraryID)
		slog.Info("file watcher stopped", "library_id", libraryID)
	}
}

// StopAll stops all watchers and the periodic scan ticker.
func (w *Watcher) StopAll() {
	w.mu.Lock()
	defer w.mu.Unlock()

	for id, lw := range w.watching {
		lw.cancel()
		if lw.debounce != nil {
			lw.debounce.Stop()
		}
		delete(w.watching, id)
		w.lastScanTime.Delete(id)
	}

	if w.scanTicker != nil {
		w.scanTicker.Stop()
		w.scanTicker = nil
	}

	// Signal all periodic scan goroutines to stop, then REPLACE the channel
	// so a later SetScanInterval can spawn a fresh loop. The comment used to
	// claim this was "reset for reuse" but it wasn't actually replacing —
	// the closed channel persisted, so any future periodicScanLoop received
	// immediately on <-w.scanDone and exited on its first iteration.
	old := w.scanDone
	w.scanDone = make(chan struct{})
	select {
	case <-old:
		// Already closed by a previous StopAll; nothing to do.
	default:
		close(old)
	}

	slog.Info("all file watchers stopped")
}

func (w *Watcher) watchLoop(ctx context.Context, watcher *fsnotify.Watcher, lw *libraryWatch) {
	defer watcher.Close()

	for {
		select {
		case <-ctx.Done():
			return

		case event, ok := <-watcher.Events:
			if !ok {
				return
			}

			// When filesystem watching is disabled via admin toggle,
			// silently discard all events. The goroutine stays alive
			// so re-enabling is instant (no teardown/restart needed).
			if !w.fsWatchEnabled.Load() {
				continue
			}

			if !isRelevantEvent(event) {
				continue
			}

			slog.Debug("file change detected",
				"op", event.Op.String(),
				"path", event.Name,
				"library", lw.library.Name,
			)

			// Debounce: reset timer on every event, fire after quiet period.
			// This handles bulk copy operations where hundreds of files land at once.
			w.mu.Lock()
			if lw.debounce != nil {
				lw.debounce.Stop()
			}
			lib := lw.library
			libID := lib.ID
			// 2026-05-19 audit (BE-H2) — capture the watch entry's
			// generation. On fire, re-verify the watching[libID]
			// matches the SAME generation we were scheduled under.
			// Prevents the closure from triggering a scan against a
			// re-created library entry (delete + re-add with same ID).
			gen := lw.generation
			lw.debounce = time.AfterFunc(w.cfg.WatchDebounce, func() {
				w.mu.Lock()
				current, stillWatched := w.watching[libID]
				w.mu.Unlock()
				if !stillWatched {
					slog.Debug("debounce fired for unwatched library, skipping", "library_id", libID)
					return
				}
				if current.generation != gen {
					slog.Debug("debounce fired for replaced library entry, skipping",
						"library_id", libID, "scheduled_gen", gen, "current_gen", current.generation)
					return
				}
				slog.Info("file changes settled, triggering rescan", "library", lib.Name)
				w.triggerScan(lib)
			})
			w.mu.Unlock()

			// If a new directory was created, start watching it too
			if event.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					_ = addDirRecursive(watcher, event.Name)
				}
			}

		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			slog.Error("file watcher error", "error", err, "library", lw.library.Name)
		}
	}
}

func isRelevantEvent(event fsnotify.Event) bool {
	relevantOps := event.Op&(fsnotify.Create|fsnotify.Remove|fsnotify.Rename) != 0
	if !relevantOps {
		return false
	}
	if IsVideoFile(event.Name) {
		return true
	}
	// New directory could be a movie folder or season folder
	if event.Op&fsnotify.Create != 0 {
		if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
			return true
		}
	}
	return false
}

// addDirRecursive adds a directory and all subdirectories to the watcher.
func addDirRecursive(watcher *fsnotify.Watcher, root string) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // Skip inaccessible paths
		}
		if d.IsDir() {
			if watchErr := watcher.Add(path); watchErr != nil {
				slog.Debug("could not watch dir", "path", path, "error", watchErr)
			}
		}
		return nil
	})
}
