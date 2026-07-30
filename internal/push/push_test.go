package push

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// fakeStore implements Store in memory. Its InsertSettingIfAbsent has the
// real query's semantics (first writer wins), which is the property the
// VAPID convergence test exists to exercise.
type fakeStore struct {
	mu       sync.Mutex
	settings map[string]string
	subs     []*models.PushSubscription
	deleted  []string
	stamped  []string
}

func newFakeStore() *fakeStore {
	return &fakeStore{settings: map[string]string{}}
}

func (f *fakeStore) GetSetting(_ context.Context, key string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.settings[key], nil
}

func (f *fakeStore) InsertSettingIfAbsent(_ context.Context, key, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, exists := f.settings[key]; !exists {
		f.settings[key] = value
	}
	return nil
}

func (f *fakeStore) ListPushSubscriptionsForUser(_ context.Context, userID int64) ([]*models.PushSubscription, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*models.PushSubscription
	for _, s := range f.subs {
		if s.UserID == userID {
			out = append(out, s)
		}
	}
	return out, nil
}

func (f *fakeStore) DeletePushSubscriptionByEndpoint(_ context.Context, endpoint string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, endpoint)
	return nil
}

func (f *fakeStore) StampPushSuccess(_ context.Context, endpoint string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stamped = append(f.stamped, endpoint)
	return nil
}

func TestEnsureVAPIDKeysGeneratesOnceAndConverges(t *testing.T) {
	store := newFakeStore()

	// Two "racing" first-users, sequentially exercising the
	// insert-if-absent + re-read protocol against shared state. (True
	// goroutine racing is nondeterministic; what matters is that a caller
	// who LOSES the insert still returns the winner's pair.)
	a, err := ensureVAPIDKeys(context.Background(), store)
	if err != nil {
		t.Fatalf("first ensure: %v", err)
	}
	b, err := ensureVAPIDKeys(context.Background(), store)
	if err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	if a != b {
		t.Errorf("two ensures returned different pairs — the identity must be stable: %+v vs %+v", a, b)
	}
	if a.Public == "" || a.Private == "" {
		t.Errorf("generated pair has empty halves: %+v", a)
	}
}

func TestEnsureVAPIDKeysLosingRacerAdoptsWinner(t *testing.T) {
	store := newFakeStore()
	// Seed the "winner": a pair some other process persisted between our
	// read-miss and our insert. insert-if-absent must leave it untouched
	// and the re-read must hand it back.
	winner := `{"public":"winner-pub","private":"winner-priv"}`
	if err := store.InsertSettingIfAbsent(context.Background(), VAPIDSettingKey, winner); err != nil {
		t.Fatal(err)
	}
	got, err := ensureVAPIDKeys(context.Background(), store)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if got.Public != "winner-pub" || got.Private != "winner-priv" {
		t.Errorf("loser must adopt the winner's pair, got %+v", got)
	}
}

func TestEnsureVAPIDKeysRejectsMalformedRow(t *testing.T) {
	store := newFakeStore()
	store.settings[VAPIDSettingKey] = "not json"
	if _, err := ensureVAPIDKeys(context.Background(), store); err == nil {
		t.Error("a malformed stored pair must error (with re-provision guidance), not silently regenerate — regenerating would orphan every existing subscription")
	}
}

func TestEnvelopeShape(t *testing.T) {
	reqID := int64(7)
	n := &models.Notification{
		ID:        123,
		UserID:    1,
		Type:      models.NotificationRequestAvailable,
		Title:     "Dune: Part Two",
		MediaType: "movie",
		RequestID: &reqID,
	}
	raw, err := Envelope(n, 3)
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		WebPush      int `json:"web_push"`
		Notification struct {
			Title    string `json:"title"`
			Body     string `json:"body"`
			Navigate string `json:"navigate"`
			AppBadge int    `json:"app_badge"`
		} `json:"notification"`
		Aurora struct {
			Type           string `json:"type"`
			NotificationID int64  `json:"notification_id"`
			Link           string `json:"link"`
		} `json:"aurora"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	// 8030 is the declarative-web-push magic number (RFC 8030 nod) — iOS
	// keys on it; without it the payload silently falls back to SW-only.
	if env.WebPush != 8030 {
		t.Errorf("web_push = %d, want 8030", env.WebPush)
	}
	if env.Notification.Title != "Dune: Part Two" {
		t.Errorf("title = %q", env.Notification.Title)
	}
	if env.Notification.Body == "" {
		t.Error("body must carry the per-type copy — iOS renders it with no client code involved")
	}
	if env.Notification.Navigate != "/v2/" {
		t.Errorf("navigate = %q, want /v2/ fallback when the notification has no link", env.Notification.Navigate)
	}
	if env.Notification.AppBadge != 3 {
		t.Errorf("app_badge = %d, want the unread count", env.Notification.AppBadge)
	}
	if env.Aurora.NotificationID != 123 || env.Aurora.Type != models.NotificationRequestAvailable {
		t.Errorf("aurora member mangled: %+v", env.Aurora)
	}
}

func TestEnvelopeUsesLinkAndRefusesOffOrigin(t *testing.T) {
	mk := func(link string) string {
		raw, err := Envelope(&models.Notification{Type: models.NotificationPartyReelReady, Title: "T", Link: link}, 0)
		if err != nil {
			t.Fatal(err)
		}
		var env struct {
			Notification struct {
				Navigate string `json:"navigate"`
			} `json:"notification"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		return env.Notification.Navigate
	}
	if got := mk("/api/parties/AB/highlight.mp4?session=9"); got != "/api/parties/AB/highlight.mp4?session=9" {
		t.Errorf("same-origin /api link must pass through, got %q", got)
	}
	// The link column is free text; the same refusals safeNotifLink makes
	// client-side must hold here, where iOS will navigate with no client
	// code in the loop.
	for _, hostile := range []string{"https://evil.example/", "//evil.example/x", "javascript:alert(1)"} {
		if got := mk(hostile); got != "/v2/" {
			t.Errorf("hostile link %q must fall back to /v2/, got %q", hostile, got)
		}
	}
}

// scriptedTransport implements webpush.HTTPClient: records requests, returns
// scripted status codes per endpoint host. When `gate` is non-nil, every Do
// BLOCKS on it until the test releases — that hold-open is what makes the
// concurrency assertion bind (an instant transport never observably exceeds
// the limit, bounded or not; the review proved the ungated version passed
// 50/50 runs with the SetLimit removed).
type scriptedTransport struct {
	mu       sync.Mutex
	requests []*http.Request
	status   map[string]int // endpoint host → status
	maxInUse int
	inUse    int
	gate     chan struct{} // nil → don't block
}

func (s *scriptedTransport) Do(req *http.Request) (*http.Response, error) {
	s.mu.Lock()
	s.inUse++
	if s.inUse > s.maxInUse {
		s.maxInUse = s.inUse
	}
	s.requests = append(s.requests, req)
	code := s.status[req.URL.Host]
	gate := s.gate
	s.mu.Unlock()
	if gate != nil {
		<-gate
	}
	defer func() { s.mu.Lock(); s.inUse--; s.mu.Unlock() }()
	if code == 0 {
		code = 201
	}
	return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(""))}, nil
}

func (s *scriptedTransport) snapshot() (inUse, maxInUse, total int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.inUse, s.maxInUse, len(s.requests)
}

func seedSubs(store *fakeStore, userID int64, hosts ...string) {
	for _, h := range hosts {
		store.subs = append(store.subs, &models.PushSubscription{
			UserID:   userID,
			Endpoint: "https://" + h + "/send/abc",
			// Real, valid P-256 point + auth secret (generated once with the
			// browser's own subscribe()) — webpush-go must be able to derive
			// a shared secret or SendNotification errors before any HTTP.
			P256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
			Auth:   "tBHItJI5svbpez7KI4CCXg",
		})
	}
}

func TestSenderDeletesDeadSubscriptionsAndStampsLiveOnes(t *testing.T) {
	store := newFakeStore()
	seedSubs(store, 1, "alive.example", "gone.example")
	tr := &scriptedTransport{status: map[string]int{"gone.example": http.StatusGone}}
	s := NewSender(store, tr)

	s.SendToUser(context.Background(), 1, []byte(`{"t":1}`))

	if len(store.deleted) != 1 || !strings.Contains(store.deleted[0], "gone.example") {
		t.Errorf("410 endpoint must be deleted, deleted=%v", store.deleted)
	}
	if len(store.stamped) != 1 || !strings.Contains(store.stamped[0], "alive.example") {
		t.Errorf("2xx endpoint must be stamped, stamped=%v", store.stamped)
	}
}

func TestSenderSetsTTLAndUrgency(t *testing.T) {
	store := newFakeStore()
	seedSubs(store, 1, "svc.example")
	tr := &scriptedTransport{}
	NewSender(store, tr).SendToUser(context.Background(), 1, []byte(`x`))

	if len(tr.requests) != 1 {
		t.Fatalf("want 1 request, got %d", len(tr.requests))
	}
	r := tr.requests[0]
	if got := r.Header.Get("TTL"); got != "86400" {
		t.Errorf("TTL header = %q, want 86400", got)
	}
	if got := r.Header.Get("Urgency"); got != "normal" {
		t.Errorf("Urgency header = %q, want normal", got)
	}
	if auth := r.Header.Get("Authorization"); !strings.Contains(auth, "vapid") && !strings.Contains(auth, "WebPush") {
		t.Errorf("Authorization header missing VAPID credential: %q", auth)
	}
}

func TestSenderDisabledSwitchShortCircuits(t *testing.T) {
	store := newFakeStore()
	store.settings[EnabledSettingKey] = "false"
	seedSubs(store, 1, "svc.example")
	tr := &scriptedTransport{}
	NewSender(store, tr).SendToUser(context.Background(), 1, []byte(`x`))
	if len(tr.requests) != 0 {
		t.Errorf("disabled switch must stop all sends, got %d requests", len(tr.requests))
	}
	// Anything except an explicit "false" is enabled — absent row included.
	store.settings[EnabledSettingKey] = ""
	if !NewSender(store, tr).Enabled(context.Background()) {
		t.Error("absent/empty switch must mean enabled")
	}
}

func TestSenderBoundsConcurrency(t *testing.T) {
	store := newFakeStore()
	hosts := make([]string, 12)
	for i := range hosts {
		hosts[i] = fmt.Sprintf("svc%d.example", i)
	}
	seedSubs(store, 1, hosts...)
	tr := &scriptedTransport{gate: make(chan struct{})}

	done := make(chan struct{})
	go func() {
		NewSender(store, tr).SendToUser(context.Background(), 1, []byte(`x`))
		close(done)
	}()

	// With the gate holding every send open, a bounded group parks at
	// exactly sendConcurrency in-flight; an unbounded one blows straight to
	// 12. Wait for the steady state, then give any over-limit sends a
	// moment to (incorrectly) join before reading the high-water mark.
	deadline := time.After(5 * time.Second)
	for {
		if in, _, _ := tr.snapshot(); in >= sendConcurrency {
			break
		}
		select {
		case <-deadline:
			t.Fatal("sends never reached the concurrency limit")
		case <-time.After(2 * time.Millisecond):
		}
	}
	time.Sleep(50 * time.Millisecond)
	if _, max, _ := tr.snapshot(); max != sendConcurrency {
		t.Errorf("high-water mark = %d concurrent sends, want exactly the bound %d", max, sendConcurrency)
	}

	close(tr.gate) // release everyone
	<-done
	if _, _, total := tr.snapshot(); total != 12 {
		t.Errorf("all 12 must be attempted, got %d", total)
	}
}
