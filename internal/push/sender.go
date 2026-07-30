package push

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"golang.org/x/sync/errgroup"

	"github.com/aurora-media/aurora/internal/models"
)

// EnabledSettingKey is the operator kill switch (D10). Push necessarily
// transits Google/Apple/Mozilla push services (payloads E2E-encrypted per
// RFC 8291, but the fact of a notification transits them) — on self-hosted
// software that is the operator's call, so it's a first-class admin setting,
// hot-read on every send. Default: enabled (absent row = on).
const EnabledSettingKey = "push_enabled"

// subscriber is the VAPID `sub` claim — a contact a push service can use to
// reach whoever operates the sender. Aurora is self-hosted with no
// per-install contact to put here, so it points at the project.
const subscriber = "https://github.com/aurora-media/aurora"

// sendConcurrency bounds parallel deliveries per Notify call. A user has
// 1-3 devices and admins a handful; 4 keeps a burst of admin fan-outs from
// stampeding the box's egress while never queueing in practice.
const sendConcurrency = 4

// Store is the query-layer slice the sender needs. *db.Queries satisfies it.
type Store interface {
	settingsStore
	ListPushSubscriptionsForUser(ctx context.Context, userID int64) ([]*models.PushSubscription, error)
	DeletePushSubscriptionByEndpoint(ctx context.Context, endpoint string) error
	StampPushSuccess(ctx context.Context, endpoint string) error
}

// Sender fans a payload out to every push subscription a user holds.
// Best-effort throughout: push mirrors the durable feed the way the WS
// broadcast does — failures are logged, never propagated to whatever
// triggered the notification.
type Sender struct {
	store  Store
	client webpush.HTTPClient
}

// NewSender wires the sender. client nil → a default *http.Client with a
// 10s timeout; tests inject a fake to capture requests and script responses.
func NewSender(store Store, client webpush.HTTPClient) *Sender {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &Sender{store: store, client: client}
}

// Enabled reports the operator switch. Fails open on a read error only in
// the "row absent" sense — an explicit "false" is the only thing that
// disables push.
func (s *Sender) Enabled(ctx context.Context) bool {
	v, err := s.store.GetSetting(ctx, EnabledSettingKey)
	if err != nil {
		slog.Warn("push: reading enabled switch failed; treating as enabled", "error", err)
		return true
	}
	return v != "false"
}

// VAPIDPublicKey returns the server's public key, provisioning the pair on
// first use (D6).
func (s *Sender) VAPIDPublicKey(ctx context.Context) (string, error) {
	pair, err := ensureVAPIDKeys(ctx, s.store)
	if err != nil {
		return "", err
	}
	return pair.Public, nil
}

// SendToUser delivers one payload to every subscription the user holds.
// Respects the operator switch; deletes subscriptions the push service
// declares dead (404/410 — RFC 8030); stamps successes. Blocking (callers
// that need fire-and-forget already detach, e.g. the dispatcher's
// WithoutCancel+timeout context).
func (s *Sender) SendToUser(ctx context.Context, userID int64, payload []byte) {
	if !s.Enabled(ctx) {
		return
	}
	subs, err := s.store.ListPushSubscriptionsForUser(ctx, userID)
	if err != nil {
		slog.Error("push: listing subscriptions failed", "user_id", userID, "error", err)
		return
	}
	if len(subs) == 0 {
		return
	}
	pair, err := ensureVAPIDKeys(ctx, s.store)
	if err != nil {
		slog.Error("push: VAPID provisioning failed", "error", err)
		return
	}

	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(sendConcurrency)
	for _, sub := range subs {
		g.Go(func() error {
			s.sendOne(gctx, sub, payload, pair)
			return nil // best-effort: one dead endpoint must not cancel siblings
		})
	}
	_ = g.Wait()
}

func (s *Sender) sendOne(ctx context.Context, sub *models.PushSubscription, payload []byte, pair vapidPair) {
	resp, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys:     webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth},
	}, &webpush.Options{
		HTTPClient:      s.client,
		Subscriber:      subscriber,
		TTL:             86400, // a day: long enough to survive a phone's overnight doze
		Urgency:         webpush.UrgencyNormal,
		VAPIDPublicKey:  pair.Public,
		VAPIDPrivateKey: pair.Private,
	})
	if err != nil {
		slog.Warn("push: send failed", "endpoint_host", hostOf(sub.Endpoint), "error", err)
		return
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		// The push service says this subscription no longer exists (user
		// revoked permission, deleted the installed app, browser profile
		// gone). Standard hygiene: drop the row so we stop paying for it.
		if err := s.store.DeletePushSubscriptionByEndpoint(context.WithoutCancel(ctx), sub.Endpoint); err != nil {
			slog.Warn("push: pruning dead subscription failed", "error", err)
		}
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		if err := s.store.StampPushSuccess(ctx, sub.Endpoint); err != nil {
			slog.Warn("push: stamping success failed", "error", err)
		}
	default:
		slog.Warn("push: service rejected send", "status", resp.StatusCode, "endpoint_host", hostOf(sub.Endpoint))
	}
}

// hostOf trims an endpoint to its host for logs — endpoints embed per-device
// capability tokens that don't belong in log files.
func hostOf(endpoint string) string {
	if u, err := url.Parse(endpoint); err == nil {
		return u.Host
	}
	return "invalid"
}
