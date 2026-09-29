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
	"strings"
	"sync"
	"syscall"
	"time"

	// The watch-party share card pins its date/time to America/New_York
	// (internal/api/party_card.go) and prints whatever abbreviation the
	// zone actually resolves to at that instant — EDT or EST. Nothing else
	// in Aurora calls LoadLocation, so without the embedded IANA tables the
	// binary would depend on the host having a zoneinfo database and would
	// silently fall back to UTC on a minimal install. ~450 KB.
	_ "time/tzdata"

	"github.com/aurora-media/aurora/internal/api"
	"github.com/aurora-media/aurora/internal/arr"
	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/embedding"
	"github.com/aurora-media/aurora/internal/library"
	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/logging"
	"github.com/aurora-media/aurora/internal/matching"
	"github.com/aurora-media/aurora/internal/metadata"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/notify"
	"github.com/aurora-media/aurora/internal/push"
	"github.com/aurora-media/aurora/internal/recommender"
	"github.com/aurora-media/aurora/internal/search"
	"github.com/aurora-media/aurora/internal/skipmarkers"
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

	// Tracked background workers.
	//
	// The DB pool used to be closed by `defer pool.Close()`, which fires the
	// instant main returns — while ~18 background goroutines are still
	// running. Cancellation is cooperative, so a worker mid-write keeps going
	// and lands on a closed pool. Production logs caught it on 2026-07-30:
	//
	//   failed to store cast   error="upsert cast Shaquille O'Neal: closed pool"
	//   failed to set match status   error="closed pool"
	//
	// i.e. enrichment work silently lost whenever a deploy landed mid-scan.
	// Workers registered through bgWorker are waited for (bounded) after ctx
	// is cancelled and before the pool closes. Fire-and-forget goroutines that
	// never touch the DB are deliberately left unwrapped.
	var bgWG sync.WaitGroup
	bgWorker := func(fn func()) {
		bgWG.Add(1)
		go func() {
			defer bgWG.Done()
			fn()
		}()
	}

	// Names what a timed-out graceful shutdown was waiting on. See
	// internal/api/inflight.go for why the request log can't answer that.
	inFlight := api.NewInFlightRegistry()

	// Database. Retries transient failures for up to a minute: systemd's
	// After=postgresql.service orders startup but does not wait for Postgres
	// to accept connections, so on a reboot Aurora can win the race and exit
	// before the database is listening. Misconfiguration (bad password,
	// missing database) still fails immediately.
	pool, err := db.NewPoolWithRetry(ctx, cfg.Database, 0)
	if err != nil {
		slog.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}

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
	// Match v2 impressions are sensitive profile history. Sweep immediately at
	// boot and daily thereafter so the 90-day retention policy is a real bound,
	// even when no profile requests another hero response.
	bgWorker(func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			pctx, pcancel := context.WithTimeout(ctx, 30*time.Second)
			if n, err := queries.PruneRecommendationImpressions(pctx, db.RecommendationImpressionRetention); err != nil {
				slog.Warn("recommendation impression retention sweep failed", "error", err)
			} else if n > 0 {
				slog.Info("pruned recommendation impression slates", "count", n)
			}
			// Playback QoE rides the same daily sweep. Its retention is
			// shorter (30 days vs 90): the data answers questions about the
			// recent past, so keeping it longer would carry more per-profile
			// history for no additional operational answer.
			// The sweep is batched and returns how much it committed even when
			// it stops early, so log the progress alongside the failure rather
			// than discarding it — a truncated sweep is still a partial one and
			// the count is what says whether a backlog is draining.
			if n, err := queries.PrunePlaybackQoE(pctx, db.PlaybackQoERetention); err != nil {
				slog.Warn("playback qoe retention sweep incomplete", "error", err, "pruned", n)
			} else if n > 0 {
				slog.Info("pruned playback qoe sessions", "count", n)
			}
			pcancel()
			select {
			case <-ticker.C:
			case <-ctx.Done():
				return
			}
		}
	})
	authSvc := auth.NewService(cfg.Auth)
	scanner := library.NewScanner(cfg.Scanner, queries)
	hub := ws.NewHub(cfg.OriginAllowed)
	activity := api.NewActivityLogger(queries)

	// Smart Skip — background intro/recap/credits detection. Always
	// constructed: the worker self-gates on FFmpeg availability and the
	// skip_markers_enabled server setting, and runs one niced FFmpeg at
	// a time so it never competes with live transcodes. The boot sweep
	// drains any backlog; scan completion re-triggers it for new files;
	// the periodic tick catches stragglers.
	//
	// The OnScanComplete hook MUST be assigned before the watcher below
	// starts — watcher-triggered scans can already be running (and
	// finishing) during boot, and the scan goroutine reads this field
	// in its completion path.
	skipWorker := skipmarkers.NewWorker(queries)
	bgWorker(func() { skipWorker.Run(ctx) })
	scanner.OnScanComplete = func(lib *models.Library) {
		skipWorker.TriggerSweep()

		// Say something when a library finishes a scan with essentially no
		// metadata matches. This is the half of the #510 report an operator
		// actually sees: the admin endpoint is a page somebody has to think to
		// visit, and the mis-typed library sat there through repeated
		// SUCCESSFUL scans because nothing ever mentioned it.
		//
		// Report only, and deliberately after the scan rather than during it —
		// the report skips a library mid-scan, since a partial tally warns and
		// then resolves itself. Failures here are swallowed: a diagnostic must
		// never be able to fail a scan.
		// bgWorker, not a bare `go`: the watcher callback twenty lines below
		// carries the note explaining that untracked goroutines are what
		// produced the 2026-07-30 "closed pool" incident, and this one outlives
		// the scan that spawned it.
		libID := lib.ID
		bgWorker(func() {
			tallies, err := queries.GetLibraryMatchHealth(ctx)
			if err != nil {
				slog.Warn("library health check failed", "library_id", libID, "error", err)
				return
			}
			api.LogLibraryHealth(api.LibraryHealthReportFor(tallies, scanner), libID)
		})
	}

	// Notification pipeline (see docs/push.md): one dispatcher owns persist →
	// WS broadcast → push fan-out.
	// Every producer (request monitor, watch party, the four scan sites,
	// request creation) routes through it. Constructed here, before the
	// watcher, because the watcher's scan callback is the first producer.
	pushSender := push.NewSender(queries, nil)
	dispatcher := notify.NewDispatcher(queries, hub, pushSender, push.Envelope)

	// File watcher: triggers incremental rescan when files change on disk
	watcher := library.NewWatcher(cfg.Scanner, scanner, func(lib *models.Library) {
		// Use TryStartScan to prevent concurrent scans if an API-triggered scan
		// is already running for this library.
		if !scanner.TryStartScan(lib.ID) {
			slog.Info("file watcher skipped rescan (already running)", "library", lib.Name)
			return
		}
		slog.Info("file watcher triggered rescan", "library", lib.Name)
		// ctx + bgWorker, not context.Background() + a bare `go`.
		//
		// This is the path the pool-close race actually ran through, and the
		// earlier fix missed it: watcher-triggered rescans fired ~3,100 times
		// in a two-week window, each one writing items and running inline
		// enrichment, on a context that could not be cancelled and a goroutine
		// nobody waited for. A deploy landing mid-scan closed the pool under
		// it — the "upsert cast ...: closed pool" line from 2026-07-30.
		//
		// Threading ctx does not SAVE the in-flight write (pgx aborts it on
		// cancel either way); it makes the scan stop promptly and fail with a
		// clear context.Canceled instead of scribbling at a dead pool, and
		// scans are idempotent so the next one recovers the work.
		bgWorker(func() {
			scanner.ScanLibrary(ctx, lib, func(p *models.ScanProgress) {
				hub.Broadcast(ws.EventScanProgress, p)
				if p.Status == models.ScanComplete && p.NewFiles > 0 {
					hub.Broadcast(ws.EventLibraryUpdate, map[string]interface{}{
						"library_id":   lib.ID,
						"library_name": lib.Name,
						"new_items":    p.NewFiles,
						"action":       "scan_completed",
					})
					dispatcher.ScanCompleted(ctx, lib.Name, p.NewFiles)
				}
			})
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

	// Rate limiters for public/sensitive auth endpoints. Split into separate
	// instances (audit MED — shared-budget starvation) so high-volume refresh
	// traffic can't drain the budget that protects login/register from
	// credential guessing. Each owns its own per-IP bucket map.
	//
	//   loginLimiter  — login + register. Tight (10/min/IP): the credential-
	//                   guessing surface.
	//   refreshLimiter — refresh + logout. Roomier (60/min/IP): a single client
	//                   can legitimately rotate tokens often (multiple tabs,
	//                   reconnects), and neither endpoint guesses a credential,
	//                   so a wider budget here is safe and stops refresh churn
	//                   from eating the login budget.
	//   pwChangeLimiter — change-password. Modest (10/min/IP): already authed +
	//                   Argon2id-gated, but still capped against a stolen-token
	//                   brute-force over the access-token lifetime.
	loginLimiter := auth.NewRateLimiter(10, time.Minute)
	defer loginLimiter.Stop()
	refreshLimiter := auth.NewRateLimiter(60, time.Minute)
	defer refreshLimiter.Stop()
	pwChangeLimiter := auth.NewRateLimiter(10, time.Minute)
	defer pwChangeLimiter.Stop()
	// requestLimiter — POST /api/requests. Per-IP flood cap (20/min/IP) on
	// media-request creation (carve-out C). Roomier than login since it's an
	// authed endpoint already behind a per-user quota gate, but bounded so a
	// single client can't outrun admin triage of the approval queue.
	requestLimiter := auth.NewRateLimiter(20, time.Minute)
	defer requestLimiter.Stop()
	// partyCardLimiter — GET /api/parties/{code}/card.png. Public and
	// unauthenticated (a social crawler can't log in), gated only by an
	// HMAC tag, and it runs a compositor. 30/min/IP is roomy for a host
	// reloading a preview and for a crawler fetching one image, while
	// making tag brute-force and render-flooding both pointless.
	partyCardLimiter := auth.NewRateLimiter(30, time.Minute)
	defer partyCardLimiter.Stop()

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
	//
	// 2026-05-25 — also constructs the AI re-matcher and its backfill
	// worker (internal/matching). Both are nil-guarded by the inline hook
	// helpers below, so disabling LLM cleanly disables this subsystem too.
	var embedder *embedding.Embedder
	var semanticSearcher *search.Searcher
	var heroRecommender *recommender.Hero
	var llmClient *llm.Client
	var aiMatcher *matching.AIMatcher
	var aiBackfill *matching.Backfiller
	if cfg.LLM.Enabled {
		// Apply any DB-stored overrides on top of env/yaml config. Precedence:
		// DB row (existing, even if empty) > env > yaml default. The "existing
		// but empty" case is an intentional explicit clear from the admin UI.
		llmCfg := llm.Config{
			Provider:         cfg.LLM.Provider,
			EmbedProvider:    cfg.LLM.EmbedProvider,
			AnthropicAPIKey:  cfg.LLM.AnthropicAPIKey,
			OpenAIAPIKey:     cfg.LLM.OpenAIAPIKey,
			AnthropicBaseURL: cfg.LLM.AnthropicBaseURL,
			OpenAIBaseURL:    cfg.LLM.OpenAIBaseURL,
			BaseURL:          cfg.LLM.OllamaURL,
			EmbedModel:       cfg.LLM.EmbedModel,
			ChatModel:        cfg.LLM.ChatModel,
			Dims:             cfg.LLM.EmbedDims,
			HTTPTimeout:      cfg.LLM.HTTPTimeout,
			NumCtx:           cfg.LLM.NumCtx,
		}
		applyLLMOverrides(ctx, queries, &llmCfg)
		llmClient = llm.NewClient(llmCfg)
		// Best-effort liveness check — do not block startup if the embedding
		// backend (local Ollama, or OpenAI when llm_embed_provider=openai) is
		// slow to come up; the backfill goroutine will retry on its own.
		pingCtx, pingCancel := context.WithTimeout(ctx, 5*time.Second)
		if err := llmClient.Ping(pingCtx); err != nil {
			// Use llmCfg (post-DB-override values) so the log reflects what the
			// client is ACTUALLY using, not the env-default. `applyLLMOverrides`
			// above mutates llmCfg with the admin-saved URL / models. Logging
			// cfg.LLM here would show the stale env baseline (e.g. the Docker
			// hostname `http://ollama:11434`) even after the admin pointed the
			// client at Ollama Cloud, which made operators chase phantom bugs.
			slog.Warn("LLM embedding backend not reachable at startup; semantic search will activate when it comes up",
				"embed_provider", llmCfg.EmbedProvider, "url", llmCfg.BaseURL, "error", err)
		} else {
			slog.Info("llm backends reachable", "provider", llmCfg.Provider,
				"embed_provider", llmCfg.EmbedProvider,
				"url", llmCfg.BaseURL, "embed_url", llmCfg.EmbedURL,
				"embed_model", llmCfg.EmbedModel, "chat_model", llmCfg.ChatModel,
				"rerank_model", llmCfg.RerankModel)
		}
		pingCancel()

		embedder = embedding.New(llmClient, queries, cfg.LLM.BackfillWorkers, cfg.LLM.BackfillBatch)
		// Tell the model-space guard whether the embed model is an explicit
		// operator choice (env var or admin-saved DB row) vs the binary
		// default — pre-marker installs with a pinned model keep their
		// vectors (same space), default-followers get nulled+re-embedded on
		// a default swap. See embedding.ensureModelSpace.
		_, embedPinnedDB, _ := queries.GetSettingExists(ctx, "llm_embed_model")
		embedder.SetModelPinned(embedPinnedDB || os.Getenv("LLM_EMBED_MODEL") != "")
		semanticSearcher = search.New(llmClient, queries)
		heroRecommender = recommender.New(queries, llmClient)
		// Phase B2 anti-repetition window (hours; 0 disables). Restart-required,
		// like the other recommender/LLM tuning knobs. Absent → New's default.
		if v, ok, _ := queries.GetSettingExists(ctx, "recommender_repeat_window_hours"); ok {
			if hrs, perr := strconv.Atoi(v); perr == nil && hrs >= 0 {
				heroRecommender.SetRepeatWindow(time.Duration(hrs) * time.Hour)
			}
		}
		// Phase E1 multi-centroid taste: cap on taste modes per profile (1 = off).
		// Restart-required. Absent → New's default (3).
		if v, ok, _ := queries.GetSettingExists(ctx, "recommender_taste_centroids"); ok {
			if n, perr := strconv.Atoi(v); perr == nil {
				heroRecommender.SetTasteCentroids(n)
			}
		}

		// AI re-matcher for items the heuristic enricher flagged as
		// 'needs_review'. The matcher reuses LLM_CHAT_MODEL (same model
		// as semantic-search rerank — single tuning surface) and
		// promotes items to 'matched' when self-reported confidence
		// clears AI_MATCH_AUTO_THRESHOLD.
		aiMatcher = matching.NewAIMatcher(llmClient, tmdbClient, enricher, queries, cfg.LLM.AIMatchAutoThreshold)
		aiBackfill = matching.NewBackfiller(aiMatcher, queries, cfg.LLM.AIMatchRatePerSec)

		// One-shot backfill of any items missing/outdated embeddings. Runs in
		// the background so it doesn't block HTTP startup; ctx cancel stops it.
		bgWorker(func() { embedder.RunBackfill(ctx) })

		// One-shot AI re-match sweep over any currently-flagged items
		// that haven't been LLM-evaluated yet. Idempotent — cheap COUNT
		// first, exits immediately on an empty queue. Cancels with ctx
		// on SIGTERM. The inline OnNewItem hook below covers
		// newly-flagged items going forward; this one drains the
		// pre-existing backlog.
		bgWorker(func() { aiBackfill.Run(ctx) })
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

	// Publish the deploy drain snapshot so aurora-update.sh can wait on
	// "sessions a viewer is still holding" instead of "is ffmpeg running".
	// A paused viewer has no ffmpeg process (the encoder is reaped as idle
	// and resumed on demand), so the old pgrep gate restarted out from under
	// paused playback. Skipped when the state dir is absent — a source
	// checkout or a dev box without install.sh — so we don't log a failed
	// write every 30s forever.
	if transcode.SetStreamStateFile(streaming.DefaultStreamStateFile) {
		slog.Info("publishing stream drain state", "path", streaming.DefaultStreamStateFile)
	} else {
		slog.Debug("drain state: state dir absent, not publishing",
			"path", streaming.DefaultStreamStateFile)
	}

	// Direct-play registry — companion to the transcode manager for
	// tracking byte-range / remux streams that don't have an FFmpeg
	// process lifecycle. Touched on every stream-serve in the
	// handlers; the admin Sessions endpoint joins this with
	// transcode.ListSessions() for a unified view. 60s default TTL.
	directPlay := streaming.NewDirectPlayRegistry(0)
	defer directPlay.Close()

	// Direct-play viewers hold no transcode session and spawn no ffmpeg, so
	// until they were counted here a deploy saw an idle box and restarted
	// mid-stream. Registered after the registry exists; the drain snapshot
	// picks it up on the next publish.
	transcode.SetDrainExtraViewers(directPlay.ActiveCount)

	// embedItem is invoked after each successful enrichment path below. It
	// regenerates the semantic-search vector so newly-imported content is
	// findable by natural-language query immediately, not on the next backfill.
	// No-op when the LLM subsystem is disabled.
	embedItem := func(ctx context.Context, item *models.MediaItem) {
		if embedder == nil {
			return
		}
		// The enricher persists TMDB overview / genres / content_rating to the DB
		// but does NOT write them back onto `item`, so the passed struct is still
		// pre-enrichment (title-only). Embedding it directly produces a degenerate
		// vector — missing overview, genres, and the Phase E2b tone cue — and
		// because EmbedItem stamps the current version, the backfill never
		// re-selects it. Re-fetch the persisted row + its genres so the inline
		// vector matches what the backfill would build.
		fresh, err := queries.GetMediaItem(ctx, item.ID)
		if err != nil || fresh == nil {
			// Leave the embedding NULL; the backfill (WHERE embedding IS NULL)
			// will catch it. An honest miss beats a stamped title-only vector.
			slog.Warn("inline embedding: re-fetch failed, deferring to backfill", "item_id", item.ID, "error", err)
			return
		}
		if byID, gErr := queries.GetMediaGenresBatch(ctx, []int64{fresh.ID}); gErr == nil {
			fresh.Genres = byID[fresh.ID]
		}
		if err := embedder.EmbedItem(ctx, fresh); err != nil {
			slog.Warn("inline embedding failed", "item", fresh.Title, "error", err)
		}
	}

	// AI matcher inline queue. The enricher's TMDB heuristic puts ~10-20%
	// of newly-scanned items into 'needs_review' (50..84 confidence band);
	// for those, we want the LLM matcher to run as a second-pass so the
	// operator sees an AI suggestion immediately on the flagged page.
	//
	// CRITICAL: the matcher LLM call takes 3-30s. Running it inline on
	// the scanner goroutine would catastrophically stall scan throughput
	// for libraries with many flagged items — a 10k-item scan with 1k
	// flagged would add hours. The bounded channel + single worker
	// goroutine decouples scan latency from match latency: scans push
	// itemIDs (cheap), the worker drains at whatever pace Ollama allows.
	//
	// Capacity 256 + drop-oldest semantics: if the scan out-runs the
	// matcher (typical), newer items take priority. The backfill goroutine
	// above will catch the dropped items on its next pass (it scans for
	// ai_match_ran_at IS NULL, so anything not yet evaluated gets a turn).
	// Single worker (not a pool) so concurrent LLM calls don't drown the
	// shared chat model used by search rerank / recommender.
	//
	// Shutdown semantics (deep-debugger Bug 1.1 fix): the worker exits
	// on `<-ctx.Done()`, no channel close needed. Producers also gate on
	// ctx so a SIGTERM during a busy scan doesn't keep enqueueing into a
	// drained worker. Dropped-on-shutdown items get picked up by the next
	// boot's backfill via the ai_match_ran_at IS NULL filter.
	type aiMatchJob struct{ itemID int64 }
	var aiMatchQueue chan aiMatchJob
	enqueueAIMatch := func(item *models.MediaItem) {} // no-op fallback when AI disabled
	if aiMatcher != nil {
		aiMatchQueue = make(chan aiMatchJob, 256)
		go func() {
			for {
				select {
				case <-ctx.Done():
					slog.Info("ai-match inline worker: shutdown")
					return
				case job := <-aiMatchQueue:
					// Re-fetch the item so we observe the post-enrichment
					// match_status. If a concurrent manual match flipped
					// it to 'matched' between enqueue and now, the
					// matcher's own early-return guard (ai_matcher.go
					// matchStatusMatched check) will skip the LLM call.
					it, err := queries.GetMediaItem(ctx, job.itemID)
					if err != nil || it == nil {
						continue
					}
					if _, err := aiMatcher.Match(ctx, it); err != nil {
						slog.Warn("inline ai-match failed",
							"item_id", it.ID, "title", it.Title, "error", err)
					}
				}
			}
		}()
		enqueueAIMatch = func(item *models.MediaItem) {
			// Gate enqueue on ctx so shutdown doesn't keep stuffing the
			// channel after the worker has exited. The channel buffer
			// (256) absorbs the normal scan burst; the default case
			// drops on overflow with the backfill safety net.
			select {
			case <-ctx.Done():
				return
			case aiMatchQueue <- aiMatchJob{itemID: item.ID}:
			default:
				// Queue full → backfill worker will catch this item on
				// its next sweep (the WHERE clause it pages on includes
				// any flagged item with ai_match_ran_at IS NULL).
				slog.Warn("ai-match queue full, deferring to backfill",
					"item_id", item.ID, "title", item.Title)
			}
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
		// Second-pass AI matcher for items that landed in 'needs_review'
		// (heuristic confidence 50..84). The thresholds here mirror the
		// enricher's defaults; the matcher itself doesn't filter on score
		// because OnNewItemByID/OnNewItemByTVDBID never reach here (those
		// produce 'matched' items directly and skip the AI second-pass).
		if score >= cfg.TMDB.ReviewThreshold && score < cfg.TMDB.AutoMatchThreshold {
			enqueueAIMatch(item)
		}
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

	// New episode files added to a show that has already been enriched OR
	// attempted skip the full enrichment path, so their episode rows would never
	// receive TMDB titles/overviews/stills. The backfill reuses the show's
	// existing tmdb match and re-runs only the season/episode pass.
	//
	// Shows that were attempted and matched nothing are intentionally left to
	// this path: re-searching TMDB on every incremental scan would churn their
	// match state and re-pay a search and an embed for a title no provider has an
	// entry for. Recovering those is the periodic RefreshStaleMetadata rotation's
	// job — and it is their ONLY recovery path, which is worth being precise
	// about because it is easy to assume otherwise:
	//
	// A show whose best candidate scored below MATCH_REVIEW_THRESHOLD (or that
	// returned no results at all) gets no SetMatchStatus write, and
	// media_items.match_status DEFAULTs to 'matched' (migration 007) while
	// UpsertMediaItem never sets it. So it reads as 'matched' with a NULL
	// tmdb_id: invisible to GetItemsNeedingReview and to the AI re-match backfill,
	// both of which filter on match_status = 'needs_review'. There is no
	// flagged/needs_review safety net for this class. The rotation is it.
	//
	// A show never attempted at all is a different case and IS re-queued for a
	// full pass by the scanner: that is the state a scan interrupted before its
	// deferred TV enrichment leaves behind, and before #510 it was permanent.
	// Note that re-queue happens once per scan in ScanLibrary, not from the
	// per-file path — processFile returns early on an unchanged hash, and in that
	// state every file IS unchanged.
	scanner.OnEpisodeBackfill = func(ctx context.Context, item *models.MediaItem, seasons []int) {
		matched, err := enricher.BackfillEpisodeMetadata(ctx, item.ID, seasons)
		if err != nil {
			slog.Warn("episode metadata backfill failed", "item", item.Title, "error", err)
		} else if matched {
			slog.Info("backfilled episode metadata", "item", item.Title, "seasons", seasons)
		}
	}

	// Background cleanup of expired/revoked refresh tokens (hourly), plus the
	// OAuth transaction rows from migration 057. Those live 10 minutes and one
	// is written per link start and per invited OAuth signup, so the table
	// would otherwise accumulate a row per attempt forever. Expiry is enforced
	// in the consume query itself — this sweep is housekeeping, not a control.
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
				sweptTxns, freedInvites, err := queries.DeleteExpiredOAuthTransactions(context.Background())
				if err != nil {
					slog.Error("oauth transaction cleanup failed", "error", err)
				} else if sweptTxns > 0 {
					// freed_invites counts codes recovered from signups that
					// were abandoned at the provider's consent screen; without
					// the sweep those stay permanently unclaimable.
					slog.Info("purged expired oauth transactions",
						"count", sweptTxns, "freed_invites", freedInvites)
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

	// Background cleanup of stale subtitle cache files.
	go runSubtitleCacheSweeper(ctx, cfg.Cache.SubtitleDir, 24*time.Hour, 30*24*time.Hour)

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
					"memory_alloc_mb": memStats.Alloc / 1024 / 1024,
					"goroutines":      runtime.NumGoroutine(),
					// Raw session count, unlike the admin dashboard's
					// "Active Streams" tile (activeStreamTileCount), which
					// folds a Chromecast's local+clone pair into one viewer
					// and adds direct plays. Nothing consumes this event
					// today; if something starts to, reconcile the two
					// rather than shipping two numbers under one name.
					"active_streams": transcode.ActiveSessions(),
					"ws_clients":     hub.ClientCount(),
					"disk_free_gb":   diskFreeGB,
					"cpu_cores":      runtime.NumCPU(),
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

	// Watch Party manager — V3 sync protocol (server-authoritative anchor +
	// tick broadcasts; see internal/watchparty/sync_v3.go).
	//
	// 2026-06 V2 deletion — the legacy `watchparty:` yaml tunables
	// (heartbeat_interval_ms, buffer_hysteresis_ms, drift_*) configured the
	// removed V2 group state machine; config.loadYAML logs a deprecation
	// warning if an aurora.yaml still sets them. They are NOT mapped onto
	// the V3 thresholds because their defaults (50ms/2000ms) differ from
	// V3's tuned values (200ms/3000ms) and silently re-tightening every
	// deployment's sync behavior would be worse than dropping stale knobs.
	// V3 tuning uses DefaultSyncConfig; per-deployment overrides can be
	// added to config as V3-named knobs if anyone ever needs them.
	partyManager := watchparty.NewManagerWithConfig(queries, hub, watchparty.SyncConfig{})
	// Reel-ready notifications route through the dispatcher so they push
	// to closed tabs like every other notification.
	partyManager.SetDispatcher(dispatcher)
	// Invites (migration 051): scheduled parties are promises that must
	// survive the auto-updater's restarts. Reload active scheduled rows and
	// re-arm their countdown + reminder timers before the listener starts
	// taking joins; overdue ones fire immediately and go live.
	if restored := partyManager.RehydrateScheduledParties(ctx); restored > 0 {
		slog.Info("rehydrated scheduled watch parties", "count", restored)
	}
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
	bgWorker(func() { partyManager.CleanupStale(ctx) })

	// Request monitor: polls ARR services for processing request completion.
	// Started UNCONDITIONALLY (not gated on arrClients.Enabled() at boot) so
	// that enabling the requests feature at runtime via the admin panel — which
	// flips arrClients.SetEnabled(true) without a restart — doesn't leave
	// newly-created requests stuck in 'processing' forever with no poller. The
	// monitor idles (slow 60s cadence, no ARR calls) whenever the feature is
	// disabled — pollOnce early-returns on !Enabled() — or nothing is
	// processing, so an always-on monitor is cheap. See audit H5.
	requestMonitor := api.NewRequestMonitor(queries, hub, arrClients, scanner, dispatcher)
	bgWorker(func() { requestMonitor.Start(ctx) })

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
		Cfg:                   cfg,
		AuthSvc:               authSvc,
		Queries:               queries,
		Scanner:               scanner,
		Hub:                   hub,
		Dispatcher:            dispatcher,
		PushSender:            pushSender,
		LoginLimiter:          loginLimiter,
		RefreshLimiter:        refreshLimiter,
		ChangePasswordLimiter: pwChangeLimiter,
		RequestLimiter:        requestLimiter,
		PartyCardLimiter:      partyCardLimiter,
		Watcher:               watcher,
		Enricher:              enricher,
		ImgProxy:              imgProxy,
		Transcode:             transcode,
		DirectPlay:            directPlay,
		Activity:              activity,
		RingLog:               ringLog,
		Pool:                  pool,
		StartTime:             startTime,
		Version:               version,
		StaticDir:             staticDir,
		ArrClients:            arrClients,
		PartyManager:          partyManager,
		Tmdb:                  tmdbClient,
		Tvdb:                  tvdbClient,
		Semantic:              apiSemantic,
		HeroProv:              apiHero,
		EmbeddingEnabled:      cfg.LLM.Enabled && embedder != nil,
		EmbeddingVersion:      embedding.CurrentVersion,
		LLMClient:             llmClient,
		// aiBackfill is nil when LLM is disabled OR matching subsystem
		// failed to construct. Router's nil check converts that to a
		// 503 from the rematch endpoints — same shape as the
		// embedding-status endpoint's nil-handling.
		AIBackfill:  aiBackfillIface(aiBackfill),
		SkipMarkers: skipWorker,
		RootCtx:     ctx, // server-lifecycle ctx for background goroutines spawned in handlers
		InFlight:    inFlight,
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
		// Every observed occurrence burned the full timeout, and the request
		// log can't say why: it only logs on COMPLETION, so a request still in
		// flight leaves no line at all. Name the stragglers here — this is the
		// evidence needed to decide whether the 10s budget is wrong or a
		// handler is failing to return.
		slog.Error("server shutdown error", "error", err,
			"in_flight", inFlight.Snapshot())
	}

	slog.Info("server stopped")

	// Only NOW tell background workers to stop.
	//
	// Ordering matters and the obvious choice is wrong. Cancelling before
	// server.Shutdown would kill RootCtx-derived work belonging to requests
	// still being drained — the graceful window exists precisely so those
	// finish. Letting workers query for the few extra seconds of the drain
	// costs nothing (the pool is still open); cutting live requests short
	// does. Previously this happened only via `defer cancel()` on return,
	// i.e. after the pool had already been closed by its own defer, which is
	// how enrichment writes landed on a dead pool.
	cancel()

	// Wait (bounded) for tracked background workers to notice the cancel and
	// unwind before the pool goes away, so an in-flight enrichment write
	// doesn't land on a closed pool. Bounded because a wedged worker must not
	// hold the deploy open — the drain gate upstream already waited for
	// viewers, and systemd will SIGKILL us eventually regardless.
	workersDone := make(chan struct{})
	go func() {
		bgWG.Wait()
		close(workersDone)
	}()
	select {
	case <-workersDone:
	case <-time.After(5 * time.Second):
		slog.Warn("background workers still running after 5s — closing pool anyway")
	}
	pool.Close()

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

// aiBackfillIface converts a possibly-nil *matching.Backfiller to a
// possibly-nil api.AIBackfillController interface value. Go's interface
// semantics require this dance: passing a typed-nil pointer to an
// interface-typed field produces a non-nil interface holding a nil
// pointer (the "famous nil interface gotcha"). The api package's nil
// check on AIBackfillController would then fail, the handler would
// dereference nil, and we'd panic. Explicit conversion via this helper
// preserves "matcher disabled → interface is nil" semantics.
func aiBackfillIface(b *matching.Backfiller) api.AIBackfillController {
	if b == nil {
		return nil
	}
	return b
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
		out[i] = api.HeroPick{
			Item: p.Item, Reason: p.Reason, Score: p.Score, Match: p.Match,
			MatchConfidence: p.MatchConfidence, MatchModelVersion: p.MatchModelVersion,
			MatchSimilarity: p.MatchSimilarity, MatchEvidence: p.MatchEvidence,
		}
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
		out[i] = api.DiscoverRail{Title: r.Title, Description: r.Description, Items: r.Items}
	}
	return out, nil
}

// DiscoverCached bridges the cache-only read (no build) so the API can serve a
// non-blocking /api/me/discover. Same shape translation as DiscoverFor.
func (a heroAdapter) DiscoverCached(profileID int64) ([]api.DiscoverRail, bool) {
	rails, ok := a.h.DiscoverCached(profileID)
	if !ok {
		return nil, false
	}
	out := make([]api.DiscoverRail, len(rails))
	for i, r := range rails {
		out[i] = api.DiscoverRail{Title: r.Title, Description: r.Description, Items: r.Items}
	}
	return out, true
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

// EngagementRailsFor bridges recommender.EngagementRail to api.EngagementRail.
// Same shape-translation pattern as DiscoverFor; pointers flow through.
func (a heroAdapter) EngagementRailsFor(ctx context.Context, profileID int64) ([]api.EngagementRail, error) {
	rails, err := a.h.EngagementRailsFor(ctx, profileID)
	if err != nil {
		return nil, err
	}
	out := make([]api.EngagementRail, len(rails))
	for i, r := range rails {
		out[i] = api.EngagementRail{Title: r.Title, Description: r.Description, Items: r.Items}
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

	// Provider is MECHANICAL as of Phase E4 (it used to be a log-only label,
	// which meant flipping it in the admin UI silently did nothing) and now
	// writes straight into cfg.Provider, where internal/llm routes every
	// chat call (anthropic/openai adapters vs the Ollama paths). The policy
	// itself lives in llm.CheckProviderCombo — ONE rule source shared with
	// UpdateLLMSettings, which 400s violations at save time; boot only
	// warns (below) so a legacy row can't brick startup. The one boot-side
	// MECHANIC is the Cloud embed coercion: our embedding models aren't
	// hosted on Ollama Cloud, so with provider=ollama_cloud and no embed
	// URL, embeddings route to the pre-override env/default URL — captured
	// here BEFORE the DB overrides rewrite BaseURL to the Cloud endpoint —
	// provided that URL actually looks local (an env chain that sets
	// LLM_OLLAMA_URL=https://ollama.com must not be "coerced" to itself).
	get("llm_provider", &cfg.Provider)
	get("llm_embed_provider", &cfg.EmbedProvider)
	localBaseURL := cfg.BaseURL // env/default URL, pre-override

	get("llm_ollama_url", &cfg.BaseURL)
	get("llm_embed_url", &cfg.EmbedURL)
	get("llm_api_key", &cfg.APIKey)
	get("llm_anthropic_api_key", &cfg.AnthropicAPIKey)
	get("llm_openai_api_key", &cfg.OpenAIAPIKey)
	get("llm_chat_model", &cfg.ChatModel)
	get("llm_embed_model", &cfg.EmbedModel)
	// Phase A per-surface routing (optional). Empty → ChatModel, so a
	// deployment that sets none is unchanged.
	get("llm_chat_model_fast", &cfg.ChatModelFast)
	get("llm_chat_model_smart", &cfg.ChatModelSmart)
	get("llm_reasoning_effort", &cfg.ReasoningEffort)
	// Phase B listwise reranker (optional). Empty model → disabled.
	get("llm_reranker_model", &cfg.RerankModel)
	get("llm_reranker_url", &cfg.RerankURL)
	if v, ok, _ := queries.GetSettingExists(ctx, "llm_structured_outputs"); ok {
		// Accept the env-style truthy set too, so a hand-edited server_settings
		// row ("1"/"yes") isn't silently ignored (matches config.go's parse).
		cfg.StructuredOutputs = v == "true" || v == "1" || v == "yes"
	}

	if v, ok, _ := queries.GetSettingExists(ctx, "llm_debug_log"); ok {
		cfg.Debug = v == "true"
	}

	hostedChat := cfg.Provider == llm.ProviderAnthropic || cfg.Provider == llm.ProviderOpenAI

	if cfg.EmbedProvider == llm.ProviderOpenAI {
		// The config-layer embed-model default (qwen3-embedding) is an Ollama
		// tag; an OpenAI embed provider with no EXPLICIT model choice (no DB
		// row, no env) gets the OpenAI default instead — cleared here so
		// llm.NewClient applies its openai default, keeping that value in one
		// place. An explicit choice (env or DB row, even an empty clear) is
		// respected as-is.
		if _, embedModelPinned, _ := queries.GetSettingExists(ctx, "llm_embed_model"); !embedModelPinned && os.Getenv("LLM_EMBED_MODEL") == "" {
			cfg.EmbedModel = ""
		}
	} else if cfg.Provider == llm.ProviderCloud && cfg.EmbedURL == "" {
		// Cloud chat, local embeddings: without this, /api/embed calls would
		// hit ollama.com, where our embedding models don't run. Only coerce
		// when the pre-override URL is plausibly a local box — otherwise
		// (env itself points at Cloud) there is no local endpoint to route
		// to, and pretending otherwise would send the operator down the
		// wrong debugging path. Skipped entirely for openai embeds above —
		// there is no local endpoint in that shape to route to.
		if !strings.HasPrefix(localBaseURL, "https://") {
			slog.Info("llm_provider=ollama_cloud with no embed URL — routing embeddings to the pre-override URL", "embed_url", localBaseURL)
			cfg.EmbedURL = localBaseURL
		} else {
			slog.Warn("llm_provider=ollama_cloud with no embed URL and no local pre-override URL — embeddings will fail until llm_embed_url points at a local Ollama")
		}
	}
	for _, violation := range llm.CheckProviderCombo(llm.ProviderCombo{
		Provider:      cfg.Provider,
		EmbedProvider: cfg.EmbedProvider,
		APIKey:        cfg.APIKey,
		AnthropicKey:  cfg.AnthropicAPIKey,
		OpenAIKey:     cfg.OpenAIAPIKey,
		ChatURL:       cfg.BaseURL,
		EmbedURL:      cfg.EmbedURL,
	}) {
		slog.Warn("LLM provider config incoherent (fix in Admin → LLM)", "provider", cfg.Provider, "problem", violation)
	}
	if cfg.NumCtx > 0 && (cfg.StructuredOutputs || hostedChat) {
		// num_ctx rides Ollama's native /api/chat options; the OpenAI-compat
		// /v1 path (structured outputs) has no options field, and the hosted
		// providers (anthropic/openai) never see it either — the knob is
		// inert exactly on the big-prompt surfaces it was set for. Warn loud.
		slog.Warn("LLM_NUM_CTX is ignored on the structured-outputs (/v1) path and on hosted providers — surfaces using it fall back to the model's default context",
			"num_ctx", cfg.NumCtx)
	}

	if cfg.Provider != "" || cfg.EmbedProvider != "" {
		slog.Info("LLM config loaded from DB overrides",
			"provider", cfg.Provider, "embed_provider", cfg.EmbedProvider,
			"chat_model", cfg.ChatModel, "embed_model", cfg.EmbedModel,
			"rerank_model", cfg.RerankModel,
			"has_api_key", cfg.APIKey != "",
			"has_anthropic_key", cfg.AnthropicAPIKey != "",
			"has_openai_key", cfg.OpenAIAPIKey != "",
			"debug", cfg.Debug)
	}
}

// sweepSubtitleCache removes files in subDir last modified more than maxAge
// ago and reports how many it deleted. Directories are left alone, and any
// entry that cannot be stat'd or removed is skipped rather than failing the
// sweep — a cache reaper must never be the reason a boot goes sideways.
func sweepSubtitleCache(subDir string, maxAge time.Duration) int {
	entries, err := os.ReadDir(subDir)
	if err != nil {
		return 0
	}
	cutoff := time.Now().Add(-maxAge)
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
	return purged
}

// runSubtitleCacheSweeper sweeps subDir immediately and then every interval,
// until ctx is done.
//
// Sweeping BEFORE the first tick is the point, and it matches the blurhash
// backfill loop above. With the sweep inside `case <-ticker.C` it needed 24
// uninterrupted hours to purge anything even once — and this box auto-deploys
// on a 5-minute timer, so on an actively-developed instance the process
// rarely lives that long and the sweep effectively never ran.
//
// These caches were never purely overwrite-in-place, so this sweep was
// always the only thing collecting them: ShiftVTTCues keys on
// (source, offset) and so accumulates one file per distinct resume position
// ever requested, and the sidecar converters key on the sidecar's path, so
// a renamed or deleted sidecar orphans its entry for good. The fingerprint
// key in ExtractSubtitleVTT made the sweep load-bearing for extracted
// tracks too — replacing a media file now orphans its old track and every
// shifted derivative built from it — which is what turned a long-standing
// slow leak into something that has to actually run.
//
// A sweep is one ReadDir plus a stat per entry, so running it on every
// restart costs nothing worth pacing; the interval stays long for the
// process that does stay up.
func runSubtitleCacheSweeper(ctx context.Context, subDir string, interval, maxAge time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if purged := sweepSubtitleCache(subDir, maxAge); purged > 0 {
			slog.Info("purged stale subtitle cache files", "count", purged)
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return
		}
	}
}
