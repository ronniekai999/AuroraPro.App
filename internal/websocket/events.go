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

	// Watch Party feature
	EventPartyInvite = "party_invite"
	EventPartyUpdate = "party_update"
)
