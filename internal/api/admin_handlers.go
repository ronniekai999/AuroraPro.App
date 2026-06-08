package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/arr"
	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/library"
	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/logging"
	"github.com/aurora-media/aurora/internal/matching"
	"github.com/aurora-media/aurora/internal/metadata"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/streaming"
	ws "github.com/aurora-media/aurora/internal/websocket"
	"github.com/go-chi/chi/v5"
)

type AdminHandler struct {
	queries      *db.Queries
	transcode    *streaming.TranscodeManager
	directPlay   *streaming.DirectPlayRegistry
	hub          *ws.Hub
	activity     *ActivityLogger
	ringLog      *logging.RingBufferHandler
	imgProxy     *metadata.ImageProxy
	watcher      *library.Watcher
	arrClients   *arr.ArrClients
	startTime    time.Time
	version      string
	transcodeDir string // for disk free calculation

	// Phase 5 — populated via SetEmbeddingInfo when the LLM subsystem is on.
	embedEnabled bool
	embedVersion int16

	// Phase 6 — optional LLM client handle so the admin UI can toggle the
	// hot-reloadable debug flag without a restart. nil when LLM is disabled.
	llmClient *llm.Client

	// 2026-05-25 — AI re-matcher backfill control. Wired via
	// SetAIBackfill from main.go when the matching subsystem is enabled.
	// Nil here means "AI matching not configured" → admin endpoints
	// return 503. Interface-typed (not *matching.Backfiller) so the api
	// package doesn't depend on internal/matching — the api → matching
	// edge would mirror the existing api → llm one but adds nothing.
	aiBackfill AIBackfillController

	// 2026-05-16 — database URL for the Backup endpoint. Set via
	// SetDatabaseURL after construction (avoids growing the constructor
	// signature for an optional feature). Empty disables the backup
	// endpoint with a clean error.
	databaseURL string

	// 2026-05-16 audit H3 — serializes concurrent Backup/Restore
	// operations. Two restores running in parallel would race their
	// DROP SCHEMA / --single-transaction COMMIT against each other,
	// producing partial corruption. A backup running during a restore
	// would capture a transient mid-restore state. TryLock returns
	// false rather than blocking so the second admin gets a clean
	// 409 Conflict instead of an inexplicable hang.
	backupRestoreMu sync.Mutex
}

// SetDatabaseURL wires the conninfo string used by the pg_dump-based
// backup endpoint. See admin_backup.go for the streaming implementation.
func (h *AdminHandler) SetDatabaseURL(url string) {
	h.databaseURL = url
}

func NewAdminHandler(
	queries *db.Queries,
	transcode *streaming.TranscodeManager,
	directPlay *streaming.DirectPlayRegistry,
	hub *ws.Hub,
	activity *ActivityLogger,
	ringLog *logging.RingBufferHandler,
	imgProxy *metadata.ImageProxy,
	watcher *library.Watcher,
	arrClients *arr.ArrClients,
	startTime time.Time,
	version string,
	transcodeDir ...string,
) *AdminHandler {
	h := &AdminHandler{
		queries:    queries,
		transcode:  transcode,
		directPlay: directPlay,
		hub:        hub,
		activity:   activity,
		ringLog:    ringLog,
		imgProxy:   imgProxy,
		watcher:    watcher,
		arrClients: arrClients,
		startTime:  startTime,
		version:    version,
	}
	if len(transcodeDir) > 0 {
		h.transcodeDir = transcodeDir[0]
	}
	return h
}

// SetEmbeddingInfo wires the embedding subsystem's state into the admin
// dashboard. Called from main.go when LLM is enabled; without it the
// EmbeddingStatus endpoint reports the feature as disabled.
func (h *AdminHandler) SetEmbeddingInfo(enabled bool, currentVersion int16) {
	h.embedEnabled = enabled
	h.embedVersion = currentVersion
}

// SetLLMClient wires the LLM client into the admin handler so the
// Diagnostics toggle can flip Debug() at runtime without a restart.
func (h *AdminHandler) SetLLMClient(c *llm.Client) {
	h.llmClient = c
}

// AIBackfillController is the minimal contract the admin handler needs
// from the AI re-matcher's backfill worker. *matching.Backfiller
// satisfies this directly — the interface exists so future tests can
// stub the backfill controller without spinning a real Ollama and TMDB
// dependency tree.
//
// StartJob: kick off a manual sweep; returns the job id, or
// matching.ErrJobInProgress if one's already running.
//
// JobStatus: snapshot of the most recent job (active or last
// finished). Returns nil if no job has ever run.
type AIBackfillController interface {
	StartJob(ctx context.Context) (string, error)
	JobStatus() *matching.JobStatus
}

// SetAIBackfill wires the AI re-matcher backfill controller. Called from
// main.go when the matching subsystem is enabled; without it the
// AIRematch* handlers return 503.
func (h *AdminHandler) SetAIBackfill(c AIBackfillController) {
	h.aiBackfill = c
}

// LLMSettings is the admin-UI representation of the LLM block.
// LiveDebugLog reports the *current in-memory* debug state of the client,
// which can drift from DebugLog (the persisted DB setting) between a write
// and the next reload. The UI renders both: persisted (saved) vs live (now).
type LLMSettings struct {
	Provider     string `json:"provider"`       // "ollama_cloud" | "local" | "" (env-controlled)
	OllamaURL    string `json:"ollama_url"`     // for chat endpoint
	EmbedURL     string `json:"embed_url"`      // optional override for local embeddings
	APIKeyMasked string `json:"api_key_masked"` // never the raw key
	HasAPIKey    bool   `json:"has_api_key"`
	ChatModel    string `json:"chat_model"`
	EmbedModel   string `json:"embed_model"`
	// Phase A per-surface routing. Empty fast/smart ⇒ fall back to ChatModel.
	// Restart-required (the client captures Config at NewClient), like ChatModel.
	ChatModelFast     string `json:"chat_model_fast"`
	ChatModelSmart    string `json:"chat_model_smart"`
	StructuredOutputs bool   `json:"structured_outputs"`
	ReasoningEffort   string `json:"reasoning_effort"` // gpt-oss /v1 reasoning level: low|medium|high|none|""
	// Phase B listwise reranker (a fast chat model). RerankModel empty ⇒ reranking
	// disabled (graceful no-op). RerankURL empty ⇒ the chat endpoint; set only to
	// run rerank on a separate/local Ollama. Restart-required, like the other
	// model fields.
	RerankModel  string `json:"rerank_model"`
	RerankURL    string `json:"rerank_url"`
	DebugLog     bool   `json:"debug_log"`      // persisted setting in DB
	LiveDebugLog bool   `json:"live_debug_log"` // in-memory state of the *active* client
	ClientLoaded bool   `json:"client_loaded"`  // false when LLM is disabled at startup
}

// llmSettingKeys is the canonical list of server_settings rows we read/write.
// Centralized so GetLLMSettings + UpdateLLMSettings can't drift.
var llmSettingKeys = struct {
	Provider, OllamaURL, EmbedURL, APIKey, ChatModel, EmbedModel, DebugLog string
	ChatModelFast, ChatModelSmart, StructuredOutputs, ReasoningEffort      string
	RerankModel, RerankURL                                                 string
}{
	Provider:          "llm_provider",
	OllamaURL:         "llm_ollama_url",
	EmbedURL:          "llm_embed_url",
	APIKey:            "llm_api_key",
	ChatModel:         "llm_chat_model",
	EmbedModel:        "llm_embed_model",
	DebugLog:          "llm_debug_log",
	ChatModelFast:     "llm_chat_model_fast",
	ChatModelSmart:    "llm_chat_model_smart",
	StructuredOutputs: "llm_structured_outputs",
	ReasoningEffort:   "llm_reasoning_effort",
	RerankModel:       "llm_reranker_model",
	RerankURL:         "llm_reranker_url",
}

// validReasoningEffort reports whether v is an accepted gpt-oss /v1
// reasoning_effort value ("" = unset/omit). Guards against a typo'd setting
// (e.g. "minimal", which Ollama rejects) silently 400ing every hero rerank —
// which would degrade the hero to vector order on every call with no retry.
func validReasoningEffort(v string) bool {
	switch v {
	case "", "low", "medium", "high", "none":
		return true
	}
	return false
}

// GetLLMSettings returns the current persisted LLM configuration plus the
// live in-memory debug state. The API key is never returned in raw form.
//
// One DB round-trip (via GetAllSettings) — filter in-memory. Cheaper than
// 7 sequential GetSetting calls and the dashboard polls this on every tab
// switch.
func (h *AdminHandler) GetLLMSettings(w http.ResponseWriter, r *http.Request) {
	out := LLMSettings{ClientLoaded: h.llmClient != nil}

	all, err := h.queries.GetAllSettings(r.Context())
	if err != nil {
		slog.Warn("GetLLMSettings: read failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read settings")
		return
	}
	byKey := make(map[string]string, len(all))
	for _, s := range all {
		byKey[s.Key] = s.Value
	}
	out.Provider = byKey[llmSettingKeys.Provider]
	out.OllamaURL = byKey[llmSettingKeys.OllamaURL]
	out.EmbedURL = byKey[llmSettingKeys.EmbedURL]
	out.ChatModel = byKey[llmSettingKeys.ChatModel]
	out.EmbedModel = byKey[llmSettingKeys.EmbedModel]
	out.ChatModelFast = byKey[llmSettingKeys.ChatModelFast]
	out.ChatModelSmart = byKey[llmSettingKeys.ChatModelSmart]
	out.ReasoningEffort = byKey[llmSettingKeys.ReasoningEffort]
	out.RerankModel = byKey[llmSettingKeys.RerankModel]
	out.RerankURL = byKey[llmSettingKeys.RerankURL]
	if v := byKey[llmSettingKeys.StructuredOutputs]; v != "" {
		out.StructuredOutputs = v == "true"
	}
	if v := byKey[llmSettingKeys.DebugLog]; v != "" {
		out.DebugLog = v == "true"
	}
	if key := byKey[llmSettingKeys.APIKey]; key != "" {
		out.HasAPIKey = true
		out.APIKeyMasked = maskAPIKey(key)
	}
	if h.llmClient != nil {
		out.LiveDebugLog = h.llmClient.Debug()
		if out.ChatModel == "" {
			out.ChatModel = h.llmClient.ChatModel()
		}
		if out.EmbedModel == "" {
			out.EmbedModel = h.llmClient.EmbedModel()
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// llmUpdateRequest is the PUT body shape. Pointers so we can distinguish
// "field present, set to empty" (explicit clear) from "field omitted, leave
// alone". The frontend sends a sparse object with only changed fields, which
// is what lets DebugLog flips return restart_required:false.
type llmUpdateRequest struct {
	Provider          *string `json:"provider,omitempty"`
	OllamaURL         *string `json:"ollama_url,omitempty"`
	EmbedURL          *string `json:"embed_url,omitempty"`
	APIKey            *string `json:"api_key,omitempty"` // empty string clears; absence leaves alone
	ChatModel         *string `json:"chat_model,omitempty"`
	EmbedModel        *string `json:"embed_model,omitempty"`
	ChatModelFast     *string `json:"chat_model_fast,omitempty"`
	ChatModelSmart    *string `json:"chat_model_smart,omitempty"`
	ReasoningEffort   *string `json:"reasoning_effort,omitempty"`
	RerankModel       *string `json:"rerank_model,omitempty"`
	RerankURL         *string `json:"rerank_url,omitempty"`
	StructuredOutputs *bool   `json:"structured_outputs,omitempty"`
	DebugLog          *bool   `json:"debug_log,omitempty"`
}

// UpdateLLMSettings persists the supplied fields to server_settings and
// hot-applies anything that doesn't require a process restart (currently
// only debug_log). The response indicates whether a restart is needed so
// the UI can prompt the operator.
func (h *AdminHandler) UpdateLLMSettings(w http.ResponseWriter, r *http.Request) {
	var req llmUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.ReasoningEffort != nil && !validReasoningEffort(*req.ReasoningEffort) {
		writeError(w, http.StatusBadRequest, "reasoning_effort must be empty or one of: low, medium, high, none")
		return
	}

	// 2026-05-19 audit (BE-H6) — validate LLM URLs to prevent SSRF. An
	// admin (or a token leaked from admin) can otherwise point these at
	// cloud metadata services (169.254.169.254) and exfiltrate IAM
	// credentials, or scan internal-network endpoints. The default
	// Ollama URL is http://localhost:11434 so loopback must remain
	// allowed; we just block link-local (cloud metadata) and require
	// a valid http(s) scheme.
	if req.OllamaURL != nil && *req.OllamaURL != "" {
		if err := validateLLMURL(*req.OllamaURL); err != nil {
			writeError(w, http.StatusBadRequest, "ollama_url: "+err.Error())
			return
		}
	}
	if req.EmbedURL != nil && *req.EmbedURL != "" {
		if err := validateLLMURL(*req.EmbedURL); err != nil {
			writeError(w, http.StatusBadRequest, "embed_url: "+err.Error())
			return
		}
	}
	if req.RerankURL != nil && *req.RerankURL != "" {
		if err := validateLLMURL(*req.RerankURL); err != nil {
			writeError(w, http.StatusBadRequest, "rerank_url: "+err.Error())
			return
		}
	}

	// restart_required tracks whether ANY field was changed that the running
	// process can't pick up live. Debug toggle is the only hot-applicable
	// field today; everything else requires a restart to take effect on the
	// existing llm.Client (which captured config at NewClient time).
	//
	// We diff against the current DB value before writing so a "save" of
	// unchanged form fields doesn't falsely demand a restart, and so failed
	// writes surface to the operator as a 500 (not a silent 200 OK).
	restartRequired := false
	apply := func(key string, val *string) error {
		if val == nil {
			return nil
		}
		current, _, _ := h.queries.GetSettingExists(r.Context(), key)
		if current == *val {
			return nil // no-op write; don't bump restart_required
		}
		if err := h.queries.SetSetting(r.Context(), key, *val); err != nil {
			return fmt.Errorf("save %s: %w", key, err)
		}
		restartRequired = true
		return nil
	}
	for _, p := range []struct {
		key string
		val *string
	}{
		{llmSettingKeys.Provider, req.Provider},
		{llmSettingKeys.OllamaURL, req.OllamaURL},
		{llmSettingKeys.EmbedURL, req.EmbedURL},
		{llmSettingKeys.APIKey, req.APIKey},
		{llmSettingKeys.ChatModel, req.ChatModel},
		{llmSettingKeys.EmbedModel, req.EmbedModel},
		{llmSettingKeys.ChatModelFast, req.ChatModelFast},
		{llmSettingKeys.ChatModelSmart, req.ChatModelSmart},
		{llmSettingKeys.ReasoningEffort, req.ReasoningEffort},
		{llmSettingKeys.RerankModel, req.RerankModel},
		{llmSettingKeys.RerankURL, req.RerankURL},
	} {
		if err := apply(p.key, p.val); err != nil {
			slog.Warn("UpdateLLMSettings: write failed", "key", p.key, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to save LLM settings")
			return
		}
	}

	// StructuredOutputs is a bool (like DebugLog) but restart-required (the
	// client captures it at NewClient), so it bumps restart_required rather
	// than hot-applying.
	if req.StructuredOutputs != nil {
		val := "false"
		if *req.StructuredOutputs {
			val = "true"
		}
		if current, _, _ := h.queries.GetSettingExists(r.Context(), llmSettingKeys.StructuredOutputs); current != val {
			if err := h.queries.SetSetting(r.Context(), llmSettingKeys.StructuredOutputs, val); err != nil {
				slog.Warn("UpdateLLMSettings: structured_outputs write failed", "error", err)
				writeError(w, http.StatusInternalServerError, "failed to save structured outputs toggle")
				return
			}
			restartRequired = true
		}
	}

	if req.DebugLog != nil {
		val := "false"
		if *req.DebugLog {
			val = "true"
		}
		if err := h.queries.SetSetting(r.Context(), llmSettingKeys.DebugLog, val); err != nil {
			slog.Warn("UpdateLLMSettings: debug_log write failed", "error", err)
			writeError(w, http.StatusInternalServerError, "failed to save debug toggle")
			return
		}
		// Hot-apply to the running client. No restart needed for this one.
		if h.llmClient != nil {
			h.llmClient.SetDebug(*req.DebugLog)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"restart_required": restartRequired,
	})
}

// maskAPIKey returns a UI-safe preview of an API key — first 4 + last 4
// characters, the middle redacted. Never call this on something you might
// then accept back as "the key" (the masked form should never round-trip
// into the DB; that's why llmUpdateRequest treats the missing-field case
// as "leave alone").
func maskAPIKey(s string) string {
	if len(s) <= 8 {
		return strings.Repeat("*", len(s))
	}
	return s[:4] + strings.Repeat("*", len(s)-8) + s[len(s)-4:]
}

// secretSettingSuffixes enumerates the server_settings key suffixes whose
// values are credentials and must never be returned to a client in cleartext
// — even to an admin. GetSettings masks any key matching one of these. It is a
// suffix denylist rather than an allowlist of the few non-secret keys because
// secret keys are added far more often than this rule is revisited; defaulting
// to "mask" is the safe failure mode (a forgotten non-secret key shows masked,
// which is harmless, vs. a forgotten secret key leaking raw).
//
// INVARIANT (audit H7 follow-up): no server_settings key that must be DISPLAYED
// in cleartext may end in one of these suffixes — the broad "_secret"/"_token"
// in particular. Today none do (all are credentials). If a non-secret key ever
// needs such a suffix, rename the key rather than weakening this list.
var secretSettingSuffixes = []string{
	"_api_key", "_client_secret", "_secret", "_password", "_token", "_credential",
}

// isSecretSettingKey reports whether a server_settings key holds a credential
// that must be masked before serialization. See audit H7.
func isSecretSettingKey(key string) bool {
	for _, suffix := range secretSettingSuffixes {
		if strings.HasSuffix(key, suffix) {
			return true
		}
	}
	return false
}

// EmbeddingStatus reports backfill progress for the admin dashboard:
// {enabled, version, total, embedded, pending}. Cheap (one COUNT...FILTER
// query) — safe to poll every few seconds during initial backfill.
func (h *AdminHandler) EmbeddingStatus(w http.ResponseWriter, r *http.Request) {
	if !h.embedEnabled {
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled":  false,
			"version":  0,
			"total":    0,
			"embedded": 0,
			"pending":  0,
		})
		return
	}
	status, err := h.queries.GetEmbeddingStatus(r.Context(), h.embedVersion)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get embedding status")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":  true,
		"version":  h.embedVersion,
		"total":    status.Total,
		"embedded": status.Embedded,
		"pending":  status.Pending,
	})
}

// Dashboard returns server statistics for the admin panel.
func (h *AdminHandler) Dashboard(w http.ResponseWriter, r *http.Request) {
	movieCount, showCount, episodeCount, err := h.queries.GetMediaCounts(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get media counts")
		return
	}

	totalSize, err := h.queries.GetTotalFileSize(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get file size stats")
		return
	}
	libCount, err := h.queries.GetLibraryCount(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get library count")
		return
	}
	userCount, err := h.queries.CountUsers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get user count")
		return
	}

	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)

	// Disk free on the transcode directory
	var diskFreeGB float64
	if h.transcodeDir != "" {
		diskFreeGB = GetDiskFreeGB(h.transcodeDir)
	}

	// Fetch pending request count and active party count (non-fatal if they fail)
	pendingRequests, _ := h.queries.GetRequestCountByStatus(r.Context(), "pending")
	processingRequests, _ := h.queries.GetRequestCountByStatus(r.Context(), "processing")
	activeParties, _ := h.queries.GetActivePartyCount(r.Context())

	stats := models.ServerStats{
		Version:            h.version,
		Uptime:             time.Since(h.startTime).Round(time.Second).String(),
		MemoryAllocMB:      int64(memStats.Alloc / 1024 / 1024),
		Goroutines:         runtime.NumGoroutine(),
		CPUCores:           float64(runtime.NumCPU()),
		DiskFreeGB:         diskFreeGB,
		ActiveStreams:      h.transcode.ActiveSessions() + directPlayCount(h.directPlay),
		WebSocketClients:   h.hub.ClientCount(),
		LibraryCount:       libCount,
		MovieCount:         movieCount,
		ShowCount:          showCount,
		EpisodeCount:       episodeCount,
		UserCount:          int64(userCount),
		TotalFileSizeBytes: totalSize,
		PendingRequests:    pendingRequests + processingRequests,
		ActiveParties:      activeParties,
	}

	writeJSON(w, http.StatusOK, stats)
}

// Activity returns paginated activity log entries.
// Accepts ?page= and ?per_page= query params (default page=1, per_page=50, max per_page=100).
// For backward compatibility, ?limit= is treated as per_page with page=1.
func (h *AdminHandler) Activity(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	eventType := q.Get("type")

	var params models.PaginationParams

	// Backward compat: if legacy ?limit= is provided, treat it as per_page with page=1
	if limitStr := q.Get("limit"); limitStr != "" {
		limit, _ := strconv.Atoi(limitStr)
		if limit <= 0 || limit > 100 {
			limit = 50
		}
		params = models.PaginationParams{Page: 1, PerPage: limit}
	} else {
		page, _ := strconv.Atoi(q.Get("page"))
		perPage, _ := strconv.Atoi(q.Get("per_page"))
		if page < 1 {
			page = 1
		}
		if perPage < 1 || perPage > 100 {
			perPage = 50
		}
		params = models.PaginationParams{Page: page, PerPage: perPage}
	}

	entries, total, err := h.queries.GetActivityPaginated(r.Context(), params, eventType)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get activity")
		return
	}
	if entries == nil {
		entries = []*models.ActivityEntry{}
	}

	totalPages := int(total) / params.PerPage
	if int(total)%params.PerPage != 0 {
		totalPages++
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"items":       entries,
		"total":       total,
		"page":        params.Page,
		"per_page":    params.PerPage,
		"total_pages": totalPages,
	})
}

// Sessions returns active streams — transcode + direct-play —
// as a flat array tagged with a `kind` discriminator so the admin
// UI can render them in a single table. Direct-play sessions only
// have a subset of the transcode fields populated.
func (h *AdminHandler) Sessions(w http.ResponseWriter, r *http.Request) {
	type unifiedSession struct {
		// Common fields
		ID        string    `json:"id"`
		Kind      string    `json:"kind"` // "transcode" or "direct"
		UserID    int64     `json:"user_id"`
		Username  string    `json:"username,omitempty"`
		FileName  string    `json:"file_name"`
		StartedAt time.Time `json:"started_at"`
		// Transcode-only
		Resolution string                      `json:"resolution,omitempty"`
		Profiles   []streaming.QualityProfile  `json:"profiles,omitempty"`
		Variants   []string                    `json:"active_variants,omitempty"`
		Resources  *streaming.SessionResources `json:"resources,omitempty"`
		Remux      bool                        `json:"remux,omitempty"`
		// Direct-play only
		FileType string `json:"file_type,omitempty"`
		FileID   int64  `json:"file_id,omitempty"`
		Decision string `json:"decision,omitempty"`
	}

	tc := h.transcode.ListSessions()
	dpList := []streaming.DirectPlaySession(nil)
	if h.directPlay != nil {
		dpList = h.directPlay.List()
	}
	out := make([]unifiedSession, 0, len(tc)+len(dpList))
	for _, s := range tc {
		// QA fix — only emit Resolution when we actually know the
		// source dimensions. omitempty alone wouldn't help because
		// "0x0" is a non-empty string and the frontend would render
		// it verbatim.
		var resolution string
		if s.SourceWidth > 0 && s.SourceHeight > 0 {
			resolution = fmt.Sprintf("%dx%d", s.SourceWidth, s.SourceHeight)
		}
		out = append(out, unifiedSession{
			ID:         s.ID,
			Kind:       "transcode",
			UserID:     s.UserID,
			Username:   s.Username,
			FileName:   s.FileName,
			StartedAt:  s.StartedAt,
			Resolution: resolution,
			Profiles:   s.Profiles,
			Variants:   s.ActiveVariants,
			Resources:  s.Resources,
			Remux:      s.Remux,
		})
	}
	for _, dp := range dpList {
		out = append(out, unifiedSession{
			ID:        dp.ID,
			Kind:      "direct",
			UserID:    dp.UserID,
			Username:  dp.Username,
			FileName:  dp.FileName,
			StartedAt: dp.StartedAt,
			FileType:  dp.FileType,
			FileID:    dp.FileID,
			Decision:  dp.Decision,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// DiagnoseSession returns a per-variant snapshot of FFmpeg state for
// the given transcode session, including stderr tails. Admin-gated
// because stderr can contain absolute file paths + shell args from
// the FFmpeg command line.
//
// Used by the Active Streams tab's "Diagnose" button when a transcode
// session is showing as failed — saves the operator from grepping
// syslog for `ffmpeg variant exited` lines.
func (h *AdminHandler) DiagnoseSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	if sessionID == "" {
		writeError(w, http.StatusBadRequest, "missing sessionID")
		return
	}
	diag, ok := h.transcode.DiagnoseSession(sessionID)
	if !ok {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	writeJSON(w, http.StatusOK, diag)
}

// directPlayCount safely returns the active direct-play count.
// Pulled out for the dashboard-stats call site that needs a single
// integer without rebuilding the full snapshot.
func directPlayCount(r *streaming.DirectPlayRegistry) int {
	if r == nil {
		return 0
	}
	return r.ActiveCount()
}

// GetSettings returns all server settings.
func (h *AdminHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := h.queries.GetAllSettings(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get settings")
		return
	}
	if settings == nil {
		settings = []*models.ServerSetting{}
	}
	// Mask every secret-bearing setting in the response. This previously
	// matched only the `_api_key` suffix, which silently leaked the OAuth
	// client secrets (stored as `oauth_*_client_secret`) in cleartext to any
	// caller of GET /api/admin/settings — see audit H7. isSecretSettingKey
	// covers all credential suffixes so a newly-added secret key is masked by
	// default rather than leaking until someone remembers to extend a list.
	for _, s := range settings {
		if isSecretSettingKey(s.Key) && s.Value != "" {
			// Unify on the same masking helper used for LLM keys so a partial
			// (<= 4 char) test key never leaks raw to the admin UI.
			s.Value = maskAPIKey(s.Value)
		}
	}
	writeJSON(w, http.StatusOK, settings)
}

// UpdateSettings updates server settings (admin only).
func (h *AdminHandler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	var req models.UpdateSettingsRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	type settingRule struct {
		validate func(string) bool
	}
	allowedKeys := map[string]settingRule{
		"completion_threshold": {func(v string) bool {
			f, err := strconv.ParseFloat(v, 64)
			return err == nil && f >= 0 && f <= 1
		}},
		"max_profiles_per_user": {func(v string) bool {
			n, err := strconv.Atoi(v)
			return err == nil && n >= 1 && n <= 100
		}},
		"now_playing_enabled": {func(v string) bool {
			return v == "true" || v == "false"
		}},
		"scan_interval_default": {func(v string) bool {
			n, err := strconv.Atoi(v)
			return err == nil && n >= 0 && n <= 86400
		}},
		"transcode_max_sessions": {func(v string) bool {
			n, err := strconv.Atoi(v)
			return err == nil && n >= 0 && n <= 1000
		}},
		"filesystem_watch_enabled": {func(v string) bool {
			return v == "true" || v == "false"
		}},
		"requests_enabled": {func(v string) bool {
			return v == "true" || v == "false"
		}},
		// Per-user media-request quota tuning (carve-out C). A request over
		// either cap is held for admin approval rather than dispatched.
		"requests_quota_active": {func(v string) bool {
			n, err := strconv.Atoi(v)
			return err == nil && n >= 1 && n <= 10000
		}},
		"requests_quota_daily": {func(v string) bool {
			n, err := strconv.Atoi(v)
			return err == nil && n >= 1 && n <= 10000
		}},
		// Audit M1 fix (Phase 8) — `ui_version` removed from allowed
		// keys after V1 retirement. The router no longer reads it
		// (readUIVersion + shouldServeV1 are gone), so accepting
		// writes would let admins set a value nothing consumes.
		// Existing rows in server_settings are harmless dead data
		// — no migration to delete, but no NEW writes allowed.
		"radarr_url":        {func(v string) bool { return v == "" || isValidARRURL(v) }},
		"radarr_api_key":    {func(v string) bool { return !isMaskedAPIKey(v) }},
		"radarr_4k_url":     {func(v string) bool { return v == "" || isValidARRURL(v) }},
		"radarr_4k_api_key": {func(v string) bool { return !isMaskedAPIKey(v) }},
		"sonarr_url":        {func(v string) bool { return v == "" || isValidARRURL(v) }},
		"sonarr_api_key":    {func(v string) bool { return !isMaskedAPIKey(v) }},
		"sonarr_4k_url":     {func(v string) bool { return v == "" || isValidARRURL(v) }},
		"sonarr_4k_api_key": {func(v string) bool { return !isMaskedAPIKey(v) }},
	}

	claims := getClaimsFromRequest(r)
	var changedKeys []string
	for key, value := range req.Settings {
		rule, ok := allowedKeys[key]
		if !ok {
			writeError(w, http.StatusBadRequest, "unknown setting: "+key)
			return
		}
		if !rule.validate(value) {
			writeError(w, http.StatusBadRequest, "invalid value for setting: "+key)
			return
		}
		if err := h.queries.UpsertSetting(r.Context(), key, value, claims.UserID); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update setting")
			return
		}
		changedKeys = append(changedKeys, key)
	}

	// Apply runtime-reloadable settings immediately.
	// Track which ARR services need a client reload so we reload each at most once,
	// even if both URL and API key for the same service are changed in one request.
	arrReload := make(map[string]bool)
	for key, value := range req.Settings {
		switch key {
		case "transcode_max_sessions":
			if n, err := strconv.Atoi(value); err == nil && h.transcode != nil {
				h.transcode.SetMaxSessions(n)
			}
		case "scan_interval_default":
			if n, err := strconv.Atoi(value); err == nil && h.watcher != nil {
				h.watcher.SetScanInterval(time.Duration(n) * time.Second)
			}
		case "filesystem_watch_enabled":
			if h.watcher != nil {
				h.watcher.SetFSWatchEnabled(value == "true")
			}
		case "requests_enabled":
			if h.arrClients != nil {
				h.arrClients.SetEnabled(value == "true")
			}
		case "radarr_url", "radarr_api_key":
			arrReload["radarr"] = true
		case "radarr_4k_url", "radarr_4k_api_key":
			arrReload["radarr_4k"] = true
		case "sonarr_url", "sonarr_api_key":
			arrReload["sonarr"] = true
		case "sonarr_4k_url", "sonarr_4k_api_key":
			arrReload["sonarr_4k"] = true
		}
	}
	// Reload ARR clients once per service after all settings are persisted.
	if h.arrClients != nil {
		for svc := range arrReload {
			switch svc {
			case "radarr":
				h.reloadARRClient(r.Context(), "radarr_url", "radarr_api_key", h.arrClients.UpdateRadarr)
			case "radarr_4k":
				h.reloadARRClient(r.Context(), "radarr_4k_url", "radarr_4k_api_key", h.arrClients.UpdateRadarr4K)
			case "sonarr":
				h.reloadARRClient(r.Context(), "sonarr_url", "sonarr_api_key", h.arrClients.UpdateSonarr)
			case "sonarr_4k":
				h.reloadARRClient(r.Context(), "sonarr_4k_url", "sonarr_4k_api_key", h.arrClients.UpdateSonarr4K)
			}
		}
	}

	if h.activity != nil && len(changedKeys) > 0 {
		h.activity.LogSettingsChanged(r.Context(), claims.UserID, changedKeys)
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "settings updated"})
}

// Logs returns recent server log entries from the in-memory ring buffer.
func (h *AdminHandler) Logs(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	if offset < 0 {
		offset = 0 // negative offset would underflow ring-buffer indexing
	}

	entries := h.ringLog.Entries(limit, offset)
	writeJSON(w, http.StatusOK, entries)
}

// FlaggedItems returns media items with match_status = 'needs_review'.
// Response items include the AI matcher's suggestion fields (populated
// when the matching subsystem has evaluated the item) so the admin UI
// can render a one-click "Accept suggestion" affordance that hits the
// existing ManualMatch endpoint with the suggested TMDB id.
func (h *AdminHandler) FlaggedItems(w http.ResponseWriter, r *http.Request) {
	items, err := h.queries.GetItemsNeedingReview(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get flagged items")
		return
	}
	if items == nil {
		items = []*models.MediaItem{}
	}
	writeJSON(w, http.StatusOK, items)
}

// AIRematchStart kicks off a manual AI re-match sweep over the flagged
// queue. Returns 202 Accepted with the job id immediately; the actual
// work runs in a background goroutine. The endpoint is idempotent in the
// "single active job" sense: a second call while one is running returns
// 409 Conflict rather than spawning a duplicate, so the operator's
// double-clicks don't fan out into N parallel sweeps stomping each other
// on Ollama.
//
// 503 when AI matching is not configured (LLM_ENABLED=false or matcher
// construction failed at boot). Distinct from 500 so the operator
// can immediately see the cause from the status code.
func (h *AdminHandler) AIRematchStart(w http.ResponseWriter, r *http.Request) {
	if h.aiBackfill == nil {
		writeError(w, http.StatusServiceUnavailable, "AI matching is not enabled")
		return
	}
	jobID, err := h.aiBackfill.StartJob(r.Context())
	if errors.Is(err, matching.ErrJobInProgress) {
		writeError(w, http.StatusConflict, "an AI re-match job is already in progress")
		return
	}
	if err != nil {
		slog.Warn("ai rematch: start failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to start AI rematch")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"job_id": jobID})
}

// AIRematchStatus reports the most recent (active or last finished)
// backfill job's progress. Returns {enabled:false} when AI matching is
// not configured, and an empty object {enabled:true} when no job has
// run yet — admin UI can render "Never run" without a 404.
func (h *AdminHandler) AIRematchStatus(w http.ResponseWriter, r *http.Request) {
	if h.aiBackfill == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	status := h.aiBackfill.JobStatus()
	if status == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": true})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": true,
		"job":     status,
	})
}

// PurgeImageCache clears the TMDB image cache.
func (h *AdminHandler) PurgeImageCache(w http.ResponseWriter, r *http.Request) {
	if h.imgProxy == nil {
		writeError(w, http.StatusInternalServerError, "image proxy not configured")
		return
	}

	size, count, _ := h.imgProxy.CacheSize()
	if err := h.imgProxy.PurgeCache(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to purge image cache")
		return
	}

	// Destructive admin action — audit-log it. Lets forensics reconstruct
	// who wiped the cache and when (e.g. on a compromised admin account).
	if h.activity != nil {
		if claims := auth.GetClaims(r.Context()); claims != nil {
			h.activity.LogImageCachePurged(r.Context(), claims.UserID, clientIP(r), int64(count))
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"message":      "image cache purged",
		"files_purged": count,
		"bytes_freed":  size,
	})
}

// TestARRConnection tests connectivity to a Radarr or Sonarr service.
// POST /api/admin/arr/test
func (h *AdminHandler) TestARRConnection(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Service string `json:"service"`
		URL     string `json:"url"`
		APIKey  string `json:"api_key"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.URL == "" || req.APIKey == "" {
		writeError(w, http.StatusBadRequest, "url and api_key are required")
		return
	}

	if !isValidARRURL(req.URL) {
		writeError(w, http.StatusBadRequest, "url must be a valid http or https URL")
		return
	}

	var testErr error
	ctx := r.Context()
	switch req.Service {
	case "radarr", "radarr_4k":
		client := arr.NewRadarrClient(req.URL, req.APIKey)
		testErr = client.TestConnection(ctx)
	case "sonarr", "sonarr_4k":
		client := arr.NewSonarrClient(req.URL, req.APIKey)
		testErr = client.TestConnection(ctx)
	default:
		writeError(w, http.StatusBadRequest, "service must be radarr, radarr_4k, sonarr, or sonarr_4k")
		return
	}

	if testErr != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"connected": false, "error": testErr.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"connected": true})
}

// reloadARRClient reads both URL and API key from DB, then swaps the client.
func (h *AdminHandler) reloadARRClient(ctx context.Context, urlKey, apiKeyKey string, update func(string, string)) {
	urlVal, urlErr := h.queries.GetSetting(ctx, urlKey)
	if urlErr != nil {
		slog.Warn("failed to read ARR setting from DB", "key", urlKey, "error", urlErr)
	}
	apiKeyVal, keyErr := h.queries.GetSetting(ctx, apiKeyKey)
	if keyErr != nil {
		slog.Warn("failed to read ARR setting from DB", "key", apiKeyKey, "error", keyErr)
	}
	update(urlVal, apiKeyVal)
	slog.Info("reloaded ARR client", "url_key", urlKey, "configured", urlVal != "" && apiKeyVal != "")
}

// isMaskedAPIKey detects values that look like masked API keys (e.g. "****ab12")
// returned by GetSettings. Prevents the frontend from accidentally writing masked
// values back to the DB, which would permanently corrupt the saved key.
func isMaskedAPIKey(v string) bool {
	return len(v) > 0 && strings.HasPrefix(v, "*")
}

// isValidARRURL checks if a string is a valid HTTP(S) URL.
func isValidARRURL(v string) bool {
	u, err := url.Parse(v)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// ============================================================
// OAuth Settings (Phase 3 / migration 020)
// ============================================================

// OAuthSettings is the admin response for OAuth provider configuration.
// Mirrors LLMSettings's pattern: secret is masked, never returned in raw.
//
// Phase B (Discord + Twitch) added the parallel field sets for each
// new provider. The flat structure preserves backward compatibility
// with the existing client at the cost of repetition. Future
// providers (Facebook, X) follow the same field pattern.
type OAuthSettings struct {
	// Google (Phase 3)
	GoogleEnabled          bool   `json:"google_enabled"`
	GoogleClientID         string `json:"google_client_id"`
	GoogleClientSecretMask string `json:"google_client_secret_masked"`
	GoogleHasSecret        bool   `json:"google_has_secret"`
	GoogleRedirectURL      string `json:"google_redirect_url"`
	// GoogleBypassInvite controls whether OAuth signups can create a new
	// account without an invite code. Default false (gated) matches the
	// password-signup security model. When true, Google sign-in becomes
	// a true frictionless flow — useful for instances that want to
	// embrace the "tap shared link → sign in with Google → join party"
	// social loop without operator-managed invites. Has no effect on
	// existing-user logins (oauth-link fast-path or email-match
	// auto-link), which are always permitted.
	GoogleBypassInvite bool `json:"google_bypass_invite"`

	// Discord (Phase B)
	DiscordEnabled          bool   `json:"discord_enabled"`
	DiscordClientID         string `json:"discord_client_id"`
	DiscordClientSecretMask string `json:"discord_client_secret_masked"`
	DiscordHasSecret        bool   `json:"discord_has_secret"`
	DiscordRedirectURL      string `json:"discord_redirect_url"`
	DiscordBypassInvite     bool   `json:"discord_bypass_invite"`

	// Twitch (Phase B)
	TwitchEnabled          bool   `json:"twitch_enabled"`
	TwitchClientID         string `json:"twitch_client_id"`
	TwitchClientSecretMask string `json:"twitch_client_secret_masked"`
	TwitchHasSecret        bool   `json:"twitch_has_secret"`
	TwitchRedirectURL      string `json:"twitch_redirect_url"`
	TwitchBypassInvite     bool   `json:"twitch_bypass_invite"`

	// Facebook (Phase C)
	FacebookEnabled          bool   `json:"facebook_enabled"`
	FacebookClientID         string `json:"facebook_client_id"`
	FacebookClientSecretMask string `json:"facebook_client_secret_masked"`
	FacebookHasSecret        bool   `json:"facebook_has_secret"`
	FacebookRedirectURL      string `json:"facebook_redirect_url"`
	FacebookBypassInvite     bool   `json:"facebook_bypass_invite"`

	// X / Twitter (Phase D)
	TwitterEnabled          bool   `json:"twitter_enabled"`
	TwitterClientID         string `json:"twitter_client_id"`
	TwitterClientSecretMask string `json:"twitter_client_secret_masked"`
	TwitterHasSecret        bool   `json:"twitter_has_secret"`
	TwitterRedirectURL      string `json:"twitter_redirect_url"`
	TwitterBypassInvite     bool   `json:"twitter_bypass_invite"`
}

// oauthSettingKeys mirrors llmSettingKeys — centralized so the read +
// write paths can't drift on key names. Per-provider sub-structs keep
// the field names readable at use sites.
var oauthSettingKeys = struct {
	GoogleEnabled, GoogleClientID, GoogleClientSecret, GoogleRedirectURL, GoogleBypassInvite           string
	DiscordEnabled, DiscordClientID, DiscordClientSecret, DiscordRedirectURL, DiscordBypassInvite      string
	TwitchEnabled, TwitchClientID, TwitchClientSecret, TwitchRedirectURL, TwitchBypassInvite           string
	FacebookEnabled, FacebookClientID, FacebookClientSecret, FacebookRedirectURL, FacebookBypassInvite string
	TwitterEnabled, TwitterClientID, TwitterClientSecret, TwitterRedirectURL, TwitterBypassInvite      string
}{
	GoogleEnabled:      "oauth_google_enabled",
	GoogleClientID:     "oauth_google_client_id",
	GoogleClientSecret: "oauth_google_client_secret",
	GoogleRedirectURL:  "oauth_google_redirect_url",
	GoogleBypassInvite: "oauth_google_bypass_invite",

	DiscordEnabled:      "oauth_discord_enabled",
	DiscordClientID:     "oauth_discord_client_id",
	DiscordClientSecret: "oauth_discord_client_secret",
	DiscordRedirectURL:  "oauth_discord_redirect_url",
	DiscordBypassInvite: "oauth_discord_bypass_invite",

	TwitchEnabled:      "oauth_twitch_enabled",
	TwitchClientID:     "oauth_twitch_client_id",
	TwitchClientSecret: "oauth_twitch_client_secret",
	TwitchRedirectURL:  "oauth_twitch_redirect_url",
	TwitchBypassInvite: "oauth_twitch_bypass_invite",

	FacebookEnabled:      "oauth_facebook_enabled",
	FacebookClientID:     "oauth_facebook_client_id",
	FacebookClientSecret: "oauth_facebook_client_secret",
	FacebookRedirectURL:  "oauth_facebook_redirect_url",
	FacebookBypassInvite: "oauth_facebook_bypass_invite",

	TwitterEnabled:      "oauth_twitter_enabled",
	TwitterClientID:     "oauth_twitter_client_id",
	TwitterClientSecret: "oauth_twitter_client_secret",
	TwitterRedirectURL:  "oauth_twitter_redirect_url",
	TwitterBypassInvite: "oauth_twitter_bypass_invite",
}

// GetOAuthSettings returns the current persisted OAuth configuration.
// The client_secret is never returned raw — only a masked preview.
func (h *AdminHandler) GetOAuthSettings(w http.ResponseWriter, r *http.Request) {
	out := OAuthSettings{}
	all, err := h.queries.GetAllSettings(r.Context())
	if err != nil {
		slog.Warn("GetOAuthSettings: read failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read settings")
		return
	}
	byKey := make(map[string]string, len(all))
	for _, s := range all {
		byKey[s.Key] = s.Value
	}
	out.GoogleEnabled = byKey[oauthSettingKeys.GoogleEnabled] == "true"
	out.GoogleClientID = byKey[oauthSettingKeys.GoogleClientID]
	out.GoogleRedirectURL = byKey[oauthSettingKeys.GoogleRedirectURL]
	out.GoogleBypassInvite = byKey[oauthSettingKeys.GoogleBypassInvite] == "true"
	if secret := byKey[oauthSettingKeys.GoogleClientSecret]; secret != "" {
		out.GoogleHasSecret = true
		out.GoogleClientSecretMask = maskAPIKey(secret)
	}

	// Phase B — Discord
	out.DiscordEnabled = byKey[oauthSettingKeys.DiscordEnabled] == "true"
	out.DiscordClientID = byKey[oauthSettingKeys.DiscordClientID]
	out.DiscordRedirectURL = byKey[oauthSettingKeys.DiscordRedirectURL]
	out.DiscordBypassInvite = byKey[oauthSettingKeys.DiscordBypassInvite] == "true"
	if secret := byKey[oauthSettingKeys.DiscordClientSecret]; secret != "" {
		out.DiscordHasSecret = true
		out.DiscordClientSecretMask = maskAPIKey(secret)
	}

	// Phase B — Twitch
	out.TwitchEnabled = byKey[oauthSettingKeys.TwitchEnabled] == "true"
	out.TwitchClientID = byKey[oauthSettingKeys.TwitchClientID]
	out.TwitchRedirectURL = byKey[oauthSettingKeys.TwitchRedirectURL]
	out.TwitchBypassInvite = byKey[oauthSettingKeys.TwitchBypassInvite] == "true"
	if secret := byKey[oauthSettingKeys.TwitchClientSecret]; secret != "" {
		out.TwitchHasSecret = true
		out.TwitchClientSecretMask = maskAPIKey(secret)
	}

	// Phase C — Facebook
	out.FacebookEnabled = byKey[oauthSettingKeys.FacebookEnabled] == "true"
	out.FacebookClientID = byKey[oauthSettingKeys.FacebookClientID]
	out.FacebookRedirectURL = byKey[oauthSettingKeys.FacebookRedirectURL]
	out.FacebookBypassInvite = byKey[oauthSettingKeys.FacebookBypassInvite] == "true"
	if secret := byKey[oauthSettingKeys.FacebookClientSecret]; secret != "" {
		out.FacebookHasSecret = true
		out.FacebookClientSecretMask = maskAPIKey(secret)
	}

	// Phase D — X / Twitter
	out.TwitterEnabled = byKey[oauthSettingKeys.TwitterEnabled] == "true"
	out.TwitterClientID = byKey[oauthSettingKeys.TwitterClientID]
	out.TwitterRedirectURL = byKey[oauthSettingKeys.TwitterRedirectURL]
	out.TwitterBypassInvite = byKey[oauthSettingKeys.TwitterBypassInvite] == "true"
	if secret := byKey[oauthSettingKeys.TwitterClientSecret]; secret != "" {
		out.TwitterHasSecret = true
		out.TwitterClientSecretMask = maskAPIKey(secret)
	}

	writeJSON(w, http.StatusOK, out)
}

// oauthUpdateRequest is the PUT body shape. Pointer semantics match the
// LLM update pattern: presence == "change to this value", absence ==
// "leave alone". *ClientSecret omitted on a save preserves the
// existing secret (so we can re-render the form with the masked preview
// and not require the admin to re-enter the secret on every edit).
type oauthUpdateRequest struct {
	// Google (Phase 3)
	GoogleEnabled      *bool   `json:"google_enabled,omitempty"`
	GoogleClientID     *string `json:"google_client_id,omitempty"`
	GoogleClientSecret *string `json:"google_client_secret,omitempty"`
	GoogleRedirectURL  *string `json:"google_redirect_url,omitempty"`
	GoogleBypassInvite *bool   `json:"google_bypass_invite,omitempty"`

	// Discord (Phase B)
	DiscordEnabled      *bool   `json:"discord_enabled,omitempty"`
	DiscordClientID     *string `json:"discord_client_id,omitempty"`
	DiscordClientSecret *string `json:"discord_client_secret,omitempty"`
	DiscordRedirectURL  *string `json:"discord_redirect_url,omitempty"`
	DiscordBypassInvite *bool   `json:"discord_bypass_invite,omitempty"`

	// Twitch (Phase B)
	TwitchEnabled      *bool   `json:"twitch_enabled,omitempty"`
	TwitchClientID     *string `json:"twitch_client_id,omitempty"`
	TwitchClientSecret *string `json:"twitch_client_secret,omitempty"`
	TwitchRedirectURL  *string `json:"twitch_redirect_url,omitempty"`
	TwitchBypassInvite *bool   `json:"twitch_bypass_invite,omitempty"`

	// Facebook (Phase C)
	FacebookEnabled      *bool   `json:"facebook_enabled,omitempty"`
	FacebookClientID     *string `json:"facebook_client_id,omitempty"`
	FacebookClientSecret *string `json:"facebook_client_secret,omitempty"`
	FacebookRedirectURL  *string `json:"facebook_redirect_url,omitempty"`
	FacebookBypassInvite *bool   `json:"facebook_bypass_invite,omitempty"`

	// X / Twitter (Phase D)
	TwitterEnabled      *bool   `json:"twitter_enabled,omitempty"`
	TwitterClientID     *string `json:"twitter_client_id,omitempty"`
	TwitterClientSecret *string `json:"twitter_client_secret,omitempty"`
	TwitterRedirectURL  *string `json:"twitter_redirect_url,omitempty"`
	TwitterBypassInvite *bool   `json:"twitter_bypass_invite,omitempty"`
}

// UpdateOAuthSettings persists OAuth provider settings. Changes are
// hot-applied — the OAuth handlers read config from server_settings on
// every request, so no restart is required. The handler returns the
// updated settings shape on success (same as Get) for client convenience.
func (h *AdminHandler) UpdateOAuthSettings(w http.ResponseWriter, r *http.Request) {
	var req oauthUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate redirect URLs if provided + non-empty. Each provider's
	// URL is validated independently so a typo on one doesn't block
	// updates to another.
	for _, v := range []struct {
		field string
		val   *string
	}{
		{"google_redirect_url", req.GoogleRedirectURL},
		{"discord_redirect_url", req.DiscordRedirectURL},
		{"twitch_redirect_url", req.TwitchRedirectURL},
		{"facebook_redirect_url", req.FacebookRedirectURL},
		{"twitter_redirect_url", req.TwitterRedirectURL},
	} {
		if v.val != nil && *v.val != "" && !isValidARRURL(*v.val) {
			writeError(w, http.StatusBadRequest, v.field+" must be a valid http(s) URL")
			return
		}
	}

	// Reject masked-secret round-trips. If the admin opens the form,
	// sees the masked preview "abc1****wxyz", and saves without
	// editing, the frontend echoes the mask back — which would
	// CORRUPT the stored secret if we wrote it verbatim. Same defense
	// as LLM api_key. Applied per provider.
	for _, secret := range []**string{
		&req.GoogleClientSecret,
		&req.DiscordClientSecret,
		&req.TwitchClientSecret,
		&req.FacebookClientSecret,
		&req.TwitterClientSecret,
	} {
		if *secret != nil && isMaskedAPIKey(**secret) {
			*secret = nil
		}
	}

	apply := func(key string, val *string) error {
		if val == nil {
			return nil
		}
		current, _, _ := h.queries.GetSettingExists(r.Context(), key)
		if current == *val {
			return nil
		}
		return h.queries.SetSetting(r.Context(), key, *val)
	}

	// Boolean settings: serialize to "true"/"false" so the SetSetting
	// TEXT column round-trips losslessly. apply() short-circuits the
	// DB write when the value is unchanged.
	for _, b := range []struct {
		key string
		val *bool
	}{
		{oauthSettingKeys.GoogleEnabled, req.GoogleEnabled},
		{oauthSettingKeys.GoogleBypassInvite, req.GoogleBypassInvite},
		{oauthSettingKeys.DiscordEnabled, req.DiscordEnabled},
		{oauthSettingKeys.DiscordBypassInvite, req.DiscordBypassInvite},
		{oauthSettingKeys.TwitchEnabled, req.TwitchEnabled},
		{oauthSettingKeys.TwitchBypassInvite, req.TwitchBypassInvite},
		{oauthSettingKeys.FacebookEnabled, req.FacebookEnabled},
		{oauthSettingKeys.FacebookBypassInvite, req.FacebookBypassInvite},
		{oauthSettingKeys.TwitterEnabled, req.TwitterEnabled},
		{oauthSettingKeys.TwitterBypassInvite, req.TwitterBypassInvite},
	} {
		if b.val == nil {
			continue
		}
		v := "false"
		if *b.val {
			v = "true"
		}
		if err := apply(b.key, &v); err != nil {
			slog.Warn("UpdateOAuthSettings: write failed", "key", b.key, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to save OAuth settings")
			return
		}
	}
	for _, p := range []struct {
		key string
		val *string
	}{
		{oauthSettingKeys.GoogleClientID, req.GoogleClientID},
		{oauthSettingKeys.GoogleClientSecret, req.GoogleClientSecret},
		{oauthSettingKeys.GoogleRedirectURL, req.GoogleRedirectURL},
		{oauthSettingKeys.DiscordClientID, req.DiscordClientID},
		{oauthSettingKeys.DiscordClientSecret, req.DiscordClientSecret},
		{oauthSettingKeys.DiscordRedirectURL, req.DiscordRedirectURL},
		{oauthSettingKeys.TwitchClientID, req.TwitchClientID},
		{oauthSettingKeys.TwitchClientSecret, req.TwitchClientSecret},
		{oauthSettingKeys.TwitchRedirectURL, req.TwitchRedirectURL},
		{oauthSettingKeys.FacebookClientID, req.FacebookClientID},
		{oauthSettingKeys.FacebookClientSecret, req.FacebookClientSecret},
		{oauthSettingKeys.FacebookRedirectURL, req.FacebookRedirectURL},
		{oauthSettingKeys.TwitterClientID, req.TwitterClientID},
		{oauthSettingKeys.TwitterClientSecret, req.TwitterClientSecret},
		{oauthSettingKeys.TwitterRedirectURL, req.TwitterRedirectURL},
	} {
		if err := apply(p.key, p.val); err != nil {
			slog.Warn("UpdateOAuthSettings: write failed", "key", p.key, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to save OAuth settings")
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
