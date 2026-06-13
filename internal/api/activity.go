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

// LogLoginFailed records a failed authentication attempt. No UserID is set —
// the attempt may target a non-existent user, or we intentionally avoid
// confirming the account exists — so the attempted username lives in Details
// alongside the source IP for brute-force/credential-stuffing forensics.
func (a *ActivityLogger) LogLoginFailed(ctx context.Context, username, ip string) {
	a.log(ctx, &models.ActivityEntry{
		EventType: "login_failed",
		IPAddress: ip,
		Details:   map[string]interface{}{"username": username},
	})
}

// LogPasswordChangeFailed records a failed change-password attempt (wrong
// current password) so operators can spot an attacker probing a hijacked
// session. The acting user is known here (the request is authenticated), so
// it is attributed via UserID.
func (a *ActivityLogger) LogPasswordChangeFailed(ctx context.Context, userID int64, ip string) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &userID,
		EventType: "password_change_failed",
		IPAddress: ip,
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

// LogUserRoleChanged records an admin promoting or demoting another user.
// actorID is the admin making the change; targetID + newRole capture who was
// changed and to what, so a privilege escalation (or self-lockout attempt) can
// be reconstructed forensically. Mirrors LogUserDeleted's actor/target shape.
func (a *ActivityLogger) LogUserRoleChanged(ctx context.Context, actorID, targetID int64, newRole, ip string) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &actorID,
		EventType: "user_role_changed",
		IPAddress: ip,
		Details:   map[string]interface{}{"target_user_id": targetID, "new_role": newRole},
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

// LogMediaDeleted records an admin removing a media item (show/movie) from the
// catalog via the manual "remove from library" action. The media row is gone
// after this fires, so the id/title live in Details rather than as an FK
// (mirrors LogUserDeleted / LogLibraryDeleted).
func (a *ActivityLogger) LogMediaDeleted(ctx context.Context, userID int64, mediaID int64, title string) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &userID,
		EventType: "media_deleted",
		Details:   map[string]interface{}{"media_id": mediaID, "title": title},
	})
}

func (a *ActivityLogger) LogSettingsChanged(ctx context.Context, userID int64, keys []string) {
	a.log(ctx, &models.ActivityEntry{
		UserID:    &userID,
		EventType: "settings_changed",
		Details:   map[string]interface{}{"keys": keys},
	})
}
