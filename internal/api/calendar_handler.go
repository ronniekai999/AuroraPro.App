package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
)

// Phase 6 — Calendar handler.
//
// GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
//   Defaults: today → today+30d. Caps the window at 90 days so a
//   misconfigured client can't ask for "all of 2026" and pull a huge
//   payload. Returns []UpcomingEpisode pre-sorted by air_date asc.
//
// Public for any authenticated user — TV shows are an inherently
// shared property of the server library, not per-user.

const (
	calendarDefaultDays = 30
	calendarMaxDays     = 90
)

type CalendarHandler struct {
	queries *db.Queries
}

func NewCalendarHandler(queries *db.Queries) *CalendarHandler {
	return &CalendarHandler{queries: queries}
}

func (h *CalendarHandler) Upcoming(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	// Parse window. Date-only strings (YYYY-MM-DD) keep the URL
	// clean; we extend `to` to end-of-day so the user sees episodes
	// airing on their selected last day.
	//
	// Audit H2 fix — truncate `from` to MIDNIGHT UTC, not "now-
	// timestamp". The DB's `air_date` is a DATE column; Postgres
	// implicitly promotes DATE → TIMESTAMP at 00:00 UTC, so a
	// `now.UTC()` timestamp at 2pm would silently exclude today's
	// already-aired episodes (`'today 00:00Z' >= 'now 14:00Z'` is
	// false). Truncating to start-of-day fixes the asymmetry.
	now := time.Now().UTC()
	from := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	to := from.AddDate(0, 0, calendarDefaultDays).Add(24*time.Hour - time.Second)

	if v := r.URL.Query().Get("from"); v != "" {
		if t, err := time.Parse("2006-01-02", v); err == nil {
			from = t
		}
	}
	if v := r.URL.Query().Get("to"); v != "" {
		if t, err := time.Parse("2006-01-02", v); err == nil {
			to = t.Add(24*time.Hour - time.Second) // end-of-day inclusive
		}
	}

	// Bound the window. The query is cheap (indexed air_date scan)
	// but unbounded ranges still return potentially-thousands of
	// rows. 90 days is generous for a "what's coming up" surface.
	if to.Sub(from) > calendarMaxDays*24*time.Hour {
		to = from.Add(calendarMaxDays * 24 * time.Hour)
	}
	// Reject reversed ranges with a noop empty response.
	if to.Before(from) {
		writeJSON(w, http.StatusOK, []any{})
		return
	}

	episodes, err := h.queries.UpcomingEpisodes(r.Context(), from, to)
	if err != nil {
		slog.Warn("calendar upcoming failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to load calendar")
		return
	}
	if episodes == nil {
		episodes = []*db.UpcomingEpisode{}
	}
	writeJSON(w, http.StatusOK, episodes)
}
