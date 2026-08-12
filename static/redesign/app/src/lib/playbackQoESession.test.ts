import { describe, it, expect } from 'vitest'
import {
  collectorAction,
  failureTerminal,
  prewarmOutcome,
  viewingKeyOf,
  viewingTerminal,
} from './playbackQoESession'

describe('viewingKeyOf', () => {
  it('is stable across delivery rebuilds of the same file', () => {
    // A seek re-anchor and an audio-track switch both re-emit the target with
    // extra fields; neither is a new viewing.
    const base = { fileId: 42, fileType: 'episode' as const }
    expect(viewingKeyOf(base)).toBe(viewingKeyOf({ ...base, resumePositionMs: 900_000 } as never))
    expect(viewingKeyOf(base)).toBe(viewingKeyOf({ ...base, audioTrackIndex: 2 } as never))
    expect(viewingKeyOf(base)).toBe(viewingKeyOf({ ...base, forceTranscode: true } as never))
  })

  it('distinguishes different files and different file types', () => {
    expect(viewingKeyOf({ fileId: 1, fileType: 'media' }))
      .not.toBe(viewingKeyOf({ fileId: 2, fileType: 'media' }))
    // Ids are only unique within their table.
    expect(viewingKeyOf({ fileId: 1, fileType: 'media' }))
      .not.toBe(viewingKeyOf({ fileId: 1, fileType: 'episode' }))
  })

  it('treats no target as no viewing', () => {
    expect(viewingKeyOf(null)).toBe('')
    expect(viewingKeyOf(undefined)).toBe('')
  })
})

describe('collectorAction', () => {
  const live = { hasCollector: true, collectorFinished: false }

  it('reuses across a rebuild of the same viewing', () => {
    expect(collectorAction({ ...live, currentKey: 'media:1', nextKey: 'media:1' })).toBe('reuse')
  })

  it('replaces on a new viewing', () => {
    expect(collectorAction({ ...live, currentKey: 'media:1', nextKey: 'media:2' })).toBe('replace')
  })

  it('replaces a collector that has already reported', () => {
    // The direct-play → transcode fallback: the element error closes the row
    // AND triggers the fallback, which re-establishes the same viewing key.
    // Reusing the spent collector left the entire fallback unmeasured.
    expect(collectorAction({
      hasCollector: true, collectorFinished: true,
      currentKey: 'media:1', nextKey: 'media:1',
    })).toBe('replace')
  })

  it('attaches when there is nothing yet', () => {
    expect(collectorAction({
      hasCollector: false, collectorFinished: false, currentKey: null, nextKey: 'media:1',
    })).toBe('attach')
  })
})

describe('prewarmOutcome', () => {
  it('reports none when the feature is switched off', () => {
    // Not "miss" — an opted-out operator is not a failed pre-warm, and
    // counting them dragged the reported hit rate toward zero.
    expect(prewarmOutcome(false, false)).toBe('none')
    expect(prewarmOutcome(false, true)).toBe('none')
  })

  it('distinguishes hit from miss when the feature is on', () => {
    expect(prewarmOutcome(true, true)).toBe('hit')
    expect(prewarmOutcome(true, false)).toBe('miss')
  })
})

describe('viewingTerminal', () => {
  it('reports ended only when the advance actually succeeded', () => {
    expect(viewingTerminal(true)).toBe('ended')
    // Every failure path leaves the viewer parked on the same episode, so the
    // viewing has not ended.
    expect(viewingTerminal(false)).toBe('user_exit')
  })
})

describe('failureTerminal', () => {
  it('classifies each outage shape distinctly', () => {
    expect(failureTerminal('media')).toBe('media_error')
    expect(failureTerminal('network')).toBe('network_error')
    // A stream-info/session-create failure never reaches hls.js or the
    // element, so nothing else would classify it and the row would have
    // closed as user_exit.
    expect(failureTerminal('session_create')).toBe('transcode_error')
  })

  it('never returns user_exit — a failure is not a departure', () => {
    for (const kind of ['media', 'network', 'session_create'] as const) {
      expect(failureTerminal(kind)).not.toBe('user_exit')
    }
  })
})
