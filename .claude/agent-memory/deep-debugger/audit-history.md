# Aurora Audit History (Detailed)

This file contains detailed findings from audits 5-20. See MEMORY.md for the index.

## Fifth Audit: Install Script Re-audit (2026-02-20)
All 24 original fixes VERIFIED correct. Found 4 new bugs, 7 edge cases, 4 improvements:
- BUG-1: `rand_string` SIGPIPE under pipefail (line 66)
- BUG-2: `detect_pg_service` always matches first candidate (line 139)
- BUG-3: Double-quoted env values + systemd C-escape interpretation (line 509-548)
- BUG-4: `urlencode_password` bash fallback missing space/backslash/quote (line 84-97)
- EDGE-1: Re-run overwrites config, destroys JWT_SECRET (line 505,509)
- EDGE-2: rm -rf static dir creates frontend outage during upgrades (line 496)
- EDGE-3: Ctrl+D at prompts causes silent exit (line 44)
See install-reaudit.md for full details.

## Sixth Fix: Install Script PG Service Handling (2026-02-21)
- Removed PG_SERVICE default fallback; added PG_HAS_CLIENT flag
- Restructured detection into 4 cases; made start section graceful with fallback probing

## Seventh Audit: Full Install Script Audit R2 (2026-02-21)
See [install-audit-r2.md](install-audit-r2.md).
- FIX-1 (HIGH): Unquoted heredoc shell expansion
- FIX-2 (MEDIUM): No macOS/non-Linux OS detection
- FIX-3 (MEDIUM): aurora.service file not validated
- FIX-4-7 (LOW): Redundant 2>&1, EXISTING_JWT quoting, systemd After=, setfacl quoting

## Eighth Audit: Codec Decision Engine (2026-02-21)
See [codec-engine-audit.md](codec-engine-audit.md).
4 MEDIUM bugs, 8 test cases added (37->45):
- FIX-1: Audio track index not forwarded to FFmpeg
- FIX-2: Frontend fallback set audio_passthrough=true unconditionally
- FIX-3: Direct play URL session leak via legacy handler
- FIX-4: RemuxAudioCopy used legacy audioCodec field

## Ninth Audit: Scan Enrichment Deduplication (2026-02-21)
2 MEDIUM bugs fixed, 2 tests added:
- FIX-1: HasTMDBMetadata guard blocked RefreshStaleMetadata permanently
- FIX-2: enrichedItems sync.Map data race under concurrent scans (-> atomic.Pointer)

## Tenth Audit: Setup-Status & [object Object] Fix (2026-02-22)
- FIX-1 (MEDIUM): First-user registration TOCTOU (CreateFirstAdmin atomic INSERT)
- FIX-2 (LOW): showRegisterForm redundant fetch

## Eleventh Fix: Registration Invite Field Visibility (2026-02-22)
- HTML default state + silent error swallowing masked failures
- Key insight: Make default HTML state match the most common case

## Twelfth Audit: Registration/Invite Flow Re-audit (2026-02-22)
- FIX-1 (MEDIUM): dropdb fails with active connections (added stop + pg_terminate_backend)
- FIX-2 (MEDIUM): CountUsers error discarded (added slog.Warn)

## Thirteenth Audit: NULL avatar_url pgx v5 Scan Fix (2026-02-22)
- COALESCE(avatar_url, '') verified correct in all 6 queries
- FIX-1 (LOW): device_info also nullable, added COALESCE
- FIX-2 (LOW): Migration 009 adds DEFAULT '' at schema level
- Key pattern: pgx v5 errors on NULL -> non-pointer scan for ALL types

## Fourteenth Audit: Live Server Fixes Re-audit (2026-02-22)
3 original fixes verified, 3 new bugs found:
- FIX-1 (MEDIUM): HLS.js 401 during long playback (added refresh + recovery)
- FIX-2 (LOW-MEDIUM): Safari native HLS missing auth tokens on sub-requests
- FIX-3 (LOW): MediaItemEnriched duplicate PosterPath/BackdropPath fields

## Fifteenth Audit: Reverse Proxy Setup (2026-02-22)
See [proxy-audit.md](proxy-audit.md). 8 findings, 8 fixed.

## Sixteenth Fix: Live Server Logs (2026-02-22)
- FIX-1: Image proxy double-slash (TMDB poster_path leading `/`)
- FIX-2: WebSocket 500 (statusCapture missing Hijack/Flush)
- FIX-3: Direct play 401 (missing ?token= on video.src)

## Seventeenth Fix: Chrome EAC3 Audio Bug (2026-02-22)
- BUG-1 (MEDIUM): direct_play with non-default compatible audio track
- BUG-2 (LOW-MEDIUM): CreateSession ignored client-specific audio caps
- 5 test cases added

## Eighteenth Fix: Activity Log inet Error (2026-02-22)
- clientIP(r) + ratelimit.go: net.SplitHostPort() to strip port

## Nineteenth Fix: Genre Deadlock During Library Scan (2026-02-22)
- ON CONFLICT DO UPDATE -> DO NOTHING, sort+dedup genres, retry loop
- Key pattern: Shared lookup tables are deadlock hotspots under concurrent upserts

## Twentieth Audit: 16-File Re-audit (2026-02-22)
18 findings examined, 4 fixes applied across 3 files:
- **FIX-1 (MEDIUM)**: HLS playlist injection via unvalidated queryToken in helpers.go
  - `url.Query().Get()` decodes %0d%0a to literal \r\n; attacker injects M3U8 directives
  - Fix: Added JWT base64url character validation in `QueryParamToken()`
- **FIX-2 (LOW-MEDIUM)**: Variant playlist .ts suffix miss with \r line endings in streaming.go
  - FFmpeg may produce \r\n; `strings.Split(data, "\n")` leaves \r on lines
  - Fix: `strings.TrimRight(line, "\r")` before HasSuffix check
- **FIX-3 (LOW)**: EnsureVariant error leaks internal paths in streaming.go
  - Fix: Log full error server-side, return generic "variant start failed" to client
- **FIX-4 (LOW)**: GetWatchProgress profileID dereferenced before error check in queries_phase2.go
  - Fix: Moved error check before profileID dereference
- 14 other findings verified as already handled, by design, or not requiring fixes
- All tests pass, go build/vet clean
