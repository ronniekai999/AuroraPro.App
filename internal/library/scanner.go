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
}

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
			slog.Warn("walk incomplete: unreadable entries — prune scoped around them",
				"path", rootPath, "unreadable", len(unreadable), "paths", unreadable)
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
	// Surface incomplete walks on the status API: a persistently
	// unreadable entry (root-owned lost+found, NAS .snapshots) disables
	// the prune on EVERY scan, and a log line is the wrong place for the
	// only evidence of that.
	progress.WalkErrors = len(unreadablePaths)
	progress.PruneSkipped = walkFailed
	// Surface WHICH paths are unreadable, bounded for display. Without this
	// the only evidence is a log line, which is how one folder disabled TV
	// pruning for three days unnoticed.
	progress.UnreadablePaths = boundedPaths(unreadablePaths, 10)
	s.mu.Unlock()
	notify()

	slog.Info("files discovered", "library", lib.Name, "count", len(allFiles))

	// Phase 1b: Prune files that exist in the DB but are no longer on disk.
	// This handles the case where a user deletes a file between scans —
	// without this step, the stale DB row would persist indefinitely.
	//
	// deep-debug H9 — only prune when EVERY path walked cleanly. A transient
	// mount/permission failure (NFS/SMB unmounted, removable drive absent)
	// makes collectVideoFiles error for that path, leaving allFiles missing
	// its entries; pruning then would delete every DB file row under it. Skip
	// pruning entirely on any walk error rather than risk wiping the catalog.
	if walkFailed {
		slog.Warn("skipping prune: one or more library paths failed to walk (transient mount/permission issue?) — leaving DB file rows intact",
			"library", lib.Name)
	} else {
		pruned, pruneErr := s.pruneDeletedFiles(ctx, lib, allFiles, unreadablePaths)
		if pruneErr != nil {
			slog.Error("prune deleted files failed", "library", lib.Name, "error", pruneErr)
		} else if pruned > 0 {
			slog.Info("pruned deleted files", "library", lib.Name, "count", pruned)
		}

		// Phase 1c: Sweep away catalog entries whose last file just
		// disappeared. After the file prune above, a movie/show with zero
		// remaining files is the "no files available" ghost the UI would
		// otherwise show indefinitely (the user deleted the title from disk,
		// but its metadata shell lingers). Remove the shell too.
		//
		// Gated by the SAME safety conditions as the prune: we're already in
		// the !walkFailed branch, and we additionally require a non-empty walk
		// (len(allFiles) > 0) — mirroring pruneDeletedFiles' zero-discovered
		// guard — so a transient empty mount can never trigger a catalog wipe.
		if len(allFiles) > 0 {
			removed, cleanErr := s.queries.DeleteEmptyMediaItems(ctx, lib.ID)
			if cleanErr != nil {
				slog.Error("prune empty media items failed", "library", lib.Name, "error", cleanErr)
			} else if len(removed) > 0 {
				for _, it := range removed {
					slog.Info("removed media item with no remaining files",
						"id", it.ID, "title", it.Title, "library", lib.Name)
				}
				slog.Info("pruned empty media items", "library", lib.Name, "count", len(removed))
			}
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

// pruneDeletedFiles removes DB rows for files no longer on disk.
//
// unreadablePaths lists subtrees the walk could not read. Rows under those
// paths are SKIPPED rather than pruned: their files may well still exist, we
// simply could not see them, and deleting them would be data loss driven by a
// permission error. Everything outside those subtrees walked cleanly and is
// pruned normally — which is the difference between one bad folder disabling
// cleanup for a whole library and it disabling cleanup only for itself.
func (s *Scanner) pruneDeletedFiles(ctx context.Context, lib *models.Library, discoveredFiles []string, unreadablePaths []string) (int64, error) {
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
		return 0, nil
	}
	// Build a set of discovered paths for O(1) lookup
	discovered := make(map[string]struct{}, len(discoveredFiles))
	for _, fp := range discoveredFiles {
		discovered[fp] = struct{}{}
	}

	isTV := lib.Type == models.LibraryShows
	var pruned int64

	if isTV {
		dbPaths, err := s.queries.GetEpisodeFilePathsForLibrary(ctx, lib.ID)
		if err != nil {
			return 0, err
		}
		var staleIDs []int64
		shielded := 0
		for path, id := range dbPaths {
			if _, exists := discovered[path]; exists {
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
		if len(staleIDs) > 0 {
			n, err := s.queries.DeleteEpisodeFilesByIDs(ctx, staleIDs)
			if err != nil {
				return 0, err
			}
			pruned = n
		}
	} else {
		dbPaths, err := s.queries.GetMediaFilePathsForLibrary(ctx, lib.ID)
		if err != nil {
			return 0, err
		}
		var staleIDs []int64
		shielded := 0
		for path, id := range dbPaths {
			if _, exists := discovered[path]; exists {
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
		if len(staleIDs) > 0 {
			n, err := s.queries.DeleteMediaFilesByIDs(ctx, staleIDs)
			if err != nil {
				return 0, err
			}
			pruned = n
		}
	}

	return pruned, nil
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
