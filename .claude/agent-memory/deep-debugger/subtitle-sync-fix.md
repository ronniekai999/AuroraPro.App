# Fix 35 (2026-02-25) - HLS Subtitle PTS Desync

## Root Cause
The MPEG-TS muxer (used internally by `-f hls`) adds a ~1.4s initial PTS offset
via its default `muxdelay` (0.7s) and `muxpreload` (0.5s). With `-copyts -start_at_zero`,
the demuxer chain normalizes timestamps to start at 0, but the mpegts muxer THEN
adds its own offset on output. Video/audio PTS in .ts segments starts at ~1.483s
instead of 0.

Meanwhile, subtitle cue times (extracted via `-f segment -segment_format webvtt`)
retain the original MKV timestamps from `-copyts -start_at_zero` (starting near 0).
This creates a ~1.4s mismatch between the video PTS timeline and subtitle cue timeline.

The X-TIMESTAMP-MAP injection with probed initPTS was MATHEMATICALLY correct
(MPEGTS=initPTS makes HLS.js compute offset=0). However, any timing race in
`getSessionInitPTS()` could produce MPEGTS=0 when initPTS=133470, shifting
subtitles 1.483s early.

## Fix (3 changes in streaming.go startVariant)

### 1. `-muxdelay 0 -muxpreload 0` before `-f hls` output
Eliminates the ~1.4s PTS offset at the source. Video PTS now starts at ~0.05-0.08s
(residual from codec delay / B-frame reordering). Subtitle cue times start at 0
(from `-copyts -start_at_zero`). Both timelines now aligned within <100ms.

### 2. `-avoid_negative_ts disabled` added to remux input args
Prevents FFmpeg from adding any PTS offset to "fix" negative timestamps.
Matches Emby's approach.

### 3. Emby-style subtitle output flags
- `-avoid_negative_ts disabled`: No PTS offset on subtitle cues
- `-segment_format webvtt`: Explicit format
- `-individual_header_trailer 1`: Each .vtt gets its own WEBVTT header
- `-break_non_keyframes 1`: Consistent with Emby
- `-segment_start_number 0`, `-map_metadata -1`: Explicit config

## Key Investigation Findings
- `-f hls` and `-f segment -segment_format mpegts` produce IDENTICAL PTS offsets
  (~1.4s with defaults). The offset comes from the underlying mpegts muxer, not
  from the hls muxer wrapper.
- Only `-muxdelay 0 -muxpreload 0` eliminates the offset.
- Emby's custom FFmpeg binary likely patches the mpegts muxer defaults (their
  output shows PTS=0 without -muxdelay/-muxpreload flags).
- The HLS.js falsy-zero issue (`if (webVttMpegTsMapOffset)` where 0 is falsy)
  is NOT a bug -- both code paths produce the same result when there are no
  discontinuity changes (CC transitions). However, eliminating the PTS offset
  makes the math simpler and removes all rounding/race condition risks.

## Files Changed
- `internal/streaming/streaming.go`: `startVariant()` function (3 changes above),
  updated comments in `ServeSubtitleSegment()` and `getSessionInitPTS()`

## Pattern
37. **FFmpeg mpegts muxer initial PTS offset**: The mpegts muxer (used by both
    `-f hls` and `-f segment -segment_format mpegts`) adds a ~1.4s initial PTS
    offset via `muxdelay` (default 0.7s) and `muxpreload` (default 0.5s). This
    offset is added AFTER the demuxer chain processes `-start_at_zero`. To get
    PTS starting at 0, add `-muxdelay 0 -muxpreload 0` before the output format.
    This is critical for subtitle synchronization where cue times come from a
    separate output chain (e.g., `-f segment -segment_format webvtt`) that does
    NOT go through the mpegts muxer and thus has no offset.

### Fix 36 (2026-02-25) - X-TIMESTAMP-MAP Delimiter Bug
- `X-TIMESTAMP-MAP:MPEGTS:` (colon) was wrong. Correct per WebVTT/HLS spec: `X-TIMESTAMP-MAP=MPEGTS:` (equals sign)
- HLS.js checks `startsWith(line, 'X-TIMESTAMP-MAP=')` — the colon form silently failed to match
- Made the entire PTS probing system (extractFirstPTS, getSessionInitPTS, CAS state machine) dead code
- Subtitles appeared ~correct by coincidence because `-muxdelay 0 -muxpreload 0` brings PTS near 0
- **Pattern 38**: WebVTT `X-TIMESTAMP-MAP` uses `=` (not `:`) between header name and value. The `:` delimiter inside `MPEGTS:` and `LOCAL:` is a different level of syntax. Always: `X-TIMESTAMP-MAP=MPEGTS:<pts>,LOCAL:<time>`
