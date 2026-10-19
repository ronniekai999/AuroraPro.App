package api

// Watch-party invites (migration 051): the member-to-member "send a watch
// party invite" flow — invite people you follow to a party that is live now
// or scheduled for later, RSVP from the bell, and read the lobby roster.
//
// Watch-party invitation contract:
//   * Sending is host-only and post-hoc by code, so it composes with BOTH
//     create paths (quick party + persistent-room start) without new create
//     shapes: the composer creates the party first, then posts invites.
//   * Delivery rides notify.Dispatcher (durable bell row + WS + web push).
//     Notification dedup = the party_invites unique index: we only notify
//     when the invite row was actually created.
//   * Invite rosters are member-visible: username/display/avatar only,
//     avatars through memberSafeAvatar, never email/role/auth fields.
//   * The invited title is checked against each invitee's DEFAULT
//     sub-profile parental ceiling at send time — an invite must not route
//     around a viewer's rating ceiling, and kids sub-profiles have no
//     account of their own, so they are structurally unreachable.

import (
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/notify"
	"github.com/aurora-media/aurora/internal/watchparty"
	"github.com/go-chi/chi/v5"
)

const (
	// maxInvitesPerSend caps one send batch. Generous for a homelab member
	// list while keeping the per-request fan-out (user lookups + ceiling
	// checks + notifications) bounded.
	maxInvitesPerSend = 20
	// maxInviteNoteLen caps the host's note. Matches the composer's
	// client-side limit.
	maxInviteNoteLen = 280
)

// PartyInviteHandler serves invite send/roster/RSVP plus the caller's
// upcoming-invites feed.
type PartyInviteHandler struct {
	manager    *watchparty.Manager
	queries    *db.Queries
	dispatcher *notify.Dispatcher
}

// NewPartyInviteHandler wires the handler. dispatcher may be nil in tests;
// notification fan-out is skipped (with a warn) when unwired.
func NewPartyInviteHandler(manager *watchparty.Manager, queries *db.Queries, dispatcher *notify.Dispatcher) *PartyInviteHandler {
	return &PartyInviteHandler{manager: manager, queries: queries, dispatcher: dispatcher}
}

// sendInvitesRequest is the JSON body for POST /api/parties/{code}/invites.
type sendInvitesRequest struct {
	Usernames []string `json:"usernames"`
	Note      string   `json:"note,omitempty"`
}

// skippedInvite explains one username the send left out. Reasons are stable
// strings the composer maps to copy: not_found | self | rating_restricted |
// already_invited.
type skippedInvite struct {
	Username string `json:"username"`
	Reason   string `json:"reason"`
}

// sentInvite is one successfully created invite in the send response.
type sentInvite struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
}

// SendInvites handles POST /api/parties/{code}/invites — host-only batch
// invite. Skips (rather than fails) per-username problems so one bad entry
// can't torpedo the batch; infrastructure errors still 500.
func (h *PartyInviteHandler) SendInvites(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}

	code := strings.ToUpper(chi.URLParam(r, "code"))
	if len(code) != 6 {
		writeError(w, http.StatusBadRequest, "invalid party code")
		return
	}

	var req sendInvitesRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Note) > maxInviteNoteLen {
		writeError(w, http.StatusBadRequest, "note too long (max 280 characters)")
		return
	}

	// Trim + dedupe (case-insensitive — usernames are unique modulo case)
	// before the cap check so "the same name pasted twice" doesn't burn
	// batch budget.
	seen := make(map[string]bool, len(req.Usernames))
	usernames := make([]string, 0, len(req.Usernames))
	for _, u := range req.Usernames {
		u = strings.TrimSpace(u)
		key := strings.ToLower(u)
		if u == "" || seen[key] {
			continue
		}
		seen[key] = true
		usernames = append(usernames, u)
	}
	if len(usernames) == 0 {
		writeError(w, http.StatusBadRequest, "usernames is required")
		return
	}
	if len(usernames) > maxInvitesPerSend {
		writeError(w, http.StatusBadRequest, "too many invitees (max 20 per send)")
		return
	}

	// The party must be live in the manager — an invite's whole job is to
	// produce a joinable /p/{code}, and joins resolve against live state.
	ps := h.manager.GetPartyState(code)
	if ps == nil {
		writeError(w, http.StatusNotFound, "party not found or has ended")
		return
	}
	ps.Lock()
	hostUserID := ps.HostUserID
	mediaItemID := ps.MediaItemID
	mediaTitle := ps.MediaTitle
	ps.Unlock()
	if hostUserID != claims.UserID {
		writeError(w, http.StatusForbidden, "only the host can send invites")
		return
	}

	// Durable ids + rating come from Postgres, not the manager: invites
	// outlive the in-memory state and the ceiling check needs the stored
	// content rating.
	party, err := h.queries.GetWatchPartyByCode(r.Context(), code)
	if err != nil {
		slog.Error("send invites: party row lookup failed", "code", code, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to send invites")
		return
	}
	if party == nil {
		// Ended between the manager check and here (endPartyInternal flips
		// the row before the map delete) — a 404, not a server fault.
		writeError(w, http.StatusNotFound, "party not found or has ended")
		return
	}
	item, err := h.queries.GetMediaItem(r.Context(), mediaItemID)
	if err != nil || item == nil {
		slog.Error("send invites: media lookup failed", "media_item_id", mediaItemID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to send invites")
		return
	}

	sent := []sentInvite{}
	skipped := []skippedInvite{}
	for _, username := range usernames {
		invitee, err := h.queries.GetUserByUsername(r.Context(), username)
		if err != nil {
			// Infra error ≠ "no such member" — a transient DB blip must not
			// tell the host their friend doesn't exist (2026-08 review).
			slog.Error("send invites: user lookup failed", "username", username, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to send invites")
			return
		}
		if invitee == nil {
			skipped = append(skipped, skippedInvite{Username: username, Reason: "not_found"})
			continue
		}
		if invitee.ID == claims.UserID {
			skipped = append(skipped, skippedInvite{Username: username, Reason: "self"})
			continue
		}

		// Parental ceiling: the invitee's DEFAULT sub-profile is the
		// account's ceiling (kids profiles never attribute to the account
		// — CLAUDE.md invariant). nil allowed-list = unrestricted. Under
		// any restriction an unrated title is excluded, matching the
		// content_rating = ANY() semantics every rail uses.
		prof, err := h.queries.GetDefaultProfile(r.Context(), invitee.ID)
		if err != nil {
			slog.Error("send invites: default profile lookup failed", "invitee", invitee.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to send invites")
			return
		}
		// prof == nil (no default profile row) means unrestricted — the Go
		// data migration guarantees one per user, so this is belt-and-
		// suspenders for freshly hand-inserted rows.
		maxRating := ""
		if prof != nil {
			maxRating = prof.MaxAgeRating
		}
		if allowed := db.AllowedRatingsForMax(maxRating); allowed != nil &&
			!slices.Contains(allowed, item.ContentRating) {
			skipped = append(skipped, skippedInvite{Username: invitee.Username, Reason: "rating_restricted"})
			continue
		}

		created, err := h.queries.CreatePartyInvite(r.Context(), party.ID, claims.UserID, invitee.ID, req.Note)
		if err != nil {
			slog.Error("send invites: insert failed", "party_id", party.ID, "invitee", invitee.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to send invites")
			return
		}
		if !created {
			skipped = append(skipped, skippedInvite{Username: invitee.Username, Reason: "already_invited"})
			continue
		}
		sent = append(sent, sentInvite{UserID: invitee.ID, Username: invitee.Username})

		// Notify only when the row was created — that's the dedup layer
		// (invite notifications carry no request_id, so the notifications
		// table's own dedup index doesn't apply).
		if h.dispatcher != nil {
			h.dispatcher.Notify(r.Context(), &models.Notification{
				UserID: invitee.ID,
				Type:   models.NotificationPartyInvite,
				Title:  claims.Username + " invited you — " + mediaTitle,
				Link:   "/p/" + code,
			})
		} else {
			slog.Warn("send invites: no dispatcher wired; invite created without notification", "code", code)
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"sent":    sent,
		"skipped": skipped,
	})
}

// Roster handles GET /api/parties/{code}/invites — the lobby's "who's
// coming" list. Visible to the host, current participants, and invitees;
// avatars pass memberSafeAvatar like every member-visible surface.
func (h *PartyInviteHandler) Roster(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}

	code := strings.ToUpper(chi.URLParam(r, "code"))
	if len(code) != 6 {
		writeError(w, http.StatusBadRequest, "invalid party code")
		return
	}

	party, err := h.queries.GetWatchPartyByCode(r.Context(), code)
	if err != nil {
		slog.Error("invite roster: party lookup failed", "code", code, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to load roster")
		return
	}
	if party == nil {
		writeError(w, http.StatusNotFound, "party not found or has ended")
		return
	}

	invites, err := h.queries.ListInvitesForParty(r.Context(), party.ID)
	if err != nil {
		slog.Error("invite roster: list failed", "party_id", party.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to load roster")
		return
	}

	// Authorization: host, invitee, or someone already in the live party.
	authorized := party.HostUserID == claims.UserID
	if !authorized {
		for _, inv := range invites {
			if inv.UserID == claims.UserID {
				authorized = true
				break
			}
		}
	}
	if !authorized {
		if ps := h.manager.GetPartyState(code); ps != nil {
			ps.Lock()
			_, inParty := ps.Participants[claims.UserID]
			ps.Unlock()
			authorized = inParty
		}
	}
	if !authorized {
		writeError(w, http.StatusForbidden, "not a member of this party")
		return
	}

	// Declining is silent — the promise is "no 'Kyle said no' wall", and
	// it must hold at the API, not just in the lobby's rendering (2026-08
	// review). Filter AFTER the auth check so a declined invitee keeps
	// read access to the roster (they can still change their mind from
	// the bell); their row simply isn't shipped to anyone.
	visible := make([]models.PartyInviteRosterEntry, 0, len(invites))
	for _, inv := range invites {
		if inv.RSVP == "declined" {
			continue
		}
		inv.AvatarURL = memberSafeAvatar(inv.AvatarURL)
		visible = append(visible, inv)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"invites": visible,
	})
}

// rsvpRequest is the JSON body for POST /api/party-invites/{id}/rsvp.
type rsvpRequest struct {
	RSVP string `json:"rsvp"`
}

// RSVP handles POST /api/party-invites/{id}/rsvp — the invitee answers
// (going | maybe | declined; re-answers allowed, latest wins). Ownership is
// enforced in SQL: a foreign invite id 404s. The host gets a bell ping only
// on the pending→going transition, so RSVP flip-flops can't spam them.
func (h *PartyInviteHandler) RSVP(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}

	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "invalid invite id")
		return
	}

	var req rsvpRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.RSVP != "going" && req.RSVP != "maybe" && req.RSVP != "declined" {
		writeError(w, http.StatusBadRequest, "rsvp must be going, maybe, or declined")
		return
	}

	prev, party, found, err := h.queries.SetInviteRSVP(r.Context(), id, claims.UserID, req.RSVP)
	if err != nil {
		slog.Error("rsvp: update failed", "invite_id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save rsvp")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "invite not found")
		return
	}

	if h.dispatcher != nil && party.IsActive && prev == "pending" && req.RSVP == "going" {
		h.dispatcher.Notify(r.Context(), &models.Notification{
			UserID: party.HostUserID,
			Type:   models.NotificationPartyRSVP,
			Title:  claims.Username + " is in — " + party.MediaTitle,
			Link:   "/p/" + party.PartyCode,
		})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"invite_id": id,
		"rsvp":      req.RSVP,
	})
}

// MyInvites handles GET /api/me/party-invites — the caller's invites whose
// party is still active, with party context for bell RSVP rows and Calendar
// chips. Declined invites are included so the UI can say "you declined"
// instead of re-asking.
func (h *PartyInviteHandler) MyInvites(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}

	allowed := listingAllowedRatings(r.Context(), h.queries, claims, "party invites")
	invites, err := h.queries.ListUpcomingInvitesForUser(r.Context(), claims.UserID, allowed)
	if err != nil {
		slog.Error("my invites: list failed", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to load invites")
		return
	}
	if invites == nil {
		invites = []models.MyPartyInvite{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"invites": invites,
	})
}
