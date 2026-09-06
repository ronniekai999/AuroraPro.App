package library

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

const batchFlushSize = 100

type pendingEnrichItem struct {
	item     *models.MediaItem
	filePath string
	// episodeBackfillOnly marks a show whose canonical row already existed
	// (so full enrichment is skipped) but which gained new episode files this
	// scan. Only the episode-level metadata pass runs for these — otherwise
	// episodes added to an already-enriched show stay bare forever.
	episodeBackfillOnly bool
	// season is the season number of the new episode file (backfill entries
	// only). Collected per show so the backfill fetches just the touched
	// seasons instead of every season of the show.
	season int
}

// episodeBackfillEntry aggregates a scan's new episode files per show: one
// entry per media item, with the union of touched season numbers. Built via
// addPendingBackfill so a 400-file season-pack import queues one entry, not
// 400.
type episodeBackfillEntry struct {
	item    *models.MediaItem
	seasons map[int]struct{}
}

// addPendingBackfill merges a backfill signal into the per-show map. Caller
// holds the map's lock.
func addPendingBackfill(m map[int64]*episodeBackfillEntry, item *models.MediaItem, season int) {
	e := m[item.ID]
	if e == nil {
		e = &episodeBackfillEntry{item: item, seasons: make(map[int]struct{})}
		m[item.ID] = e
	}
	if season > 0 {
		e.seasons[season] = struct{}{}
	}
}

// sortedSeasons returns the entry's touched seasons in ascending order.
func (e *episodeBackfillEntry) sortedSeasons() []int {
	out := make([]int, 0, len(e.seasons))
	for sn := range e.seasons {
		out = append(out, sn)
	}
	sort.Ints(out)
	return out
}

type Scanner struct {
	cfg     config.ScannerConfig
	queries *db.Queries

	mu       sync.RWMutex
	progress map[int64]*models.ScanProgress

	// Batch collectors for file inserts (protected by batchMu)
	batchMu        sync.Mutex
	movieFileBuf   []*models.MediaFile
	episodeFileBuf []*models.EpisodeFile

	// enrichedItems tracks media item IDs already enriched during the current scan
	// to prevent redundant TMDB/TVDB API calls (e.g., 100 episodes of the same show).
	// Stored as an atomic pointer so that resetting between scans is safe even when
	// a concurrent scan of a different library has workers still reading the old map.
	enrichedItems atomic.Pointer[sync.Map]

	// showLocks provides per-show serialization during scanning.
	// Key: "libraryID:showTitle" (lowercased).
	// Purpose: Enrichment can mutate the media_items unique key (e.g., setting the
	// year from TMDB), causing subsequent UpsertMediaItem calls to create a duplicate
	// row instead of hitting the ON CONFLICT path. When the enricher detects the
	// duplicate and merges (deletes) it, goroutines that already resolved the
	// now-deleted ID get FK violations on tv_seasons/tv_episodes inserts.
	// Holding a per-show lock through the entire upsert+season+episode+enrichment
	// flow prevents this race.
	showLocks sync.Map // map[string]*sync.Mutex

	// OnNewItem is called after a new media item is upserted during scan.
	// The enricher hooks into this to trigger TMDB lookups inline.
	OnNewItem func(ctx context.Context, item *models.MediaItem)

	// OnNewItemByID is called when an .nfo file provides an explicit TMDB ID,
	// bypassing the search/match pipeline entirely.
	OnNewItemByID func(ctx context.Context, item *models.MediaItem, tmdbID int)

	// OnNewItemByTVDBID is called when an .nfo file provides a TVDB ID (but no TMDB ID).
	OnNewItemByTVDBID func(ctx context.Context, item *models.MediaItem, tvdbID int)

	// OnEpisodeBackfill is called for shows whose canonical row already
	// existed when a scan added new episode files. The enricher hooks into
	// this to populate episode-level TMDB metadata for the new rows without
	// re-running the full show match. seasons lists the season numbers the
	// scan touched (empty ⇒ refresh all seasons).
	OnEpisodeBackfill func(ctx context.Context, item *models.MediaItem, seasons []int)

	// OnScanComplete fires once per ScanLibrary call after the scan
	// finished SUCCESSFULLY (not on failure), regardless of which
	// entry point started it (API handler, watcher, periodic timer).
	// The Smart Skip worker hooks this to sweep for unanalyzed files.
	// Must be cheap/non-blocking — it runs on the scan goroutine.
	OnScanComplete func(lib *models.Library)

	// repointed records libraries whose paths were just changed by an admin,
	// keyed by library ID and holding the paths they were changed TO. See
	// NoteRepointed.
	repointedMu sync.Mutex
	repointed   map[int64][]string
}

// prunePlan is what a scan does about files recorded in the DB but absent
// from this walk.
type prunePlan int

const (
	prunePlanNow       prunePlan = iota // ordinary scan: absence means deletion
	prunePlanRelocated                  // the library moved: delete nothing
	prunePlanSkip                       // no usable evidence either way
)

func (p prunePlan) String() string {
	switch p {
	case prunePlanNow:
		return "prune-now"
	case prunePlanRelocated:
		return "relocated"
	default:
		return "skip"
	}
}

// planPrune chooses between those three from what is known BEFORE the walk's
// rows are read. The data-derived relocation check cannot be an input here —
// it needs the recorded paths, which only pruneDeletedFiles fetches — so a
// prunePlanNow can still be turned into prunePlanRelocated by that check.
//
// Extracted so the branch is pinned by a table rather than mirrored in a test:
// ScanLibrary needs a live Postgres and a real directory tree, so a mutation
// that dropped the relocation arm entirely would otherwise pass the suite.
func planPrune(walkFailed, markedRepointed bool) prunePlan {
	switch {
	case walkFailed:
		// An unwalkable root says nothing about any row under it. This
		// predates the relocation work (deep-debug H9) and outranks it.
		return prunePlanSkip
	case markedRepointed:
		return prunePlanRelocated
	default:
		return prunePlanNow
	}
}

// noteRelocationSkip logs a relocation the scan will not act on, and says what
// the operator has to do about it.
//
// A relocated library DELETES NOTHING — not the file rows, not the items. An
// earlier design pruned the stale rows after phase 2 had attached the new
// ones, which is correct only if the rescan re-matches each file to the SAME
// media_items row. It does not, routinely: UpsertMediaItem keys on
// (library_id, type, title, year) parsed from the FILENAME, while the stored
// row carries whatever TMDB enrichment last wrote. A row saying
// title="Seven", year=1995 whose folder reads "Se7en (1995)" re-keys to a NEW
// item, and the old one — holding the watch progress, ratings, feedback,
// taste seeds and embedding — is then swept as empty. A show with a NULL
// stored year does the same with no enrichment drift at all. Both were
// reproduced against a real database.
//
// So the rows move with the LIBRARY instead, in the same transaction as the
// path change (see the API's planPathRewrites / RepointLibrary). By the time
// a scan runs, a supported repoint has nothing stale left. Reaching here means
// something changed the paths WITHOUT moving the rows — a bare psql UPDATE, a
// restored database — and the honest answer is to stop rather than guess. The
// library is stuck, visibly, until its rows describe where it points; nothing
// is lost, and docs/moving-media-paths.md says how to finish the job.
func noteRelocationSkip(lib *models.Library, why string) {
	slog.Warn("skipping prune: "+why+" — this library's recorded files describe somewhere else, so nothing here is evidence of a deletion. "+
		"Nothing was removed. Its titles will not play until the file rows are moved to the new location too: "+
		"repoint it from Admin > Libraries, or see docs/moving-media-paths.md",
		"library", lib.Name, "paths", lib.Paths)
}

// allPathsOutsideRoots reports whether EVERY recorded path lies outside all of
// the library's current roots — the signature of media that moved rather than
// media that was deleted.
//
// This is the primary relocation guard, and it is derived from the data rather
// than signalled by whoever changed the paths. That matters because the paths
// can change without the API handler: an operator editing `libraries.paths` in
// psql (which the runbook documents for boxes that cannot take a new binary
// yet), a restored database, or a handler-set marker lost to the restart that
// deploys move the library just as effectively as the Edit button, and an
// in-memory signal covers none of those. Re-derived on every scan, so it also
// survives a restart mid-move and cannot be spent by a scan that then fails.
//
// The reasoning is the same one the walkFailed and zero-discovered guards
// already apply: absence from the walk is evidence of deletion only when the
// walk covered where the file was supposed to be. If not one recorded row is
// under a path we actually walked, the walk had nothing to say about any of
// them.
//
// Deliberately ALL and not "most": a library whose media genuinely was deleted
// wholesale should still prune, and one row still under a root is enough to
// show the roots are where this library's files live. That leaves the partial
// move — one root of several changed — to the explicit marker below.
//
// An empty set returns false: there is nothing to prune and nothing to infer.
func allPathsOutsideRoots(dbPaths map[string]int64, roots []string) bool {
	if len(dbPaths) == 0 || len(roots) == 0 {
		return false
	}
	// Clean the roots first. underAnyPrefix compares against root+"/"
	// verbatim, so a root stored with a trailing slash matches nothing and
	// every row reads as "outside" — which disables this library's prune
	// permanently and silently. Reachable through the psql edit the runbook
	// documents, where nothing normalizes what the operator typed.
	clean := make([]string, 0, len(roots))
	for _, r := range roots {
		if r == "" {
			continue
		}
		clean = append(clean, filepath.Clean(r))
	}
	if len(clean) == 0 {
		return false
	}
	for path := range dbPaths {
		if underAnyPrefix(path, clean) {
			return false
		}
	}
	return true
}

// NoteRepointed records that a library's paths were changed to newPaths, so a
// scan that runs with exactly those paths treats absence from the walk as the
// move rather than as deletions.
//
// This is a BACKSTOP, not the mechanism. The supported repoint moves the file
// rows in the same transaction as the path change (see the API's
// planPathRewrites / RepointLibrary), so a scan afterwards has nothing stale
// to reason about. The marker covers what that could not move: a PARTIAL move
// ([A B] to [A C]), where rows still under A stop the data-derived check from
// firing, and rows whose target was not on disk yet when the admin saved.
//
// Keyed on the paths, not a bare flag, because a periodic scan can start
// between the admin's save and the handler's own rescan. Such a scan is still
// running against the OLD paths, and a bare flag would be matched by it.
func (s *Scanner) NoteRepointed(libraryID int64, newPaths []string) {
	s.repointedMu.Lock()
	defer s.repointedMu.Unlock()
	if s.repointed == nil {
		s.repointed = make(map[int64][]string)
	}
	s.repointed[libraryID] = append([]string(nil), newPaths...)
}

// isRepointed reports whether lib has a pending repoint marker for exactly the
// paths it is about to scan. It PEEKS — the marker is cleared by clearRepoint
// only once a scan has actually finished the deferred prune.
//
// Peeking rather than consuming is the whole point. A marker consumed at the
// top of a scan is spent before the work it protects is durable: a walk that
// finds nothing (repointed at a mount still being populated), a scan cancelled
// by the 5-minute auto-deploy, or an error in phase 2 would all burn it and
// hand the NEXT scan an unguarded shot at the catalog. The asymmetry runs one
// way — a marker held too long costs one deferred prune, a marker lost costs
// every user's history — so it is released only on success.
func (s *Scanner) isRepointed(lib *models.Library) bool {
	s.repointedMu.Lock()
	defer s.repointedMu.Unlock()
	want, ok := s.repointed[lib.ID]
	if !ok || len(want) != len(lib.Paths) {
		return false
	}
	for i := range want {
		if want[i] != lib.Paths[i] {
			return false
		}
	}
	return true
}

// clearRepoint releases a library's marker. Called after a scan completes the
// relocation is resolved, and by ForgetRepoint.
func (s *Scanner) clearRepoint(libraryID int64) {
	s.repointedMu.Lock()
	defer s.repointedMu.Unlock()
	delete(s.repointed, libraryID)
}

// ForgetRepoint drops any pending repoint marker for a library. Called when a
// library is deleted so its ID cannot hand a stale deferral to a future
// library that happens to reuse it.
func (s *Scanner) ForgetRepoint(libraryID int64) { s.clearRepoint(libraryID) }

func NewScanner(cfg config.ScannerConfig, queries *db.Queries) *Scanner {
	s := &Scanner{
		cfg:      cfg,
		queries:  queries,
		progress: make(map[int64]*models.ScanProgress),
	}
	s.enrichedItems.Store(&sync.Map{})
	return s
}

func (s *Scanner) GetProgress(libraryID int64) *models.ScanProgress {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if p, ok := s.progress[libraryID]; ok {
		cp := *p
		return &cp
	}
	return &models.ScanProgress{LibraryID: libraryID, Status: models.ScanIdle}
}

// TryStartScan atomically checks if a scan is already running for the library
// and marks it as running if not. Returns false if a scan is already in progress.
func (s *Scanner) TryStartScan(libraryID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p, ok := s.progress[libraryID]; ok && p.Status == models.ScanRunning {
		return false
	}
	now := time.Now()
	s.progress[libraryID] = &models.ScanProgress{
		LibraryID: libraryID,
		Status:    models.ScanRunning,
		StartedAt: &now,
	}
	return true
}

func (s *Scanner) ScanLibrary(ctx context.Context, lib *models.Library, progressCb func(*models.ScanProgress)) error {
	now := time.Now()

	// Retrieve the progress entry (set by TryStartScan or create one for direct callers like watcher)
	s.mu.Lock()
	progress, exists := s.progress[lib.ID]
	if !exists || progress.Status != models.ScanRunning {
		progress = &models.ScanProgress{
			LibraryID: lib.ID,
			Status:    models.ScanRunning,
			StartedAt: &now,
		}
		s.progress[lib.ID] = progress
	}
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		if progress.Error != "" {
			progress.Status = models.ScanFailed
		} else {
			progress.Status = models.ScanComplete
		}
		completed := progress.Status == models.ScanComplete
		s.mu.Unlock()
		if progressCb != nil {
			progressCb(progress)
		}
		if completed && s.OnScanComplete != nil {
			s.OnScanComplete(lib)
		}
	}()

	notify := func() {
		if progressCb != nil {
			s.mu.RLock()
			cp := *progress
			s.mu.RUnlock()
			progressCb(&cp)
		}
	}

	// Reset per-scan dedup tracker so each scan starts fresh.
	// Uses atomic pointer swap so concurrent scans of other libraries
	// that still reference the old map are not affected.
	s.enrichedItems.Store(&sync.Map{})

	slog.Info("scan started", "library", lib.Name, "id", lib.ID, "paths", lib.Paths)

	// Phase 1: Walk all paths and collect video files
	var allFiles []string
	var unreadablePaths []string
	walkFailed := false
	for _, rootPath := range lib.Paths {
		files, unreadable, err := collectVideoFiles(rootPath)
		if err != nil {
			// The ROOT itself is unwalkable (unmounted share, removed drive).
			// Nothing under it can be reasoned about, so the prune stays off
			// for the whole library — this is the catastrophic case the H9
			// guard was written for and it is unchanged.
			slog.Error("walk path failed", "path", rootPath, "error", err)
			walkFailed = true
			continue
		}
		// A walk that "succeeded" but skipped unreadable entries still has an
		// incomplete file list. Previously that disabled the prune for the
		// ENTIRE library: one permission-denied folder
		// (/media/tvshows/CSI - Miami) left every deleted TV episode in the
		// database for three days, with a log line as the only evidence.
		//
		// Now the unreadable subtrees are carried into the prune and excluded
		// there, so the rest of the library — which walked cleanly — is
		// pruned normally.
		if len(unreadable) > 0 {
			// Bounded: this fires on EVERY scan (~200/day) for a persistently
			// unreadable folder, and an unbounded list would put up to 1000
			// paths on each line.
			slog.Warn("walk incomplete: unreadable entries — prune scoped around them",
				"path", rootPath, "unreadable", len(unreadable),
				"paths", boundedPaths(unreadable, 5))
			unreadablePaths = append(unreadablePaths, unreadable...)
		}
		allFiles = append(allFiles, files...)
	}
	// Too many unreadable entries to scope around: at this scale the
	// "everything else walked cleanly" assumption no longer holds, so fall
	// back to the old all-or-nothing behaviour.
	if len(unreadablePaths) >= maxTrackedUnreadable {
		slog.Warn("walk incomplete: too many unreadable entries to scope the prune — skipping it entirely",
			"library", lib.Name, "unreadable", len(unreadablePaths))
		walkFailed = true
	}

	s.mu.Lock()
	progress.TotalFiles = len(allFiles)
	// Surface incomplete walks on the status API. Note these two fields are
	// now INDEPENDENT: unreadable entries (root-owned lost+found, NAS
	// .snapshots, a permission-denied show folder) no longer disable the
	// prune — it is scoped around them — so WalkErrors > 0 with
	// PruneSkipped false is the normal, healthy case. PruneSkipped means the
	// prune was abandoned wholesale: an unwalkable root, or so many unreadable
	// entries that scoping stopped being trustworthy.
	// Does this library carry a marker saying its paths were just changed?
	// PEEKED, never consumed here — see isRepointed. The data-derived
	// relocation check inside pruneDeletedFiles is the primary guard; this
	// only adds the partial-move case it cannot see.
	markedRepointed := s.isRepointed(lib)
	progress.WalkErrors = len(unreadablePaths)
	progress.PruneSkipped = walkFailed || markedRepointed
	// ...and WHICH paths, bounded for display. A log line being the only
	// evidence is how one folder went unnoticed for three days.
	progress.UnreadablePaths = boundedPaths(unreadablePaths, 10)
	s.mu.Unlock()
	notify()

	slog.Info("files discovered", "library", lib.Name, "count", len(allFiles))

	// Phase 1b/1c: prune files that vanished from disk, then sweep away the
	// catalog entries their disappearance emptied. Both are DEFERRED when
	// this scan looks like a relocation.
	//
	// deep-debug H9 — only prune when EVERY path walked cleanly. A transient
	// mount/permission failure (NFS/SMB unmounted, removable drive absent)
	// makes collectVideoFiles error for that path, leaving allFiles missing
	// its entries; pruning then would delete every DB file row under it. Skip
	// pruning entirely on any walk error rather than risk wiping the catalog.
	//
	// The relocation case is why the prune can also run AFTER phase 2 rather
	// than before it. Running it here, on a library whose files just moved,
	// deletes every row (none of them are in this walk) and then the sweep
	// cascades away each media item — the watch history, ratings, feedback,
	// taste seeds and embedding that repointing exists to preserve — moments
	// before phase 2 recreates the same titles under new ids. Deferring until
	// the new rows are attached gets the same stale rows deleted with the
	// items intact, in ONE scan: leaving them for the next scan would mean
	// every title in the library holding a dead path that sorts FIRST in
	// GetMediaFiles (lower id, same version_tag), so nothing would play until
	// that scan ran.
	plan := planPrune(walkFailed, markedRepointed)
	switch plan {
	case prunePlanSkip:
		slog.Warn("skipping prune: one or more library paths failed to walk (transient mount/permission issue?) — leaving DB file rows intact",
			"library", lib.Name)
	case prunePlanRelocated:
		noteRelocationSkip(lib, "this library's paths were just changed")
	default:
		pruned, relocated, pruneErr := s.pruneDeletedFiles(ctx, lib, allFiles, unreadablePaths)
		switch {
		case pruneErr != nil:
			slog.Error("prune deleted files failed", "library", lib.Name, "error", pruneErr)
		case relocated:
			// Every recorded row sits outside the paths we just walked, so
			// this library moved rather than lost its files — reached without
			// anyone having to tell us, which is what covers a psql edit of
			// libraries.paths, a restored database, and a marker lost to the
			// restart that deploys.
			noteRelocationSkip(lib, "every recorded file lies outside this library's current paths")
			s.mu.Lock()
			progress.PruneSkipped = true
			s.mu.Unlock()
		default:
			if pruned > 0 {
				slog.Info("pruned deleted files", "library", lib.Name, "count", pruned)
			}
			// The sweep runs ONLY here — on a scan that pruned with real
			// evidence. See sweepEmptyMediaItems.
			s.sweepEmptyMediaItems(ctx, lib, allFiles)
		}
	}

	// Phase 2: Process files concurrently with bounded goroutines.
	//
	// MED (med-integration #1) — clamp the worker count to a sane minimum.
	// A zero-capacity semaphore (Workers==0) deadlocks: `sem <- struct{}{}`
	// blocks waiting for a receiver, but the receiving goroutine only runs
	// after the send completes, so the first file hangs the scan forever. A
	// negative Workers value panics in make(). Default to 1 (serial) when the
	// configured value is non-positive so the scan always makes progress.
	workers := s.cfg.Workers
	if workers <= 0 {
		slog.Warn("scanner workers misconfigured (<=0); defaulting to 1", "configured", s.cfg.Workers)
		workers = 1
	}
	sem := make(chan struct{}, workers)
	var scannedCount atomic.Int64
	var newCount atomic.Int64
	var wg sync.WaitGroup

	// Local per-scan collections for deferred TV enrichment.
	// TV show enrichment is deferred until all files are processed so that
	// all season/episode rows exist when enrichSeasons() runs. Full
	// enrichments (new shows) and episode backfills (existing shows that
	// gained files) are kept apart: backfills dedup per show at enqueue,
	// and running the fulls first is structural, not an ordering pass.
	var pendingMu sync.Mutex
	var pendingTVEnrich []*pendingEnrichItem
	pendingBackfill := make(map[int64]*episodeBackfillEntry)

	for _, fp := range allFiles {
		if ctx.Err() != nil {
			s.mu.Lock()
			progress.Error = "scan cancelled"
			s.mu.Unlock()
			return ctx.Err()
		}

		wg.Add(1)
		sem <- struct{}{}

		go func(filePath string) {
			defer wg.Done()
			defer func() { <-sem }()

			isNew, pending, err := s.processFile(ctx, lib, filePath)
			if err != nil {
				slog.Error("process file failed", "path", filePath, "error", err)
			}
			if pending != nil {
				pendingMu.Lock()
				if pending.episodeBackfillOnly {
					addPendingBackfill(pendingBackfill, pending.item, pending.season)
				} else {
					pendingTVEnrich = append(pendingTVEnrich, pending)
				}
				pendingMu.Unlock()
			}

			count := scannedCount.Add(1)
			if isNew {
				newCount.Add(1)
			}

			if count%10 == 0 || int(count) == len(allFiles) {
				s.mu.Lock()
				progress.ScannedFiles = int(count)
				progress.NewFiles = int(newCount.Load())
				progress.CurrentFile = filepath.Base(filePath)
				s.mu.Unlock()
				notify()
			}
		}(fp)
	}

	wg.Wait()

	// Clear per-show locks for this library to prevent unbounded growth.
	// All workers are done, so no goroutine holds these locks anymore.
	prefix := fmt.Sprintf("%d:", lib.ID)
	s.showLocks.Range(func(key, _ interface{}) bool {
		if k, ok := key.(string); ok && strings.HasPrefix(k, prefix) {
			s.showLocks.Delete(key)
		}
		return true
	})

	// Flush remaining batched files
	s.flushBatches(ctx)

	// Enrich TV shows after all files are processed.
	// All season/episode rows now exist in the DB, so enrichSeasons() can
	// populate every episode with TMDB metadata (titles, overviews, stills).
	if len(pendingTVEnrich) > 0 || len(pendingBackfill) > 0 {
		slog.Info("enriching TV shows",
			"full", len(pendingTVEnrich), "episode_backfills", len(pendingBackfill))
		// Fulls run before backfills: a full enrichment covers the
		// backfill's work and marks the show in the shared per-scan dedup
		// map, so backfillEpisodeMetadata skips shows enriched this scan
		// (a show gets BOTH kinds of entry when its first file created the
		// row and later files found it existing).
		interrupted := false
		for i, p := range pendingTVEnrich {
			if ctx.Err() != nil {
				slog.Warn("TV enrichment interrupted by context cancellation",
					"completed", i, "remaining", len(pendingTVEnrich)-i+len(pendingBackfill))
				interrupted = true
				break
			}
			s.enrichNewItem(ctx, p.item, p.filePath)
		}
		if !interrupted {
			done := 0
			for _, b := range pendingBackfill {
				if ctx.Err() != nil {
					slog.Warn("episode backfill interrupted by context cancellation",
						"completed", done, "remaining", len(pendingBackfill)-done)
					break
				}
				s.backfillEpisodeMetadata(ctx, b.item, b.sortedSeasons())
				done++
			}
		}
	}

	// Phase 3: the prune deferred above, now that phase 2 has attached the
	// files at their new location. The same call that would have emptied every
	// media item before now finds each one holding its new row, so the stale
	// old-location rows go and the items — with their watch history, ratings
	// and embeddings — stay.
	//
	s.mu.Lock()
	progress.ScannedFiles = len(allFiles)
	progress.NewFiles = int(newCount.Load())
	progress.CurrentFile = ""
	s.mu.Unlock()

	elapsed := time.Since(now)
	slog.Info("scan complete",
		"library", lib.Name,
		"total_files", len(allFiles),
		"new_files", newCount.Load(),
		"duration", elapsed.Round(time.Millisecond),
	)

	return nil
}

// showLockKey returns the per-show lock for a given library+title combination.
// The lock serializes all operations on the same show: UpsertMediaItem, UpsertSeason,
// UpsertEpisode, and enrichment. This prevents the race where enrichment mutates
// the media_items unique key (year), causing concurrent goroutines to create duplicate
// rows that are subsequently merged (deleted), producing FK violations.
func (s *Scanner) showLock(libraryID int64, title string) *sync.Mutex {
	key := fmt.Sprintf("%d:%s", libraryID, strings.ToLower(title))
	actual, _ := s.showLocks.LoadOrStore(key, &sync.Mutex{})
	return actual.(*sync.Mutex)
}

func (s *Scanner) processFile(ctx context.Context, lib *models.Library, filePath string) (bool, *pendingEnrichItem, error) {
	fileHash, fileSize, err := generateFileHash(filePath)
	if err != nil {
		return false, nil, fmt.Errorf("hash file: %w", err)
	}

	isTV := lib.Type == models.LibraryShows

	// Check if file already exists and is unchanged
	var existingHash string
	if isTV {
		existing, err := s.queries.GetEpisodeFileByPath(ctx, filePath)
		if err != nil {
			return false, nil, fmt.Errorf("check existing: %w", err)
		}
		if existing != nil {
			existingHash = existing.FileHash
		}
	} else {
		existing, err := s.queries.GetMediaFileByPath(ctx, filePath)
		if err != nil {
			return false, nil, fmt.Errorf("check existing: %w", err)
		}
		if existing != nil {
			existingHash = existing.FileHash
		}
	}
	if existingHash == fileHash {
		return false, nil, nil
	}
	isNew := existingHash == ""

	// Parse filename to extract metadata
	var parsed ParsedFile
	if isTV {
		parsed = ParseTVPath(filePath)
	} else {
		parsed = ParseMoviePath(filePath)
	}

	if parsed.Title == "" {
		parsed.Title = strings.TrimSuffix(filepath.Base(filePath), filepath.Ext(filePath))
	}

	mediaType := models.MediaMovie
	if isTV {
		mediaType = models.MediaShow
	}

	// For TV shows, serialize all operations on the same show title within a library.
	// This prevents a race condition where:
	//  1. Goroutine A upserts media_item (year=nil, parsed from folder) -> ID 178
	//  2. Goroutine A's enrichment sets year=2016 from TMDB on row 178
	//  3. Goroutine B upserts media_item (year=nil) -> no conflict (178 now has year=2016) -> creates ID 194
	//  4. Goroutine B's enrichment detects tmdb_id collision, merges 194 into 178 (deletes 194)
	//  5. Goroutine C already resolved ID 194, tries UpsertSeason(194,...) -> FK violation
	// The per-show lock ensures only one goroutine at a time runs the full
	// upsert+season+episode+enrichment pipeline for a given show.
	if isTV {
		mu := s.showLock(lib.ID, parsed.Title)
		mu.Lock()
		defer mu.Unlock()
	}

	item := &models.MediaItem{
		LibraryID: lib.ID,
		Type:      mediaType,
		Title:     parsed.Title,
		SortTitle: GenerateSortTitle(parsed.Title),
		Year:      parsed.Year,
	}

	// needsEnrichment tracks whether this media item needs TMDB enrichment.
	// Separate from isNew (which tracks whether the episode FILE is new for
	// progress counting). We skip enrichment when we resolve to an existing
	// canonical item that was already enriched by a prior goroutine.
	needsEnrichment := isNew

	// For TV shows under the per-show lock: check if a canonical row already
	// exists for this (library, type, title) regardless of year. This handles the
	// case where a previous goroutine's enrichment changed the year on the
	// canonical row, which breaks UpsertMediaItem's ON CONFLICT path (it includes
	// COALESCE(year, 0) in the unique key, so year=NULL no longer matches
	// year=2021). Without this check, every episode would create a duplicate row,
	// trigger enrichment, detect the tmdb_id collision, and merge — all wasteful
	// and potentially causing FK violations if the lock isn't held.
	if isTV {
		existing, findErr := s.queries.FindMediaItemByTitle(ctx, lib.ID, string(mediaType), parsed.Title)
		if findErr != nil {
			slog.Warn("find canonical item failed, falling back to upsert", "title", parsed.Title, "error", findErr)
		}
		if existing != nil {
			// Canonical row found — reuse it. Skip UpsertMediaItem entirely to
			// avoid creating a duplicate row that would need to be merged.
			item.ID = existing.ID
			item.AddedAt = existing.AddedAt
			item.UpdatedAt = existing.UpdatedAt
			// The item already exists, so no enrichment needed.
			needsEnrichment = false
		}
	}

	if item.ID == 0 {
		if err := s.queries.UpsertMediaItem(ctx, item); err != nil {
			return false, nil, fmt.Errorf("upsert media item: %w", err)
		}
	}

	// Probe file for codec info
	probeResult, probeErr := Probe(ctx, s.cfg.FFprobePath, filePath)
	if probeErr != nil {
		slog.Debug("ffprobe unavailable", "file", filepath.Base(filePath))
	}

	if isTV {
		// TV: create season → episode → episode_file chain
		seasonNum := parsed.Season
		if seasonNum <= 0 {
			seasonNum = 1 // Default to season 1 if parser couldn't determine
		}
		episodeNum := parsed.Episode
		if episodeNum <= 0 {
			episodeNum = 1
		}

		seasonID, err := s.queries.UpsertSeason(ctx, item.ID, seasonNum)
		if err != nil {
			return false, nil, fmt.Errorf("upsert season: %w", err)
		}

		episodeID, err := s.queries.UpsertEpisode(ctx, seasonID, item.ID, episodeNum)
		if err != nil {
			return false, nil, fmt.Errorf("upsert episode: %w", err)
		}

		ef := &models.EpisodeFile{
			EpisodeID: episodeID,
			Path:      filePath,
			SizeBytes: fileSize,
			FileHash:  fileHash,
			Container: containerFromExt(filePath),
		}
		if probeResult != nil {
			ef.Container = probeResult.Container
			ef.VideoCodec = probeResult.VideoCodec
			ef.AudioCodec = probeResult.AudioCodec
			ef.Resolution = probeResult.Resolution
			ef.Bitrate = probeResult.Bitrate
			ef.DurationMs = probeResult.DurationMs
			ef.AudioTracks = probeResult.AudioTracks
			ef.SubtitleTracks = probeResult.SubtitleTracks
			ef.VideoProfile = probeResult.VideoProfile
			ef.VideoPixFmt = probeResult.VideoPixFmt
			ef.ColorTransfer = probeResult.ColorTransfer
			ef.ColorPrimaries = probeResult.ColorPrimaries
			ef.VideoFPS = probeResult.VideoFPS
		} else if parsed.Resolution != "" {
			ef.Resolution = parsed.Resolution
		}
		ef.VersionTag = ClassifyVersion(ef.Resolution, ef.VideoCodec)

		s.addEpisodeFileBatch(ctx, ef)

		// Flush episode files BEFORE enrichment. Enrichment can trigger a
		// TMDB duplicate merge that deletes this item.ID. If the file is
		// still in the batch buffer when that happens, the deferred flush
		// would try to insert with a deleted episode_id → FK violation.
		s.flushEpisodeFiles(ctx)

		// Defer TV enrichment until after all files are processed.
		// At this point only this episode's season/episode rows exist.
		// enrichSeasons() needs ALL episode rows to populate TMDB metadata
		// for every episode. The deferred pass runs after wg.Wait().
		if needsEnrichment {
			return isNew, &pendingEnrichItem{item: item, filePath: filePath}, nil
		}
		// Canonical show already existed (needsEnrichment=false), but this
		// scan added a NEW episode file. The full-enrichment path won't run
		// for this show, so queue an episode-level backfill or the new
		// episode rows never receive TMDB titles/overviews/stills.
		if isNew {
			return isNew, &pendingEnrichItem{item: item, filePath: filePath, episodeBackfillOnly: true, season: seasonNum}, nil
		}
	} else {
		// Movie: create media_file
		mf := &models.MediaFile{
			MediaItemID: item.ID,
			Path:        filePath,
			SizeBytes:   fileSize,
			FileHash:    fileHash,
			Container:   containerFromExt(filePath),
		}
		if probeResult != nil {
			mf.Container = probeResult.Container
			mf.VideoCodec = probeResult.VideoCodec
			mf.AudioCodec = probeResult.AudioCodec
			mf.Resolution = probeResult.Resolution
			mf.Bitrate = probeResult.Bitrate
			mf.DurationMs = probeResult.DurationMs
			mf.AudioTracks = probeResult.AudioTracks
			mf.SubtitleTracks = probeResult.SubtitleTracks
			mf.VideoProfile = probeResult.VideoProfile
			mf.VideoPixFmt = probeResult.VideoPixFmt
			mf.ColorTransfer = probeResult.ColorTransfer
			mf.ColorPrimaries = probeResult.ColorPrimaries
			mf.VideoFPS = probeResult.VideoFPS
		} else if parsed.Resolution != "" {
			mf.Resolution = parsed.Resolution
		}
		mf.VersionTag = ClassifyVersion(mf.Resolution, mf.VideoCodec)

		s.addMovieFileBatch(ctx, mf)

		// Flush movie files BEFORE enrichment. Enrichment can trigger a
		// TMDB duplicate merge that deletes this item.ID. If the file is
		// still in the batch buffer when that happens, the deferred flush
		// would try to insert with a deleted media_item_id → FK violation.
		s.flushMovieFiles(ctx)

		// Trigger metadata enrichment for new movie items.
		if isNew {
			s.enrichNewItem(ctx, item, filePath)
		}
	}

	return isNew, nil, nil
}

// enrichNewItem triggers metadata enrichment for a newly discovered media item.
// Dedup: skips if this media item was already enriched during the current scan
// (e.g., multiple episodes of the same TV show share one media_item ID).
func (s *Scanner) enrichNewItem(ctx context.Context, item *models.MediaItem, filePath string) {
	if _, alreadyEnriched := s.enrichedItems.Load().LoadOrStore(item.ID, true); alreadyEnriched {
		slog.Debug("skipping duplicate enrichment", "item_id", item.ID, "title", item.Title, "file", filepath.Base(filePath))
		return
	}

	// Check for .nfo file with explicit external IDs (skip search-based matching)
	if nfoPath := FindNFO(filePath); nfoPath != "" {
		if nfo, err := ParseNFO(nfoPath); err == nil && nfo.HasExternalID() {
			if nfo.TMDBID > 0 {
				slog.Debug("nfo provided tmdb id", "file", filepath.Base(filePath), "tmdb_id", nfo.TMDBID)
				if s.OnNewItemByID != nil {
					s.OnNewItemByID(ctx, item, nfo.TMDBID)
				}
				return
			}
			if nfo.TVDBID > 0 {
				slog.Debug("nfo provided tvdb id", "file", filepath.Base(filePath), "tvdb_id", nfo.TVDBID)
				if s.OnNewItemByTVDBID != nil {
					s.OnNewItemByTVDBID(ctx, item, nfo.TVDBID)
				}
				return
			}
		}
	}
	// No NFO with usable ID — fall through to search-based enrichment
	if s.OnNewItem != nil {
		s.OnNewItem(ctx, item)
	}
}

// backfillEpisodeMetadata triggers the episode-level metadata pass for a show
// that already had a canonical row when this scan added new episode files.
// Shares the per-scan dedup map with enrichNewItem so a show fully enriched
// this scan (which already covered its episodes) is skipped.
func (s *Scanner) backfillEpisodeMetadata(ctx context.Context, item *models.MediaItem, seasons []int) {
	if _, alreadyEnriched := s.enrichedItems.Load().LoadOrStore(item.ID, true); alreadyEnriched {
		slog.Debug("skipping duplicate episode backfill", "item_id", item.ID, "title", item.Title)
		return
	}
	if s.OnEpisodeBackfill != nil {
		s.OnEpisodeBackfill(ctx, item, seasons)
	}
}

// boundedPaths returns at most n entries, for surfacing on the status API
// without letting a pathological mount blow up the JSON payload.
func boundedPaths(paths []string, n int) []string {
	if len(paths) <= n {
		return paths
	}
	return paths[:n]
}

// sweepEmptyMediaItems removes catalog entries whose last file just
// disappeared — the "no files available" ghost the UI would otherwise show
// forever. Only ever called immediately after a prune that actually ran, and
// only with a non-empty walk behind it, mirroring pruneDeletedFiles'
// zero-discovered guard: a transient empty mount must never reach this.
func (s *Scanner) sweepEmptyMediaItems(ctx context.Context, lib *models.Library, allFiles []string) {
	if len(allFiles) == 0 {
		return
	}
	removed, err := s.queries.DeleteEmptyMediaItems(ctx, lib.ID)
	if err != nil {
		slog.Error("prune empty media items failed", "library", lib.Name, "error", err)
		return
	}
	if len(removed) == 0 {
		return
	}
	for _, it := range removed {
		slog.Info("removed media item with no remaining files",
			"id", it.ID, "title", it.Title, "library", lib.Name)
	}
	slog.Info("pruned empty media items", "library", lib.Name, "count", len(removed))
}

// pruneDeletedFiles removes DB rows for files no longer on disk.
//
// unreadablePaths lists subtrees the walk could not read. Rows under those
// paths are SKIPPED rather than pruned: their files may well still exist, we
// simply could not see them, and deleting them would be data loss driven by a
// permission error. Everything outside those subtrees walked cleanly and is
// pruned normally — which is the difference between one bad folder disabling
// cleanup for a whole library and it disabling cleanup only for itself.
//
// The second return value means RELOCATED: every recorded path lies outside
// this library's current roots, so it moved rather than lost its files.
// Nothing is pruned in that case — see allPathsOutsideRoots.
func (s *Scanner) pruneDeletedFiles(ctx context.Context, lib *models.Library, discoveredFiles []string, unreadablePaths []string) (int64, bool, error) {
	// deep-debug H9 — refuse to prune when zero files were discovered. The
	// canonical NFS/SMB failure leaves the mountpoint present-but-EMPTY, so
	// collectVideoFiles returns ([], nil) — no error, so the walkFailed guard
	// in ScanLibrary does NOT trip — and pruning against an empty set would
	// delete every file row for the library. Treat zero-discovered as suspect,
	// not authoritative: bail and keep the rows. A genuinely-emptied library
	// just carries stale rows until a scan finds files again (or the operator
	// removes it) — acceptable versus catastrophic, unattended data loss.
	if len(discoveredFiles) == 0 {
		slog.Warn("prune skipped: zero files discovered for library — refusing to delete all file rows (transient mount failure?)", "library", lib.Name)
		return 0, false, nil
	}
	// Build a set of discovered paths for O(1) lookup
	discovered := make(map[string]struct{}, len(discoveredFiles))
	for _, fp := range discoveredFiles {
		discovered[fp] = struct{}{}
	}

	// The library's roots, cleaned. underAnyPrefix compares against root+"/"
	// verbatim, so a trailing slash — reachable through a psql edit, where
	// nothing normalises what the operator typed — would make every row read
	// as outside and silently disable this library's prune for good.
	cleanRoots := make([]string, 0, len(lib.Paths))
	for _, r := range lib.Paths {
		if r != "" {
			cleanRoots = append(cleanRoots, filepath.Clean(r))
		}
	}
	outside := 0

	isTV := lib.Type == models.LibraryShows
	var pruned int64

	if isTV {
		dbPaths, err := s.queries.GetEpisodeFilePathsForLibrary(ctx, lib.ID)
		if err != nil {
			return 0, false, err
		}
		if allPathsOutsideRoots(dbPaths, lib.Paths) {
			slog.Warn("prune skipped: every recorded episode file lies outside this library's current paths — treating it as a relocation, not deletions",
				"library", lib.Name, "paths", lib.Paths, "rows", len(dbPaths))
			return 0, true, nil
		}
		var staleIDs []int64
		shielded := 0
		for path, id := range dbPaths {
			if _, exists := discovered[path]; exists {
				continue
			}
			// A row OUTSIDE the library's current roots was never covered by
			// this walk, so its absence from the results is not evidence of
			// anything. This is the generalisation of the walkFailed and
			// zero-discovered guards, and it is what makes a relocation safe
			// without having to detect one: after a move, every old row sits
			// outside the roots and is simply not a candidate. Deleting them
			// empties their items, and the sweep then cascades away the watch
			// progress, ratings, feedback, taste seeds and embedding — which
			// is what happened, reproducibly, in three consecutive designs.
			if !underAnyPrefix(path, cleanRoots) {
				outside++
				continue
			}
			if underAnyPrefix(path, unreadablePaths) {
				// Absent from the walk only because we could not read its
				// directory — not evidence the file is gone.
				shielded++
				continue
			}
			staleIDs = append(staleIDs, id)
			slog.Info("pruning deleted episode file", "path", path)
		}
		if shielded > 0 {
			slog.Warn("prune: kept rows under unreadable paths", "library", lib.Name,
				"kept", shielded, "unreadable", boundedPaths(unreadablePaths, 5))
		}
		if outside > 0 {
			slog.Warn("prune: kept rows that lie outside this library's current paths — they were never walked, so their absence proves nothing. "+
				"If the media moved, repoint the library from Admin > Libraries (see docs/moving-media-paths.md); nothing has been deleted",
				"library", lib.Name, "kept", outside, "paths", lib.Paths)
		}
		if len(staleIDs) > 0 {
			n, err := s.queries.DeleteEpisodeFilesByIDs(ctx, staleIDs)
			if err != nil {
				return 0, false, err
			}
			pruned = n
		}
	} else {
		dbPaths, err := s.queries.GetMediaFilePathsForLibrary(ctx, lib.ID)
		if err != nil {
			return 0, false, err
		}
		if allPathsOutsideRoots(dbPaths, lib.Paths) {
			slog.Warn("prune skipped: every recorded media file lies outside this library's current paths — treating it as a relocation, not deletions",
				"library", lib.Name, "paths", lib.Paths, "rows", len(dbPaths))
			return 0, true, nil
		}
		var staleIDs []int64
		shielded := 0
		for path, id := range dbPaths {
			if _, exists := discovered[path]; exists {
				continue
			}
			// A row OUTSIDE the library's current roots was never covered by
			// this walk, so its absence from the results is not evidence of
			// anything. This is the generalisation of the walkFailed and
			// zero-discovered guards, and it is what makes a relocation safe
			// without having to detect one: after a move, every old row sits
			// outside the roots and is simply not a candidate. Deleting them
			// empties their items, and the sweep then cascades away the watch
			// progress, ratings, feedback, taste seeds and embedding — which
			// is what happened, reproducibly, in three consecutive designs.
			if !underAnyPrefix(path, cleanRoots) {
				outside++
				continue
			}
			if underAnyPrefix(path, unreadablePaths) {
				shielded++
				continue
			}
			staleIDs = append(staleIDs, id)
			slog.Info("pruning deleted media file", "path", path)
		}
		if shielded > 0 {
			slog.Warn("prune: kept rows under unreadable paths", "library", lib.Name,
				"kept", shielded, "unreadable", boundedPaths(unreadablePaths, 5))
		}
		if outside > 0 {
			slog.Warn("prune: kept rows that lie outside this library's current paths — they were never walked, so their absence proves nothing. "+
				"If the media moved, repoint the library from Admin > Libraries (see docs/moving-media-paths.md); nothing has been deleted",
				"library", lib.Name, "kept", outside, "paths", lib.Paths)
		}
		if len(staleIDs) > 0 {
			n, err := s.queries.DeleteMediaFilesByIDs(ctx, staleIDs)
			if err != nil {
				return 0, false, err
			}
			pruned = n
		}
	}

	return pruned, false, nil
}

// maxTrackedUnreadable bounds how many unreadable paths we remember for
// prune-scoping. Beyond this the caller falls back to skipping the prune for
// the whole library: a mount that fails wholesale should not be handled by
// accumulating a million paths, and at that scale the "everything else walked
// cleanly" assumption the scoping rests on no longer holds.
const maxTrackedUnreadable = 1000

// collectVideoFiles walks root and returns the video files it found plus the
// paths it could NOT read (permission errors, I/O failures, a subtree whose
// mount dropped mid-walk). A non-empty unreadable list means the file list is
// INCOMPLETE for those subtrees — which is what lets the caller prune the rest
// of the library safely instead of skipping the prune wholesale. See
// pruneDeletedFiles.
func collectVideoFiles(root string) ([]string, []string, error) {
	// 2026-05-19 audit (BE-H3) — defend against symlinked files that
	// escape the library root. filepath.WalkDir (Go 1.21+) does NOT
	// follow directory symlinks, but it DOES traverse FILE-level
	// symlinks normally — if a file under root is a symlink to
	// /etc/passwd or anywhere outside root, IsVideoFile() decides
	// based on the symlink name's extension and we'd hash+scan the
	// target. Resolve each candidate and require it to live under
	// the root we were asked to scan; reject otherwise.
	//
	// EvalSymlinks on the root itself ensures the comparison uses the
	// resolved, canonical form (the LibraryHandler already did this on
	// path creation, but defensively re-resolve here so this helper
	// is self-contained).
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, nil, fmt.Errorf("resolve root: %w", err)
	}
	resolvedRoot = filepath.Clean(resolvedRoot)
	var files []string
	var unreadable []string
	noteUnreadable := func(path string) {
		if len(unreadable) < maxTrackedUnreadable {
			unreadable = append(unreadable, filepath.Clean(path))
		}
	}
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			// deep-debug H9 addendum — count the failure instead of silently
			// absorbing it. Returning nil keeps the walk going (we still want
			// to scan every readable file), but the caller must know the file
			// list is incomplete: pruning against a partial list would delete
			// the DB rows for everything under an unreadable subtree.
			// Record WHICH path failed, not just that one did: everything
			// under an unreadable subtree is unknown to the prune, but the
			// rest of the library walked cleanly and is still safe to prune.
			noteUnreadable(path)
			slog.Warn("walk error", "path", path, "error", err)
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !IsVideoFile(path) {
			return nil
		}
		// Resolve the file's path to catch symlink-escapes. A file
		// that's a symlink to something outside the library root
		// must not be processed.
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			// Distinguish "genuinely gone" from "can't verify". A dangling
			// symlink (or a file deleted mid-walk) is safe for the prune to
			// treat as absent. Any other failure (EACCES, EIO) means the
			// file may well still exist — count it so the prune is skipped,
			// otherwise this skip silently shrinks the discovered list and
			// the prune deletes the row of a file that is still on disk.
			if !errors.Is(err, fs.ErrNotExist) {
				noteUnreadable(path)
			}
			slog.Warn("skip: resolve symlink failed", "path", path, "error", err)
			return nil
		}
		resolved = filepath.Clean(resolved)
		if !strings.HasPrefix(resolved, resolvedRoot+string(filepath.Separator)) && resolved != resolvedRoot {
			slog.Warn("skip: symlink escapes library root", "path", path, "resolved", resolved, "root", resolvedRoot)
			return nil
		}
		files = append(files, path)
		return nil
	})
	return files, unreadable, walkErr
}

// underAnyPrefix reports whether path lives at or beneath one of prefixes.
// Compares on path boundaries so "/media/CSI - Miami" does not shield
// "/media/CSI - Miami 2".
func underAnyPrefix(path string, prefixes []string) bool {
	if len(prefixes) == 0 {
		return false
	}
	clean := filepath.Clean(path)
	for _, p := range prefixes {
		if clean == p || strings.HasPrefix(clean, p+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func generateFileHash(path string) (string, int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", 0, err
	}
	data := fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
	hash := sha256.Sum256([]byte(data))
	return fmt.Sprintf("%x", hash[:16]), info.Size(), nil
}

func (s *Scanner) addMovieFileBatch(ctx context.Context, mf *models.MediaFile) {
	s.batchMu.Lock()
	s.movieFileBuf = append(s.movieFileBuf, mf)
	needFlush := len(s.movieFileBuf) >= batchFlushSize
	s.batchMu.Unlock()
	if needFlush {
		s.flushMovieFiles(ctx)
	}
}

func (s *Scanner) addEpisodeFileBatch(ctx context.Context, ef *models.EpisodeFile) {
	s.batchMu.Lock()
	s.episodeFileBuf = append(s.episodeFileBuf, ef)
	needFlush := len(s.episodeFileBuf) >= batchFlushSize
	s.batchMu.Unlock()
	if needFlush {
		s.flushEpisodeFiles(ctx)
	}
}

func (s *Scanner) flushBatches(ctx context.Context) {
	s.flushMovieFiles(ctx)
	s.flushEpisodeFiles(ctx)
}

func (s *Scanner) flushMovieFiles(ctx context.Context) {
	s.batchMu.Lock()
	files := s.movieFileBuf
	s.movieFileBuf = nil
	s.batchMu.Unlock()
	if len(files) == 0 {
		return
	}
	if err := s.queries.BatchInsertMediaFiles(ctx, files); err != nil {
		slog.Error("batch insert media files failed", "count", len(files), "error", err)
	}
}

func (s *Scanner) flushEpisodeFiles(ctx context.Context) {
	s.batchMu.Lock()
	files := s.episodeFileBuf
	s.episodeFileBuf = nil
	s.batchMu.Unlock()
	if len(files) == 0 {
		return
	}
	if err := s.queries.BatchInsertEpisodeFiles(ctx, files); err != nil {
		slog.Error("batch insert episode files failed", "count", len(files), "error", err)
	}
}

// ClassifyVersion determines the quality tier tag for a media file based on
// its resolution string (from ffprobe or parser) and optional video codec.
// Returns one of: "4K", "1080p", "720p", "SD", or "" if unknown.
func ClassifyVersion(resolution, videoCodec string) string {
	if resolution == "" {
		return ""
	}

	res := strings.ToLower(resolution)

	// Check ffprobe format "WIDTHxHEIGHT"
	if parts := strings.SplitN(res, "x", 2); len(parts) == 2 {
		w, errW := strconv.Atoi(parts[0])
		h, errH := strconv.Atoi(parts[1])
		if errW == nil && errH == nil {
			if w >= 3840 || h >= 2160 {
				return "4K"
			}
			if w >= 1920 || h >= 1080 {
				return "1080p"
			}
			if w >= 1280 || h >= 720 {
				return "720p"
			}
			return "SD"
		}
	}

	// Check parser format: "2160p", "4k", "1080p", "720p", etc.
	if strings.Contains(res, "2160") || strings.Contains(res, "4k") {
		return "4K"
	}
	if strings.Contains(res, "1080") {
		return "1080p"
	}
	if strings.Contains(res, "720") {
		return "720p"
	}
	if strings.Contains(res, "480") || strings.Contains(res, "576") || strings.Contains(res, "360") {
		return "SD"
	}

	return ""
}

func containerFromExt(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if len(ext) > 0 {
		return ext[1:]
	}
	return ""
}
