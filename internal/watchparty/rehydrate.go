package watchparty

// Scheduled-party durability (migration 051 invites).
//
// Two concerns live here, both born from the same fact: a scheduled party is
// a promise about the future, and promises must survive process restarts on
// a box whose auto-updater restarts the server on every merge to main.
//
//   1. RehydrateScheduledParties — at boot, reload every active, scheduled,
//      not-yet-started party row into the in-memory Manager and re-arm its
//      countdown timer, so invite deep links (/p/{code}) keep resolving and
//      the party still auto-starts on time. Without this, a restart between
//      "schedule" and "showtime" silently killed the party while the
//      invites, bell notifications, and calendar chips kept pointing at it.
//
//   2. The T-10 reminder — a bell ping to the host + non-declined invitees
//      shortly before a scheduled start. Reminder goroutines are armed
//      wherever the schedule timer is armed and cancelled with it.
//      They also re-validate against the party's CURRENT state at fire time
//      (rescheduled → target mismatch → silent no-op; ended → party gone →
//      no-op), with PartyState.reminderSentFor collapsing double-arms.

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// reminderLead is how long before a scheduled start the reminder fires.
// Mirrored in the composer's "reminder 10 minutes before showtime" copy —
// change both together.
const reminderLead = 10 * time.Minute

// armReminderLocked spawns the reminder goroutine for a scheduled start.
// Caller must hold ps.mu (same contract as startScheduleTimerLocked, its
// only call site). No-op when showtime is already inside the lead window —
// a just-sent invite is its own reminder. That same rule means a server
// restart landing INSIDE the lead window skips the reminder entirely
// (reminderSentFor is not persisted, so re-arming could double-send;
// skipping is the chosen trade-off — the countdown still fires on time).
func (m *Manager) armReminderLocked(ps *PartyState, scheduledStartAt time.Time) {
	delay := time.Until(scheduledStartAt.Add(-reminderLead))
	if delay <= 0 {
		return
	}
	code := ps.Code
	target := scheduledStartAt
	reminderCtx, cancel := context.WithCancel(context.Background())
	ps.reminderCancel = cancel
	go func() {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-timer.C:
			m.fireScheduledReminder(code, target)
		case <-reminderCtx.Done():
		}
	}()
}

// fireScheduledReminder is the reminder goroutine body. Validates that the
// party still exists, hasn't started or begun ending, and is still scheduled
// for the exact target this timer was armed with — a reschedule makes the
// stale goroutine a silent no-op while the newly armed one carries the new
// time. The reminderSentFor guard makes concurrent same-target arms send
// at most once.
func (m *Manager) fireScheduledReminder(code string, target time.Time) {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return
	}

	ps.mu.Lock()
	stale := ps.StartedAt != nil || ps.ending ||
		ps.ScheduledStartAt == nil || !ps.ScheduledStartAt.Equal(target) ||
		(ps.reminderSentFor != nil && ps.reminderSentFor.Equal(target))
	if !stale {
		t := target
		ps.reminderSentFor = &t
	}
	dbID := ps.dbID
	hostUserID := ps.HostUserID
	mediaTitle := ps.MediaTitle
	ps.mu.Unlock()
	if stale {
		return
	}

	// Read the dispatcher under m.mu like notifyReelReady does —
	// SetDispatcher writes it under the same lock, and this goroutine may
	// outlive boot wiring by hours.
	m.mu.RLock()
	dispatcher := m.dispatcher
	m.mu.RUnlock()
	if dispatcher == nil || dbID <= 0 {
		return
	}

	// Fresh context: the arming request is hours gone. The dispatcher adds
	// its own WithoutCancel + timeout per notification; this bounds the
	// invitee query.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	recipients, err := m.queries.ListInviteeUserIDsForReminder(ctx, dbID)
	if err != nil {
		slog.Warn("party reminder: invitee query failed; reminding host only", "code", code, "error", err)
		recipients = nil
	}
	recipients = append(recipients, hostUserID)

	for _, userID := range recipients {
		dispatcher.Notify(ctx, &models.Notification{
			UserID: userID,
			Type:   models.NotificationPartyReminder,
			Title:  mediaTitle,
			Link:   "/p/" + code,
		})
	}
	slog.Info("party reminder sent", "code", code, "recipients", len(recipients))
}

// RehydrateScheduledParties reloads active, scheduled, not-yet-started
// parties from Postgres into the Manager and re-arms their countdown (and
// reminder) timers. Call once at boot, after SetDispatcher, before the
// HTTP listener starts taking joins.
//
// Parties whose scheduled time passed during downtime are re-armed too —
// their timer fires immediately, taking the party live so invite links keep
// working (guests just find it already started, same as joining late).
//
// Returns the number of parties restored. Failures are logged and skipped
// row-by-row; one corrupt row must not strand every other scheduled party.
func (m *Manager) RehydrateScheduledParties(ctx context.Context) int {
	if m.queries == nil {
		return 0
	}
	rows, persistent, err := m.queries.ListScheduledUnstartedParties(ctx)
	if err != nil {
		slog.Error("rehydrate scheduled parties: query failed", "error", err)
		return 0
	}

	restored := 0
	for i, row := range rows {
		if row.ScheduledStartAt == nil {
			continue // defensive; the query filters on NOT NULL
		}

		// Settings round-trip from the row; defaults on unmarshal failure
		// mirror CreateParty's defaults rather than zero-values (a corrupt
		// settings blob shouldn't produce a no-chat, no-pause party).
		settings := PartySettings{AllowPause: true, AllowChat: true}
		if err := json.Unmarshal([]byte(row.SettingsJSON), &settings); err != nil {
			slog.Warn("rehydrate: settings unmarshal failed; using defaults", "code", row.PartyCode, "error", err)
		}
		settings.MaxParticipants = row.MaxParticipants

		now := time.Now()
		ps := &PartyState{
			Code:             row.PartyCode,
			HostUserID:       row.HostUserID,
			MediaItemID:      row.MediaItemID,
			EpisodeID:        row.EpisodeID,
			MediaTitle:       row.MediaTitle,
			MediaPoster:      row.MediaPoster,
			PartyName:        row.PartyName,
			StateRevision:    1,
			Participants:     make(map[int64]*Participant),
			ChatHistory:      make([]ChatMessage, 0, chatHistoryMax),
			Settings:         settings,
			CreatedAt:        row.CreatedAt,
			MaxParticipants:  row.MaxParticipants,
			dbID:             row.ID,
			IsRoomPersistent: persistent[i],

			// The pre-restart resume offset is gone with the process; a
			// scheduled party hasn't played yet, so anchoring at 0 matches
			// what CreateParty does for a fresh unwatched party.
			Running:        false,
			AnchorAbsMs:    0,
			AnchorServerAt: now,
			syncConns:      make(map[int64]*SafeConn),
			roomConns:      make(map[int64]*SafeConn),

			ScheduledStartAt: row.ScheduledStartAt,
			StartedAt:        nil,
		}
		if row.RoomID != nil {
			ps.roomDBID = *row.RoomID
		}

		// Register guarding only against code collisions. Deliberately NO
		// one-party-per-host guard here (2026-08 review): CreateParty
		// enforces it, but StartPartyInRoom does not, so a host can
		// legitimately hold two scheduled parties before a restart —
		// skipping the second here would strand it as a permanent DB
		// zombie (active row, invites and calendars pointing at a code
		// the manager never serves again). Rehydration's job is to
		// restore reality as persisted, not to re-litigate creation
		// rules.
		m.mu.Lock()
		if _, exists := m.parties[ps.Code]; exists {
			m.mu.Unlock()
			slog.Warn("rehydrate: code already live; skipping row", "code", ps.Code)
			continue
		}
		m.parties[ps.Code] = ps
		m.mu.Unlock()

		ps.mu.Lock()
		m.startScheduleTimerLocked(ps, *row.ScheduledStartAt)
		ps.mu.Unlock()

		restored++
		slog.Info("rehydrated scheduled watch party",
			"code", ps.Code,
			"scheduled_start_at", row.ScheduledStartAt,
			"host_user_id", row.HostUserID,
			"media_title", row.MediaTitle,
		)
	}
	return restored
}
