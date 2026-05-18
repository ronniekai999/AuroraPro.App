# Aurora Authorization Audit Findings (2026-02-17)

## Authorization Model Summary
- `RequireAuth` middleware: validates JWT from `Authorization: Bearer <token>` header, sets claims in context
- `RequireAdmin` middleware: reads `claims.Role`, rejects unless == "admin"
- `auth.GetClaims(ctx)` returns `*JWTClaims{UserID, Username, Role}`
- All protected routes live inside `r.Group(func(r chi.Router) { r.Use(auth.RequireAuth(authSvc)) })`

## Confirmed Gaps

### Gap A — HIGH: `GET /api/libraries/{id}/scan/status` not admin-gated
- File: `internal/api/router.go:118`
- The route is outside the `RequireAdmin` sub-group (lines 111-116) but should be inside
- Fix: move into the admin sub-group

### Gap B — MEDIUM: `StreamMediaFile` and `StreamEpisodeFile` have dead auth check on direct-play path
- File: `internal/api/phase2_handlers.go:440-443` (StreamMediaFile), `480-483` (StreamEpisodeFile)
- `streaming.ServeFile()` is called before `auth.GetClaims()` is ever invoked in the handler
- Outer `RequireAuth` middleware ensures a valid JWT is always present, so this is not an unauthenticated access bug
- The actual gap: there is no per-file ownership/access check — any authenticated user can stream any file by ID
- However, libraries themselves have no per-user ACL (all auth users see all libraries), so this is by design
- Secondary gap: the `claims == nil` guard in the transcode branch is dead code (RequireAuth already guarantees claims are set)
- Fix: confirm whether per-file access control is a requirement; if yes, add library ACL before streaming

### Gap C — MEDIUM: `GET /api/tmdb/search` allows any authenticated user to drive TMDB API calls
- File: `internal/api/router.go:142`
- No `RequireAdmin` or per-user rate limit on this endpoint
- Fix: add `RequireAdmin` if admin-only, or add rate limiting if user-facing

## Confirmed Non-Gaps
- Watch progress: all 4 handlers use `claims.UserID` exclusively, URL `{id}` is media item ID not user ID
- Transcode session deletion: `DeleteSession` and `KeepAlive` both verify `owner == claims.UserID || claims.Role == "admin"`
- Admin endpoints (users, library CRUD, metadata refresh/match, session list): correctly gated

## Code Patterns
- Inline role check: `claims.Role != "admin"` used in HLS session handlers instead of `RequireAdmin` middleware — consistent but diverges from middleware pattern
- `GetSessionOwner` returns -1 for missing session, 0+ for owner user ID — no collision with valid user IDs due to BIGSERIAL (starts at 1)
