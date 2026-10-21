package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/models"
)

type fakePushStore struct {
	mu       sync.Mutex
	upserted []*models.PushSubscription
	deleted  []struct {
		endpoint string
		userID   int64
	}
	subs   []*models.PushSubscription
	pruned bool
}

func (f *fakePushStore) UpsertPushSubscription(_ context.Context, s *models.PushSubscription) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.upserted = append(f.upserted, s)
	return nil
}

func (f *fakePushStore) DeletePushSubscriptionForUser(_ context.Context, endpoint string, userID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, struct {
		endpoint string
		userID   int64
	}{endpoint, userID})
	return nil
}

func (f *fakePushStore) ListPushSubscriptionsForUser(_ context.Context, userID int64) ([]*models.PushSubscription, error) {
	var out []*models.PushSubscription
	for _, s := range f.subs {
		if s.UserID == userID {
			out = append(out, s)
		}
	}
	return out, nil
}

func (f *fakePushStore) PruneStalePushSubscriptions(_ context.Context, _ time.Time) (int64, error) {
	f.pruned = true
	return 0, nil
}

func (f *fakePushStore) CountUnreadNotifications(_ context.Context, _ int64, _ bool) (int, error) {
	return 2, nil
}

type fakePushService struct {
	enabled bool
	key     string
	sent    []int64
}

func (f *fakePushService) Enabled(_ context.Context) bool { return f.enabled }
func (f *fakePushService) VAPIDPublicKey(_ context.Context) (string, error) {
	return f.key, nil
}
func (f *fakePushService) SendToUser(_ context.Context, userID int64, _ []byte) {
	f.sent = append(f.sent, userID)
}

func pushReq(method, body string, userID int64) *http.Request {
	r := httptest.NewRequest(method, "/api/me/push/x", strings.NewReader(body))
	claims := &auth.JWTClaims{UserID: userID, Username: "u", Role: "user"}
	return r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, claims))
}

func TestPushConfigDisabledDoesNotProvision(t *testing.T) {
	svc := &fakePushService{enabled: false, key: "should-not-appear"}
	h := NewPushHandler(&fakePushStore{}, svc)
	rec := httptest.NewRecorder()
	h.Config(rec, pushReq("GET", "", 1))
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"enabled":false`) || strings.Contains(body, "should-not-appear") {
		t.Errorf("disabled config must not expose a key: %s", body)
	}
}

func TestPushSubscribeUsesClaimsNotBody(t *testing.T) {
	store := &fakePushStore{}
	h := NewPushHandler(store, &fakePushService{enabled: true})
	rec := httptest.NewRecorder()
	// A body claiming user_id 999 must be ignored — identity comes from the
	// token. (The wire shape has no user field; this pins that adding one
	// later couldn't matter.)
	h.Subscribe(rec, pushReq("POST",
		`{"user_id":999,"endpoint":"https://push.example/send/abc","keys":{"p256dh":"BAbc-123","auth":"xY_z"}}`, 42))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if len(store.upserted) != 1 || store.upserted[0].UserID != 42 {
		t.Fatalf("subscription must belong to the authenticated user, got %+v", store.upserted)
	}
	if !store.pruned {
		t.Error("subscribe must run the opportunistic stale-row prune")
	}
}

func TestPushSubscribeValidation(t *testing.T) {
	for name, body := range map[string]string{
		"http endpoint":   `{"endpoint":"http://push.example/x","keys":{"p256dh":"a","auth":"b"}}`,
		"no endpoint":     `{"keys":{"p256dh":"a","auth":"b"}}`,
		"missing p256dh":  `{"endpoint":"https://push.example/x","keys":{"auth":"b"}}`,
		"missing auth":    `{"endpoint":"https://push.example/x","keys":{"p256dh":"a"}}`,
		"key with spaces": `{"endpoint":"https://push.example/x","keys":{"p256dh":"a b","auth":"c"}}`,
	} {
		store := &fakePushStore{}
		h := NewPushHandler(store, &fakePushService{enabled: true})
		rec := httptest.NewRecorder()
		h.Subscribe(rec, pushReq("POST", body, 1))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", name, rec.Code)
		}
		if len(store.upserted) != 0 {
			t.Errorf("%s: rejected input must not be stored", name)
		}
	}
}

func TestPushUnsubscribeIsOwnerScoped(t *testing.T) {
	store := &fakePushStore{}
	h := NewPushHandler(store, &fakePushService{enabled: true})
	rec := httptest.NewRecorder()
	h.Unsubscribe(rec, pushReq("DELETE", `{"endpoint":"https://push.example/send/abc"}`, 42))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d", rec.Code)
	}
	if len(store.deleted) != 1 || store.deleted[0].userID != 42 {
		t.Fatalf("delete must carry the caller's user id — that scoping is what stops cross-user unsubscribes: %+v", store.deleted)
	}
}

func TestPushTestCooldownAndDeviceCount(t *testing.T) {
	store := &fakePushStore{subs: []*models.PushSubscription{{UserID: 7, Endpoint: "https://a/x"}}}
	svc := &fakePushService{enabled: true}
	h := NewPushHandler(store, svc)
	now := time.Unix(1000, 0)
	h.now = func() time.Time { return now }

	rec := httptest.NewRecorder()
	h.Test(rec, pushReq("POST", "", 7))
	if rec.Code != 200 || len(svc.sent) != 1 {
		t.Fatalf("first test: status %d sent %v", rec.Code, svc.sent)
	}

	// Immediately again → throttled, nothing sent.
	rec = httptest.NewRecorder()
	h.Test(rec, pushReq("POST", "", 7))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second test within cooldown: status %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("429 must carry Retry-After")
	}
	if len(svc.sent) != 1 {
		t.Error("throttled test must not send")
	}

	// The cooldown is per-user, not global.
	store.subs = append(store.subs, &models.PushSubscription{UserID: 8, Endpoint: "https://b/x"})
	rec = httptest.NewRecorder()
	h.Test(rec, pushReq("POST", "", 8))
	if rec.Code != 200 {
		t.Errorf("another user must not inherit the cooldown: %d", rec.Code)
	}

	// After the window, the same user may test again.
	now = now.Add(testPushCooldown + time.Second)
	rec = httptest.NewRecorder()
	h.Test(rec, pushReq("POST", "", 7))
	if rec.Code != 200 {
		t.Errorf("post-cooldown test: status %d", rec.Code)
	}
}

func TestPushTestWithNoDevices(t *testing.T) {
	h := NewPushHandler(&fakePushStore{}, &fakePushService{enabled: true})
	rec := httptest.NewRecorder()
	h.Test(rec, pushReq("POST", "", 7))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("no devices: status %d, want 400 with guidance", rec.Code)
	}
}
