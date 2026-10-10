package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

// These seams place real HTTP revocation exactly between Poll's lookup and
// version-checked insert, rather than relying on scheduler timing.
type deviceExchangeStore struct {
	*db.Queries
	beforeCreate func()
	afterCreate  func()
}

func (s *deviceExchangeStore) CreateRefreshTokenAtVersion(ctx context.Context, rt *models.RefreshToken, version int) (bool, error) {
	if s.beforeCreate != nil {
		s.beforeCreate()
	}
	created, err := s.Queries.CreateRefreshTokenAtVersion(ctx, rt, version)
	if created && s.afterCreate != nil {
		s.afterCreate()
	}
	return created, err
}

func TestDevicePairing_RevocationBetweenLookupAndInsert(t *testing.T) {
	for _, action := range []string{"logout", "password"} {
		t.Run(action, func(t *testing.T) {
			q, pool := requireOAuthTxnTestDB(t)
			userID := seedTxnTestUser(t, pool)
			h, _ := deviceTestHandler()
			account := NewAuthHandler(h.authSvc, q, nil)
			raw, err := h.authSvc.GenerateRefreshToken()
			if err != nil {
				t.Fatal(err)
			}
			browser := &models.RefreshToken{UserID: userID, Token: raw, ExpiresAt: time.Now().Add(time.Hour)}
			if err := q.CreateRefreshToken(context.Background(), browser); err != nil {
				t.Fatal(err)
			}
			if action == "password" {
				hash, err := h.authSvc.HashPassword("old-password-for-device-race")
				if err != nil {
					t.Fatal(err)
				}
				if err := q.UpdateUserPassword(context.Background(), userID, hash); err != nil {
					t.Fatal(err)
				}
			}
			h.sessions = &deviceExchangeStore{Queries: q, beforeCreate: func() {
				w := httptest.NewRecorder()
				if action == "logout" {
					r := httptest.NewRequest("POST", "https://aurora.example/api/auth/logout", nil)
					r.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: raw})
					account.Logout(w, r)
				} else {
					r := httptest.NewRequest("POST", "https://aurora.example/api/auth/change-password", strings.NewReader(
						`{"current_password":"old-password-for-device-race","new_password":"new-password-for-device-race"}`))
					r = r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, &auth.JWTClaims{UserID: userID}))
					account.ChangePassword(w, r)
				}
				if w.Code != http.StatusOK {
					t.Fatalf("revocation failed: %d %s", w.Code, w.Body)
				}
			}}
			secret, grant, _ := h.grants.start("TV")
			if !h.grants.authorize(grant.UserCode, userID, 0) {
				t.Fatal("authorize failed")
			}
			w := deviceRequest(h.Poll, "POST", "/api/auth/device/poll", fmt.Sprintf(`{"device_code":%q}`, secret), false)
			if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "expired_token") || len(w.Result().Cookies()) != 0 {
				t.Fatalf("revoked exchange issued a session: %d %s", w.Code, w.Body)
			}
			var active int
			if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM refresh_tokens WHERE user_id=$1 AND NOT revoked`, userID).Scan(&active); err != nil || active != 0 {
				t.Fatalf("renewable sessions=%d error=%v", active, err)
			}
		})
	}
}

func TestDevicePairing_RevocationAfterInsertCannotRenew(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	userID := seedTxnTestUser(t, pool)
	h, _ := deviceTestHandler()
	h.sessions = &deviceExchangeStore{Queries: q, afterCreate: func() {
		if _, err := q.RevokeAllUserSessions(context.Background(), userID); err != nil {
			t.Fatal(err)
		}
	}}
	secret, grant, _ := h.grants.start("TV")
	h.grants.authorize(grant.UserCode, userID, 0)
	w := deviceRequest(h.Poll, "POST", "/api/auth/device/poll", fmt.Sprintf(`{"device_code":%q}`, secret), false)
	if w.Code != http.StatusOK {
		t.Fatalf("exchange: %d %s", w.Code, w.Body)
	}
	account := NewAuthHandler(h.authSvc, q, nil)
	refreshRequest := httptest.NewRequest("POST", "https://aurora.example/api/auth/refresh", nil)
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == auth.RefreshCookieName {
			refreshRequest.AddCookie(cookie)
		}
	}
	refreshed := httptest.NewRecorder()
	account.Refresh(refreshed, refreshRequest)
	if refreshed.Code != http.StatusUnauthorized {
		t.Fatalf("revoked TV restored access: %d %s", refreshed.Code, refreshed.Body)
	}
}

func TestDevicePairing_RefreshCarriesActingProfileAndNewRole(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	userID := seedTxnTestUser(t, pool)
	h, _ := deviceTestHandler()
	h.sessions = q
	secret, grant, _ := h.grants.start("TV")
	h.grants.authorize(grant.UserCode, userID, 0)
	w := deviceRequest(h.Poll, "POST", "/api/auth/device/poll", fmt.Sprintf(`{"device_code":%q}`, secret), false)
	if w.Code != http.StatusOK {
		t.Fatalf("exchange: %d %s", w.Code, w.Body)
	}
	var refresh *http.Cookie
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == auth.RefreshCookieName {
			refresh = cookie
		}
	}
	if refresh == nil {
		t.Fatal("missing session")
	}
	rt, err := q.GetRefreshToken(context.Background(), refresh.Value)
	if err != nil || rt == nil {
		t.Fatalf("stored session: %v", err)
	}
	profile, err := q.CreateDefaultProfileForUser(context.Background(), userID, "Viewer")
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := q.SetActiveProfileForToken(context.Background(), rt.ID, userID, profile.ID); err != nil || !ok {
		t.Fatalf("activate: %v %v", ok, err)
	}
	// Role changes invalidate access tokens but deliberately preserve refresh
	// sessions. Version-checked issuance must continue that existing behavior.
	if _, err := pool.Exec(context.Background(), `UPDATE users SET role='admin', token_version=token_version+1 WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "https://aurora.example/api/auth/refresh", nil)
	request.AddCookie(refresh)
	refreshed := httptest.NewRecorder()
	NewAuthHandler(h.authSvc, q, nil).Refresh(refreshed, request)
	if refreshed.Code != http.StatusOK {
		t.Fatalf("refresh: %d %s", refreshed.Code, refreshed.Body)
	}
	for _, cookie := range refreshed.Result().Cookies() {
		if cookie.Name == auth.AccessCookieName {
			claims, err := h.authSvc.ValidateAccessToken(cookie.Value)
			if err != nil || claims.TokenVersion != 1 || claims.Role != "admin" {
				t.Fatalf("stale refreshed identity: %+v %v", claims, err)
			}
		}
		if cookie.Name == auth.RefreshCookieName {
			current, err := q.GetRefreshToken(context.Background(), cookie.Value)
			if err != nil || current == nil || current.ActiveProfileID == nil || *current.ActiveProfileID != profile.ID {
				t.Fatalf("lost acting profile: %+v %v", current, err)
			}
		}
	}
}
