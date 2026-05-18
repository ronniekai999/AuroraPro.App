# Watch Party V3 — Phase 1: The Foundation

Status: **Plan, not yet executing.**
Scope: Phase 1 only. Phases 2–4 are out of scope for this document.
Non-goal: migration. Active parties must be recreated after deploy.

---

## 1. Why this exists

V2 (current) inherited Jellyfin SyncPlay's tri-state group machine
(`Idle` / `Waiting` / `Playing`) and a Ready protocol that gates the
entire group on the slowest peer. Three rounds of patches fixed real
bugs (autoplay policy, per-user resume desync, coordinate-space
mixing) but the underlying machine keeps generating new bugs:

- **Host can't auto-start when guest joins** — Ready-gate races with
  browser autoplay policy.
- **Guest lags host by 10–15s** — Ready arrives before HLS is actually
  buffered; server transitions to Playing too early.
- **"Re-syncing…" toasts flicker** — drift correction hits hard-seek
  threshold because the expected/actual math was in different
  coordinate spaces until last week's patch.

The root cause is that the group's state machine conflates two
independent concerns:

1. **Intent** — is the movie supposed to be running or paused?
2. **Readiness** — has each peer buffered enough to start?

V2 treats these as one thing (`Waiting` = intent-play-but-not-ready).
V3 separates them: **intent is global, readiness is local.**

## 2. The new model, in one paragraph

The party has exactly two states: **Running** and **Paused**. When the
host hits play, the server enters Running *immediately* and begins
emitting `tick` broadcasts. Every peer who is buffered plays. Every
peer who is not buffered stays paused on their last frame, reports their
lag via heartbeat, and rate-adjusts to 1.05× once buffered so they catch
up within 10–20 seconds. Nobody gates anybody. The movie always plays.

This is how live-stream viewers work: when you open a Twitch stream 30
seconds late, the other viewers aren't held back waiting for you to
buffer. You just catch up (or don't — your problem).

## 3. Wire protocol

### 3.1 Transport

**Two WebSockets** (new):

- `/ws/party-sync` — high-frequency, sync-only. Tick broadcasts at
  250ms cadence while Running. No other traffic.
- `/ws/party-room` — low-frequency, everything else: chat,
  reactions, presence, future voice signaling.

Rationale: chat spam, reaction floods, or future voice negotiation
cannot delay a sync tick. Independent failure domains.

### 3.2 Coordinate space

Already settled in last week's fix: **absolute source-ms on the wire,
HLS-relative seconds in the video element.** V3 keeps this. All
`absMs` fields below are absolute source milliseconds.

### 3.3 Sync messages

**Server → client:**

```
{ "type": "tick",  "abs_ms": 1234567, "server_now_ms": 1700000001234, "rev": 42 }
{ "type": "pause", "abs_ms": 1234567, "rev": 43, "by": "user_17" }
{ "type": "seek",  "abs_ms": 2000000, "rev": 44, "by": "user_17" }
{ "type": "hello", "abs_ms": 1234567, "running": true, "server_now_ms": ..., "rev": 44, "media": {...} }
```

- `tick` — emitted every 250ms while Running. Carries the canonical
  `abs_ms` at the server's `server_now_ms`. Client projects forward
  using its measured clock offset.
- `pause` — enters Paused at `abs_ms`. Server stops emitting ticks.
- `seek` — in Running state, updates canonical position (server
  continues ticking from the new abs_ms). In Paused state, updates
  position without resuming.
- `hello` — sent once on connect. Carries current state so new peers
  know whether to start playing, where, and what's on screen.

**Client → server:**

```
{ "type": "request-play",   "from_ms": 1234567 }   // host or any peer if allow_pause
{ "type": "request-pause",  "at_ms": 1234567 }
{ "type": "request-seek",   "to_ms": 2000000 }
{ "type": "heartbeat",      "abs_ms": 1234567, "ready_state": 4, "buffered_end_ms": 1300000 }
{ "type": "time-sync",      "client_send_ms": 1700000001000 }
```

- `request-*` are intents. Server arbitrates (host-only vs.
  democratic) and broadcasts the resolved command back as `pause` /
  `seek` / `tick` resumption.
- `heartbeat` at 2s cadence. Purely informational — server uses it
  for presence timeouts and optional slow-peer telemetry. It does NOT
  seek-correct anyone.
- `time-sync` — unchanged NTP handshake, echoes back
  `TimeSyncResponse`. Runs on the sync socket.

### 3.4 Room messages

Chat, reactions, presence, participant join/leave — all existing V2
messages, moved verbatim to `/ws/party-room`. No logic changes in
Phase 1.

### 3.5 What's gone

- **Ready protocol.** Deleted wholesale. No `ready`, no Waiting
  state, no "all participants ready" gate.
- **Drift-report / FailedSeekAttempts / Suspensions["desync"].**
  Deleted. Rate-adjust never fails, so there's nothing to report.
- **Force-sync / playback-control legacy shims.** Deleted.
- **StateRevision on sync messages.** Kept on `pause` / `seek` /
  `hello` (so late-arriving messages don't clobber newer state) but
  removed from `tick` (ticks are idempotent — if you miss one, the
  next one arrives 250ms later with the current truth).

## 4. Client state machine

```
        connect
           │
           ▼
  ┌──────────────┐   hello{running:false}   ┌──────────────┐
  │  Connecting  │─────────────────────────>│    Paused    │
  └──────────────┘                          └──────────────┘
         │                                    ▲         │
         │   hello{running:true}              │         │
         │                                  pause       │
         ▼                                    │         ▼
  ┌──────────────┐     tick/seek              │ ┌──────────────┐
  │   Running    │<───────────────────────────┘ │   (paused)   │
  └──────────────┘                              └──────────────┘
         │
         ├── local: buffered + near target → vid.play(), rate=1
         ├── local: buffered + behind target → vid.play(), rate=1.05 until caught up
         ├── local: not buffered → vid.pause(), spinner; next tick re-evaluates
         └── local: ahead of target → vid.pause() briefly until target catches up
```

The magic: the client always knows what the canonical position *is*
(from ticks + clock offset), and uses four simple rules to pick its
local action. No "is the group ready" question. No server round-trip
to start playing.

## 5. Catch-up algorithm

On every tick:

```
expectedMs = tick.abs_ms + (serverNow() - tick.server_now_ms)
actualMs   = hlsSecToAbsMs(vid.currentTime)
lag        = expectedMs - actualMs       // positive = we're behind

if vid.readyState < 3:                    // not buffered
    vid.pause(); show spinner; return

if |lag| < 200ms:                          // in the pocket
    vid.playbackRate = 1.0
    if vid.paused: vid.play()

elif lag > 200 and lag < 3_000:            // behind, recoverable by rate-adjust
    vid.playbackRate = 1.03                 // catch up at ~3% speed (inaudible pitch)
    if vid.paused: vid.play()

elif lag >= 3_000:                          // too far behind — hard seek
    vid.currentTime = absMsToHlsSec(expectedMs)
    vid.playbackRate = 1.0
    if vid.paused: vid.play()

elif lag < -200 and lag > -3_000:          // slightly ahead
    vid.playbackRate = 0.97                 // ease back

else:                                       // way ahead (seek happened on server)
    vid.currentTime = absMsToHlsSec(expectedMs)
    vid.playbackRate = 1.0
```

Thresholds tunable via the existing `SyncConfig`. Defaults above are
what Syncplay uses and feel natural.

## 6. Server state machine (simplified)

```go
type PartyState struct {
    // Identity (unchanged)
    Code, HostUserID, MediaItemID, EpisodeID, PartyName, ...

    // Running/Paused model
    Running        bool   // replaces tri-state GroupState
    AnchorAbsMs    int64  // position at AnchorServerMs
    AnchorServerMs int64  // server wall-clock when AnchorAbsMs was set
    Revision       uint64 // bumped on pause/seek, NOT on tick

    // Presence (trimmed)
    Participants map[int64]*Participant  // Participant loses ReadyAtMs, Suspensions, FailedSeekAttempts
    conns        map[int64]*SafeConn     // split: syncConns + roomConns
}
```

Canonical position at any moment:

```go
func (ps *PartyState) CurrentAbsMs() int64 {
    if !ps.Running { return ps.AnchorAbsMs }
    return ps.AnchorAbsMs + (time.Now().UnixMilli() - ps.AnchorServerMs)
}
```

Tick broadcaster: one goroutine per party, 250ms ticker, emits
`{type:"tick", abs_ms: ps.CurrentAbsMs(), server_now_ms: now, rev: ps.Revision}`
while `ps.Running`. Cleanly stoppable via context on party end.

## 7. File-by-file change list

### 7.1 Backend: `internal/watchparty/`

**`manager.go`** (1215 → ~900 lines)

- Remove `GroupState` constants and field.
- Add `Running bool`, `AnchorAbsMs int64`, `AnchorServerMs int64`.
- Add `CurrentAbsMs()` method.
- `Participant` struct: remove `ReadyAtMs`, `IsBuffering`,
  `BufferingSince`, `FailedSeekAttempts`, `Suspensions`. Keep
  `UserID`, `Username`, `IsHost`, `LastSeen`, `LastRTTms`,
  `ClockOffsetMs`.
- Split `conns` map into `syncConns` and `roomConns`.
- Per-party tick goroutine: started on `Running=true`, stopped on
  `Running=false` or party end.
- `HandlePlaybackControl` rewritten: becomes
  `HandleRequestPlay / Pause / Seek`, each setting the anchor and
  bumping Revision, then broadcasting the resolved message.

**`sync.go`** (247 → ~120 lines)

- Delete: `HandleReady`, `transitionToWaitingLocked`, the
  tri-state snapshot format, `HandleDriftReport`, bump-on-tick.
- Keep: `HandleTimeSync`, `RecordRTT`, `bumpRevLocked`.
- Add: `tickBroadcaster(ps)`, `broadcastPauseLocked(ps)`,
  `broadcastSeekLocked(ps)`, `buildHelloLocked(ps)`.

**`manager_test.go`** (1522 → ~1100 lines)

Kept as-is (still valid): GenerateCode*, CreateParty*, JoinParty*,
LeaveParty*, Chat*, Reaction*, EndParty*, CleanupOnce*,
ConcurrentCodeGeneration, PartyCount, ActiveParties,
TimeSync_Echoes, RecordRTT_Updates, SyncConfigAccessor,
NewManagerWithConfig_Backfills.

**Rewritten** for new protocol: `HandlePlaybackControl_*` (4 tests),
`CalculateCurrentPosition_*` (2 tests), `HandleSyncHeartbeat_*` (4
tests become 2: non-existent party, non-participant).

**Deleted**: `PlayEntersWaiting`, `Ready_*` (3 tests),
`TransientBufferDoesNotPauseGroup`,
`SustainedBufferTransitionsToWaiting`, `BufferClearRemovesSuspension`,
`DriftReport_*` (2 tests), `StateRevisionIsMonotonic` (rewritten to
assert rev bumps only on pause/seek, not tick).

**New tests:**
- `TestRunning_TickAdvances` — anchor + elapsed == CurrentAbsMs.
- `TestPause_StopsTicking` — no ticks broadcast after pause.
- `TestSeek_Running_ContinuesTicking` — seek updates anchor, ticks
  continue from new position.
- `TestSeek_Paused_UpdatesPositionOnly` — seek while paused, no
  ticks emitted.
- `TestHello_NewJoinerGetsCanonicalState` — late joiner's hello
  carries Running + current abs_ms within 10ms of real canonical.

### 7.2 Backend: `internal/api/`

**`party_ws.go`** (463 lines, split into two files)

- New: `party_ws_sync.go` — handler for `/ws/party-sync`. Handles
  `time-sync`, `heartbeat`, `request-play`, `request-pause`,
  `request-seek`. Registers the conn in `ps.syncConns`.
- Rename existing: `party_ws_room.go` — handler for `/ws/party-room`.
  Handles `chat-message`, `reaction`, presence. Registers the conn
  in `ps.roomConns`.
- Both handlers share `join-party` semantics: a client must open the
  room socket first (it validates party membership), then the sync
  socket (which authenticates via the same token and binds to the
  same userID).

**`party_handlers.go`** (293 lines, minor)

- No signature changes. `CreateParty` still takes
  `initialPositionMs` from last week's fix — now stored as
  `ps.AnchorAbsMs` with `ps.Running = false`.

**`routes.go` / router setup** (wherever routes are registered)

- Remove: `GET /ws/party` (old single socket).
- Add: `GET /ws/party-sync`, `GET /ws/party-room`.

### 7.3 Frontend: `static/aurora_pro.html`

Two WebSocket connections. Helpers:

```js
function connectPartySockets(code) {
    // Room first — it's the membership gate.
    connectPartyRoomWS(code);
    // Sync second — opens after room confirms membership.
}
```

**Deleted functions:**

- `armPartyReadySender` — no more Ready.
- `schedulePartyPlayAtServerTime` — collapsed into tick handler.
- `handlePartyForceSync` — dead.
- `handlePartyPlaybackControl` — replaced by tick/pause/seek.
- `triggerPartyAutoPlay`, `_partyAutoPlayPending`, pre-warm
  MANIFEST_PARSED hack, participant-join unpause branch — all gone.
  The host's "Watch Party" click now IS the play() call; autoplay
  policy never comes into it because the sync socket immediately
  emits `request-play` on that click.

**New functions:**

- `partyApplyTick(msg)` — runs the 6-branch catch-up decision.
- `partyHandleHello(msg)` — on connect, enters Running or Paused
  based on `msg.running`.
- `partyHandlePause(msg)` — pauses local video, updates revision.
- `partyHandleSeek(msg)` — seeks local video to the abs_ms.

**Rewritten UI flow:**

- "Start Watch Party" button: opens both sockets, sends
  `request-play` on room socket. No more pre-warm dance.
- Chat/reactions/participants: unchanged, just send via the room
  socket instead of the unified socket.

Estimated SPA diff: ~250 lines deleted, ~200 lines added.

## 8. Migration

None. Deploying V3 kills all active parties. Users reopen the app and
re-create. This is a self-hosted app with 1–2 concurrent parties;
the cost is effectively zero.

## 9. Exit criteria (how we know Phase 1 shipped)

All must pass on two-laptop local test:

1. **Host starts party alone.** Video loads, pauses at start
   position. No playback begins. Panel shows "Waiting for guests."
2. **Guest joins.** Both videos load. Host clicks play. Guest's
   video starts within 500ms of host's, at the same source-second.
3. **Mid-movie seek.** Either peer scrubs forward. Other peer seeks
   within 500ms. No "Re-syncing…" toast.
4. **30-minute cold run.** Peers stay within 200ms without any
   toast, any rate-adjust visible to the naked eye, or any pause.
5. **Slow-peer catch-up.** Throttle guest's network to 1 Mbps for
   10s mid-movie. Guest falls behind, recovers within 30s via
   rate-adjust. Host is never paused.
6. **Late join is non-disruptive.** Guest joins 15 minutes into a
   party. The already-playing peers see no pause, no seek, no
   "Re-syncing…" toast. Guest eventually (within ~10–15s) sees
   canonical position. Phase 2 will cut this to <3s.
7. **All existing tests pass** (minus the deleted/rewritten ones).
   Running `go test ./internal/watchparty/... -race` is green.
8. **Backgrounded tab recovery.** Guest switches to another tab for
   60 seconds. Returns. Video catches up within 2 seconds via hard
   seek (lag >3s triggers seek, not rate-adjust). No toast spam, no
   group pause.

## 10. Execution order

Single commit per step, each individually green on `go build && go test`:

1. **Add tick broadcaster + Running/Paused fields** alongside
   existing tri-state. Don't wire frontend yet. Server compiles,
   old protocol still works.
2. **Add new `/ws/party-sync` + `/ws/party-room` routes** alongside
   `/ws/party`. All three work simultaneously.
3. **Frontend: add new socket code path behind feature flag**
   `S.partyV3=true` (hardcoded off). Old path unchanged.
4. **Flip the flag on.** Run manual two-laptop test. Iterate until
   exit criteria pass.
5. **Delete old path:** `HandleReady`, `transitionToWaitingLocked`,
   `GroupState` tri-state, `/ws/party` route, legacy frontend.
6. **Delete/rewrite tests.** Green `go test -race`.
7. **Update `docs/watchparty-v3.md`** — strike through "plan,"
   mark as shipped.

Roughly two days of focused work. Biggest single step is step 1
(maybe 4 hours). Step 5 is terrifying-looking but is almost
entirely deletions; should take an hour.

## 11. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Two WebSockets per client doubles connection overhead | Low (parties are tiny) | Accept it; gives independent failure domains. |
| Tick broadcast goroutine leaks if party ends mid-tick | Medium | Context-cancel pattern; test with `goleak` in party-end test. |
| Catch-up rate of 1.05× is imperceptible but SOME users will spot audio pitch shift | Low | Document the tradeoff; can go to 1.02× if complaints arise. |
| Seek during Running causes buffer evacuation on some peers → they spinner for 5s | Medium | Acceptable — the Running-state contract is "whoever is buffered plays." Spinners are honest. |
| Late-joiner's `hello.abs_ms` is stale by the time client applies it | Low | `hello` also carries `server_now_ms`; client projects forward same as tick. |
| New tests miss a race that was caught by old Ready-protocol tests | Medium | Port the Ready concurrency test scenarios to assert new invariants (e.g., tick goroutine doesn't emit after pause). |

## 12. Out of scope (saved for later phases)

- Jumpstart low-bitrate sidecar (Phase 2).
- WebRTC voice (Phase 3).
- PiP chat HUD (Phase 3).
- Reaction timeline + clip-sharing (Phase 4).
- Multi-host / democratic pause (Phase 3).

---

**Ready to execute on your approval.**
