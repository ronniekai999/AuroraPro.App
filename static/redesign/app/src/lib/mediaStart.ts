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
// fragment's tagList as ['AURORA-MEDIA-START', '<seconds>']. The native-HLS
// path (Safari/iOS) cannot see playlist tags, so it fetches the variant
// playlist itself once (fetchNativeMediaWindow). Without the line (older
// servers, a failed measurement) the player keeps start_sec, as before.
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
 * early, or two on Matroska; two GOPs past a minute is not a real stream.
 * Mirrors mediaStartMaxLagSec on the server.
 */
export const MEDIA_START_MAX_LAG_SEC = 60

/**
 * Margin the alignment keeps from the end of what the level playlist has
 * published, ON TOP of the reload runway (and alone on a finished playlist):
 * a playhead at the produced edge is what the level-lag containment rebuilds
 * on, and a rebuild here would land on the same key frame and try again.
 * Matches needsHlsSessionRebuild's edge tolerance.
 */
export const MEDIA_START_ALIGN_EDGE_SEC = 0.5

/** Alignments smaller than this are not worth a seek. */
export const MEDIA_START_ALIGN_MIN_SEC = 0.05

/**
 * A host re-anchor is sent only when the host's picture and the room's clock
 * disagree by at least this much. Below it the room already matches; a seek
 * would make every guest stutter for nothing.
 */
export const MEDIA_START_REANCHOR_TOLERANCE_SEC = 0.5

/** How close a `seeked` must land to the alignment target to be its echo. */
export const MEDIA_START_ECHO_TOLERANCE_SEC = 0.5

/**
 * How long a party guest leaves room positions unjudged while its clock waits
 * for the first level load (RemuxClock.holdsPartyPosition). The server answers
 * a remux's first variant request within about 2.75 s (media_start.go's
 * budget plus its wait slack); past this the guest judges the room against
 * start_sec, as it did before the hold existed.
 */
export const MEDIA_START_PARTY_HOLD_MS = 4000

type TagList = ReadonlyArray<ReadonlyArray<string>>
type TaggedFragment = { tagList?: TagList; initSegment?: { tagList?: TagList } | null }

const DECIMAL_SECONDS = /^\d+(?:\.\d+)?$/

function parseSeconds(raw: string | undefined): number | null {
  const text = (raw ?? '').trim()
  if (!DECIMAL_SECONDS.test(text)) return null
  const sec = Number(text)
  return Number.isFinite(sec) ? sec : null
}

/**
 * The media start the variant playlist reports, in source seconds, or null
 * when it reports none (or something that is not a number of seconds).
 *
 * The server writes the line directly before the first segment, which hls.js
 * files on fragments[0]. A copy in the playlist header would instead land on
 * the init segment of an fMP4 playlist (hls.js turns the header's fragment
 * into the #EXT-X-MAP one) — measured in Chromium, and pinned against the
 * installed hls.js parser in mediaStart.hlsjs.test.ts — so that is accepted too.
 */
export function reportedMediaStartSec(fragments: ReadonlyArray<TaggedFragment> | undefined): number | null {
  const first = fragments?.[0]
  if (!first) return null
  const tags = [...(first.tagList ?? []), ...(first.initSegment?.tagList ?? [])]
  for (const tag of tags) {
    if (tag[0] !== MEDIA_START_TAG) continue
    return parseSeconds(tag[1])
  }
  return null
}

/**
 * The reported start if it is believable for this session, else null: a
 * remux request, a session that seeked, and a value in
 * [start_sec - MAX_LAG, start_sec + MAX_LEAD], never negative. `remux` is the
 * requested delivery: a transcode request can never become a remux on the
 * server (only the reverse), so a transcode never moves its clock.
 */
export function plausibleMediaStartSec(sessionStartSec: number, reportedSec: number | null, remux: boolean): number | null {
  const start = Number.isFinite(sessionStartSec) && sessionStartSec > 0 ? sessionStartSec : 0
  if (!remux || start === 0 || reportedSec === null || !Number.isFinite(reportedSec)) return null
  if (reportedSec < 0 ||
      reportedSec > start + MEDIA_START_MAX_LEAD_SEC ||
      reportedSec < start - MEDIA_START_MAX_LAG_SEC) return null
  return reportedSec
}

/**
 * The source second at the session's media time 0 — the subtrahend for every
 * media-clock ↔ absolute conversion: the plausible reported start, else
 * start_sec.
 */
export function sessionMediaOriginSec(sessionStartSec: number, reportedSec: number | null, remux: boolean): number {
  const start = Number.isFinite(sessionStartSec) && sessionStartSec > 0 ? sessionStartSec : 0
  return plausibleMediaStartSec(sessionStartSec, reportedSec, remux) ?? start
}

/**
 * Where in the media to start so playback begins at start_sec, the position
 * the session was asked for, rather than at the key frame before it. 0 means
 * no seek.
 *
 * Not cosmetic: a party host's room clock runs from the position it asked for
 * (the server sets the anchor on request-seek and keeps it running), while
 * its picture ran from the key frame. Every remuxing guest used to be wrong by
 * the same gap and so agreed with the host; once the guests' clocks are true,
 * a host left at the key frame would sit a gap behind all of them. Starting
 * everyone at start_sec keeps clock, picture and room in agreement; when that
 * cannot happen in time, RemuxClock.hostReanchorSec moves the room instead.
 *
 * All or nothing, and only with runway: the target plus `runwaySec` plus the
 * edge margin must fit inside what the level playlist has published. On a
 * live playlist hls.js learns of the next segment only at its next reload,
 * about one segment duration after this load (its computeReloadInterval), so
 * a start nearer the produced edge than that just converts the skipped seconds
 * into a stall — worse than playing them, which is what happened before this
 * change.
 */
export function mediaStartAlignmentSec(
  sessionStartSec: number,
  originSec: number,
  producedMediaEndSec: number,
  runwaySec: number,
): number {
  return alignmentWithRunwaySec(sessionStartSec - originSec, producedMediaEndSec, runwaySec)
}

/**
 * The runway rule on its own: `intoSec` (media seconds) if it is worth a seek
 * and fits, with the reload runway and the edge margin, inside what the level
 * playlist has published; else 0. A party guest aligns to the room's position
 * under the same rule (RemuxClock).
 */
export function alignmentWithRunwaySec(intoSec: number, producedMediaEndSec: number, runwaySec: number): number {
  if (!(intoSec > MEDIA_START_ALIGN_MIN_SEC)) return 0
  const runway = Number.isFinite(runwaySec) && runwaySec >= 0 ? runwaySec : Infinity
  if (!(intoSec + runway + MEDIA_START_ALIGN_EDGE_SEC <= producedMediaEndSec)) return 0
  return intoSec
}

/** What one playlist load says about the session's media window. */
export interface MediaWindow {
  /** The start this load reports, or null. */
  reportedSec: number | null
  /** End of the last listed segment, in media seconds. */
  producedEndSec: number
  /**
   * Seconds until the player learns of the next segment: the last segment's
   * duration on a live playlist (hls.js reloads after about that long), 0 on
   * a finished one.
   */
  runwaySec: number
}

/** The window an hls.js LevelDetails describes. */
export function levelMediaWindow(details?: {
  live?: boolean
  fragments?: ReadonlyArray<TaggedFragment & { start: number; duration: number }>
}): MediaWindow {
  const frags = details?.fragments ?? []
  const last = frags[frags.length - 1]
  return {
    reportedSec: reportedMediaStartSec(frags),
    producedEndSec: last ? last.start + last.duration : 0,
    runwaySec: details?.live && last ? last.duration : 0,
  }
}

/**
 * The same window parsed from a variant playlist's text (the native path,
 * which has no hls.js). The media-start line counts only before the first
 * segment, where the server writes it.
 */
export function parseMediaPlaylistWindow(text: string): MediaWindow {
  let reportedSec: number | null = null
  let sawSegment = false
  let pendingDuration: number | null = null
  let producedEndSec = 0
  let lastDuration = 0
  let live = true
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (line === '#EXT-X-ENDLIST') { live = false; continue }
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseSeconds(line.slice('#EXTINF:'.length).split(',')[0])
      continue
    }
    if (line.startsWith(`#${MEDIA_START_TAG}:`)) {
      if (!sawSegment && reportedSec === null) reportedSec = parseSeconds(line.slice(MEDIA_START_TAG.length + 2))
      continue
    }
    if (line.startsWith('#')) continue
    sawSegment = true
    if (pendingDuration !== null) {
      producedEndSec += pendingDuration
      lastDuration = pendingDuration
    }
    pendingDuration = null
  }
  return { reportedSec, producedEndSec, runwaySec: live ? lastDuration : 0 }
}

/** The first variant URI a master playlist lists, or null. */
export function firstVariantUri(masterText: string): string | null {
  for (const raw of masterText.split(/\r?\n/)) {
    const line = raw.trim()
    if (line !== '' && !line.startsWith('#')) return line
  }
  return null
}

/**
 * The native-HLS path's one look at the variant playlist: fetch the master,
 * then its first variant (a remux has one), and parse the window. Never
 * throws: any failure is null, and the caller then behaves exactly as before
 * this existed. Nothing here touches the media element or how Safari loads
 * the stream.
 */
export async function fetchNativeMediaWindow(
  masterUrl: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<MediaWindow | null> {
  try {
    const base = typeof window !== 'undefined' ? window.location.href : undefined
    const masterAbs = new URL(masterUrl, base)
    const master = await fetchImpl(masterAbs.toString(), { credentials: 'include', signal })
    if (!master.ok) return null
    const uri = firstVariantUri(await master.text())
    if (!uri) return null
    const variant = await fetchImpl(new URL(uri, masterAbs).toString(), { credentials: 'include', signal })
    if (!variant.ok) return null
    return parseMediaPlaylistWindow(await variant.text())
  } catch {
    return null
  }
}

/** What the clock wants done after a playlist load. */
export interface ClockUpdate {
  /** originSec changed: re-read it for every conversion. */
  originChanged: boolean
  /** Seek the element here (media seconds), or null. */
  alignTo: number | null
}

type Alignment =
  | 'pending'   // wanted, not yet possible
  | 'aligned'   // the element was sent to start_sec
  | 'unneeded'  // no gap worth a seek
  | 'passed'    // playback reached start_sec on its own; the picture is still the gap late
  | 'abandoned' // a seek (user, or before anything played) owns the playhead now

/**
 * One HLS session's media clock: where media time 0 is, whether the element
 * should be moved to start_sec, and whether a party host must re-anchor the
 * room. Fed by both delivery paths; holds no DOM references.
 *
 * - Adoption happens only before the element has played (M2): a start that
 *   arrives later would move the clock under a viewer already watching, so the
 *   provisional start_sec is kept instead — the behaviour before this existed.
 * - Alignment is retried on every later playlist load while the playhead is
 *   still short of start_sec and the produced window now leaves runway: a
 *   forward jump of at most the gap. Never after a user seek.
 * - A party guest is aligned instead to the room's projected position, and
 *   only before it plays (guestAlignmentTarget); after that, or without the
 *   runway, its position is the drift loop's, as before.
 * - Until the first level load says where media time 0 is, a party guest
 *   leaves room positions unjudged (holdsPartyPosition), for a bounded time:
 *   judged against the provisional start_sec, a position inside the key-frame
 *   gap reads as "before this session" and rebuilds it.
 * - A party host that has started playing without aligning sends ONE seek with
 *   its true position (hostReanchorSec), so the room follows its picture.
 */
export class RemuxClock {
  readonly sessionStartSec: number
  readonly remux: boolean
  private origin: number
  private adopted = false
  private refused = false
  private played = false
  private levelSeen = false
  private holdSinceMs: number | null = null
  private alignment: Alignment = 'pending'
  private pendingEchoSec: number | null = null
  private reanchorDone = false

  constructor(sessionStartSec: number, remux: boolean) {
    this.sessionStartSec = Number.isFinite(sessionStartSec) && sessionStartSec > 0 ? sessionStartSec : 0
    this.remux = remux
    this.origin = this.sessionStartSec
  }

  /** The source second at media time 0. */
  get originSec(): number { return this.origin }
  /** A measured start was adopted. */
  get hasMeasuredOrigin(): boolean { return this.adopted }
  /** A measured start arrived after playback began and was refused. */
  get refusedLateStart(): boolean { return this.refused }
  /** Whether a remux session could have a measured start at all. */
  get wantsMeasuredOrigin(): boolean { return this.remux && this.sessionStartSec > 0 }
  /**
   * The session could report a measured start and nothing has said yet
   * whether it does: no level load (hls.js), or the native path's one fetch
   * neither applied nor failed.
   */
  get awaitingMeasuredStart(): boolean { return this.wantsMeasuredOrigin && !this.levelSeen }

  /** The element has played media (a `playing` event, or the clock advancing). */
  notePlayed(): void { this.played = true }

  /** The native path's fetch failed: no level load is coming. */
  noteNoMeasurement(): void { this.levelSeen = true }

  /**
   * A seek the clock did not make moved the playhead: a user's, or a party
   * seek applied to a guest.
   */
  noteUserSeek(): void {
    if (this.alignment === 'pending' || this.alignment === 'passed') this.alignment = 'abandoned'
    this.pendingEchoSec = null
  }

  /**
   * For a party guest (L1): leave this room position (an explicit seek's
   * target, or the drift loop's projected one) unjudged for now. True while
   * the clock awaits its first level load and the position is one a plausible
   * start could still serve, at or after start_sec - MAX_LAG; for at most
   * MEDIA_START_PARTY_HOLD_MS from the first hold. Judged against the
   * provisional start_sec instead, a host's re-anchor (a key frame plus a
   * little, so just BEFORE start_sec) reads as "before this session" and
   * rebuilds a guest whose first level load would have put it in the window,
   * and a position after start_sec lands the gap early. A position before
   * start_sec - MAX_LAG precedes any start the clock would accept, so it is
   * never held: it rebuilds at once, as before.
   */
  holdsPartyPosition(targetAbsSec: number, nowMs: number): boolean {
    if (!this.awaitingMeasuredStart || !Number.isFinite(targetAbsSec) || !Number.isFinite(nowMs)) return false
    if (targetAbsSec < this.sessionStartSec - MEDIA_START_MAX_LAG_SEC) return false
    if (this.holdSinceMs === null) this.holdSinceMs = nowMs
    return nowMs - this.holdSinceMs < MEDIA_START_PARTY_HOLD_MS
  }

  /**
   * A playlist load arrived. `ownsPlayhead` is false for a party guest;
   * `roomAbsSec` is then the room's projected position, or null when it is
   * unknown, stale, or an explicit seek still waiting to be applied owns where
   * the guest goes.
   */
  noteLevel(w: MediaWindow, el: { currentTime: number; ownsPlayhead: boolean; roomAbsSec?: number | null }): ClockUpdate {
    this.levelSeen = true
    let originChanged = false
    if (!this.adopted && !this.refused) {
      const start = plausibleMediaStartSec(this.sessionStartSec, w.reportedSec, this.remux)
      if (start !== null) {
        if (this.played) {
          this.refused = true
        } else {
          this.adopted = true
          originChanged = start !== this.origin
          this.origin = start
        }
      }
    }
    if (!this.adopted) return { originChanged, alignTo: null }
    return { originChanged, alignTo: this.alignmentTarget(w, el) }
  }

  private alignmentTarget(
    w: MediaWindow,
    el: { currentTime: number; ownsPlayhead: boolean; roomAbsSec?: number | null },
  ): number | null {
    if (this.alignment !== 'pending' || this.reanchorDone) return null
    const into = this.sessionStartSec - this.origin
    if (!(into > MEDIA_START_ALIGN_MIN_SEC)) { this.alignment = 'unneeded'; return null }
    // Nothing but a seek moves an element that has not played.
    if (!this.played && el.currentTime > MEDIA_START_ALIGN_MIN_SEC) { this.alignment = 'abandoned'; return null }
    if (!el.ownsPlayhead) return this.guestAlignmentTarget(w, el.roomAbsSec ?? null)
    if (el.currentTime >= into - MEDIA_START_ALIGN_MIN_SEC) { this.alignment = 'passed'; return null }
    return this.aligned(mediaStartAlignmentSec(this.sessionStartSec, this.origin, w.producedEndSec, w.runwaySec))
  }

  /**
   * A party guest (L2), before it plays: the room's projected position in
   * media seconds, under the same runway rule, or null. A guest used to start
   * at the key frame and agree with its host only because both clocks read
   * high by the same gap; with true clocks a guest of an aligned host would
   * start that gap behind the room and catch up through the drift loop — a
   * hard snap after its first frames, or up to half a minute at 5% speed.
   * Before playback a seek is invisible. Once the element has played, or
   * without the runway, the drift loop owns the position, as before, so the
   * two never both move it; the guest sends nothing either way.
   */
  private guestAlignmentTarget(w: MediaWindow, roomAbsSec: number | null): number | null {
    if (this.played || roomAbsSec === null || !Number.isFinite(roomAbsSec)) return null
    return this.aligned(alignmentWithRunwaySec(roomAbsSec - this.origin, w.producedEndSec, w.runwaySec))
  }

  private aligned(target: number): number | null {
    if (!(target > 0)) return null
    this.alignment = 'aligned'
    this.pendingEchoSec = target
    return target
  }

  /**
   * True exactly once, for the `seeked` that completes the alignment seek: it
   * is not a scrub and must not reach the room as one. A one-shot matched by
   * position, not a time window, so a slow first fragment cannot outlast it.
   */
  consumeAlignmentSeeked(currentTime: number): boolean {
    if (this.pendingEchoSec === null || !Number.isFinite(currentTime)) return false
    if (Math.abs(currentTime - this.pendingEchoSec) > MEDIA_START_ECHO_TOLERANCE_SEC) return false
    this.pendingEchoSec = null
    return true
  }

  /**
   * For a party host whose playback is under way with the room running: the
   * absolute position to send as ONE seek so the room re-anchors on the
   * host's actual picture, or null. Decided at most once per session — after
   * it, alignment stops too, so the host never jumps away from the room it
   * just re-anchored. Only an unaligned host qualifies (never aligned, or
   * reached start_sec by playing a gap late); a host that aligned, had no gap,
   * or seeked has a room that already matches it. `roomAbsSec` is the room's
   * projected position when known: if it already agrees, nothing is sent.
   */
  hostReanchorSec(currentTime: number, roomAbsSec: number | null): number | null {
    if (this.reanchorDone || !this.adopted || !Number.isFinite(currentTime)) return null
    if (this.alignment !== 'pending' && this.alignment !== 'passed') return null
    this.reanchorDone = true
    const trueAbs = this.origin + currentTime
    const offset = roomAbsSec !== null && Number.isFinite(roomAbsSec)
      ? Math.abs(roomAbsSec - trueAbs)
      : this.sessionStartSec - this.origin
    return offset >= MEDIA_START_REANCHOR_TOLERANCE_SEC ? trueAbs : null
  }
}

/**
 * Feeds a clock what it learns from the element itself: that playback has
 * begun. A `playing` event, or the clock advancing while playing and not
 * seeking (jsdom and some engines skip `playing`). Returns the unbinder.
 */
export function observePlayback(vid: HTMLMediaElement, clock: RemuxClock): () => void {
  const onPlaying = () => clock.notePlayed()
  const onTimeUpdate = () => {
    if (!vid.paused && !vid.seeking && vid.currentTime > MEDIA_START_ALIGN_MIN_SEC) clock.notePlayed()
  }
  vid.addEventListener('playing', onPlaying)
  vid.addEventListener('timeupdate', onTimeUpdate)
  return () => {
    vid.removeEventListener('playing', onPlaying)
    vid.removeEventListener('timeupdate', onTimeUpdate)
  }
}
