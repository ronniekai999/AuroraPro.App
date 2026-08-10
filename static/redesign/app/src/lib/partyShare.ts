// Watch-party share card — pure helpers.
//
// The card itself is rendered server-side (internal/api/party_card.go); the
// SPA's whole job is to fetch the signed URLs, show a preview, and get the
// PNG onto the host's device. Everything here is dependency-free and
// unit-tested: the filename a host sees in their downloads folder and the
// "is this URL one of ours" check are both places a small mistake is
// user-visible.

// CardFormat is one crop of the composition. Phase 1 ships `story`;
// `square` and `og` arrive with the Phase 2 renderer, at which point they
// join this union and cardLinks gains the matching fields.
export type CardFormat = 'story'

// PartyCardLinks mirrors the card-links response. `page` is the party's
// /p/{CODE} deep link — the thing a host pastes into a chat.
export interface PartyCardLinks {
  code: string
  story: string
  page: string
}

// CARD_DIMENSIONS drives the preview box's aspect ratio so the modal
// reserves the right space before the image loads (no layout jump).
export const CARD_DIMENSIONS: Record<CardFormat, { width: number; height: number }> = {
  story: { width: 1080, height: 1920 },
}

// cardFormatLabel is the human name for a format tab.
export function cardFormatLabel(format: CardFormat): string {
  switch (format) {
    case 'story':
      return 'Story'
    default:
      return format
  }
}

// cardDownloadName builds the filename the browser saves as. Codes come
// from a fixed alphabet, but the format string is interpolated too, so the
// whole thing is scrubbed to a conservative charset rather than trusted —
// a filename is a place stray characters cause real trouble.
export function cardDownloadName(code: string, format: CardFormat): string {
  const safeCode = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'PARTY'
  const safeFormat = String(format).replace(/[^a-z0-9]/g, '') || 'card'
  return `aurora-watch-party-${safeCode}-${safeFormat}.png`
}

// isSameOriginCardURL guards the download path. The URL comes back from
// our own API, but it is the input to a fetch and to an <a download>, so
// it gets checked rather than assumed: same origin, and the card route.
// Anything else is refused instead of followed.
export function isSameOriginCardURL(url: string, origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url, origin)
  } catch {
    return false
  }
  if (parsed.origin !== origin) return false
  return /^\/api\/parties\/[A-Za-z0-9]{6}\/card\.png$/.test(parsed.pathname)
}

// triggerDownload saves a blob under `filename` using the standard
// anchor-click dance. Split out from the fetch so the modal can be tested
// without a real DOM download.
export function triggerDownload(blob: Blob, filename: string, doc: Document = document): void {
  const href = URL.createObjectURL(blob)
  const a = doc.createElement('a')
  a.href = href
  a.download = filename
  doc.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can race the download in some browsers; a tick
  // later is universally safe and still bounds the object URL's lifetime.
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}

// downloadCard fetches the PNG and saves it. Returns an error string
// rather than throwing so the modal can render it inline — a failed
// download is a normal thing to report, not an exception to bubble.
export async function downloadCard(
  url: string,
  code: string,
  format: CardFormat,
  opts: { origin?: string; fetchImpl?: typeof fetch; doc?: Document } = {},
): Promise<{ ok: boolean; error?: string }> {
  const origin = opts.origin ?? window.location.origin
  if (!isSameOriginCardURL(url, origin)) {
    return { ok: false, error: 'Refusing to download from an unexpected URL.' }
  }
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(url, { credentials: 'same-origin' })
    if (!res.ok) {
      return { ok: false, error: `Card unavailable (${res.status})` }
    }
    const blob = await res.blob()
    triggerDownload(blob, cardDownloadName(code, format), opts.doc ?? document)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Download failed' }
  }
}

// copyToClipboard writes text to the clipboard, falling back to the
// legacy execCommand path on browsers (and insecure origins) where the
// async Clipboard API is unavailable. Returns success rather than
// throwing, same reasoning as downloadCard.
export async function copyToClipboard(text: string, nav: Navigator = navigator): Promise<boolean> {
  try {
    if (nav.clipboard?.writeText) {
      await nav.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
