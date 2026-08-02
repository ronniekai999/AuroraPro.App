package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/arr"
	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/library"
	"github.com/aurora-media/aurora/internal/metadata"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/notify"
	ws "github.com/aurora-media/aurora/internal/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// RequestHandler handles HTTP endpoints for the media Requests feature.
type RequestHandler struct {
	queries  *db.Queries
	hub      *ws.Hub
	activity *ActivityLogger
	clients  *arr.ArrClients
	tmdb     *metadata.TMDBClient // optional — used to recover TVDB ID via external_ids when Sonarr lookup misses
	tvdb     *metadata.TVDBClient // optional — used to search TVDB by title+year as final fallback
	// rootCtx is the server-lifecycle context; goroutines spawned from
	// handlers (notably dispatchToARR) parent off it so a graceful shutdown
	// actually stops them. nil → fall back to context.Background() for
	// backwards compatibility with tests that don't set it.
	rootCtx context.Context
	// dispatcher fans out admin_new_request notifications on creation.
	// Optional (nil in tests) — creation works without it.
	dispatcher *notify.Dispatcher
}

// NewRequestHandler creates a new RequestHandler with all dependencies.
// tmdb and tvdb may be nil; if so, the TMDB→TVDB fallback chain in
// addSeriesToSonarr will degrade to "Sonarr lookup only".
func NewRequestHandler(
	queries *db.Queries,
	hub *ws.Hub,
	activity *ActivityLogger,
	clients *arr.ArrClients,
	tmdb *metadata.TMDBClient,
	tvdb *metadata.TVDBClient,
) *RequestHandler {
	return &RequestHandler{
		queries:  queries,
		hub:      hub,
		activity: activity,
		clients:  clients,
		tmdb:     tmdb,
		tvdb:     tvdb,
	}
}

// SetRootContext wires the server-lifecycle ctx so background dispatch
// goroutines participate in graceful shutdown.
func (h *RequestHandler) SetRootContext(ctx context.Context) {
	h.rootCtx = ctx
}

// SetDispatcher wires the notification pipeline (admin_new_request on
// creation). Optional: nil simply skips the admin alert.
func (h *RequestHandler) SetDispatcher(d *notify.Dispatcher) {
	h.dispatcher = d
}

// GetConfig returns the requests feature configuration flags.
// GET /api/requests/config
func (h *RequestHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	radarr := h.clients.Radarr()
	sonarr := h.clients.Sonarr()
	radarr4K := h.clients.Radarr4K()
	sonarr4K := h.clients.Sonarr4K()
	resp := models.RequestsConfigResponse{
		Enabled:   h.clients.Enabled(),
		HasRadarr: radarr != nil && radarr.IsConfigured(),
		HasSonarr: sonarr != nil && sonarr.IsConfigured(),
		Has4K: (radarr4K != nil && radarr4K.IsConfigured()) ||
			(sonarr4K != nil && sonarr4K.IsConfigured()),
	}
	writeJSON(w, http.StatusOK, resp)
}

// GetServiceStatus pings each configured ARR service and returns connection status.
// GET /api/requests/status
func (h *RequestHandler) GetServiceStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	type serviceStatus struct {
		Name      string `json:"name"`
		Connected bool   `json:"connected"`
		Error     string `json:"error,omitempty"`
	}

	var statuses []serviceStatus

	// checkRadarr tests a Radarr client connection if configured.
	checkRadarr := func(name string, client *arr.RadarrClient) {
		if client == nil || !client.IsConfigured() {
			return
		}
		s := serviceStatus{Name: name}
		if err := client.TestConnection(ctx); err != nil {
			s.Error = err.Error()
		} else {
			s.Connected = true
		}
		statuses = append(statuses, s)
	}

	// checkSonarr tests a Sonarr client connection if configured.
	checkSonarr := func(name string, client *arr.SonarrClient) {
		if client == nil || !client.IsConfigured() {
			return
		}
		s := serviceStatus{Name: name}
		if err := client.TestConnection(ctx); err != nil {
			s.Error = err.Error()
		} else {
			s.Connected = true
		}
		statuses = append(statuses, s)
	}

	checkRadarr("Radarr", h.clients.Radarr())
	checkRadarr("Radarr 4K", h.clients.Radarr4K())
	checkSonarr("Sonarr", h.clients.Sonarr())
	checkSonarr("Sonarr 4K", h.clients.Sonarr4K())

	if statuses == nil {
		statuses = []serviceStatus{}
	}

	writeJSON(w, http.StatusOK, statuses)
}

// List returns all requests. Admins see all requests with usernames;
// regular users see only their own requests.
// GET /api/requests
func (h *RequestHandler) List(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var requests []models.Request
	var err error

	if claims.Role == "admin" {
		requests, err = h.queries.GetAllRequests(r.Context())
		if err != nil {
			slog.Error("failed to get all requests", "error", err)
			writeError(w, http.StatusInternalServerError, "failed to get requests")
			return
		}

		// Populate usernames for admin view via a single batch lookup.
		// (Used to do GetUserByID per unique user — N round-trips at risk of
		// pool exhaustion under load. Now one query with WHERE id = ANY($1).)
		seen := make(map[int64]struct{}, len(requests))
		ids := make([]int64, 0, len(requests))
		for _, req := range requests {
			if _, ok := seen[req.UserID]; ok {
				continue
			}
			seen[req.UserID] = struct{}{}
			ids = append(ids, req.UserID)
		}
		usernameMap, uErr := h.queries.GetUsernamesByIDs(r.Context(), ids)
		if uErr != nil {
			slog.Warn("get usernames for admin requests view failed", "error", uErr)
			usernameMap = map[int64]string{}
		}
		for i := range requests {
			requests[i].Username = usernameMap[requests[i].UserID]
		}
	} else {
		requests, err = h.queries.GetRequestsByUserID(r.Context(), claims.UserID)
		if err != nil {
			slog.Error("failed to get user requests", "error", err, "user_id", claims.UserID)
			writeError(w, http.StatusInternalServerError, "failed to get requests")
			return
		}
	}

	if requests == nil {
		requests = []models.Request{}
	}

	writeJSON(w, http.StatusOK, requests)
}

// Create submits a new media request and dispatches it to the appropriate ARR service.
// POST /api/requests
func (h *RequestHandler) Create(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	if !h.clients.Enabled() {
		writeError(w, http.StatusForbidden, "requests feature is not enabled")
		return
	}

	var payload models.CreateRequestPayload
	if err := decodeJSON(w, r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate required fields
	if payload.MediaType != "movie" && payload.MediaType != "tv" {
		writeError(w, http.StatusBadRequest, "media_type must be 'movie' or 'tv'")
		return
	}
	if payload.TMDBID <= 0 {
		writeError(w, http.StatusBadRequest, "tmdb_id is required")
		return
	}
	if payload.Title == "" {
		writeError(w, http.StatusBadRequest, "title is required")
		return
	}

	// 2026-05-19 audit (API-H5) — cap free-text fields. Without these,
	// the 1 MB request body limit could still admit individual fields
	// up to ~1 MB each, which get stored verbatim and later passed to
	// Radarr/Sonarr. Caps are generous against real TMDB values:
	// titles top out around 200 chars, overviews around 1000.
	if len(payload.Title) > 500 {
		writeError(w, http.StatusBadRequest, "title must be 500 characters or fewer")
		return
	}
	if len(payload.Overview) > 4000 {
		writeError(w, http.StatusBadRequest, "overview must be 4000 characters or fewer")
		return
	}
	if len(payload.PosterPath) > 1000 {
		writeError(w, http.StatusBadRequest, "poster_path must be 1000 characters or fewer")
		return
	}

	if !payload.Quality1080p && !payload.Quality4K {
		writeError(w, http.StatusBadRequest, "at least one quality must be selected")
		return
	}

	// Check for existing active request
	exists, err := h.queries.RequestExistsActive(r.Context(), claims.UserID, payload.MediaType, payload.TMDBID)
	if err != nil {
		slog.Error("failed to check existing request", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to check existing request")
		return
	}
	if exists {
		writeError(w, http.StatusConflict, "you already have an active request for this media")
		return
	}

	// Validate that the appropriate ARR service is configured
	radarr := h.clients.Radarr()
	sonarr := h.clients.Sonarr()
	if payload.MediaType == "movie" && (radarr == nil || !radarr.IsConfigured()) {
		writeError(w, http.StatusBadRequest, "Radarr is not configured — movie requests are not available")
		return
	}
	if payload.MediaType == "tv" && (sonarr == nil || !sonarr.IsConfigured()) {
		writeError(w, http.StatusBadRequest, "Sonarr is not configured — TV requests are not available")
		return
	}

	now := time.Now()

	// Quota gating (carve-out C). Admins bypass all gating and dispatch
	// immediately. Regular users are held for admin approval once they reach
	// either the active-in-flight cap or the rolling 24h submission cap; held
	// requests are inserted as pending_approval and NOT dispatched until an
	// admin approves them.
	status := models.RequestPending
	// Review LOW-7: held requests are inserted (not rejected), and each
	// insert alerts every admin — so without a cap, N distinct titles = N
	// pushes to every admin's phone. Past double the daily quota the held
	// rows still land in the Requests view, but the pings stop.
	suppressAdminAlert := false
	if claims.Role != string(models.RoleAdmin) {
		activeMax, dailyMax := h.requestQuota(r.Context())

		activeCount, err := h.queries.CountActiveRequestsByUser(r.Context(), claims.UserID)
		if err != nil {
			slog.Error("failed to count active requests", "error", err, "user_id", claims.UserID)
			writeError(w, http.StatusInternalServerError, "failed to check request quota")
			return
		}
		dailyCount, err := h.queries.CountUserRequestsSince(r.Context(), claims.UserID, now.Add(-24*time.Hour))
		if err != nil {
			slog.Error("failed to count daily requests", "error", err, "user_id", claims.UserID)
			writeError(w, http.StatusInternalServerError, "failed to check request quota")
			return
		}
		if activeCount >= activeMax || dailyCount >= dailyMax {
			status = models.RequestPendingApproval
		}
		if dailyCount >= dailyMax*2 {
			suppressAdminAlert = true
		}
	}

	req := &models.Request{
		UserID:       claims.UserID,
		MediaType:    payload.MediaType,
		TMDBID:       payload.TMDBID,
		Title:        payload.Title,
		PosterPath:   payload.PosterPath,
		Overview:     payload.Overview,
		Year:         payload.Year,
		Status:       status,
		Quality1080p: payload.Quality1080p,
		Quality4K:    payload.Quality4K,
		RequestedAt:  now,
		UpdatedAt:    now,
	}

	if err := h.queries.InsertRequest(r.Context(), req); err != nil {
		// The partial-unique index idx_requests_active_unique catches two
		// concurrent Creates that both passed the RequestExistsActive check
		// (TOCTOU race). Return 409 in that specific case so the client can
		// distinguish "you already requested this" from a real server error.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeError(w, http.StatusConflict, "you already have an active request for this title")
			return
		}
		slog.Error("failed to insert request", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to create request")
		return
	}

	// Tell the admins — for held requests this is the review nudge, for
	// admitted ones a heads-up. Deduped per (admin, request, type) by the
	// notifications table; the requester is excluded (their own request is
	// not news to them). Detached goroutine: fan-out must not add latency
	// to the response, and AdminNewRequest detaches from ctx internally.
	if h.dispatcher != nil && !suppressAdminAlert {
		go h.dispatcher.AdminNewRequest(r.Context(), req, claims.UserID)
	}

	// Only dispatch immediately when the request was admitted (pending).
	// Held (pending_approval) requests wait for an admin to approve them via
	// ApproveRequest, which performs the dispatch at that point.
	if status == models.RequestPending {
		// Dispatch to ARR service in background goroutine. Lifecycle is tied
		// to h.rootCtx (set by main.go via SetRootContext) so graceful shutdown
		// cancels in-flight ARR calls and the follow-up DB writes.
		go h.dispatchToARR(req)
	}

	if h.activity != nil {
		eventType := "request_created"
		if status == models.RequestPendingApproval {
			eventType = "request_pending_approval"
		}
		h.activity.log(r.Context(), &models.ActivityEntry{
			UserID:    &claims.UserID,
			EventType: eventType,
			Details:   map[string]interface{}{"title": req.Title, "type": req.MediaType, "tmdb_id": req.TMDBID},
		})
	}

	writeJSON(w, http.StatusCreated, req)
}

// requestQuota returns the per-user request quotas: the maximum number of
// simultaneously-active (pending/processing/pending_approval) requests, and the
// maximum number of requests in a rolling 24h window. Defaults are 10 active /
// 25 daily, each overridable via the server_settings keys
// 'requests_quota_active' and 'requests_quota_daily'. A stored value only
// overrides the default when it parses to a positive integer, so a missing,
// empty, or malformed setting safely falls back to the default.
func (h *RequestHandler) requestQuota(ctx context.Context) (int, int) {
	activeMax, dailyMax := 10, 25

	if v, err := h.queries.GetSetting(ctx, "requests_quota_active"); err == nil {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			activeMax = n
		}
	}
	if v, err := h.queries.GetSetting(ctx, "requests_quota_daily"); err == nil {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			dailyMax = n
		}
	}
	return activeMax, dailyMax
}

// dispatchToARR sends a request to the appropriate Radarr/Sonarr instance.
// Runs in a background goroutine. Updates status to processing on success, failed on error.
//
// Parents off h.rootCtx (the server lifecycle) so graceful shutdown actually
// stops in-flight ARR calls and the subsequent DB writes — without this, a
// goroutine launched seconds before shutdown could still hit the DB pool
// after Close, producing "use of closed pool" panics.
func (h *RequestHandler) dispatchToARR(req *models.Request) {
	parent := h.rootCtx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()

	// Re-confirm the request row still exists before mutating ARR services.
	// Between the API handler accepting the request and this goroutine
	// running, the user could be deleted (CASCADE removes the request) or
	// the request itself could be deleted by the user. If we proceed
	// blindly, Radarr/Sonarr get the order while our DB has no record —
	// the request appears to "succeed" but is invisible to the user, and
	// the download still hits disk. Cheap pre-check beats the alternative.
	current, err := h.queries.GetRequestByID(ctx, req.ID)
	if err != nil || current == nil {
		slog.Info("ARR dispatch skipped: request no longer exists",
			"request_id", req.ID, "lookup_error", err)
		return
	}

	var arrErr error
	var arrJobIDs string

	switch req.MediaType {
	case "movie":
		arrErr = h.dispatchMovie(ctx, req, &arrJobIDs)
	case "tv":
		arrErr = h.dispatchTV(ctx, req, &arrJobIDs)
	default:
		arrErr = fmt.Errorf("unsupported media type: %s", req.MediaType)
	}

	if arrErr != nil {
		slog.Error("ARR dispatch failed", "request_id", req.ID, "error", arrErr)
		if updateErr := h.queries.UpdateRequestStatus(ctx, req.ID, models.RequestFailed, "", arrErr.Error()); updateErr != nil {
			slog.Error("failed to update request status to failed", "request_id", req.ID, "error", updateErr)
		}
		h.broadcastRequestStatus(req, models.RequestFailed)
		return
	}

	if updateErr := h.queries.UpdateRequestStatus(ctx, req.ID, models.RequestProcessing, arrJobIDs, ""); updateErr != nil {
		slog.Error("failed to update request status to processing", "request_id", req.ID, "error", updateErr)
		return
	}
	h.broadcastRequestStatus(req, models.RequestProcessing)
}

// pendingRecoveryGrace is how long a request may sit in 'pending' before the
// recovery sweep treats its dispatch goroutine as orphaned. It comfortably
// exceeds dispatchToARR's 30s timeout so a live, in-flight dispatch is never
// re-fired underneath itself.
const pendingRecoveryGrace = 2 * time.Minute

// pendingRecoveryInterval is the cadence of the periodic recovery sweep after
// the initial post-boot pass.
const pendingRecoveryInterval = 5 * time.Minute

// StartPendingRecovery reconciles requests orphaned in 'pending' by an
// interrupted dispatch goroutine — the process crashed/restarted or graceful
// shutdown cancelled the root context between Create's INSERT and dispatchToARR
// finishing. Without this, such a request is stranded forever ('pending' is
// never re-examined by the monitor, which only polls 'processing'), and because
// RequestExistsActive treats 'pending' as active the user can't even re-request
// it. The sweep runs once shortly after boot and then periodically until ctx is
// cancelled. Re-dispatch is idempotent: dispatchToARR re-confirms the row
// still exists, and addMovieToRadarr/addSeriesToSonarr skip the ARR add when
// the title is already present, so an orphan whose original dispatch already
// reached Radarr/Sonarr is reconciled to processing rather than failed. See
// audit H4. Run in a goroutine: go h.StartPendingRecovery(ctx).
func (h *RequestHandler) StartPendingRecovery(ctx context.Context) {
	// Brief initial delay so boot-time dispatches and the DB pool settle
	// before the first sweep (and so a request created seconds before a clean
	// restart isn't re-fired prematurely — the grace window guards that too).
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			h.recoverStalePending(ctx)
			timer.Reset(pendingRecoveryInterval)
		}
	}
}

// recoverStalePending finds pending requests older than the grace window and
// re-runs their ARR dispatch sequentially (sequential, not fan-out, to avoid
// hammering Radarr/Sonarr on a backlog).
func (h *RequestHandler) recoverStalePending(ctx context.Context) {
	cutoff := time.Now().Add(-pendingRecoveryGrace)
	stale, err := h.queries.GetStalePendingRequests(ctx, cutoff)
	if err != nil {
		slog.Error("pending-request recovery: query failed", "error", err)
		return
	}
	if len(stale) == 0 {
		return
	}
	slog.Info("pending-request recovery: re-dispatching orphaned requests", "count", len(stale))
	for i := range stale {
		if ctx.Err() != nil {
			return
		}
		req := stale[i]
		h.dispatchToARR(&req)
	}
}

// dispatchMovie sends a movie request to Radarr.
// When both 1080p and 4K are requested, dispatches to both instances.
func (h *RequestHandler) dispatchMovie(ctx context.Context, req *models.Request, arrJobIDs *string) error {
	radarr := h.clients.Radarr()
	radarr4K := h.clients.Radarr4K()
	dualQuality := req.Quality1080p && req.Quality4K && radarr != nil && radarr.IsConfigured() && radarr4K != nil && radarr4K.IsConfigured()

	if dualQuality {
		// Dispatch to both regular and 4K instances
		ids, err := h.addMovieToRadarr(ctx, req, radarr, "radarr")
		if err != nil {
			return fmt.Errorf("failed to add movie to Radarr: %w", err)
		}
		ids4K, err := h.addMovieToRadarr(ctx, req, radarr4K, "radarr4k")
		if err != nil {
			// Regular succeeded but 4K failed. Store partial IDs so the
			// monitor can still track the successful regular dispatch.
			slog.Warn("4K dispatch failed, falling back to regular only", "error", err)
			*arrJobIDs = ids
			return nil
		}
		*arrJobIDs = ids + "|" + ids4K
		return nil
	}

	// Single-instance dispatch
	client := radarr
	prefix := "radarr"
	if req.Quality4K && !req.Quality1080p && radarr4K != nil && radarr4K.IsConfigured() {
		client = radarr4K
		prefix = "radarr4k"
	}
	if client == nil || !client.IsConfigured() {
		return fmt.Errorf("Radarr is not configured")
	}

	ids, err := h.addMovieToRadarr(ctx, req, client, prefix)
	if err != nil {
		return err
	}
	*arrJobIDs = ids
	return nil
}

// addMovieToRadarr adds a movie to a specific Radarr instance and returns the job ID string.
func (h *RequestHandler) addMovieToRadarr(ctx context.Context, req *models.Request, client *arr.RadarrClient, prefix string) (string, error) {
	// Idempotency (audit H4 follow-up): AddMovie is a bare POST with no
	// existence check, and Radarr returns HTTP 400 for an already-added title,
	// which doRequest maps to an error. On the recovery path an orphaned
	// request may already be in Radarr (its original dispatch reached the API
	// but the process died before the DB status write), and on the normal path
	// the title may have been added out-of-band. Re-adding would then wrongly
	// mark the request failed, so treat an existing movie as a successful
	// (idempotent) dispatch and hand back its id for the monitor to reconcile.
	if existing, err := client.GetMovie(ctx, req.TMDBID); err != nil {
		return "", fmt.Errorf("failed to check %s for existing movie: %w", prefix, err)
	} else if existing != nil {
		slog.Info("movie already present in ARR; treating as dispatched",
			"prefix", prefix, "tmdb_id", req.TMDBID, "movie_id", existing.ID)
		return fmt.Sprintf("%s:%d", prefix, existing.ID), nil
	}

	folders, err := client.GetRootFolders(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get %s root folders: %w", prefix, err)
	}
	if len(folders) == 0 {
		return "", fmt.Errorf("no root folders configured in %s", prefix)
	}
	profiles, err := client.GetQualityProfiles(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get %s quality profiles: %w", prefix, err)
	}
	if len(profiles) == 0 {
		return "", fmt.Errorf("no quality profiles configured in %s", prefix)
	}
	movie, err := client.AddMovie(ctx, req.TMDBID, req.Title, req.Year, profiles[0].ID, folders[0].Path)
	if err != nil {
		return "", fmt.Errorf("failed to add movie to %s: %w", prefix, err)
	}
	return fmt.Sprintf("%s:%d", prefix, movie.ID), nil
}

// dispatchTV sends a TV request to Sonarr. First resolves TMDB ID to TVDB ID via lookup.
// When both 1080p and 4K are requested, dispatches to both instances.
func (h *RequestHandler) dispatchTV(ctx context.Context, req *models.Request, arrJobIDs *string) error {
	sonarr := h.clients.Sonarr()
	sonarr4K := h.clients.Sonarr4K()
	dualQuality := req.Quality1080p && req.Quality4K && sonarr != nil && sonarr.IsConfigured() && sonarr4K != nil && sonarr4K.IsConfigured()

	if dualQuality {
		ids, err := h.addSeriesToSonarr(ctx, req, sonarr, "sonarr")
		if err != nil {
			return fmt.Errorf("failed to add series to Sonarr: %w", err)
		}
		ids4K, err := h.addSeriesToSonarr(ctx, req, sonarr4K, "sonarr4k")
		if err != nil {
			// Regular succeeded but 4K failed. Store partial IDs so the
			// monitor can still track the successful regular dispatch.
			slog.Warn("4K dispatch failed, falling back to regular only", "error", err)
			*arrJobIDs = ids
			return nil
		}
		*arrJobIDs = ids + "|" + ids4K
		return nil
	}

	// Single-instance dispatch
	client := sonarr
	prefix := "sonarr"
	if req.Quality4K && !req.Quality1080p && sonarr4K != nil && sonarr4K.IsConfigured() {
		client = sonarr4K
		prefix = "sonarr4k"
	}
	if client == nil || !client.IsConfigured() {
		return fmt.Errorf("Sonarr is not configured")
	}

	ids, err := h.addSeriesToSonarr(ctx, req, client, prefix)
	if err != nil {
		return err
	}
	*arrJobIDs = ids
	return nil
}

// addSeriesToSonarr adds a series to a specific Sonarr instance and returns the job ID string.
//
// TMDB→TVDB resolution tries three layers:
//
//	A. Sonarr's lookup with `tmdb:{id}` (uses Skyhook's cached mapping).
//	B. TMDB's /tv/{id}/external_ids to read tvdb_id directly, then re-query
//	   Sonarr with `tvdb:{id}` (handles stale Skyhook cache).
//	C. TVDB SearchSeries by title+year (handles cases where TMDB itself lacks
//	   the tvdb_id link).
//
// Only A's "not found" outcome triggers fallback — network/auth errors short-
// circuit immediately so we don't mask infrastructure problems.
func (h *RequestHandler) addSeriesToSonarr(ctx context.Context, req *models.Request, client *arr.SonarrClient, prefix string) (string, error) {
	tvdbID, err := h.resolveTvdbID(ctx, req, client, prefix)
	if err != nil {
		return "", err
	}

	// Idempotency (audit H4 follow-up): see addMovieToRadarr. If the series is
	// already in this Sonarr instance, re-adding 400s and would wrongly fail
	// the request, so treat it as a successful dispatch and return its id.
	if existing, err := client.GetSeries(ctx, tvdbID); err != nil {
		return "", fmt.Errorf("failed to check %s for existing series: %w", prefix, err)
	} else if existing != nil {
		slog.Info("series already present in ARR; treating as dispatched",
			"prefix", prefix, "tvdb_id", tvdbID, "series_id", existing.ID)
		return fmt.Sprintf("%s:%d:%d", prefix, existing.ID, existing.TvdbID), nil
	}

	folders, err := client.GetRootFolders(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get %s root folders: %w", prefix, err)
	}
	if len(folders) == 0 {
		return "", fmt.Errorf("no root folders configured in %s", prefix)
	}
	profiles, err := client.GetQualityProfiles(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get %s quality profiles: %w", prefix, err)
	}
	if len(profiles) == 0 {
		return "", fmt.Errorf("no quality profiles configured in %s", prefix)
	}
	series, err := client.AddSeries(ctx, tvdbID, req.Title, req.Year, profiles[0].ID, folders[0].Path)
	if err != nil {
		return "", fmt.Errorf("failed to add series to %s: %w", prefix, err)
	}
	return fmt.Sprintf("%s:%d:%d", prefix, series.ID, series.TvdbID), nil
}

// resolveTvdbID walks the A→B→C fallback chain to discover the TVDB ID for a
// TMDB-keyed request. Returns a user-actionable error if all layers fail.
func (h *RequestHandler) resolveTvdbID(ctx context.Context, req *models.Request, client *arr.SonarrClient, prefix string) (int, error) {
	// --- Layer A: Sonarr's TMDB-keyed lookup (the happy path) ---
	lookup, err := client.LookupSeriesByTmdbID(ctx, req.TMDBID)
	if err == nil {
		return lookup.TvdbID, nil
	}
	// Anything other than "not found" is treated as a hard failure — Sonarr
	// is unreachable, the API key is wrong, etc. Don't waste TMDB/TVDB calls.
	if !errors.Is(err, arr.ErrSeriesNotFound) {
		return 0, fmt.Errorf("Sonarr lookup failed via %s: %w", prefix, err)
	}
	slog.Info("Sonarr Skyhook missed TMDB lookup, trying fallbacks",
		"tmdb_id", req.TMDBID, "title", req.Title, "instance", prefix)

	// --- Layer B: TMDB external_ids → re-query Sonarr by TVDB ID ---
	if h.tmdb != nil {
		ids, tmdbErr := h.tmdb.GetTVExternalIDs(ctx, req.TMDBID)
		if tmdbErr == nil && ids.TVDB > 0 {
			slog.Info("recovered TVDB ID from TMDB external_ids",
				"tmdb_id", req.TMDBID, "tvdb_id", ids.TVDB)
			// Re-query Sonarr with the discovered TVDB ID. If Sonarr knows
			// the show under TVDB but not under TMDB, this succeeds.
			if confirmed, sErr := client.LookupSeriesByTvdbID(ctx, ids.TVDB); sErr == nil {
				return confirmed.TvdbID, nil
			} else if !errors.Is(sErr, arr.ErrSeriesNotFound) {
				return 0, fmt.Errorf("Sonarr lookup failed via %s: %w", prefix, sErr)
			}
			// Sonarr STILL doesn't know about it under TVDB either. Push the
			// raw TVDB ID through to AddSeries — Sonarr will fetch from
			// Skyhook itself, and if that fails it will error with a more
			// specific message than the lookup did.
			return ids.TVDB, nil
		}
		if tmdbErr != nil {
			slog.Warn("TMDB external_ids fallback failed", "tmdb_id", req.TMDBID, "error", tmdbErr)
		}
	}

	// --- Layer C: TVDB direct search by title+year ---
	if h.tvdb != nil && req.Title != "" {
		results, tvdbErr := h.tvdb.SearchSeries(ctx, req.Title, req.Year)
		if tvdbErr == nil {
			if id := bestTVDBMatch(results, req.Year); id > 0 {
				slog.Info("recovered TVDB ID via TVDB direct search",
					"tmdb_id", req.TMDBID, "tvdb_id", id, "title", req.Title)
				return id, nil
			}
		} else {
			slog.Warn("TVDB search fallback failed", "title", req.Title, "error", tvdbErr)
		}
	}

	// --- All layers exhausted: actionable user-facing error ---
	return 0, fmt.Errorf(
		"couldn't find %q in TVDB — this show may not be added to TVDB yet. "+
			"Check thetvdb.com to confirm, or try again in a few hours after caches refresh. "+
			"(TMDB ID: %d)",
		req.Title, req.TMDBID,
	)
}

// bestTVDBMatch picks the best TVDB search result for the given year.
// Prefers exact-year matches, then falls back to the first valid result.
// (TVDB's search already filters by query string, so title-level matching
// is delegated to the API.)
func bestTVDBMatch(results []metadata.TVDBSearchResult, year int) int {
	if len(results) == 0 {
		return 0
	}
	if year > 0 {
		for _, r := range results {
			if r.ParseYear() == year {
				if id := r.ParseID(); id > 0 {
					return id
				}
			}
		}
	}
	for _, r := range results {
		if id := r.ParseID(); id > 0 {
			return id
		}
	}
	return 0
}

// broadcastRequestStatus sends a request_status WebSocket event to the requesting user.
func (h *RequestHandler) broadcastRequestStatus(req *models.Request, status string) {
	h.hub.BroadcastToUser(req.UserID, ws.EventRequestStatus, map[string]interface{}{
		"request_id": req.ID,
		"title":      req.Title,
		"status":     status,
		"media_type": req.MediaType,
	})
}

// Delete removes a request. Users can only delete their own pending/failed requests;
// admins can delete any pending/failed request.
// DELETE /api/requests/{id}
func (h *RequestHandler) Delete(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	reqID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid request id")
		return
	}

	req, err := h.queries.GetRequestByID(r.Context(), reqID)
	if err != nil {
		slog.Error("failed to get request", "error", err, "request_id", reqID)
		writeError(w, http.StatusInternalServerError, "failed to get request")
		return
	}
	if req == nil {
		writeError(w, http.StatusNotFound, "request not found")
		return
	}

	// Ownership check: users can only delete their own requests
	if claims.Role != "admin" && req.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "you can only delete your own requests")
		return
	}

	// Can only delete pending or failed requests (processing/available should not be deleted)
	if req.Status != models.RequestPending && req.Status != models.RequestFailed {
		writeError(w, http.StatusBadRequest, "can only delete pending or failed requests")
		return
	}

	if err := h.queries.DeleteRequest(r.Context(), reqID); err != nil {
		slog.Error("failed to delete request", "error", err, "request_id", reqID)
		writeError(w, http.StatusInternalServerError, "failed to delete request")
		return
	}

	if h.activity != nil {
		h.activity.log(r.Context(), &models.ActivityEntry{
			UserID:    &claims.UserID,
			EventType: "request_deleted",
			Details:   map[string]interface{}{"request_id": reqID, "title": req.Title},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// ============================================================
// Admin Approval Queue (carve-out C)
// ============================================================

// ListPendingApprovals returns every request currently held for admin approval,
// oldest first. Admin-only — wired under the RequireAdmin /api/admin group.
// GET /api/admin/requests/pending
func (h *RequestHandler) ListPendingApprovals(w http.ResponseWriter, r *http.Request) {
	requests, err := h.queries.GetPendingApprovalRequests(r.Context())
	if err != nil {
		slog.Error("failed to get pending approval requests", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to get pending approvals")
		return
	}
	if requests == nil {
		requests = []models.Request{}
	}

	// Populate usernames so the admin queue shows who requested each title.
	// Single batch lookup (WHERE id = ANY) rather than per-row, matching the
	// admin List handler. Degrade gracefully if the lookup fails.
	seen := make(map[int64]struct{}, len(requests))
	ids := make([]int64, 0, len(requests))
	for _, req := range requests {
		if _, ok := seen[req.UserID]; ok {
			continue
		}
		seen[req.UserID] = struct{}{}
		ids = append(ids, req.UserID)
	}
	if len(ids) > 0 {
		usernameMap, uErr := h.queries.GetUsernamesByIDs(r.Context(), ids)
		if uErr != nil {
			slog.Warn("get usernames for pending approvals failed", "error", uErr)
		} else {
			for i := range requests {
				requests[i].Username = usernameMap[requests[i].UserID]
			}
		}
	}

	writeJSON(w, http.StatusOK, requests)
}

// ApproveRequest admits a held (pending_approval) request: it flips the status
// to pending and dispatches to the appropriate ARR service, exactly as a
// non-gated Create would have. Admin-only.
// POST /api/admin/requests/{id}/approve
func (h *RequestHandler) ApproveRequest(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	reqID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid request id")
		return
	}

	req, err := h.queries.GetRequestByID(r.Context(), reqID)
	if err != nil {
		slog.Error("failed to get request", "error", err, "request_id", reqID)
		writeError(w, http.StatusInternalServerError, "failed to get request")
		return
	}
	if req == nil {
		writeError(w, http.StatusNotFound, "request not found")
		return
	}
	if req.Status != models.RequestPendingApproval {
		writeError(w, http.StatusBadRequest, "request is not pending approval")
		return
	}

	if err := h.queries.UpdateRequestStatus(r.Context(), reqID, models.RequestPending, "", ""); err != nil {
		slog.Error("failed to approve request", "error", err, "request_id", reqID)
		writeError(w, http.StatusInternalServerError, "failed to approve request")
		return
	}

	// Dispatch now that the request is admitted. dispatchToARR re-reads the row
	// and drives it to processing/failed; lifecycle is tied to h.rootCtx.
	req.Status = models.RequestPending
	// Make the approval flip real-time: previously the client only saw movement
	// once dispatch flipped the row to processing/failed.
	h.broadcastRequestStatus(req, models.RequestPending)
	go h.dispatchToARR(req)

	if h.activity != nil {
		h.activity.log(r.Context(), &models.ActivityEntry{
			UserID:    &claims.UserID,
			EventType: "request_approved",
			Details:   map[string]interface{}{"request_id": reqID, "title": req.Title, "type": req.MediaType, "tmdb_id": req.TMDBID},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "approved"})
}

// DenyRequest rejects a held (pending_approval) request, marking it failed with
// a "denied by admin" message. The user can delete it and try again later.
// Admin-only.
// POST /api/admin/requests/{id}/deny
func (h *RequestHandler) DenyRequest(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	reqID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid request id")
		return
	}

	req, err := h.queries.GetRequestByID(r.Context(), reqID)
	if err != nil {
		slog.Error("failed to get request", "error", err, "request_id", reqID)
		writeError(w, http.StatusInternalServerError, "failed to get request")
		return
	}
	if req == nil {
		writeError(w, http.StatusNotFound, "request not found")
		return
	}
	if req.Status != models.RequestPendingApproval {
		writeError(w, http.StatusBadRequest, "request is not pending approval")
		return
	}

	if err := h.queries.UpdateRequestStatus(r.Context(), reqID, models.RequestFailed, "", "denied by admin"); err != nil {
		slog.Error("failed to deny request", "error", err, "request_id", reqID)
		writeError(w, http.StatusInternalServerError, "failed to deny request")
		return
	}

	if h.activity != nil {
		h.activity.log(r.Context(), &models.ActivityEntry{
			UserID:    &claims.UserID,
			EventType: "request_denied",
			Details:   map[string]interface{}{"request_id": reqID, "title": req.Title, "type": req.MediaType, "tmdb_id": req.TMDBID},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "denied"})
}

// ============================================================
// Request Monitor — Background Goroutine
// ============================================================

// RequestMonitor polls ARR services every 60 seconds to check if processing
// requests have completed (files downloaded). Updates status and sends
// WebSocket notifications on completion.
type RequestMonitor struct {
	queries    *db.Queries
	hub        *ws.Hub
	clients    *arr.ArrClients
	scanner    *library.Scanner
	dispatcher *notify.Dispatcher

	mu           sync.Mutex
	failCounts   map[int64]int              // consecutive API failures per request ID
	goneCounts   map[int64]int              // consecutive "item absent in ARR" polls per request ID (MED finding 1)
	lastProgress map[int64]downloadProgress // dedup cache for WS progress broadcasts
}

const maxMonitorFailures = 10

// maxGoneChecks bounds how many consecutive polls may report a request's ARR
// item as absent (no error, but the movie/series is no longer present in any
// instance we dispatched to) before we give up and mark the request failed.
//
// MED finding 1: previously only an ARR *error* incremented failCounts, so a
// legitimately-removed item (deleted from Radarr/Sonarr after dispatch) left
// the request pinned in 'processing' forever — and because any processing row
// holds the monitor at the 5s fast interval, that also meant perpetual
// fast-polling. A small bound tolerates a brief window where the item is
// momentarily not yet visible (e.g. just after an add, or a one-sided removal
// in a dual-quality pair) while still letting the request leave 'processing'.
const maxGoneChecks = 5

// NewRequestMonitor creates a new RequestMonitor. dispatcher carries
// request-lifecycle notifications to the bell, WS, and push; nil (tests)
// downgrades notifyRequest to a no-op.
func NewRequestMonitor(queries *db.Queries, hub *ws.Hub, clients *arr.ArrClients, scanner *library.Scanner, dispatcher *notify.Dispatcher) *RequestMonitor {
	return &RequestMonitor{
		queries:      queries,
		hub:          hub,
		clients:      clients,
		scanner:      scanner,
		dispatcher:   dispatcher,
		failCounts:   make(map[int64]int),
		goneCounts:   make(map[int64]int),
		lastProgress: make(map[int64]downloadProgress),
	}
}

// Polling cadence. Fast applies whenever any request is processing so the UI
// can paint near-real-time progress; slow applies whenever the queue is empty
// to avoid hammering ARR for no reason.
const (
	monitorFastInterval = 5 * time.Second
	monitorSlowInterval = 60 * time.Second
)

// Start begins the adaptive polling loop. Cadence flips between fast (5s) and
// slow (60s) based on whether any requests are currently processing. Runs
// until ctx is cancelled. Should be called in a goroutine: go monitor.Start(ctx)
func (m *RequestMonitor) Start(ctx context.Context) {
	slog.Info("request monitor started",
		"fast_interval", monitorFastInterval,
		"slow_interval", monitorSlowInterval,
	)

	// Poll once immediately so a server restart doesn't leave clients staring
	// at stale state for the full slow interval.
	active := m.pollOnce(ctx)
	timer := time.NewTimer(nextInterval(active))
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			slog.Info("request monitor stopped")
			return
		case <-timer.C:
			active := m.pollOnce(ctx)
			timer.Reset(nextInterval(active))
		}
	}
}

func nextInterval(activeCount int) time.Duration {
	if activeCount > 0 {
		return monitorFastInterval
	}
	return monitorSlowInterval
}

// pollOnce queries all processing requests, fetches download queues, broadcasts
// progress updates, and checks each request for completion. Returns the count
// of processing requests so the caller can pick the next polling interval.
func (m *RequestMonitor) pollOnce(ctx context.Context) int {
	// Honor the runtime feature toggle (audit H5 follow-up): when requests are
	// disabled, idle even if the ARR clients are still configured. Disabling
	// the feature only flips Enabled — it does not clear the Radarr/Sonarr
	// URL+key — so without this guard the always-on monitor would keep polling
	// ARR, and could complete or library-scan in-flight rows, while the feature
	// is supposedly off.
	if m.clients == nil || !m.clients.Enabled() {
		return 0
	}
	requests, err := m.queries.GetProcessingRequests(ctx)
	if err != nil {
		slog.Error("request monitor: failed to get processing requests", "error", err)
		return 0
	}

	if len(requests) == 0 {
		m.mu.Lock()
		if len(m.lastProgress) > 0 {
			m.lastProgress = make(map[int64]downloadProgress)
		}
		m.mu.Unlock()
		return 0
	}

	slog.Debug("request monitor: checking processing requests", "count", len(requests))

	// Batch-fetch download queues from each configured ARR instance.
	queues := m.fetchQueues(ctx)

	for i := range requests {
		if ctx.Err() != nil {
			return len(requests)
		}
		m.broadcastProgress(&requests[i], queues)
		m.checkRequest(ctx, &requests[i])
	}
	return len(requests)
}

// checkRequest polls the appropriate ARR service for a single request.
//
// The ARR check yields three outcomes: an error (infrastructure problem →
// handleCheckFailure), or a successful poll that reports the item as either
// present (still being processed/downloaded) or absent. "Absent" with no error
// means the movie/series was removed from every ARR instance we dispatched to
// after the request started processing; that request can never complete, so we
// must move it out of 'processing' (MED finding 1) rather than fast-poll it
// forever — see handleGone.
func (m *RequestMonitor) checkRequest(ctx context.Context, req *models.Request) {
	var present, available bool
	var checkErr error

	switch req.MediaType {
	case "movie":
		present, available, checkErr = m.checkMovie(ctx, req)
	case "tv":
		present, available, checkErr = m.checkTV(ctx, req)
	default:
		checkErr = fmt.Errorf("unsupported media type: %s", req.MediaType)
	}

	if checkErr != nil {
		m.handleCheckFailure(ctx, req, checkErr)
		return
	}

	// Successful poll: clear the API-failure counter regardless of outcome.
	m.mu.Lock()
	delete(m.failCounts, req.ID)
	m.mu.Unlock()

	// The item is no longer in ARR and not (yet) available. Count consecutive
	// "gone" polls and fail the request once the bound is reached. A present
	// item resets the counter below.
	if !present && !available {
		m.handleGone(ctx, req)
		return
	}

	// Item is present (or already available): reset the gone counter so an
	// earlier transient absence doesn't accumulate toward failure.
	m.mu.Lock()
	delete(m.goneCounts, req.ID)
	m.mu.Unlock()

	if available {
		slog.Info("request monitor: request fulfilled", "request_id", req.ID, "title", req.Title)
		if err := m.queries.UpdateRequestStatus(ctx, req.ID, models.RequestAvailable, "", ""); err != nil {
			slog.Error("request monitor: failed to update status", "request_id", req.ID, "error", err)
			return
		}
		m.mu.Lock()
		delete(m.lastProgress, req.ID)
		m.mu.Unlock()
		m.hub.BroadcastToUser(req.UserID, ws.EventRequestStatus, map[string]interface{}{
			"request_id": req.ID,
			"title":      req.Title,
			"status":     models.RequestAvailable,
			"media_type": req.MediaType,
		})
		// Durable "now available" notification (bell + panel); also pushed live.
		m.notifyRequest(ctx, req, models.NotificationRequestAvailable)
		// Trigger library scan so the new file appears in Aurora's catalog
		m.triggerMatchingLibraryScan(ctx, req)
	}
}

// triggerMatchingLibraryScan starts a scan on libraries whose type matches the request.
// Movies → "movie" libraries, TV → "show" libraries. Skips libraries already scanning.
func (m *RequestMonitor) triggerMatchingLibraryScan(ctx context.Context, req *models.Request) {
	if m.scanner == nil {
		return
	}

	libs, err := m.queries.GetLibraries(ctx)
	if err != nil {
		slog.Error("request monitor: failed to get libraries for auto-scan", "error", err)
		return
	}

	wantType := models.LibraryMovies
	if req.MediaType == "tv" {
		wantType = models.LibraryShows
	}

	for _, lib := range libs {
		if lib.Type != wantType {
			continue
		}
		if !m.scanner.TryStartScan(lib.ID) {
			slog.Debug("request monitor: scan already running, skipping", "library_id", lib.ID)
			continue
		}
		slog.Info("request monitor: triggering library scan", "library_id", lib.ID, "library", lib.Name, "reason", req.Title)
		go func(l *models.Library) {
			// ctx here descends from Start(ctx) with no timeout — the server
			// lifecycle. context.Background() detached the scan from shutdown
			// and let it write into a closed pool.
			m.scanner.ScanLibrary(ctx, l, func(p *models.ScanProgress) {
				m.hub.Broadcast(ws.EventScanProgress, p)
				if p.Status == models.ScanComplete && p.NewFiles > 0 {
					m.hub.Broadcast(ws.EventLibraryUpdate, map[string]interface{}{
						"library_id":   l.ID,
						"library_name": l.Name,
						"new_items":    p.NewFiles,
						"action":       "scan_completed",
					})
					if m.dispatcher != nil {
						m.dispatcher.ScanCompleted(context.Background(), l.Name, p.NewFiles)
					}
				}
			})
		}(lib)
	}
}

// checkMovie checks if a movie is available in Radarr.
// For dual-quality requests, both regular and 4K instances must have the file.
//
// Returns (present, available, error). present is true while the movie still
// exists in at least one instance we dispatched to; it goes false only once the
// movie has been removed from every such instance (MED finding 1 — lets a
// removed request leave 'processing' instead of fast-polling forever). For a
// dual-quality request, availability still requires the file in BOTH instances,
// but presence is the OR across them so a one-sided removal doesn't read as
// "gone" while the other half is still importing.
func (m *RequestMonitor) checkMovie(ctx context.Context, req *models.Request) (present bool, available bool, err error) {
	if isDualQuality(req) {
		radarr := m.clients.Radarr()
		radarr4K := m.clients.Radarr4K()
		if radarr == nil || !radarr.IsConfigured() || radarr4K == nil || !radarr4K.IsConfigured() {
			return false, false, fmt.Errorf("both Radarr instances required for dual-quality request")
		}
		exists1080, has1080, err := radarr.MovieExists(ctx, req.TMDBID)
		if err != nil {
			return false, false, err
		}
		exists4K, has4K, err := radarr4K.MovieExists(ctx, req.TMDBID)
		if err != nil {
			return false, false, err
		}
		return exists1080 || exists4K, has1080 && has4K, nil
	}

	client := m.clients.Radarr()
	if r4k := m.clients.Radarr4K(); req.Quality4K && !req.Quality1080p && r4k != nil && r4k.IsConfigured() {
		client = r4k
	}
	if client == nil || !client.IsConfigured() {
		return false, false, fmt.Errorf("Radarr is not configured")
	}
	exists, hasFile, err := client.MovieExists(ctx, req.TMDBID)
	if err != nil {
		return false, false, err
	}
	return exists, hasFile, nil
}

// checkTV checks if a TV series has episodes in Sonarr.
// For dual-quality requests, both regular and 4K instances must have episodes.
//
// Returns (present, available, error). See checkMovie for the presence
// semantics: present stays true while the series exists in at least one
// instance we dispatched to and goes false only once it is absent from every
// such instance (MED finding 1).
func (m *RequestMonitor) checkTV(ctx context.Context, req *models.Request) (present bool, available bool, err error) {
	if isDualQuality(req) {
		sonarr := m.clients.Sonarr()
		sonarr4K := m.clients.Sonarr4K()
		if sonarr == nil || !sonarr.IsConfigured() || sonarr4K == nil || !sonarr4K.IsConfigured() {
			return false, false, fmt.Errorf("both Sonarr instances required for dual-quality request")
		}
		// Parse dual job IDs: "sonarr:5:82493|sonarr4k:8:82493"
		parts := splitArrJobIDs(req.ArrJobIDs)
		var has1080, has4K, exists1080, exists4K bool
		for _, part := range parts {
			_, tvdbID, _ := parseTVArrIDs(part)
			if tvdbID <= 0 {
				continue
			}
			if strings.HasPrefix(part, "sonarr4k:") {
				exists, hasEps, err := sonarr4K.SeriesExists(ctx, tvdbID)
				if err != nil {
					return false, false, err
				}
				exists4K = exists
				has4K = hasEps
			} else {
				exists, hasEps, err := sonarr.SeriesExists(ctx, tvdbID)
				if err != nil {
					return false, false, err
				}
				exists1080 = exists
				has1080 = hasEps
			}
		}
		return exists1080 || exists4K, has1080 && has4K, nil
	}

	client := m.clients.Sonarr()
	if s4k := m.clients.Sonarr4K(); req.Quality4K && !req.Quality1080p && s4k != nil && s4k.IsConfigured() {
		client = s4k
	}
	if client == nil || !client.IsConfigured() {
		return false, false, fmt.Errorf("Sonarr is not configured")
	}

	_, tvdbID, _ := parseTVArrIDs(req.ArrJobIDs)
	if tvdbID <= 0 {
		return false, false, fmt.Errorf("invalid TVDB ID in arr_job_ids: %q", req.ArrJobIDs)
	}
	exists, hasEpisodes, checkErr := client.SeriesExists(ctx, tvdbID)
	if checkErr != nil {
		return false, false, checkErr
	}
	return exists, hasEpisodes, nil
}

// handleCheckFailure increments the failure counter and marks the request as
// failed after maxMonitorFailures consecutive failures.
func (m *RequestMonitor) handleCheckFailure(ctx context.Context, req *models.Request, checkErr error) {
	m.mu.Lock()
	m.failCounts[req.ID]++
	count := m.failCounts[req.ID]
	m.mu.Unlock()

	slog.Warn("request monitor: check failed",
		"request_id", req.ID,
		"title", req.Title,
		"consecutive_failures", count,
		"error", checkErr,
	)

	if count >= maxMonitorFailures {
		errMsg := fmt.Sprintf("gave up after %d consecutive failures: %v", count, checkErr)
		if err := m.queries.UpdateRequestStatus(ctx, req.ID, models.RequestFailed, "", errMsg); err != nil {
			slog.Error("request monitor: failed to mark request as failed", "request_id", req.ID, "error", err)
			return
		}

		m.mu.Lock()
		delete(m.failCounts, req.ID)
		delete(m.goneCounts, req.ID)
		delete(m.lastProgress, req.ID)
		m.mu.Unlock()

		m.hub.BroadcastToUser(req.UserID, ws.EventRequestStatus, map[string]interface{}{
			"request_id": req.ID,
			"title":      req.Title,
			"status":     models.RequestFailed,
			"media_type": req.MediaType,
		})
		m.notifyRequest(ctx, req, models.NotificationRequestFailed)
	}
}

// handleGone counts consecutive polls in which a request's ARR item is absent
// (no error, but the movie/series is gone from every instance we dispatched to)
// and marks the request failed once maxGoneChecks is reached.
//
// MED finding 1: without this, a request whose item was deleted from
// Radarr/Sonarr after it reached 'processing' stayed there indefinitely — the
// completion check returned (available=false) with no error, so failCounts
// never advanced, and the row kept the monitor pinned at the 5s fast interval.
// The bound absorbs a brief, benign absence (e.g. immediately after an add, or
// a transient one-sided removal in a dual-quality pair) before giving up.
func (m *RequestMonitor) handleGone(ctx context.Context, req *models.Request) {
	m.mu.Lock()
	m.goneCounts[req.ID]++
	count := m.goneCounts[req.ID]
	m.mu.Unlock()

	slog.Warn("request monitor: ARR item absent",
		"request_id", req.ID,
		"title", req.Title,
		"consecutive_gone", count,
	)

	if count < maxGoneChecks {
		return
	}

	errMsg := fmt.Sprintf(
		"media was removed from the download service after %d consecutive checks; "+
			"it may have been deleted in Radarr/Sonarr — delete this request and try again",
		count,
	)
	if err := m.queries.UpdateRequestStatus(ctx, req.ID, models.RequestFailed, "", errMsg); err != nil {
		slog.Error("request monitor: failed to mark gone request as failed", "request_id", req.ID, "error", err)
		return
	}

	m.mu.Lock()
	delete(m.goneCounts, req.ID)
	delete(m.failCounts, req.ID)
	delete(m.lastProgress, req.ID)
	m.mu.Unlock()

	slog.Info("request monitor: request marked failed (ARR item gone)", "request_id", req.ID, "title", req.Title)
	m.hub.BroadcastToUser(req.UserID, ws.EventRequestStatus, map[string]interface{}{
		"request_id": req.ID,
		"title":      req.Title,
		"status":     models.RequestFailed,
		"media_type": req.MediaType,
	})
	m.notifyRequest(ctx, req, models.NotificationRequestFailed)
}

// notifyRequest hands a request lifecycle outcome to the notification
// pipeline: persist (deduped by (user, request, type)) → WS 'notification'
// event → push fan-out, all best-effort. The dispatcher owns the
// WithoutCancel+timeout detachment this function used to hand-roll — the
// status UPDATE has already committed, so a graceful shutdown must not drop
// the only record an offline user will get.
func (m *RequestMonitor) notifyRequest(ctx context.Context, req *models.Request, notifType string) {
	if m.dispatcher == nil {
		return
	}
	reqID := req.ID
	m.dispatcher.Notify(ctx, &models.Notification{
		UserID:    req.UserID,
		Type:      notifType,
		Title:     req.Title,
		MediaType: req.MediaType,
		RequestID: &reqID,
	})
}

// ============================================================
// Download Progress Tracking
// ============================================================

// downloadProgress represents the current download state of a request.
// Held in-memory only — not persisted to DB.
type downloadProgress struct {
	RequestID   int64   `json:"request_id"`
	Title       string  `json:"title"`
	MediaType   string  `json:"media_type"`
	Stage       string  `json:"stage"`
	Percent     float64 `json:"percent"`
	SizeTotal   int64   `json:"size_total"`
	SizeLeft    int64   `json:"size_left"`
	ETA         string  `json:"eta"`
	Protocol    string  `json:"protocol"`
	ReleaseName string  `json:"release_name"`
}

// arrQueues holds pre-fetched queue data from each ARR instance.
type arrQueues struct {
	radarr   []arr.QueueItem
	radarr4K []arr.QueueItem
	sonarr   []arr.QueueItem
	sonarr4K []arr.QueueItem
}

// fetchQueues fetches the download queue from each configured ARR instance.
func (m *RequestMonitor) fetchQueues(ctx context.Context) *arrQueues {
	q := &arrQueues{}

	if c := m.clients.Radarr(); c != nil && c.IsConfigured() {
		items, err := c.GetQueue(ctx)
		if err != nil {
			slog.Debug("request monitor: failed to fetch Radarr queue", "error", err)
		} else {
			q.radarr = items
		}
	}
	if c := m.clients.Radarr4K(); c != nil && c.IsConfigured() {
		items, err := c.GetQueue(ctx)
		if err != nil {
			slog.Debug("request monitor: failed to fetch Radarr 4K queue", "error", err)
		} else {
			q.radarr4K = items
		}
	}
	if c := m.clients.Sonarr(); c != nil && c.IsConfigured() {
		items, err := c.GetQueue(ctx)
		if err != nil {
			slog.Debug("request monitor: failed to fetch Sonarr queue", "error", err)
		} else {
			q.sonarr = items
		}
	}
	if c := m.clients.Sonarr4K(); c != nil && c.IsConfigured() {
		items, err := c.GetQueue(ctx)
		if err != nil {
			slog.Debug("request monitor: failed to fetch Sonarr 4K queue", "error", err)
		} else {
			q.sonarr4K = items
		}
	}

	return q
}

// broadcastProgress looks up the request in the ARR queue data and sends
// a request_progress WS event if the progress has changed since last poll.
func (m *RequestMonitor) broadcastProgress(req *models.Request, queues *arrQueues) {
	var progress *downloadProgress

	switch req.MediaType {
	case "movie":
		progress = m.findMovieProgress(req, queues)
	case "tv":
		progress = m.findTVProgress(req, queues)
	}

	if progress == nil {
		m.mu.Lock()
		_, hasPrev := m.lastProgress[req.ID]
		m.mu.Unlock()
		if !hasPrev {
			progress = &downloadProgress{
				RequestID: req.ID,
				Title:     req.Title,
				MediaType: req.MediaType,
				Stage:     "sent",
				Percent:   0,
			}
		} else {
			return
		}
	}

	m.mu.Lock()
	last, exists := m.lastProgress[req.ID]
	changed := !exists ||
		last.Stage != progress.Stage ||
		last.Percent != progress.Percent ||
		last.SizeLeft != progress.SizeLeft
	if changed {
		m.lastProgress[req.ID] = *progress
	}
	m.mu.Unlock()

	if changed {
		m.hub.BroadcastToUser(req.UserID, ws.EventRequestProgress, progress)
	}
}

// findMovieProgress finds the queue item for a movie request.
// For dual-quality requests, aggregates progress from both queues.
func (m *RequestMonitor) findMovieProgress(req *models.Request, queues *arrQueues) *downloadProgress {
	if isDualQuality(req) {
		return m.findDualMovieProgress(req, queues)
	}

	radarrID, ok := parseMovieArrIDs(req.ArrJobIDs)
	if !ok {
		return nil
	}

	items := queues.radarr
	if r4k := m.clients.Radarr4K(); req.Quality4K && !req.Quality1080p && r4k != nil && r4k.IsConfigured() {
		items = queues.radarr4K
	}

	for i := range items {
		if items[i].MovieID == radarrID {
			return queueItemToProgress(req, &items[i])
		}
	}
	return nil
}

// findDualMovieProgress aggregates progress from both Radarr and Radarr 4K queues.
func (m *RequestMonitor) findDualMovieProgress(req *models.Request, queues *arrQueues) *downloadProgress {
	parts := splitArrJobIDs(req.ArrJobIDs)
	var matched []arr.QueueItem

	for _, part := range parts {
		radarrID, ok := parseMovieArrIDs(part)
		if !ok {
			continue
		}
		items := queues.radarr
		if strings.HasPrefix(part, "radarr4k:") {
			items = queues.radarr4K
		}
		for i := range items {
			if items[i].MovieID == radarrID {
				matched = append(matched, items[i])
			}
		}
	}

	if len(matched) == 0 {
		return nil
	}
	return aggregateQueueProgress(req, matched)
}

// findTVProgress finds queue items for a TV request and aggregates progress.
// For dual-quality requests, aggregates from both Sonarr queues.
func (m *RequestMonitor) findTVProgress(req *models.Request, queues *arrQueues) *downloadProgress {
	if isDualQuality(req) {
		return m.findDualTVProgress(req, queues)
	}

	sonarrID, _, hasSonarrID := parseTVArrIDs(req.ArrJobIDs)
	if !hasSonarrID {
		return nil
	}

	items := queues.sonarr
	if s4k := m.clients.Sonarr4K(); req.Quality4K && !req.Quality1080p && s4k != nil && s4k.IsConfigured() {
		items = queues.sonarr4K
	}

	var matched []arr.QueueItem
	for _, qi := range items {
		if qi.SeriesID == sonarrID {
			matched = append(matched, qi)
		}
	}
	if len(matched) == 0 {
		return nil
	}
	return aggregateQueueProgress(req, matched)
}

// findDualTVProgress aggregates progress from both Sonarr and Sonarr 4K queues.
func (m *RequestMonitor) findDualTVProgress(req *models.Request, queues *arrQueues) *downloadProgress {
	parts := splitArrJobIDs(req.ArrJobIDs)
	var matched []arr.QueueItem

	for _, part := range parts {
		sonarrID, _, hasSonarrID := parseTVArrIDs(part)
		if !hasSonarrID {
			continue
		}
		items := queues.sonarr
		if strings.HasPrefix(part, "sonarr4k:") {
			items = queues.sonarr4K
		}
		for _, qi := range items {
			if qi.SeriesID == sonarrID {
				matched = append(matched, qi)
			}
		}
	}

	if len(matched) == 0 {
		return nil
	}
	return aggregateQueueProgress(req, matched)
}

// queueItemToProgress converts a single QueueItem to downloadProgress.
func queueItemToProgress(req *models.Request, qi *arr.QueueItem) *downloadProgress {
	var pct float64
	if qi.Size > 0 {
		pct = ((qi.Size - qi.Sizeleft) / qi.Size) * 100
	}

	return &downloadProgress{
		RequestID:   req.ID,
		Title:       req.Title,
		MediaType:   req.MediaType,
		Stage:       mapQueueStage(qi),
		Percent:     math.Round(pct*10) / 10,
		SizeTotal:   int64(qi.Size),
		SizeLeft:    int64(qi.Sizeleft),
		ETA:         qi.Timeleft,
		Protocol:    qi.Protocol,
		ReleaseName: qi.Title,
	}
}

// mapQueueStage maps Radarr/Sonarr queue status fields to simplified stage names.
func mapQueueStage(qi *arr.QueueItem) string {
	switch qi.TrackedDownloadState {
	case "importing":
		return "importing"
	case "importPending":
		return "downloaded"
	case "failedPending":
		return "failed_import"
	}

	switch qi.Status {
	case "queued", "delay":
		return "queued"
	case "downloading":
		return "downloading"
	case "completed":
		return "downloaded"
	case "failed", "warning":
		return "failed_import"
	default:
		return "queued"
	}
}

// stagePriority returns a numeric priority for stage ordering (higher = more behind).
func stagePriority(stage string) int {
	switch stage {
	case "importing":
		return 0
	case "downloaded":
		return 1
	case "downloading":
		return 2
	case "queued":
		return 3
	case "sent":
		return 4
	case "failed_import":
		return 5
	default:
		return 3
	}
}

// ============================================================
// Helpers
// ============================================================

// isDualQuality returns true when the request was actually dispatched to both
// regular and 4K instances. Checks arr_job_ids for the pipe delimiter rather
// than the quality flags, because dispatch may have silently downgraded to
// single-instance when the 4K instance was not configured.
func isDualQuality(req *models.Request) bool {
	return strings.Contains(req.ArrJobIDs, "|")
}

// splitArrJobIDs splits a pipe-delimited arr_job_ids string into parts.
// e.g. "radarr:42|radarr4k:55" → ["radarr:42", "radarr4k:55"]
func splitArrJobIDs(ids string) []string {
	if ids == "" {
		return nil
	}
	return strings.Split(ids, "|")
}

// aggregateQueueProgress combines multiple queue items into a single progress report.
func aggregateQueueProgress(req *models.Request, matched []arr.QueueItem) *downloadProgress {
	var totalSize, totalLeft float64
	worstStage := "importing"
	var firstETA, protocol, releaseName string

	for _, qi := range matched {
		totalSize += qi.Size
		totalLeft += qi.Sizeleft
		stage := mapQueueStage(&qi)
		if stagePriority(stage) > stagePriority(worstStage) {
			worstStage = stage
		}
		if firstETA == "" && qi.Timeleft != "" {
			firstETA = qi.Timeleft
		}
		if protocol == "" {
			protocol = qi.Protocol
		}
		if releaseName == "" {
			releaseName = qi.Title
		}
	}

	var pct float64
	if totalSize > 0 {
		pct = ((totalSize - totalLeft) / totalSize) * 100
	}

	return &downloadProgress{
		RequestID:   req.ID,
		Title:       req.Title,
		MediaType:   req.MediaType,
		Stage:       worstStage,
		Percent:     math.Round(pct*10) / 10,
		SizeTotal:   int64(totalSize),
		SizeLeft:    int64(totalLeft),
		ETA:         firstETA,
		Protocol:    protocol,
		ReleaseName: releaseName,
	}
}

// ============================================================
// arr_job_ids Parsers (backward-compatible with legacy format)
// ============================================================

// parseMovieArrIDs extracts the Radarr movie ID from a single arr_job_ids segment.
// Supports: "radarr:42", "radarr4k:55", and legacy bare integer "42".
func parseMovieArrIDs(arrJobIDs string) (radarrID int, ok bool) {
	if strings.HasPrefix(arrJobIDs, "radarr4k:") {
		id, err := strconv.Atoi(strings.TrimPrefix(arrJobIDs, "radarr4k:"))
		if err != nil || id <= 0 {
			return 0, false
		}
		return id, true
	}
	if strings.HasPrefix(arrJobIDs, "radarr:") {
		id, err := strconv.Atoi(strings.TrimPrefix(arrJobIDs, "radarr:"))
		if err != nil || id <= 0 {
			return 0, false
		}
		return id, true
	}
	id, err := strconv.Atoi(arrJobIDs)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}

// parseTVArrIDs extracts the Sonarr series ID and TVDB ID from a single arr_job_ids segment.
// Supports: "sonarr:<sonarrID>:<tvdbID>", "sonarr4k:<sonarrID>:<tvdbID>",
// and legacy bare integer "<tvdbID>".
func parseTVArrIDs(arrJobIDs string) (sonarrID int, tvdbID int, hasSonarrID bool) {
	// Handle both "sonarr:" and "sonarr4k:" prefixes
	var body string
	if strings.HasPrefix(arrJobIDs, "sonarr4k:") {
		body = strings.TrimPrefix(arrJobIDs, "sonarr4k:")
	} else if strings.HasPrefix(arrJobIDs, "sonarr:") {
		body = strings.TrimPrefix(arrJobIDs, "sonarr:")
	}
	if body != "" {
		parts := strings.SplitN(body, ":", 2)
		if len(parts) == 2 {
			sid, err1 := strconv.Atoi(parts[0])
			tid, err2 := strconv.Atoi(parts[1])
			if err1 == nil && err2 == nil && sid > 0 && tid > 0 {
				return sid, tid, true
			}
		}
		return 0, 0, false
	}
	tid, err := strconv.Atoi(arrJobIDs)
	if err != nil || tid <= 0 {
		return 0, 0, false
	}
	return 0, tid, false
}
