package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/models"
)

type deviceTestStore struct {
	mu         sync.Mutex
	user       models.User
	created    []models.RefreshToken
	failCreate bool
	acting     *models.UserProfile // nil: an unrestricted acting profile
	failActing bool
	unlocked   *models.UserProfile // MostRestrictiveUnlockedProfile's answer
	ended      bool                // SessionLive answers false
	// MostRestrictiveProfilePIN's answer.
	mostRestrictive    *models.UserProfile
	mostRestrictivePIN *string
	preferred          int64 // the prefer MostRestrictiveProfilePIN was asked for
}

func (s *deviceTestStore) SessionLive(context.Context, int64, int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.ended, nil
}

func (s *deviceTestStore) MostRestrictiveUnlockedProfile(context.Context, int64) (*models.UserProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unlocked == nil {
		return nil, nil
	}
	p := *s.unlocked
	return &p, nil
}

func (s *deviceTestStore) ResolveActingProfile(_ context.Context, userID, _ int64) (*models.UserProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failActing {
		return nil, errors.New("database down")
	}
	if s.acting != nil {
		p := *s.acting
		return &p, nil
	}
	return &models.UserProfile{UserID: userID}, nil
}

func (s *deviceTestStore) GetUserByID(_ context.Context, id int64) (*models.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id != s.user.ID {
		return nil, errors.New("missing user")
	}
	user := s.user
	return &user, nil
}
func (s *deviceTestStore) CreateRefreshTokenAtVersion(_ context.Context, token *models.RefreshToken, expectedVersion int) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failCreate {
		return false, errors.New("database unavailable")
	}
	if token.UserID != s.user.ID || expectedVersion != s.user.TokenVersion {
		return false, nil
	}
	token.ID = int64(len(s.created) + 1)
	s.created = append(s.created, *token)
	return true, nil
}
func (*deviceTestStore) RevokeRefreshToken(context.Context, string) error { return nil }

func deviceTestHandler() (*DeviceAuthHandler, *deviceTestStore) {
	store := &deviceTestStore{user: models.User{ID: 7, Username: "alice", Role: "user", TokenVersion: 3, PasswordHash: "private"}}
	cfg := config.Default().Auth
	cfg.JWTSecret = "device-test-secret-at-least-32-characters-long"
	cfg.AccessTokenExpiry = 15 * time.Minute
	cfg.RefreshTokenExpiry = 24 * time.Hour
	svc := auth.NewService(cfg)
	return &DeviceAuthHandler{grants: newDeviceGrants(), sessions: store, authSvc: svc}, store
}

func deviceRequest(handler http.HandlerFunc, method, path, body string, authenticated bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "https://aurora.example"+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if authenticated {
		r = r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, &auth.JWTClaims{UserID: 7, Username: "alice", Role: "user", TokenVersion: 3}))
	}
	w := httptest.NewRecorder()
	handler(w, r)
	return w
}

func TestDevicePairing_ApprovalAndSingleUseCookieExchange(t *testing.T) {
	h, store := deviceTestHandler()
	start := deviceRequest(h.Start, "POST", "/api/auth/device/start", `{"device_name":"Living room TV"}`, false)
	var grant struct {
		DeviceCode string `json:"device_code"`
		UserCode   string `json:"user_code"`
	}
	if start.Code != 201 || json.Unmarshal(start.Body.Bytes(), &grant) != nil {
		t.Fatalf("start: %d %s", start.Code, start.Body)
	}
	if len(grant.DeviceCode) != 43 || len(grant.UserCode) != 9 || start.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("invalid grant")
	}
	pollBody := fmt.Sprintf(`{"device_code":%q}`, grant.DeviceCode)
	if w := deviceRequest(h.Poll, "POST", "/api/auth/device/poll", pollBody, false); !strings.Contains(w.Body.String(), "authorization_pending") || len(w.Result().Cookies()) != 0 {
		t.Fatalf("pending: %s", w.Body)
	}
	preview := deviceRequest(h.Preview, "GET", "/api/auth/device/preview?code="+grant.UserCode, "", true)
	if preview.Code != 200 || !strings.Contains(preview.Body.String(), "Living room TV") || strings.Contains(preview.Body.String(), grant.DeviceCode) {
		t.Fatalf("preview: %s", preview.Body)
	}
	approveBody := fmt.Sprintf(`{"user_code":%q,"expected_user_id":7}`, strings.ToLower(grant.UserCode))
	if w := deviceRequest(h.Authorize, "POST", "/api/auth/device/authorize", approveBody, false); w.Code != 401 {
		t.Fatalf("anonymous approval: %d", w.Code)
	}
	if w := deviceRequest(h.Authorize, "POST", "/api/auth/device/authorize", approveBody, true); w.Code != 200 {
		t.Fatalf("approve: %d %s", w.Code, w.Body)
	}
	if w := deviceRequest(h.Authorize, "POST", "/api/auth/device/authorize", approveBody, true); w.Code != 404 {
		t.Fatalf("re-approve: %d", w.Code)
	}
	exchange := deviceRequest(h.Poll, "POST", "/api/auth/device/poll", pollBody, false)
	if exchange.Code != 200 || !strings.Contains(exchange.Body.String(), "authorized") {
		t.Fatalf("exchange: %d %s", exchange.Code, exchange.Body)
	}
	for _, secret := range []string{"private", "access_token", "refresh_token", store.created[0].Token} {
		if strings.Contains(exchange.Body.String(), secret) {
			t.Fatalf("body leaked %q", secret)
		}
	}
	cookies := exchange.Result().Cookies()
	if len(cookies) != 2 {
		t.Fatalf("cookies: %+v", cookies)
	}
	for _, cookie := range cookies {
		if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode {
			t.Fatalf("unsafe cookie: %+v", cookie)
		}
		if cookie.Name == "aurora_refresh" && cookie.Path != "/api/auth" {
			t.Fatalf("refresh scope: %+v", cookie)
		}
		if cookie.Name == "aurora_access" {
			claims, err := h.authSvc.ValidateAccessToken(cookie.Value)
			if err != nil || claims.RefreshTokenID != store.created[0].ID || claims.TokenVersion != 3 {
				t.Fatalf("unbound access token: %+v %v", claims, err)
			}
		}
	}
	if w := deviceRequest(h.Poll, "POST", "/api/auth/device/poll", pollBody, false); !strings.Contains(w.Body.String(), "expired_token") || len(w.Result().Cookies()) != 0 {
		t.Fatalf("reused poll: %s", w.Body)
	}
	if len(store.created) != 1 || store.created[0].DeviceInfo != "Living room TV" {
		t.Fatalf("sessions: %+v", store.created)
	}
}

func TestDevicePairing_RevocationAndFailedExchange(t *testing.T) {
	for _, failure := range []string{"revoked", "deleted", "create"} {
		t.Run(failure, func(t *testing.T) {
			h, store := deviceTestHandler()
			secret, grant, err := h.grants.start("TV")
			if err != nil || !h.grants.authorize(grant.UserCode, 7, 3, 0, nil) {
				t.Fatal("grant failed")
			}
			switch failure {
			case "revoked":
				store.user.TokenVersion++
			case "deleted":
				store.user.ID = 8
			case "create":
				store.failCreate = true
			}
			w := deviceRequest(h.Poll, "POST", "/api/auth/device/poll", fmt.Sprintf(`{"device_code":%q}`, secret), false)
			if len(w.Result().Cookies()) != 0 || len(store.created) != 0 {
				t.Fatal("invalid grant produced session")
			}
			if failure == "create" && w.Code != 500 {
				t.Fatalf("status=%d", w.Code)
			}
			if failure != "create" && !strings.Contains(w.Body.String(), "expired_token") {
				t.Fatalf("body=%s", w.Body)
			}
		})
	}
}

func TestDevicePairing_CrossOriginAndStaleApproval(t *testing.T) {
	h, store := deviceTestHandler()
	_, grant, _ := h.grants.start("TV")
	r := httptest.NewRequest("POST", "https://aurora.example/api/auth/device/authorize", strings.NewReader(fmt.Sprintf(`{"user_code":%q,"expected_user_id":7}`, grant.UserCode)))
	r = r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, &auth.JWTClaims{UserID: 7, TokenVersion: 3}))
	r.Header.Set("Origin", "https://attacker.example")
	w := httptest.NewRecorder()
	h.Authorize(w, r)
	if w.Code != 403 {
		t.Fatalf("cross-origin: %d", w.Code)
	}
	store.user.TokenVersion++
	w = deviceRequest(h.Authorize, "POST", "/api/auth/device/authorize", fmt.Sprintf(`{"user_code":%q,"expected_user_id":7}`, grant.UserCode), true)
	if w.Code != 401 {
		t.Fatalf("stale approval: %d", w.Code)
	}
	if _, okay := h.grants.preview(grant.UserCode); !okay {
		t.Fatal("failed approval consumed grant")
	}
}

func TestDevicePairing_ApprovalRejectsAccountChangeAfterPreview(t *testing.T) {
	h, _ := deviceTestHandler()
	_, grant, _ := h.grants.start("TV")
	preview := deviceRequest(h.Preview, "GET", "/api/auth/device/preview?code="+grant.UserCode, "", true)
	var identity struct {
		UserID   int64  `json:"user_id"`
		Username string `json:"username"`
	}
	if err := json.Unmarshal(preview.Body.Bytes(), &identity); err != nil || identity.UserID != 7 || identity.Username != "alice" {
		t.Fatalf("unverified preview identity: %s", preview.Body)
	}
	w := deviceRequest(h.Authorize, "POST", "/api/auth/device/authorize", fmt.Sprintf(`{"user_code":%q,"expected_user_id":8}`, grant.UserCode), true)
	if w.Code != http.StatusConflict {
		t.Fatalf("changed account: %d %s", w.Code, w.Body)
	}
	if _, okay := h.grants.preview(grant.UserCode); !okay {
		t.Fatal("account mismatch authorized the device")
	}
}

func TestDeviceGrants_ConcurrentPollExpirationAndBounds(t *testing.T) {
	g := newDeviceGrants()
	now := time.Now()
	g.now = func() time.Time { return now }
	secret, grant, _ := g.start("TV")
	if !g.authorize(grant.UserCode, 7, 3, 0, nil) {
		t.Fatal("authorize failed")
	}
	var successes atomic.Int32
	var group sync.WaitGroup
	for range 40 {
		group.Go(func() {
			if _, status := g.take(secret); status == "authorized" {
				successes.Add(1)
			}
		})
	}
	group.Wait()
	if successes.Load() != 1 {
		t.Fatalf("exchanges=%d", successes.Load())
	}
	secret, grant, _ = g.start("TV")
	now = now.Add(deviceGrantTTL)
	if g.authorize(grant.UserCode, 7, 3, 0, nil) {
		t.Fatal("expired grant approved")
	}
	if _, status := g.take(secret); status != "expired_token" {
		t.Fatalf("status=%s", status)
	}
	for range 1024 {
		if _, _, err := g.start("TV"); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := g.start("TV"); err == nil {
		t.Fatal("grant bound not enforced")
	}
	for range 10 {
		if !g.allow("start", "client", 10) {
			t.Fatal("premature limit")
		}
	}
	if g.allow("start", "client", 10) || !g.allow("poll", "client", 120) {
		t.Fatal("budgets are not independent")
	}
	now = now.Add(time.Minute)
	if !g.allow("start", "client", 10) {
		t.Fatal("budget failed to expire")
	}
}

func TestDevicePairing_RouterPublicAndProtectedRoutes(t *testing.T) {
	router := newHealthTestRouter(healthTestService())
	for _, route := range []struct {
		method, path, body string
		status             int
	}{
		{"POST", "/api/auth/device/start", `{"device_name":"TV"}`, 201},
		{"POST", "/api/auth/device/poll", `{"device_code":"bad"}`, 400},
		{"GET", "/api/auth/device/preview?code=ABCD-1234", "", 401},
		{"POST", "/api/auth/device/authorize", `{"user_code":"ABCD-1234"}`, 401},
	} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(route.method, route.path, strings.NewReader(route.body)))
		if w.Code != route.status {
			t.Errorf("%s: %d %s", route.path, w.Code, w.Body)
		}
	}
}

// TestDevicePairing_RestrictedApproverBindsTheDevice: an unbound session acts
// as the account's default profile, so a kid's session approving a new device
// must not hand that device the unrestricted default, and no approver should
// hand it a default profile that may be locked. The device's session is bound
// to the approver's acting profile; an account with no profile leaves it
// unbound.
func TestDevicePairing_RestrictedApproverBindsTheDevice(t *testing.T) {
	for _, tc := range []struct {
		name   string
		acting *models.UserProfile
		want   *int64
	}{
		{"restricted approver", &models.UserProfile{ID: 42, UserID: 7, MaxAgeRating: "PG"}, func() *int64 { v := int64(42); return &v }()},
		{"unrestricted approver", &models.UserProfile{ID: 41, UserID: 7}, func() *int64 { v := int64(41); return &v }()},
		{"account with no profile", &models.UserProfile{UserID: 7}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, store := deviceTestHandler()
			store.acting = tc.acting
			secret, grant, err := h.grants.start("Kid's phone")
			if err != nil {
				t.Fatal(err)
			}
			if w := deviceRequest(h.Authorize, "POST", "/api/auth/device/authorize", fmt.Sprintf(`{"user_code":%q,"expected_user_id":7}`, grant.UserCode), true); w.Code != 200 {
				t.Fatalf("authorize: %d %s", w.Code, w.Body)
			}
			if w := deviceRequest(h.Poll, "POST", "/api/auth/device/poll", fmt.Sprintf(`{"device_code":%q}`, secret), false); w.Code != 200 || len(store.created) != 1 {
				t.Fatalf("poll: %d %s, sessions %d", w.Code, w.Body, len(store.created))
			}
			got := store.created[0].ActiveProfileID
			if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
				t.Errorf("paired device session bound to %v, want %v", got, tc.want)
			}
		})
	}
}

// TestDevicePairing_FailsClosedWhenTheActingProfileIsUnknown: the device is
// bound to the approver's acting profile, so an approval that cannot read it
// must not go through and pair the device as the account default.
func TestDevicePairing_FailsClosedWhenTheActingProfileIsUnknown(t *testing.T) {
	h, store := deviceTestHandler()
	store.failActing = true
	secret, grant, err := h.grants.start("Kid's phone")
	if err != nil {
		t.Fatal(err)
	}
	if w := deviceRequest(h.Authorize, "POST", "/api/auth/device/authorize", fmt.Sprintf(`{"user_code":%q,"expected_user_id":7}`, grant.UserCode), true); w.Code != http.StatusInternalServerError {
		t.Fatalf("authorize with the acting profile unknown: %d %s, want 500", w.Code, w.Body)
	}
	if w := deviceRequest(h.Poll, "POST", "/api/auth/device/poll", fmt.Sprintf(`{"device_code":%q}`, secret), false); len(store.created) != 0 {
		t.Errorf("the refused approval still paired the device: poll %d %s, sessions %d", w.Code, w.Body, len(store.created))
	}
}

// TestDevicePairing_ALockedApproverDoesNotPassItsProfileOn: a device acting
// as a locked profile skips its PIN, so a parent pairing the family TV from
// a session on its locked profile left that profile open to anyone at the
// TV. The device gets the account's most restrictive unlocked profile, and
// with every profile locked the approval is refused.
func TestDevicePairing_ALockedApproverDoesNotPassItsProfileOn(t *testing.T) {
	pair := func(t *testing.T, store *deviceTestStore, h *DeviceAuthHandler) (int, []models.RefreshToken) {
		t.Helper()
		secret, grant, err := h.grants.start("Family TV")
		if err != nil {
			t.Fatal(err)
		}
		w := deviceRequest(h.Authorize, "POST", "/api/auth/device/authorize", fmt.Sprintf(`{"user_code":%q,"expected_user_id":7}`, grant.UserCode), true)
		deviceRequest(h.Poll, "POST", "/api/auth/device/poll", fmt.Sprintf(`{"device_code":%q}`, secret), false)
		return w.Code, store.created
	}
	t.Run("an unlocked profile exists", func(t *testing.T) {
		h, store := deviceTestHandler()
		store.acting = &models.UserProfile{ID: 41, UserID: 7, HasPIN: true}
		store.unlocked = &models.UserProfile{ID: 42, UserID: 7, MaxAgeRating: "PG"}
		code, created := pair(t, store, h)
		if code != http.StatusOK || len(created) != 1 || created[0].ActiveProfileID == nil || *created[0].ActiveProfileID != 42 {
			t.Errorf("approval %d, sessions %+v; want the device bound to the unlocked profile 42", code, created)
		}
	})
	t.Run("every profile is locked", func(t *testing.T) {
		h, store := deviceTestHandler()
		store.acting = &models.UserProfile{ID: 41, UserID: 7, HasPIN: true}
		code, created := pair(t, store, h)
		if code != http.StatusConflict || len(created) != 0 {
			t.Errorf("approval %d with %d sessions created; want 409 and none", code, len(created))
		}
	})
	// With no password the device has no other way in, so it gets the most
	// restrictive profile, PIN and all; the session insert rechecks that PIN.
	t.Run("every profile is locked on an account with no password", func(t *testing.T) {
		h, store := deviceTestHandler()
		store.user.PasswordHash = ""
		store.acting = &models.UserProfile{ID: 41, UserID: 7, HasPIN: true}
		hash := "argon2-of-the-kid's-pin"
		store.mostRestrictive = &models.UserProfile{ID: 43, UserID: 7, MaxAgeRating: "PG", HasPIN: true}
		store.mostRestrictivePIN = &hash
		code, created := pair(t, store, h)
		if code != http.StatusOK || len(created) != 1 || created[0].ActiveProfileID == nil || *created[0].ActiveProfileID != 43 {
			t.Fatalf("approval %d, sessions %+v; want the device bound to the most restrictive profile 43", code, created)
		}
		if created[0].BoundPINHash == nil || *created[0].BoundPINHash != hash {
			t.Errorf("the session was judged under PIN %v, want the profile's hash", created[0].BoundPINHash)
		}
		if store.preferred != 41 {
			t.Errorf("asked for the most restrictive profile preferring %d, want the approver's own 41", store.preferred)
		}
	})
}

func (s *deviceTestStore) MostRestrictiveProfilePIN(_ context.Context, _ int64, prefer int64) (*models.UserProfile, *string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.preferred = prefer
	if s.mostRestrictive == nil {
		return nil, nil, errors.New("no profile")
	}
	p := *s.mostRestrictive
	return &p, s.mostRestrictivePIN, nil
}
