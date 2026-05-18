package api

import (
	"context"
	"log/slog"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

// ActivityLogger provides convenience methods for logging server events.
type ActivityLogger struct {
	queries *db.Queries
}

func NewActivityLogger(queries *db.Queries) *ActivityLogger {
	return &ActivityLogger{queries: queries}
}

func (a *ActivityLogger) log(ctx context.Context, entry *models.ActivityEntry) {
	if err := a.queries.InsertActivity(ctx, entry); err != nil {
		slog.Error("failed to log activity", "event", entry.EventType, "error", err)
	}
}

func (a *ActivityLogger) LogLogin(ctx context.Context, userID int64, ip string) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &userID,
		EventType: "user_login",
		IPAddress: ip,
	})
}

func (a *ActivityLogger) LogLogout(ctx context.Context, userID int64) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &userID,
		EventType: "user_logout",
	})
}

func (a *ActivityLogger) LogUserCreated(ctx context.Context, userID int64, username, ip string) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &userID,
		EventType: "user_created",
		IPAddress: ip,
		Details:   map[string]interface{}{"username": username},
	})
}

// LogUserDeleted records who deleted whom. Distinct from LogUserCreated so
// forensics can reconstruct admin actions on a compromised account. actorID
// is the admin performing the deletion; targetID is the user being deleted
// (kept in Details rather than UserID because the user row is gone after
// this fires and an FK lookup would fail).
func (a *ActivityLogger) LogUserDeleted(ctx context.Context, actorID, targetID int64, ip string) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &actorID,
		EventType: "user_deleted",
		IPAddress: ip,
		Details:   map[string]interface{}{"target_user_id": targetID},
	})
}

// LogImageCachePurged records the admin who wiped the image cache.
func (a *ActivityLogger) LogImageCachePurged(ctx context.Context, actorID int64, ip string, filesRemoved int64) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &actorID,
		EventType: "image_cache_purged",
		IPAddress: ip,
		Details:   map[string]interface{}{"files_removed": filesRemoved},
	})
}

func (a *ActivityLogger) LogScanStarted(ctx context.Context, libraryID int64, libraryName string) {
	a.log(ctx, &models.ActivityEntry{
		EventType: "scan_started",
		Details:   map[string]interface{}{"library_id": libraryID, "library_name": libraryName},
	})
}

func (a *ActivityLogger) LogScanCompleted(ctx context.Context, libraryID int64, libraryName string, filesFound int) {
	a.log(ctx, &models.ActivityEntry{
		EventType: "scan_completed",
		Details:   map[string]interface{}{"library_id": libraryID, "library_name": libraryName, "files_found": filesFound},
	})
}

func (a *ActivityLogger) LogStreamStarted(ctx context.Context, userID int64, mediaTitle, decision string) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &userID,
		EventType: "stream_started",
		Details:   map[string]interface{}{"media_title": mediaTitle, "decision": decision},
	})
}

func (a *ActivityLogger) LogStreamStopped(ctx context.Context, userID int64, mediaTitle string) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &userID,
		EventType: "stream_stopped",
		Details:   map[string]interface{}{"media_title": mediaTitle},
	})
}

func (a *ActivityLogger) LogLibraryCreated(ctx context.Context, userID int64, libraryName string) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &userID,
		EventType: "library_created",
		Details:   map[string]interface{}{"library_name": libraryName},
	})
}

func (a *ActivityLogger) LogLibraryDeleted(ctx context.Context, userID int64, libraryID int64) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &userID,
		EventType: "library_deleted",
		Details:   map[string]interface{}{"library_id": libraryID},
	})
}

func (a *ActivityLogger) LogSettingsChanged(ctx context.Context, userID int64, keys []string) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &userID,
		EventType: "settings_changed",
		Details:   map[string]interface{}{"keys": keys},
	})
}
