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
  downloadCard,
  isSameOriginCardURL,
} from './partyShare'

const ORIGIN = 'https://aurora.example.com'

describe('cardDownloadName', () => {
  it('names the file after the party and the crop', () => {
    expect(cardDownloadName('7K2QD9', 'story')).toBe('aurora-watch-party-7K2QD9-story.png')
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
  it('labels the story crop', () => {
    expect(cardFormatLabel('story')).toBe('Story')
  })
})

describe('CARD_DIMENSIONS', () => {
  it('carries the renderer’s real output size', () => {
    expect(CARD_DIMENSIONS.story).toEqual({ width: 1080, height: 1920 })
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
