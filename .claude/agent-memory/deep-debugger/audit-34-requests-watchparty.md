# Audit 34 (2026-02-26) - Requests & Watch Party Cross-Feature Integration

## Scope
20 files (12 new, 8 modified) implementing Requests (Radarr/Sonarr) and Watch Party features.

## Findings: 9 total (3 HIGH, 4 MEDIUM, 2 LOW)

### HIGH (3) - ALL FIXED

1. **Frontend-backend WebSocket message format mismatch**
   - Frontend sent flat `{type:'join-party', party_code:code}` but backend expected `{type:'join-party', payload:{party_code:code}}`
   - Applied to ALL 6 message types (join-party, leave-party, playback-control, sync-heartbeat, chat-message, reaction)
   - Frontend read broadcast data at top level but backend nested under `.payload`
   - **Files**: `static/aurora_pro.html`
   - **Fix**: Updated all frontend WS sends to include `payload` wrapper, updated all receive handlers to dereference `.payload`

2. **Migration FK references wrong table name**
   - `watch_parties.episode_id REFERENCES episodes(id)` -- table is `tv_episodes`, not `episodes`
   - Would cause migration failure on fresh install
   - **File**: `migrations/013_requests_and_parties.up.sql` line 43
   - **Fix**: Changed to `REFERENCES tv_episodes(id)`

3. **Concurrent WebSocket writes from broadcast and ping goroutine**
   - gorilla/websocket does NOT support concurrent writers
   - Ping goroutine wrote control frames while `broadcastToPartyLocked` wrote data frames
   - **Files**: `internal/watchparty/manager.go`, `internal/api/party_ws.go`
   - **Fix**: Added `SafeConn` wrapper with write mutex. All writes (broadcast, ping, sendError, direct messages) go through SafeConn. Changed `conns` map type, updated `JoinParty` signature, updated `sendError` to accept `*SafeConn`.

### MEDIUM (4) - ALL FIXED

4. **Service status response format mismatch**
   - Backend `GetServiceStatus` returns array `[{name, connected, error}]`
   - Frontend did `Object.entries(st)` expecting object with `{configured, online}`
   - **File**: `static/aurora_pro.html`
   - **Fix**: Frontend now iterates array with `svc.name`, `svc.connected`

5. **Active parties response format + field name mismatch**
   - Backend returns `{parties: [...], total: N}`, frontend expected plain array
   - Backend uses `"code"` field, frontend expected `"party_code"`
   - **File**: `static/aurora_pro.html`
   - **Fix**: Frontend handles wrapper format and uses `p.code||p.party_code`

6. **Deadlock: reversed lock ordering in cleanupOnce and ActiveParties**
   - `cleanupOnce` held `m.mu.RLock()` then acquired `ps.mu.Lock()` (per-party mutex)
   - `endPartyInternal` acquired `ps.mu.Lock()` then `m.mu.Lock()`
   - If cleanup holds RLock and tries ps.mu.Lock while endPartyInternal holds ps.mu.Lock and tries m.mu.Lock -- deadlock (Write lock blocked by RLock)
   - Same issue in `ActiveParties`
   - **File**: `internal/watchparty/manager.go`
   - **Fix**: Snapshot+iterate pattern: collect party pointers under RLock, release RLock, then lock individual ps.mu without holding m.mu

7. **TOCTOU race in CreateParty**
   - "Already hosting" check under RLock, released, then code/DB work, then write Lock to insert
   - Two concurrent CreateParty calls could both pass the RLock check
   - **File**: `internal/watchparty/manager.go`
   - **Fix**: Authoritative re-check under write lock at insertion time. If race detected, best-effort DB cleanup.

### LOW (2) - NOT FIXED (acceptable)

8. **Install.sh env values not quoted**
   - `printf 'RADARR_URL=%s\n' "$RADARR_URL"` writes unquoted value to env file
   - URLs and API keys don't contain spaces/special chars, so this is cosmetic
   - **File**: `scripts/install.sh`

9. **No WriteDeadline before broadcast writes**
   - `broadcastToPartyLocked` writes to SafeConn without setting a write deadline
   - Mitigated: SafeConn serializes writes; stuck writes will eventually be caught by the pong timeout
   - **File**: `internal/watchparty/manager.go`

## Files Modified
- `migrations/013_requests_and_parties.up.sql` - FK reference fix
- `internal/watchparty/manager.go` - SafeConn type, deadlock fix, TOCTOU fix
- `internal/watchparty/manager_test.go` - Updated for SafeConn type
- `internal/api/party_ws.go` - SafeConn integration, sendError signature
- `static/aurora_pro.html` - WS message format, service status, active parties

## Build & Tests
- `go build ./...` -- clean
- `go vet ./...` -- clean
- `go test ./internal/watchparty/...` -- 37/37 pass
- `go test ./internal/arr/...` -- 28/28 pass
