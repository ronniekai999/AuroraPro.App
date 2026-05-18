# Codec Decision Engine Audit (2026-02-21)

## Files Audited
1. `internal/streaming/streaming.go` - Decision engine core
2. `internal/models/models.go` - StreamInfo with 4 new fields
3. `internal/api/phase2_handlers.go` - GetStreamInfo handler
4. `internal/library/ffprobe.go` - Container normalization
5. `static/aurora_pro.html` - Frontend codec detection
6. `internal/streaming/decision_test.go` - 45 test cases (37 + 8 new)

## Findings Fixed

### FIX-1 (MEDIUM): Audio track index not forwarded to FFmpeg
- `AudioTrackIndex` from `DecidePlayback` was returned in JSON but never used
- Added `AudioTrackIndex` to `SessionOpts`, `TranscodeSession`, and FFmpeg `-map` args
- Added `audio_track_index` to CreateSession request + frontend forwarding

### FIX-2 (MEDIUM): Direct play fallback set audio_passthrough=true unconditionally
- Frontend's `tryDirectPlay` failure path forced `audio_passthrough=true`
- If audio codec was incompatible (DTS), this would copy it to HLS where browser can't play
- Fixed: removed unconditional `audio_passthrough=true`, kept server's decision

### FIX-3 (MEDIUM): Direct play URL hit legacy handler causing session leak
- `stream_url` pointed to `StreamMediaFile` which creates transcode sessions on `CanDirectPlay` failure
- HEVC-on-Safari: decision engine says direct_play, legacy handler rejects and creates transcode session
- Frontend's `tryDirectPlay` errors, creates second session via `setupHLSPlay`; first session leaked
- Fixed: Added `ServeDirectFile` handler + `/api/stream/{fileID}/direct` route
- `GetStreamInfo` returns direct-serve URL when caps-based decision is direct_play

### FIX-4 (MEDIUM): RemuxAudioCopy used wrong audio codec
- Used legacy single `audioCodec` field (always first track)
- Decision engine may select track 1 (AAC) while field says track 0 (DTS)
- Fixed: looks up selected track's actual codec from `audioTracks` slice

### FIX-5 (LOW): Added 8 missing test cases
- Empty audio tracks, nil caps with empty audio, avc/avc1 aliases
- Unknown containers, multi-incompatible tracks, cross-combinations

## Findings Not Fixed (Architecture Notes)

### NOTE-1 (LOW): Empty audio tracks cause false "needs remux" with caps
- `findBestAudioTrack` returns `(-1, "", false)` for empty tracks
- Causes `audioOK=false` -> decision is "direct_stream" even for video-only MP4 + H.264
- Mitigated: handler synthesizes single-track list from `audioCodec` field
- Only hits files with truly no audio -- rare and arguably correct behavior

### NOTE-2 (LOW): `_container` suffix in ParseClientCaps accepts arbitrary keys
- `strings.HasSuffix(key, "_container")` stores any `*_container` key
- Not exploitable: consumption is a closed switch checking only `mp4_container`/`webm_container`
- Memory impact negligible (query string length-limited by HTTP)

### NOTE-3 (LOW): decideStatic treats empty audioCodec as incompatible
- Empty string not in DirectPlayAudioCodecs -> returns "direct_stream"
- Only affects video-only files with nil caps (backward compat path)

## Verified Safe
- Import cycle: library->streaming is one-way, no cycle
- XSS: transcode_reason not rendered in HTML; decision label is hardcoded string
- caps sanitization: lowercased, trimmed, unknown keys silently ignored
- URL encoding: Go's Query().Get() auto-decodes, frontend's encodeURIComponent matches
- Race conditions: CLIENT_CAPS on frontend is synchronous (probed once at startup)
- Container normalization is idempotent (called at scan time + decision time)
