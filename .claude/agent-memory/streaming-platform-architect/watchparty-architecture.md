# Watch Party Architecture

## Files Created
1. `internal/watchparty/manager.go` (1049 lines) - In-memory party state manager
2. `internal/watchparty/manager_test.go` (1038 lines) - 39 test cases
3. `internal/db/queries_parties.go` (251 lines) - PostgreSQL DB queries
4. `internal/api/party_handlers.go` (280 lines) - REST HTTP handlers
5. `internal/api/party_ws.go` (370 lines) - Dedicated WebSocket handler

## Manager (internal/watchparty/manager.go)
- `Manager` struct: top-level `sync.RWMutex` guards `parties map[string]*PartyState`
- `PartyState` struct: per-party `sync.Mutex` guards mutable fields
- Exported `Lock()/Unlock()` methods on PartyState for cross-package access
- Key methods: CreateParty, JoinParty, LeaveParty, EndParty, HandlePlaybackControl, HandleSyncHeartbeat, HandleChat, HandleReaction, CleanupStale, Shutdown
- GenerateCode: crypto/rand, 6-char uppercase alphanumeric, excludes 0/O/1/I/L
- Drift thresholds: 3s non-critical, 10s critical
- Chat: 500 char max, html.EscapeString sanitization, 100-message ring buffer
- Reactions: 15-emoji whitelist
- Host-authoritative sync: host heartbeats update authoritative position
- calculateCurrentPosition: accounts for elapsed time since PlayingSince

## Lock Ordering
- Always: m.mu (RLock/Lock) FIRST, then ps.mu (Lock)
- endPartyInternal: acquires ps.mu, releases it, then acquires m.mu
- cleanupOnce: holds m.mu.RLock while iterating and locking individual ps.mu
- No deadlock risk because locks are always acquired in same order

## DB Queries (internal/db/queries_parties.go)
- InsertWatchParty: RETURNING id
- GetWatchPartyByCode: WHERE is_active=true
- GetWatchPartyByCodeAny: no active filter (for ended party info)
- EndWatchParty: SET is_active=false, ended_at=now()
- InsertParticipant: ON CONFLICT DO UPDATE (re-join clears left_at)
- UpdateParticipantLeft: SET left_at=now()
- GetActivePartiesForUser: LEFT JOIN with is_active=true
- GetPartyParticipants: with username via JOIN

## REST Handlers (internal/api/party_handlers.go)
- POST /api/parties -> Create (validates media_item exists)
- GET /api/parties/{code} -> GetInfo (live state or DB fallback)
- POST /api/parties/{code}/end -> End (host only)
- GET /api/parties/active -> ListActive

## WebSocket Handler (internal/api/party_ws.go)
- Dedicated /ws/party endpoint (separate from main /ws hub)
- JWT auth via ?token= query param (same pattern as /ws)
- Message types: join-party, leave-party, playback-control, sync-heartbeat, chat-message, reaction
- Chat rate limiting: 30 messages/minute per user, lazy cleanup at >100 entries
- Max message size: 4096 bytes
- Ping/pong: 60s write, 90s pong wait
- On disconnect: auto-leave party

## Audit Fixes Applied
- Nil conn guards on all WebSocket write paths
- chatRates map lazy cleanup to prevent unbounded growth
- endPartyInternal nil conn check before WriteControl/Close
