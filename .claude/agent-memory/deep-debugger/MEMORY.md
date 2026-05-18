# Aurora Codebase - Deep Debugger Memory

## Project Overview
- Go 1.23.6 media streaming backend ("Aurora")
- Chi v5 router, PostgreSQL 16 (pgx/v5), JWT auth (HS256), Argon2id passwords
- TMDB/TVDB metadata, FFmpeg transcoding (HLS), WebSocket, Docker deployment

## Architecture
- `cmd/aurora/main.go` - entry point, graceful shutdown
- `internal/config/` - YAML + env var config loading
- `internal/auth/` - JWT, Argon2id hashing, rate limiting, middleware
- `internal/db/` - pgxpool, queries (parameterized), migrations
- `internal/api/` - HTTP handlers (auth, media, streaming, progress)
- `internal/library/` - file scanner, parser, watcher, ffprobe, NFO
- `internal/streaming/` - HLS transcode, subtitles, hw accel, profiles
- `internal/metadata/` - TMDB/TVDB clients, enricher, image proxy
- `internal/websocket/` - gorilla/websocket hub
- `internal/httputil/` - JSON response helpers

## Audit Index (36 audits, most findings resolved)
Detailed findings: [audit-history.md](audit-history.md), [audit-findings.md](audit-findings.md)
Specialized: [codec-engine-audit.md](codec-engine-audit.md), [install-audit-r2.md](install-audit-r2.md), [proxy-audit.md](proxy-audit.md)

### Audits 1-4 (2026-02-17 to 2026-02-19) - Core Security & Feature Completion
- **1st**: 8 issues (MaxBytesReader nil RW, registration TOCTOU, broadcast deadlock, RemoteAddr port, origin wildcard, path leak, auth gaps) - ALL FIXED
- **2nd**: 6 issues (StopSession I/O under lock, GetOrCreateSession TOCTOU, MarkWatched zeros, GetNextEpisode error masking, StopAllSessions lock, ListSessions nested lock)
- **3rd**: 12 issues (ringbuffer race, cleanupLoop leak, invite TOCTOU, settings validation, error masking, unbounded caches, config edge cases)
- **4th**: 24 feature-completion findings (GetContinueWatching missing column, write-only settings, dead code, unimplemented features)

### Audits 5-10 (2026-02-20 to 2026-02-22) - Install Script & Frontend
- **5th**: Install script re-audit (4 bugs: rand_string SIGPIPE, PG detect, env quoting, urlencode)
- **6th**: PG service handling restructured (4 detection cases, graceful start)
- **7th**: Install script R2 (heredoc expansion HIGH, OS detection, service validation)
- **8th**: Codec engine (4 MEDIUM: audio track index, frontend fallback, session leak, RemuxAudioCopy)
- **9th**: Scan enrichment dedup (HasTMDBMetadata guard, sync.Map race)
- **10th**: Setup-status & [object Object] (first-admin TOCTOU, redundant fetch)

### Audits 11-15 (2026-02-22) - Registration & Live Server
- **11th**: Registration invite field visibility (HTML default state, silent error swallowing)
- **12th**: Registration/invite re-audit (dropdb connections, CountUsers error)
- **13th**: NULL pgx v5 scan (COALESCE avatar_url, device_info, schema DEFAULT)
- **14th**: Live server (HLS.js 401 refresh, Safari token embedding, MediaItemEnriched dup fields)
- **15th**: Reverse proxy setup (8 findings) - see proxy-audit.md

### Audits 16-20 (2026-02-22) - Live Fixes & Final Re-audit
- **16th**: Image proxy double-slash, WebSocket Hijack, direct play auth token
- **17th**: Chrome EAC3 (direct_play non-default track, client-specific audio caps)
- **18th**: Activity log inet (net.SplitHostPort in clientIP + ratelimit)
- **19th**: Genre deadlock (DO NOTHING, sort+dedup, retry loop)
- **20th**: 16-file re-audit (HLS playlist injection, variant .ts \r, error leak, profileID ordering)

### Audit 21 (2026-02-22) - File Logging (lumberjack) Implementation
- **21st**: 7 findings (MkdirAll fail-through HIGH, log-after-close MEDIUM, dir perms MEDIUM, neg values LOW, path traversal LOW, YAML compress LOW, install perms LOW) - ALL FIXED

## Key Debugging Patterns
1. **pgx v5 NULL scanning**: Always COALESCE nullable columns or use pointer types
2. **HLS auth chain**: `<video>`/`<img>` can't set headers; use `?token=` query params
3. **Direct play limitations**: Can't select audio tracks; multi-track needs remux
4. **Shared lookup table upserts**: Sort keys + DO NOTHING to prevent deadlocks
5. **Go url.Query().Get()**: Decodes %0d%0a to literal \r\n -- validate before embedding in responses
6. **FFmpeg line endings**: May produce \r\n; always TrimRight("\r") after Split("\n")
7. **Token promotion flow**: router middleware stores ?token= in context -> helpers.go validates -> streaming embeds
8. **Chi RealIP + net.SplitHostPort**: RemoteAddr format varies with/without proxy headers
9. **Default HTML state**: Should match the most common runtime state (prevents flash of wrong UI)
10. **Error messages to clients**: Never include err.Error() from internal operations (paths, FFmpeg stderr)
11. **io.MultiWriter fail-through**: If one writer is broken, don't wire it in -- every log line will error
12. **Shutdown ordering**: Close log writers LAST, after final log line; use stderr for close-error reporting
13. **Remux audio transcode**: Never force `-ac 2` in remux mode -- preserves source channel layout (5.1 EAC3 -> 5.1 AAC). Use 384k bitrate for adequate multi-channel quality
14. **Log message accuracy**: `startVariant` log must reflect actual encoder, not `tm.hwAccel.VideoEncoder` when in remux mode (where video_encoder=copy)

15. **Frontend image URLs: Always use proxy, never direct TMDB/TVDB URLs**: Detail page `_url` fields (poster_url, backdrop_url, still_url) contain direct TMDB CDN URLs that bypass the image proxy. Always use `_path` fields with `/api/images/{size}/${imgPath(path)}` for consistency. Direct URLs break when TMDB CDN is unreachable from client.
16. **TVDB poster_path is a full URL (FIXED)**: TVDB enrichment stores full URLs (https://artworks.thetvdb.com/...) in poster_path/backdrop_path. Image proxy now detects full URLs via `isExternalURL()`, validates against `allowedImageHosts` domain allowlist (SSRF prevention), and proxies directly via `fetchAndCacheURL()`. Go's net/http path cleaning collapses `https://` to `https:/` in URLs -- the `ProxyImage` handler reconstructs the double-slash.
17. **Never use `<img src="">` as fallback**: Empty `src=""` causes browser to request the current page URL as an image. Use a placeholder `<div>` or omit the `<img>` tag entirely when no image path exists.

### Audit 22 (2026-02-22) - Image Proxy Migration & Audio Transcode Fix
- **22nd**: Re-audit of two targeted fixes:
  - Fix 1 (image proxy migration): All detail page images now use `/api/images/` proxy with `imgPath()` + `_path` fields. 1 finding: cast `<img src="">` when no profile_path caused wasted request -- FIXED (replaced with placeholder div)
  - Fix 2 (audio transcode): `-ac 2` removed from remux path, bitrate 192k->384k, log message fixed. All 4 code paths verified correct. LOW: 384k marginal for 7.1 but acceptable
  - Pre-existing: TVDB full-URL paths broke image proxy (documented in pattern #16) -- NOW FIXED in Audit 23

### Audit 23 (2026-02-22) - TVDB Image Proxy Fix
- **23rd**: TVDB full-URL image proxying. 3 files changed:
  - `imageproxy.go`: Added `allowedImageHosts` domain allowlist, `isExternalURL()` detector, `serveExternalImage()` with SSRF validation, `fetchAndCacheURL()` for direct URL fetching, `downloadToCache()` shared helper. Updated `FetchAndCache`/`GetBlurhash` for URL-aware routing.
  - `phase2_handlers.go`: `ProxyImage` reconstructs `https://` from path-cleaned `https:/` (Go net/http collapses `//` to `/`)
  - Frontend `imgPath()`: No change needed (TVDB URLs have no leading slash)

### Fix 24 (2026-02-22) - Duplicate Key Violations During Library Scanning
- **Root cause**: Concurrent scan workers create separate `media_items` from slightly different filename parses (e.g., "Avatar The Last Airbender" vs "Avatar - The Last Airbender"). Both resolve to the same TMDB/TVDB entry. When `UpdateMediaMetadata` sets canonical title+year or tmdb_id, it violates unique constraints (`uq_media_items_lib_type_title_year` or `idx_media_items_tmdb`).
- **Fix**: 3-layer approach:
  1. `UpdateMediaMetadata` now catches PgError 23505, identifies the canonical item via `findCanonicalItem()`, returns `*DuplicateMetadataError`
  2. `MergeMediaItems(canonical, duplicate)` transactionally reassigns all child records (media_files, tv_seasons/episodes/episode_files, watch_progress, artwork, cast, genres, external_ids) then deletes the duplicate. Handles overlapping seasons/episodes gracefully.
  3. All 5 `UpdateMediaMetadata` call sites in `enricher.go` check for `DuplicateMetadataError` via `handleDuplicateMetadata()` -- merges and continues without error.
- **Files**: `internal/db/queries_phase2.go` (DuplicateMetadataError, findCanonicalItem, MergeMediaItems), `internal/metadata/enricher.go` (handleDuplicateMetadata + 5 call sites)

## Key Debugging Patterns (continued)
18. **Concurrent scan duplicate items**: Filename parser variations create separate media_items for the same show/movie. TMDB enrichment normalizes titles, causing unique constraint violations on UPDATE (not INSERT). Fix: detect 23505 on UPDATE, find canonical item, merge children, delete duplicate.
19. **Video element src cleanup**: Always use `vid.removeAttribute('src'); vid.load()` instead of `vid.src=''`. Empty string src causes browser to fetch current page URL as media. Also: destroy HLS.js instance BEFORE clearing vid.src to let `detachMedia()` run cleanly.
20. **HLS.js + native player interference**: Before `attachMedia()`, fully reset the video element (`pause`, `removeAttribute('src')`, `load()`) to cancel any in-flight native player requests from a prior `vid.src` assignment (e.g., failed direct play fallback). Prevents duplicate unauthenticated m3u8 requests.
21. **`<track>` subtitle auth**: Like `<video>`/`<img>`, `<track src>` can't set Authorization headers. Append `&token=` to subtitle URLs. Best practice: append token at click time (in `setSubtitle`) not at menu-build time, so refreshed tokens are used during long playback sessions.
22. **Player state cleanup on close**: `closePlayer()` must reset ALL player UI state: DOM text (title, subtitle bar), state vars (`S.currentTitle`, `S.mediaId`, `S.episodeId`), and timers. Every entry point to `playMedia()` must set `S.currentTitle` before calling it -- not just `loadDetail()`. Functions that fetch an `item` and then call `playMedia()` (like `playFromDetail`, `resumePlayback`) must also set `S.currentTitle = item.title`.

### Audit 25 (2026-02-22) - Re-audit of Fixes 1-4 (Image Proxy, HLS, Subtitles, Merge)
- **25th**: 4 findings across 3 files, ALL FIXED:
  1. **HIGH: SSRF via redirect bypass in `downloadToCache`** -- `http.Client` follows redirects by default. Allowed host (e.g. artworks.thetvdb.com) could 302 to internal IP. FIXED: Added `CheckRedirect` that validates each redirect target against `allowedImageHosts`.
  2. **MEDIUM: Missing domain validation in `FetchAndCache`/`GetBlurhash`** -- Both called `fetchAndCacheURL` for external URLs without checking `allowedImageHosts`. FIXED: Added `validateExternalHost()` shared helper, called from all 3 entry points (`serveExternalImage`, `FetchAndCache`, `GetBlurhash`).
  3. **LOW: `filepath.Ext` returns query params on URLs** -- `filepath.Ext("file.jpg?v=2")` = `.jpg?v=2`, causing wrong cache file extension. FIXED: Strip `?` suffix from extension in `localPath()`.
  4. **MEDIUM: `MergeMediaItems` loses watch_progress for reassigned episodes** -- When episodes are reassigned to canonical (not merged), their `watch_progress.media_item_id` still points to the duplicate. The final `DELETE FROM media_items` CASCADE deletes those rows. FIXED: Added `UPDATE watch_progress SET media_item_id` in both reassignment branches.
  - Fixes 2 (HLS 401) and 3 (subtitle auth) audited clean -- no issues found.

23. **SSRF redirect validation**: Go's `http.Client` follows up to 10 redirects by default. When proxying external URLs, always set `CheckRedirect` to validate redirect targets against the domain allowlist. Initial host validation alone is insufficient.
24. **Domain validation at every entry point**: When a function like `fetchAndCacheURL` can be called from multiple code paths (HTTP handler, eager cache, blurhash gen), domain validation must be in each caller or in the function itself -- not just in one caller.
25. **`filepath.Ext` on URLs**: Go's `filepath.Ext` treats `?` as part of the extension. Always strip query params before extracting extension from URLs.
26. **FK CASCADE data loss during merge**: When reassigning child records (episodes) from one parent (media_item) to another, also update any grandchild records (watch_progress) that have a direct FK to the old parent. Otherwise `DELETE parent CASCADE` silently destroys them.

### Fix 26 (2026-02-22) - HEVC Remux HLS.js Failure
- **Root cause**: HLS.js v1.5.17 (used by Aurora) cannot demux HEVC NAL units from MPEG-TS (.ts) segments. HEVC in .ts was only added in HLS.js v1.6.0 (March 2025). When Chrome on macOS reports HEVC support via `MediaSource.isTypeSupported`, the decision engine returns `direct_stream` with `remux=true` for MKV HEVC files. FFmpeg copies the HEVC video stream (`-c:v copy`) into HLS .ts segments, which HLS.js then fails to demux, producing "otherError" after 1-2 segments.
- **Fix**: Added `remuxVideoOK` variable in `DecidePlayback`. When video is HEVC and client uses HLS.js (`HLSJS=true && !HLSNative`), `remuxVideoOK=false` forces the transcode path (HEVC->H.264) instead of remux. Direct play from MP4/MOV containers is unaffected (uses `videoOK`, not `remuxVideoOK`). Safari with native HLS continues to get HEVC remux since `HLSNative=true`.
- **Files**: `internal/streaming/streaming.go` (DecidePlayback), `internal/streaming/decision_test.go` (8 new tests, chromeHEVCCaps profile)

27. **HLS.js HEVC .ts limitation**: HLS.js <1.6.0 only supports HEVC in fMP4 containers, NOT in MPEG-TS (.ts). FFmpeg's `-f hls` defaults to .ts segments. When the decision engine would remux HEVC into HLS, it must check whether the client uses HLS.js -- if so, force full transcode to H.264. Safari's native HLS player handles HEVC in .ts natively, so remux is fine there. Use separate `videoOK` (for direct play) vs `remuxVideoOK` (for remux paths) to distinguish.

### Audit 27 (2026-02-22) - Vulnerability Scanner Exposure Audit
- **27th**: Assessed server exposure to common scanner probes (dotfiles, path traversal, directory listing, info leakage). 2 findings, both FIXED:
  1. **MEDIUM: Directory listing on `/static/`** -- `http.FileServer` generates HTML directory index when no `index.html` exists. FIXED: `safeFileServer()` wrapper blocks requests ending with `/`.
  2. **MEDIUM: Dotfiles/backup files served from `/static/`** -- `http.FileServer` does not filter dotfiles. A `.env` accidentally placed in `static/` would be served. FIXED: `safeFileServer()` blocks path components starting with `.` and extensions `.bak`/`.old`/`.orig`/`.swp`.
  - NOT VULNERABLE: Path traversal (Go's `http.Dir` sanitizes `..`), no Server/X-Powered-By headers leaked, Chi 404 is minimal plain text.
  - NOTED (not fixed): `/api/health` exposes version/uptime/disk/db_status publicly -- standard practice for monitoring, design decision.
- **Files**: `internal/api/router.go` (safeFileServer + route change), `internal/api/static_security_test.go` (17 test cases)

28. **Go `http.FileServer` serves dotfiles and directory listings**: Unlike Nginx/Apache, Go's `http.FileServer(http.Dir(...))` has NO built-in dotfile filtering or directory listing suppression. Always wrap with a filter handler when serving user-facing static content. The `safeFileServer()` pattern blocks: dotfile path components (`.env`, `.git/*`), backup extensions (`.bak`, `.old`, `.orig`, `.swp`), and directory listing requests (trailing `/`).

### Audit 28 (2026-02-22) - 4K Version Selector Feature
- **28th**: 8 findings (1 HIGH, 4 MEDIUM, 3 LOW) across 10 files:
  1. **HIGH: `GetMediaItemsWith4K` only queries `media_files`** -- TV shows store files in `episode_files` (via `tv_episodes`), so TV shows NEVER get `has_4k=true`. Fix: UNION with `episode_files JOIN tv_episodes`.
  2. **MEDIUM: ORDER BY references "4K HDR" but nothing produces it** -- `ClassifyVersion` returns "4K", "1080p", "720p", "SD", or "". Dead CASE branch. Remove or implement HDR detection.
  3. **LOW: Migration backfill misses "UHD" resolution** -- Rare edge case since ffprobe provides WIDTHxHEIGHT.
  4. **LOW: `ClassifyVersion` accepts unused `videoCodec` param** -- Code hygiene.
  5. **LOW: Episode `data-file-id=0` edge case** -- `parseInt("0")` is falsy but DB IDs start at 1.
  6. **MEDIUM: `S.selectedFileId`/`S.detailFiles` not cleared on nav** -- Mitigated by `S.detailId === mediaId` guard, but stale state.
  7. **MEDIUM: `GetMediaItemsWith4K` errors silently swallowed** -- No logging when 4K badge annotation fails.
  8. **MEDIUM: `GetEnriched` computes `has_4k` from movie files only** -- Same root cause as #1.
- **Files**: `queries_phase2.go`, `queries.go`, `010_version_tags.up.sql`, `scanner.go`, `media_handlers.go`, `phase2_handlers.go`, `aurora_pro.html`, `scanner_version_test.go`

29. **Cross-table feature queries for TV shows**: TV show data is split across `media_items` -> `tv_seasons` -> `tv_episodes` -> `episode_files`. Any aggregation query (like "does this show have 4K files?") must join through the episode chain. Queries that only check `media_files` will silently return empty results for TV shows with no functional error.

### Audit 29 (2026-02-22) - Exhaustive 4K Version Selector Deep Audit
- **29th**: Full lifecycle audit tracing 4K files from disk to playback. 11 findings (2 HIGH, 3 MEDIUM, 6 LOW):
  1. **HIGH: `ParseTVPath` does NOT strip `[4K]`/`[UHD]` from show folder names** -- `Shows/Breaking Bad [4K]/` creates a SEPARATE media_item from `Shows/Breaking Bad/`. Root cause: `extractTitleYear` only strips content after year patterns; brackets not in `reClean` or `TrimRight`. Two separate enrichments, split watch progress.
  2. **HIGH: `extractTitleYear` fails when `[4K]` folder has no year** -- `Movies/Inception [4K]/` produces title="Inception [4K]" instead of "Inception". Same root cause: no year means nothing is stripped after it.
  3. **MEDIUM: `GetEnriched` has_4k still only checks `media_files`** -- TV show detail page always shows `has_4k=false`. List endpoints fixed (UNION query from Audit 28), but detail handler not updated.
  4. **MEDIUM: No orphan file cleanup in scanner** -- Deleted 4K files persist in DB. Stale `has_4k` badges, phantom version options, playback errors on deleted files.
  5. **MEDIUM: `S.detailFiles`/`S.selectedFileId` not cleared at top of `loadDetail`** -- If `loadDetail` throws, stale state from previous movie persists. Mitigated by `S.detailId===mediaId` guard.
  6-11. **LOW**: Migration "UHD" gap, unused videoCodec param, parseInt("0") edge case, version selector by design for TV shows, ORDER BY CASE correct, XSS properly escaped.
- **Files**: `parser.go`, `scanner.go`, `phase2_handlers.go`, `aurora_pro.html`, `010_version_tags.up.sql`

30. **Title parser quality suffix stripping**: `ParseMoviePath`/`ParseTVPath` extract raw folder names. Quality markers like `[4K]`, `[UHD]`, `[HDR]`, `[REMUX]` in brackets/parens must be stripped BEFORE title matching, or they pollute the unique key and create duplicate `media_items`. The `extractTitleYear` function strips everything after the year but only if a year exists. Use a dedicated `reQualitySuffix` regex to remove `[\[\(]\s*(4K|UHD|2160p|1080p|720p|HDR|HDR10|DV|Dolby Vision|REMUX|3D)\s*[\]\)]` from titles.
31. **Scanner lacks orphan cleanup**: `ScanLibrary` discovers and upserts files but never removes DB rows for files deleted from disk. Stale rows affect `has_4k`, version selectors, file counts. Needs a post-scan phase comparing DB file paths against discovered paths.

### Audit 30 (2026-02-22) - Cross-Library Version Linking Feature
- **30th**: 11 findings (2 HIGH, 4 MEDIUM, 5 LOW) across 7 files:
  1. **HIGH: Pagination broken by post-query deduplication** -- `List` handler deduplicates AFTER DB pagination. Users see fewer items than `per_page`, totals are inconsistent between pages, some items invisible. Fix: SQL-level dedup with `DISTINCT ON` or over-fetch+trim.
  2. **HIGH: `findCanonicalItem` for `idx_media_items_tmdb` is dead code** -- Migration 011 drops UNIQUE on tmdb_id. The 23505 catch for this constraint can never fire. Same-library dups with same tmdb_id but different parsed titles won't merge anymore. Dead `case "idx_media_items_tmdb":` branch.
  3. **MEDIUM: N+1 query in GetEpisodes** -- Each episode triggers 2 queries for cross-lib files (season/ep lookup + file query). 24-episode season = 48 extra queries. Fix: batch function.
  4. **MEDIUM: GetCrossLibraryFiles 2 queries when 1 suffices** -- tmdb_id lookup + file query. Combine with subquery.
  5. **MEDIUM: `GetMediaItemsWith4KCrossLibrary` lacks tmdb_id > 0 guard** -- Other cross-lib functions check >0, this one only checks IS NOT NULL. tmdb_id=0 would cause all unenriched items to match.
  6. **MEDIUM: DeduplicateByTMDBID queries DB for data already in memory** -- Extra round-trip to fetch tmdb_ids that could be loaded alongside items.
  7-11. **LOW**: Episode version selector consistent XSS escaping, silenced json.Unmarshal, no integration tests, redundant episode lookup query, down migration lacks pre-check.
- **Security**: No library-level access control exists (design decision). SQL injection safe. File paths not exposed. TMDB ID no overflow.
- **Files**: `queries_crosslib.go`, `queries_crosslib_test.go`, `media_handlers.go`, `phase2_handlers.go`, `aurora_pro.html`, `011_cross_library_linking.up.sql`, `011_cross_library_linking.down.sql`

32. **Post-query deduplication breaks pagination** (NOW FIXED): Application-level dedup after `LIMIT/OFFSET` caused items to disappear between pages. The `adjustedTotal` computation conflated overfetch trimming with actual dedup removals, under-counting total items and making `totalPages` too low. Fix: moved dedup to SQL level using `DISTINCT ON (COALESCE(NULLIF(tmdb_id,0)::bigint, -id))` in `GetMediaItems`. Both COUNT and data query now operate on the deduped subquery, making pagination exact. Handler no longer needs overfetch/dedup/trim.
33. **Dropping a UNIQUE index creates dead code in constraint-catch paths**: When a migration changes an index from UNIQUE to non-unique, all Go code catching `23505` (unique violation) for that index name becomes dead code. Same-table duplicate handling that relied on the constraint must be replaced with explicit application-level checking.

### Audit 31 (2026-02-22) - Safari Audio / Full Pipeline Audit
- **31st**: 7 findings (2 HIGH, 3 MEDIUM, 2 LOW) across streaming.go, aurora_pro.html, profiles.go
  1. **HIGH: HLS.js-vs-native mismatch breaks Safari audio** -- Server assumes Safari uses native HLS (hls_native=true skips guards), but frontend always uses HLS.js when `Hls.isSupported()` is true (macOS Safari supports MSE). HLS.js v1.5.17 cannot demux AC3/EAC3 from .ts. Decision engine says "passthrough AC3/EAC3" for Safari -> FFmpeg copies into .ts -> HLS.js fails -> NO AUDIO.
  2. **HIGH: HEVC remux guard bypassed on macOS Safari** -- Same root cause: guard checks `HLSJS && !HLSNative`, but Safari has both true. Guard doesn't fire. Server sends HEVC remux, frontend uses HLS.js which can't demux HEVC from .ts.
  3. **MEDIUM: `findBestAudioTrack` forces unnecessary remux when no track marked default** -- If no track has IsDefault=true, first compatible track returns isDefault=false, blocking direct play.
  4. **MEDIUM: Static fallback passes through FLAC/Vorbis in remux** -- DirectPlayAudioCodecs includes FLAC/Vorbis but HLS.js can't demux them from .ts.
  5. **MEDIUM: Full transcode forces stereo** -- All profiles have AudioChannels=2, `-ac 2` downmixes surround. Remux correctly omits `-ac`.
  6. **LOW: NormalizeContainer redundant** -- Scanner pre-normalizes at scan time; defense-in-depth only.
  7. **LOW: HLS.js TS demuxer codec coverage** -- Only AAC, MP3, AC-3 supported. EAC3, FLAC, Vorbis, Opus, DTS all fail if passthrough into .ts.

34. **HLS.js vs native HLS mismatch**: macOS Safari supports both MSE (Hls.isSupported()=true) and native HLS. Frontend always prefers HLS.js. Server decision engine uses hls_native to skip codec guards. Fix: decision must be based on what the FRONTEND actually uses, not what the browser theoretically supports. Either: (a) frontend sends a single `hls_player=hlsjs|native` flag, or (b) server treats any client with HLSJS=true as HLS.js-only for codec guard purposes.
35. **Audio passthrough must match HLS.js TS demuxer capabilities**: HLS.js v1.5.17 TS demuxer only handles AAC, MP3, and AC-3 (with build flag). Any other codec passed through into .ts segments will produce silent audio. The decision engine must NOT set AudioPassthrough=true for codecs HLS.js can't demux, UNLESS the client uses native HLS.

### Fix 32 (2026-02-22) - HLS.js Remux-to-Transcode Fallback Too Aggressive
- **Root cause**: Single `hlsRecoveryAttempts` counter mixed NETWORK_ERROR and MEDIA_ERROR. Threshold of 2 (3 errors) triggered fallback from transient network issues (segment not yet ready during remux). 401 handler lacked concurrency guard -- multiple 401s caused multiple `doRefresh()`/`startLoad()` calls, confusing HLS.js state.
- **Fix**: Separate `mediaErrorCount`/`networkErrorCount` counters. Only MEDIA_ERROR triggers remux fallback (threshold raised to >3). Network errors allow up to 6 retries. Added `refreshing` flag to prevent concurrent 401 refresh. Added `thisHls` reference check to ignore stale handler events.
- **File**: `static/aurora_pro.html` (setupHLSPlay error handler)

36. **HLS.js error handler design**: Never mix NETWORK_ERROR and MEDIA_ERROR into a single recovery counter. Network errors are transient (segments not ready during remux, brief server hiccups) and should NOT trigger codec-related fallbacks. Media errors indicate persistent incompatibility. Use separate counters with different thresholds. Guard async 401 refresh with a flag to prevent concurrent `doRefresh()`/`startLoad()`.

### Audit 32 (2026-02-23) - Decision Engine Batch Audit
- **32nd**: 10 findings (1 HIGH, 4 MEDIUM, 5 LOW). See [audit-33-hls-subtitles.md](audit-33-hls-subtitles.md) for details.

### Audit 33 (2026-02-24) - HLS Inline Subtitle Pipeline (Emby-style)
- **33rd**: 4 MEDIUM, 4 LOW. 3 MEDIUM FIXED. See [audit-33-hls-subtitles.md](audit-33-hls-subtitles.md)

### Fix 34 (2026-02-24) - HLS.js subtitleTracks empty at MANIFEST_PARSED
- **ROOT CAUSE**: `hls.subtitleTracks` getter returns `tracksInGroup` (not `tracks`). `tracksInGroup` is populated in `switchLevel()` triggered by `LEVEL_SWITCHING` which fires AFTER `MANIFEST_PARSED`. Code called `loadHLSSubtitles(hls)` at `MANIFEST_PARSED` -> empty array -> fell through to on-demand extraction fallback (which requires reading entire MKV file, taking minutes for 4K files).
- **Fix**: Listen for `Hls.Events.SUBTITLE_TRACKS_UPDATED` event instead. Added 3s timeout safety net: if event never fires, falls back to on-demand extraction. Applied to both primary and fallback (transcode) HLS instances. Cleanup in `closePlayer()`.
- **File**: `static/aurora_pro.html`

37. **HLS.js subtitleTracks timing**: `hls.subtitleTracks` is EMPTY at `MANIFEST_PARSED`. The getter returns `tracksInGroup` which is only populated after `LEVEL_SWITCHING` -> `switchLevel()` -> `SUBTITLE_TRACKS_UPDATED`. Always use `Hls.Events.SUBTITLE_TRACKS_UPDATED` to detect when subtitle tracks are available, never check at `MANIFEST_PARSED`.
  - FIXED: HLS playlist injection via subtitle metadata (`sanitizeHLSAttr()`)
  - NOTED: Subtitle segment list lacks EXT-X-PLAYLIST-TYPE:EVENT (minor perf)

37. **FFmpeg multi-output subtitle extraction**: Subtitle output chains are appended AFTER the HLS video/audio output. Each sub track gets `-map 0:N? -vn -an -c:s webvtt -f segment`. The trailing `?` on `-map` makes the subtitle stream optional -- if it doesn't exist, FFmpeg skips it instead of killing the entire command (which would also kill video/audio).
38. **HLS attribute injection**: Always sanitize text from FFprobe metadata (track titles, languages) before interpolating into m3u8 playlists. Strip `"`, `\n`, `\r` to prevent attribute breakout or line injection.
  - 5 LOW: missing macSafari+VP9 test, no `injectTonemapFilter` unit tests, dead `QualityProfile.AudioBitrate`/`AudioChannels` fields, no upper cap on audio bitrate, theoretical native HLS VP9 edge case.

### Audits 34-35 (2026-02-23 to 2026-02-25) - Misc Fixes
- **34th**: ILIKE double-escape (Sprintf chain), invite code autofill, FFmpeg subtitle PTS desync
- See [subtitle-sync-fix.md](subtitle-sync-fix.md) for subtitle PTS details

### Audit 35 (2026-02-26) - Requests & Watch Party Integration
- **35th**: 9 findings (3 HIGH, 4 MEDIUM, 2 LOW) across 20 files. ALL HIGH/MEDIUM FIXED.
- See [audit-34-requests-watchparty.md](audit-34-requests-watchparty.md) for full details
  1. **HIGH: Frontend WS message format mismatch** -- flat vs {type,payload} envelope. FIXED.
  2. **HIGH: Migration FK `episodes(id)` should be `tv_episodes(id)`**. FIXED.
  3. **HIGH: Concurrent WS writes** -- gorilla/websocket no concurrent writers. FIXED: SafeConn wrapper.
  4. **MEDIUM: Service status response format mismatch**. FIXED.
  5. **MEDIUM: Active parties response format + field name mismatch**. FIXED.
  6. **MEDIUM: Deadlock -- reversed lock ordering in cleanupOnce/ActiveParties**. FIXED: snapshot+iterate.
  7. **MEDIUM: TOCTOU race in CreateParty**. FIXED: re-check under write lock.

46. **gorilla/websocket concurrent write protection**: gorilla/websocket does NOT support concurrent writers. When multiple goroutines write to the same connection (ping, broadcast, direct message, error sends), wrap with a `SafeConn` that serializes all writes with a mutex. Both `WriteMessage` and `WriteControl` need protection.
47. **Lock ordering in Manager pattern (RWMutex + per-item Mutex)**: Never hold the top-level `m.mu` (RLock or Lock) while acquiring a per-item `ps.mu`. Use snapshot+iterate: collect references under RLock, release, then lock individual items. `endPartyInternal` acquires `ps.mu` then `m.mu.Lock` -- if cleanup holds `m.mu.RLock` and tries `ps.mu.Lock`, Go's RWMutex blocks the write Lock until all RLocks release, causing deadlock.
48. **TOCTOU in create-with-uniqueness-check**: When checking "does user already have X?" under RLock then creating under Lock, re-check under the write lock. The DB insert may succeed but the in-memory check was stale. Clean up the DB row if the re-check fails.

### Audit 36 (2026-02-26) - ARR Admin Settings & Hot-Reload
- **36th**: 9 findings (2 HIGH, 4 MEDIUM, 3 LOW) across 6 files. ALL HIGH/MEDIUM FIXED.
  1. **HIGH: Masked API keys writable back to DB** -- `_api_key` validators accepted anything (`return true`). Masked values like `****ab12` from GetSettings could corrupt saved keys. FIXED: `isMaskedAPIKey()` rejects values starting with `*`.
  2. **HIGH: TestARRConnection lacks URL validation** -- Admin SSRF via arbitrary URL. FIXED: added `isValidARRURL()` check.
  3. **MEDIUM: `h.arrClients.UpdateRadarr` panics if arrClients nil** -- Method ref evaluated before `reloadARRClient` nil guard. FIXED: outer `if h.arrClients != nil` guard.
  4. **MEDIUM: Duplicate reloadARRClient calls** -- Both URL+key in same request triggers 2 reloads. FIXED: `arrReload` set deduplicates.
  5. **MEDIUM: `loadARRSettingsFromDB` uses `||` instead of `&&`** -- Single DB key destroys config-file client. FIXED: changed to `&&`.
  6. **MEDIUM: reloadARRClient swallows DB errors** -- FIXED: added slog.Warn.
  7-9. **LOW**: Router indentation (FIXED), settings page re-render (design), test button needs re-entry (design).

49. **API key masking write-back**: When an API returns masked secrets (e.g. `****ab12`), the UPDATE endpoint MUST reject masked values. Client-side prevention (not sending empty fields) is insufficient -- direct API calls bypass it. Validate with `isMaskedAPIKey()`.
50. **Method ref on nil receiver**: `h.arrClients.UpdateRadarr` evaluates the method reference at call site, not inside the called function. If `h.arrClients` is nil, this panics BEFORE the nil guard inside `reloadARRClient`. Always guard before passing method refs.
51. **Deduplicate hot-reload calls**: When a settings map contains both `X_url` and `X_api_key`, map iteration calls reload twice. Use a `map[string]bool` to track which services need reload, execute once after all DB writes.
52. **DB override with incomplete pair**: `loadSettingsFromDB` should require BOTH url AND api_key from DB before overriding config-file defaults. A single key with `||` condition nils out a working client.

### Audit 37 (2026-02-28) - Watch Party Auto-Play Feature
- **37th**: 3 findings (1 HIGH, 1 MEDIUM, 1 LOW) in `aurora_pro.html` lines 3719-3780:
  1. **HIGH: TV show parties play wrong episode** -- `playFromDetail` uses per-user `next-episode` API. Different guests get different episodes. Sync only adjusts `currentTime`, not episode identity. Also: `createPartyFromDetail` never sends `episode_id`.
  2. **MEDIUM: Double playFromDetail on rapid participant-join** -- `S.mediaId` stale during async gap. `_playMediaActive` in `playMedia` partially mitigates but wasted API calls and `closePlayer()` disruption possible. Fix: `_partyAutoPlayPending` flag.
  3. **LOW: Re-auto-play after manual player close** -- `closePlayer` nulls `S.mediaId`, next `participant-join` re-triggers.

53. **playFromDetail is per-user for TV shows**: Uses next-episode algorithm (varies by watch progress). Shared contexts (watch parties) must pass explicit episode/file IDs.
54. **Async event guard pattern**: Set guard flag synchronously BEFORE first `await`, not inside the called async function. Multiple WS events can trigger same async chain before first completes.
55. **broadcastToPartyLocked includes joiner**: Server adds joiner to `ps.conns` before broadcast. Joiner gets `participant-join` for self before `party-state`. Frontend guards with `if(S.partyState)` null check.
56. **HLS master CODECS must match .ts payload exactly**: `hlsCodecString` in `internal/streaming/streaming.go:1042` hard-codes `avc1.XXXXXX,mp4a.40.2` (H.264+AAC) regardless of actual encoder output. If `DecidePlayback` returns `decision=transcode` with `AudioPassthrough=true` for a non-AAC codec (MP3/AC3), FFmpeg copies the original audio into .ts while the master playlist advertises AAC — HLS.js throws `bufferAppendError` on first audio append. Any change to the HLS-path audio allow-list (`streaming.go:262`) must be mirrored in `hlsCodecString`, OR the transcode-branch return at `streaming.go:320` must force `AudioPassthrough=false`. Trigger combo in the wild: MPEG-4/DivX/Xvid video + MP3 audio (forces video transcode, MP3 is in the HLS.js passthrough allow-list).

## Known Remaining Issues (documented, not fixed)
- Second Audit items 1-6: Low-severity streaming lock/I/O patterns (acceptable tradeoffs)
- Third Audit items 6-7: Unbounded image/subtitle caches (no eviction policy)
- Fourth Audit: Dead code (MediaHandler.Get, unused query/model functions)
