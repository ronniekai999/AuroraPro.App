package api

import (
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
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

// applyHandle validates one submitted handle patch and normalizes it in
// place. nil = leave unchanged (stays nil for the COALESCE update); empty
// after normalization = clear. Returns false after writing a 400 so the
// caller can bail with a bare return.
func applyHandle(w http.ResponseWriter, raw *string, re *regexp.Regexp, network string) bool {
	if raw == nil {
		return true
	}
	v := normalizeHandle(*raw)
	if v != "" && !re.MatchString(v) {
		writeError(w, http.StatusBadRequest, network+" handle looks invalid — enter just the username, not a URL")
		return false
	}
	*raw = v
	return true
}

// memberSafeAvatar filters an avatar reference for the member-visible
// boundary. Sub-profile avatars accept ANY http(s) URL (validAvatarValue) —
// fine while only the owner's browser loads them, but a member card is
// fetched by every viewer, which would (a) disclose the raw URL string to
// all members and (b) hand each viewer's IP/UA to whatever host the URL
// names. The SPA's img-src CSP blocks such fetches today, but one loosened
// header shouldn't be the only thing standing (PR-428 review). Member
// cards therefore carry only references that actually render under that
// CSP — built-in nebula ids and TMDB paths; anything else falls back to
// ” and the UI shows the initial (which is also strictly better than the
// blank box CSP-blocked foreign URLs render as).
func memberSafeAvatar(v string) string {
	if v == "" || strings.HasPrefix(v, "nebula:") || strings.HasPrefix(v, "https://image.tmdb.org/") {
		return v
	}
	return ""
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
	p.AvatarURL = memberSafeAvatar(p.AvatarURL)
	writeJSON(w, http.StatusOK, p)
}

// UpdateMyProfile applies a partial patch (nil = leave unchanged, empty =
// clear) to the signed-in user's member profile. The entire patch is
// validated before any DB touch — bad input never costs a query, and the
// pure-validation tests run with nil queries to pin that ordering. The
// write itself is a single atomic per-field COALESCE update (see
// UpdateMemberProfile), then the response re-reads the fresh row.
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
	if !applyHandle(w, req.SocialX, socialXRe, "X") {
		return
	}
	if !applyHandle(w, req.SocialInstagram, socialInstagramRe, "Instagram") {
		return
	}
	if !applyHandle(w, req.SocialFacebook, socialFacebookRe, "Facebook") {
		return
	}
	if !applyHandle(w, req.SocialSnapchat, socialSnapchatRe, "Snapchat") {
		return
	}

	found, err := h.queries.UpdateMemberProfile(r.Context(), claims.UserID, &req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update profile")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	p, err := h.queries.GetMemberProfileByID(r.Context(), claims.UserID)
	if err != nil || p == nil {
		writeError(w, http.StatusInternalServerError, "failed to load profile")
		return
	}
	p.AvatarURL = memberSafeAvatar(p.AvatarURL)
	writeJSON(w, http.StatusOK, p)
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
	// Follow graph (social phase 2). is_following is viewer-relative and
	// meaningless on your own profile (self-follows can't exist).
	FollowerCount  int  `json:"follower_count"`
	FollowingCount int  `json:"following_count"`
	IsFollowing    bool `json:"is_following"`
}

// resolveMemberParam turns the {username} route param into a member profile,
// writing the 400/404/500 itself. Returns nil when the response is already
// written.
func (h *SocialHandler) resolveMemberParam(w http.ResponseWriter, r *http.Request) *models.MemberProfile {
	username := chi.URLParam(r, "username")
	// users.username is VARCHAR(50); anything longer can't exist. Cheap
	// upper bound before the DB round-trip.
	if username == "" || len(username) > 100 {
		writeError(w, http.StatusBadRequest, "invalid username")
		return nil
	}
	p, err := h.queries.GetMemberProfileByUsername(r.Context(), username)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load profile")
		return nil
	}
	if p == nil {
		writeError(w, http.StatusNotFound, "member not found")
		return nil
	}
	return p
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
	p := h.resolveMemberParam(w, r)
	if p == nil {
		return
	}

	p.AvatarURL = memberSafeAvatar(p.AvatarURL)
	resp := memberProfileResponse{
		Profile:       p,
		IsMe:          p.UserID == claims.UserID,
		RecentWatches: []models.MemberRecentWatch{},
	}
	followers, following, isFollowing, err := h.queries.GetFollowStats(r.Context(), p.UserID, claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load follow stats")
		return
	}
	resp.FollowerCount, resp.FollowingCount, resp.IsFollowing = followers, following, isFollowing
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

// Follow makes the caller follow {username}. Idempotent (re-follow = 204).
// Open follow, no approval flow: the only thing an edge unlocks is content
// the followee already opted into sharing (share_watch_history) — the
// privacy gate lives on the data, not the edge.
func (h *SocialHandler) Follow(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	p := h.resolveMemberParam(w, r)
	if p == nil {
		return
	}
	if p.UserID == claims.UserID {
		writeError(w, http.StatusBadRequest, "you cannot follow yourself")
		return
	}
	if err := h.queries.FollowMember(r.Context(), claims.UserID, p.UserID); err != nil {
		// The followee can vanish between resolveMemberParam and the
		// INSERT (admin delete) — the FK violation (23503) is "member not
		// found", not a server fault. Mirrors Unfollow, which no-ops in
		// the same race. Same errors.As pattern as SetRating's FK→404.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			writeError(w, http.StatusNotFound, "member not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to follow")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Unfollow removes the caller's edge to {username}. Idempotent.
func (h *SocialHandler) Unfollow(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	p := h.resolveMemberParam(w, r)
	if p == nil {
		return
	}
	if err := h.queries.UnfollowMember(r.Context(), claims.UserID, p.UserID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to unfollow")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// memberListResponse is the shared envelope for the directory and the
// follower/following lists. Avatars pass the same member-visible boundary
// filter the profile card uses.
type memberListResponse struct {
	Members []models.MemberSummary `json:"members"`
}

func filteredMemberList(members []models.MemberSummary) memberListResponse {
	if members == nil {
		members = []models.MemberSummary{}
	}
	for i := range members {
		members[i].AvatarURL = memberSafeAvatar(members[i].AvatarURL)
	}
	return memberListResponse{Members: members}
}

// ListMembers is the member directory — how you find someone to follow.
func (h *SocialHandler) ListMembers(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	members, err := h.queries.ListMembers(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list members")
		return
	}
	writeJSON(w, http.StatusOK, filteredMemberList(members))
}

// Followers lists who follows {username}, each row flagged with whether the
// CALLER follows them.
func (h *SocialHandler) Followers(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	p := h.resolveMemberParam(w, r)
	if p == nil {
		return
	}
	members, err := h.queries.ListFollowers(r.Context(), p.UserID, claims.UserID, 100)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list followers")
		return
	}
	writeJSON(w, http.StatusOK, filteredMemberList(members))
}

// Following lists who {username} follows, same caller-relative flagging.
func (h *SocialHandler) Following(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	p := h.resolveMemberParam(w, r)
	if p == nil {
		return
	}
	members, err := h.queries.ListFollowing(r.Context(), p.UserID, claims.UserID, 100)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list following")
		return
	}
	writeJSON(w, http.StatusOK, filteredMemberList(members))
}

// resolveViewerProfile mirrors HeroHandler.resolveProfileID (?profile_id=
// validated for ownership, else the default profile) but returns the whole
// profile row — the feed needs max_age_rating, not just the id.
func (h *SocialHandler) resolveViewerProfile(w http.ResponseWriter, r *http.Request, userID int64) (*models.UserProfile, bool) {
	if pidStr := r.URL.Query().Get("profile_id"); pidStr != "" {
		profileID, parseErr := strconv.ParseInt(pidStr, 10, 64)
		if parseErr != nil || profileID <= 0 {
			writeError(w, http.StatusBadRequest, "invalid profile_id")
			return nil, false
		}
		profile, err := h.queries.GetProfile(r.Context(), profileID)
		if err != nil || profile == nil {
			writeError(w, http.StatusNotFound, "profile not found")
			return nil, false
		}
		if profile.UserID != userID {
			writeError(w, http.StatusForbidden, "profile does not belong to this user")
			return nil, false
		}
		return profile, true
	}
	profile, err := h.queries.GetDefaultProfile(r.Context(), userID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "no default profile")
		return nil, false
	}
	return profile, true
}

// FollowingRecent feeds the "From People You Follow" home rail. Empty when
// the caller follows nobody (or nobody they follow shares) — the SPA skips
// zero-item rails, so cold accounts cost one cheap query and render nothing.
//
// The feed is account-scoped DATA but gated by the VIEWING sub-profile's
// parental ceiling, same as every other server-pushed home surface (Trending
// uses server-wide data and still gates) — a kids profile must not get
// R-rated cards because the account follows someone (PR-429 review).
func (h *SocialHandler) FollowingRecent(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profile, ok := h.resolveViewerProfile(w, r, claims.UserID)
	if !ok {
		return
	}
	allowed := allowedRatingsForMax(profile.MaxAgeRating)
	items, err := h.queries.GetFollowedRecentWatches(r.Context(), claims.UserID, allowed, recentWatchesLimit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load feed")
		return
	}
	if items == nil {
		items = []models.FollowedRecentWatch{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
