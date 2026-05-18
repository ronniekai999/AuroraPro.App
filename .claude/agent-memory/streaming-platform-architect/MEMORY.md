# Aurora Media Server - Architecture Notes

## Stack
- Go 1.23, Chi router, pgx/v5 (PostgreSQL), gorilla/websocket, golang-jwt
- Argon2id passwords, structured logging via log/slog

## Project Structure
- `cmd/aurora/main.go` - entry point, wires all services
- `internal/api/` - HTTP handlers (auth_handlers.go, media_handlers.go, phase2_handlers.go, router.go, helpers.go, admin_handlers.go)
- `internal/auth/` - JWT service (auth.go), middleware.go (RequireAuth, RequireAdmin, GetClaims), ratelimit.go
- `internal/db/` - Queries struct on pgxpool: queries.go, queries_phase2.go, queries_phase4.go, pool.go
- `internal/config/` - YAML + env overlay config
- `internal/library/` - scanner, parser, ffprobe, watcher, nfo
- `internal/metadata/` - TMDB/TVDB clients, enricher, image proxy, blurhash
- `internal/streaming/` - HLS transcode manager, hw accel detection, subtitle support, direct play
- `internal/websocket/` - Hub with broadcast, client management, ping/pong
- `internal/httputil/` - WriteJSON, WriteError shared helpers
- `internal/models/` - all shared types in single models.go

## Key Patterns
- Handler structs: `NewXxxHandler(deps) *XxxHandler` with method receivers
- `writeJSON/writeError` in api package delegate to httputil
- `decodeJSON` with MaxBytesReader (1MB limit)
- Auth claims: `auth.GetClaims(r.Context())` returns `*auth.JWTClaims{UserID, Username, Role}`
- AuthHandler uses field `authSvc` (not `auth`): `h.authSvc.HashPassword()`, `h.authSvc.VerifyPassword()`
- Router constructor takes RouterDeps struct, builds full route tree
- DB queries are hand-written SQL with pgx, no ORM
- WebSocket Hub: Broadcast(), BroadcastToAdmins(), BroadcastToUser()
- WebSocket event constants in `internal/websocket/events.go` (EventScanProgress, EventNowPlaying, etc.)
- TranscodeManager.OnSessionEvent callback fires on session create/stop/expire, wired in main.go to BroadcastToAdmins
- TranscodeSession: FileName, UserID, Remux, AudioPassthrough; GetSession returns (*TranscodeSession, bool)
- ProgressHandler has `hub *ws.Hub` dep for progress_sync broadcasts (wired via NewProgressHandler)

## DB Query Distribution
- queries.go: users, tokens, invites, libraries, media items/files, batch ops, UpdateUserPassword
- queries_phase2.go: metadata, genres, artwork, cast, TV, watch progress, enriched media, GetEpisodeNowPlayingInfo
- queries_phase4.go: activity, profiles, watchlists, settings, dashboard stats

## Phases Complete (1-4)
- Phase 1: Schema, auth, scanner, watcher, REST API, WebSocket
- Phase 2: TMDB/TVDB metadata, image proxy, artwork/cast/genres, watch progress
- Phase 3: Direct play, HLS transcode, hw accel, subtitles, session management
- Phase 4: Profiles, watchlists, admin dashboard, activity log, settings, now_playing, deployment

## Multi-Track Metadata (Feature 1)
- Migration 008: audio_tracks/subtitle_tracks JSONB columns on media_files + episode_files
- marshalTracks() helper in queries.go for consistent JSON serialization
- All 10 SELECT/INSERT/UPSERT functions updated: UpsertMediaFile, GetMediaFileByPath, GetMediaFiles, BatchInsertMediaFiles, BatchInsertEpisodeFiles, GetEpisodeFiles, UpsertEpisodeFile, GetEpisodeFileByPath, GetMediaFileByID, GetEpisodeFileByID
- Scanner copies probeResult.AudioTracks/SubtitleTracks to both MediaFile and EpisodeFile
- Frontend: "Media Info" section in loadDetail after cast, uses insertAdjacentHTML('afterend') on detailCast

## Runtime Hot-Reload
- TranscodeManager.SetMaxSessions(n), Watcher.SetScanInterval(d)
- AdminHandler.UpdateSettings applies changes immediately after DB save

## Gap Fixes Applied (Session 2)
- SearchMedia: overview added to WHERE clause (queries.go)
- FFprobe: multi-track audio/subtitle capture (ffprobe.go, AudioTrack/SubtitleTrack in models.go)
- Scanner: batch inserts with mutex-guarded buffer, flush at 100 or end-of-scan (scanner.go, BatchInsertEpisodeFiles in queries.go)
- MetadataProvider interface in provider.go; TMDBClient satisfies it
- Levenshtein distance in strings.go, used by MatchConfidence in tmdb.go
- match_status column via migration 007; enricher flags <85 confidence as needs_review
- Eager image caching: FetchAndCache on ImageProxy, Enricher takes optional imgProxy
- H.264 baseline profile flags in hwaccel.go for libx264/NVENC/QSV/AMF
- Bandwidth estimation: atomic BytesServed on TranscodeSession, BandwidthBps in ListSessions
- /api/stream/{fileID}/direct alias route
- TLS/autocert support in config.go + main.go (golang.org/x/crypto/acme/autocert)
- Dashboard: CPUPercent, DiskFreeGB via syscall.Statfs in admin_handlers.go
- WS health push: disk_free_gb and cpu_count added to periodic broadcast in main.go
- Custom RequestLogger middleware replaces chi middleware.Logger (logging_middleware.go)

## Test Suite (Session 3)
- 321 test cases across 5 packages, all passing, plus 14 benchmarks
- Test files: parser_test.go, parser_bench_test.go, nfo_test.go, strings_test.go, strings_bench_test.go, tmdb_test.go, auth_test.go, ratelimit_test.go, hwaccel_test.go, profiles_test.go, config_test.go, subtitles_test.go
- NFO fixtures in internal/library/testdata/nfo/ (movie_kodi.nfo, movie_url.nfo, movie_imdb.nfo)
- Parser: extractTitleYear now strips trailing parentheses via TrimRight (fixed in M6 audit)
- Config tests use t.Setenv + AURORA_CONFIG_FILE=/nonexistent to isolate from real config
- Auth tests use low Argon2 iterations (1) for speed

## Static File Serving & CSP (Session 5)
- RouterDeps.StaticDir field: path to static files directory
- findStaticDir() in main.go: searches CWD, exe-relative, /opt/aurora/static
- Root `/` serves aurora_pro.html; `/static/*` serves static file directory
- Two CSP policies: `securityHeaders` (restrictive, API only), `frontendHeaders` (permissive, SPA)
- frontendHeaders allows: inline scripts, cdn.jsdelivr.net, image.tmdb.org, ws/wss, blob: media
- securityHeaders: `default-src 'none'; frame-ancestors 'none'` (API-only)
- Dockerfile: `COPY --from=builder /build/static ./static`
- install.sh: copies static/ to /opt/aurora/static, auto-generates JWT_SECRET
- GetDiskFreeGB is exported (capital G) in api package, used by both router.go and main.go

## Frontend (aurora_pro.html) - Session 4
- Single-page app at `/static/aurora_pro.html`, all JS inline in `<script>` tag
- hls.js from CDN for HLS playback; direct play via native `<video>` element
- State object `S` holds token, user, profile, ws, hls, sessionId, etc.
- `api()` wrapper handles JWT auth, 401->refresh->retry, JSON serialization
- WebSocket at `/ws?token=` with exponential backoff reconnect
- 72 API endpoints wired, 7 WS events handled (scan_progress, now_playing, etc.)
- Images use `/api/images/w500/` (posters) and `/api/images/original/` (backdrops), public no auth
- Transcode: POST /api/stream/sessions -> {session_id, master_playlist}; hls.js auto-fetches variants+segments
- Progress reporting every 10s during playback via PUT /api/progress/{mediaId}
- DOM IDs match task spec; all views navigated via `navigateTo(view, param)`

## Bug Fixes Applied (Session 6)
- WriteError returns `{error:{code,message}}` (nested object); frontend api() now extracts `.message` string
- `/api/auth/setup-status` public endpoint: returns `{has_users, requires_invite, is_initial_setup}`
- Frontend auto-detects first-user setup: hides invite code field, shows "Initial Setup" title
- `initAuth()` auto-shows register form when `is_initial_setup` is true

## File-Based Logging with Rotation
- lumberjack v2 (`gopkg.in/natefinch/lumberjack.v2`) for log rotation
- LogConfig struct in config.go: Dir, Level, MaxSizeMB, MaxBackups, MaxAgeDays, Compress
- Defaults: /var/log/aurora, info, 100MB, 5 backups, 30 days, gzip on
- Env vars: LOG_DIR, LOG_LEVEL, LOG_MAX_SIZE_MB, LOG_MAX_BACKUPS, LOG_MAX_AGE_DAYS, LOG_COMPRESS
- YAML section: `logging:` with dir, level, max_size_mb, max_backups, max_age_days, compress
- main.go: bootstrap logger (stdout only) before config load, then io.MultiWriter(stdout, lumberjack) after
- ParseLogLevel() in config.go: debug/info/warn/error string to slog.Level
- Lumberjack logger closed in shutdown section of main.go
- aurora.service: /var/log/aurora added to ReadWritePaths
- install.sh: creates /var/log/aurora with aurora:aurora ownership

## Version Tags / 4K Quality Tiers (Session 7)
- Migration 010: `version_tag VARCHAR(50)` on media_files + episode_files, indexes, backfill from resolution
- `ClassifyVersion(resolution, videoCodec)` in scanner.go: "4K"/"1080p"/"720p"/"SD"/""
- All 10 media/episode file queries updated to include version_tag column
- GetMediaFiles/GetEpisodeFiles ORDER BY quality: 4K HDR > 4K > 1080p > 720p > SD
- `GetMediaItemsWith4K(ids)` batch query for has_4k badges on list/search/recent
- MediaItem.Has4K field annotated by List, Recent, Search handlers + GetEnriched
- Frontend: `card-badge-4k` CSS class on cards, `version-selector` segmented control on detail
- S.selectedFileId/S.detailFiles state for version selection; playFromDetail/resumePlayback use it
- Episode version: 4K/multi-version badges + `<select>` dropdown per episode row
- `playEpisodeFromEl(el)` reads data-file-id from closest episode-item for version selection
- scanner_version_test.go: 16 test cases for ClassifyVersion

## Cross-Library Version Linking (Session 8)
- Migration 011: dropped UNIQUE idx_media_items_tmdb, replaced with non-unique + composite idx_media_items_tmdb_type
- New file: `internal/db/queries_crosslib.go` with cross-library query functions
- `GetCrossLibraryFiles(mediaItemID)`: aggregates media_files across sibling media_items sharing same tmdb_id
- `GetCrossLibraryEpisodeFiles(episodeID, tmdbID)`: same for TV episode files (matches by season+episode number)
- `GetMediaItemsWith4KCrossLibrary(ids)`: extends 4K badge check to include cross-library siblings
- `DeduplicateByTMDBID(items)`: removes cross-library duplicates from list/search/recent, keeps richest metadata
- `metadataRichness(item)`: scoring function for dedup tiebreaking (overview=3, poster=3, backdrop=2, rating=2, etc.)
- MediaFile.LibraryName / EpisodeFile.LibraryName: API-only field for frontend version selector labels
- Enricher no longer merges cross-library items (unique constraint on tmdb_id is gone)
- Frontend: version selector buttons show `[Library Name]` suffix for cross-library files
- Frontend: episode version dropdown also shows library name
- Tests: queries_crosslib_test.go with 7 cases for metadataRichness scoring
- Key design: each library keeps its own media_items rows; linking is purely at query time via shared tmdb_id

## Infinite Scroll Pagination (Frontend)
- State: S.moviesPage/showsPage/libraryPage, S.xxxHasMore, S.xxxLoading
- IntersectionObserver on sentinel divs (#moviesSentinel, #showsSentinel, #librarySentinel) with 200px rootMargin
- renderMovies/renderShows/renderLibrary accept `append` param: falsy=fresh load, truthy=append next page
- Loading-more indicators: .grid-loading-more divs with .active class toggle
- Filter change handlers wrapped in arrow fns to pass false (not Event object) as append
- Backend fix: over-fetch cap raised from 100 to 110 in media_handlers.go List handler
- Search endpoint uses simple `limit` param (not paginated), no infinite scroll needed
- paginate() in helpers.go caps user input at 100; handler adds +10 dedup buffer internally

## H.264 10-bit (Hi10P) Detection & Remux Fallback
- Migration 012: video_profile, video_pix_fmt VARCHAR(50) on media_files + episode_files
- FFprobe: Profile, PixFmt, Level on ffprobeStream; VideoProfile, VideoPixFmt on ProbeResult
- Scanner propagates VideoProfile/VideoPixFmt to MediaFile and EpisodeFile
- All 13 SQL query functions (queries.go, queries_phase2.go, queries_crosslib.go) updated
- DecidePlayback: variadic `pixFmt ...string` for backward compat; `isH264_10bit` guard
- Detection: (h264|avc|avc1) + pixFmt containing "10" -> force full transcode
- Applied in both client-caps-aware AND static fallback paths
- phase2_handlers.go: GetStreamInfo reads file.VideoPixFmt, passes to DecidePlayback
- Frontend: setupHLSPlay tracks `isRemuxSession` and `triedTranscodeFallback`
- After 2 HLS recoverMediaError failures during remux: destroy session, create new with remux=false
- Fallback session gets its own fresh error handler (no infinite retry loops)
- decision_test.go: 7 new test cases for Hi10P scenarios (total ~35 DecidePlayback tests)

## Playback Pipeline Fixes (Session 9 - 2026-02-23)
- **Missing -map flags**: startVariant() now ALWAYS adds `-map 0:v:0 -map 0:a:N` even when AudioTrackIndex=-1 (defaults to `-map 0:a:0`). Without explicit maps, FFmpeg includes subtitle/attachment/data streams from MKV files which cannot be muxed into .ts, causing "muxer does not support codec" errors or broken segments.
- **HLS.js timeout**: manifestLoadingTimeOut increased from 10s default to 45s for transcode sessions (remux sessions keep 10s). Software transcoding on modest hardware can take 15-30s for first segment; HLS.js timed out before server responded (server waits 40s for FFmpeg).
- **Detail page z-index**: `.detail-content` was missing `position: relative; z-index: 2;` (unlike `.hero-content` which had it). This caused poster/info to render behind the `.hero-gradient` overlay depending on browser compositing order.
- **Stale detail content**: loadDetail() now clears all stale DOM content (poster, title, description, backdrop, cast, actions, episodes) BEFORE the async API call, preventing flash of previous movie's content during loading.
- **Poster onerror**: `<img>` in detailPoster now has `onerror="this.style.display='none'"` to hide broken images gracefully. Missing posters show a movie icon SVG placeholder instead of empty div.

## Emby-Style HLS Subtitle Pipeline (Session — 2026-02-24)
- Subtitles piggyback on FIRST variant's FFmpeg process (no separate extraction process)
- `HLSSubtitleTrack` struct in streaming.go: AbsoluteIndex, Language, Title, Forced, Default
- `SubtitleTracks []HLSSubtitleTrack` on SessionOpts + TranscodeSession; `subtitlesAttached` flag
- startVariant: appends `-map 0:N -vn -an -c:s webvtt -f segment -segment_time -segment_list` per track
- Subtitle files in session root OutputDir (not variant subdirs), named `subs_N.m3u8`/`subs_N_NNNNN.vtt`
- GenerateMasterPlaylist: variadic `subtitleTracks ...[]HLSSubtitleTrack` for backward compat
- Adds `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs"` + `SUBTITLES="subs"` on STREAM-INF
- ServeSubtitlePlaylist/ServeSubtitleSegment on TranscodeManager; token rewriting for Safari
- Route: `GET /hls/{sessionID}/{subsFile}` -> `ServeHLSSubtitleFile` (dispatches .m3u8/.vtt)
- phase2_handlers.go: CreateSession probes subs, filters bitmap (PGS/VOBSUB/DVB), builds HLSSubtitleTrack list
- Frontend: `loadHLSSubtitles(hls)` uses HLS.js native subtitle API; fallback to on-demand extraction
- `S._hlsSubtitleMode`, `S._fallbackSubtitles` state for HLS vs direct-play subtitle paths
- Tests: 5 new functions in subtitles_test.go (master playlist with/without subs, token, defaults, boolYesNo)
- 491 total test cases passing across all packages

## Inline Modal System (Frontend)
- `showModal(config)` Promise-based, replaces all browser prompt/confirm/alert
- Types: prompt (multi-field), confirm, alert (with copyable code); z-index 10003

## Watch Party Feature (Session — 2026-02-26)
- See [watchparty-architecture.md](watchparty-architecture.md) for full details
- manager.go (in-memory state), queries_parties.go, party_handlers.go, party_ws.go
- Lock ordering: m.mu (RLock) -> ps.mu (Lock); nil conn guards on all WS writes

## Requests Feature (Session — 2026-02-26)
- See [requests-feature.md](requests-feature.md) for full details
- `internal/arr/` package: RadarrClient + SonarrClient (v3 API, 26 tests)
- `internal/db/queries_requests.go`: 8 query methods
- `internal/api/request_handlers.go`: RequestHandler (5 endpoints) + RequestMonitor (60s polling)
- Migration 013: requests + watch_parties + watch_party_participants tables
- Config: RequestsConfig with 4 ArrInstanceConfig (radarr, radarr4K, sonarr, sonarr4K), 9 env vars
- Router wiring NOT done yet (another agent's task)

## Gotchas
- main.go init order: imgProxy BEFORE enricher; NewEnricher/NewAdminHandler use variadic params
- **Always use explicit `-map` flags with FFmpeg HLS output**
- GenerateMasterPlaylist: variadic subtitle tracks for backward compat
- ARR nil interface bug: typed nil `*arr.RadarrClient` wrapped in interface is non-nil; use concrete types
- Activity logger: always nil-check `h.activity` before calling `.log()`
