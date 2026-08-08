package api

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/recap"
	"github.com/go-chi/chi/v5"
)

// RecapHandler serves "Previously" — spoiler-safe AI series recaps.
type RecapHandler struct {
	queries *db.Queries
	svc     *recap.Service
}

const (
	defaultRecapAskRate    = 20
	defaultRecapAskWindow  = time.Hour
	recapRequestStaleAfter = 2 * time.Minute
)

// NewRecapHandler wires the recap service. llmClient may be nil (LLM disabled);
// the handler then reports the feature as unavailable rather than erroring.
func NewRecapHandler(queries *db.Queries, llmClient *llm.Client) *RecapHandler {
	return &RecapHandler{
		queries: queries,
		svc:     recap.New(queries, llmClient),
	}
}

// Service exposes the underlying recap service so other handlers (e.g. the
// progress handler's completion-hook prebuild) can share the SAME instance —
// keeping single-flight dedup effective across the on-demand and prebuild paths.
func (h *RecapHandler) Service() *recap.Service { return h.svc }

// recapResponse is the GET /api/media/{id}/recap payload. Available is false
// (with a Reason) whenever there's nothing to show — the frontend hides the
// affordance instead of surfacing an error.
type recapResponse struct {
	Available          bool        `json:"available"`
	Reason             string      `json:"reason,omitempty"`
	Recap              string      `json:"recap,omitempty"`
	SuggestedQuestions []string    `json:"suggested_questions,omitempty"`
	UpTo               *recap.UpTo `json:"up_to,omitempty"`
	Cached             bool        `json:"cached,omitempty"`
	HasAskHistory      bool        `json:"has_ask_history,omitempty"`
}

type recapStatusResponse struct {
	Available     bool   `json:"available"`
	Reason        string `json:"reason,omitempty"`
	HasAskHistory bool   `json:"has_ask_history"`
}

type recapTurnResponse struct {
	ID        int64      `json:"id"`
	RequestID string     `json:"request_id"`
	Question  string     `json:"question"`
	Answer    string     `json:"answer"`
	UpTo      recap.UpTo `json:"up_to"`
	Mode      string     `json:"mode"`
	CreatedAt string     `json:"created_at"`
}

type recapConversationResponse struct {
	Available         bool                `json:"available"`
	CanAsk            bool                `json:"can_ask"`
	Reason            string              `json:"reason,omitempty"`
	Turns             []recapTurnResponse `json:"turns"`
	CurrentUpTo       *recap.UpTo         `json:"current_up_to,omitempty"`
	HiddenTurnCount   int                 `json:"hidden_turn_count"`
	HighestHiddenUpTo *recap.UpTo         `json:"highest_hidden_up_to,omitempty"`
	NextBeforeTurnID  *int64              `json:"next_before_turn_id,omitempty"`
}

// Get returns the spoiler-safe recap for the resolved profile resuming a show.
func (h *RecapHandler) Get(w http.ResponseWriter, r *http.Request) {
	mediaID, ok := recapMediaID(w, r)
	if !ok {
		return
	}
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	profileID, ok := h.resolveProfileID(w, r, claims.UserID)
	if !ok {
		return
	}
	hasHistory, historyErr := h.queries.RecapConversationHasHistory(r.Context(), profileID, mediaID)
	if historyErr != nil {
		// History visibility is useful recovery metadata, but a transient lookup
		// failure must not turn an otherwise valid cached recap into a 500.
		slog.Warn("recap: history status lookup failed", "media_item_id", mediaID, "profile_id", profileID,
			"failure", "database", "error_type", fmt.Sprintf("%T", historyErr))
	}

	res, err := h.svc.Build(r.Context(), profileID, mediaID)
	switch {
	case errors.Is(err, recap.ErrLLMUnavailable):
		writeJSON(w, http.StatusOK, recapResponse{Available: false, Reason: "ai_unavailable", HasAskHistory: hasHistory})
	case errors.Is(err, recap.ErrNoHistory):
		writeJSON(w, http.StatusOK, recapResponse{Available: false, Reason: "no_history", HasAskHistory: hasHistory})
	case errors.Is(err, recap.ErrInsufficientContext):
		writeJSON(w, http.StatusOK, recapResponse{Available: false, Reason: "insufficient_overviews", HasAskHistory: hasHistory})
	case err != nil:
		slog.Warn("recap: build failed", "media_item_id", mediaID, "profile_id", profileID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to build recap")
	default:
		writeJSON(w, http.StatusOK, recapResponse{
			Available:          true,
			Recap:              res.Recap,
			SuggestedQuestions: res.SuggestedQuestions,
			UpTo:               &res.UpTo,
			Cached:             res.Cached,
			HasAskHistory:      hasHistory,
		})
	}
}

// Status is the show-wide, profile-aware affordance check. It never invokes a
// model or builds a recap, so detail pages can decide whether to show
// Previously without inspecting one selected season's default-profile rows.
func (h *RecapHandler) Status(w http.ResponseWriter, r *http.Request) {
	mediaID, ok := recapMediaID(w, r)
	if !ok {
		return
	}
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	profileID, ok := h.resolveProfileID(w, r, claims.UserID)
	if !ok {
		return
	}
	hasHistory, err := h.queries.RecapConversationHasHistory(r.Context(), profileID, mediaID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load Previously status")
		return
	}
	_, err = h.svc.Availability(r.Context(), profileID, mediaID)
	if reason, unavailable := recapUnavailableReason(err); unavailable {
		writeJSON(w, http.StatusOK, recapStatusResponse{Available: false, Reason: reason, HasAskHistory: hasHistory})
		return
	}
	if err != nil {
		slog.Warn("recap: status lookup failed", "media_item_id", mediaID, "profile_id", profileID,
			"failure", "database", "error_type", fmt.Sprintf("%T", err))
		writeError(w, http.StatusInternalServerError, "failed to load Previously status")
		return
	}
	writeJSON(w, http.StatusOK, recapStatusResponse{Available: true, HasAskHistory: hasHistory})
}

// Conversation returns the persistent thread filtered to the viewer's current
// spoiler boundary. Later turns are counted but never included in the payload.
func (h *RecapHandler) Conversation(w http.ResponseWriter, r *http.Request) {
	mediaID, ok := recapMediaID(w, r)
	if !ok {
		return
	}
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	profileID, ok := h.resolveProfileID(w, r, claims.UserID)
	if !ok {
		return
	}
	before, limit, ok := recapConversationPagination(w, r)
	if !ok {
		return
	}
	snapshot, err := h.queries.LoadRecapConversationSnapshot(r.Context(), profileID, mediaID, before, limit)
	if err != nil {
		slog.Warn("ask previously: conversation load failed", "media_item_id", mediaID, "profile_id", profileID,
			"failure", "database", "error_type", fmt.Sprintf("%T", err))
		writeError(w, http.StatusInternalServerError, "failed to load Ask Previously")
		return
	}
	page := snapshot.Page
	canAsk := false
	reason := ""
	switch {
	case snapshot.Boundary == nil:
		reason = "no_history"
	case !h.svc.Enabled():
		reason = "ai_unavailable"
	default:
		err = h.svc.CheckAvailabilityAtBoundary(r.Context(), mediaID, snapshot.Boundary)
		if unavailableReason, unavailable := recapUnavailableReason(err); unavailable {
			reason = unavailableReason
		} else if err != nil {
			slog.Warn("ask previously: availability lookup failed", "media_item_id", mediaID, "profile_id", profileID,
				"failure", "database", "error_type", fmt.Sprintf("%T", err))
			writeError(w, http.StatusInternalServerError, "failed to load Ask Previously")
			return
		} else {
			canAsk = true
		}
	}
	turns := make([]recapTurnResponse, 0, len(page.Turns))
	for i := range page.Turns {
		turns = append(turns, recapTurnPayload(&page.Turns[i]))
	}
	response := recapConversationResponse{
		Available:        canAsk || snapshot.HasHistory,
		CanAsk:           canAsk,
		Reason:           reason,
		Turns:            turns,
		HiddenTurnCount:  page.HiddenTurnCount,
		NextBeforeTurnID: page.NextBeforeTurnID,
	}
	if snapshot.Boundary != nil {
		current := recapBoundaryPayload(snapshot.Boundary)
		response.CurrentUpTo = &current
	}
	if page.HighestHiddenTurn != nil {
		hidden := recapTurnBoundaryPayload(page.HighestHiddenTurn)
		response.HighestHiddenUpTo = &hidden
	}
	writeJSON(w, http.StatusOK, response)
}

// AskTurn generates and atomically stores one question/answer pair.
func (h *RecapHandler) AskTurn(w http.ResponseWriter, r *http.Request) {
	mediaID, ok := recapMediaID(w, r)
	if !ok {
		return
	}
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	profileID, ok := h.resolveProfileID(w, r, claims.UserID)
	if !ok {
		return
	}
	var req struct {
		RequestID string `json:"request_id"`
		Question  string `json:"question"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.RequestID = strings.TrimSpace(req.RequestID)
	req.Question = strings.TrimSpace(req.Question)
	if !validUUID(req.RequestID) {
		writeError(w, http.StatusBadRequest, "request_id must be a UUID")
		return
	}
	if req.Question == "" || utf8.RuneCountInString(req.Question) > 500 || strings.ContainsRune(req.Question, '\x00') {
		writeError(w, http.StatusBadRequest, "question must be between 1 and 500 characters")
		return
	}
	questionHash := recapQuestionHash(req.Question)
	reservation, reserveErr := h.queries.ReserveRecapConversationRequest(r.Context(), claims.UserID, profileID, mediaID,
		req.RequestID, questionHash, recapRequestStaleAfter, defaultRecapAskRate, defaultRecapAskWindow)
	switch {
	case errors.Is(reserveErr, db.ErrRecapRateLimited):
		seconds := int(math.Ceil(reservation.RetryAfter.Seconds()))
		if seconds < 1 {
			seconds = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
		slog.Info("ask previously: rate limited", "user_id", claims.UserID, "media_item_id", mediaID)
		writeError(w, http.StatusTooManyRequests, fmt.Sprintf("too many questions — try again in %d seconds", seconds))
		return
	case errors.Is(reserveErr, db.ErrRecapRequestInFlight):
		w.Header().Set("Retry-After", "2")
		writeError(w, http.StatusConflict, "this question is already being answered — retry shortly")
		return
	case errors.Is(reserveErr, db.ErrRecapRequestConflict):
		writeError(w, http.StatusConflict, "request_id was already used for a different question")
		return
	case errors.Is(reserveErr, db.ErrRecapRequestInvalidated):
		writeError(w, http.StatusConflict, "this conversation changed — please retry")
		return
	case reserveErr != nil:
		slog.Warn("ask previously: reservation failed", "media_item_id", mediaID, "profile_id", profileID,
			"failure", "database", "error_type", fmt.Sprintf("%T", reserveErr))
		writeError(w, http.StatusInternalServerError, "failed to start Ask Previously")
		return
	}
	if reservation.ExistingTurn != nil {
		h.writeGuardedRecapTurn(w, r, reservation.ID, profileID, mediaID, req.RequestID, questionHash, http.StatusOK)
		return
	}

	completed := false
	defer func() {
		if completed {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
		defer cancel()
		if failErr := h.queries.FailRecapConversationRequest(cleanupCtx, reservation.ID); failErr != nil {
			slog.Warn("ask previously: failed to release reservation", "media_item_id", mediaID, "profile_id", profileID,
				"failure", "database", "error_type", fmt.Sprintf("%T", failErr))
		}
	}()

	// Reserve before every availability/provider step. A concurrent clear can
	// now invalidate this exact generation epoch, while completed UUID retries
	// above remain available even if the provider is temporarily disabled.
	if !h.svc.Enabled() {
		writeError(w, http.StatusServiceUnavailable, "Ask Previously is temporarily unavailable")
		return
	}
	if _, err := h.svc.Availability(r.Context(), profileID, mediaID); err != nil {
		switch {
		case errors.Is(err, recap.ErrNoHistory):
			writeError(w, http.StatusConflict, "Ask Previously is unavailable: no_history")
		case errors.Is(err, recap.ErrInsufficientContext):
			writeError(w, http.StatusConflict, "Ask Previously is unavailable: insufficient_overviews")
		default:
			writeError(w, http.StatusInternalServerError, "failed to resolve spoiler boundary")
		}
		return
	}

	result, err := h.svc.Ask(r.Context(), profileID, mediaID, req.Question)
	switch {
	case errors.Is(err, recap.ErrLLMUnavailable), errors.Is(err, recap.ErrGeneration):
		writeError(w, http.StatusServiceUnavailable, "Ask Previously is temporarily unavailable")
		return
	case errors.Is(err, recap.ErrNoHistory):
		writeError(w, http.StatusConflict, "Ask Previously is unavailable: no_history")
		return
	case errors.Is(err, recap.ErrInsufficientContext):
		writeError(w, http.StatusConflict, "Ask Previously is unavailable: insufficient_overviews")
		return
	case err != nil:
		slog.Warn("ask previously: request failed", "media_item_id", mediaID, "profile_id", profileID,
			"failure", "internal", "error_type", fmt.Sprintf("%T", err))
		writeError(w, http.StatusInternalServerError, "failed to answer question")
		return
	}

	_, _, err = h.queries.InsertRecapConversationTurn(r.Context(), reservation.ID, profileID, mediaID,
		req.RequestID, questionHash, req.Question, result.Answer, result.Boundary, result.Mode)
	if errors.Is(err, db.ErrRecapBoundaryChanged) {
		writeError(w, http.StatusConflict, "viewing progress changed while answering — please try again")
		return
	}
	if errors.Is(err, db.ErrRecapRequestInvalidated) {
		writeError(w, http.StatusConflict, "this conversation was cleared while answering")
		return
	}
	if err != nil {
		slog.Warn("ask previously: turn persistence failed", "media_item_id", mediaID, "profile_id", profileID,
			"failure", "database", "error_type", fmt.Sprintf("%T", err))
		writeError(w, http.StatusInternalServerError, "failed to save answer")
		return
	}
	completed = true
	h.writeGuardedRecapTurn(w, r, reservation.ID, profileID, mediaID, req.RequestID, questionHash, http.StatusCreated)
}

func (h *RecapHandler) writeGuardedRecapTurn(
	w http.ResponseWriter,
	r *http.Request,
	reservationID, profileID, mediaID int64,
	requestID, questionHash string,
	status int,
) {
	err := h.queries.WithRecapTurnResponseGuard(r.Context(), reservationID, profileID, mediaID, requestID, questionHash,
		func(turn *db.RecapConversationTurn, boundary *db.RecapBoundary) {
			current := recapBoundaryPayload(boundary)
			writeJSON(w, status, map[string]any{"turn": recapTurnPayload(turn), "current_up_to": current})
		})
	switch {
	case errors.Is(err, db.ErrRecapBoundaryChanged):
		writeError(w, http.StatusConflict, "viewing progress changed while answering — please try again")
	case errors.Is(err, db.ErrRecapRequestInvalidated):
		writeError(w, http.StatusConflict, "this conversation was cleared while answering")
	case err != nil:
		slog.Warn("ask previously: response guard failed", "media_item_id", mediaID, "profile_id", profileID,
			"failure", "database", "error_type", fmt.Sprintf("%T", err))
		writeError(w, http.StatusInternalServerError, "failed to finalize answer")
	}
}

func (h *RecapHandler) ClearConversation(w http.ResponseWriter, r *http.Request) {
	mediaID, ok := recapMediaID(w, r)
	if !ok {
		return
	}
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	profileID, ok := h.resolveProfileID(w, r, claims.UserID)
	if !ok {
		return
	}
	if err := h.queries.ClearRecapConversation(r.Context(), profileID, mediaID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to clear Ask Previously history")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *RecapHandler) ClearUnsafeTurns(w http.ResponseWriter, r *http.Request) {
	mediaID, ok := recapMediaID(w, r)
	if !ok {
		return
	}
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	profileID, ok := h.resolveProfileID(w, r, claims.UserID)
	if !ok {
		return
	}
	if err := h.queries.ClearUnsafeRecapTurnsAtCurrentBoundary(r.Context(), profileID, mediaID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to clear hidden answers")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func recapMediaID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	mediaID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || mediaID <= 0 {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return 0, false
	}
	return mediaID, true
}

func recapConversationPagination(w http.ResponseWriter, r *http.Request) (int64, int, bool) {
	var before int64
	if raw := r.URL.Query().Get("before_turn_id"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "invalid before_turn_id")
			return 0, 0, false
		}
		before = parsed
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	return before, limit, true
}

func recapUnavailableReason(err error) (string, bool) {
	switch {
	case errors.Is(err, recap.ErrLLMUnavailable):
		return "ai_unavailable", true
	case errors.Is(err, recap.ErrNoHistory):
		return "no_history", true
	case errors.Is(err, recap.ErrInsufficientContext):
		return "insufficient_overviews", true
	default:
		return "", false
	}
}

func recapBoundaryPayload(boundary *db.RecapBoundary) recap.UpTo {
	return recap.UpTo{EpisodeID: boundary.EpisodeID, Season: boundary.SeasonNumber, Episode: boundary.EpisodeNumber, Title: boundary.Title}
}

func recapTurnBoundaryPayload(turn *db.RecapConversationTurn) recap.UpTo {
	var episodeID int64
	if turn.UpToEpisodeID != nil {
		episodeID = *turn.UpToEpisodeID
	}
	return recap.UpTo{EpisodeID: episodeID, Season: turn.BoundarySeason, Episode: turn.BoundaryEpisode, Title: turn.BoundaryTitle}
}

func recapTurnPayload(turn *db.RecapConversationTurn) recapTurnResponse {
	return recapTurnResponse{
		ID: turn.ID, RequestID: turn.RequestID, Question: turn.Question, Answer: turn.Answer,
		UpTo: recapTurnBoundaryPayload(turn), Mode: turn.GroundingMode, CreatedAt: turn.CreatedAt.UTC().Format(time.RFC3339),
	}
}

func validUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for i, r := range value {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			continue
		}
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}

func recapQuestionHash(question string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(question)))
	return fmt.Sprintf("%x", sum[:])
}

// resolveProfileID mirrors HeroHandler.resolveProfileID: honor ?profile_id=
// (validated against the caller's account), else fall back to the default
// profile. Kept local so the recap route is self-contained.
func (h *RecapHandler) resolveProfileID(w http.ResponseWriter, r *http.Request, userID int64) (int64, bool) {
	if pidStr := r.URL.Query().Get("profile_id"); pidStr != "" {
		profileID, parseErr := strconv.ParseInt(pidStr, 10, 64)
		if parseErr != nil || profileID <= 0 {
			writeError(w, http.StatusBadRequest, "invalid profile_id")
			return 0, false
		}
		profile, err := h.queries.GetProfile(r.Context(), profileID)
		if err != nil || profile == nil {
			writeError(w, http.StatusNotFound, "profile not found")
			return 0, false
		}
		if profile.UserID != userID {
			writeError(w, http.StatusForbidden, "profile does not belong to this user")
			return 0, false
		}
		return profileID, true
	}
	profile, err := h.queries.GetDefaultProfile(r.Context(), userID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "no default profile")
		return 0, false
	}
	return profile.ID, true
}
