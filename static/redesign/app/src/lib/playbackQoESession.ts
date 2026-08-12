// Session-identity rules for playback QoE (August 2026 review, adversarial pass).
//
// These are the decisions that were wrong in the first implementation, extracted
// from VideoPlayer so they can be tested. The player is a ~5,000-line component
// wired to hls.js, cast and party sync, and an adversarial review showed that
// all five of its QoE behaviors could be reverted with the whole SPA suite
// staying green. The wiring still has no test; the LOGIC now does, and the logic
// is where every one of those defects lived.

import type { QoEPrewarm, QoETerminal } from './playbackQoE'

/** The subset of PlayTarget that identifies what is being watched. */
export interface ViewingIdentity {
  fileId: number
  fileType: 'media' | 'episode'
}

/**
 * viewingKeyOf identifies one VIEWING — the title being watched — as distinct
 * from one DELIVERY of it.
 *
 * A seek re-anchor, an audio-track switch and a transcode fallback each mutate
 * the player target for the same viewing. Keying telemetry on the target object
 * meant one movie with four scrubs wrote five rows: four terminating as
 * `user_exit`, four contributing a "startup" measured from the rebuild, and
 * `watched_ms` reset each time. Only a change of file is a new viewing.
 */
export function viewingKeyOf(t: ViewingIdentity | null | undefined): string {
  if (!t) return ''
  return `${t.fileType}:${t.fileId}`
}

/**
 * What to do with the existing collector when a delivery is (re)established.
 *
 *   reuse   — same viewing, still live: count a rebuild, keep the row open
 *   replace — different viewing, or the collector has already reported
 *   attach  — nothing there yet
 */
export type CollectorAction = 'reuse' | 'replace' | 'attach'

export function collectorAction(args: {
  hasCollector: boolean
  collectorFinished: boolean
  currentKey: string | null
  nextKey: string
}): CollectorAction {
  if (!args.hasCollector) return 'attach'
  // A collector that has already reported is SPENT: its listeners are detached
  // and every further call is a no-op. Reusing one made the rest of the viewing
  // telemetry-dark — which is what happened on the direct-play → transcode
  // fallback, since the element error that triggers the fallback also closes
  // the row.
  if (args.collectorFinished) return 'replace'
  if (args.currentKey !== args.nextKey) return 'replace'
  return 'reuse'
}

/**
 * How a pre-warm attempt is recorded.
 *
 * `miss` must mean "we looked and there was nothing to adopt". Reporting an
 * operator who has the feature switched off as a miss buried every opted-out
 * user in the denominator and dragged the reported hit rate toward zero — for
 * the column whose entire purpose is to say whether pre-warm works.
 */
export function prewarmOutcome(enabled: boolean, adopted: boolean): QoEPrewarm {
  if (!enabled) return 'none'
  return adopted ? 'hit' : 'miss'
}

/**
 * The terminal for a viewing that ends without the element firing `ended`.
 *
 * The next-up card advances at the credits marker, so a fully-watched episode
 * never reaches the element's own `ended`. Reporting that as `user_exit` made a
 * completed episode indistinguishable from an abandoned one — but the advance
 * must have actually SUCCEEDED, because every failure path leaves the viewer
 * parked on the same episode and the viewing continues.
 */
export function viewingTerminal(advanceSucceeded: boolean): QoETerminal {
  return advanceSucceeded ? 'ended' : 'user_exit'
}

/**
 * Terminal classification for a playback failure.
 *
 * hls.js media and network errors do not set HTMLMediaElement.error, so the
 * collector's own element listener never sees them on the MSE path. Everything
 * funnelled through the player's failure handler and was recorded as
 * `user_exit`, which made the admin error rate read 0.00 during an outage that
 * was failing every transcode.
 */
export type FailureKind = 'media' | 'network' | 'session_create'

export function failureTerminal(kind: FailureKind): QoETerminal {
  switch (kind) {
    case 'network':
      return 'network_error'
    case 'session_create':
      // Never reaches hls.js or the element: a session cap, an ffprobe
      // failure, a full disk. Nothing else would classify it.
      return 'transcode_error'
    default:
      return 'media_error'
  }
}
