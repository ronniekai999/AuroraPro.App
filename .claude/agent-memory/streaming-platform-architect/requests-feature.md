# Requests Feature - Backend Implementation

## Overview
Media request system allowing users to request movies/TV shows. Dispatches to Radarr/Sonarr for automated downloading. Background monitor polls ARR services for completion status.

## Files Created
- `migrations/013_requests_and_parties.up.sql` - 3 tables (requests, watch_parties, watch_party_participants)
- `migrations/013_requests_and_parties.down.sql` - Drop tables
- `internal/arr/client.go` - Base ARR HTTP client (30s timeout, X-Api-Key, 10MB response limit)
- `internal/arr/radarr.go` - RadarrClient (v3 API: movie CRUD, root folders, quality profiles)
- `internal/arr/sonarr.go` - SonarrClient (v3 API: series CRUD, TMDB->TVDB lookup)
- `internal/arr/client_test.go` - 26 tests using httptest mock servers
- `internal/db/queries_requests.go` - 8 DB query functions (Insert, Get, List, Update, Delete, Exists)
- `internal/api/request_handlers.go` - RequestHandler (5 endpoints) + RequestMonitor (60s polling)

## Files Modified
- `internal/config/config.go` - RequestsConfig, ArrInstanceConfig structs, YAML loading, 9 env vars
- `internal/models/models.go` - Request, CreateRequestPayload, RequestsConfigResponse + WatchParty models
- `internal/websocket/events.go` - EventRequestStatus, EventPartyInvite, EventPartyUpdate

## API Endpoints (to be wired in router.go by another agent)
- `GET /api/requests/config` - Feature flags (enabled, has_radarr, has_sonarr, has_4k)
- `GET /api/requests/status` - Ping each ARR service (admin only)
- `GET /api/requests` - List requests (admin=all+usernames, user=own)
- `POST /api/requests` - Create request (validates, dedup check, async ARR dispatch)
- `DELETE /api/requests/{id}` - Delete pending/failed requests (ownership check)

## Key Design Decisions
- Partial unique index prevents duplicate active requests per user+media (failed excluded)
- Background goroutine for ARR dispatch (30s context timeout)
- RequestMonitor: 60s ticker, in-memory failure counter (mutex-protected), marks failed after 10 consecutive failures
- 4K instance selection: only used when quality_4k=true AND quality_1080p=false
- TMDB->TVDB resolution via Sonarr lookup API (`/api/v3/series/lookup?term=tmdb:{id}`)
- TVDB ID stored in arr_job_ids for monitor polling

## Audit Fixes Applied
1. Nil interface bug in GetServiceStatus: split generic `checkService` into concrete `checkRadarr`/`checkSonarr`
2. Activity logger nil checks: added `if h.activity != nil` guards in Create and Delete
3. Response body limit: `io.LimitReader(resp.Body, 10<<20)` in doRequest

## Config
```yaml
requests:
  enabled: true
  radarr:
    url: http://localhost:7878
    api_key: xxx
  sonarr:
    url: http://localhost:8989
    api_key: xxx
```
Env vars: REQUESTS_ENABLED, RADARR_URL, RADARR_API_KEY, RADARR_4K_URL, RADARR_4K_API_KEY, SONARR_URL, SONARR_API_KEY, SONARR_4K_URL, SONARR_4K_API_KEY
