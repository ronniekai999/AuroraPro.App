// Package push delivers Web Push notifications: VAPID key provisioning,
// the cross-platform payload envelope, and the fan-out sender. It is the
// transport half of the notification pipeline — internal/notify decides who
// hears about what; this package only carries it to closed tabs.
package push

import (
	"context"
	"encoding/json"
	"fmt"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// VAPIDSettingKey is the server_settings row holding the keypair. The
// `_secret` suffix is load-bearing: isSecretSettingKey masks it in the admin
// listing, and it is deliberately absent from allowedKeys so the admin API
// cannot overwrite it (do/pwa-push/IMPLEMENTATION.md D6). Rotation = delete
// the row and restart; devices re-subscribe on next app boot.
const VAPIDSettingKey = "push_vapid_secret"

// vapidPair is stored as ONE JSON value so the public/private halves can
// never be torn by concurrent writers — the reason this is a single row
// rather than two.
type vapidPair struct {
	Public  string `json:"public"`
	Private string `json:"private"`
}

// settingsStore is the slice of the query layer VAPID provisioning needs.
type settingsStore interface {
	GetSetting(ctx context.Context, key string) (string, error)
	InsertSettingIfAbsent(ctx context.Context, key, value string) error
}

// ensureVAPIDKeys returns the server's keypair, generating and persisting it
// on first use. Concurrency-safe by construction: the write is
// insert-if-absent followed by a re-read, so two racing first-users both end
// up holding whichever single pair won the insert. Zero operator setup.
func ensureVAPIDKeys(ctx context.Context, store settingsStore) (vapidPair, error) {
	read := func() (vapidPair, bool, error) {
		raw, err := store.GetSetting(ctx, VAPIDSettingKey)
		if err != nil {
			return vapidPair{}, false, err
		}
		if raw == "" {
			return vapidPair{}, false, nil
		}
		var p vapidPair
		if err := json.Unmarshal([]byte(raw), &p); err != nil || p.Public == "" || p.Private == "" {
			return vapidPair{}, false, fmt.Errorf("stored %s is malformed — delete the row to re-provision: %v", VAPIDSettingKey, err)
		}
		return p, true, nil
	}

	if p, ok, err := read(); err != nil || ok {
		return p, err
	}

	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return vapidPair{}, fmt.Errorf("generating VAPID keys: %w", err)
	}
	blob, err := json.Marshal(vapidPair{Public: pub, Private: priv})
	if err != nil {
		return vapidPair{}, err
	}
	if err := store.InsertSettingIfAbsent(ctx, VAPIDSettingKey, string(blob)); err != nil {
		return vapidPair{}, fmt.Errorf("persisting VAPID keys: %w", err)
	}

	// Re-read rather than trust our own value: if we lost the insert race,
	// the winner's pair is the server's identity and ours is garbage.
	p, ok, err := read()
	if err != nil {
		return vapidPair{}, err
	}
	if !ok {
		return vapidPair{}, fmt.Errorf("%s missing immediately after insert", VAPIDSettingKey)
	}
	return p, nil
}
