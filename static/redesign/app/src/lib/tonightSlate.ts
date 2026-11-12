// Tonight's slate: what the hero shows and its filmstrip offers.
//
// Resume first. When the viewer left something unfinished recently, the hero
// leads with it ("Pick up where you left off"); Aurora's picks follow. The
// picks used to rotate through the hero unseen, nine seconds each, with a
// "Not tonight" button to skip one: the filmstrip shows them all, says which
// is up, and lets any be chosen directly. The strip is the picks, and only
// the picks: the title to resume is the hero's own, and the first card of
// Continue Watching, and is not listed a third time.
//
// The slate is derived, never stored: from Continue Watching and the hero
// pool as they are now. What the hero shows is then an index into it.
import { isResumable } from '@/lib/format'
import { mapContinueToMedia, type ContinueWatchingItem, type HeroPick } from '@/lib/api'
import { type Media } from '@/lib/types'

/** "Recently": a title last watched longer ago than this does not lead. It
 *  is still in Continue Watching, one row down. */
export const RESUME_LEAD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface SlateEntry {
  /** Stable across re-renders, for React and for "which is showing". */
  key: string
  kind: 'resume' | 'pick'
  media: Media
  /** Where this title sits in the pool as it is now, when it is in it:
   *  which entry the hero is on. */
  poolIndex: number | null
  /** A pick's place in the recommender's slate as the server sent it: what
   *  its exposure is reported under. The lead has none, also when it is one
   *  of the picks: a title shown as "Pick up where you left off" is one the
   *  viewer was already watching, and reporting it as a pick that was seen
   *  would credit the recommender with watching it did not cause. */
  position: number | null
  /** The record to resume from (the lead only). */
  record?: ContinueWatchingItem
  /** Why Aurora picked it (picks only). */
  reason?: string
}

/** The title to lead with: the most recent Continue Watching record that is
 *  far enough in to resume and was watched within the window. Continue
 *  Watching arrives most recent first. A record with no timestamp is taken
 *  as recent (older servers do not send one). */
export function resumeLead(items: ContinueWatchingItem[], now: number): ContinueWatchingItem | null {
  for (const c of items) {
    if (!isResumable(c)) continue
    if (c.completed) continue
    const at = c.updated_at ? Date.parse(c.updated_at) : NaN
    if (Number.isFinite(at) && now - at > RESUME_LEAD_MAX_AGE_MS) continue
    return c
  }
  return null
}

/** The lead, then the picks in the recommender's order. A title that is both
 *  appears once, as the lead. */
export function buildSlate(lead: ContinueWatchingItem | null, pool: HeroPick[]): SlateEntry[] {
  const out: SlateEntry[] = []
  if (lead) {
    const at = pool.findIndex(p => p.media.id === lead.media_item_id)
    const media = mapContinueToMedia(lead)
    // The pool's copy has the wide backdrop and the description; the
    // Continue Watching one is sized for a card.
    out.push({
      key: `resume:${lead.media_item_id}`, kind: 'resume', poolIndex: at >= 0 ? at : null, position: null, record: lead,
      media: at >= 0 ? { ...pool[at].media, progress: media.progress } : media,
    })
  }
  pool.forEach((p, i) => {
    if (lead && p.media.id === lead.media_item_id) return
    out.push({ key: `pick:${p.media.id}`, kind: 'pick', media: p.media, poolIndex: i, position: p.position ?? i, reason: p.reason })
  })
  return out
}

/** Which entry the hero shows: the lead while the viewer has not moved off
 *  it, else the pick at `poolIndex`. -1 when the slate has neither (the hero
 *  is then the catalog's fallback, or nothing). */
export function shownSlateIndex(slate: SlateEntry[], onLead: boolean, poolIndex: number): number {
  if (slate.length === 0) return -1
  if (onLead && slate[0].kind === 'resume') return 0
  const at = slate.findIndex(e => e.poolIndex === poolIndex)
  if (at >= 0) return at
  // The pool changed under the index (a refresh, a thumbs-down): the first
  // pick, or the lead when there are no picks.
  const first = slate.findIndex(e => e.kind === 'pick')
  return first >= 0 ? first : 0
}

/** "29 min left", "1 h 12 min left"; '' when the length is unknown or it is
 *  all but over. */
export function timeLeftLabel(positionMs: number, durationMs: number): string {
  if (!durationMs || durationMs <= 0) return ''
  const mins = Math.round((durationMs - positionMs) / 60000)
  if (mins < 1) return ''
  if (mins < 60) return `${mins} min left`
  const h = Math.floor(mins / 60), m = mins % 60
  return m ? `${h} h ${m} min left` : `${h} h left`
}

/** The line under the lead's title: where in a show it is, or the film's
 *  year and genre. */
export function resumeLine(c: ContinueWatchingItem): string {
  if (c.type === 'show' && c.season_number !== undefined && c.episode_number !== undefined) {
    const where = `Season ${c.season_number}, episode ${c.episode_number}`
    return c.episode_title ? `${where} · ${c.episode_title}` : where
  }
  return [c.year ? String(c.year) : '', c.genre ?? ''].filter(Boolean).join(' · ')
}
