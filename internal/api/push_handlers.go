package api

import (
	"context"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/push"
)

// pushStore is the query-layer slice the handlers need — a narrow interface
// so tests use a fake and mutation testing can prove the owner-scoping
// binds (the referralStore pattern). *db.Queries satisfies it.
type pushStore interface {
	UpsertPushSubscription(ctx context.Context, s *models.PushSubscription) error
	DeletePushSubscriptionForUser(ctx context.Context, endpoint string, userID int64) error
	ListPushSubscriptionsForUser(ctx context.Context, userID int64) ([]*models.PushSubscription, error)
	PruneStalePushSubscriptions(ctx context.Context, cutoff time.Time) (int64, error)
	CountUnreadNotifications(ctx context.Context, userID int64, adminAlerts bool) (int, error)
}

// pushService is the sender surface the handlers need. *push.Sender
// satisfies it.
type pushService interface {
	Enabled(ctx context.Context) bool
	VAPIDPublicKey(ctx context.Context) (string, error)
	SendToUser(ctx context.Context, userID int64, payload []byte)
}

// Subscriptions older than this with no boot re-POST are pruned
// opportunistically on subscribe (D11): the device either hasn't opened
// Aurora in half a year or deleted the installed app (which kills the
// subscription without notifying anyone).
const pushPruneAfter = 180 * 24 * time.Hour

// testPushCooldown throttles the Settings "Send test notification" button
// per user, so it can't be leaned on as a push-service spam lever.
const testPushCooldown = 10 * time.Second

type PushHandler struct {
	store pushStore
	svc   pushService

	mu       sync.Mutex
	lastTest map[int64]time.Time
	now      func() time.Time // injectable for the cooldown test
}

func NewPushHandler(store pushStore, svc pushService) *PushHandler {
	return &PushHandler{
		store:    store,
		svc:      svc,
		lastTest: make(map[int64]time.Time),
		now:      time.Now,
	}
}

// Config reports whether push is available and the key a client needs to
// subscribe. Provisions the VAPID pair lazily on first call (D6) — but not
// while the operator switch is off: a disabled feature should not mint keys.
// GET /api/me/push/config
func (h *PushHandler) Config(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if !h.svc.Enabled(r.Context()) {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "vapid_public_key": ""})
		return
	}
	key, err := h.svc.VAPIDPublicKey(r.Context())
	if err != nil {
		slog.Error("push: VAPID provisioning failed", "error", err)
		writeError(w, http.StatusInternalServerError, "push configuration unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "vapid_public_key": key})
}

// pushSubscriptionWire is the browser's PushSubscription.toJSON() shape —
// the frontend POSTs it verbatim.
type pushSubscriptionWire struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

// base64-ish (both alphabets, optional padding) — the browser emits
// unpadded base64url; be liberal in what we store, it goes back out verbatim.
var pushKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_\-+/=]+$`)

func validPushKey(s string, max int) bool {
	return s != "" && len(s) <= max && pushKeyPattern.MatchString(s)
}

// Subscribe upserts the caller's push subscription. The endpoint-conflict
// reassignment (D11) means a shared device always belongs to whoever
// enabled push most recently. 204.
// POST /api/me/push/subscriptions
func (h *PushHandler) Subscribe(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var wire pushSubscriptionWire
	if err := decodeJSON(w, r, &wire); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	u, err := url.Parse(wire.Endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || len(wire.Endpoint) > 2048 {
		writeError(w, http.StatusBadRequest, "endpoint must be an https push-service URL")
		return
	}
	if !validPushKey(wire.Keys.P256dh, 256) || !validPushKey(wire.Keys.Auth, 128) {
		writeError(w, http.StatusBadRequest, "keys.p256dh and keys.auth are required")
		return
	}

	ua := r.UserAgent()
	if len(ua) > 400 {
		ua = ua[:400]
	}
	if err := h.store.UpsertPushSubscription(r.Context(), &models.PushSubscription{
		UserID:    claims.UserID,
		Endpoint:  wire.Endpoint,
		P256dh:    wire.Keys.P256dh,
		Auth:      wire.Keys.Auth,
		UserAgent: ua,
	}); err != nil {
		slog.Error("push: subscription upsert failed", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save subscription")
		return
	}

	// Opportunistic hygiene, detached from this request's outcome.
	if n, err := h.store.PruneStalePushSubscriptions(r.Context(), h.now().Add(-pushPruneAfter)); err == nil && n > 0 {
		slog.Info("push: pruned stale subscriptions", "count", n)
	}

	w.WriteHeader(http.StatusNoContent)
}

// Unsubscribe removes the caller's subscription for one endpoint. Owner-
// scoped: someone else's endpoint is silently a no-op, not information.
// DELETE /api/me/push/subscriptions
func (h *PushHandler) Unsubscribe(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var body struct {
		Endpoint string `json:"endpoint"`
	}
	if err := decodeJSON(w, r, &body); err != nil || body.Endpoint == "" {
		writeError(w, http.StatusBadRequest, "endpoint is required")
		return
	}
	if err := h.store.DeletePushSubscriptionForUser(r.Context(), body.Endpoint, claims.UserID); err != nil {
		slog.Error("push: unsubscribe failed", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to remove subscription")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Test sends a real push to every device the caller has enabled — the
// Settings button that answers "is this actually working?". Cooldown per
// user (429 + Retry-After) so it can't be a spam lever.
// POST /api/me/push/test
func (h *PushHandler) Test(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if !h.svc.Enabled(r.Context()) {
		writeError(w, http.StatusConflict, "push is disabled by the server operator")
		return
	}

	h.mu.Lock()
	last, seen := h.lastTest[claims.UserID]
	now := h.now()
	if seen && now.Sub(last) < testPushCooldown {
		h.mu.Unlock()
		w.Header().Set("Retry-After", strconv.Itoa(int((testPushCooldown-now.Sub(last)).Seconds())+1))
		writeError(w, http.StatusTooManyRequests, "a test was just sent — try again in a few seconds")
		return
	}
	h.lastTest[claims.UserID] = now
	h.mu.Unlock()

	subs, err := h.store.ListPushSubscriptionsForUser(r.Context(), claims.UserID)
	if err != nil {
		slog.Error("push: listing subscriptions failed", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to load subscriptions")
		return
	}
	if len(subs) == 0 {
		writeError(w, http.StatusBadRequest, "this account has no push-enabled devices yet")
		return
	}

	// The test goes to every device on the account, so its badge counts every
	// unread row, as the dispatcher's does (notify.Dispatcher.Notify).
	unread, err := h.store.CountUnreadNotifications(r.Context(), claims.UserID, true)
	if err != nil {
		unread = 0
	}
	payload, err := push.Envelope(&models.Notification{
		UserID: claims.UserID,
		Type:   push.NotificationTest,
		Title:  "Aurora",
		Link:   "/v2/",
	}, unread)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to build test notification")
		return
	}
	h.svc.SendToUser(r.Context(), claims.UserID, payload)

	writeJSON(w, http.StatusOK, map[string]any{"status": "sent", "devices": len(subs)})
}
