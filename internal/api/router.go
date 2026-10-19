package api

import (
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
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
	"github.com/aurora-media/aurora/internal/notify"
	"github.com/aurora-media/aurora/internal/push"
	"github.com/aurora-media/aurora/internal/skipmarkers"
	"github.com/aurora-media/aurora/internal/streaming"
	"github.com/aurora-media/aurora/internal/watchparty"
	ws "github.com/aurora-media/aurora/internal/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
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
	// Security review 2026-06 (watch-party report, finding 1) — the
	// highlight-reel path (/api/parties/{code}/highlight.mp4, audit H11)
	// was REMOVED from this list. The SPA's reel link is a same-origin
	// <a href> whose GET carries the httpOnly access cookie (post-H10),
	// so promotion was only ever exercised by the SPA embedding its full
	// login JWT in the URL — leaking it into browser history and any
	// fronting proxy's access log. tokenFromRequest's cookie fallback
	// keeps the route working with zero credentials in the URL.
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

// ffmpegAvailOnce caches the ffmpeg PATH lookup. The binary's presence
// doesn't change over a process lifetime (install.sh ships it alongside
// the unit), so there's no reason to shell out to LookPath on every health
// probe — and the detailed health fields are now behind auth, so this is
// only hit by authenticated callers + the admin dashboard anyway.
var (
	ffmpegAvailOnce sync.Once
	ffmpegAvailVal  bool
)

// ffmpegAvailable reports whether an `ffmpeg` binary is resolvable on PATH,
// memoizing the first lookup. See ffmpegAvailOnce.
func ffmpegAvailable() bool {
	ffmpegAvailOnce.Do(func() {
		_, err := exec.LookPath("ffmpeg")
		ffmpegAvailVal = err == nil
	})
	return ffmpegAvailVal
}

// healthCallerAuthed reports whether the request carries a valid access token,
// without writing any response — used by the public /api/health handler to
// decide between the anonymous liveness shape and the full diagnostic payload.
// Unlike requireQueryTokenClaims / RequireAuth it never 401s: an absent or bad
// token simply means "anonymous", since the route is public by design.
//
// Accepts the same two credential carriers a logged-in operator's browser
// would send: an Authorization: Bearer header (curl/CI probes) or the SPA's
// httpOnly access cookie. The ?token= query form is intentionally NOT honored
// here — /api/health is not in shouldPromoteToken, so a query token is never
// promoted to the header, and we don't want the version leaking to a URL that
// lands in proxy access logs.
func healthCallerAuthed(r *http.Request, svc *auth.Service, versionStore *auth.TokenVersionStore) bool {
	if svc == nil {
		return false
	}
	var token string
	if authHeader := r.Header.Get("Authorization"); authHeader != "" {
		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
			token = parts[1]
		}
	}
	if token == "" {
		if c, err := r.Cookie(auth.AccessCookieName); err == nil {
			token = c.Value
		}
	}
	if token == "" {
		return false
	}
	claims, err := svc.ValidateAccessToken(token)
	if err != nil {
		return false
	}
	if versionStore != nil && !versionStore.Check(r.Context(), claims.UserID, claims.TokenVersion) {
		return false
	}
	return true
}

// RouterDeps holds all dependencies needed by the router.
type RouterDeps struct {
	Cfg     *config.Config
	AuthSvc *auth.Service
	Queries *db.Queries
	Scanner *library.Scanner
	Hub     *ws.Hub
	// Rate limiters for the public/sensitive auth endpoints. Split into
	// separate instances (audit MED — shared-budget starvation) so high-volume
	// refresh traffic can't drain the budget that protects login/register from
	// credential guessing. Each limiter owns its own per-IP bucket map.
	//   LoginLimiter         — POST /api/auth/login + /register (credential surface; tight)
	//   RefreshLimiter       — POST /api/auth/refresh + /logout (session-lifecycle churn; roomier)
	//   ChangePasswordLimiter — POST /api/auth/change-password (authed, Argon2id-gated; modest cap)
	//   RequestLimiter       — POST /api/requests (per-IP media-request flood cap)
	//   PartyCardLimiter     — GET /api/parties/{code}/card.png. The one
	//     PUBLIC route that runs a compositor, and the one whose HMAC tag
	//     an attacker would have to guess: the cap both bounds brute force
	//     and stops the renderer being used as a CPU sink. Optional — nil
	//     registers the route unlimited (tests).
	LoginLimiter          *auth.RateLimiter
	RefreshLimiter        *auth.RateLimiter
	ChangePasswordLimiter *auth.RateLimiter
	RequestLimiter        *auth.RateLimiter
	PartyCardLimiter      *auth.RateLimiter
	Watcher               *library.Watcher
	Enricher              *metadata.Enricher
	ImgProxy              *metadata.ImageProxy
	Transcode             *streaming.TranscodeManager
	DirectPlay            *streaming.DirectPlayRegistry
	Activity              *ActivityLogger
	RingLog               *logging.RingBufferHandler
	Pool                  *pgxpool.Pool
	StartTime             time.Time
	Version               string
	StaticDir             string // Path to static files directory (e.g. "static")
	ArrClients            *arr.ArrClients
	PartyManager          *watchparty.Manager
	Tmdb                  *metadata.TMDBClient // optional — enables TMDB external_ids fallback for Sonarr lookup
	Tvdb                  *metadata.TVDBClient // optional — enables TVDB direct-search fallback for Sonarr lookup
	Semantic              SemanticSearcher     // optional — enables natural-language /search when LLM is configured
	HeroProv              HeroProvider         // optional — enables personalized /api/me/hero
	EmbeddingEnabled      bool                 // for the admin dashboard's coverage card
	EmbeddingVersion      int16                // current embedding.CurrentVersion at boot
	LLMClient             *llm.Client          // optional — admin debug toggle target (Phase 6)
	Dispatcher            *notify.Dispatcher   // notification pipeline (persist → WS → push); producers route through it
	PushSender            *push.Sender         // Web Push transport, for the /api/me/push/* handlers
	AIBackfill            AIBackfillController // optional — enables /admin/flagged/ai-rematch endpoints
	SkipMarkers           *skipmarkers.Worker  // optional — Smart Skip status/sweep/correction endpoints
	// RootCtx is the server-lifecycle context. Handlers that spawn long-
	// lived background goroutines (e.g. ARR dispatch) parent off this so
	// graceful shutdown stops them. May be nil; handlers must tolerate it.
	RootCtx context.Context
	// InFlight records executing handlers so a shutdown that exceeds its
	// deadline can name what it was waiting on. Optional; nil disables
	// tracking. See inflight.go.
	InFlight *InFlightRegistry
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
				promote := shouldPromoteToken(r.URL.Path) &&
					r.Header.Get("Authorization") == "" && token != ""
				// Streaming routes additionally require the query token to be
				// CAST-SCOPED (review 2026-06 finding S2). Every first-party
				// streaming client authenticates without URL tokens — the SPA
				// and same-origin native HLS ride httpOnly cookies; Chromecast/
				// AirPlay receivers use session-bound cast tokens minted by
				// CreateCastToken. Promoting a regular 15-min login JWT from a
				// URL only ever served to widen the replay window when a
				// stream URL leaked into an upstream proxy log. Non-cast query
				// tokens are now simply NOT promoted here (no hard 401): a
				// cookie-authed request with a vestigial ?token= keeps working
				// via its cookie, and redaction below still scrubs the value.
				//
				// Fail CLOSED when AuthSvc is nil (test/embedding wiring): a
				// token we cannot scope-check is not promoted, rather than
				// silently reverting to the pre-hardening behavior.
				//
				// NOTE: this prefix must cover every STREAMING path listed in
				// shouldPromoteToken. If a new streaming route tree is added
				// there under a different prefix, extend this check too — a
				// miss means regular tokens are promoted on the new routes.
				if promote && strings.HasPrefix(r.URL.Path, "/api/stream/") {
					promote = false
					if deps.AuthSvc != nil {
						if _, castErr := deps.AuthSvc.ValidateCastToken(token); castErr == nil {
							promote = true
						}
					}
				}
				if promote {
					r.Header.Set("Authorization", "Bearer "+token)
				}
				q := r.URL.Query()
				q.Set("token", "[REDACTED]")
				r.URL.RawQuery = q.Encode()
			}
			next.ServeHTTP(w, r)
		})
	})
	// Outside RequestLogger: the tracked window must cover the same span the
	// server's graceful shutdown waits on, and RequestLogger only emits AFTER
	// the handler returns (which is why a stalled shutdown left no evidence).
	if deps.InFlight != nil {
		r.Use(TrackInFlight(deps.InFlight))
	}
	r.Use(RequestLogger)
	r.Use(middleware.Recoverer)
	// NOTE: 60s request timeout is applied per-route-group below, NOT globally,
	// so that long-running streaming and WebSocket connections are not killed.
	// CORS is dispatched by path (see corsMiddleware): the token-authed HLS
	// streaming subtree gets a permissive credential-less policy so Chromecast /
	// AirPlay receivers can fetch fragments cross-origin (issue #181), while
	// every other route keeps the credentialed allowlist.
	r.Use(corsMiddleware(cfg.Server.AllowedOrigins))
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
			// Magic-link entry points. /r/{code} redirects to V2's
			// deep-link route; V2's BrowserRouter extracts the code
			// from the URL path on load.
			//
			// /p/{code} used to be the same one-line 302. It is now the
			// share card's unfurl shell (party_card_page.go) and is
			// registered further down, next to the card image it points
			// at — a browser still lands in the SPA, via the shell's
			// location.replace rather than a Location header. See
			// ServePartyPage for why the shell is served to everyone
			// instead of sniffing User-Agent.
			r.Get("/r/{code}", func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, "/v2/r/"+chi.URLParam(r, "code"), http.StatusFound)
			})
			// Feature 1 (mobile companion) — the QR code on the big screen
			// encodes /join/{CODE}; this mirrors /p and /r by bouncing to
			// the V2 SPA companion route. See joinShortLinkRedirect for the
			// open-redirect-safe details.
			r.Get("/join/{code}", joinShortLinkRedirect)
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
			// Extracted to a named constructor (PWA Phase 1) so the
			// serving contract — SPA fallback, traversal checks, and
			// the manifest content type — is testable without building
			// the whole router. See static_pwa_test.go.
			v2Handler := newV2Handler(deps.StaticDir, v2IndexPath)
			r.Get("/v2/*", v2Handler)
			r.Head("/v2/*", v2Handler)
		})
	}

	// Token-version store + handlers
	tokenVerStore := auth.NewTokenVersionStore(deps.Queries)
	// Admin routes need the admin role and a session not acting as a
	// restricted profile (see refuseRestrictedAdmin).
	refuseRestricted := refuseRestrictedAdmin(deps.Queries)
	requireAdmin := func(next http.Handler) http.Handler {
		return auth.RequireAdmin(refuseRestricted(next))
	}
	authH := NewAuthHandler(deps.AuthSvc, deps.Queries, deps.Activity)
	deviceAuthH := NewDeviceAuthHandler(deps.AuthSvc, deps.Queries, deps.Activity, cfg.Server.SecureCookies)
	// Phase 3 (Google OAuth): handles /api/auth/oauth/google/{start,callback}.
	// Reads config from server_settings on each request so admin toggles
	// take effect without a restart. Returns 404 when OAuth not enabled.
	oauthH := NewOAuthHandler(deps.Queries, deps.AuthSvc, deps.Activity)
	authH.SetTokenVersionStore(tokenVerStore)
	authH.SetSecureCookies(cfg.Server.SecureCookies)  // deep-debug H10
	oauthH.SetSecureCookies(cfg.Server.SecureCookies) // deep-debug H10 — OAuth login also sets cookies
	libH := NewLibraryHandler(deps.Queries, deps.Scanner, deps.Hub, deps.Watcher, deps.Activity)
	if deps.RootCtx != nil {
		libH.SetRootContext(deps.RootCtx)
	}
	libH.SetDispatcher(deps.Dispatcher)
	mediaH := NewMediaHandler(deps.Queries, deps.Activity)
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
	// Lets cold-path Discover builds push discover_ready to the user so the
	// LLM-curated rails splice in live instead of only after a page refresh.
	heroH.SetHub(deps.Hub)
	tvH := NewTVHandler(deps.Queries)
	// "Previously" — spoiler-safe AI series recaps. LLMClient may be nil
	// (LLM disabled); the handler then reports the feature unavailable.
	recapH := NewRecapHandler(deps.Queries, deps.LLMClient)
	metaH := NewMetadataHandler(deps.Queries, deps.Enricher, deps.ImgProxy)
	streamH := NewStreamHandler(deps.Queries, deps.Transcode, deps.DirectPlay, cfg.Cache.SubtitleDir, deps.Hub, deps.Activity, deps.AuthSvc)
	qoeH := NewPlaybackQoEHandler(deps.Queries, deps.Transcode)
	progressH := NewProgressHandler(deps.Queries, deps.Hub)
	if deps.HeroProv != nil {
		progressH.SetHeroProvider(deps.HeroProv)
	}
	// Phase 6 — Gamification. Engine is a side-effect surface
	// driven by MarkWatched; handler exposes /api/me/gamification
	// for the profile UI. Both share the queries layer.
	gamifyEngine := NewGamificationEngine(deps.Queries)
	progressH.SetGamificationEngine(gamifyEngine)
	// Finishing an episode warms the "Previously" recap for the next resume.
	// Shares the GET handler's service instance so single-flight dedup spans
	// both the prebuild and on-demand paths.
	progressH.SetRecapService(recapH.Service())
	gamifyH := NewGamificationHandler(deps.Queries)
	profileH := NewProfileHandler(deps.Queries)
	profileH.SetAuthService(deps.AuthSvc)
	if deps.HeroProv != nil {
		profileH.SetHeroProvider(deps.HeroProv)
	}
	onboardingH := NewOnboardingHandler(deps.Queries)
	if deps.HeroProv != nil {
		onboardingH.SetHeroProvider(deps.HeroProv)
	}
	// Member profiles (social phase 1): /api/me/profile self-service +
	// /api/members/{username} member-visible cards.
	socialH := NewSocialHandler(deps.Queries)
	adminH := NewAdminHandler(deps.Queries, deps.Transcode, deps.DirectPlay, deps.Hub, deps.Activity, deps.RingLog, deps.ImgProxy, deps.Watcher, deps.ArrClients, deps.StartTime, deps.Version, deps.Cfg.Cache.TranscodeDir)
	adminH.SetEmbeddingInfo(deps.EmbeddingEnabled, deps.EmbeddingVersion)
	if deps.AIBackfill != nil {
		adminH.SetAIBackfill(deps.AIBackfill)
	}
	// Auto-updater endpoints. Handler is stateless beyond the
	// status-file path and unit name, both fixed by install.sh.
	systemH := NewSystemHandler()
	// Smart Skip — admin status / sweep trigger / manual marker
	// correction. Worker may be nil in test wiring; handlers degrade
	// to "disabled" responses.
	skipMarkerH := NewSkipMarkerHandler(deps.Queries, deps.SkipMarkers)
	// 2026-05-16 — wire the DB connection string for the pg_dump backup
	// endpoint. Empty string is a clean disable (Backup returns 500 with
	// "not configured" — no panic).
	adminH.SetDatabaseURL(deps.Cfg.Database.URL)
	if deps.LLMClient != nil {
		adminH.SetLLMClient(deps.LLMClient)
	}
	requestH := NewRequestHandler(deps.Queries, deps.Hub, deps.Activity, deps.ArrClients, deps.Tmdb, deps.Tvdb)
	requestH.SetDispatcher(deps.Dispatcher)
	notificationH := NewNotificationHandler(deps.Queries)
	// Web Push endpoints (see docs/push.md).
	// PushSender may be nil in tests that build a router without push;
	// the handler is only registered when it exists.
	var pushH *PushHandler
	if deps.PushSender != nil {
		pushH = NewPushHandler(deps.Queries, deps.PushSender)
	}
	referralH := NewReferralHandler(deps.Queries)
	if deps.RootCtx != nil {
		requestH.SetRootContext(deps.RootCtx)
		// Reconcile requests orphaned in 'pending' by a dispatch goroutine that
		// was interrupted by a crash/restart, so they don't strand forever
		// (and block re-requests via the active-duplicate guard). See audit H4.
		go requestH.StartPendingRecovery(deps.RootCtx)
	}
	// Bug-report (Phase 1+). Constructor returns a handler even when
	// the feature is disabled — its routes self-gate via cfg.Enabled
	// so misconfiguration shows up as a 404/503 rather than a startup
	// panic. The image cache dir is reused for attachment storage
	// under <ImageDir>/bug-reports/. RootCtx threads through so the
	// Phase 3 attachment-janitor goroutine exits cleanly on graceful
	// shutdown.
	feedbackH := NewFeedbackHandler(deps.RootCtx, deps.Cfg.BugReport, deps.Cfg.Cache.ImageDir, deps.Version)
	if deps.Queries != nil {
		feedbackH.sessions = deps.Queries
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
	// Watch-party invites (migration 051) — member-to-member invite send,
	// lobby roster, RSVP, and the caller's upcoming-invites feed. Delivery
	// rides the shared dispatcher pipeline (bell + WS + web push).
	partyInviteH := NewPartyInviteHandler(deps.PartyManager, deps.Queries, deps.Dispatcher)
	// Phase 2 (share-to-story): the share-image handler renders + caches a
	// 1080×1920 PNG per party for posting to social-media stories. Cache
	// directory reuses the image proxy's cache root for filesystem locality;
	// generated images live under <root>/party-share/<code>.png.
	// The same handler now also serves the watch-party SHARE CARD
	// (party_card.go): GET card.png (public, HMAC-tagged) and card-links
	// (authed, host-only). It needs queries for the host's member-visible
	// identity and the meta line, the JWT secret to key the card token,
	// and the secure-cookie hint so minted URLs get the right scheme
	// behind a TLS-terminating proxy.
	//
	// Both dependencies are nil-normalized into their interfaces first: a
	// nil *watchparty.Manager (or *db.Queries) stored in a non-nil
	// interface still passes `!= nil` and panics on the first method call,
	// which makes the handler's own `== nil` guards inert. That never
	// mattered while every card route sat behind an HMAC tag, but the
	// Phase 3 unfurl shell at /p/{code} is reachable with no token at all,
	// so it has to degrade to "no party" rather than take the process down
	// when a caller builds a router without one of them.
	var partyLookup partyStateLookup
	if deps.PartyManager != nil {
		partyLookup = deps.PartyManager
	}
	var cardQ cardQueries
	if deps.Queries != nil {
		cardQ = deps.Queries
	}
	partyShareH := NewPartyShareHandler(
		partyLookup, cardQ, deps.Cfg.Cache.ImageDir,
		cfg.Auth.JWTSecret, cfg.Server.SecureCookies,
	)
	// Close the follow-up manager.go:2780 recorded: the manager had no way
	// to drop a party's cached artwork, so a media swap or a party ending
	// left a stale poster until the 30-day reaper. It does now.
	if deps.PartyManager != nil {
		deps.PartyManager.SetShareCacheInvalidator(partyShareH.InvalidateCache)
	}
	// Feature 1 (mobile companion): renders the companion-join QR code
	// (PNG of <scheme>://<host>/join/{CODE}). Auth + party-membership gated;
	// secureCookies threads through so the encoded URL's scheme is https
	// behind a TLS-terminating proxy (same hint the auth cookies use).
	partyQRH := NewPartyQRHandler(deps.PartyManager, cfg.Server.SecureCookies)
	if deps.Queries != nil { // a nil *db.Queries would be a non-nil sessionStore
		partyQRH.sessions = deps.Queries
	}
	// V3 dual-socket handlers. The legacy NewPartyWSHandler/V2 handler is
	// no longer constructed (orphan code in party_ws.go) — its route has
	// been removed and no current client speaks V2 wire format.
	partyWSHV3Sync := NewPartyWSHandlerV3Sync(deps.PartyManager, deps.AuthSvc, tokenVerStore, cfg.OriginAllowed)
	partyWSHV3Room := NewPartyWSHandlerV3Room(deps.PartyManager, deps.AuthSvc, tokenVerStore, cfg.OriginAllowed)

	// ── Watch-party link unfurl (share card, Phase 3) ──────────────────
	//
	// /p/{code} is the link a host pastes into a chat. It answers every
	// caller with the same small HTML shell carrying og:/twitter: tags,
	// and bounces browsers into the SPA from inside that page — see
	// ServePartyPage for why this beats sniffing User-Agent, and what a
	// human's path looks like now.
	//
	// /p/{code}/card.png is an ALIAS onto the same ServeCardPNG the API
	// route exposes: same HMAC gate, same 404-for-everything, same cache.
	// It exists so the og:image sits under the one prefix robots.txt
	// allows — crawlers that honour robots (X's card crawler most
	// explicitly) skip images the file disallows, and the locked decision
	// is that the carve-out is `Allow: /p/` and nothing else.
	//
	// Both routes carry the card limiter: the shell is public, mints a
	// card tag, and is the cheapest thing to hammer on the box. Both
	// register HEAD as well as GET — crawlers preflight, and chi routes
	// methods independently (a GET-only registration answers HEAD with
	// 405). Gated on StaticDir for the same reason the old /p/ redirect
	// was: with no SPA built there is nowhere for a browser to land.
	if deps.StaticDir != "" {
		r.Group(func(r chi.Router) {
			r.Use(frontendHeaders)
			if deps.PartyCardLimiter != nil {
				r.Use(deps.PartyCardLimiter.Middleware)
			}
			r.Get("/p/{code}", partyShareH.ServePartyPage)
			r.Head("/p/{code}", partyShareH.ServePartyPage)
			r.Get("/p/{code}/card.png", partyShareH.ServeCardPNG)
			r.Head("/p/{code}/card.png", partyShareH.ServeCardPNG)
		})
	}

	// ── API routes (with restrictive security headers) ─────────────────
	r.Group(func(r chi.Router) {
		r.Use(securityHeaders)

		// robots.txt — 1,139 real 404s over two weeks of production logs.
		// Aurora is a private media server: nothing here should be crawled or
		// indexed, and the absence of this file meant every crawler probed
		// paths individually and logged a 404 each time. Disallow everything.
		//
		// ONE carve-out (share card, Phase 3): `Allow: /p/`, the watch-party
		// unfurl shell and the card image served under it. Without it the
		// crawlers that honour this file — X's card crawler, Slack's and
		// Discord's fetchers — refuse to render a pasted party link, which is
		// the whole feature. It is written ABOVE the blanket rule so
		// first-match parsers take it too; longest-match parsers (Google,
		// Bing) prefer `/p/` over `/` either way. Nothing else moves: every
		// other route on this server stays uncrawlable.
		r.Get("/robots.txt", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			_, _ = io.WriteString(w, "User-agent: *\nAllow: /p/\nDisallow: /\n")
		})

		// sitemap.xml — 706 real 404s. A private server has no public site to
		// map, but answering with a valid empty sitemap stops well-behaved
		// crawlers retrying and is cheaper than a 404 through the SPA fallback.
		r.Get("/sitemap.xml", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/xml; charset=utf-8")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			_, _ = io.WriteString(w,
				`<?xml version="1.0" encoding="UTF-8"?>`+"\n"+
					`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`+"\n")
		})

		// Health check.
		//
		// Public response is a MINIMAL liveness shape: {status, db_connected}.
		// The detailed fields (version, disk_free_gb, ffmpeg_available, uptime)
		// are gated on a valid access token in the same handler — leaking the
		// build version to anonymous callers enables CVE fingerprinting
		// (security-low audit). An authenticated probe (Authorization: Bearer …
		// OR the SPA's access cookie) still gets the full diagnostic payload;
		// the admin dashboard surfaces the same data via /api/admin/dashboard.
		r.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
			// Liveness: DB connectivity drives the public status. Ping is the
			// one check we keep on the anonymous path so load balancers /
			// uptime monitors can see "degraded" when the DB is unreachable.
			dbOK := true
			if deps.Pool != nil {
				if err := deps.Pool.Ping(r.Context()); err != nil {
					dbOK = false
				}
			}
			status := "ok"
			if !dbOK {
				status = "degraded"
			}

			// Anonymous callers get liveness only — no version, no host metrics.
			if !healthCallerAuthed(r, deps.AuthSvc, tokenVerStore) {
				writeJSON(w, http.StatusOK, struct {
					Status      string `json:"status"`
					DBConnected bool   `json:"db_connected"`
				}{Status: status, DBConnected: dbOK})
				return
			}

			// Authenticated: fold ffmpeg availability into the status and
			// return the full diagnostic payload.
			ffmpegOK := ffmpegAvailable()
			if !ffmpegOK {
				status = "degraded"
			}
			writeJSON(w, http.StatusOK, models.HealthStatus{
				Status:      status,
				Service:     "aurora",
				DBConnected: dbOK,
				FFmpegAvail: ffmpegOK,
				DiskFreeGB:  GetDiskFreeGB(cfg.Cache.TranscodeDir),
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

		// Watch-party SHARE CARD (public, HMAC-tagged). Unauthenticated
		// because a social crawler unfurling a pasted link cannot log in;
		// gated on ?t=, a stateless HMAC over the code that only an
		// authenticated host can mint via /card-links. Every rejection is
		// a 404 — a 403 would confirm the code names a real party. Rate
		// limited per IP so the tag can't be brute-forced and the
		// compositor can't be used as a CPU sink.
		if deps.PartyCardLimiter != nil {
			r.With(deps.PartyCardLimiter.Middleware).
				Get("/api/parties/{code}/card.png", partyShareH.ServeCardPNG)
		} else {
			r.Get("/api/parties/{code}/card.png", partyShareH.ServeCardPNG)
		}

		// Bug-report attachments (public — the filename is a 128-bit
		// random hex string which serves as the access token, same
		// shape as the party share-image route above). Allows GitHub's
		// image proxy to render the attachment in the issue body.
		// Handler 404s when the feature flag is off OR the requested
		// filename doesn't match the whitelisted shape, so this route
		// is inert until an operator enables BUG_REPORT_ENABLED.
		//
		// 2026-05-27 — Register HEAD too. Chrome and Safari issue
		// HEAD before GET when loading video/audio inline (they need
		// Content-Type, Content-Length, and Accept-Ranges before
		// committing to the media pipeline). Without an explicit HEAD
		// route, the HEAD request doesn't match this GET-only route
		// and chi routes it elsewhere — in our config it ends up
		// hitting one of the authed groups that returns 401, which
		// makes browsers refuse to play. http.ServeContent inside
		// ServeAttachment handles HEAD correctly (writes the headers
		// without the body).
		r.Get("/api/feedback/attachments/{name}", feedbackH.ServeAttachment)
		r.Head("/api/feedback/attachments/{name}", feedbackH.ServeAttachment)

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
			// Separate limiters per audit MED (shared-budget starvation): login
			// and register share the credential-guessing budget; refresh and
			// logout share a roomier session-lifecycle budget so token rotation
			// can't starve the login budget (and vice-versa).
			r.With(deps.LoginLimiter.Middleware).Post("/login", authH.Login)
			r.With(deps.LoginLimiter.Middleware).Post("/register", authH.Register)
			r.With(deps.RefreshLimiter.Middleware).Post("/refresh", authH.Refresh)
			r.With(deps.RefreshLimiter.Middleware).Post("/logout", authH.Logout)
			r.Post("/device/start", deviceAuthH.Start)
			r.Post("/device/poll", deviceAuthH.Poll)
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
				r.Get("/device/preview", deviceAuthH.Preview)
				r.Post("/device/authorize", deviceAuthH.Authorize)
				// Rate-limited: change-password verifies the current password
				// with Argon2id (~100ms/attempt) but is still brute-forceable
				// over the access-token lifetime (~10 min) by a stolen-token
				// attacker. Its own limiter (audit MED) so it doesn't share a
				// budget with login/refresh.
				r.With(deps.ChangePasswordLimiter.Middleware).Post("/change-password", authH.ChangePassword)

				// Multi-provider OAuth account linking (audit carve-out D).
				// Authenticated: a signed-in user lists/connects/disconnects
				// their linked providers. The link START records a server-side
				// transaction naming the caller, which flips the PUBLIC
				// /oauth/{provider}/callback above into link mode
				// (handleLinkCallback) instead of login.
				// DELETE refuses to remove the user's last sign-in method.
				r.Get("/oauth/links", oauthH.LinksStatus)
				r.Post("/oauth/{provider}/link", oauthH.StartLink)
				r.Delete("/oauth/{provider}/link", oauthH.Unlink)
			})
		})

		// Protected routes
		r.Group(func(r chi.Router) {
			r.Use(auth.RequireAuth(deps.AuthSvc, tokenVerStore))

			// Users (admin only)
			r.Route("/api/users", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				r.Use(requireAdmin)
				r.Get("/", authH.ListUsers)
				r.Post("/invite", authH.CreateInvite)
				r.Put("/{id}/role", authH.UpdateUserRole)
				r.Delete("/{id}", authH.DeleteUser)
			})

			// Members — the user-facing profile surface. Deliberately a
			// separate namespace from the admin-gated /api/users subtree:
			// any signed-in member may view a member's profile card (this
			// is an invite-only server; "member-visible" ≠ public
			// internet). Also unmixable with /api/users for a mechanical
			// reason: that tree's routes bind the {id} wildcard and chi
			// panics on a sibling {username} wildcard at the same node.
			r.Route("/api/members", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				// Directory + profile cards (phase 1), follow graph
				// (phase 2). Follow/unfollow are idempotent; the privacy
				// gate for feed content is share_watch_history on the
				// followee, re-checked at read time.
				r.Get("/", socialH.ListMembers)
				r.Get("/{username}", socialH.MemberProfile)
				r.Post("/{username}/follow", socialH.Follow)
				r.Delete("/{username}/follow", socialH.Unfollow)
				r.Get("/{username}/followers", socialH.Followers)
				r.Get("/{username}/following", socialH.Following)
			})

			// Libraries
			r.Route("/api/libraries", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				r.Get("/", libH.List)

				r.Group(func(r chi.Router) {
					r.Use(requireAdmin)
					r.Post("/", libH.Create)
					r.Put("/{id}", libH.Update)
					r.Delete("/{id}", libH.Delete)
					r.Post("/{id}/scan", libH.Scan)
					r.Get("/{id}/scan/status", libH.ScanStatus)
					// Changing a library's type (#510). Two calls on
					// purpose: the preview is read-only and says what
					// would be destroyed, the POST echoes back the count
					// it was shown and is refused if the catalog moved
					// since. This is a PURGE and a rescan, not a field
					// edit — a bare UPDATE of the type leaves every
					// existing row the wrong type with its files in the
					// wrong table, unreachable by any later prune.
					r.Get("/{id}/retype/preview", libH.RetypePreview)
					r.Post("/{id}/retype", libH.Retype)
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
				r.Get("/genres", mediaH.ListGenres)
				r.Get("/recent", mediaH.Recent)
				r.Get("/search", mediaH.Search)
				r.Get("/{id}", metaH.GetEnriched)
				r.Get("/{id}/files", mediaH.GetFiles)

				// TV show detail
				r.Get("/{id}/seasons", tvH.GetSeasons)
				r.Get("/{id}/seasons/{season}/episodes", tvH.GetEpisodes)
				r.Get("/{id}/next-episode", tvH.GetNextEpisode)
				// "Previously" — spoiler-safe AI recap for the resumed series.
				r.Get("/{id}/recap", recapH.Get)
				r.Get("/{id}/recap/status", recapH.Status)
				r.Get("/{id}/recap/conversation", recapH.Conversation)
				r.Post("/{id}/recap/conversation/turns", recapH.AskTurn)
				r.Delete("/{id}/recap/conversation", recapH.ClearConversation)
				r.Delete("/{id}/recap/conversation/unsafe-turns", recapH.ClearUnsafeTurns)

				// Episode files (used by watch party auto-play)
				r.Get("/episodes/{episodeId}/files", tvH.GetEpisodeFiles)

				// Metadata
				r.Get("/{id}/artwork", metaH.GetArtwork)
				r.Get("/{id}/cast", metaH.GetCast)
				r.With(requireAdmin).Post("/{id}/refresh-metadata", metaH.RefreshMetadata)
				r.With(requireAdmin).Post("/{id}/match", metaH.ManualMatch)
				// Remove a show/movie from the catalog (admin only). Does not
				// touch files on disk — only deletes Aurora's library entry and
				// its child rows. Manual counterpart to the scanner's automatic
				// empty-item cleanup.
				r.With(requireAdmin).Delete("/{id}", mediaH.DeleteItem)
			})

			// TMDB Search (for manual matching) — admin-only since RefreshMetadata and ManualMatch are admin-only
			r.With(middleware.Timeout(60*time.Second), requireAdmin).Get("/api/tmdb/search", metaH.SearchTMDB)

			// Streaming (Phase 3: adaptive HLS + session management)
			r.Route("/api/stream", func(r chi.Router) {
				// Stream info + direct play
				r.Get("/info/{fileID}", streamH.GetStreamInfo)
				r.Get("/media/{fileID}", streamH.StreamMediaFile)
				r.Get("/episode/{fileID}", streamH.StreamEpisodeFile)

				// Direct file serve: bypasses CanDirectPlay gate, used by the
				// client-aware decision engine when it has already validated codecs
				r.Get("/{fileID}/direct", streamH.ServeDirectFile)

				// HEAD support on the byte-serving routes (2026-07 review).
				// Chrome/Safari and native players (AVFoundation, download
				// managers) preflight media with HEAD before GET; without an
				// explicit HEAD route chi matches nothing here and the
				// preflight fails, which makes some players refuse to start —
				// the same failure documented and fixed for feedback
				// attachments (see the HEAD note above that route).
				// http.ServeContent answers HEAD natively (headers +
				// Content-Length, no body); the handlers skip their
				// activity-log side effects for HEAD.
				r.Head("/media/{fileID}", streamH.StreamMediaFile)
				r.Head("/episode/{fileID}", streamH.StreamEpisodeFile)
				r.Head("/{fileID}/direct", streamH.ServeDirectFile)

				// Phase 3: Transcode session management
				r.Post("/sessions", streamH.CreateSession)
				r.With(requireAdmin).Get("/sessions", streamH.ListSessions)
				r.Delete("/sessions/{sessionID}", streamH.DeleteSession)
				r.Post("/sessions/{sessionID}/keepalive", streamH.KeepAlive)
				// Mint a cast-scoped token for handing to Chromecast/AirPlay
				// receivers. Bound to a single sessionID; rejected by
				// RequireAuth so it cannot impersonate a regular session.
				r.Post("/sessions/{sessionID}/cast-token", streamH.CreateCastToken)
				// Direct-play twin: mint a cast token bound to a single FILE
				// (no transcode session exists to bind to). Consumed by the
				// AirPlay hand-off of direct-play titles; the returned URL
				// targets the cast-capable /api/stream/direct/{fileID} route.
				r.Post("/{fileID}/cast-token", streamH.CreateDirectCastToken)

				// NOTE: HLS playlist + segment routes live in a sibling
				// group (search for "RequireStreamAuth" below) so they can
				// accept either a regular access token OR a cast token.
				// They MUST NOT be defined here — RequireAuth in the
				// surrounding group rejects scoped tokens by design.

				// Phase 3: Hardware acceleration status
				r.Get("/hwaccel", streamH.HWAccelStatus)

				// Playback QoE telemetry (August 2026 review item #1).
				// Member-authenticated and fire-and-forget: both handlers
				// answer 204 even when they reject the payload, so telemetry
				// can never become something a player has to handle mid-movie.
				// The /finish twin is delivered by navigator.sendBeacon during
				// page unload.
				r.Post("/qoe/start", qoeH.RecordStart)
				r.Post("/qoe/finish", qoeH.RecordFinish)
				// Delivery rebuilt beneath a still-open viewing: re-stamp its facts.
				r.Post("/qoe/restamp", qoeH.Restamp)

				// Subtitles (includes Phase 3 burn-in support)
				r.Get("/{fileID}/subtitles", streamH.GetSubtitles)
				r.Get("/{fileID}/subtitles/{trackIdx}", streamH.ServeSubtitle)
				r.Head("/{fileID}/subtitles/{trackIdx}", streamH.ServeSubtitle)
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
				// 90s covers the slowest path that still blocks a request:
				// Hero's synchronous flight wait — rerankBudget (30s) +
				// heroRerankBudget (45s) + vector/anchor pre-work and
				// annotation (~5s) ≈ 80s, leaving ~10s of jitter margin.
				// Discover no longer rides this timeout: a cold cache
				// returns "building" immediately and the build runs
				// detached under buildFlightBudget (90s).
				//
				// MUST be strictly greater than the internal LLM ctx
				// timeout — chi cancels the request from the OUTSIDE while
				// the LLM ctx is still alive inside, wasting the round-
				// trip. Hero faced the exact same regression last round
				// (15s route vs 30s LLM); same fix here, different scale.
				//
				// Rail and anchor-rails (pure vector, sub-300ms) sit
				// comfortably under the wider bound.
				r.Use(middleware.Timeout(90 * time.Second))
				r.Get("/hero", heroH.Get)
				r.Post("/recommendation-exposure", heroH.Exposure)
				r.Get("/recommendations", heroH.Rail)
				r.Get("/discover", heroH.Discover)
				// Phase 3: anchor-pinned "Because You Watched X" rails.
				// Pure vector retrieval, sub-300ms — sits comfortably
				// under the wider /api/me timeout that Discover requires.
				r.Get("/anchor-rails", heroH.AnchorRails)
				// Phase C: signal-driven rails (Trending Now / Hidden Gems /
				// Finish It Tonight / Comfort Rewatch). No LLM — pure first-party
				// engagement signals, fast + resilient when the Cloud LLM is down.
				r.Get("/engagement-rails", heroH.EngagementRails)
				// Phase D: steerable thumbs. 👍/👎 on a title reshapes the
				// feed live (taste-vector boost / recall exclusion) + invalidates.
				r.Post("/feedback", heroH.Feedback)
				// Star ratings: graded 1-5★ verdicts. 4-5★ feeds the taste
				// vector, 1-2★ excludes the title everywhere + anti-anchors
				// its neighbors in the LLM prompts; GET drives the detail
				// page's star widget. Both are cheap DB hits — the wide
				// timeout is irrelevant to them.
				r.Get("/rating", heroH.GetRating)
				r.Post("/rating", heroH.SetRating)
				// Member profile self-service (the Account card's "Phase 3"):
				// read + edit display name / bio / social handles and the
				// share-watch-history opt-in. Cheap DB hits — the wide
				// /api/me timeout Discover needs is irrelevant here.
				r.Get("/profile", socialH.MyProfile)
				r.Put("/profile", socialH.UpdateMyProfile)
				// "From People You Follow" home rail (social phase 2).
				// One indexed query, no LLM — the wide timeout above is
				// irrelevant here.
				r.Get("/following/recent", socialH.FollowingRecent)
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
				r.Get("/active", profileH.GetActiveProfile)
				r.Post("/", profileH.CreateProfile)
				r.Get("/{id}", profileH.GetProfile)
				r.Put("/{id}", profileH.UpdateProfile)
				r.Delete("/{id}", profileH.DeleteProfile)
				r.Post("/{id}/default", profileH.SetDefault)
				// Session-bound acting profile (issue #462) — distinct from
				// SetDefault's account-wide persistent default; this is what
				// read/playback rating-ceiling enforcement consults.
				r.Post("/{id}/activate", profileH.ActivateProfile)
				r.Put("/{id}/pin", profileH.SetProfilePIN)

				// Watchlists (nested under profile)
				r.Get("/{profileId}/watchlists", profileH.ListWatchlists)
				r.Post("/{profileId}/watchlists", profileH.CreateWatchlist)
				r.Delete("/{profileId}/watchlists/{listId}", profileH.DeleteWatchlist)
				r.Get("/{profileId}/watchlists/{listId}/items", profileH.GetWatchlistItems)
				r.Post("/{profileId}/watchlists/{listId}/items", profileH.AddToWatchlist)
				r.Delete("/{profileId}/watchlists/{listId}/items/{itemId}", profileH.RemoveFromWatchlist)

				// My Library — the profile's default saved-titles list (the +
				// save button). Media-keyed so the client toggles by media id.
				r.Get("/{profileId}/library", profileH.GetLibrary)
				r.Post("/{profileId}/library", profileH.AddToLibrary)
				r.Delete("/{profileId}/library/{mediaItemId}", profileH.RemoveFromLibrary)
			})

			// Taste onboarding ("Pick What You Love") — seeds the recommender
			// for a brand-new profile so personalization works on first load.
			// Per-profile (the acting profile, or a ?profile_id= it may name). Gated server-
			// side on the library being embedded (restricted profiles are
			// age-filtered, not excluded).
			r.Route("/api/onboarding", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				r.Get("/status", onboardingH.Status)
				r.Get("/grid", onboardingH.Grid)
				r.Get("/preview", onboardingH.Preview)
				r.Post("/seeds", onboardingH.SaveSeeds)
				r.Post("/skip", onboardingH.Skip)
				r.Delete("/seeds", onboardingH.Reset)
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

			// Per-user in-app notifications (bell + Notifications panel). Mounted
			// here (not under the /api/me Route group) to avoid inheriting that
			// group's 90s LLM timeout — these are sub-millisecond DB reads/writes.
			r.Get("/api/me/notifications", notificationH.List)
			r.Post("/api/me/notifications/read-all", notificationH.MarkAllRead)
			r.Post("/api/me/notifications/{id}/read", notificationH.MarkRead)
			if pushH != nil {
				r.Get("/api/me/push/config", pushH.Config)
				r.Post("/api/me/push/subscriptions", pushH.Subscribe)
				r.Delete("/api/me/push/subscriptions", pushH.Unsubscribe)
				r.Post("/api/me/push/test", pushH.Test)
			}

			// Referral prompt (migration 046) — asked once of signups that
			// bypassed the invite gate. Mounted flat for the same reason as
			// notifications: two trivial DB round-trips that shouldn't inherit
			// the /api/me group's LLM-sized timeout. GET reports whether the
			// server considers this user pending (the client is never the
			// authority); POST records the answer or the skip, idempotently.
			r.Get("/api/me/referral-prompt", referralH.Prompt)
			r.Post("/api/me/referral", referralH.Submit)

			// Admin (Phase 4)
			r.Route("/api/admin", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				r.Use(requireAdmin)
				r.Get("/dashboard", adminH.Dashboard)
				r.Get("/activity", adminH.Activity)
				// Distinct event types for the Activity tab's filter. Static
				// subpath, so it can't collide with /activity itself.
				r.Get("/activity/types", adminH.ActivityTypes)
				r.Get("/sessions", adminH.Sessions)
				r.Get("/sessions/{sessionID}/diagnose", adminH.DiagnoseSession)
				// Aggregate playback QoE: startup percentiles, rebuffer
				// ratio, direct-play ratio and error rate over a window.
				r.Get("/playback-qoe", qoeH.Summary)
				r.Get("/settings", adminH.GetSettings)
				r.Put("/settings", adminH.UpdateSettings)
				r.Get("/logs", adminH.Logs)
				r.Get("/flagged", adminH.FlaggedItems)
				// Per-library metadata-match rates, and a warning for the
				// ones that look mis-typed (#510). Mounted HERE and not
				// beside the other library routes on purpose: GET
				// /api/libraries is member-visible (the browse tabs read
				// it), and item counts plus a diagnosis of what is wrong
				// with the server are not. Report only — it changes nothing.
				r.Get("/library-health", libH.Health)
				// AI re-matcher (migration 026 + internal/matching).
				// POST is fire-and-forget — the LLM sweep runs in a
				// detached goroutine outside the 60s admin timeout
				// applied to this route group; the endpoint just
				// returns the job id. GET reports progress.
				r.Post("/flagged/ai-rematch", adminH.AIRematchStart)
				r.Get("/flagged/ai-rematch/status", adminH.AIRematchStatus)
				r.Get("/embedding-status", adminH.EmbeddingStatus)
				// Referral attribution breakdown (migration 046). ?days=N
				// windows on signup date; 0/absent is all time.
				r.Get("/referrals/summary", referralH.Summary)
				// Smart Skip (intro/recap/credits markers). Status +
				// fire-and-forget sweep trigger mirror the embedding /
				// ai-rematch pattern; PUT/DELETE are the manual
				// correction surface (detector='manual' rows that the
				// background analyzer never overwrites). File family is
				// disambiguated via ?type=episode|media, matching
				// /api/stream/info.
				r.Get("/skip-markers/status", skipMarkerH.Status)
				r.Post("/skip-markers/sweep", skipMarkerH.TriggerSweep)
				r.Get("/skip-markers/{fileID}", skipMarkerH.GetMarkers)
				r.Put("/skip-markers/{fileID}", skipMarkerH.UpsertMarker)
				r.Delete("/skip-markers/{fileID}", skipMarkerH.DeleteMarker)
				r.Get("/llm", adminH.GetLLMSettings)
				r.Put("/llm", adminH.UpdateLLMSettings)
				// Connectivity probe (ARR-test parity): reachability +
				// which configured models each Ollama endpoint actually
				// serves, so a bad URL or un-pulled model surfaces here
				// instead of as a silent keyword-search fallback.
				r.Post("/llm/test", adminH.TestLLMConnection)
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
				// Media-request approval queue (carve-out C). Requests held by
				// the per-user quota gate land in pending_approval; admins
				// triage them here. Approve dispatches to ARR; deny fails it.
				r.Get("/requests/pending", requestH.ListPendingApprovals)
				r.Post("/requests/{id}/approve", requestH.ApproveRequest)
				r.Post("/requests/{id}/deny", requestH.DenyRequest)
			})
			// 2026-05-16 — admin backup endpoint. Separate route because
			// pg_dump can run for several minutes on a large catalog and
			// the 60s timeout middleware above would kill it. Auth is
			// still admin-only via the wrapping authenticated group +
			// explicit RequireAdmin.
			r.With(requireAdmin).Get("/api/admin/backup", adminH.Backup)
			// 2026-05-18 — admin restore endpoint. Same rationale (long-
			// running). Streams the uploaded pg_dump custom-format
			// archive to a temp file via MultipartReader (bounded
			// memory), then runs pg_restore --single-transaction
			// against it. Destructive — the handler runs a per-object
			// wipe that preserves installed extensions before invoking
			// pg_restore. See admin_backup.go header for the full
			// pipeline rationale.
			r.With(requireAdmin).Post("/api/admin/restore", adminH.Restore)

			// Requests (media request + ARR integration)
			r.Route("/api/requests", func(r chi.Router) {
				r.Use(middleware.Timeout(60 * time.Second))
				r.Get("/config", requestH.GetConfig)
				r.Get("/status", requestH.GetServiceStatus)
				// TMDB search for request creation — reuses metaH.SearchTMDB
				// but without RequireAdmin so regular users can search.
				r.Get("/search", metaH.SearchTMDB)
				r.Get("/", requestH.List)
				// Per-IP rate limit on request creation (carve-out C) so a
				// single client can't flood the queue (and the per-user quota
				// gate) faster than an admin can triage.
				r.With(deps.RequestLimiter.Middleware).Post("/", requestH.Create)
				r.Delete("/{id}", requestH.Delete)
			})

			// Bug report (Phase 1 MVP). Both routes are authed — we
			// don't expose feature-flag state to anonymous users, and
			// only authed users can submit issues (so the username
			// appears in the GitHub issue for triage).
			// The public attachment-serve route is wired separately
			// above in the unauthenticated block.
			r.Route("/api/feedback", func(r chi.Router) {
				// 2026-05-27 — Bumped 60s → 100s. Real envelope: 9 MB
				// upload (~15-30s) + WebM→MP4 transcode (~10-30s) +
				// GitHub API call (caps at 60s in the handler). The
				// previous 60s ceiling left almost no budget for
				// GitHub once upload + transcode finished, and a slow
				// GitHub minute pushed the user past the chi cancel.
				//
				// Why 100s, not 120s: http.Server.WriteTimeout is 120s
				// and covers the ENTIRE write phase from header read to
				// response done. If chi.Timeout == WriteTimeout, a
				// handler that runs to the deadline has zero budget
				// left to write the 504 response body before the
				// connection-level timeout truncates it. 20s of
				// headroom is generous for the ~200-byte error body.
				r.Use(middleware.Timeout(100 * time.Second))
				r.Get("/config", feedbackH.GetConfig)
				r.Post("/", feedbackH.Submit)
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
				// Invites (migration 051): host-only batch send; roster
				// readable by host/invitees/participants.
				r.Post("/{code}/invites", partyInviteH.SendInvites)
				r.Get("/{code}/invites", partyInviteH.Roster)
			})

			// Invitee-side invite actions. Flat routes (not under the
			// /api/me Route group) for the same reason as notifications:
			// sub-millisecond DB work that must not inherit that group's
			// long LLM timeout.
			r.Post("/api/party-invites/{id}/rsvp", partyInviteH.RSVP)
			r.Get("/api/me/party-invites", partyInviteH.MyInvites)

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
			// Feature 1 (mobile companion) — companion-join QR. Returns a
			// PNG encoding <scheme>://<host>/join/{CODE}. Auth-required
			// (this group) + party-membership gated inside the handler,
			// same policy as reactions/highlight above.
			r.Get("/api/parties/{code}/qr.png", partyQRH.ServeQR)
			// Share-card links — HOST-ONLY (403 for anyone else). The
			// host generating and sharing the image IS the consent event
			// for putting their name and their evening on a public URL,
			// so nobody else can mint it.
			r.Get("/api/parties/{code}/card-links", partyShareH.CardLinks)
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

			// HEAD support (2026-07 review): native HLS players and cast
			// receivers may preflight playlists/segments with HEAD; chi
			// routes methods independently, so GET-only registration made
			// those preflights 404/405. Handlers are HEAD-safe —
			// http.ServeFile answers HEAD without a body, and net/http
			// discards manually-written bodies for HEAD responses.
			r.Head("/api/stream/hls/{sessionID}/master.m3u8", streamH.ServeMasterPlaylist)
			r.Head("/api/stream/hls/{sessionID}/{profile}/stream.m3u8", streamH.ServeVariantPlaylist)
			r.Head("/api/stream/hls/{sessionID}/{profile}/{segment}", streamH.ServeHLSSegment)
			r.Head("/api/stream/hls/{sessionID}/{subsFile}", streamH.ServeHLSSubtitleFile)

			// Direct-play byte serving for receivers (AirPlay): accepts a
			// regular token OR a cast token bound to this exact file via
			// CreateDirectCastToken. A static "direct" path segment —
			// sibling of "hls" — so it coexists cleanly with the mounted
			// /api/stream subrouter above. The browser's own direct play
			// keeps using /api/stream/{fileID}/direct with cookie auth.
			r.Get("/api/stream/direct/{fileID}", streamH.ServeDirectCastFile)
			r.Head("/api/stream/direct/{fileID}", streamH.ServeDirectCastFile)
		})

		// WebSocket (authenticated via query param for browser compat)
		r.Get("/ws", func(w http.ResponseWriter, r *http.Request) {
			claims, ok := requireQueryTokenClaims(w, r, deps.AuthSvc, tokenVerStore)
			if !ok {
				return
			}
			// The hub sends an admin-role socket the admin-only events (now
			// playing, server-wide) for the connection's life; a session
			// acting as a restricted profile connects as a user.
			role := claims.Role
			if role == "admin" && !adminPowers(r.Context(), deps.Queries, claims) {
				role = "user"
			}
			deps.Hub.HandleConnectAuth(w, r, claims.UserID, role)
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
				// 'self' is what permits navigator.serviceWorker.register
				// ('/v2/sw.js') — SW registration is governed by worker-src,
				// and without it the PWA worker is refused at the CSP layer.
				// blob: stays for hls.js's inline transmux worker.
				"worker-src 'self' blob:; "+
				"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "+
				"font-src 'self' https://fonts.gstatic.com; "+
				// 2026-05-27 — `blob:` added for img-src so the bug-report
				// modal can preview captured screenshots and disk-uploaded
				// images via URL.createObjectURL. Blob URLs are scoped to
				// the page's origin + document lifecycle; an attacker can't
				// inject a blob URL pointing at malicious content without
				// already running script in the user's session (in which
				// case CSP can't help). `media-src` below already allows
				// blob: for the video preview path; this completes the pair.
				"img-src 'self' https://image.tmdb.org data: blob:; "+
				"connect-src 'self' ws: wss: https://cdn.jsdelivr.net; "+
				"media-src 'self' blob:; "+
				// frame-src allows the detail page's "Watch Trailer" modal to
				// embed a YouTube trailer. Without it the browser falls back to
				// default-src 'self' and refuses the cross-origin iframe, so the
				// trailer would silently render blank. youtube.com is included
				// alongside the nocookie host because the embed can serve nested
				// frames / redirect there in some flows. (frame-ancestors below
				// is unrelated — it governs who may embed Aurora, not what
				// Aurora may embed.)
				"frame-src https://www.youtube-nocookie.com https://www.youtube.com; "+
				"frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

// newV2Handler serves the built V2 SPA from <staticDir>/v2. Real files are
// served as-is; any other path gets the index.html SPA fallback so React
// Router's BrowserRouter owns deep links (/v2/library/123, /v2/p/ABC).
// http.ServeFile is path-traversal safe in theory; defence-in-depth with
// Clean + HasPrefix catches any `..` or %2e%2e tricks.
func newV2Handler(staticDir, indexPath string) http.HandlerFunc {
	// Pre-compute the cleaned absolute base so the per-request
	// path-traversal check is a constant-time string compare.
	v2Base := filepath.Clean(filepath.Join(staticDir, "v2"))
	return func(w http.ResponseWriter, r *http.Request) {
		// Strip /v2/ prefix.
		rel := strings.TrimPrefix(r.URL.Path, "/v2/")
		if rel == "" || strings.HasSuffix(rel, "/") {
			http.ServeFile(w, r, indexPath)
			return
		}
		// Reject hidden files (`.git`, `.DS_Store`) up-front.
		if strings.HasPrefix(rel, ".") {
			http.NotFound(w, r)
			return
		}
		abs := filepath.Clean(filepath.Join(staticDir, "v2", rel))
		if abs != v2Base && !strings.HasPrefix(abs, v2Base+string(filepath.Separator)) {
			http.NotFound(w, r)
			return
		}
		if info, err := os.Stat(abs); err == nil && !info.IsDir() {
			// The web app manifest needs its registered MIME type, and Go's
			// extension lookup is host-dependent (the XDG shared-mime DB /
			// /etc/mime.types) and commonly has no .webmanifest entry — on
			// such hosts ServeFile would sniff text/plain. Set it explicitly;
			// ServeFile honors a pre-set Content-Type.
			if strings.HasSuffix(rel, ".webmanifest") {
				w.Header().Set("Content-Type", "application/manifest+json")
			}
			http.ServeFile(w, r, abs)
			return
		}
		// SPA fallback for client-side routes.
		http.ServeFile(w, r, indexPath)
	}
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
