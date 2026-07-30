package push

import (
	"encoding/json"
	"strings"

	"github.com/aurora-media/aurora/internal/models"
)

// Envelope builds the one payload every platform understands
// (do/pwa-push/IMPLEMENTATION.md D9):
//
//   - iOS/iPadOS ≥18.4 recognizes the "web_push": 8030 marker and renders
//     the "notification" member declaratively — no service worker wake.
//     `navigate` is the click target; `app_badge` sets the icon badge.
//   - Chrome/Firefox/older Safari don't know the marker; the payload reaches
//     the SW `push` handler, which reads the same object (sw.js mirrors the
//     field names here) and calls showNotification itself.
//
// The "aurora" member is ours: the SW uses notification_id for the
// collapse tag and link for click routing (links may be /api/... media URLs,
// which `navigate` also tolerates — same-origin, cookie-authenticated).
func Envelope(n *models.Notification, unread int) ([]byte, error) {
	nav := "/v2/"
	if strings.HasPrefix(n.Link, "/") && !strings.HasPrefix(n.Link, "//") {
		nav = n.Link
	}
	env := map[string]any{
		"web_push": 8030,
		"notification": map[string]any{
			"title":     n.Title,
			"body":      bodyFor(n.Type),
			"navigate":  nav,
			"app_badge": unread,
		},
		"aurora": map[string]any{
			"type":            n.Type,
			"notification_id": n.ID,
			"link":            nav,
		},
	}
	return json.Marshal(env)
}

// bodyFor is the secondary line under the title (which carries the specific
// thing — media title, library name). Copy lives server-side so iOS's
// declarative path — which runs none of our client code — shows the same
// words as everyone else.
func bodyFor(notifType string) string {
	switch notifType {
	case models.NotificationRequestAvailable:
		return "Your request is ready to watch."
	case models.NotificationRequestFailed:
		return "Your request could not be completed."
	case models.NotificationPartyReelReady:
		return "Your watch party highlight reel is ready."
	case models.NotificationAdminNewRequest:
		return "New media request awaiting review."
	case models.NotificationScanComplete:
		return "Library scan finished with new items."
	case NotificationTest:
		return "Push notifications are working on this device."
	default:
		return "Open Aurora to see what's new."
	}
}

// NotificationTest is the synthetic type the Settings "Send test
// notification" button uses. Never persisted to the notifications table —
// it exists only as a push payload.
const NotificationTest = "push_test"
