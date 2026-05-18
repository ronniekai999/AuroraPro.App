# Audit 33 (2026-02-24) - HLS Inline Subtitle Pipeline (Emby-style)

## Overview
Full audit of the HLS subtitle pipeline that extracts text-based subtitles inline with FFmpeg's video/audio transcode, producing segmented WebVTT playlists served via HLS.js. 6 files changed.

## Files Audited
1. `internal/streaming/streaming.go` - HLSSubtitleTrack, SubtitleTracks, startVariant subtitle chains, ServeSubtitlePlaylist, ServeSubtitleSegment
2. `internal/streaming/profiles.go` - GenerateMasterPlaylist variadic subtitleTracks, EXT-X-MEDIA generation
3. `internal/api/phase2_handlers.go` - CreateSession subtitle probing, ServeHLSSubtitleFile dispatcher
4. `internal/api/router.go` - `/hls/{sessionID}/{subsFile}` route
5. `static/aurora_pro.html` - loadHLSSubtitles, setHLSSubtitle, fallback path
6. `internal/streaming/subtitles_test.go` - New master playlist + subtitle tests

## Build/Test Status
- `go build ./...` - PASS
- `go vet ./...` - PASS
- `go test -count=1 ./...` - ALL PASS (11 packages)

## Findings: 4 MEDIUM, 4 LOW (3 MEDIUM FIXED, 1 MEDIUM noted)

### MEDIUM-1: Subtitle playlist timing race on slow hardware
**File**: `streaming.go:1496-1516`
**Issue**: `ServeSubtitlePlaylist` waits for the video variant's `v.Ready` (triggered when `stream.m3u8` appears). But FFmpeg may write the video playlist slightly BEFORE the subtitle playlist. HLS.js parses the master playlist, discovers subtitle tracks, and immediately requests `subs_0.m3u8`. If the subtitle file hasn't been written yet, `http.ServeFile` returns 404.
**Risk**: Brief 404 on subtitle playlist request during first few hundred milliseconds after variant starts. HLS.js will retry, so transient failures are usually invisible.
**Fix**: Add a small retry loop (3x 500ms) in `ServeSubtitlePlaylist` after `v.Ready` fires: check if the subtitle playlist file exists, wait briefly if not. **FIXED**: Added 6x 500ms retry loop (3s total) with context cancellation support.

### MEDIUM-2: FFmpeg exits if subtitle stream index is invalid
**File**: `streaming.go:1234`
**Issue**: `-map 0:<abs_idx>` without trailing `?` fails FFmpeg entirely if the stream index doesn't exist, killing video/audio playback too. Indices come from `ProbeSubtitles` so they're normally valid, but edge cases exist (file modified between probe and transcode, corrupt container).
**Fix**: Use `-map 0:<abs_idx>?` (trailing `?`) for subtitle maps, making them optional. If the subtitle stream doesn't exist, FFmpeg silently skips it rather than failing. **FIXED**.

### MEDIUM-3: HLS playlist injection via subtitle track metadata
**File**: `profiles.go:143`
**Issue**: `name` and `lang` values from FFprobe subtitle metadata are interpolated into the m3u8 without escaping double quotes or newlines. A subtitle track title containing `"` (e.g., `English "SDH"`) would break the `NAME="..."` attribute syntax, potentially injecting arbitrary HLS attributes.
**Risk**: LOW in practice (track titles from FFprobe are rarely malformed), but defense-in-depth should strip `"` and `\n`/`\r` from name and lang before interpolation.
**Fix**: `name = strings.NewReplacer("\"", "", "\n", "", "\r", "").Replace(name)` and same for `lang`. **FIXED**: Added `sanitizeHLSAttr()` helper + 10 test cases.

### MEDIUM-4: Subtitle segment list lacks EXT-X-PLAYLIST-TYPE:EVENT
**File**: `streaming.go:1238` (FFmpeg `-f segment`)
**Issue**: Video output uses `-hls_playlist_type event` (adds `#EXT-X-PLAYLIST-TYPE:EVENT`), but subtitle output uses `-f segment -segment_list_type m3u8` which doesn't include this tag. HLS.js may treat the subtitle playlist as a live stream and poll more aggressively.
**Risk**: Minor performance impact (extra subtitle playlist requests), no functional breakage. HLS.js handles growing playlists correctly.
**Fix**: Not critical. If fixing, could post-process the subtitle playlist to inject the tag, or use a different FFmpeg output approach.

### LOW-1: Native HLS (Safari fallback) subtitle menu not populated
**File**: `aurora_pro.html:2268-2273`
**Issue**: When `Hls.isSupported()` is false (only Safari on iOS), `loadHLSSubtitles()` is never called. Aurora's custom subtitle menu stays empty. Safari's native player controls DO handle `#EXT-X-MEDIA TYPE=SUBTITLES` natively, so subtitles still work via Safari's built-in UI.
**Risk**: UX inconsistency on iOS Safari (native controls vs Aurora controls). Desktop Safari uses HLS.js (MSE supported), so this only affects iOS.

### LOW-2: FORCED subtitle AUTOSELECT behavior
**File**: `profiles.go:128-130`
**Issue**: Forced subtitles have `AUTOSELECT=YES` but not `DEFAULT=YES` (unless the track was also marked default in the source). Per HLS spec, forced subtitles with matching language should auto-display. HLS.js may or may not auto-select them depending on version.
**Risk**: Forced subs might not auto-display. Users can manually select them from the menu.

### LOW-3: Subtitle track NAME escaping for frontend display
**File**: `aurora_pro.html:2329-2333`
**Issue**: `t.name` from HLS.js is the NAME attribute from the master playlist. While the frontend uses `esc()` for XSS protection, the value was already potentially corrupted by MEDIUM-3 (unescaped quotes in the playlist).
**Risk**: Defense-in-depth issue. The `esc()` function handles `"` correctly for HTML, so even if the HLS attribute was broken, the HTML rendering is safe.

### LOW-4: Session cleanup includes subtitle files
**File**: `streaming.go:654` (`os.RemoveAll(s.OutputDir)`)
**Verified**: Session cleanup removes the entire `OutputDir` which contains both variant subdirs and subtitle files. No orphan subtitle files are left behind. CORRECT.

## Verified Correct (No Issues Found)

### FFmpeg Multi-Output Syntax
- Subtitle output chains correctly placed AFTER the HLS video/audio output
- `-vn -an` applies per-output (between output file paths), not globally
- Multiple subtitle outputs (one per track) each get their own `-f segment` -- verified working with 2 subtitle tracks
- `-map 0:<idx>` for each subtitle track correctly targets absolute stream index

### Route Registration
- `/hls/{sessionID}/{subsFile}` does NOT conflict with existing routes
- `/hls/{sessionID}/master.m3u8` is matched by literal before wildcard (Chi v5 specificity)
- `/hls/{sessionID}/{profile}/stream.m3u8` has 2 path segments vs 1 for subtitle routes -- different depth
- Auth middleware properly applied (RequireAuth on parent group)

### Master Playlist Generation (RFC 8216)
- `#EXT-X-MEDIA:TYPE=SUBTITLES` syntax is correct
- `GROUP-ID="subs"` matches `SUBTITLES="subs"` on STREAM-INF lines
- `DEFAULT`, `AUTOSELECT`, `FORCED` attributes properly formatted
- URI is relative path with correct token handling for Safari
- Backward compat: variadic parameter, 0 subs = no entries, no SUBTITLES attribute

### Token Handling
- Safari token rewriting works for both subtitle playlists (.vtt lines) and video playlists (.ts lines)
- `QueryParamToken(r)` correctly reads from context (set by router middleware)
- HLS.js uses `xhrSetup` for Authorization header on subtitle playlist/segment requests

### Path Traversal Prevention
- `ServeSubtitlePlaylist`: validates prefix `subs_`, suffix `.m3u8`, blocks `/`, `\`, `..`
- `ServeSubtitleSegment`: validates prefix `subs_`, suffix `.vtt`, blocks `/`, `\`, `..`
- `ServeHLSSubtitleFile`: validates `.m3u8` or `.vtt` extension

### Frontend Integration -- **BUG FOUND IN FIX 34**
- **BUG**: `loadHLSSubtitles(hls)` was called at `MANIFEST_PARSED` but `hls.subtitleTracks` returns `tracksInGroup` which is EMPTY at that point. HLS.js populates `tracksInGroup` in `switchLevel()` which fires on `LEVEL_SWITCHING` AFTER `MANIFEST_PARSED`. **FIXED**: Listen for `Hls.Events.SUBTITLE_TRACKS_UPDATED` instead, with 3s timeout fallback.
- Fallback to on-demand extraction when no inline subtitle tracks exist
- `setHLSSubtitle(idx)` correctly sets `hls.subtitleTrack` and `hls.subtitleDisplay`
- Audio track switch rebuilds subtitle menu via new session's SUBTITLE_TRACKS_UPDATED
- `closePlayer()` properly resets `S._hlsSubtitleMode`, `S._fallbackSubtitles`, and `S._hlsSubsTimer`
- Remux-to-transcode fallback also uses SUBTITLE_TRACKS_UPDATED for subtitle menu

### Bitmap Subtitle Handling
- `CreateSession` correctly filters bitmap subs via `IsBitmapSubtitle` (line 939)
- Only text-based subs (subrip, ass, ssa, mov_text, webvtt) are included in HLS inline tracks
- `ProbeSubtitles` returns raw tracks; `GetStreamInfo` handler sets `.Bitmap` for frontend filtering

### Session/Variant Locking
- `subtitlesAttached` flag is accessed under `variantMu` (via `EnsureVariant` -> `startVariant`)
- No race condition: only one variant at a time can check and set the flag
- `GetSession` updates `LastAccess`, preventing cleanup during subtitle serving

### Content-Type Headers
- Subtitle playlists: `application/vnd.apple.mpegurl` (correct)
- Subtitle segments: `text/vtt; charset=utf-8` (correct)
- Cache-Control: `no-cache` for playlists, `max-age=3600` for segments (correct)

### Test Coverage
- 8 new tests in `subtitles_test.go` for master playlist generation with/without subtitles
- Token handling, default values, empty language, forced attribute all tested
- Existing 480+ tests continue to pass
