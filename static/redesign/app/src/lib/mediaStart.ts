// Where a remux session's media really begins (server: internal/streaming/
// media_start.go).
//
// A remux copies video, so FFmpeg's `-ss <start_sec> -noaccurate_seek` can only
// start the stream at the key frame BEFORE start_sec, and hls.js maps that first
// sample to media time 0. Adding start_sec to the media clock therefore read
// every position high by the gap to that key frame: up to a whole GOP (10 s on
// a 10 s GOP, measured in Chromium), in progress writes, party broadcasts and
// drift, skip markers and the cast hand-off. A transcode seeks accurately and
// really does begin at start_sec.
//
// The server measures where the first segment it wrote begins and publishes it
// in the variant playlist as a comment line, `#AURORA-MEDIA-START:<seconds>`,
// directly before the first segment, which hls.js files on the first
// fragment's tagList as ['AURORA-MEDIA-START', '<seconds>']. Players without
// it (older servers, native HLS) keep start_sec, exactly as before.
//
// start_sec itself is unchanged and still owns what it always did: the
// whole-second `-ss` anchor the session was asked for, the subtitle cue-shift
// request and the cast receiver conversion.

/** hls.js's name for the comment line; media_start.go writes the same one. */
export const MEDIA_START_TAG = 'AURORA-MEDIA-START'

/**
 * How far after start_sec a reported start may sit and still be believed.
 * `-noaccurate_seek` only lands at or before its anchor; the slack covers a
 * first sample's codec delay. Mirrors mediaStartMaxLeadSec on the server.
 */
export const MEDIA_START_MAX_LEAD_SEC = 1

/**
 * How far before start_sec a reported start may sit. A remux begins one GOP
 * early, or two on Matroska; nothing real is ten minutes long, so a value
 * that far out is a wrong answer, not a long GOP.
 */
export const MEDIA_START_MAX_LAG_SEC = 600

/**
 * The boot alignment never targets closer than this to the end of what the
 * level playlist has published, even on a finished one: a playhead at the
 * produced edge is what the level-lag containment rebuilds on, and a rebuild
 * here would land on the same key frame and try again. Matches
 * needsHlsSessionRebuild's edge tolerance.
 */
export const MEDIA_START_ALIGN_EDGE_SEC = 0.5

/** Alignments smaller than this are not worth a seek. */
export const MEDIA_START_ALIGN_MIN_SEC = 0.05

type TagList = ReadonlyArray<ReadonlyArray<string>>
type TaggedFragment = { tagList?: TagList; initSegment?: { tagList?: TagList } | null }

const DECIMAL_SECONDS = /^\d+(?:\.\d+)?$/

/**
 * The media start the variant playlist reports, in source seconds, or null
 * when it reports none (or something that is not a number of seconds).
 *
 * The server writes the line directly before the first segment, which hls.js
 * files on fragments[0]. A copy in the playlist header would instead land on
 * the init segment of an fMP4 playlist (hls.js turns the header's fragment
 * into the #EXT-X-MAP one) — measured in Chromium — so that is accepted too.
 */
export function reportedMediaStartSec(fragments: ReadonlyArray<TaggedFragment> | undefined): number | null {
  const first = fragments?.[0]
  if (!first) return null
  const tags = [...(first.tagList ?? []), ...(first.initSegment?.tagList ?? [])]
  for (const tag of tags) {
    if (tag[0] !== MEDIA_START_TAG) continue
    const raw = (tag[1] ?? '').trim()
    if (!DECIMAL_SECONDS.test(raw)) return null
    const sec = Number(raw)
    return Number.isFinite(sec) ? sec : null
  }
  return null
}

/**
 * The source second at the session's media time 0 — the subtrahend for every
 * media-clock ↔ absolute conversion.
 *
 * start_sec for everything except a remux started mid-file whose playlist
 * reported a plausible measured start. `remux` is the requested delivery: a
 * transcode request can never become a remux on the server (only the reverse),
 * so a transcode keeps start_sec whatever its playlist says.
 */
export function sessionMediaOriginSec(sessionStartSec: number, reportedSec: number | null, remux: boolean): number {
  const start = Number.isFinite(sessionStartSec) && sessionStartSec > 0 ? sessionStartSec : 0
  if (!remux || start === 0 || reportedSec === null || !Number.isFinite(reportedSec)) return start
  if (reportedSec < 0 ||
      reportedSec > start + MEDIA_START_MAX_LEAD_SEC ||
      reportedSec < start - MEDIA_START_MAX_LAG_SEC) return start
  return reportedSec
}

/**
 * Where in the media to start so playback begins at start_sec, the position
 * the session was asked for, rather than at the key frame before it. 0 means
 * no seek.
 *
 * Not cosmetic: a party host's room clock runs from the position it asked for
 * (the server sets the anchor on request-seek and keeps it running),
 * while its picture ran from the key frame. Every remuxing guest used to be
 * wrong by the same gap and so agreed with the host; once the guests' clocks
 * are true, a host left at the key frame would sit a gap behind all of them.
 * Starting everyone at start_sec keeps clock, picture and room in agreement.
 *
 * All or nothing, and only with runway: the target plus `runwaySec` must fit
 * inside what the level playlist has published. On a live playlist hls.js
 * learns of the next segment only at its next reload, about one segment
 * duration after this load (its computeReloadInterval), so a start nearer the
 * produced edge than that just converts the skipped seconds into a stall —
 * worse than playing them, which is what happened before this change. When the
 * runway is not there (the encoder has published only the first segment, as on
 * slow storage) playback starts at the key frame and the clock stays true.
 */
export function mediaStartAlignmentSec(
  sessionStartSec: number,
  originSec: number,
  producedMediaEndSec: number,
  runwaySec: number,
): number {
  const into = sessionStartSec - originSec
  if (!(into > MEDIA_START_ALIGN_MIN_SEC)) return 0
  const runway = Math.max(MEDIA_START_ALIGN_EDGE_SEC, Number.isFinite(runwaySec) ? runwaySec : Infinity)
  if (!(into + runway <= producedMediaEndSec)) return 0
  return into
}
