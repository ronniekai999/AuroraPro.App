package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
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
	secureCookies bool                    // force Secure on auth cookies (TLS-terminating proxy); deep-debug H10
}

func NewAuthHandler(authSvc *auth.Service, queries *db.Queries, activity *ActivityLogger) *AuthHandler {
	return &AuthHandler{authSvc: authSvc, queries: queries, activity: activity}
}

// SetSecureCookies wires the AURORA_SECURE_COOKIES config so the auth cookies
// get the Secure attribute when Aurora runs behind a TLS-terminating reverse
// proxy (where r.TLS is nil). deep-debug H10.
func (h *AuthHandler) SetSecureCookies(v bool) { h.secureCookies = v }

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
		if h.activity != nil {
			h.activity.LogLoginFailed(r.Context(), req.Username, clientIP(r))
		}
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
		if h.activity != nil {
			h.activity.LogLoginFailed(r.Context(), req.Username, clientIP(r))
		}
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	match, err := h.authSvc.VerifyPassword(req.Password, user.PasswordHash)
	if err != nil || !match {
		if h.activity != nil {
			h.activity.LogLoginFailed(r.Context(), req.Username, clientIP(r))
		}
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	// Generate tokens. The refresh token row is created FIRST (issue #462)
	// so its id is known and can ride the access token as the "rtid" claim —
	// the server-side anchor for which sub-profile is currently acting.
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

	accessToken, expiresAt, err := h.authSvc.GenerateAccessToken(user.ID, user.Username, string(user.Role), user.TokenVersion, rt.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	if h.activity != nil {
		h.activity.LogLogin(r.Context(), user.ID, clientIP(r))
	}

	// Stamp last_login_at for the admin Users table's "Last Login" column.
	// Best-effort: the session is already valid, so a write failure here must
	// not fail the login — log and proceed.
	if err := h.queries.UpdateLastLogin(r.Context(), user.ID); err != nil {
		slog.Warn("failed to record last login", "user_id", user.ID, "err", err)
	}

	// Clear password hash before sending user object
	user.PasswordHash = ""
	// deep-debug H10 — set httpOnly cookies and return NO tokens in the body,
	// so neither token is readable from browser JavaScript.
	h.setAuthCookies(w, r, accessToken, time.Until(expiresAt), refreshTokenStr, time.Until(h.authSvc.RefreshTokenExpiry()))
	writeJSON(w, http.StatusOK, models.TokenResponse{
		ExpiresIn: int64(time.Until(expiresAt).Seconds()),
		User:      user,
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

	// Canonicalize the email before validation + storage so case/whitespace
	// variants collapse to one identity (paired with migration 028's
	// LOWER(email) unique index and the case-insensitive GetUserByEmail).
	// deep-debug H1.
	req.Email = normalizeEmail(req.Email)
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
			// Account-enumeration defense: return ONE generic conflict
			// regardless of which unique constraint fired. A
			// username-specific vs email-specific message lets an
			// attacker probe which usernames/emails are already
			// registered. The specific constraint is logged for
			// operators only.
			slog.Warn("register: unique violation on first-admin create",
				"constraint", pgErr.ConstraintName)
			writeError(w, http.StatusConflict, "that username or email is unavailable")
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
			// Account-enumeration defense: we used to special-case
			// "an administrator account already exists — try signing in
			// instead" when exactly one user (the admin) existed. That
			// message confirmed, to an unauthenticated caller, the exact
			// setup state of the server. Return the generic
			// invite-required error in all cases; the gating itself
			// (no invite code → rejected) is unchanged.
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
				// Account-enumeration defense — single generic conflict,
				// specific constraint logged for operators only (see the
				// first-admin branch above for the full rationale).
				slog.Warn("register: unique violation on user create",
					"constraint", pgErr.ConstraintName)
				writeError(w, http.StatusConflict, "that username or email is unavailable")
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
			// ReleaseInviteCodeForUser, not UnclaimInviteCode: by this point
			// FinalizeInviteCode has already stamped used_by with this user,
			// and the plain unclaim deliberately refuses to touch a finalized
			// invite. Releasing it scoped to this user's id undoes our own
			// finalize without being able to reopen anyone else's.
			_ = h.queries.ReleaseInviteCodeForUser(r.Context(), inviteClaimID, user.ID)
		}
		_, _ = h.queries.DeleteUser(r.Context(), user.ID)
	}

	// Generate tokens for immediate login. Refresh token row first (issue
	// #462) so its id is known for the access token's "rtid" claim.
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

	accessToken, expiresAt, err := h.authSvc.GenerateAccessToken(user.ID, user.Username, string(user.Role), user.TokenVersion, rt.ID)
	if err != nil {
		rollbackUser(err)
		writeError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	// Registration logs the user straight in, so seed last_login_at now — a
	// brand-new active account reads as "just now" rather than "Never". Best-
	// effort, same as the password Login path.
	if err := h.queries.UpdateLastLogin(r.Context(), user.ID); err != nil {
		slog.Warn("failed to record last login", "user_id", user.ID, "err", err)
	}

	user.PasswordHash = "" // defense-in-depth: clear even though json:"-" prevents serialization
	// deep-debug H10 — httpOnly cookies, no body tokens.
	h.setAuthCookies(w, r, accessToken, time.Until(expiresAt), refreshTokenStr, time.Until(h.authSvc.RefreshTokenExpiry()))
	writeJSON(w, http.StatusCreated, models.TokenResponse{
		ExpiresIn: int64(time.Until(expiresAt).Seconds()),
		User:      user,
	})
}

func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	// deep-debug H10 — cookie-first (browser sends the httpOnly refresh cookie
	// and no body); fall back to the JSON body for non-browser/API clients.
	refreshTok := ""
	if c, cerr := r.Cookie(auth.RefreshCookieName); cerr == nil && c.Value != "" {
		refreshTok = c.Value
	} else if r.ContentLength != 0 {
		// Only attempt the body decode when a body was actually sent.
		//
		// The browser sends NONE — the refresh token rides the httpOnly
		// cookie. So once that cookie expired, this fell through to
		// decodeJSON on an empty body and answered 400 "invalid request
		// body" for what is simply an expired session: 734 of them in two
		// weeks of production logs, every one mislabelled. Worse, the 400
		// returned BEFORE the clearAuthCookies call below, so the dead
		// cookies were left in place.
		var req models.RefreshRequest
		if err := decodeJSON(w, r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		refreshTok = req.RefreshToken
	}
	if refreshTok == "" {
		h.clearAuthCookies(w, r)
		writeError(w, http.StatusUnauthorized, "no refresh token provided")
		return
	}

	// Atomically revoke the old token and retrieve its data.
	// This prevents TOCTOU races where two concurrent requests both succeed.
	//
	// Distinguish "DB error" from "token not found" so a flaky database
	// doesn't mass-log-out every active user with a misleading 401. A real
	// DB outage returns 500 (alertable, retried by clients); a legitimate
	// revoked/expired token returns 401 (re-login).
	rt, err := h.queries.RevokeAndGetRefreshToken(r.Context(), refreshTok)
	if err != nil {
		slog.Warn("refresh: RevokeAndGetRefreshToken DB error", "error", err)
		writeError(w, http.StatusInternalServerError, "refresh failed")
		return
	}
	if rt == nil {
		// Audit M-refresh — a token that hashes to nothing in the table was
		// presented: either already-consumed (rotated away) or forged. Both
		// are worth a theft signal so operators can alert on replay bursts.
		// We log the client IP (not the token itself — it's a bearer secret).
		//
		// NOTE: this only *signals* reuse; it cannot *contain* it. Truly
		// revoking the active session of a stolen-then-rotated token requires
		// a token-family (family_id) concept so we can invalidate the whole
		// chain when any consumed member reappears. That needs a schema
		// migration and is deferred (migration numbering is coordinated
		// separately).
		slog.Warn("refresh: non-matching refresh token presented (consumed or invalid) — possible replay/theft",
			"client_ip", clientIP(r))
		h.clearAuthCookies(w, r)
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
		// Carry the acting-profile binding forward across rotation (issue
		// #462) — access tokens are short-lived (15 min) and refresh
		// silently in the background, so without this the user's active
		// profile would revert to the account default every rotation.
		ActiveProfileID: rt.ActiveProfileID,
	}
	if err := h.queries.CreateRefreshToken(r.Context(), newRT); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to store refresh token")
		return
	}

	accessToken, expiresAt, err := h.authSvc.GenerateAccessToken(user.ID, user.Username, string(user.Role), user.TokenVersion, newRT.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	user.PasswordHash = ""
	// deep-debug H10 — rotate the cookies, no body tokens.
	h.setAuthCookies(w, r, accessToken, time.Until(expiresAt), newRefreshStr, time.Until(h.authSvc.RefreshTokenExpiry()))
	writeJSON(w, http.StatusOK, models.TokenResponse{
		ExpiresIn: int64(time.Until(expiresAt).Seconds()),
		User:      user,
	})
}

func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	// deep-debug H10 — cookie-first (browser); fall back to the body for
	// non-browser clients. Always clear the cookies regardless of outcome.
	refreshTok := ""
	if c, cerr := r.Cookie(auth.RefreshCookieName); cerr == nil && c.Value != "" {
		refreshTok = c.Value
	} else if r.ContentLength != 0 {
		// Same empty-body trap as Refresh, and it bit harder here: a browser
		// logging out with an already-expired refresh cookie sends no body,
		// hit the decode error, and returned 400 BEFORE clearAuthCookies —
		// so "log me out" left the stale cookies in the browser. Logout must
		// be idempotent; an absent token now falls through to the revoke +
		// clear below, which already tolerate an empty/unknown token.
		var req models.RefreshRequest
		if err := decodeJSON(w, r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		refreshTok = req.RefreshToken
	}
	h.clearAuthCookies(w, r)

	// Use RevokeAndGetRefreshToken to atomically revoke and retrieve the user ID
	// so we can log the logout event. Falls back to plain revoke on failure.
	rt, err := h.queries.RevokeAndGetRefreshToken(r.Context(), refreshTok)
	if err != nil || rt == nil {
		// Token was already revoked, expired, or invalid — still acknowledge logout
		_ = h.queries.RevokeRefreshToken(r.Context(), refreshTok)
	}

	if rt != nil {
		// Audit M-logout — "logout = kill all sessions" requires revoking
		// EVERY refresh token for the user, not just the one presented.
		// RevokeAndGetRefreshToken above only consumed the submitted token,
		// leaving other devices' refresh tokens live and renewable. Mirror
		// the password-change path (ChangePassword) which already pairs
		// RevokeAllUserTokens with BumpUserTokenVersion. Non-fatal on error:
		// the submitted token IS already revoked, and the token_version bump
		// below still neutralizes outstanding access tokens; operator sees
		// the log.
		if err := h.queries.RevokeAllUserTokens(r.Context(), rt.UserID); err != nil {
			slog.Error("failed to revoke all refresh tokens on logout", "user_id", rt.UserID, "error", err)
		}

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
		if h.activity != nil {
			h.activity.LogPasswordChangeFailed(r.Context(), claims.UserID, clientIP(r))
		}
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
		// cached value for up to the cache TTL. See audit H2. (This narrows but
		// does not atomically close the window: a Check racing between the
		// DELETE commit and this call could refill the cache — but only ever
		// with the DB-correct value, since its read is the source of truth, so
		// the residual is identical to the normal TTL window.)
		h.tokenVerStore.Invalidate(id)
	}
	if h.activity != nil {
		h.activity.LogUserDeleted(r.Context(), claims.UserID, id, clientIP(r))
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "user deleted"})
}

// updateRoleRequest is the body for PUT /api/users/{id}/role.
type updateRoleRequest struct {
	Role string `json:"role"`
}

// UpdateUserRole promotes a user to admin or demotes an admin to user.
// Admin-only (gated by the router). The acting admin cannot change their own
// role: that guard both prevents an accidental self-demotion that could strand
// the server with no admin (the only way to reach zero admins, since any other
// admin can be re-promoted by a peer) and matches DeleteUser's self-guard.
func (h *AuthHandler) UpdateUserRole(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}

	claims := auth.GetClaims(r.Context())
	if claims.UserID == id {
		writeError(w, http.StatusBadRequest, "cannot change your own role")
		return
	}

	var req updateRoleRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	role := models.UserRole(req.Role)
	if role != models.RoleAdmin && role != models.RoleUser {
		writeError(w, http.StatusBadRequest, "role must be 'admin' or 'user'")
		return
	}

	updated, lastAdmin, err := h.queries.UpdateUserRole(r.Context(), id, role)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update role")
		return
	}
	if lastAdmin {
		// Refused: demoting this user would leave the server with no admin.
		writeError(w, http.StatusBadRequest, "cannot remove admin from the last remaining admin")
		return
	}
	if !updated {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}

	// RequireAdmin reads the role from the JWT, so a DB-only change wouldn't
	// take effect until the target's access token expired (~10 min). Bump
	// token_version to invalidate the outstanding access token immediately: the
	// next request 401s, the SPA silently refreshes, and Refresh re-reads the
	// new role from the DB. Unlike password-change / delete we deliberately do
	// NOT revoke refresh tokens — the user stays signed in and simply picks up
	// the new role on the next refresh.
	demotion := role == models.RoleUser
	if _, err := h.queries.BumpUserTokenVersion(r.Context(), id); err != nil {
		slog.Error("failed to bump token_version after role change", "user_id", id, "error", err)
		if demotion {
			// Demotion is the security-sensitive direction: until the version is
			// bumped, the just-demoted admin's outstanding token still carries
			// role=admin. Surface the failure (mirrors ChangePassword's fatal
			// treatment) rather than reporting a clean success — the role IS
			// already persisted, so a retry is idempotent and will re-bump.
			writeError(w, http.StatusInternalServerError, "role updated but session revocation failed; retry to fully revoke admin access")
			return
		}
		// Promotion: a missed bump is harmless — the user simply picks up admin
		// on their next natural token refresh. Return success.
	} else if h.tokenVerStore != nil {
		h.tokenVerStore.Invalidate(id)
	}

	if h.activity != nil {
		h.activity.LogUserRoleChanged(r.Context(), claims.UserID, id, string(role), clientIP(r))
	}
	writeJSON(w, http.StatusOK, map[string]string{"role": string(role)})
}
