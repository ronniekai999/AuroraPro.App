package websocket

// Centralized WebSocket event type constants.
// All packages that broadcast events should use these instead of raw string literals
// to prevent typos and enable grep-ability.
const (
	EventScanProgress      = "scan_progress"
	EventNowPlaying        = "now_playing"
	EventNowPlayingStopped = "now_playing_stopped"
	EventServerHealth      = "server_health"
	EventLibraryUpdate     = "library_update"
	EventProgressSync      = "progress_sync"
	EventTranscodeStatus   = "transcode_status"

	// Requests feature
	EventRequestStatus   = "request_status"
	EventRequestProgress = "request_progress"

	// Per-user in-app notification (bell + Notifications panel). Carries a
	// persisted notification row's id so the client can render it and mark it
	// read; see internal/db/queries_notifications.go.
	EventNotification = "notification"

	// Watch Party feature
	EventPartyInvite = "party_invite"
	EventPartyUpdate = "party_update"

	// EventDiscoverReady signals that a profile's LLM-curated Discover rails
	// finished building (cold-cache path). Carries {profile_id} so the client
	// re-fetches /api/me/discover and splices the rails in without a page
	// refresh. Pushed per-user via BroadcastToUser.
	EventDiscoverReady = "discover_ready"
)
