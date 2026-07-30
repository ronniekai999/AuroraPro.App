// Package notify owns the persist → broadcast → push pipeline for per-user
// notifications (do/pwa-push/IMPLEMENTATION.md D7). Before it existed, the
// persist-then-broadcast dance was hand-rolled at each producer with
// inconsistent WS payloads; producers now call Notify and get all three
// legs, consistently, best-effort.
package notify

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	ws "github.com/aurora-media/aurora/internal/websocket"
)

// Store is the query-layer slice the dispatcher needs. *db.Queries satisfies it.
type Store interface {
	CreateNotification(ctx context.Context, n *models.Notification) (bool, error)
	CountUnreadNotifications(ctx context.Context, userID int64) (int, error)
	GetAdminUserIDs(ctx context.Context) ([]int64, error)
}

// Hub is the live-delivery leg. *websocket.Hub satisfies it.
type Hub interface {
	BroadcastToUser(userID int64, event string, payload interface{})
}

// PushSender is the closed-tab leg. *push.Sender satisfies it; nil disables
// push without touching the other legs.
type PushSender interface {
	SendToUser(ctx context.Context, userID int64, payload []byte)
}

// Envelope builds the push payload for a created notification. Injected so
// the dispatcher package doesn't import push (and tests can capture it);
// production wiring passes push.Envelope.
type Envelope func(n *models.Notification, unread int) ([]byte, error)

type Dispatcher struct {
	store    Store
	hub      Hub
	push     PushSender
	envelope Envelope
}

func NewDispatcher(store Store, hub Hub, sender PushSender, envelope Envelope) *Dispatcher {
	return &Dispatcher{store: store, hub: hub, push: sender, envelope: envelope}
}

// Notify persists n, then — only when a new row was actually created (the
// table dedupes request-linked rows) — broadcasts it over WS and fans out a
// push. Best-effort with the same detachment semantics the producers used
// inline (request_handlers.go:1437): the durable write has 5s on a
// cancellation-immune context, because the status transition that triggered
// us has already committed and a shutdown must not drop the only record an
// offline user will ever get.
func (d *Dispatcher) Notify(ctx context.Context, n *models.Notification) {
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()

	created, err := d.store.CreateNotification(writeCtx, n)
	if err != nil {
		slog.Error("notify: persisting notification failed",
			"type", n.Type, "user_id", n.UserID, "error", err)
		return
	}
	if !created {
		return // already notified for this (user, request, type) — don't re-deliver
	}

	if d.hub != nil {
		// One payload shape for every producer. Requests historically omitted
		// link and the reel omitted media_type/request_id; the frontend's
		// AppNotification has every field optional, so unifying is additive.
		d.hub.BroadcastToUser(n.UserID, ws.EventNotification, map[string]interface{}{
			"id":         n.ID,
			"type":       n.Type,
			"title":      n.Title,
			"media_type": n.MediaType,
			"request_id": n.RequestID,
			"link":       n.Link,
			"created_at": n.CreatedAt,
		})
	}

	if d.push == nil || d.envelope == nil {
		return
	}
	// Badge = unread count AFTER the insert; a count error degrades to 0
	// rather than losing the push.
	unread, err := d.store.CountUnreadNotifications(writeCtx, n.UserID)
	if err != nil {
		slog.Warn("notify: unread count for badge failed", "user_id", n.UserID, "error", err)
		unread = 0
	}
	payload, err := d.envelope(n, unread)
	if err != nil {
		slog.Error("notify: building push envelope failed", "type", n.Type, "error", err)
		return
	}
	d.push.SendToUser(writeCtx, n.UserID, payload)
}

// AdminNewRequest tells every admin (except the requester, when the
// requester is an admin) that a media request was created. The table's
// (user_id, request_id, type) dedupe yields exactly one row per admin per
// request no matter how often this fires.
func (d *Dispatcher) AdminNewRequest(ctx context.Context, req *models.Request, requesterID int64) {
	readCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	admins, err := d.store.GetAdminUserIDs(readCtx)
	if err != nil {
		slog.Error("notify: listing admins failed", "error", err)
		return
	}
	reqID := req.ID
	for _, adminID := range admins {
		if adminID == requesterID {
			continue // you don't need a bell for your own request
		}
		d.Notify(ctx, &models.Notification{
			UserID:    adminID,
			Type:      models.NotificationAdminNewRequest,
			Title:     req.Title,
			MediaType: req.MediaType,
			RequestID: &reqID,
			Link:      "/v2/requests",
		})
	}
}

// ScanCompleted tells every admin a scan finished AND added items. The
// newFiles gate is load-bearing (D7): scan_complete rows carry no
// request_id, so the table gives them no dedupe — and the Watcher scans on
// a periodic timer, so an unconditional producer would notify every admin
// every cycle, forever. No-change scans stay silent.
func (d *Dispatcher) ScanCompleted(ctx context.Context, libraryName string, newFiles int) {
	if newFiles <= 0 {
		return
	}
	readCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	admins, err := d.store.GetAdminUserIDs(readCtx)
	if err != nil {
		slog.Error("notify: listing admins failed", "error", err)
		return
	}
	title := libraryName
	if title == "" {
		title = "Library"
	}
	for _, adminID := range admins {
		d.Notify(ctx, &models.Notification{
			UserID: adminID,
			Type:   models.NotificationScanComplete,
			Title:  scanTitle(title, newFiles),
			Link:   "/v2/",
		})
	}
}

func scanTitle(library string, newFiles int) string {
	if newFiles == 1 {
		return library + ": 1 new item"
	}
	return library + ": " + strconv.Itoa(newFiles) + " new items"
}
