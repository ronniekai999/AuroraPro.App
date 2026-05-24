package api

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/aurora-media/aurora/internal/arr"
	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/library"
	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/logging"
	"github.com/aurora-media/aurora/internal/metadata"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/streaming"
	"github.com/aurora-media/aurora/internal/watchparty"
	ws "github.com/aurora-media/aurora/internal/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"
)

// shouldPromoteToken reports whether a request path is one of the few that
// legitimately authenticates via ?token= (Safari native HLS, WebSocket
// upgrades, image proxy fetched by <img> elements, browser-anchor
// downloads that can't set headers). Every other path should use
// Authorization headers; promoting their query-string tokens would leak
// the credential into upstream proxy access logs.
func shouldPromoteToken(path string) bool {
	// 2026-05-16 audit H1 fix — `/api/admin/backup` added because the
	// admin UI triggers the download via an anchor element (the only
	// way to get streaming + Content-Disposition filename handling
	// natively in the browser). Anchors can't set Authorization
	// headers, so the token rides as ?token= and gets promoted here.
	// The middleware redacts the token from the logged URL after
	// promotion (router.go ~line 122) so it doesn't appear in Aurora's
	// access logs. Operator note: a fronting proxy (Caddy/Nginx/CF)
	// will still see the raw token in its own access logs — a defense
	// the user must apply at that layer if they're concerned (typical
	// fix: drop `?token=*` from upstream log formats).
	return strings.HasPrefix(path, "/ws") ||
		strings.HasPrefix(path, "/api/stream/") ||
		strings.HasPrefix(path, "/api/images/") ||
		path == "/api/admin/backup"
}

// GetDiskFreeGB returns available disk space in gigabytes for the filesystem
// containing the given path. Returns 0 if the syscall fails (non-fatal).
func GetDiskFreeGB(path string) float64 {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0
	}
	// Bavail = blocks available to unprivileged users, Bsize = block size
	freeBytes := uint64(stat.Bavail) * uint64(stat.Bsize)
	return float64(freeBytes) / (1 << 30)
}

// RouterDeps holds all dependencies needed by the router.
type RouterDeps struct {
	Cfg              *config.Config
	AuthSvc          *auth.Service
	Queries          *db.Queries
	Scanner          *library.Scanner
	Hub              *ws.Hub
	AuthLimiter      *auth.RateLimiter
	Watcher          *library.Watcher
	Enricher         *metadata.Enricher
	ImgProxy         *metadata.ImageProxy
	Transcode        *streaming.TranscodeManager
	DirectPlay       *streaming.DirectPlayRegistry
	Activity         *ActivityLogger
	RingLog          *logging.RingBufferHandler
	Pool             *pgxpool.Pool
	StartTime        time.Time
	Version          string
	StaticDir        string // Path to static files directory (e.g. "static")
	ArrClients       *arr.ArrClients
	PartyManager     *watchparty.Manager
	Tmdb             *metadata.TMDBClient // optional — enables TMDB external_ids fallback for Sonarr lookup
	Tvdb             *metadata.TVDBClient // optional — enables TVDB direct-search fallback for Sonarr lookup
	Semantic         SemanticSearcher     // optional — enables natural-language /search when LLM is configured
	HeroProv         HeroProvider         // optional — enables personalized /api/me/hero
	EmbeddingEnabled bool                 // for the admin dashboard's coverage card
	EmbeddingVersion int16                // current embedding.CurrentVersion at boot
	LLMClient        *llm.Client          // optional — admin debug toggle target (Phase 6)
	// RootCtx is the server-lifecycle context. Handlers that spawn long-
	// lived background goroutines (e.g. ARR dispatch) parent off this so
	// graceful shutdown stops them. May be nil; handlers must tolerate it.
	RootCtx context.Context
}

func NewRouter(deps RouterDeps) http.Handler {
	r := chi.NewRouter()
	cfg := deps.Cfg

	// Global middleware
	r.Use(middleware.RequestID)
	// TrustedProxyMiddleware honors X-Forwarded-For / X-Real-IP ONLY when the
	// immediate TCP peer matches one of cfg.Server.TrustedProxies (parsed at
	// startup). When the list is empty, the middleware is a pass-through —
	// the secure default. This replaces chi.middleware.RealIP, which trusted
	// those headers from anyone and let any client spoof its source IP to
	// bypass the auth rate limiter.
	r.Use(TrustedProxyMiddleware(ParseTrustedProxyCIDRs(cfg.Server.TrustedProxies)))
	// Redact sensitive query params before logger captures credentials.
	// Promotes ?token= to Authorization header for HLS native playback and
	// WebSocket connections where headers can't be set by the client.
	//
	// Promotion is SCOPED to paths that legitimately need ?token= auth —
	// streaming, images, and WebSocket endpoints. Other routes (static SPA,
	// general API) get redaction only. Without this scope, a stray ?token=
	// on /static/ or /api/health would still be promoted, and the raw token
	// would appear in any reverse-proxy access log upstream of Aurora
	// (Nginx, Caddy, ALB) since redaction only runs in-process.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.RawQuery != "" && r.URL.Query().Has("token") {
				token := r.URL.Query().Get("token")
				ctx := context.WithValue(r.Context(), queryParamTokenKey{}, token)
				r = r.WithContext(ctx)
				// Only routes that genuinely cannot use Authorization headers
				// get the token promoted. Path-prefix check is OK because the
				// router has not yet stripped /api etc.
				if shouldPromoteToken(r.URL.Path) &&
					r.Header.Get("Authorization") == "" && token != "" {
					r.Header.Set("Authorization", "Bearer "+token)
				}
				q := r.URL.Query()
				q.Set("token", "[REDACTED]")
				r.URL.RawQuery = q.Encode()
			}
			next.ServeHTTP(w, r)
		})
	})
	r.Use(RequestLogger)
	r.Use(middleware.Recoverer)
	// NOTE: 60s request timeout is applied per-route-group below, NOT globally,
	// so that long-running streaming and WebSocket connections are not killed.
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.Server.AllowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		ExposedHeaders:   []string{"Link", "X-Search-Mode"},
		AllowCredentials: true,
		MaxAge:           300,
	}))
	// NOTE: securityHeaders is NOT applied globally — it is applied only to
	// API routes below.  Static/frontend routes get a permissive CSP instead.

	// ── Static file routes (frontend SPA) ──────────────────────────────
	//
	// Phase 8 — V1 (aurora_pro.html) retired. Aurora serves the V2
	// React SPA at /v2/ as the canonical UI. `/`, `/p/{code}`, and
	// `/r/{code}` redirect to the V2 equivalents. The old
	// `ui_version` server-setting machinery + the V1 HTML file +
	// the /api/ui-version endpoint are removed in this cut.
	//
	// Future: change Vite's `base: '/v2/'` to `'/'` and serve V2 at
	// root so users see clean URLs without the `/v2/` prefix. Left
	// as a separate change because it touches every asset URL in
	// the built bundle.
	if deps.StaticDir != "" {
		// v2IndexPath caches the index.html path; SPA fallback re-uses
		// it on every history-API route that doesn't match a real file.
		v2IndexPath := filepath.Join(deps.StaticDir, "v2", "index.html")

		r.Group(func(r chi.Router) {
			r.Use(frontendHeaders)
			// `/` → /v2/. Unconditional now that V1 is gone.
			// Audit H3 fix (Phase 8) — preserve the raw query
			// string across the redirect so old bookmarks like
			// `aurora.example/?ui=v1` (now-meaningless V1 toggle)
			// or `?foo=bar` (future deep-link query params) keep
			// their query payload after the bounce to V2. The
			// browser already preserves the fragment across a 302
			// natively; the query is the only thing we have to
			// re-append ourselves.
			r.Get("/", func(w http.ResponseWriter, r *http.Request) {
				dest := "/v2/"
				if r.URL.RawQuery != "" {
					dest += "?" + r.URL.RawQuery
				}
				http.Redirect(w, r, dest, http.StatusFound)
			})
			// Magic-link entry points. /p/{code} and /r/{code}
			// redirect to V2's deep-link routes; V2's BrowserRouter
			// extracts the code from the URL path on load.
			r.Get("/p/{code}", func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, "/v2/p/"+chi.URLParam(r, "code"), http.StatusFound)
			})
			r.Get("/r/{code}", func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, "/v2/r/"+chi.URLParam(r, "code"), http.StatusFound)
			})
			r.Handle("/static/*", http.StripPrefix("/static/",
				safeFileServer(http.Dir(deps.StaticDir))))

			// 2026-05-20 — browsers auto-request /favicon.ico from
			// the document root before the SPA's <link rel="icon">
			// has a chance to override. We redirect to the SVG
			// favicon that lives at /v2/favicon.svg (deployed by
			// Vite's public/ copy step). Without this, anonymous
			// /favicon.ico requests log 404 every time someone
			// hits the bare root URL.
			//
			// 302 (StatusFound) matches the rest of this file's
			// redirect philosophy — leaves room to change paths
			// without permanent browser-cache lock-in (e.g., if
			// the Vite base ever flips off /v2/).
			r.Get("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, "/v2/favicon.svg", http.StatusFound)
			})

			// Aurora V2 SPA. The Vite build outputs to static/v2/, so
			// /v2/assets/* resolves to real built files. Any path that
			// DOESN'T match a real file (deep links like
			// /v2/library/123, /v2/p/ABC) gets the index.html fallback
			// so React Router's BrowserRouter takes over client-side.
			// Register GET + HEAD so probes (curl -I, future health
			// checks) don't get a 405 from chi's strict method routing.
			v2Redirect := func(w http.ResponseWriter, r *http.Request) {
				// 302 not 301 — leaves room to change paths without
				// permanent browser-cache lock-in.
				http.Redirect(w, r, "/v2/", http.StatusFound)
			}
			r.Get("/v2", v2Redirect)
			r.Head("/v2", v2Redirect)
			// Pre-compute the cleaned absolute base so the per-request
			// path-traversal check is a constant-time string compare.
			v2Base := filepath.Clean(filepath.Join(deps.StaticDir, "v2"))
			v2Handler := func(w http.ResponseWriter, r *http.Request) {
				// Strip /v2/ prefix. http.ServeFile is path-traversal
				// safe in theory; defence-in-depth with Clean +
				// HasPrefix below catches any `..` or %2e%2e tricks.
				rel := strings.TrimPrefix(r.URL.Path, "/v2/")
				if rel == "" || strings.HasSuffix(rel, "/") {
					http.ServeFile(w, r, v2IndexPath)
					return
				}
				// Reject hidden files (`.git`, `.DS_Store`) up-front.
				if strings.HasPrefix(rel, ".") {
					http.NotFound(w, r)
					return
				}
				abs := filepath.Clean(filepath.Join(deps.StaticDir, "v2", rel))
				if abs != v2Base && !strings.HasPrefix(abs, v2Base+string(filepath.Separator)) {
					http.NotFound(w, r)
					return
				}
				if info, err := os.Stat(abs); err == nil && !info.IsDir() {
					http.ServeFile(w, r, abs)
					return
				}
				// SPA fallback for client-side routes.
				http.ServeFile(w, r, v2IndexPath)
			}
			r.Get("/v2/*", v2Handler)
			r.Head("/v2/*", v2Handler)
		})
	}

	// Token-version store + handlers
	tokenVerStore := auth.NewTokenVersionStore(deps.Queries)
	authH := NewAuthHandler(deps.AuthSvc, deps.Queries, deps.Activity)
	// Phase 3 (Google OAuth): handles /api/auth/oauth/google/{start,callback}.
	// Reads config from server_settings on each request so admin toggles
	// take effect without a restart. Returns 404 when OAuth not enabled.
	oauthH := NewOAuthHandler(deps.Queries, deps.AuthSvc, deps.Activity)
	authH.SetTokenVersionStore(tokenVerStore)
	libH := NewLibraryHandler(deps.Queries, deps.Scanner, deps.Hub, deps.Watcher, deps.Activity)
	mediaH := NewMediaHandler(deps.Queries)
	if deps.Semantic != nil {
		mediaH.SetSemanticSearcher(deps.Semantic)
	}
	// Phase 6 — Collections. Reuses the SemanticSearcher for AI-
	// curated collections. When semantic is nil, AI-collection
	// creation is rejected (manual still works).
	collectionsH := NewCollectionsHandler(deps.Queries)
	if deps.Semantic != nil {
		collectionsH.SetSemanticSearcher(deps.Semantic)
	}
	// Phase 6 — Calendar (upcoming episodes).
	calendarH := NewCalendarHandler(deps.Queries)
	heroH := NewHeroHandler(deps.Queries)
	if deps.HeroProv != nil {
		heroH.SetHeroProvider(deps.HeroProv)
	}
	tvH := NewTVHandler(deps.Queries)
	metaH := NewMetadataHandler(deps.Queries, deps.Enricher, deps.ImgProxy)
	streamH := NewStreamHandler(deps.Queries, deps.Transcode, deps.DirectPlay, cfg.Cache.SubtitleDir, deps.Hub, deps.Activity, deps.AuthSvc)
	progressH := NewProgressHandler(deps.Queries, deps.Hub)
	if deps.HeroProv != nil {
		progressH.SetHeroProvider(deps.HeroProv)
	}
	// Phase 6 — Gamification. Engine is a side-effect surface
	// driven by MarkWatched; handler exposes /api/me/gamification
	// for the profile UI. Both share the queries layer.
	gamifyEngine := NewGamificationEngine(deps.Queries)
	progressH.SetGamificationEngine(gamifyEngine)
	gamifyH := NewGamificationHandler(deps.Queries)
	profileH := NewProfileHandler(deps.Queries)
	adminH := NewAdminHandler(deps.Queries, deps.Transcode, deps.DirectPlay, deps.Hub, deps.Activity, deps.RingLog, deps.ImgProxy, deps.Watcher, deps.ArrClients, deps.StartTime, deps.Version, deps.Cfg.Cache.TranscodeDir)
	adminH.SetEmbeddingInfo(deps.EmbeddingEnabled, deps.EmbeddingVersion)
	// Auto-updater endpoints. Handler is stateless beyond the
	// status-file path and unit name, both fixed by install.sh.
	systemH := NewSystemHandler()
	// 2026-05-16 — wire the DB connection string for the pg_dump backup
	// endpoint. Empty string is a clean disable (Backup returns 500 with
	// "not configured" — no panic).
	adminH.SetDatabaseURL(deps.Cfg.Database.URL)
	if deps.LLMClient != nil {
		adminH.SetLLMClient(deps.LLMClient)
	}
	requestH := NewRequestHandler(deps.Queries, deps.Hub, deps.Activity, deps.ArrClients, deps.Tmdb, deps.Tvdb)
	if deps.RootCtx != nil {
		requestH.SetRootContext(deps.RootCtx)
	}
	partyH := NewPartyHandler(
		deps.PartyManager,
		deps.Queries,
		deps.Activity,
		deps.Cfg.WatchParty.VoiceSTUNServers,
		deps.Cfg.WatchParty.VoiceTURNURL,
		deps.Cfg.WatchParty.VoiceTURNUsername,
		deps.Cfg.WatchParty.VoiceTURNCredential,
	)
	// M3 — persistent rooms (long-lived join targets). Quick parties still
	// route through partyH; roomH handles the "My Rooms" lifecycle.
	roomH := NewRoomHandler(deps.PartyManager, deps.Queries, deps.Activity)
	// Phase 2 (share-to-story): the share-image handler renders + caches a
	// 1080×1920 PNG per party for posting to social-media stories. Cache
	// directory reuses the image proxy's cache root for filesystem locality;
	// generated images live under <root>/party-share/<code>.png.
	partyShareH := NewPartyShareHandler(deps.PartyManager, deps.Cfg.Cache.ImageDir)
	// V3 dual-socket handlers. The legacy NewPartyWSHandler/V2 handler is
	// no longer constructed (orphan code in party_ws.go) — its route has
	// been removed and no current client speaks V2 wire format.
	partyWSHV3Sync := NewPartyWSHandlerV3Sync(deps.PartyManager, deps.AuthSvc, tokenVerStore, cfg.OriginAllowed)
	partyWSHV3Room := NewPartyWSHandlerV3Room(deps.PartyManager, deps.AuthSvc, tokenVerStore, cfg.OriginAllowed)

	// ── API routes (with restrictive security headers) ─────────────────
	r.Group(func(r chi.Router) {
		r.Use(securityHeaders)

		// Health check (public, enhanced)
		r.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
			status := "ok"

			dbOK := true
			if deps.Pool != nil {
				if err := deps.Pool.Ping(r.Context()); err != nil {
					dbOK = false
					status = "degraded"
				}
			}

			ffmpegOK := true
			if _, err := exec.LookPath("ffmpeg"); err != nil {
				ffmpegOK = false
				status = "degraded"
			}

			diskFreeGB := GetDiskFreeGB(cfg.Cache.TranscodeDir)

			writeJSON(w, http.StatusOK, models.HealthStatus{
				Status:      status,
				Service:     "aurora",
				DBConnected: dbOK,
				FFmpegAvail: ffmpegOK,
				DiskFreeGB:  diskFreeGB,
				Uptime:      time.Since(deps.StartTime).Round(time.Second).String(),
				Version:     deps.Version,
			})
		})

		// Image proxy (public — browser needs to load these in <img> tags without auth)
		r.Get("/api/images/{size}/*", metaH.ProxyImage)

		// Party share image (public — "tease-only" model: strangers see the
		// poster + party code on social media but still need an Aurora
		// account to actually join. Knowing the code alone gives no access.)
		// Cached on disk so repeated social-media-crawler hits don't
		// re-render the image.
		r.Get("/api/parties/{code}/share-image.png", partyShareH.ServeShareImage)

		// M4 — magic-link landing lookup. Unauthenticated by design so the
		// /p/{code} page can render basic context (party name, "room
		// offline" state) before the user logs in. Returns either an
		// active party state, an offline-room state, or 404. Surface
		// area is intentionally small: no participants, no chat history,
		// no playback details — those need auth via the WS join.
		r.Get("/api/code/{code}/info", partyH.GetCodeInfo)

		// Auth routes (public)
		r.Route("/api/auth", func(r chi.Router) {
			r.Use(middleware.Timeout(60 * time.Second))
			r.Get("/setup-status", authH.SetupStatus) // public, no rate limit (read-only)
			r.With(deps.AuthLimiter.Middleware).Post("/login", authH.Login)
			r.With(deps.AuthLimiter.Middleware).Post("/register", authH.Register)
			r.With(deps.AuthLimiter.Middleware).Post("/refresh", authH.Refresh)
			r.With(deps.AuthLimiter.Middleware).Post("/logout", authH.Logout)
			// Phase 3 → Phase A refactor: provider-agnostic OAuth.
			// {provider} is resolved against OAuthHandler's registry
			// at request time (currently: "google"; future: "discord",
			// "twitch", "facebook", "twitter"). Both endpoints are
			// public — Start generates the CSRF state cookie +
			// redirects to the provider; Callback validates state,
			// exchanges code, issues tokens.
			//
			// Backward-compat: `/oauth/google/start` is a specific case
			// of `/oauth/{provider}/start`, so existing frontend links
			// keep working without change.
			r.Get("/oauth/{provider}/start", oauthH.Start)
			r.Get("/oauth/{provider}/callback", oauthH.Callback)

			// Protected
			r.Group(func(r chi.Router) {
				r.Use(auth.RequireAuth(deps.AuthSvc, tokenVerStore))
				r.Get("/me", authH.Me)
				// Rate-limited: change-password verifies the current password
				// with Argon2id (~100ms/attempt) but is still brute-forceable
				// over the access-token lifetime (~10 min) by a stolen-token
				// attacker. Cap attempts the same way as login/refresh.
				r.With(deps.AuthLimiter.Middleware).Post("/change-password", authH.ChangePassword)
			})
		})

		// Protected routes
		r.Group(func(r chi.Router) {
			r.Use(auth.RequireAuth(deps.AuthSvc, tokenVerStore))

			// Users (admin only)
			r.Route("/api/users", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				r.Use(auth.RequireAdmin)
				r.Get("/", authH.ListUsers)
				r.Post("/invite", authH.CreateInvite)
				r.Delete("/{id}", authH.DeleteUser)
			})

			// Libraries
			r.Route("/api/libraries", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				r.Get("/", libH.List)

				r.Group(func(r chi.Router) {
					r.Use(auth.RequireAdmin)
					r.Post("/", libH.Create)
					r.Put("/{id}", libH.Update)
					r.Delete("/{id}", libH.Delete)
					r.Post("/{id}/scan", libH.Scan)
					r.Get("/{id}/scan/status", libH.ScanStatus)
				})
			})

			// Media
			r.Route("/api/media", func(r chi.Router) {
				// 100s covers the search path's worst case: queryParseBudget
				// (30s) + rerankBudget (45s) + vector recall + DB hydration
				// (~5s) ≈ 80s, leaving 20s margin for Cloud-side jitter.
				// Bumped from 75s on 2026-05-21 when queryParseBudget was
				// raised from 8s → 30s for Cloud Turbo's gpt-oss:120b
				// (which routinely takes 6-25s for query parse); the
				// previous 75s cap would have 504'd mid-search whenever
				// parse hit its budget. Other /api/media endpoints (Get,
				// ListGenres, etc.) return in milliseconds, so the wider
				// bound is irrelevant for them.
				r.Use(middleware.Timeout(100 * time.Second))
				r.Get("/", mediaH.List)
				r.Get("/recent", mediaH.Recent)
				r.Get("/search", mediaH.Search)
				r.Get("/{id}", metaH.GetEnriched)
				r.Get("/{id}/files", mediaH.GetFiles)

				// TV show detail
				r.Get("/{id}/seasons", tvH.GetSeasons)
				r.Get("/{id}/seasons/{season}/episodes", tvH.GetEpisodes)
				r.Get("/{id}/next-episode", tvH.GetNextEpisode)

				// Episode files (used by watch party auto-play)
				r.Get("/episodes/{episodeId}/files", tvH.GetEpisodeFiles)

				// Metadata
				r.Get("/{id}/artwork", metaH.GetArtwork)
				r.Get("/{id}/cast", metaH.GetCast)
				r.With(auth.RequireAdmin).Post("/{id}/refresh-metadata", metaH.RefreshMetadata)
				r.With(auth.RequireAdmin).Post("/{id}/match", metaH.ManualMatch)
			})

			// TMDB Search (for manual matching) — admin-only since RefreshMetadata and ManualMatch are admin-only
			r.With(middleware.Timeout(60*time.Second), auth.RequireAdmin).Get("/api/tmdb/search", metaH.SearchTMDB)

			// Streaming (Phase 3: adaptive HLS + session management)
			r.Route("/api/stream", func(r chi.Router) {
				// Stream info + direct play
				r.Get("/info/{fileID}", streamH.GetStreamInfo)
				r.Get("/media/{fileID}", streamH.StreamMediaFile)
				r.Get("/episode/{fileID}", streamH.StreamEpisodeFile)

				// Direct file serve: bypasses CanDirectPlay gate, used by the
				// client-aware decision engine when it has already validated codecs
				r.Get("/{fileID}/direct", streamH.ServeDirectFile)

				// Phase 3: Transcode session management
				r.Post("/sessions", streamH.CreateSession)
				r.With(auth.RequireAdmin).Get("/sessions", streamH.ListSessions)
				r.Delete("/sessions/{sessionID}", streamH.DeleteSession)
				r.Post("/sessions/{sessionID}/keepalive", streamH.KeepAlive)
				// Mint a cast-scoped token for handing to Chromecast/AirPlay
				// receivers. Bound to a single sessionID; rejected by
				// RequireAuth so it cannot impersonate a regular session.
				r.Post("/sessions/{sessionID}/cast-token", streamH.CreateCastToken)

				// NOTE: HLS playlist + segment routes live in a sibling
				// group (search for "RequireStreamAuth" below) so they can
				// accept either a regular access token OR a cast token.
				// They MUST NOT be defined here — RequireAuth in the
				// surrounding group rejects scoped tokens by design.

				// Phase 3: Hardware acceleration status
				r.Get("/hwaccel", streamH.HWAccelStatus)

				// Subtitles (includes Phase 3 burn-in support)
				r.Get("/{fileID}/subtitles", streamH.GetSubtitles)
				r.Get("/{fileID}/subtitles/{trackIdx}", streamH.ServeSubtitle)
			})

			// Personalization endpoints (Phase 5).
			// /api/me is reserved for things scoped to the current user/profile.
			//
			// 45s bounds the LLM round-trip plus pre-work. Must be > the hero
			// rerank's own ctx budget (heroRerankBudget=30s) plus the
			// surrounding profile-vector / anchor / annotate phases (~5s each
			// on a cold DB cache). A previous 15s here silently capped the
			// hero LLM call before its own ctx timeout could fire — chi cut
			// the response at 15s while the LLM call kept running in the
			// background for another 15s, wasting the result.
			//
			// Rail (pure vector retrieval, no LLM) returns in <100ms so the
			// wider budget has no perf impact for that endpoint.
			r.Route("/api/me", func(r chi.Router) {
				// 90s covers Discover's worst case: discoverBudget=60s for
				// the LLM call + ~5s for pre-work (BuildProfileVector,
				// NearestUnwatched(50), RecentTasteAnchors, annotateGenres)
				// + ~5s for post-work (parse, resolvePick loop,
				// annotateDiscoverItems with 2 batched queries) ≈ 70s,
				// leaving 20s of jitter margin.
				//
				// MUST be strictly greater than the internal LLM ctx
				// timeout — chi cancels the request from the OUTSIDE while
				// the LLM ctx is still alive inside, wasting the round-
				// trip. Hero faced the exact same regression last round
				// (15s route vs 30s LLM); same fix here, different scale.
				//
				// Hero (30s LLM) and Rail (sub-100ms) both fit cleanly
				// under the wider bound.
				r.Use(middleware.Timeout(90 * time.Second))
				r.Get("/hero", heroH.Get)
				r.Get("/recommendations", heroH.Rail)
				r.Get("/discover", heroH.Discover)
				// Phase 3: anchor-pinned "Because You Watched X" rails.
				// Pure vector retrieval, sub-300ms — sits comfortably
				// under the wider /api/me timeout that Discover requires.
				r.Get("/anchor-rails", heroH.AnchorRails)
			})

			// Watch Progress
			r.Route("/api/progress", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				r.Get("/continue", progressH.ContinueWatching)
				r.Get("/recent", progressH.RecentlyWatched)
				r.Get("/history", progressH.WatchHistory)
				r.Put("/{id}", progressH.UpdateProgress)
				r.Get("/{id}", progressH.GetProgress)
				r.Delete("/{id}", progressH.DeleteProgress)
				r.Post("/{id}/watched", progressH.MarkWatched)
			})

			// Profiles (Phase 4)
			r.Route("/api/profiles", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				r.Get("/", profileH.ListProfiles)
				r.Post("/", profileH.CreateProfile)
				r.Get("/{id}", profileH.GetProfile)
				r.Put("/{id}", profileH.UpdateProfile)
				r.Delete("/{id}", profileH.DeleteProfile)
				r.Post("/{id}/default", profileH.SetDefault)

				// Watchlists (nested under profile)
				r.Get("/{profileId}/watchlists", profileH.ListWatchlists)
				r.Post("/{profileId}/watchlists", profileH.CreateWatchlist)
				r.Delete("/{profileId}/watchlists/{listId}", profileH.DeleteWatchlist)
				r.Get("/{profileId}/watchlists/{listId}/items", profileH.GetWatchlistItems)
				r.Post("/{profileId}/watchlists/{listId}/items", profileH.AddToWatchlist)
				r.Delete("/{profileId}/watchlists/{listId}/items/{itemId}", profileH.RemoveFromWatchlist)
			})

			// Phase 6 — Collections. Visible to any signed-in user
			// (you see your own + public). Mutations require ownership
			// or admin role (handler enforces; no route-level filter).
			r.Route("/api/collections", func(r chi.Router) {
				r.Get("/", collectionsH.List)
				r.Post("/", collectionsH.Create)
				r.Get("/{id}", collectionsH.Get)
				r.Delete("/{id}", collectionsH.Delete)
				r.Post("/{id}/items", collectionsH.AddItem)
				r.Delete("/{id}/items/{itemId}", collectionsH.RemoveItem)
			})

			// Phase 6 — Calendar. GET-only; window controlled via
			// ?from= and ?to= (YYYY-MM-DD). Server caps at 90d.
			r.Get("/api/calendar", calendarH.Upcoming)

			// Phase 6 — Gamification stats (XP/level/streak +
			// achievement catalog). Per-user; reads from
			// claims.UserID.
			r.Get("/api/me/gamification", gamifyH.Stats)

			// Admin (Phase 4)
			r.Route("/api/admin", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				r.Use(auth.RequireAdmin)
				r.Get("/dashboard", adminH.Dashboard)
				r.Get("/activity", adminH.Activity)
				r.Get("/sessions", adminH.Sessions)
				r.Get("/sessions/{sessionID}/diagnose", adminH.DiagnoseSession)
				r.Get("/settings", adminH.GetSettings)
				r.Put("/settings", adminH.UpdateSettings)
				r.Get("/logs", adminH.Logs)
				r.Get("/flagged", adminH.FlaggedItems)
				r.Get("/embedding-status", adminH.EmbeddingStatus)
				r.Get("/llm", adminH.GetLLMSettings)
				r.Put("/llm", adminH.UpdateLLMSettings)
				// Phase 3 (Google OAuth): admin-only configuration.
				// client_secret is masked in responses; submission with a
				// masked value is treated as "leave alone" so admins can
				// re-save the form without re-entering the secret.
				r.Get("/oauth", adminH.GetOAuthSettings)
				r.Put("/oauth", adminH.UpdateOAuthSettings)
				r.Post("/cache/images/purge", adminH.PurgeImageCache)
				r.Post("/arr/test", adminH.TestARRConnection)
				// Auto-updater. Manual trigger + status polling.
				// TriggerUpdate writes a timestamp to the
				// /var/lib/aurora/trigger-update file, which the
				// aurora-update.path systemd unit watches; the
				// modification fires aurora-update.service as root.
				// No sudo, no NOPASSWD grant — see system_handlers.go
				// header for the architectural rationale.
				// The status read is plain-file I/O on update-status.json.
				r.Post("/system/update", systemH.TriggerUpdate)
				r.Get("/system/update/status", systemH.GetUpdateStatus)
			})
			// 2026-05-16 — admin backup endpoint. Separate route because
			// pg_dump can run for several minutes on a large catalog and
			// the 60s timeout middleware above would kill it. Auth is
			// still admin-only via the wrapping authenticated group +
			// explicit RequireAdmin.
			r.With(auth.RequireAdmin).Get("/api/admin/backup", adminH.Backup)
			// 2026-05-18 — admin restore endpoint. Same rationale (long-
			// running). Streams the uploaded pg_dump custom-format
			// archive to a temp file via MultipartReader (bounded
			// memory), then runs pg_restore --single-transaction
			// against it. Destructive — the handler runs a per-object
			// wipe that preserves installed extensions before invoking
			// pg_restore. See admin_backup.go header for the full
			// pipeline rationale.
			r.With(auth.RequireAdmin).Post("/api/admin/restore", adminH.Restore)

			// Requests (media request + ARR integration)
			r.Route("/api/requests", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				r.Get("/config", requestH.GetConfig)
				r.Get("/status", requestH.GetServiceStatus)
				// TMDB search for request creation — reuses metaH.SearchTMDB
				// but without RequireAdmin so regular users can search.
				r.Get("/search", metaH.SearchTMDB)
				r.Get("/", requestH.List)
				r.Post("/", requestH.Create)
				r.Delete("/{id}", requestH.Delete)
			})

			// Watch Party (REST endpoints)
			r.Route("/api/parties", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				r.Post("/", partyH.Create)
				r.Get("/active", partyH.ListActive)
				r.Get("/{code}", partyH.GetInfo)
				r.Post("/{code}/end", partyH.End)
				// Phase 1 (countdown): host-only reschedule endpoint.
				// Accepts {scheduled_start_at: rfc3339 | null}. Null clears
				// the schedule; a future timestamp arms the timer.
				r.Post("/{code}/schedule", partyH.Schedule)
			})

			// Persistent Rooms (M3) — long-lived join targets that survive
			// across sessions. Quick parties continue to use /api/parties;
			// these endpoints are for the "My Rooms" UX (create a room
			// that friends bookmark, start new movie nights in it without
			// changing the join code).
			r.Route("/api/rooms", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				r.Post("/", roomH.Create)
				r.Get("/", roomH.List)
				r.Delete("/{id}", roomH.Delete)
				r.Post("/{id}/parties", roomH.StartParty)
			})

			// M8 — voice ICE servers (STUN/TURN config for the frontend's
			// RTCPeerConnection). Auth-required because TURN credentials
			// are sensitive. The frontend fetches once on voice-join.
			r.Get("/api/voice/ice-servers", partyH.GetIceServers)

			// M9 — reaction timeline. Returns the per-party ring buffer
			// (capped at reactionsRingBufferMax=200) for seekbar dots.
			r.Get("/api/parties/{code}/reactions", partyH.GetReactions)
			// M9 — highlight reel. Auto-generated on party-end; this
			// endpoint serves the cached MP4 (404 if not yet generated
			// or if the party never had enough reactions).
			r.Get("/api/parties/{code}/highlight.mp4", partyH.ServeHighlightReel)
		})

		// HLS playlist + segment routes — sibling of the RequireAuth
		// group above. RequireStreamAuth accepts either a regular access
		// token OR a cast token (Scope == ScopeCast) so Chromecast and
		// AirPlay receivers, which can't carry our Authorization header,
		// can fetch via a token-in-URL handed to them by the web sender.
		// Handlers still enforce that a cast token's SessionID matches
		// the URL's sessionID; see the scope check in each handler.
		r.Group(func(r chi.Router) {
			r.Use(auth.RequireStreamAuth(deps.AuthSvc, tokenVerStore))
			r.Get("/api/stream/hls/{sessionID}/master.m3u8", streamH.ServeMasterPlaylist)
			r.Get("/api/stream/hls/{sessionID}/{profile}/stream.m3u8", streamH.ServeVariantPlaylist)
			r.Get("/api/stream/hls/{sessionID}/{profile}/{segment}", streamH.ServeHLSSegment)
			// Inline HLS subtitle playlists + segments (Emby-style).
			// Subtitle files live in the session root dir (not variant subdirs).
			// URLs: /api/stream/hls/{sessionID}/subs_N.m3u8 (playlist)
			//        /api/stream/hls/{sessionID}/subs_N_NNNNN.vtt (segment)
			r.Get("/api/stream/hls/{sessionID}/{subsFile}", streamH.ServeHLSSubtitleFile)
		})

		// WebSocket (authenticated via query param for browser compat)
		r.Get("/ws", func(w http.ResponseWriter, r *http.Request) {
			claims, ok := requireQueryTokenClaims(w, r, deps.AuthSvc, tokenVerStore)
			if !ok {
				return
			}
			deps.Hub.HandleConnectAuth(w, r, claims.UserID, claims.Role)
		})

		// Watch Party V3 — dual-socket model (Running/Paused, ticks at 250ms
		// while Running). The legacy /ws/party single-socket endpoint was
		// deleted alongside the V3 frontend cutover (handler still exists in
		// party_ws.go as orphan code; route removal closes the attack surface
		// where a buggy or malicious client could open the V2 endpoint and
		// mutate party state via V2 paths). Full V2 backend deletion is a
		// separate cleanup task.
		r.Get("/ws/party-sync", partyWSHV3Sync.ServeHTTP)
		r.Get("/ws/party-room", partyWSHV3Room.ServeHTTP)
	})

	return r
}

// frontendHeaders sets security headers appropriate for the frontend SPA.
// Allows inline scripts/styles, CDN resources, TMDB images, WebSocket, and blob: media.
func frontendHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		// 2026-05-19 audit (FE-H6) — tightened from
		// "strict-origin-when-cross-origin" to "no-referrer" on the
		// frontend SPA. Aurora embeds JWT tokens as ?token= in some
		// native-element URLs (backup download anchors, HLS playlist
		// query strings for Safari) so that clicks from those pages
		// don't leak the token via the Referer header. The
		// stricter policy here doesn't affect Aurora's own request
		// patterns (API calls use Authorization headers, not Referer)
		// and is materially safer for token hygiene.
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		// Prevent browsers from using stale cached HTML/JS/CSS.  Without an
		// explicit Cache-Control header, browsers apply heuristic caching (up
		// to 10% of the file's age) which can serve outdated frontend code
		// for days after a deployment — causing missing UI elements, broken
		// features, or JS errors when the API has changed.
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		// Chromecast Cast SDK loads scripts from multiple gstatic paths.
		// PR #51 pinned to /cv/ thinking that covered the SDK, but the
		// bootstrap at /cv/js/sender/v1/cast_sender.js dynamically pulls
		// the framework + sender shims from /cast/sdk/ and /eureka/clank/.
		// Confirmed via QA console (2026-05-24):
		//   - /cv/js/sender/v1/cast_sender.js      (bootstrap, our injected tag)
		//   - /cast/sdk/libs/sender/1.0/cast_framework.js  (CAF v3 framework)
		//   - /eureka/clank/{147,148,...}/cast_sender.js   (versioned shims)
		// Without all three prefixes the framework never initializes and
		// our 30s timeout fires ("SDK did not initialize within 30s —
		// Cast button will remain hidden").
		//
		// Each prefix is listed explicitly so the allowlist still
		// excludes the rest of gstatic (recaptcha, Meet bundles, etc.)
		// per the original security-review concern.
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://www.gstatic.com/cv/ https://www.gstatic.com/cast/ https://www.gstatic.com/eureka/; "+
				"worker-src blob:; "+
				"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "+
				"font-src 'self' https://fonts.gstatic.com; "+
				"img-src 'self' https://image.tmdb.org data:; "+
				"connect-src 'self' ws: wss: https://cdn.jsdelivr.net; "+
				"media-src 'self' blob:; "+
				"frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

// safeFileServer wraps http.FileServer to block dotfiles, directory listings,
// and backup files (.bak, .old, .orig). Go's http.FileServer serves dotfiles
// and generates directory listings by default, which would expose sensitive
// files if accidentally placed in the static directory.
func safeFileServer(root http.FileSystem) http.Handler {
	fs := http.FileServer(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Clean the path to prevent bypass via double-slash or encoded tricks.
		// http.Dir.Open already does this, but we need to inspect the path
		// before delegating to FileServer to suppress directory listings.
		urlPath := filepath.ToSlash(filepath.Clean(r.URL.Path))
		if urlPath == "" {
			urlPath = "/"
		}

		// Block dotfiles: any path component starting with '.' is rejected.
		// This prevents serving .env, .git/*, .htaccess, .DS_Store, etc.
		for _, segment := range strings.Split(urlPath, "/") {
			if strings.HasPrefix(segment, ".") && segment != "." && segment != ".." {
				http.NotFound(w, r)
				return
			}
		}

		// Block backup files that should not be served publicly.
		lower := strings.ToLower(urlPath)
		if strings.HasSuffix(lower, ".bak") || strings.HasSuffix(lower, ".old") ||
			strings.HasSuffix(lower, ".orig") || strings.HasSuffix(lower, ".swp") {
			http.NotFound(w, r)
			return
		}

		// Block directory listings: if the path ends with '/' (or is exactly "/"),
		// it would trigger http.FileServer's directory index. Reject it.
		// The root static listing is not useful — the SPA is served at "/".
		if strings.HasSuffix(r.URL.Path, "/") || urlPath == "/" {
			http.NotFound(w, r)
			return
		}

		fs.ServeHTTP(w, r)
	})
}

// securityHeaders sets restrictive security headers for API routes.
// Frontend/static routes use frontendHeaders instead.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		// HSTS: instruct browsers to always use HTTPS after first visit.
		// Only effective when served over TLS (browsers ignore it over HTTP).
		w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		// CSP: restrictive default for an API server — block all inline/external content.
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}
