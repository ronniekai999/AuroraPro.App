package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/httputil"
	"github.com/aurora-media/aurora/internal/models"
)

const deviceGrantTTL = 10 * time.Minute

type deviceGrant struct {
	Name         string
	UserCode     string
	Expires      time.Time
	UserID       int64
	TokenVersion int
	// ProfileID binds the new device's session to the approver's acting
	// profile (0 when the account has none). An unbound session acts as the
	// account's default profile, so without this a kid's session could approve
	// a new device and land it on the unrestricted default, and any approver
	// could hand a device a locked default it never unlocked.
	ProfileID int64
}

type deviceBudget struct {
	Since time.Time
	Count int
}

// Pairing grants are transient and bounded. A restart invalidates them; it never
// logs a device in. Only a SHA-256 digest of the TV's 256-bit secret is retained.
type deviceGrants struct {
	mu      sync.Mutex
	byToken map[[32]byte]deviceGrant
	byCode  map[string][32]byte
	budgets map[string]deviceBudget
	now     func() time.Time
}

func newDeviceGrants() *deviceGrants {
	return &deviceGrants{byToken: make(map[[32]byte]deviceGrant), byCode: make(map[string][32]byte),
		budgets: make(map[string]deviceBudget), now: time.Now}
}

func (g *deviceGrants) pruneLocked(now time.Time) {
	for token, grant := range g.byToken {
		if !now.Before(grant.Expires) {
			delete(g.byToken, token)
			delete(g.byCode, grant.UserCode)
		}
	}
	for key, budget := range g.budgets {
		if now.Sub(budget.Since) >= time.Minute {
			delete(g.budgets, key)
		}
	}
}

func (g *deviceGrants) allow(action, ip string, maximum int) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	g.pruneLocked(now)
	key := action + ":" + ip
	budget, exists := g.budgets[key]
	if !exists {
		if len(g.budgets) >= 4096 {
			return false
		}
		budget.Since = now
	}
	if budget.Count >= maximum {
		return false
	}
	budget.Count++
	g.budgets[key] = budget
	return true
}

func normalizeDeviceUserCode(code string) string {
	return strings.ReplaceAll(strings.ToUpper(strings.TrimSpace(code)), "-", "")
}

func (g *deviceGrants) start(name string) (string, deviceGrant, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	g.pruneLocked(now)
	if len(g.byToken) >= 1024 {
		return "", deviceGrant{}, errors.New("too many pending devices")
	}
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	for attempt := 0; attempt < 4; attempt++ {
		var random [40]byte
		if _, err := rand.Read(random[:]); err != nil {
			return "", deviceGrant{}, err
		}
		secret := base64.RawURLEncoding.EncodeToString(random[:32])
		code := make([]byte, 8)
		for i, n := range random[32:] {
			code[i] = alphabet[int(n)%len(alphabet)]
		}
		if _, exists := g.byCode[string(code)]; exists {
			continue
		}
		grant := deviceGrant{Name: name, UserCode: string(code), Expires: now.Add(deviceGrantTTL)}
		token := sha256.Sum256([]byte(secret))
		g.byToken[token] = grant
		g.byCode[grant.UserCode] = token
		return secret, grant, nil
	}
	return "", deviceGrant{}, errors.New("could not generate a device code")
}

func (g *deviceGrants) preview(code string) (deviceGrant, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.pruneLocked(g.now())
	token, exists := g.byCode[normalizeDeviceUserCode(code)]
	if !exists {
		return deviceGrant{}, false
	}
	grant := g.byToken[token]
	return grant, grant.UserID == 0
}

func (g *deviceGrants) authorize(code string, userID int64, tokenVersion int, profileID int64) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.pruneLocked(g.now())
	token, exists := g.byCode[normalizeDeviceUserCode(code)]
	if !exists {
		return false
	}
	grant := g.byToken[token]
	if grant.UserID != 0 {
		return false
	}
	grant.UserID, grant.TokenVersion, grant.ProfileID = userID, tokenVersion, profileID
	g.byToken[token] = grant
	return true
}

// take deletes an approved grant while holding the lock, before minting any
// session. Two concurrent polls cannot obtain two refresh-token rows.
func (g *deviceGrants) take(secret string) (deviceGrant, string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.pruneLocked(g.now())
	token := sha256.Sum256([]byte(secret))
	grant, exists := g.byToken[token]
	if !exists {
		return deviceGrant{}, "expired_token"
	}
	if grant.UserID == 0 {
		return deviceGrant{}, "authorization_pending"
	}
	delete(g.byToken, token)
	delete(g.byCode, grant.UserCode)
	return grant, "authorized"
}

type deviceSessionStore interface {
	GetUserByID(context.Context, int64) (*models.User, error)
	ResolveActingProfile(ctx context.Context, userID, refreshTokenID int64) (*models.UserProfile, error)
	MostRestrictiveUnlockedProfile(ctx context.Context, userID int64) (*models.UserProfile, error)
	SessionLive(ctx context.Context, userID, refreshTokenID int64) (bool, error)
	CreateRefreshTokenAtVersion(context.Context, *models.RefreshToken, int) (bool, error)
	RevokeRefreshToken(context.Context, string) error
}

type DeviceAuthHandler struct {
	grants        *deviceGrants
	sessions      deviceSessionStore
	authSvc       *auth.Service
	activity      *ActivityLogger
	secureCookies bool
}

func NewDeviceAuthHandler(svc *auth.Service, queries *db.Queries, activity *ActivityLogger, secure bool) *DeviceAuthHandler {
	return &DeviceAuthHandler{grants: newDeviceGrants(), sessions: queries, authSvc: svc, activity: activity, secureCookies: secure}
}

func (h *DeviceAuthHandler) rateLimit(w http.ResponseWriter, r *http.Request, action string, maximum int) bool {
	w.Header().Set("Cache-Control", "no-store")
	if h.grants.allow(action, clientIP(r), maximum) {
		return true
	}
	w.Header().Set("Retry-After", "60")
	writeError(w, http.StatusTooManyRequests, "too many device sign-in attempts; try again in a minute")
	return false
}

func (h *DeviceAuthHandler) Start(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimit(w, r, "start", 10) {
		return
	}
	var req struct {
		Name string `json:"device_name"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 64 || strings.ContainsFunc(req.Name, unicode.IsControl) {
		writeError(w, http.StatusBadRequest, "device name must be 1 to 64 characters")
		return
	}
	secret, grant, err := h.grants.start(req.Name)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "device sign-in is busy; try again shortly")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"device_code": secret, "user_code": grant.UserCode[:4] + "-" + grant.UserCode[4:],
		"verification_uri": "/v2/device", "expires_in": int(deviceGrantTTL.Seconds()), "interval": 5,
	})
}

func (h *DeviceAuthHandler) Preview(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimit(w, r, "authorize", 10) {
		return
	}
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	grant, exists := h.grants.preview(r.URL.Query().Get("code"))
	if !exists {
		writeError(w, http.StatusNotFound, "device code is expired or already used")
		return
	}
	user, err := h.sessions.GetUserByID(r.Context(), claims.UserID)
	if err != nil || user == nil || user.TokenVersion != claims.TokenVersion {
		writeError(w, http.StatusUnauthorized, "sign in again before authorizing this device")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device_name": grant.Name, "user_id": user.ID, "username": user.Username})
}

func (h *DeviceAuthHandler) Authorize(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimit(w, r, "authorize", 10) {
		return
	}
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && !httputil.SameOrigin(origin, r.Host) {
		writeError(w, http.StatusForbidden, "authorize this device from your Aurora server")
		return
	}
	var req struct {
		Code           string `json:"user_code"`
		ExpectedUserID int64  `json:"expected_user_id"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ExpectedUserID != claims.UserID {
		writeError(w, http.StatusConflict, "your signed-in account changed; look up this TV again before approving")
		return
	}
	user, err := h.sessions.GetUserByID(r.Context(), claims.UserID)
	if err != nil || user == nil || user.TokenVersion != claims.TokenVersion {
		writeError(w, http.StatusUnauthorized, "sign in again before authorizing this device")
		return
	}
	// An approver whose own session has ended (its row deleted by a PIN write,
	// a profile delete or the purge) cannot pair: the new session would
	// outlive the one that approved it.
	if !requireLiveSession(w, r, h.sessions.SessionLive, claims) {
		return
	}
	// The approver passes its own acting profile on to the device. A
	// restricted approver on an unlocked profile therefore cannot raise a
	// ceiling by pairing, and an unrestricted non-default one does not hand
	// the device the account default, which may be a locked profile it never
	// unlocked. A locked acting profile is not passed on: a device acting as
	// it would skip its PIN, so anyone at the new device could pick it. The
	// device gets the account's most restrictive unlocked profile instead,
	// which can be looser than a locked restricted approver's own, though
	// never looser than a profile the approver could switch to without a
	// PIN; with every profile locked the pairing is refused (the account
	// password can still sign the device in). Fails closed.
	acting, err := h.sessions.ResolveActingProfile(r.Context(), claims.UserID, claims.RefreshTokenID)
	if err != nil || acting == nil {
		writeError(w, http.StatusInternalServerError, "could not check the active profile")
		return
	}
	if acting.HasPIN {
		unlocked, uerr := h.sessions.MostRestrictiveUnlockedProfile(r.Context(), claims.UserID)
		if uerr != nil {
			writeError(w, http.StatusInternalServerError, "could not check the active profile")
			return
		}
		if unlocked == nil {
			writeErrorReason(w, http.StatusConflict, "profile_locked",
				"every profile on this account has a PIN; sign in on the device with the account password instead")
			return
		}
		acting = unlocked
	}
	bindProfile := acting.ID // 0 when the account has no profile yet: unbound
	if !h.grants.authorize(req.Code, user.ID, user.TokenVersion, bindProfile) {
		writeError(w, http.StatusNotFound, "device code is expired or already used")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "device authorized"})
}

func (h *DeviceAuthHandler) Poll(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimit(w, r, "poll", 120) {
		return
	}
	var req struct {
		Code string `json:"device_code"`
	}
	if err := decodeJSON(w, r, &req); err != nil || len(req.Code) != 43 {
		writeError(w, http.StatusBadRequest, "invalid device code")
		return
	}
	grant, status := h.grants.take(req.Code)
	if status != "authorized" {
		writeJSON(w, http.StatusOK, map[string]string{"status": status})
		return
	}
	user, err := h.sessions.GetUserByID(r.Context(), grant.UserID)
	if err != nil || user == nil || user.TokenVersion != grant.TokenVersion {
		writeJSON(w, http.StatusOK, map[string]string{"status": "expired_token"})
		return
	}
	refresh, err := h.authSvc.GenerateRefreshToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not sign in this device")
		return
	}
	rt := &models.RefreshToken{UserID: user.ID, Token: refresh, ExpiresAt: h.authSvc.RefreshTokenExpiry(), DeviceInfo: grant.Name}
	if grant.ProfileID != 0 {
		rt.ActiveProfileID = &grant.ProfileID
	}
	created, err := h.sessions.CreateRefreshTokenAtVersion(r.Context(), rt, grant.TokenVersion)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not sign in this device")
		return
	}
	if !created {
		writeJSON(w, http.StatusOK, map[string]string{"status": "expired_token"})
		return
	}
	access, expiry, err := h.authSvc.GenerateAccessToken(user.ID, user.Username, string(user.Role), user.TokenVersion, rt.ID)
	if err != nil {
		// A failed exchange must not leave a renewable session behind.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
		defer cancel()
		_ = h.sessions.RevokeRefreshToken(ctx, refresh)
		writeError(w, http.StatusInternalServerError, "could not sign in this device")
		return
	}
	writeAuthCookies(w, cookieSecureFor(r, h.secureCookies), access, time.Until(expiry), refresh, time.Until(rt.ExpiresAt))
	user.PasswordHash = ""
	if h.activity != nil {
		h.activity.LogLogin(r.Context(), user.ID, clientIP(r))
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "authorized", "user": user})
}
