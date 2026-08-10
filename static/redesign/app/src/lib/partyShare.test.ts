// Unit tests for the watch-party share-card helpers.
//
// Two of these guard user-visible surfaces (the filename in a downloads
// folder, the copied link) and one guards a small but real boundary: the
// download path fetches a URL and hands it to an <a download>, so it
// checks the URL is one of ours rather than assuming the API gave it to
// us unmolested.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CARD_DIMENSIONS,
  cardDownloadName,
  cardFormatLabel,
  canShareCardFiles,
  cardShareData,
  downloadCard,
  isSameOriginCardURL,
  shareCard,
  type CardFormat,
} from './partyShare'

const ORIGIN = 'https://aurora.example.com'
const FORMATS: CardFormat[] = ['story', 'square', 'og']

describe('cardDownloadName', () => {
  it('names the file after the party and the crop', () => {
    expect(cardDownloadName('7K2QD9', 'story')).toBe('aurora-watch-party-7K2QD9-story.png')
    expect(cardDownloadName('7K2QD9', 'square')).toBe('aurora-watch-party-7K2QD9-square.png')
    expect(cardDownloadName('7K2QD9', 'og')).toBe('aurora-watch-party-7K2QD9-og.png')
  })
  it('upper-cases and scrubs the code', () => {
    expect(cardDownloadName('7k2qd9', 'story')).toBe('aurora-watch-party-7K2QD9-story.png')
    expect(cardDownloadName('../../etc/passwd', 'story')).toBe('aurora-watch-party-ETCPASSWD-story.png')
  })
  it('falls back rather than emitting a bare-dash filename', () => {
    expect(cardDownloadName('', 'story')).toBe('aurora-watch-party-PARTY-story.png')
  })
})

describe('cardFormatLabel', () => {
  it('names every crop', () => {
    expect(cardFormatLabel('story')).toBe('Story')
    expect(cardFormatLabel('square')).toBe('Square')
    expect(cardFormatLabel('og')).toBe('Link preview')
  })
})

describe('CARD_DIMENSIONS', () => {
  // These have to stay the renderer's real output sizes — they drive the
  // preview's reserved aspect ratio, and a wrong one is a layout jump.
  it('carries the renderer’s real output size for every crop', () => {
    expect(CARD_DIMENSIONS.story).toEqual({ width: 1080, height: 1920 })
    expect(CARD_DIMENSIONS.square).toEqual({ width: 1080, height: 1080 })
    expect(CARD_DIMENSIONS.og).toEqual({ width: 1200, height: 630 })
    expect(Object.keys(CARD_DIMENSIONS).sort()).toEqual([...FORMATS].sort())
  })
})

describe('isSameOriginCardURL', () => {
  it('accepts our own card route', () => {
    expect(isSameOriginCardURL(`${ORIGIN}/api/parties/7K2QD9/card.png?v=story&t=abc`, ORIGIN)).toBe(true)
    expect(isSameOriginCardURL('/api/parties/7K2QD9/card.png?v=story&t=abc', ORIGIN)).toBe(true)
  })
  it('rejects another origin, another path, and nonsense', () => {
    expect(isSameOriginCardURL('https://evil.example.com/api/parties/7K2QD9/card.png', ORIGIN)).toBe(false)
    expect(isSameOriginCardURL(`${ORIGIN}/api/admin/users`, ORIGIN)).toBe(false)
    expect(isSameOriginCardURL(`${ORIGIN}/api/parties/7K2QD9/qr.png`, ORIGIN)).toBe(false)
    expect(isSameOriginCardURL(`${ORIGIN}/api/parties/TOOLONG1/card.png`, ORIGIN)).toBe(false)
    expect(isSameOriginCardURL('javascript:alert(1)', ORIGIN)).toBe(false)
    expect(isSameOriginCardURL('', ORIGIN)).toBe(false)
  })
})

describe('downloadCard', () => {
  let clicked: string[]
  let fakeDoc: Document

  beforeEach(() => {
    clicked = []
    // Minimal stand-in for the anchor dance — no jsdom needed.
    const anchor = {
      href: '',
      download: '',
      click() { clicked.push(this.download) },
      remove() {},
    }
    fakeDoc = {
      createElement: () => anchor,
      body: { appendChild: () => {} },
    } as unknown as Document
    // Shim the object-URL lifecycle — these tests run without a DOM.
    globalThis.URL.createObjectURL = () => 'blob:fake'
    globalThis.URL.revokeObjectURL = () => {}
  })

  it('saves the PNG under the party filename', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob(['png']), { status: 200 }))
    const res = await downloadCard(
      `${ORIGIN}/api/parties/7K2QD9/card.png?v=story&t=abc`, '7K2QD9', 'story',
      { origin: ORIGIN, fetchImpl: fetchImpl as unknown as typeof fetch, doc: fakeDoc },
    )
    expect(res.ok).toBe(true)
    expect(clicked).toEqual(['aurora-watch-party-7K2QD9-story.png'])
  })

  it('refuses a URL that is not ours, without fetching it', async () => {
    const fetchImpl = vi.fn()
    const res = await downloadCard(
      'https://evil.example.com/steal.png', '7K2QD9', 'story',
      { origin: ORIGIN, fetchImpl: fetchImpl as unknown as typeof fetch, doc: fakeDoc },
    )
    expect(res.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(clicked).toEqual([])
  })

  it('reports a non-OK response instead of saving an error page', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }))
    const res = await downloadCard(
      `${ORIGIN}/api/parties/7K2QD9/card.png?t=bad`, '7K2QD9', 'story',
      { origin: ORIGIN, fetchImpl: fetchImpl as unknown as typeof fetch, doc: fakeDoc },
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('404')
    expect(clicked).toEqual([])
  })

  it('reports a network failure rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline') })
    const res = await downloadCard(
      `${ORIGIN}/api/parties/7K2QD9/card.png?t=abc`, '7K2QD9', 'story',
      { origin: ORIGIN, fetchImpl: fetchImpl as unknown as typeof fetch, doc: fakeDoc },
    )
    expect(res).toEqual({ ok: false, error: 'offline' })
  })
})

// ── Web Share ───────────────────────────────────────────────────────

describe('canShareCardFiles', () => {
  const data = { files: [] } as ShareData

  it('is false without share(), without canShare(), and when canShare says no', () => {
    expect(canShareCardFiles(data, {} as Navigator)).toBe(false)
    expect(canShareCardFiles(data, { share: () => Promise.resolve() } as unknown as Navigator)).toBe(false)
    expect(canShareCardFiles(data, {
      share: () => Promise.resolve(), canShare: () => false,
    } as unknown as Navigator)).toBe(false)
  })

  it('is true only when the browser accepts this exact payload', () => {
    const canShare = vi.fn(() => true)
    expect(canShareCardFiles(data, {
      share: () => Promise.resolve(), canShare,
    } as unknown as Navigator)).toBe(true)
    // Probed with the payload that will actually be shared, not a guess.
    expect(canShare).toHaveBeenCalledWith(data)
  })

  it('survives a canShare() that throws', () => {
    expect(canShareCardFiles(data, {
      share: () => Promise.resolve(),
      canShare: () => { throw new TypeError('nope') },
    } as unknown as Navigator)).toBe(false)
  })
})

describe('cardShareData', () => {
  it('wraps the PNG under the download filename, with no url or text', () => {
    const data = cardShareData(new Blob(['png']), 'aurora-watch-party-7K2QD9-story.png', 'Aurora watch party')
    expect(data?.files?.[0]?.name).toBe('aurora-watch-party-7K2QD9-story.png')
    expect(data?.files?.[0]?.type).toBe('image/png')
    expect(data?.title).toBe('Aurora watch party')
    // Several share targets refuse a mixed payload; the card already
    // carries the code and the QR.
    expect(data?.url).toBeUndefined()
    expect(data?.text).toBeUndefined()
  })
})

describe('shareCard', () => {
  const URL_OK = `${ORIGIN}/api/parties/7K2QD9/card.png?v=story&t=abc`
  let clicked: string[]
  let fakeDoc: Document
  const png = () => new Response(new Blob(['png']), { status: 200 })

  beforeEach(() => {
    clicked = []
    const anchor = { href: '', download: '', click() { clicked.push(this.download) }, remove() {} }
    fakeDoc = {
      createElement: () => anchor,
      body: { appendChild: () => {} },
    } as unknown as Document
    globalThis.URL.createObjectURL = () => 'blob:fake'
    globalThis.URL.revokeObjectURL = () => {}
  })

  const run = (nav: unknown, fetchImpl = vi.fn(async () => png()), format: CardFormat = 'story') =>
    shareCard(URL_OK, '7K2QD9', format, {
      origin: ORIGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      doc: fakeDoc,
      nav: nav as Navigator,
    })

  it('hands the PNG to the OS share sheet when the browser takes files', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(async () => {})
    const res = await run({ share, canShare: () => true })
    expect(res).toEqual({ ok: true, outcome: 'shared' })
    expect(clicked).toEqual([])
    const payload = share.mock.calls[0][0]
    expect(payload.files?.[0]?.name).toBe('aurora-watch-party-7K2QD9-story.png')
  })

  it('treats a dismissed share sheet as a non-event — no error, no download', async () => {
    // The user backing out of the sheet is a decision, not a failure: it
    // must not surface as a toast, and it must not silently save a file
    // they just declined to share.
    const abort = Object.assign(new Error('Share canceled'), { name: 'AbortError' })
    const share = vi.fn(async () => { throw abort })
    const res = await run({ share, canShare: () => true })
    expect(res).toEqual({ ok: true, outcome: 'dismissed' })
    expect(clicked).toEqual([])
    expect(res.error).toBeUndefined()
  })

  it('falls back to a download where canShare() refuses files (desktop)', async () => {
    const share = vi.fn(async () => {})
    const res = await run({ share, canShare: () => false })
    expect(res).toEqual({ ok: true, outcome: 'downloaded' })
    expect(share).not.toHaveBeenCalled()
    expect(clicked).toEqual(['aurora-watch-party-7K2QD9-story.png'])
  })

  it('falls back to a download on a browser with no Web Share at all', async () => {
    const res = await run({})
    expect(res).toEqual({ ok: true, outcome: 'downloaded' })
    expect(clicked).toEqual(['aurora-watch-party-7K2QD9-story.png'])
  })

  it('falls back to a download when share() fails for any other reason', async () => {
    // e.g. Safari refusing because the fetch spent the user activation.
    const notAllowed = Object.assign(new Error('not allowed'), { name: 'NotAllowedError' })
    const share = vi.fn(async () => { throw notAllowed })
    const res = await run({ share, canShare: () => true })
    expect(res).toEqual({ ok: true, outcome: 'downloaded' })
    expect(clicked).toEqual(['aurora-watch-party-7K2QD9-story.png'])
  })

  it('names the file after the selected crop', async () => {
    const res = await run({}, vi.fn(async () => png()), 'og')
    expect(res.outcome).toBe('downloaded')
    expect(clicked).toEqual(['aurora-watch-party-7K2QD9-og.png'])
  })

  it('refuses a URL that is not ours, without fetching it', async () => {
    const fetchImpl = vi.fn()
    const res = await shareCard('https://evil.example.com/steal.png', '7K2QD9', 'story', {
      origin: ORIGIN, fetchImpl: fetchImpl as unknown as typeof fetch, doc: fakeDoc,
      nav: { share: vi.fn(), canShare: () => true } as unknown as Navigator,
    })
    expect(res.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(clicked).toEqual([])
  })

  it('reports a non-OK response instead of sharing an error page', async () => {
    const share = vi.fn(async () => {})
    const res = await run({ share, canShare: () => true }, vi.fn(async () => new Response('nope', { status: 404 })))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('404')
    expect(share).not.toHaveBeenCalled()
    expect(clicked).toEqual([])
  })
})
