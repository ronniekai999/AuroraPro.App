// Watch-party share card — pure helpers.
//
// The card itself is rendered server-side (internal/api/party_card.go); the
// SPA's whole job is to fetch the signed URLs, show a preview, and get the
// PNG onto the host's device. Everything here is dependency-free and
// unit-tested: the filename a host sees in their downloads folder and the
// "is this URL one of ours" check are both places a small mistake is
// user-visible.

// CardFormat is one crop of the composition. The three values are the
// `?v=` the image route takes and the keys card-links answers with, which
// is what lets the modal index the response by the selected format
// instead of switching on it.
export type CardFormat = 'story' | 'square' | 'og'

// PartyCardLinks mirrors the card-links response. `page` is the party's
// /p/{CODE} deep link — the thing a host pastes into a chat.
//
// Extending Record<CardFormat, string> is deliberate: it demands a URL for
// every crop in the union, so adding a format without wiring up its link
// is a type error rather than an undefined src on the preview.
export interface PartyCardLinks extends Record<CardFormat, string> {
  code: string
  page: string
}

// CARD_DIMENSIONS drives the preview box's aspect ratio so the modal
// reserves the right space before the image loads (no layout jump).
// These are the renderer's real output sizes (internal/api's layout
// tables); they are not independent constants to be tuned.
export const CARD_DIMENSIONS: Record<CardFormat, { width: number; height: number }> = {
  story: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  og: { width: 1200, height: 630 },
}

// cardFormatLabel is the human name for a format tab. `og` is labelled by
// what it is FOR rather than by its aspect ratio — a host choosing a crop
// is choosing a destination, and "1.91:1" is not one.
export function cardFormatLabel(format: CardFormat): string {
  switch (format) {
    case 'story':
      return 'Story'
    case 'square':
      return 'Square'
    case 'og':
      return 'Link preview'
    default:
      return format
  }
}

// cardDownloadName builds the filename the browser saves as, and the name
// the OS share sheet shows. Codes come from a fixed alphabet, but the
// format string is interpolated too, so the whole thing is scrubbed to a
// conservative charset rather than trusted — a filename is a place stray
// characters cause real trouble.
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

// ── Web Share ───────────────────────────────────────────────────────
//
// On a phone this is the feature: the host taps Share and the OS sheet
// opens straight into Instagram, Messages or WhatsApp with the PNG
// attached. Everywhere else it saves the file, which is the same outcome
// one step longer.

// ShareCardOutcome distinguishes the three ways the button can succeed.
// `dismissed` is a SUCCESS: the host opened the sheet and closed it, which
// is a decision, not an error to report back at them.
export type ShareCardOutcome = 'shared' | 'dismissed' | 'downloaded'

export interface ShareCardResult {
  ok: boolean
  outcome?: ShareCardOutcome
  error?: string
}

// cardShareData wraps the PNG as the payload the share sheet takes.
// Returns null where `File` does not exist, which is the browsers that
// were never going to take a file anyway.
//
// No `url` and no `text`: several targets refuse a mixed payload, and the
// card already carries the join code and the QR. The image IS the message.
export function cardShareData(blob: Blob, filename: string, title: string): ShareData | null {
  if (typeof File !== 'function') return null
  try {
    return { files: [new File([blob], filename, { type: 'image/png' })], title }
  } catch {
    return null
  }
}

// canShareCardFiles probes the FILE path specifically, with the very
// payload it intends to send. `navigator.share` alone is not enough —
// browsers expose it for text and URLs while refusing files, and calling
// share({files}) there throws. Probing the same object that will be
// shared is the only honest signal.
export function canShareCardFiles(data: ShareData, nav: Navigator = navigator): boolean {
  try {
    return typeof nav.share === 'function' && nav.canShare?.(data) === true
  } catch {
    return false
  }
}

// isShareDismissal reports the user closing the share sheet. The Web Share
// API signals that with an AbortError, which is not a failure and must not
// surface as one — no toast, no console noise, nothing.
//
// Checked structurally rather than with `instanceof Error`: this arrives
// as a DOMException, and the point is the name.
function isShareDismissal(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    (err as { name?: unknown }).name === 'AbortError'
}

// shareCard fetches the PNG and hands it to the OS share sheet, falling
// back to a download on desktop, on a browser that will not take files,
// and on any share failure that is not the user backing out.
//
// The fetch happens before share(), which costs the transient user
// activation on strict browsers (Safari); that shows up as a throw, and
// the download fallback catches it. Returns a result rather than throwing,
// same reasoning as downloadCard.
export async function shareCard(
  url: string,
  code: string,
  format: CardFormat,
  opts: {
    origin?: string
    fetchImpl?: typeof fetch
    doc?: Document
    nav?: Navigator
    title?: string
  } = {},
): Promise<ShareCardResult> {
  const origin = opts.origin ?? window.location.origin
  if (!isSameOriginCardURL(url, origin)) {
    return { ok: false, error: 'Refusing to share from an unexpected URL.' }
  }
  const doFetch = opts.fetchImpl ?? fetch
  let blob: Blob
  try {
    const res = await doFetch(url, { credentials: 'same-origin' })
    if (!res.ok) {
      return { ok: false, error: `Card unavailable (${res.status})` }
    }
    blob = await res.blob()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Share failed' }
  }

  const filename = cardDownloadName(code, format)
  const nav = opts.nav ?? navigator
  const data = cardShareData(blob, filename, opts.title ?? 'Aurora watch party')
  if (data && canShareCardFiles(data, nav)) {
    try {
      await nav.share(data)
      return { ok: true, outcome: 'shared' }
    } catch (err) {
      if (isShareDismissal(err)) {
        return { ok: true, outcome: 'dismissed' }
      }
      // Anything else — no activation, target refused, transport died —
      // still leaves the host with the file.
    }
  }
  try {
    triggerDownload(blob, filename, opts.doc ?? document)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Share failed' }
  }
  return { ok: true, outcome: 'downloaded' }
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
