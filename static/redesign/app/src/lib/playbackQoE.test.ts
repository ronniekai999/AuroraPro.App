// @vitest-environment jsdom
//
// The collector attaches DOM listeners to a <video> element, so this file needs
// jsdom. Per the project convention in vitest.config.ts the environment is
// declared per file rather than globally.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { attachPlaybackQoE } from './playbackQoE'

// The collector posts through sendBeacon (terminal) and apiFetchResponse
// (first frame). Both are stubbed so the assertions can read exactly what
// would have gone over the wire.
const fetched: Array<{ path: string; body: Record<string, unknown> }> = []
vi.mock('./api', () => ({
  apiFetchResponse: (path: string, opts: { body?: string }) => {
    fetched.push({ path, body: JSON.parse(opts.body || '{}') })
    return Promise.resolve(new Response(null, { status: 204 }))
  },
}))

const beacons: Array<{ path: string; body: Record<string, unknown> }> = []

/** A minimal EventTarget-backed stand-in for HTMLVideoElement. */
function makeVideo(): HTMLVideoElement {
  const el = document.createElement('video')
  Object.defineProperty(el, 'clientWidth', { value: 1280, configurable: true })
  return el
}

beforeEach(() => {
  fetched.length = 0
  beacons.length = 0
  vi.stubGlobal('crypto', {
    getRandomValues: (arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = i
      return arr
    },
  })
  navigator.sendBeacon = ((path: string, blob: Blob) => {
    // Blob.text() is async; the payload is small so read it synchronously
    // through the FileReader-free path vitest's jsdom supports.
    void blob.text().then((text) => {
      beacons.push({ path, body: JSON.parse(text) })
    })
    return true
  }) as typeof navigator.sendBeacon
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
}

describe('attachPlaybackQoE', () => {
  it('reports the startup row on the first playing event', async () => {
    const video = makeVideo()
    const qoe = attachPlaybackQoE(video, {
      decision: 'transcode',
      decisionReason: 'video_codec',
      outputCodec: 'h264',
      encoderFamily: 'software',
      burnIn: 'bitmap',
      clickAtMs: performance.now() - 500,
    })
    qoe.noteManifestParsed()
    video.dispatchEvent(new Event('playing'))
    await flush()

    expect(fetched).toHaveLength(1)
    expect(fetched[0].path).toBe('/api/stream/qoe/start')
    expect(fetched[0].body.decision).toBe('transcode')
    expect(fetched[0].body.burn_in).toBe('bitmap')
    // The session token has to satisfy the server's shape check.
    expect(String(fetched[0].body.session_token)).toMatch(/^[0-9a-f]{32}$/)
    // Startup timing is measured, not fabricated.
    expect(Number(fetched[0].body.click_to_first_frame_ms)).toBeGreaterThanOrEqual(500)

    qoe.detach()
  })

  it('only reports the startup row once', async () => {
    const video = makeVideo()
    const qoe = attachPlaybackQoE(video, { decision: 'direct_play' })
    video.dispatchEvent(new Event('playing'))
    video.dispatchEvent(new Event('waiting'))
    video.dispatchEvent(new Event('playing'))
    await flush()

    expect(fetched.filter((f) => f.path.endsWith('/qoe/start'))).toHaveLength(1)
    qoe.detach()
  })

  it('counts a stall as a rebuffer but not a seek', async () => {
    const video = makeVideo()
    const qoe = attachPlaybackQoE(video, { decision: 'transcode' })
    video.dispatchEvent(new Event('playing'))

    // A genuine stall: waiting with no seek in progress.
    video.dispatchEvent(new Event('waiting'))
    video.dispatchEvent(new Event('playing'))

    // A seek-induced wait must NOT count — otherwise a heavy scrubber reads
    // as a stalling server.
    video.dispatchEvent(new Event('seeking'))
    video.dispatchEvent(new Event('waiting'))
    video.dispatchEvent(new Event('seeked'))
    video.dispatchEvent(new Event('playing'))

    qoe.finish('ended')
    await flush()

    expect(beacons).toHaveLength(1)
    expect(beacons[0].path).toBe('/api/stream/qoe/finish')
    expect(beacons[0].body.rebuffer_count).toBe(1)
    expect(beacons[0].body.terminal).toBe('ended')
  })

  it('buckets throughput rather than reporting the raw estimate', async () => {
    const video = makeVideo()
    const qoe = attachPlaybackQoE(video, { decision: 'transcode' })
    video.dispatchEvent(new Event('playing'))
    qoe.noteThroughput(7_500_000)
    qoe.finish('ended')
    await flush()

    expect(beacons[0].body.throughput_class).toBe('5m_10m')
    // The raw figure must never appear — with a timestamp it is closer to a
    // network fingerprint than to an operational metric.
    expect(JSON.stringify(beacons[0].body)).not.toContain('7500000')
  })

  it('counts rendition switches', async () => {
    const video = makeVideo()
    const qoe = attachPlaybackQoE(video, { decision: 'transcode' })
    video.dispatchEvent(new Event('playing'))
    qoe.noteRenditionSwitch()
    qoe.noteRenditionSwitch()
    qoe.finish('ended')
    await flush()

    expect(beacons[0].body.rendition_switches).toBe(2)
  })

  it('classifies a media error from the element error code', async () => {
    const video = makeVideo()
    attachPlaybackQoE(video, { decision: 'transcode' })
    video.dispatchEvent(new Event('playing'))
    Object.defineProperty(video, 'error', { value: { code: 2 }, configurable: true })
    video.dispatchEvent(new Event('error'))
    await flush()

    expect(beacons[0].body.terminal).toBe('network_error')
  })

  it('prefers an explicitly noted error over the DOM terminal', async () => {
    const video = makeVideo()
    const qoe = attachPlaybackQoE(video, { decision: 'transcode' })
    video.dispatchEvent(new Event('playing'))
    qoe.noteError('transcode_error')
    qoe.finish('ended')
    await flush()

    expect(beacons[0].body.terminal).toBe('transcode_error')
  })

  it('still reports a session that never reached first frame', async () => {
    const video = makeVideo()
    const qoe = attachPlaybackQoE(video, {
      decision: 'transcode',
      clickAtMs: performance.now() - 100,
    })
    // No 'playing' ever fires — the title failed to start.
    qoe.finish('media_error')
    await flush()

    const start = fetched.find((f) => f.path.endsWith('/qoe/start'))
    expect(start).toBeDefined()
    // No fabricated startup timing: a failed start has no first frame to time.
    expect(start?.body.click_to_first_frame_ms).toBeNull()
    expect(beacons[0].body.terminal).toBe('media_error')
  })

  it('reports only once even if finish is called repeatedly', async () => {
    const video = makeVideo()
    const qoe = attachPlaybackQoE(video, { decision: 'direct_play' })
    video.dispatchEvent(new Event('playing'))
    qoe.finish('ended')
    qoe.finish('user_exit')
    video.dispatchEvent(new Event('ended'))
    await flush()

    expect(beacons).toHaveLength(1)
    expect(beacons[0].body.terminal).toBe('ended')
  })

  it('detach stops reporting entirely', async () => {
    const video = makeVideo()
    const qoe = attachPlaybackQoE(video, { decision: 'direct_play' })
    qoe.detach()
    video.dispatchEvent(new Event('playing'))
    video.dispatchEvent(new Event('ended'))
    await flush()

    expect(fetched).toHaveLength(0)
    expect(beacons).toHaveLength(0)
  })

  it('never throws into the player when the transport fails', async () => {
    const video = makeVideo()
    navigator.sendBeacon = (() => {
      throw new Error('beacon exploded')
    }) as typeof navigator.sendBeacon

    const qoe = attachPlaybackQoE(video, { decision: 'transcode' })
    expect(() => {
      video.dispatchEvent(new Event('playing'))
      qoe.finish('ended')
    }).not.toThrow()
  })
})
