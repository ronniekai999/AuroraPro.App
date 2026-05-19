package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/aurora-media/aurora/internal/api"
	"github.com/aurora-media/aurora/internal/arr"
	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/embedding"
	"github.com/aurora-media/aurora/internal/library"
	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/logging"
	"github.com/aurora-media/aurora/internal/search"
	"github.com/aurora-media/aurora/internal/metadata"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/recommender"
	"github.com/aurora-media/aurora/internal/streaming"
	"github.com/aurora-media/aurora/internal/watchparty"
	ws "github.com/aurora-media/aurora/internal/websocket"
	"golang.org/x/crypto/acme/autocert"
	"gopkg.in/natefinch/lumberjack.v2"
)

var version = "dev"

func main() {
	startTime := time.Now()

	// Bootstrap logger (stdout only) — used until config is loaded
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	slog.Info("Aurora Media Server starting...", "version", version)

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		slog.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	// Set up file-based logging with rotation via lumberjack.
	// If the log directory cannot be created, fall back to stdout-only logging
	// so that a broken LOG_DIR does not cause write errors on every log line.
	logLevel := config.ParseLogLevel(cfg.Logging.Level)
	var fileLogger *lumberjack.Logger
	var logWriter io.Writer = os.Stdout

	if err := os.MkdirAll(cfg.Logging.Dir, 0750); err != nil {
		slog.Warn("failed to create log directory, file logging disabled", "dir", cfg.Logging.Dir, "error", err)
	} else {
		logFilePath := filepath.Join(cfg.Logging.Dir, "aurora.log")
		fileLogger = &lumberjack.Logger{
			Filename:   logFilePath,
			MaxSize:    cfg.Logging.MaxSizeMB,
			MaxBackups: cfg.Logging.MaxBackups,
			MaxAge:     cfg.Logging.MaxAgeDays,
			Compress:   cfg.Logging.Compress,
		}
		logWriter = io.MultiWriter(os.Stdout, fileLogger)
		slog.Info("file logging enabled", "file", logFilePath, "level", cfg.Logging.Level,
			"max_size_mb", cfg.Logging.MaxSizeMB, "max_backups", cfg.Logging.MaxBackups,
			"max_age_days", cfg.Logging.MaxAgeDays, "compress", cfg.Logging.Compress)
	}

	textHandler := slog.NewTextHandler(logWriter, &slog.HandlerOptions{
		Level: logLevel,
	})
	ringLog := logging.NewRingBufferHandler(textHandler, 1000)
	slog.SetDefault(slog.New(ringLog))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Database
	pool, err := db.NewPool(ctx, cfg.Database)
	if err != nil {
		slog.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Run schema migrations
	migrationsDir := findMigrationsDir()
	if migrationsDir != "" {
		if err := db.RunMigrations(ctx, pool, migrationsDir); err != nil {
			slog.Error("failed to run migrations", "error", err)
			os.Exit(1)
		}
	} else {
		slog.Warn("migrations directory not found, skipping")
	}

	// Run data migrations (create default profiles, backfill profile_id)
	if err := db.RunDataMigrations(ctx, pool); err != nil {
		slog.Error("failed to run data migrations", "error", err)
		os.Exit(1)
	}

	// Post-migration smoke test: confirm pgvector is reachable AND
	// hnsw.ef_search is configured. The expected minimum (100) matches
	// migration 018; if the value comes back lower, search/hero recall
	// is silently degraded and the operator needs to know immediately.
	// Non-fatal so installs without pgvector (e.g. test setups) still boot.
	db.VerifyVectorTuning(ctx, pool, 100)

	// Services
	queries := db.NewQueries(pool)
	authSvc := auth.NewService(cfg.Auth)
	scanner := library.NewScanner(cfg.Scanner, queries)
	hub := ws.NewHub(cfg.OriginAllowed)
	activity := api.NewActivityLogger(queries)

	// File watcher: triggers incremental rescan when files change on disk
	watcher := library.NewWatcher(cfg.Scanner, scanner, func(lib *models.Library) {
		// Use TryStartScan to prevent concurrent scans if an API-triggered scan
		// is already running for this library.
		if !scanner.TryStartScan(lib.ID) {
			slog.Info("file watcher skipped rescan (already running)", "library", lib.Name)
			return
		}
		slog.Info("file watcher triggered rescan", "library", lib.Name)
		go scanner.ScanLibrary(context.Background(), lib, func(p *models.ScanProgress) {
			hub.Broadcast(ws.EventScanProgress, p)
			if p.Status == models.ScanComplete && p.NewFiles > 0 {
				hub.Broadcast(ws.EventLibraryUpdate, map[string]interface{}{
					"library_id":   lib.ID,
					"library_name": lib.Name,
					"new_items":    p.NewFiles,
					"action":       "scan_completed",
				})
			}
		})
	})
	defer watcher.StopAll()

	// Start watching all existing libraries — in parallel, off the boot path.
	// Each WatchLibrary call walks the entire directory tree and registers an
	// inotify watch per directory, which can take minutes for libraries with
	// thousands of folders. Detaching to a goroutine lets HTTP start serving
	// immediately; parallelizing across libraries collapses wall time from
	// sum(per-lib) to max(per-lib). Files added during the attach window get
	// picked up by the next periodic scan.
	go func() {
		libs, err := queries.GetLibraries(ctx)
		if err != nil {
			slog.Warn("failed to load libraries for watcher startup", "error", err)
			return
		}
		start := time.Now()
		var wg sync.WaitGroup
		for _, lib := range libs {
			wg.Add(1)
			go func(lib *models.Library) {
				defer wg.Done()
				if err := watcher.WatchLibrary(ctx, lib); err != nil {
					slog.Warn("failed to start file watcher", "library", lib.Name, "error", err)
				}
			}(lib)
		}
		wg.Wait()
		slog.Info("all library watchers attached", "count", len(libs), "elapsed", time.Since(start))
	}()

	// Load saved admin settings for watcher behavior.
	// filesystem_watch_enabled: controls whether fsnotify events trigger scans (default: on)
	if fsWatch, err := queries.GetSetting(ctx, "filesystem_watch_enabled"); err == nil && fsWatch == "false" {
		watcher.SetFSWatchEnabled(false)
	}
	// scan_interval_default: periodic scan interval in seconds (default: 6 hours)
	// A saved value of "0" means explicitly disabled; only default to 6h when no setting exists.
	if intervalStr, err := queries.GetSetting(ctx, "scan_interval_default"); err == nil && intervalStr != "" {
		if n, err := strconv.Atoi(intervalStr); err == nil {
			if n > 0 {
				watcher.SetScanInterval(time.Duration(n) * time.Second)
			}
			// n == 0 means admin explicitly disabled periodic scanning
		}
	} else {
		// No saved setting — enable periodic scanning at default 6-hour interval
		watcher.SetScanInterval(6 * time.Hour)
	}

	// Rate limiter for public auth endpoints
	authLimiter := auth.NewRateLimiter(10, time.Minute)
	defer authLimiter.Stop()

	// Phase 2: TMDB metadata client
	tmdbClient := metadata.NewTMDBClient(cfg.TMDB.APIKey, cfg.TMDB.Language)

	// Phase 2: TVDB client (optional fallback for TV shows)
	var tvdbClient *metadata.TVDBClient
	if cfg.TVDB.Enabled && cfg.TVDB.APIKey != "" {
		tvdbClient = metadata.NewTVDBClient(cfg.TVDB.APIKey, cfg.TVDB.PIN, cfg.TVDB.Language)
		slog.Info("TVDB fallback enabled")
	}

	// Phase 2: Image proxy (caches TMDB images locally)
	imgProxy, err := metadata.NewImageProxy(cfg.Cache.ImageDir)
	if err != nil {
		slog.Error("failed to create image proxy", "error", err)
		os.Exit(1)
	}
	// 2026-05-19 audit (BE-M7) — background eviction. Runs once per
	// hour; cheap when already under cap. Keeps the on-disk image
	// cache bounded against a buggy TMDB feed or stress test that
	// bursts thousands of unique URLs and exhausts the disk.
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			if freed, removed, err := imgProxy.EvictIfOverCap(); err != nil {
				slog.Warn("image cache evict failed", "error", err)
			} else if removed > 0 {
				slog.Info("image cache evicted", "files_removed", removed, "bytes_freed", freed)
			}
		}
	}()

	enricher := metadata.NewEnricher(tmdbClient, tvdbClient, queries, imgProxy)
	enricher.SetThresholds(cfg.TMDB.AutoMatchThreshold, cfg.TMDB.ReviewThreshold)

	// Phase 5: Local LLM client + per-item embedder for semantic search.
	// When LLM_ENABLED=false (or Ollama is unreachable at startup) we leave
	// `embedder` nil so the scanner hooks below skip embedding silently and
	// the rest of the system keeps working with trigram search only.
	var embedder *embedding.Embedder
	var semanticSearcher *search.Searcher
	var heroRecommender *recommender.Hero
	var llmClient *llm.Client
	if cfg.LLM.Enabled {
		// Apply any DB-stored overrides on top of env/yaml config. Precedence:
		// DB row (existing, even if empty) > env > yaml default. The "existing
		// but empty" case is an intentional explicit clear from the admin UI.
		llmCfg := llm.Config{
			BaseURL:     cfg.LLM.OllamaURL,
			EmbedModel:  cfg.LLM.EmbedModel,
			ChatModel:   cfg.LLM.ChatModel,
			Dims:        cfg.LLM.EmbedDims,
			HTTPTimeout: cfg.LLM.HTTPTimeout,
		}
		applyLLMOverrides(ctx, queries, &llmCfg)
		llmClient = llm.NewClient(llmCfg)
		// Best-effort liveness check — do not block startup if Ollama is slow
		// to come up; the backfill goroutine will retry on its own.
		pingCtx, pingCancel := context.WithTimeout(ctx, 5*time.Second)
		if err := llmClient.Ping(pingCtx); err != nil {
			slog.Warn("ollama not reachable at startup; semantic search will activate when it comes up",
				"url", cfg.LLM.OllamaURL, "error", err)
		} else {
			slog.Info("ollama reachable", "url", cfg.LLM.OllamaURL,
				"embed_model", cfg.LLM.EmbedModel, "chat_model", cfg.LLM.ChatModel)
		}
		pingCancel()

		embedder = embedding.New(llmClient, queries, cfg.LLM.BackfillWorkers, cfg.LLM.BackfillBatch)
		semanticSearcher = search.New(llmClient, queries)
		heroRecommender = recommender.New(queries, llmClient)

		// One-shot backfill of any items missing/outdated embeddings. Runs in
		// the background so it doesn't block HTTP startup; ctx cancel stops it.
		go embedder.RunBackfill(ctx)
	} else {
		slog.Info("LLM disabled (LLM_ENABLED=false); skipping embedding subsystem")
	}

	// Phase 2: Transcode manager (HLS transcoding sessions)
	transcode, err := streaming.NewTranscodeManager(cfg.Cache.TranscodeDir, cfg.Transcode)
	if err != nil {
		slog.Error("failed to create transcode manager", "error", err)
		os.Exit(1)
	}

	// Wire transcode session events to admin WebSocket broadcasts
	transcode.OnSessionEvent = func(eventType string, data interface{}) {
		hub.BroadcastToAdmins(ws.EventTranscodeStatus, data)
	}

	// embedItem is invoked after each successful enrichment path below. It
	// regenerates the semantic-search vector so newly-imported content is
	// findable by natural-language query immediately, not on the next backfill.
	// No-op when the LLM subsystem is disabled.
	embedItem := func(ctx context.Context, item *models.MediaItem) {
		if embedder == nil {
			return
		}
		if err := embedder.EmbedItem(ctx, item); err != nil {
			slog.Warn("inline embedding failed", "item", item.Title, "error", err)
		}
	}

	// Phase 2: Hook scanner into enricher so new items get TMDB metadata inline
	scanner.OnNewItem = func(ctx context.Context, item *models.MediaItem) {
		score, err := enricher.EnrichMediaItem(ctx, item)
		if err != nil {
			slog.Warn("inline enrichment failed", "item", item.Title, "error", err)
		} else if score > 0 {
			slog.Info("enriched new item", "item", item.Title, "confidence", score)
		}
		embedItem(ctx, item)
	}

	// NFO support: when an .nfo file provides an explicit TMDB ID, skip search
	scanner.OnNewItemByID = func(ctx context.Context, item *models.MediaItem, tmdbID int) {
		score, err := enricher.EnrichByTMDBID(ctx, item, tmdbID, string(item.Type))
		if err != nil {
			slog.Warn("nfo enrichment failed", "item", item.Title, "tmdb_id", tmdbID, "error", err)
		} else {
			slog.Info("enriched via nfo", "item", item.Title, "tmdb_id", tmdbID, "confidence", score)
		}
		embedItem(ctx, item)
	}

	// NFO support: when an .nfo file provides a TVDB ID (but no TMDB ID)
	scanner.OnNewItemByTVDBID = func(ctx context.Context, item *models.MediaItem, tvdbID int) {
		if enricher.TVDBEnabled() {
			score, err := enricher.EnrichByTVDBID(ctx, item, tvdbID)
			if err != nil {
				slog.Warn("nfo tvdb enrichment failed", "item", item.Title, "tvdb_id", tvdbID, "error", err)
			} else {
				slog.Info("enriched via nfo (tvdb)", "item", item.Title, "tvdb_id", tvdbID, "confidence", score)
			}
		} else {
			slog.Warn("nfo has tvdb id but tvdb is disabled", "item", item.Title, "tvdb_id", tvdbID)
		}
		embedItem(ctx, item)
	}

	// Background cleanup of expired/revoked refresh tokens (hourly)
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				purged, err := queries.PurgeExpiredTokens(context.Background())
				if err != nil {
					slog.Error("token cleanup failed", "error", err)
				} else if purged > 0 {
					slog.Info("purged expired tokens", "count", purged)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// Background cleanup of old activity log entries (daily, keep 90 days)
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				purged, err := queries.PurgeOldActivity(context.Background(), 90*24*time.Hour)
				if err != nil {
					slog.Error("activity log cleanup failed", "error", err)
				} else if purged > 0 {
					slog.Info("purged old activity entries", "count", purged)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// Phase 2: Background metadata refresh (checks for stale metadata periodically)
	go func() {
		// Initial enrichment pass: enrich any items that have never had TMDB metadata
		slog.Info("starting initial metadata enrichment pass...")
		if err := enricher.RefreshStaleMetadata(ctx, 0); err != nil {
			slog.Error("initial metadata enrichment failed", "error", err)
		}

		ticker := time.NewTicker(cfg.TMDB.MetadataRefresh)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				slog.Info("refreshing stale metadata...")
				if err := enricher.RefreshStaleMetadata(ctx, cfg.TMDB.MetadataRefresh); err != nil {
					slog.Error("metadata refresh failed", "error", err)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// Phase 2: Background blurhash generation for artwork placeholders
	go func() {
		// Wait a bit for initial enrichment to populate artwork first
		select {
		case <-time.After(30 * time.Second):
		case <-ctx.Done():
			return
		}

		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			filled, err := enricher.BackfillBlurhashes(ctx, imgProxy, 50)
			if err != nil {
				slog.Error("blurhash backfill failed", "error", err)
			} else if filled > 0 {
				slog.Info("blurhash backfill complete", "filled", filled)
			}

			select {
			case <-ticker.C:
			case <-ctx.Done():
				return
			}
		}
	}()

	// Background cleanup of stale subtitle cache files (daily, remove files older than 30 days)
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				subDir := cfg.Cache.SubtitleDir
				entries, err := os.ReadDir(subDir)
				if err != nil {
					continue
				}
				cutoff := time.Now().Add(-30 * 24 * time.Hour)
				var purged int
				for _, e := range entries {
					if e.IsDir() {
						continue
					}
					info, err := e.Info()
					if err != nil {
						continue
					}
					if info.ModTime().Before(cutoff) {
						if os.Remove(filepath.Join(subDir, e.Name())) == nil {
							purged++
						}
					}
				}
				if purged > 0 {
					slog.Info("purged stale subtitle cache files", "count", purged)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// Phase 4: Server health push to admin WebSocket clients
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				var memStats runtime.MemStats
				runtime.ReadMemStats(&memStats)
				// Disk free on transcode directory
				diskFreeGB := api.GetDiskFreeGB(cfg.Cache.TranscodeDir)
				hub.BroadcastToAdmins(ws.EventServerHealth, map[string]interface{}{
					"memory_alloc_mb":    memStats.Alloc / 1024 / 1024,
					"goroutines":         runtime.NumGoroutine(),
					"active_streams":     transcode.ActiveSessions(),
					"ws_clients":         hub.ClientCount(),
					"disk_free_gb":       diskFreeGB,
					"cpu_cores":          runtime.NumCPU(),
				})
			case <-ctx.Done():
				return
			}
		}
	}()

	// ARR clients for media Requests feature (Radarr/Sonarr integration)
	var radarrClient, radarr4KClient *arr.RadarrClient
	var sonarrClient, sonarr4KClient *arr.SonarrClient
	if cfg.Requests.Radarr.URL != "" {
		radarrClient = arr.NewRadarrClient(cfg.Requests.Radarr.URL, cfg.Requests.Radarr.APIKey)
		slog.Info("Radarr client configured", "url", cfg.Requests.Radarr.URL)
	}
	if cfg.Requests.Radarr4K.URL != "" {
		radarr4KClient = arr.NewRadarrClient(cfg.Requests.Radarr4K.URL, cfg.Requests.Radarr4K.APIKey)
		slog.Info("Radarr 4K client configured", "url", cfg.Requests.Radarr4K.URL)
	}
	if cfg.Requests.Sonarr.URL != "" {
		sonarrClient = arr.NewSonarrClient(cfg.Requests.Sonarr.URL, cfg.Requests.Sonarr.APIKey)
		slog.Info("Sonarr client configured", "url", cfg.Requests.Sonarr.URL)
	}
	if cfg.Requests.Sonarr4K.URL != "" {
		sonarr4KClient = arr.NewSonarrClient(cfg.Requests.Sonarr4K.URL, cfg.Requests.Sonarr4K.APIKey)
		slog.Info("Sonarr 4K client configured", "url", cfg.Requests.Sonarr4K.URL)
	}

	// Shared thread-safe ARR client registry (supports hot-reload from admin settings)
	arrClients := arr.NewArrClients(radarrClient, radarr4KClient, sonarrClient, sonarr4KClient, cfg.Requests.Enabled)

	// Load saved ARR settings from DB — overrides env/yaml defaults
	loadARRSettingsFromDB(ctx, queries, arrClients)

	// Watch Party manager — sync protocol V2 (server-authoritative, anchored
	// play via TimeSync, Ready/GroupWait state machine). Tunables are exposed
	// under the `watchparty:` block in configs/aurora.yaml.
	partyManager := watchparty.NewManagerWithConfig(queries, hub, watchparty.SyncConfig{
		HeartbeatInterval: cfg.WatchParty.HeartbeatInterval,
		TimeSyncInterval:  cfg.WatchParty.TimeSyncInterval,
		BufferHysteresis:  cfg.WatchParty.BufferHysteresis,
		PlayScheduleDelay: cfg.WatchParty.PlayScheduleDelay,
		DriftIgnoreMs:     cfg.WatchParty.DriftIgnoreMs,
		DriftRateAdjustMs: cfg.WatchParty.DriftRateAdjustMs,
		DriftHardSeekMs:   cfg.WatchParty.DriftHardSeekMs,
		DriftMaxAttempts:  cfg.WatchParty.DriftMaxAttempts,
	})
	// M9 — set the shutdown context BEFORE the cache dir so background
	// goroutines (the reaper, in-flight ffmpeg renders) parent off it.
	// On SIGTERM, ctx cancels and the renders unwind cleanly rather
	// than orphaning child ffmpeg processes.
	partyManager.SetShutdownContext(ctx)
	// M9 — set the highlight-reel cache directory. Reels live under
	// <ImageDir>/party-highlights/<code>.mp4, mirroring share-image's
	// pattern. Empty path disables reel generation (feature is best-
	// effort; absent dir = no reels, no errors).
	if cfg.Cache.ImageDir != "" {
		partyManager.SetHighlightCacheDir(filepath.Join(cfg.Cache.ImageDir, "party-highlights"))
	}
	go partyManager.CleanupStale(ctx)

	// Request monitor: polls ARR services for processing request completion
	if arrClients.Enabled() {
		requestMonitor := api.NewRequestMonitor(queries, hub, arrClients, scanner)
		go requestMonitor.Start(ctx)
		slog.Info("request monitor started")
	}

	// Locate static files directory for frontend SPA
	staticDir := findStaticDir()
	if staticDir != "" {
		slog.Info("serving frontend", "static_dir", staticDir)
	} else {
		slog.Warn("static directory not found, frontend will not be served")
	}

	// Adapter: search.Searcher returns (hits, parsed, err) but the api package
	// only needs (hits, err). Wrapping here keeps api free of search-package
	// types and lets a future change to search.Searcher's signature avoid
	// rippling into handlers.
	var apiSemantic api.SemanticSearcher
	if semanticSearcher != nil {
		apiSemantic = semanticAdapter{s: semanticSearcher}
	}
	var apiHero api.HeroProvider
	if heroRecommender != nil {
		apiHero = heroAdapter{h: heroRecommender}
	}

	// Router
	router := api.NewRouter(api.RouterDeps{
		Cfg:          cfg,
		AuthSvc:      authSvc,
		Queries:      queries,
		Scanner:      scanner,
		Hub:          hub,
		AuthLimiter:  authLimiter,
		Watcher:      watcher,
		Enricher:     enricher,
		ImgProxy:     imgProxy,
		Transcode:    transcode,
		Activity:     activity,
		RingLog:      ringLog,
		Pool:         pool,
		StartTime:    startTime,
		Version:      version,
		StaticDir:    staticDir,
		ArrClients:   arrClients,
		PartyManager: partyManager,
		Tmdb:         tmdbClient,
		Tvdb:         tvdbClient,
		Semantic:         apiSemantic,
		HeroProv:         apiHero,
		EmbeddingEnabled: cfg.LLM.Enabled && embedder != nil,
		EmbeddingVersion: embedding.CurrentVersion,
		LLMClient:        llmClient,
		RootCtx:          ctx, // server-lifecycle ctx for background goroutines spawned in handlers
	})

	// HTTP Server
	server := &http.Server{
		Addr:         cfg.ServerAddr(),
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start server in goroutine with optional TLS
	go func() {
		switch {
		case cfg.TLS.AutoCert && cfg.TLS.Domain != "":
			// Automatic HTTPS via Let's Encrypt (autocert)
			cacheDir := cfg.TLS.CacheDir
			if cacheDir == "" {
				cacheDir = "/var/cache/aurora/autocert"
			}
			m := &autocert.Manager{
				Cache:      autocert.DirCache(cacheDir),
				Prompt:     autocert.AcceptTOS,
				HostPolicy: autocert.HostWhitelist(cfg.TLS.Domain),
			}
			server.TLSConfig = &tls.Config{GetCertificate: m.GetCertificate}
			slog.Info("server listening with autocert TLS", "addr", cfg.ServerAddr(), "domain", cfg.TLS.Domain)
			if err := server.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
				slog.Error("server failed", "error", err)
				cancel()
			}
		case cfg.TLS.CertFile != "" && cfg.TLS.KeyFile != "":
			// Manual TLS certificate
			slog.Info("server listening with TLS", "addr", cfg.ServerAddr())
			if err := server.ListenAndServeTLS(cfg.TLS.CertFile, cfg.TLS.KeyFile); err != nil && err != http.ErrServerClosed {
				slog.Error("server failed", "error", err)
				cancel()
			}
		default:
			// Plain HTTP
			slog.Info("server listening", "addr", cfg.ServerAddr())
			if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				slog.Error("server failed", "error", err)
				cancel()
			}
		}
	}()

	// Print startup info. URLs printed here are intended to be
	// clickable / pastable into a browser, so we use DisplayAddr
	// (which rewrites the 0.0.0.0 bind to "localhost" since
	// browsers refuse 0.0.0.0 as a destination). When TLS is
	// configured with an explicit domain, that domain takes
	// precedence — operators behind autocert reach the server via
	// its public hostname, not localhost.
	scheme := "http"
	wsScheme := "ws"
	if (cfg.TLS.AutoCert && cfg.TLS.Domain != "") || (cfg.TLS.CertFile != "" && cfg.TLS.KeyFile != "") {
		scheme = "https"
		wsScheme = "wss"
	}
	displayAddr := cfg.DisplayAddr()
	if cfg.TLS.Domain != "" {
		displayAddr = cfg.TLS.Domain
	}
	fmt.Printf("\n  Aurora Media Server %s\n", version)
	if staticDir != "" {
		fmt.Printf("  ├─ Frontend:    %s://%s/\n", scheme, displayAddr)
	}
	fmt.Printf("  ├─ API:         %s://%s/api/health\n", scheme, displayAddr)
	fmt.Printf("  ├─ WebSocket:   %s://%s/ws\n", wsScheme, displayAddr)
	fmt.Printf("  ├─ TMDB:        enabled\n")
	fmt.Printf("  ├─ Streaming:   direct play + HLS transcode\n")
	fmt.Printf("  └─ Ready.\n\n")

	// Graceful shutdown on signal or server failure
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	select {
	case <-quit:
		slog.Info("received shutdown signal...")
	case <-ctx.Done():
		slog.Info("shutting down due to server error...")
	}
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	// Stop watch parties
	slog.Info("stopping watch parties...")
	partyManager.Shutdown()

	// Stop transcode sessions and cleanup goroutine
	slog.Info("stopping transcode sessions...")
	transcode.Close()
	transcode.StopAllSessions()

	if err := server.Shutdown(shutdownCtx); err != nil {
		slog.Error("server shutdown error", "error", err)
	}

	slog.Info("server stopped")

	// Close the lumberjack file logger LAST, after all log lines have been written.
	// This ensures the final "server stopped" message is captured in the log file.
	if fileLogger != nil {
		if err := fileLogger.Close(); err != nil {
			// Write to stderr directly since the slog pipeline may be broken
			fmt.Fprintf(os.Stderr, "failed to close log file: %v\n", err)
		}
	}
}

// findMigrationsDir looks for the migrations directory relative to the binary or CWD
func findMigrationsDir() string {
	candidates := []string{
		"migrations",
		"./migrations",
		filepath.Join("..", "migrations"),
		filepath.Join("..", "..", "migrations"),
	}

	// Also check relative to executable
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "migrations"))
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "..", "migrations"))
	}

	for _, dir := range candidates {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			abs, _ := filepath.Abs(dir)
			return abs
		}
	}

	return ""
}

// loadARRSettingsFromDB overrides env/yaml ARR client defaults with any
// values saved in the server_settings DB table (from admin UI).
func loadARRSettingsFromDB(ctx context.Context, queries *db.Queries, clients *arr.ArrClients) {
	if v, err := queries.GetSetting(ctx, "requests_enabled"); err == nil && v != "" {
		clients.SetEnabled(v == "true")
		slog.Info("loaded requests_enabled from DB", "value", v)
	}

	pairs := []struct {
		urlKey, apiKeyKey string
		update            func(string, string)
		label             string
	}{
		{"radarr_url", "radarr_api_key", clients.UpdateRadarr, "Radarr"},
		{"radarr_4k_url", "radarr_4k_api_key", clients.UpdateRadarr4K, "Radarr 4K"},
		{"sonarr_url", "sonarr_api_key", clients.UpdateSonarr, "Sonarr"},
		{"sonarr_4k_url", "sonarr_4k_api_key", clients.UpdateSonarr4K, "Sonarr 4K"},
	}
	for _, p := range pairs {
		urlVal, _ := queries.GetSetting(ctx, p.urlKey)
		keyVal, _ := queries.GetSetting(ctx, p.apiKeyKey)
		// Only override config-file defaults when DB has BOTH url and api_key.
		// If only one is set in DB, the incomplete pair would nil out a working
		// client that was configured via environment variables or config file.
		if urlVal != "" && keyVal != "" {
			p.update(urlVal, keyVal)
			slog.Info("loaded ARR config from DB", "service", p.label, "url", urlVal)
		}
	}
}

// findStaticDir looks for the static directory containing Aurora's
// V2 SPA build (`v2/index.html`) relative to the binary, CWD, or
// well-known install paths.
//
// Audit H1 fix (Phase 8) — the previous sentinel was the now-deleted
// `aurora_pro.html` (V1 single-file HTML). After V1 retirement that
// file no longer exists in any deployment, so the function silently
// returned "" → router.go skipped its entire static-routes group →
// the API booted clean but every browser request got a chi 404.
// The new sentinel is `v2/index.html` (Vite emits this on every
// build), which is the canonical marker for "this directory has a
// usable Aurora frontend."
func findStaticDir() string {
	candidates := []string{
		"static",
		"./static",
		filepath.Join("..", "static"),
		filepath.Join("..", "..", "static"),
		"/opt/aurora/static",
	}

	// Also check relative to executable
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "static"))
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "..", "static"))
	}

	for _, dir := range candidates {
		// Verify the directory exists AND contains the V2 SPA build.
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, "v2", "index.html")); err == nil {
			abs, _ := filepath.Abs(dir)
			return abs
		}
	}

	return ""
}

// semanticAdapter wraps *search.Searcher and discards the ParsedQuery so it
// satisfies api.SemanticSearcher. The parser output is still useful for
// debug logging — exposing it via the adapter would just leak search-package
// types into the api boundary.
type semanticAdapter struct {
	s *search.Searcher
}

func (a semanticAdapter) Search(ctx context.Context, query string, limit int) ([]api.SemanticHit, error) {
	hits, _, err := a.s.Search(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	out := make([]api.SemanticHit, len(hits))
	for i, h := range hits {
		out[i] = api.SemanticHit{Item: h.Item, Score: h.Score, Reason: h.Reason}
	}
	return out, nil
}

// heroAdapter bridges *recommender.Hero (returns recommender.HeroPick) to
// the api.HeroProvider interface (returns api.HeroPick). One-line shape
// translation — the underlying *models.MediaItem pointer flows through
// unchanged so there's no extra allocation per item.
type heroAdapter struct {
	h *recommender.Hero
}

func (a heroAdapter) PoolFor(ctx context.Context, profileID int64) ([]api.HeroPick, error) {
	picks, err := a.h.PoolFor(ctx, profileID)
	if err != nil {
		return nil, err
	}
	out := make([]api.HeroPick, len(picks))
	for i, p := range picks {
		out[i] = api.HeroPick{Item: p.Item, Reason: p.Reason}
	}
	return out, nil
}

func (a heroAdapter) RailFor(ctx context.Context, profileID int64, limit int) ([]*models.MediaItem, error) {
	return a.h.RailFor(ctx, profileID, limit)
}

// DiscoverFor bridges recommender.DiscoverRail to api.DiscoverRail.
// Pure shape translation; the underlying *MediaItem pointers flow through
// unchanged so no extra allocation per item.
func (a heroAdapter) DiscoverFor(ctx context.Context, profileID int64) ([]api.DiscoverRail, error) {
	rails, err := a.h.DiscoverFor(ctx, profileID)
	if err != nil {
		return nil, err
	}
	out := make([]api.DiscoverRail, len(rails))
	for i, r := range rails {
		out[i] = api.DiscoverRail{Title: r.Title, Items: r.Items}
	}
	return out, nil
}

// AnchorRailsFor bridges recommender.AnchorRail to api.AnchorRail.
// Same shape-translation pattern as DiscoverFor; pointers flow through.
func (a heroAdapter) AnchorRailsFor(ctx context.Context, profileID int64) ([]api.AnchorRail, error) {
	rails, err := a.h.AnchorRailsFor(ctx, profileID)
	if err != nil {
		return nil, err
	}
	out := make([]api.AnchorRail, len(rails))
	for i, r := range rails {
		out[i] = api.AnchorRail{Anchor: r.Anchor, Items: r.Items}
	}
	return out, nil
}

func (a heroAdapter) Invalidate(profileID int64) { a.h.Invalidate(profileID) }

// applyLLMOverrides mutates cfg with values from server_settings, overriding
// env/yaml defaults. The three-state precedence (DB row exists / does not /
// exists-but-empty) lets the admin UI explicitly clear a field by writing
// an empty value — env doesn't get to refill it. Errors are logged-and-
// ignored: a bad DB row should never block server start when env+yaml work.
func applyLLMOverrides(ctx context.Context, queries *db.Queries, cfg *llm.Config) {
	get := func(key string, dst *string) {
		v, ok, err := queries.GetSettingExists(ctx, key)
		if err != nil {
			slog.Warn("applyLLMOverrides: read failed", "key", key, "error", err)
			return
		}
		if !ok {
			return // no row → keep env/yaml default
		}
		*dst = v // includes intentional empty-string clears
	}

	// Provider is informational only — local vs cloud is implied by whether
	// the operator filled in OllamaURL + APIKey. We still read it so future
	// validation can warn on mismatched combinations.
	var provider string
	get("llm_provider", &provider)

	get("llm_ollama_url", &cfg.BaseURL)
	get("llm_embed_url", &cfg.EmbedURL)
	get("llm_api_key", &cfg.APIKey)
	get("llm_chat_model", &cfg.ChatModel)
	get("llm_embed_model", &cfg.EmbedModel)

	if v, ok, _ := queries.GetSettingExists(ctx, "llm_debug_log"); ok {
		cfg.Debug = v == "true"
	}

	if provider != "" {
		slog.Info("LLM config loaded from DB overrides", "provider", provider,
			"chat_model", cfg.ChatModel, "embed_model", cfg.EmbedModel,
			"has_api_key", cfg.APIKey != "", "debug", cfg.Debug)
	}
}
