package notify

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

type fakeStore struct {
	mu        sync.Mutex
	created   []*models.Notification
	createRet bool // what CreateNotification reports (false = dedupe hit)
	createErr error
	unread    int
	admins    []int64
	adminsErr error
	nextID    int64
}

func (f *fakeStore) CreateNotification(_ context.Context, n *models.Notification) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return false, f.createErr
	}
	if f.createRet {
		f.nextID++
		n.ID = f.nextID
		f.created = append(f.created, n)
	}
	return f.createRet, nil
}

func (f *fakeStore) CountUnreadNotifications(_ context.Context, _ int64) (int, error) {
	return f.unread, nil
}

func (f *fakeStore) GetAdminUserIDs(_ context.Context) ([]int64, error) {
	return f.admins, f.adminsErr
}

type fakeHub struct {
	mu     sync.Mutex
	events []map[string]interface{}
	users  []int64
}

func (f *fakeHub) BroadcastToUser(userID int64, event string, payload interface{}) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.users = append(f.users, userID)
	if m, ok := payload.(map[string]interface{}); ok {
		f.events = append(f.events, m)
	}
}

type fakePush struct {
	mu       sync.Mutex
	users    []int64
	payloads [][]byte
}

func (f *fakePush) SendToUser(_ context.Context, userID int64, payload []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.users = append(f.users, userID)
	f.payloads = append(f.payloads, payload)
}

func passthroughEnvelope(n *models.Notification, unread int) ([]byte, error) {
	return []byte(n.Type), nil
}

func TestNotifyRunsAllThreeLegs(t *testing.T) {
	store := &fakeStore{createRet: true, unread: 4}
	hub := &fakeHub{}
	push := &fakePush{}
	d := NewDispatcher(store, hub, push, passthroughEnvelope)

	d.Notify(context.Background(), &models.Notification{UserID: 9, Type: "request_available", Title: "Hook"})

	if len(store.created) != 1 {
		t.Fatalf("persist leg: %d rows", len(store.created))
	}
	if len(hub.users) != 1 || hub.users[0] != 9 {
		t.Errorf("WS leg: users=%v", hub.users)
	}
	// The unified WS payload always carries link — the field requests
	// historically omitted (D7).
	if _, ok := hub.events[0]["link"]; !ok {
		t.Error("WS payload must include link for every producer")
	}
	if len(push.users) != 1 || push.users[0] != 9 || string(push.payloads[0]) != "request_available" {
		t.Errorf("push leg: users=%v payloads=%q", push.users, push.payloads)
	}
}

func TestNotifyDedupeSuppressesBroadcastAndPush(t *testing.T) {
	store := &fakeStore{createRet: false} // the table says: already notified
	hub := &fakeHub{}
	push := &fakePush{}
	NewDispatcher(store, hub, push, passthroughEnvelope).
		Notify(context.Background(), &models.Notification{UserID: 9, Type: "request_available"})

	if len(hub.users) != 0 || len(push.users) != 0 {
		t.Errorf("a dedupe hit must deliver nothing: ws=%v push=%v — re-pushing on every 5s monitor poll is the failure this guards", hub.users, push.users)
	}
}

func TestNotifyPersistErrorStopsPipeline(t *testing.T) {
	store := &fakeStore{createErr: errors.New("db down")}
	hub := &fakeHub{}
	push := &fakePush{}
	NewDispatcher(store, hub, push, passthroughEnvelope).
		Notify(context.Background(), &models.Notification{UserID: 9, Type: "x"})
	if len(hub.users) != 0 || len(push.users) != 0 {
		t.Error("no durable row → no live delivery; the row is the source of truth")
	}
}

func TestNotifyNilPushStillBroadcasts(t *testing.T) {
	store := &fakeStore{createRet: true}
	hub := &fakeHub{}
	d := NewDispatcher(store, hub, nil, nil)
	d.Notify(context.Background(), &models.Notification{UserID: 3, Type: "x"})
	if len(hub.users) != 1 {
		t.Error("push being unwired must not cost the WS leg")
	}
}

func TestAdminNewRequestExcludesTheRequester(t *testing.T) {
	store := &fakeStore{createRet: true, admins: []int64{1, 2, 3}}
	hub := &fakeHub{}
	push := &fakePush{}
	d := NewDispatcher(store, hub, push, passthroughEnvelope)

	d.AdminNewRequest(context.Background(), &models.Request{ID: 55, Title: "Dune", MediaType: "movie"}, 2)

	if len(store.created) != 2 {
		t.Fatalf("want 2 notifications (admin 2 is the requester), got %d", len(store.created))
	}
	for _, n := range store.created {
		if n.UserID == 2 {
			t.Error("the requester must not be notified about their own request")
		}
		if n.Type != models.NotificationAdminNewRequest {
			t.Errorf("type = %q", n.Type)
		}
		if n.RequestID == nil || *n.RequestID != 55 {
			t.Error("request_id must be set — it is the dedupe key that makes this idempotent")
		}
		if n.Link != "/v2/requests" {
			t.Errorf("link = %q, want the requests view", n.Link)
		}
	}
}

func TestScanCompletedGatesOnNewFiles(t *testing.T) {
	store := &fakeStore{createRet: true, admins: []int64{1, 2}}
	hub := &fakeHub{}
	d := NewDispatcher(store, hub, nil, nil)

	// The load-bearing gate (D7): scan_complete has NO table dedupe and the
	// watcher scans on a timer — zero-new-files runs must be silent or every
	// admin gets pinged every cycle forever.
	d.ScanCompleted(context.Background(), "Movies", 0)
	if len(store.created) != 0 {
		t.Fatal("a no-change scan must notify nobody")
	}

	d.ScanCompleted(context.Background(), "Movies", 3)
	if len(store.created) != 2 {
		t.Fatalf("want one notification per admin, got %d", len(store.created))
	}
	if store.created[0].Title != "Movies: 3 new items" {
		t.Errorf("title = %q", store.created[0].Title)
	}

	d.ScanCompleted(context.Background(), "Movies", 1)
	if got := store.created[len(store.created)-1].Title; got != "Movies: 1 new item" {
		t.Errorf("singular title = %q", got)
	}
}
