# Aurora Media Server — project memory

Self-hosted media server in Go (bare-metal Linux: systemd + native
PostgreSQL), with a React/Vite SPA frontend. See `README.md` for the full
install/operate story.

## Build & test

```bash
go build ./...     # must be green
go test ./...      # must be green
```

The dev pipeline (research → implement+tests → adversarial review → merge gate)
is documented in `docs/dev-workflow.md`. Branch off `main`; never commit to
`main` directly.

## Testing against the live server

You can deploy a change and verify it against the **running instance**
(`https://aurorapro.app`) end-to-end over HTTPS — no SSH needed:

```bash
# After the change is on `main`:
bash scripts/server-test-loop.sh --trigger-update
```

This logs in, triggers the in-app auto-updater, waits for the rebuild, then runs
the API smoke test. Full runbook + the manual curl equivalents are in
**`docs/server-testing.md`**.

Key facts:

- **Credentials are environment secrets, never committed.** The loop reads
  `AURORA_TEST_USER` / `AURORA_TEST_PASS` (and optional `AURORA_BASE`) from the
  environment. Configure them in the Claude Code web environment's secrets.
- **The remote update trigger is admin-only** and the server builds
  **`origin/main`** (`AURORA_UPDATE_BRANCH`, default `main`). A change only
  deploys once it's on `main` — trigger *after* merging.
- Without an admin account, deploy by merging to `main` and letting the box's
  5-minute `aurora-update.timer` pick it up, then run the smoke test.

Relevant code/scripts: `scripts/server-test-loop.sh`,
`scripts/aurora_smoke_test.sh`, `scripts/aurora-update.sh`,
`internal/api/system_handlers.go` (update trigger/status endpoints).

## Social features (member profiles + follows, PRs #428/#429)

Member-visible profiles (`/user/:name`, bio/socials/recent watches), a
follow graph, a `/members` directory, and the "From People You Follow" home
rail. Code: migrations 049–050, `internal/db/queries_social.go`,
`internal/api/social_handlers.go` (+ tests), SPA `UserProfileView` /
`MembersView` / `lib/socialLinks`.

Invariants to preserve when touching this area:

- **Watch-history sharing is opt-in** (`users.share_watch_history`, default
  FALSE) and re-checked inside every read query — no caches to invalidate.
- History surfaces show the **default sub-profile only** (kids profiles
  never attribute to the account) and only rows with `completed_at`.
- The follow **feed applies the viewing sub-profile's parental ceiling**
  (`allowedRatingsForMax`) like every home rail.
- Member-visible responses never carry email/role/auth fields; avatars pass
  `memberSafeAvatar` (nebula/TMDB only); social handles are stored bare and
  shape-validated per network (links can only point at the four fixed
  domains).
- `/api/members/*` is the member-visible namespace — the admin-gated
  `/api/users` subtree must stay admin-only (and chi can't mix `{id}` /
  `{username}` wildcards at one node anyway).

## Watch-party invites (migration 051)

Member-to-member invites — send now or scheduled — with bell RSVP, a lobby
countdown, and calendar chips. Code: migration 051,
`internal/db/queries_party_invites.go`, `internal/api/party_invite_handlers.go`,
`internal/watchparty/rehydrate.go` (+ tests), SPA `PartyComposerModal` /
`PartyLobbyCard` / `lib/partyInvites` + bell/calendar wiring in `App.tsx` and
`CalendarView`.

Invariants to preserve here:

- **Sending is host-only and post-hoc by code** (composes with both create
  paths). A re-invite is a no-op that must never reset the invitee's RSVP.
- **Delivery goes through `notify.Dispatcher` only**, and only when the
  invite row was actually created — that created-flag is the notification
  dedup layer (invite notifications carry no `request_id`, so the
  notifications table's dedup index does not apply).
- **Parental ceilings are checked at SEND time** against the invitee's
  DEFAULT sub-profile (`rating_restricted` skip; unrated titles excluded
  under any restriction). Kids sub-profiles are structurally unreachable.
  Known limit: the check is point-in-time — party JOIN carries no rating
  gate at all (pre-existing, whole watchparty package) and a media swap
  after sending isn't re-checked. Gating join on the joiner's ceiling is
  the open follow-up; don't advertise stronger enforcement than this.
- **Rosters are member-visible surfaces**: username/display/avatar only,
  avatars through `memberSafeAvatar`; declines stay private to the
  decliner — the roster ENDPOINT filters `declined` rows out (not just the
  lobby UI), while declined invitees keep roster read access.
- **Scheduled-but-unstarted parties are exempt from every reaper** (empty-
  party cleanup, host-disconnect grace, host explicit leave) until the
  scheduled start has passed by the staleness window — a booking must
  survive its host closing the laptop. After an auto-start with an empty
  room, staleness anchors on `StartedAt`, giving showtime joiners ~5 min.
- **Scheduled parties must survive restarts**: the manager rehydrates
  active+scheduled+unstarted rows at boot and re-arms countdown/reminder
  timers (the box auto-deploys, so restarts are routine). Reminder timers
  carry no cancel hooks — they self-validate against the CURRENT
  `ScheduledStartAt` at fire time and dedupe via `reminderSentFor`.
- Calendar: party chips group by the viewer's **local** date; episode air
  dates stay UTC-keyed. Don't unify them.
