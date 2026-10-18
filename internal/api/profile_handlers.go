package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type ProfileHandler struct {
	queries *db.Queries
	hero    HeroProvider  // optional; for cache invalidation on maturity_pref change
	authSvc *auth.Service // hashes and checks profile PINs and the account password
	// passwordLimiter is the account password's own budget as a stand-in for
	// a PIN, keyed by account and acting profile.
	passwordLimiter *auth.RateLimiter
	// pinWriteLimiter bounds PIN writes, which each run argon2id.
	pinWriteLimiter *auth.RateLimiter
	// resolveActing resolves the session's acting profile; a field so a test
	// can make it fail and see the management gates fail closed.
	resolveActing func(ctx context.Context, userID, refreshTokenID int64) (*models.UserProfile, error)
	// sessionLive is queries.SessionLive; see actingProfile.
	sessionLive func(ctx context.Context, userID, refreshTokenID int64) (bool, error)
}

// Profile PIN brute-force budget: a four-digit PIN has 10,000 values, so the
// limit is what makes it a lock. After profilePINMaxFailures consecutive
// failures the profile refuses attempts for profilePINLockout, and every
// further failure before a success restarts it. The account password, which
// stands in for a PIN, has a separate budget of profilePasswordAttempts per
// profilePasswordWindow per account.
const (
	profilePINMaxFailures   = 5
	profilePINLockout       = 15 * time.Minute
	profilePasswordAttempts = 5
	profilePasswordWindow   = 15 * time.Minute
	// profilePINWrites PIN sets, changes or removals per profilePINWriteWindow
	// per account.
	profilePINWrites      = 5
	profilePINWriteWindow = 15 * time.Minute
)

// profilePINRe: profile PINs are exactly four digits, as on a TV remote.
var profilePINRe = regexp.MustCompile(`^[0-9]{4}$`)

// nebulaAvatarRe matches the built-in animated-nebula avatar ids the onboarding
// flow assigns ("nebula:aurora", "nebula:tidal", …). These are short opaque ids,
// not image URLs, so avatar validation accepts them alongside http(s) URLs.
var nebulaAvatarRe = regexp.MustCompile(`^nebula:[a-z0-9_-]{1,32}$`)

// validAvatarValue reports whether v is an acceptable, non-empty avatar
// reference: an http(s) URL (length already capped by callers) or a built-in
// nebula id. Callers handle the empty string (means "leave unchanged"/"clear")
// before calling this.
func validAvatarValue(v string) bool {
	if len(v) > 2048 {
		return false
	}
	if strings.HasPrefix(v, "http://") || strings.HasPrefix(v, "https://") {
		return true
	}
	return nebulaAvatarRe.MatchString(v)
}

// maxAgeRatingError is the 400 for a ceiling the rating ladder doesn't know.
// Rejecting it beats storing it: a value no gate recognises reads back as
// all-ages only (db.AllowedRatingsForMax), and before that it meant no
// restriction at all.
func maxAgeRatingError() string {
	return "max_age_rating must be empty (no restriction) or one of: " + strings.Join(db.MaxRatingChoices(), ", ")
}

func NewProfileHandler(queries *db.Queries) *ProfileHandler {
	return &ProfileHandler{
		queries:         queries,
		passwordLimiter: auth.NewRateLimiter(profilePasswordAttempts, profilePasswordWindow),
		pinWriteLimiter: auth.NewRateLimiter(profilePINWrites, profilePINWriteWindow),
		resolveActing:   queries.ResolveActingProfile,
		sessionLive:     queries.SessionLive,
	}
}

// SetHeroProvider wires the recommender so a content-tone (maturity_pref) change
// can invalidate the profile's cached hero/discover and re-curate promptly.
func (h *ProfileHandler) SetHeroProvider(p HeroProvider) { h.hero = p }

// SetAuthService wires the password hasher used for profile PINs and for the
// account password that stands in for a forgotten PIN.
func (h *ProfileHandler) SetAuthService(s *auth.Service) { h.authSvc = s }

// writeErrorReason is writeError with a machine-readable reason that clients
// branch on (the message is for people): "profile_pin_required",
// "profile_pin_invalid", "profile_pin_locked" and "profile_restricted".
func writeErrorReason(w http.ResponseWriter, status int, reason, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": status, "message": message, "reason": reason},
	})
}

// actingProfile resolves the session's acting profile for a profile-management
// write. Unlike discovery, these fail CLOSED: a resolve error must not let a
// restricted session through.
//
// A session whose row is gone (a PIN write, a profile delete or the purge
// ended it) is refused outright: its still-valid access token acts as the
// most restrictive profile, which once no restricted profile is left is the
// unrestricted default, so it could otherwise manage profiles until the
// token expired.
func (h *ProfileHandler) actingProfile(w http.ResponseWriter, r *http.Request, claims *auth.JWTClaims) (*models.UserProfile, bool) {
	if !requireLiveSession(w, r, h.sessionLive, claims) {
		return nil, false
	}
	acting, err := h.resolveActing(r.Context(), claims.UserID, claims.RefreshTokenID)
	if err != nil || acting == nil {
		slog.Warn("profiles: resolve acting profile failed", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to resolve the active profile")
		return nil, false
	}
	return acting, true
}

// requireLiveSession refuses (401 session_ended) a token whose session row
// no longer exists, writing the refusal itself. A token with no session id
// predates session binding and is let through, as elsewhere. Fails closed.
func requireLiveSession(w http.ResponseWriter, r *http.Request, live func(context.Context, int64, int64) (bool, error), claims *auth.JWTClaims) bool {
	if claims.RefreshTokenID == 0 || live == nil {
		return true
	}
	ok, err := live(r.Context(), claims.UserID, claims.RefreshTokenID)
	if err != nil {
		slog.Warn("check session failed", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to check the session")
		return false
	}
	if !ok {
		writeErrorReason(w, http.StatusUnauthorized, "session_ended", "this session has ended; sign in again")
		return false
	}
	return true
}

// requireUnrestricted refuses profile management from a session acting as a
// restricted (ceilinged) profile. Creating an unrestricted profile, deleting
// or re-defaulting one, changing a ceiling or a PIN: each would let the
// restricted session undo its own ceiling.
func (h *ProfileHandler) requireUnrestricted(w http.ResponseWriter, r *http.Request, claims *auth.JWTClaims) (*models.UserProfile, bool) {
	acting, ok := h.actingProfile(w, r, claims)
	if !ok {
		return nil, false
	}
	if acting.MaxAgeRating != "" {
		writeErrorReason(w, http.StatusForbidden, "profile_restricted",
			"switch to a profile without a content rating limit to manage profiles")
		return nil, false
	}
	return acting, true
}

// denyLastUnrestricted refuses a write that would leave the account no
// profile without a content rating limit (db.ErrLastUnrestrictedProfile).
func denyLastUnrestricted(w http.ResponseWriter) {
	writeErrorReason(w, http.StatusConflict, "last_unrestricted_profile",
		"an account keeps at least one profile without a content rating limit; add one first")
}

// sessionStore is what denyRestrictedSession needs.
type sessionStore interface {
	actingProfileResolver
	SessionLive(ctx context.Context, userID, refreshTokenID int64) (bool, error)
}

// actingProfileResolver resolves the session's acting profile.
type actingProfileResolver interface {
	ResolveActingProfile(ctx context.Context, userID, refreshTokenID int64) (*models.UserProfile, error)
}

// denyRestrictedSession refuses an account-level action from a session acting
// as a restricted profile, writing a 403 profile_restricted that names the
// action and returning true. It fails closed: a resolve error refuses too.
// Linking a sign-in identity is one such action: a fresh sign-in through it
// lands on the account default without that profile's PIN.
func denyRestrictedSession(w http.ResponseWriter, r *http.Request, store sessionStore, claims *auth.JWTClaims, action string) bool {
	if !requireLiveSession(w, r, store.SessionLive, claims) {
		return true
	}
	acting, err := store.ResolveActingProfile(r.Context(), claims.UserID, claims.RefreshTokenID)
	if err != nil || acting == nil {
		slog.Warn("resolve acting profile failed", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to resolve the active profile")
		return true
	}
	if acting.MaxAgeRating != "" {
		writeErrorReason(w, http.StatusForbidden, "profile_restricted",
			"switch to a profile without a content rating limit to "+action)
		return true
	}
	return false
}

// unlockRequest carries what can unlock a PIN-protected profile: its PIN, or
// the account password in its place.
type unlockRequest struct {
	PIN      string `json:"pin"`
	Password string `json:"password"`
}

// checkUnlock verifies an unlock attempt for a PIN-protected profile and
// writes the refusal itself, returning false, when it fails:
//   - 403 profile_pin_required with nothing supplied (not counted);
//   - 403 profile_pin_invalid for a wrong PIN or password;
//   - 429 profile_pin_locked while a PIN lockout runs, or once the password
//     budget is spent.
//
// A PIN attempt is counted before it is checked (ReserveProfilePINAttempt),
// so concurrent guesses cannot outrun the limit, and none is checked during a
// lockout. The account password has its own budget instead (passwordLimiter),
// and a PIN lockout does not block it: the password is the recovery path, and
// if PIN guesses could lock it too, anyone on the account could keep the
// owner out indefinitely with one wrong guess per lockout.
//
// The password budget is per account AND acting profile. Per account alone,
// a kid's session spending it every 15 minutes kept the owner's password out
// of every session. Per session, a kid could multiply it by pairing devices.
// Keyed by the acting profile, a restricted session spends only its own
// profile's budget (and that of any unlocked profile it can switch into),
// and every session it can open acts as that profile.
func (h *ProfileHandler) checkUnlock(w http.ResponseWriter, r *http.Request, acting, profile *models.UserProfile, req unlockRequest) bool {
	ok, _ := h.checkUnlockHash(w, r, acting, profile, req)
	return ok
}

// checkUnlockHash is checkUnlock that also returns the hash a presented PIN
// matched ("" when the password unlocked it, or the profile turned out to
// have no PIN), so a bind can refuse if the PIN changed in between.
func (h *ProfileHandler) checkUnlockHash(w http.ResponseWriter, r *http.Request, acting, profile *models.UserProfile, req unlockRequest) (bool, string) {
	ctx := r.Context()
	if h.authSvc == nil {
		writeError(w, http.StatusInternalServerError, "profile lock check unavailable")
		return false, ""
	}
	verified := ""
	switch {
	case req.PIN != "":
		attempt, err := h.queries.ReserveProfilePINAttempt(ctx, profile.ID, profilePINMaxFailures, profilePINLockout)
		if err != nil {
			slog.Warn("profiles: reserve pin attempt failed", "profile_id", profile.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to check the profile lock")
			return false, ""
		}
		if attempt.NoPIN {
			return true, ""
		}
		if !attempt.Reserved {
			writeLockout(w, *attempt.LockedUntil)
			return false, ""
		}
		if ok, _ := h.authSvc.VerifyPassword(req.PIN, attempt.Hash); !ok {
			if attempt.LocksOut {
				writeLockout(w, time.Now().Add(profilePINLockout))
				return false, ""
			}
			writeErrorReason(w, http.StatusForbidden, "profile_pin_invalid", "wrong PIN or password")
			return false, ""
		}
		verified = attempt.Hash
	case req.Password != "":
		st, err := h.queries.GetProfilePINState(ctx, profile.ID)
		if err != nil || st == nil {
			writeError(w, http.StatusInternalServerError, "failed to check the profile lock")
			return false, ""
		}
		if st.Hash == "" {
			return true, ""
		}
		if h.passwordLimiter != nil && !h.passwordLimiter.Allow(strconv.FormatInt(profile.UserID, 10)+":"+strconv.FormatInt(acting.ID, 10)) {
			writeLockout(w, time.Now().Add(profilePasswordWindow))
			return false, ""
		}
		matched := false
		if user, uerr := h.queries.GetUserByID(ctx, profile.UserID); uerr == nil && user != nil && user.PasswordHash != "" {
			matched, _ = h.authSvc.VerifyPassword(req.Password, user.PasswordHash)
		}
		if !matched {
			writeErrorReason(w, http.StatusForbidden, "profile_pin_invalid", "wrong PIN or password")
			return false, ""
		}
	default:
		st, err := h.queries.GetProfilePINState(ctx, profile.ID)
		if err != nil || st == nil {
			writeError(w, http.StatusInternalServerError, "failed to check the profile lock")
			return false, ""
		}
		if st.Hash == "" {
			return true, ""
		}
		writeErrorReason(w, http.StatusForbidden, "profile_pin_required", "this profile is locked; enter its PIN")
		return false, ""
	}
	// A correct PIN or password clears the count and any lockout.
	if err := h.queries.ResetProfilePINFailures(ctx, profile.ID); err != nil {
		slog.Warn("profiles: reset pin failures failed", "profile_id", profile.ID, "error", err)
	}
	return true, verified
}

func writeLockout(w http.ResponseWriter, until time.Time) {
	secs := int(time.Until(until).Seconds()) + 1
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	writeErrorReason(w, http.StatusTooManyRequests, "profile_pin_locked", "too many wrong attempts; try again later")
}

// decodeOptionalJSON decodes a request body that clients may leave empty.
func decodeOptionalJSON(w http.ResponseWriter, r *http.Request, v any) error {
	if err := decodeJSON(w, r, v); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

// ListProfiles returns all profiles for the authenticated user.
func (h *ProfileHandler) ListProfiles(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profiles, err := h.queries.GetProfilesByUser(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list profiles")
		return
	}
	if profiles == nil {
		profiles = []*models.UserProfile{}
	}
	writeJSON(w, http.StatusOK, profiles)
}

// CreateProfile creates a new profile for the authenticated user.
func (h *ProfileHandler) CreateProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}

	var req models.CreateProfileRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Name == "" || len(req.Name) > 100 {
		writeError(w, http.StatusBadRequest, "name is required (max 100 characters)")
		return
	}
	// A restricted session creating an unrestricted profile and switching to
	// it would undo its own ceiling.
	if _, ok := h.requireUnrestricted(w, r, claims); !ok {
		return
	}

	// Check max profiles per user
	count, err := h.queries.CountProfilesByUser(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check profile count")
		return
	}

	maxStr, _ := h.queries.GetSetting(r.Context(), "max_profiles_per_user")
	maxProfiles := 6
	if maxStr != "" {
		if v, err := strconv.Atoi(maxStr); err == nil && v > 0 {
			maxProfiles = v
		}
	}
	if count >= maxProfiles {
		writeError(w, http.StatusBadRequest, "maximum number of profiles reached")
		return
	}

	lang := req.Language
	if lang == "" {
		lang = "en"
	}
	subMode := req.SubtitleMode
	if subMode == "" {
		subMode = "off"
	}
	if subMode != "off" && subMode != "auto" && subMode != "always" {
		writeError(w, http.StatusBadRequest, "subtitle_mode must be off, auto, or always")
		return
	}

	if req.AvatarURL != "" && !validAvatarValue(req.AvatarURL) {
		writeError(w, http.StatusBadRequest, "avatar must be an http(s) URL or a built-in avatar id")
		return
	}
	maxRating, ok := db.CanonicalMaxRating(req.MaxAgeRating)
	if !ok {
		writeError(w, http.StatusBadRequest, maxAgeRatingError())
		return
	}

	profile := &models.UserProfile{
		UserID:       claims.UserID,
		Name:         req.Name,
		AvatarURL:    req.AvatarURL,
		IsDefault:    false,
		MaxAgeRating: maxRating,
		Language:     lang,
		SubtitleLang: req.SubtitleLang,
		SubtitleMode: subMode,
	}

	if err := h.queries.CreateProfile(r.Context(), profile); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create profile")
		return
	}

	writeJSON(w, http.StatusCreated, profile)
}

// GetProfile returns a single profile by ID.
func (h *ProfileHandler) GetProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profileID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile id")
		return
	}

	profile, err := h.queries.GetProfile(r.Context(), profileID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	if profile.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "access denied")
		return
	}

	writeJSON(w, http.StatusOK, profile)
}

// UpdateProfile updates a profile.
func (h *ProfileHandler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profileID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile id")
		return
	}

	profile, err := h.queries.GetProfile(r.Context(), profileID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	if profile.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "access denied")
		return
	}

	var req models.UpdateProfileRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Name != nil && (len(*req.Name) == 0 || len(*req.Name) > 100) {
		writeError(w, http.StatusBadRequest, "name must be 1-100 characters")
		return
	}
	if req.SubtitleMode != nil {
		m := *req.SubtitleMode
		if m != "off" && m != "auto" && m != "always" {
			writeError(w, http.StatusBadRequest, "subtitle_mode must be off, auto, or always")
			return
		}
	}
	// Language column is NOT NULL DEFAULT 'en' in the schema; allowing an
	// empty string through here would silently insert "" and break downstream
	// language-dependent code paths (subtitle picker, UI locale).
	if req.Language != nil && *req.Language == "" {
		writeError(w, http.StatusBadRequest, "language must be a non-empty BCP-47 tag (e.g. 'en')")
		return
	}
	if req.AvatarURL != nil && *req.AvatarURL != "" && !validAvatarValue(*req.AvatarURL) {
		writeError(w, http.StatusBadRequest, "avatar must be an http(s) URL or a built-in avatar id")
		return
	}
	if req.MaxAgeRating != nil {
		maxRating, ok := db.CanonicalMaxRating(*req.MaxAgeRating)
		if !ok {
			writeError(w, http.StatusBadRequest, maxAgeRatingError())
			return
		}
		req.MaxAgeRating = &maxRating
	}

	// A session acting as a restricted profile may edit only that profile's
	// own cosmetic settings: never another profile, and never a ceiling. A
	// client that round-trips the unchanged ceiling is fine.
	acting, ok := h.actingProfile(w, r, claims)
	if !ok {
		return
	}
	if acting.MaxAgeRating != "" {
		if profile.ID != acting.ID {
			writeErrorReason(w, http.StatusForbidden, "profile_restricted", "a restricted profile can only edit itself")
			return
		}
		if req.MaxAgeRating != nil {
			if current, ok := db.CanonicalMaxRating(profile.MaxAgeRating); !ok || current != *req.MaxAgeRating {
				writeErrorReason(w, http.StatusForbidden, "profile_restricted", "a restricted profile cannot change its content rating limit")
				return
			}
		}
	}

	if err := h.queries.UpdateProfile(r.Context(), profileID, &req); err != nil {
		if errors.Is(err, db.ErrLastUnrestrictedProfile) {
			denyLastUnrestricted(w)
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update profile")
		return
	}

	// A content-tone change reshapes recall (maturityPenaltyExpr), so drop the
	// profile's cached hero/discover to re-curate on the next fetch instead of
	// waiting out the 24h TTL. A ceiling change must too, and more urgently:
	// those caches were built under the old ceiling, so tightening it would
	// otherwise keep serving now over-ceiling picks for up to a day.
	if (req.MaturityPref != nil || req.MaxAgeRating != nil) && h.hero != nil {
		h.hero.Invalidate(profileID)
	}

	updated, _ := h.queries.GetProfile(r.Context(), profileID)
	writeJSON(w, http.StatusOK, updated)
}

// DeleteProfile deletes a non-default profile.
func (h *ProfileHandler) DeleteProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profileID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile id")
		return
	}

	profile, err := h.queries.GetProfile(r.Context(), profileID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	if profile.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "access denied")
		return
	}
	if profile.IsDefault {
		writeError(w, http.StatusBadRequest, "cannot delete default profile")
		return
	}
	if _, ok := h.requireUnrestricted(w, r, claims); !ok {
		return
	}

	deleted, err := h.queries.DeleteProfile(r.Context(), profileID)
	if err != nil {
		if errors.Is(err, db.ErrLastUnrestrictedProfile) {
			denyLastUnrestricted(w)
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to delete profile")
		return
	}
	if !deleted {
		writeError(w, http.StatusBadRequest, "cannot delete default profile")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "profile deleted"})
}

// SetDefault sets a profile as the user's default. Restricted sessions may
// not: the default profile is where an unbound session lands.
func (h *ProfileHandler) SetDefault(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	acting, ok := h.requireUnrestricted(w, r, claims)
	if !ok {
		return
	}
	profileID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile id")
		return
	}

	profile, err := h.queries.GetProfile(r.Context(), profileID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	if profile.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "access denied")
		return
	}
	// A session with no binding acts as the default, so making a locked
	// profile the default hands it to every such session without its PIN.
	// It needs the PIN or the password, like activating it.
	var unlock unlockRequest
	if err := decodeOptionalJSON(w, r, &unlock); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if profile.HasPIN && acting.ID != profile.ID && !h.checkUnlock(w, r, acting, profile, unlock) {
		return
	}

	if err := h.queries.SetDefaultProfile(r.Context(), claims.UserID, profileID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to set default profile")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "default profile updated"})
}

// ActivateProfile binds profileID as this SESSION's server-side acting
// profile (issue #462) — the rating-ceiling source of truth for read/
// playback enforcement, distinct from SetDefault's account-wide persistent
// default. Clients switch their display only once this returns 200, so a 200
// always means the binding took. A locked profile needs its PIN or the
// account password first.
func (h *ProfileHandler) ActivateProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profileID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile id")
		return
	}

	profile, err := h.queries.GetProfile(r.Context(), profileID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	if profile.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "access denied")
		return
	}

	// A locked profile needs its PIN (or the account password), unless this
	// session is already acting as it. Checked before the unbound-token
	// branch below, so no client is told a locked profile is active without
	// one.
	var unlock unlockRequest
	if err := decodeOptionalJSON(w, r, &unlock); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// The bind rechecks the PIN state judged here (wantHash), so a PIN set
	// or changed in between cannot be skipped.
	none := ""
	wantHash := &none
	if profile.HasPIN {
		acting, ok := h.actingProfile(w, r, claims)
		if !ok {
			return
		}
		wantHash = nil
		if acting.ID != profile.ID {
			ok, verified := h.checkUnlockHash(w, r, acting, profile, unlock)
			if !ok {
				return
			}
			if verified != "" {
				wantHash = &verified
			}
		}
	}

	if claims.RefreshTokenID == 0 {
		// This access token predates the session-binding feature (or is a
		// scoped/cast token, which never carries one), so there is no
		// refresh_tokens row to bind. It used to answer 200 "activated
		// locally", but clients now take a 200 as a confirmed binding, so
		// this is a 409 like a revoked row: refresh, then retry.
		writeErrorReason(w, http.StatusConflict, "session_unbound", "this session cannot hold a profile yet; refresh and retry")
		return
	}

	bound, err := h.queries.SetActiveProfileForTokenIfPIN(r.Context(), claims.RefreshTokenID, claims.UserID, profileID, wantHash)
	if errors.Is(err, db.ErrProfilePINChanged) {
		writeErrorReason(w, http.StatusForbidden, "profile_pin_required", "this profile's PIN just changed; enter its PIN")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to activate profile")
		return
	}
	if !bound {
		// The session (refresh_tokens row) itself is gone — revoked by a
		// concurrent logout/refresh between this request's auth check and
		// this write. Reporting success here would silently leave
		// enforcement on the account default; the caller should re-auth
		// and retry rather than believe the switch took.
		writeError(w, http.StatusConflict, "session no longer active; please refresh and retry")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "profile activated"})
}

// GetActiveProfile returns the profile this session is acting as, which is
// what every server-side ceiling uses. Clients read it at startup instead of
// trusting a locally remembered choice, so the UI cannot show one profile
// while the server enforces another.
func (h *ProfileHandler) GetActiveProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	acting, ok := h.actingProfile(w, r, claims)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, acting)
}

// SetProfilePIN sets, changes or removes a profile's PIN:
// {"pin": "1234"} sets it, {"pin": ""} removes it. Changing or removing an
// existing PIN also needs that PIN ("current_pin") or the account password
// ("password"), with the same attempt budget as activation. Only sessions
// acting as an unrestricted profile may manage PINs.
func (h *ProfileHandler) SetProfilePIN(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profileID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile id")
		return
	}
	var req struct {
		PIN        *string `json:"pin"`
		CurrentPIN string  `json:"current_pin"`
		Password   string  `json:"password"`
	}
	if err := decodeJSON(w, r, &req); err != nil || req.PIN == nil {
		writeError(w, http.StatusBadRequest, `body must be {"pin": "1234"} to set a PIN or {"pin": ""} to remove it`)
		return
	}
	if *req.PIN != "" && !profilePINRe.MatchString(*req.PIN) {
		writeError(w, http.StatusBadRequest, "a profile PIN is exactly four digits")
		return
	}

	profile, err := h.queries.GetProfile(r.Context(), profileID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	if profile.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "access denied")
		return
	}
	acting, ok := h.requireUnrestricted(w, r, claims)
	if !ok {
		return
	}
	// Every write hashes the new PIN with argon2id (64 MiB), and checking the
	// current one costs another, so PIN writes have their own budget per
	// account, as the auth routes do.
	// Keyed by account and acting profile, like the password budget, so one
	// session spending it does not lock the owner out of PIN changes.
	if h.pinWriteLimiter != nil && !h.pinWriteLimiter.Allow(strconv.FormatInt(claims.UserID, 10)+":"+strconv.FormatInt(acting.ID, 10)) {
		w.Header().Set("Retry-After", strconv.Itoa(int(profilePINWriteWindow.Seconds())))
		writeErrorReason(w, http.StatusTooManyRequests, "rate_limited", "too many PIN changes; try again later")
		return
	}
	if profile.HasPIN && !h.checkUnlock(w, r, acting, profile, unlockRequest{PIN: req.CurrentPIN, Password: req.Password}) {
		return
	}
	if h.authSvc == nil {
		writeError(w, http.StatusInternalServerError, "profile lock unavailable")
		return
	}

	hash := ""
	if *req.PIN != "" {
		if hash, err = h.authSvc.HashPassword(*req.PIN); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to set the PIN")
			return
		}
	}
	revoked, err := h.queries.SetProfilePIN(r.Context(), claims.UserID, profileID, hash, claims.RefreshTokenID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to set the PIN")
		return
	}
	if revoked > 0 {
		slog.Info("profiles: a PIN change signed out the sessions acting as the profile",
			"profile_id", profileID, "sessions", revoked)
	}
	updated, _ := h.queries.GetProfile(r.Context(), profileID)
	writeJSON(w, http.StatusOK, updated)
}

// ============================================================
// Watchlist Handlers
// ============================================================

func (h *ProfileHandler) requireProfileOwnership(w http.ResponseWriter, r *http.Request) (int64, bool) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return 0, false
	}
	profileID, err := strconv.ParseInt(chi.URLParam(r, "profileId"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile id")
		return 0, false
	}

	profile, err := h.queries.GetProfile(r.Context(), profileID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return 0, false
	}
	if profile.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "access denied")
		return 0, false
	}
	return profileID, true
}

func (h *ProfileHandler) requireWatchlistOwnership(w http.ResponseWriter, r *http.Request, profileID int64) (int64, bool) {
	listID, err := strconv.ParseInt(chi.URLParam(r, "listId"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid watchlist id")
		return 0, false
	}

	wl, err := h.queries.GetWatchlist(r.Context(), listID)
	if err != nil || wl == nil {
		writeError(w, http.StatusNotFound, "watchlist not found")
		return 0, false
	}
	if wl.ProfileID != profileID {
		writeError(w, http.StatusForbidden, "access denied")
		return 0, false
	}
	return listID, true
}

// ListWatchlists returns all watchlists for a profile.
func (h *ProfileHandler) ListWatchlists(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}

	lists, err := h.queries.GetWatchlistsByProfile(r.Context(), profileID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list watchlists")
		return
	}
	if lists == nil {
		lists = []*models.Watchlist{}
	}
	writeJSON(w, http.StatusOK, lists)
}

// CreateWatchlist creates a new watchlist for a profile.
func (h *ProfileHandler) CreateWatchlist(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}

	var req models.CreateWatchlistRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Name == "" || len(req.Name) > 255 {
		writeError(w, http.StatusBadRequest, "name is required (max 255 characters)")
		return
	}

	listType := req.ListType
	if listType == "" {
		listType = "custom"
	}
	if listType != "want_to_watch" && listType != "favorites" && listType != "custom" {
		writeError(w, http.StatusBadRequest, "list_type must be want_to_watch, favorites, or custom")
		return
	}

	wl := &models.Watchlist{
		ProfileID: profileID,
		Name:      req.Name,
		ListType:  listType,
	}

	if err := h.queries.CreateWatchlist(r.Context(), wl); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create watchlist")
		return
	}

	writeJSON(w, http.StatusCreated, wl)
}

// DeleteWatchlist deletes a watchlist.
func (h *ProfileHandler) DeleteWatchlist(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}

	listID, ok := h.requireWatchlistOwnership(w, r, profileID)
	if !ok {
		return
	}

	deleted, err := h.queries.DeleteWatchlist(r.Context(), listID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete watchlist")
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "watchlist not found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "watchlist deleted"})
}

// GetWatchlistItems returns items in a watchlist.
func (h *ProfileHandler) GetWatchlistItems(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}

	listID, ok := h.requireWatchlistOwnership(w, r, profileID)
	if !ok {
		return
	}

	params := paginate(r)
	items, total, err := h.queries.GetWatchlistItems(r.Context(), listID, params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get watchlist items")
		return
	}
	if items == nil {
		items = []*models.WatchlistItem{}
	}

	writeJSON(w, http.StatusOK, paginatedResponse(items, total, params))
}

// AddToWatchlist adds an item to a watchlist.
func (h *ProfileHandler) AddToWatchlist(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}

	listID, ok := h.requireWatchlistOwnership(w, r, profileID)
	if !ok {
		return
	}

	var req models.AddToWatchlistRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.MediaItemID <= 0 {
		writeError(w, http.StatusBadRequest, "media_item_id required")
		return
	}

	if err := h.queries.AddToWatchlist(r.Context(), listID, req.MediaItemID); err != nil {
		// Distinguish FK violation (media_item_id doesn't exist) from
		// genuine server errors so the client gets an actionable 404
		// instead of a generic 500.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			writeError(w, http.StatusNotFound, "media item not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to add to watchlist")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]string{"message": "added to watchlist"})
}

// GetLibrary returns the profile's "My Library" saved items — the set behind
// the + save button. Backed by a reserved default watchlist so saves persist
// server-side and sync across devices (previously they lived only in one
// browser's localStorage).
func (h *ProfileHandler) GetLibrary(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}
	wl, err := h.queries.GetOrCreateLibraryWatchlist(r.Context(), profileID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve library")
		return
	}
	items, err := h.queries.GetAllWatchlistItems(r.Context(), wl.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get library items")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// AddToLibrary saves a media item to the profile's library. Idempotent —
// re-saving an already-saved item is a no-op, not an error.
func (h *ProfileHandler) AddToLibrary(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}
	var req models.AddToWatchlistRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.MediaItemID <= 0 {
		writeError(w, http.StatusBadRequest, "media_item_id required")
		return
	}
	wl, err := h.queries.GetOrCreateLibraryWatchlist(r.Context(), profileID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve library")
		return
	}
	if err := h.queries.AddToWatchlist(r.Context(), wl.ID, req.MediaItemID); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			writeError(w, http.StatusNotFound, "media item not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to add to library")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"message": "added to library"})
}

// RemoveFromLibrary removes a media item from the profile's library by its
// media_item_id. Idempotent — removing an item that isn't saved returns 200 so
// an optimistic UI double-remove doesn't surface a spurious error.
func (h *ProfileHandler) RemoveFromLibrary(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}
	mediaItemID, err := strconv.ParseInt(chi.URLParam(r, "mediaItemId"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media item id")
		return
	}
	wl, err := h.queries.GetOrCreateLibraryWatchlist(r.Context(), profileID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve library")
		return
	}
	if _, err := h.queries.RemoveFromWatchlistByMedia(r.Context(), wl.ID, mediaItemID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove from library")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "removed from library"})
}

// RemoveFromWatchlist removes an item from a watchlist.
func (h *ProfileHandler) RemoveFromWatchlist(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}

	listID, ok := h.requireWatchlistOwnership(w, r, profileID)
	if !ok {
		return
	}

	itemID, err := strconv.ParseInt(chi.URLParam(r, "itemId"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid item id")
		return
	}

	deleted, err := h.queries.RemoveFromWatchlist(r.Context(), listID, itemID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove from watchlist")
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "item not found in watchlist")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "removed from watchlist"})
}
