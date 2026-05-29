package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type AuthHandler struct {
	authSvc       *auth.Service
	queries       *db.Queries
	activity      *ActivityLogger
	tokenVerStore *auth.TokenVersionStore // optional — when set, ChangePassword invalidates cached versions immediately
}

func NewAuthHandler(authSvc *auth.Service, queries *db.Queries, activity *ActivityLogger) *AuthHandler {
	return &AuthHandler{authSvc: authSvc, queries: queries, activity: activity}
}

// SetTokenVersionStore wires the shared cache so password changes can
// invalidate cached versions and take effect on the next request.
func (h *AuthHandler) SetTokenVersionStore(s *auth.TokenVersionStore) {
	h.tokenVerStore = s
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req models.LoginRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "username and password required")
		return
	}

	user, err := h.queries.GetUserByUsername(r.Context(), req.Username)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if user == nil {
		// Run a dummy hash to prevent timing-based username enumeration.
		// Without this, "user not found" responds instantly while "wrong password"
		// takes ~100ms (Argon2), revealing whether the username exists.
		_, _ = h.authSvc.VerifyPassword(req.Password, "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	// OAuth-only users have empty password_hash by design (set by
	// CreateOAuthUser in queries.go). Reject password attempts against
	// them up-front, BEFORE the Argon2 verification, with the same
	// "invalid credentials" message + a dummy verify call to keep timing
	// flat — same defense as the user-not-found branch above. Without
	// this, an OAuth-only user's account is technically reachable via
	// password if their hash ever became matchable (it never will, since
	// the empty string isn't a valid Argon2 hash), but more importantly,
	// the error path is consistent: OAuth users see "invalid credentials"
	// rather than a special-cased message that would leak the fact that
	// they exist as an OAuth account.
	if user.PasswordHash == "" {
		_, _ = h.authSvc.VerifyPassword(req.Password, "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	match, err := h.authSvc.VerifyPassword(req.Password, user.PasswordHash)
	if err != nil || !match {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	// Generate tokens
	accessToken, expiresAt, err := h.authSvc.GenerateAccessToken(user.ID, user.Username, string(user.Role), user.TokenVersion)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	refreshTokenStr, err := h.authSvc.GenerateRefreshToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate refresh token")
		return
	}

	rt := &models.RefreshToken{
		UserID:     user.ID,
		Token:      refreshTokenStr,
		ExpiresAt:  h.authSvc.RefreshTokenExpiry(),
		DeviceInfo: r.UserAgent(),
	}
	if err := h.queries.CreateRefreshToken(r.Context(), rt); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to store refresh token")
		return
	}

	if h.activity != nil {
		h.activity.LogLogin(r.Context(), user.ID, clientIP(r))
	}

	// Clear password hash before sending user object
	user.PasswordHash = ""
	writeJSON(w, http.StatusOK, models.TokenResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshTokenStr,
		ExpiresIn:    int64(time.Until(expiresAt).Seconds()),
		User:         user,
	})
}

// SetupStatus returns whether the server has been set up (i.e. has at least one user).
// This is a public endpoint used by the frontend to decide whether to show the
// invite code field during registration. When no users exist, the first registrant
// becomes admin and no invite code is needed.
//
// Phase 3 (OAuth) addition: also returns oauth_google_enabled so the auth
// screen can conditionally show the "Sign in with Google" button. The
// frontend reads this on every load — no caching needed beyond browser
// HTTP defaults.
//
// oauth_google_bypass_invite: exposes the admin's choice of whether Google
// sign-up requires an invite code. The frontend uses this to (a) show a
// "your invite code applies to Google sign-up too" hint when required,
// and (b) pre-flight-validate before kicking off the OAuth round-trip,
// avoiding a wasted Google dance when we already know it'll fail at
// callback. Backend remains the source of truth — this is a UX shortcut,
// not a security boundary.
func (h *AuthHandler) SetupStatus(w http.ResponseWriter, r *http.Request) {
	count, err := h.queries.CountUsers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	// Read per-provider OAuth enabled flags. Errors are non-fatal — if
	// we can't read a setting, we render the login page without that
	// provider's button, which is the safe default. Operators see
	// "oauth not working for X" rather than an entire broken auth
	// screen.
	//
	// Bypass-invite flags default to false (safe — requires invite)
	// when unreadable. Operators have to explicitly opt into "no
	// invite required for this provider", matching the security
	// posture admins expect.
	readBool := func(key string) bool {
		v, gerr := h.queries.GetSetting(r.Context(), key)
		return gerr == nil && v == "true"
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"has_users": count > 0,
		// Audit M6 — `setup_complete` was declared on the TS
		// SetupStatus interface but never emitted by the backend.
		// Frontend treated undefined as false → "server not set
		// up" forever. setup_complete and has_users currently
		// alias the same condition; if Aurora ever adds richer
		// setup state (e.g. "first user created but no library
		// scanned yet"), this is where to wire it.
		"setup_complete":             count > 0,
		"requires_invite":            count > 0,
		"is_initial_setup":           count == 0,
		"oauth_google_enabled":       readBool("oauth_google_enabled"),
		"oauth_google_bypass_invite": readBool("oauth_google_bypass_invite"),
		// Phase B — Discord + Twitch enabled/bypass flags. Frontend
		// AuthView reads these to conditionally render sign-in
		// buttons + adjust invite-code messaging.
		"oauth_discord_enabled":       readBool("oauth_discord_enabled"),
		"oauth_discord_bypass_invite": readBool("oauth_discord_bypass_invite"),
		"oauth_twitch_enabled":        readBool("oauth_twitch_enabled"),
		"oauth_twitch_bypass_invite":  readBool("oauth_twitch_bypass_invite"),
		// Phase C — Facebook flags.
		"oauth_facebook_enabled":       readBool("oauth_facebook_enabled"),
		"oauth_facebook_bypass_invite": readBool("oauth_facebook_bypass_invite"),
		// Phase D — X (Twitter) flags.
		"oauth_twitter_enabled":       readBool("oauth_twitter_enabled"),
		"oauth_twitter_bypass_invite": readBool("oauth_twitter_bypass_invite"),
	})
}

func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req models.RegisterRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Username == "" || req.Email == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "username, email, and password required")
		return
	}

	// Basic email format validation
	if !isValidEmail(req.Email) {
		writeError(w, http.StatusBadRequest, "invalid email format")
		return
	}

	// Validate username format: alphanumeric, underscores, hyphens, 3-50 chars
	if len(req.Username) < 3 || len(req.Username) > 50 {
		writeError(w, http.StatusBadRequest, "username must be 3-50 characters")
		return
	}
	for _, c := range req.Username {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
			writeError(w, http.StatusBadRequest, "username may only contain letters, numbers, underscores, and hyphens")
			return
		}
	}

	if len(req.Password) < 8 {
		writeError(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	if len(req.Password) > 128 {
		writeError(w, http.StatusBadRequest, "password must be at most 128 characters")
		return
	}

	// Hash password before any DB work (Argon2id is slow; do it outside any lock).
	hash, err := h.authSvc.HashPassword(req.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to hash password")
		return
	}

	// ── First-user path (atomic): become admin without invite code ──
	// CreateFirstAdmin uses INSERT ... WHERE NOT EXISTS(SELECT 1 FROM users)
	// so two concurrent first-registrations cannot both succeed — the loser
	// gets pgx.ErrNoRows and falls through to the invite-code path.
	user, created, err := h.queries.CreateFirstAdmin(r.Context(), req.Username, req.Email, hash)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			msg := "username or email already taken"
			if strings.Contains(pgErr.ConstraintName, "username") {
				msg = "username already taken"
			} else if strings.Contains(pgErr.ConstraintName, "email") {
				msg = "email already taken"
			}
			writeError(w, http.StatusConflict, msg)
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to create user")
		return
	}

	var inviteClaimID int64
	if !created {
		// ── Normal-user path: require invite code ──────────────────────
		// Atomically claim the invite code BEFORE user creation to prevent
		// TOCTOU races where two concurrent registrations reuse the same code.
		if req.InviteCode == "" {
			// Give a helpful message if the admin account already exists
			// (common when a previous registration partially succeeded).
			count, cErr := h.queries.CountUsers(r.Context())
			if cErr != nil {
				slog.Warn("CountUsers failed during registration hint", "error", cErr)
			}
			if count == 1 {
				writeError(w, http.StatusConflict, "an administrator account already exists — try signing in instead")
				return
			}
			writeError(w, http.StatusBadRequest, "invite code required")
			return
		}
		claimID, err := h.queries.ClaimInviteCode(r.Context(), req.InviteCode)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid or expired invite code")
			return
		}
		inviteClaimID = claimID

		// Rely on DB UNIQUE constraints instead of check-then-act to prevent
		// race conditions where concurrent requests both pass the existence check.
		user, err = h.queries.CreateUser(r.Context(), req.Username, req.Email, hash, models.RoleUser)
		if err != nil {
			_ = h.queries.UnclaimInviteCode(r.Context(), inviteClaimID)
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				msg := "username or email already taken"
				if strings.Contains(pgErr.ConstraintName, "username") {
					msg = "username already taken"
				} else if strings.Contains(pgErr.ConstraintName, "email") {
					msg = "email already taken"
				}
				writeError(w, http.StatusConflict, msg)
				return
			}
			writeError(w, http.StatusInternalServerError, "failed to create user")
			return
		}
	}

	// Finalize the invite code with the real user ID
	if inviteClaimID > 0 {
		if err := h.queries.FinalizeInviteCode(r.Context(), inviteClaimID, user.ID); err != nil {
			_ = h.queries.UnclaimInviteCode(r.Context(), inviteClaimID)
			_, _ = h.queries.DeleteUser(r.Context(), user.ID)
			writeError(w, http.StatusInternalServerError, "failed to process invite code")
			return
		}
	}

	// Auto-create default profile for the new user
	if _, err := h.queries.CreateDefaultProfileForUser(r.Context(), user.ID, user.Username); err != nil {
		// Non-fatal: user is created, profile will be created on next server start via data migration
		_ = err
	}

	if h.activity != nil {
		h.activity.LogUserCreated(r.Context(), user.ID, user.Username, clientIP(r))
	}

	// rollbackUser compensates the CreateUser + invite finalize on any
	// downstream failure. Without this, a token-generation or refresh-token-
	// write failure left the user row in the DB with no session AND no invite
	// link — the user could neither log in (we never returned them a token)
	// nor re-register (their email/username were taken). A full DB
	// transaction here would be cleaner, but requires restructuring the
	// auth code path significantly; compensation gets us the same outcome.
	rollbackUser := func(reason error) {
		slog.Warn("register: rolling back user creation", "user_id", user.ID, "error", reason)
		if inviteClaimID > 0 {
			_ = h.queries.UnclaimInviteCode(r.Context(), inviteClaimID)
		}
		_, _ = h.queries.DeleteUser(r.Context(), user.ID)
	}

	// Generate tokens for immediate login
	accessToken, expiresAt, err := h.authSvc.GenerateAccessToken(user.ID, user.Username, string(user.Role), user.TokenVersion)
	if err != nil {
		rollbackUser(err)
		writeError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	refreshTokenStr, err := h.authSvc.GenerateRefreshToken()
	if err != nil {
		rollbackUser(err)
		writeError(w, http.StatusInternalServerError, "failed to generate refresh token")
		return
	}
	rt := &models.RefreshToken{
		UserID:     user.ID,
		Token:      refreshTokenStr,
		ExpiresAt:  h.authSvc.RefreshTokenExpiry(),
		DeviceInfo: r.UserAgent(),
	}
	if err := h.queries.CreateRefreshToken(r.Context(), rt); err != nil {
		rollbackUser(err)
		writeError(w, http.StatusInternalServerError, "failed to store refresh token")
		return
	}

	user.PasswordHash = "" // defense-in-depth: clear even though json:"-" prevents serialization
	writeJSON(w, http.StatusCreated, models.TokenResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshTokenStr,
		ExpiresIn:    int64(time.Until(expiresAt).Seconds()),
		User:         user,
	})
}

func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req models.RefreshRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Atomically revoke the old token and retrieve its data.
	// This prevents TOCTOU races where two concurrent requests both succeed.
	//
	// Distinguish "DB error" from "token not found" so a flaky database
	// doesn't mass-log-out every active user with a misleading 401. A real
	// DB outage returns 500 (alertable, retried by clients); a legitimate
	// revoked/expired token returns 401 (re-login).
	rt, err := h.queries.RevokeAndGetRefreshToken(r.Context(), req.RefreshToken)
	if err != nil {
		slog.Warn("refresh: RevokeAndGetRefreshToken DB error", "error", err)
		writeError(w, http.StatusInternalServerError, "refresh failed")
		return
	}
	if rt == nil {
		writeError(w, http.StatusUnauthorized, "invalid or expired refresh token")
		return
	}

	user, err := h.queries.GetUserByID(r.Context(), rt.UserID)
	if err != nil || user == nil {
		// Don't distinguish "user was deleted" from "token revoked" to a
		// holder of a previously-valid token. Same response either way.
		writeError(w, http.StatusUnauthorized, "invalid or expired refresh token")
		return
	}

	accessToken, expiresAt, err := h.authSvc.GenerateAccessToken(user.ID, user.Username, string(user.Role), user.TokenVersion)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	newRefreshStr, err := h.authSvc.GenerateRefreshToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate refresh token")
		return
	}
	newRT := &models.RefreshToken{
		UserID:     user.ID,
		Token:      newRefreshStr,
		ExpiresAt:  h.authSvc.RefreshTokenExpiry(),
		DeviceInfo: r.UserAgent(),
	}
	if err := h.queries.CreateRefreshToken(r.Context(), newRT); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to store refresh token")
		return
	}

	user.PasswordHash = ""
	writeJSON(w, http.StatusOK, models.TokenResponse{
		AccessToken:  accessToken,
		RefreshToken: newRefreshStr,
		ExpiresIn:    int64(time.Until(expiresAt).Seconds()),
		User:         user,
	})
}

func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	var req models.RefreshRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Use RevokeAndGetRefreshToken to atomically revoke and retrieve the user ID
	// so we can log the logout event. Falls back to plain revoke on failure.
	rt, err := h.queries.RevokeAndGetRefreshToken(r.Context(), req.RefreshToken)
	if err != nil || rt == nil {
		// Token was already revoked, expired, or invalid — still acknowledge logout
		_ = h.queries.RevokeRefreshToken(r.Context(), req.RefreshToken)
	}

	if rt != nil {
		// Bump token_version so outstanding access AND cast-scoped tokens
		// are invalidated immediately, not just on natural expiry. Without
		// this, a long-lived cast URL (default 4h TTL) handed to a
		// Chromecast or AirPlay receiver remains playable after the user
		// signs out — defeating the purpose of logout on a shared device.
		//
		// Side effect: this kills the user's access tokens on OTHER
		// devices too. Aurora's model is "logout = kill all sessions",
		// matching the password-change path above. Multi-device users
		// who want per-device logout would need a separate session-id
		// concept, out of scope here.
		if _, err := h.queries.BumpUserTokenVersion(r.Context(), rt.UserID); err != nil {
			slog.Error("failed to bump token_version on logout", "user_id", rt.UserID, "error", err)
			// Don't fail the logout — the refresh token IS revoked,
			// which prevents session renewal. Access/cast tokens will
			// expire naturally (15m / 4h). Operator will see the log.
		} else if h.tokenVerStore != nil {
			// Drop cached version so the next authenticated request
			// reloads the new value and rejects pre-bump tokens.
			h.tokenVerStore.Invalidate(rt.UserID)
		}

		if h.activity != nil {
			h.activity.LogLogout(r.Context(), rt.UserID)
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "logged out"})
}

func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return
	}

	user, err := h.queries.GetUserByID(r.Context(), claims.UserID)
	if err != nil || user == nil {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}

	user.PasswordHash = ""
	writeJSON(w, http.StatusOK, user)
}

func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return
	}

	var req models.ChangePasswordRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.CurrentPassword == "" {
		writeError(w, http.StatusBadRequest, "current password is required")
		return
	}
	if len(req.NewPassword) < 8 {
		writeError(w, http.StatusBadRequest, "new password must be at least 8 characters")
		return
	}
	if len(req.NewPassword) > 128 {
		writeError(w, http.StatusBadRequest, "new password must be at most 128 characters")
		return
	}

	user, err := h.queries.GetUserByID(r.Context(), claims.UserID)
	if err != nil || user == nil {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}

	match, err := h.authSvc.VerifyPassword(req.CurrentPassword, user.PasswordHash)
	if err != nil || !match {
		writeError(w, http.StatusUnauthorized, "current password is incorrect")
		return
	}

	newHash, err := h.authSvc.HashPassword(req.NewPassword)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to hash password")
		return
	}

	if err := h.queries.UpdateUserPassword(r.Context(), claims.UserID, newHash); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update password")
		return
	}

	// Revoke all existing refresh tokens so compromised tokens can't be
	// renewed into fresh access tokens. AND bump token_version to invalidate
	// every OUTSTANDING access token (not just future refreshes).
	//
	// Both failures must propagate to the client as a 500. The user's
	// contract on a successful password change is full session revocation;
	// silently logging the failure would leave a window where old tokens
	// still work while the response says "updated" — exactly the scenario
	// the user changed their password to escape.
	if err := h.queries.RevokeAllUserTokens(r.Context(), claims.UserID); err != nil {
		slog.Error("failed to revoke tokens after password change", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "password updated but session revocation failed; contact admin")
		return
	}
	if _, err := h.queries.BumpUserTokenVersion(r.Context(), claims.UserID); err != nil {
		slog.Error("failed to bump token_version after password change", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "password updated but session revocation failed; contact admin")
		return
	}
	// Drop the cached version so the next authenticated request reloads
	// the new value and rejects any token issued before the bump.
	if h.tokenVerStore != nil {
		h.tokenVerStore.Invalidate(claims.UserID)
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "password updated"})
}

func (h *AuthHandler) CreateInvite(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	// Defensive: RequireAuth + RequireAdmin ensure claims is non-nil today.
	// Adding the check so a future router refactor that exposes this
	// handler unauthenticated can't nil-panic on claims.UserID below.
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return
	}

	var req models.InviteRequest
	if err := decodeJSON(w, r, &req); err != nil {
		req.ExpiresInHours = 72 // default 3 days
	}
	if req.ExpiresInHours <= 0 {
		req.ExpiresInHours = 72
	}
	if req.ExpiresInHours > 720 {
		req.ExpiresInHours = 720 // max 30 days
	}

	code, err := h.authSvc.GenerateInviteCode()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate code")
		return
	}

	ic := &models.InviteCode{
		Code:      code,
		CreatedBy: claims.UserID,
		ExpiresAt: time.Now().Add(time.Duration(req.ExpiresInHours) * time.Hour),
	}
	if err := h.queries.CreateInviteCode(r.Context(), ic); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create invite")
		return
	}

	writeJSON(w, http.StatusCreated, ic)
}

func (h *AuthHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.queries.GetAllUsers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list users")
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (h *AuthHandler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}

	claims := auth.GetClaims(r.Context())
	if claims.UserID == id {
		writeError(w, http.StatusBadRequest, "cannot delete yourself")
		return
	}

	deleted, err := h.queries.DeleteUser(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete user")
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}

	_ = h.queries.RevokeAllUserTokens(r.Context(), id)
	if h.tokenVerStore != nil {
		// Drop any cached token_version so the next request bearing the
		// deleted user's still-unexpired access token hits the DB and gets the
		// fail-closed -1 sentinel immediately, rather than matching a stale
		// cached value for up to the cache TTL. See audit H2.
		h.tokenVerStore.Invalidate(id)
	}
	if h.activity != nil {
		h.activity.LogUserDeleted(r.Context(), claims.UserID, id, clientIP(r))
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "user deleted"})
}
