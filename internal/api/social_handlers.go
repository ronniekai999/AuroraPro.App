package api

import (
	"net/http"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
)

// SocialHandler serves the member-facing profile surfaces (the Account
// card's long-promised "Phase 3"): the signed-in user's own editable profile
// at /api/me/profile, and the member-visible card at /api/members/{username}.
//
// Privacy model: this is an invite-only server, so "visible" always means
// visible to other AUTHENTICATED members, never the open internet. Identity
// fields (display name / bio / socials) are member-visible by default;
// watch history is opt-in via share_watch_history and scoped to the
// account's default sub-profile only (see GetMemberRecentWatches).
type SocialHandler struct {
	queries *db.Queries
}

func NewSocialHandler(queries *db.Queries) *SocialHandler {
	return &SocialHandler{queries: queries}
}

// Per-network handle shapes. Handles are stored bare (no "@", no URL); the
// frontend composes links against fixed well-known domains, so a profile can
// never point at an arbitrary site. Shapes follow each network's published
// username rules, padded slightly rather than chasing their exact edge cases.
// None admit ':' or '/', which is what makes pasted URLs fail closed.
var (
	socialXRe         = regexp.MustCompile(`^[A-Za-z0-9_]{1,15}$`)
	socialInstagramRe = regexp.MustCompile(`^[A-Za-z0-9._]{1,30}$`)
	socialFacebookRe  = regexp.MustCompile(`^[A-Za-z0-9.]{1,60}$`)
	socialSnapchatRe  = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{1,14}$`)
)

const (
	maxDisplayNameRunes = 80
	maxBioRunes         = 500
	// recentWatchesLimit bounds the profile page's watch strip. Fixed, not
	// client-tunable — the strip is a teaser, not a history browser.
	recentWatchesLimit = 18
)

// sanitizeProfileLine trims and strips control/format/line-separator runes —
// the same character classes sanitizeReferralDetail rejects, for the same
// reason: these fields render in OTHER members' UIs, where invisible
// characters mislead whoever reads them.
func sanitizeProfileLine(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) {
			return -1
		}
		return r
	}, s)
	return strings.TrimSpace(s)
}

// sanitizeProfileBio is sanitizeProfileLine but newline-preserving: the bio
// is the one multi-line field. \r\n normalizes to \n first so the CR doesn't
// get stripped into a mid-line join.
func sanitizeProfileBio(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.Map(func(r rune) rune {
		if r == '\n' {
			return r
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) {
			return -1
		}
		return r
	}, s)
	return strings.TrimSpace(s)
}

// normalizeHandle prepares a submitted social handle for validation: trim,
// then drop one leading "@" (people paste "@name" constantly). Full URL
// pastes are left intact and fail the per-network regexes, producing the
// "bare username" error below.
func normalizeHandle(s string) string {
	return strings.TrimPrefix(strings.TrimSpace(s), "@")
}

// applyHandle validates one submitted handle patch into dst. nil raw = leave
// unchanged; empty (after normalization) = clear. Returns false after
// writing a 400 so the caller can bail with a bare return.
func applyHandle(w http.ResponseWriter, raw *string, re *regexp.Regexp, network string, dst *string) bool {
	if raw == nil {
		return true
	}
	v := normalizeHandle(*raw)
	if v == "" {
		*dst = ""
		return true
	}
	if !re.MatchString(v) {
		writeError(w, http.StatusBadRequest, network+" handle looks invalid — enter just the username, not a URL")
		return false
	}
	*dst = v
	return true
}

// MyProfile returns the signed-in user's own member profile — the settings
// form's read model. Same shape the member endpoint shows others, so the
// form doubles as an exact preview.
func (h *SocialHandler) MyProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	p, err := h.queries.GetMemberProfileByID(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load profile")
		return
	}
	if p == nil {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// UpdateMyProfile applies a partial patch (nil = leave unchanged, empty =
// clear) to the signed-in user's member profile. The entire patch is
// validated before the current row is read, so bad input never costs a
// query — and pure-validation tests can run with nil queries.
func (h *SocialHandler) UpdateMyProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	var req models.UpdateMemberProfileRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.DisplayName != nil {
		v := sanitizeProfileLine(*req.DisplayName)
		if utf8.RuneCountInString(v) > maxDisplayNameRunes {
			writeError(w, http.StatusBadRequest, "display name too long (max 80 characters)")
			return
		}
		req.DisplayName = &v
	}
	if req.Bio != nil {
		v := sanitizeProfileBio(*req.Bio)
		if utf8.RuneCountInString(v) > maxBioRunes {
			writeError(w, http.StatusBadRequest, "bio too long (max 500 characters)")
			return
		}
		req.Bio = &v
	}

	// Validate handles into a scratch profile first (validation must precede
	// any DB touch); the real overlay onto current happens below.
	var scratch models.MemberProfile
	if !applyHandle(w, req.SocialX, socialXRe, "X", &scratch.SocialX) {
		return
	}
	if !applyHandle(w, req.SocialInstagram, socialInstagramRe, "Instagram", &scratch.SocialInstagram) {
		return
	}
	if !applyHandle(w, req.SocialFacebook, socialFacebookRe, "Facebook", &scratch.SocialFacebook) {
		return
	}
	if !applyHandle(w, req.SocialSnapchat, socialSnapchatRe, "Snapchat", &scratch.SocialSnapchat) {
		return
	}

	current, err := h.queries.GetMemberProfileByID(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load profile")
		return
	}
	if current == nil {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}

	if req.DisplayName != nil {
		current.DisplayName = *req.DisplayName
	}
	if req.Bio != nil {
		current.Bio = *req.Bio
	}
	if req.SocialX != nil {
		current.SocialX = scratch.SocialX
	}
	if req.SocialInstagram != nil {
		current.SocialInstagram = scratch.SocialInstagram
	}
	if req.SocialFacebook != nil {
		current.SocialFacebook = scratch.SocialFacebook
	}
	if req.SocialSnapchat != nil {
		current.SocialSnapchat = scratch.SocialSnapchat
	}
	if req.ShareWatchHistory != nil {
		current.ShareWatchHistory = *req.ShareWatchHistory
	}

	if err := h.queries.UpdateMemberProfile(r.Context(), claims.UserID,
		current.DisplayName, current.Bio,
		current.SocialX, current.SocialInstagram, current.SocialFacebook, current.SocialSnapchat,
		current.ShareWatchHistory); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update profile")
		return
	}
	writeJSON(w, http.StatusOK, current)
}

// memberProfileResponse wraps the profile card with its watch strip.
// history_visible (not slice emptiness) is the UI's signal: false = the
// member keeps history private; true + empty slice = shared but nothing
// completed yet. Those render differently.
type memberProfileResponse struct {
	Profile        *models.MemberProfile      `json:"profile"`
	IsMe           bool                       `json:"is_me"`
	HistoryVisible bool                       `json:"history_visible"`
	RecentWatches  []models.MemberRecentWatch `json:"recent_watches"`
}

// MemberProfile returns another member's profile card. Any signed-in member
// may call it; the watch strip is included only when the subject opted in
// (share_watch_history) — or when the viewer IS the subject, so their own
// page previews exactly what sharing would reveal.
func (h *SocialHandler) MemberProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	username := chi.URLParam(r, "username")
	// users.username is VARCHAR(50); anything longer can't exist. Cheap
	// upper bound before the DB round-trip.
	if username == "" || len(username) > 100 {
		writeError(w, http.StatusBadRequest, "invalid username")
		return
	}
	p, err := h.queries.GetMemberProfileByUsername(r.Context(), username)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load profile")
		return
	}
	if p == nil {
		writeError(w, http.StatusNotFound, "member not found")
		return
	}

	resp := memberProfileResponse{
		Profile:       p,
		IsMe:          p.UserID == claims.UserID,
		RecentWatches: []models.MemberRecentWatch{},
	}
	if p.ShareWatchHistory || resp.IsMe {
		resp.HistoryVisible = true
		watches, err := h.queries.GetMemberRecentWatches(r.Context(), p.UserID, recentWatchesLimit)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to load recent watches")
			return
		}
		if watches != nil {
			resp.RecentWatches = watches
		}
	}
	writeJSON(w, http.StatusOK, resp)
}
