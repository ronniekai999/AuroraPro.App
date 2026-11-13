// Aurora V2 — PartyShareCardModal (watch-party share card)
//
// The host taps "Share card" and gets the poster: a PNG of the artwork,
// the Eastern start time (or LIVE NOW), who's hosting, and a QR +
// six-character code that gets a friend into the room.
//
// The image is rendered and cached SERVER-side (internal/api/party_card.go)
// — this component only fetches the signed URLs, previews the result, and
// gets the file onto the device. That split matters: the PNG has to be a
// real URL a social crawler can fetch, which a canvas render in the tab
// could never be.
//
// Three crops off one composition — Story for a story tray, Square for a
// feed or a Discord drop, Link preview for the 1200×630 an unfurl reads.
// Share… hands the PNG to the OS share sheet on a phone and saves it
// everywhere else; Download and Copy link are always there.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getPartyCardLinks } from '@/lib/api'
import {
  CARD_DIMENSIONS,
  cardFormatLabel,
  copyToClipboard,
  downloadCard,
  shareCard,
  type CardFormat,
  type PartyCardLinks,
} from '@/lib/partyShare'
import { failureWords } from '@/lib/failureWords'

export interface PartyShareCardModalProps {
  code: string
  /** Heading. The composer overrides it to celebrate the booking. */
  title?: string
  /** Copy under the title — e.g. "Saturday, August 15 · 4 people invited". */
  subtitle?: string
  onClose: () => void
}

// Tab order is the order a host is likely to want them: the one people
// post, then the feed crop, then the one that only matters when a link
// gets pasted somewhere.
const FORMATS: CardFormat[] = ['story', 'square', 'og']

export function PartyShareCardModal({ code, title, subtitle, onClose }: PartyShareCardModalProps) {
  const [links, setLinks] = useState<PartyCardLinks | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [format, setFormat] = useState<CardFormat>('story')
  // Which action is in flight, so the button that started it is the one
  // whose label changes — a share must not make Download say "Saving…".
  const [busy, setBusy] = useState<null | 'download' | 'share'>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [imageReady, setImageReady] = useState(false)

  useEffect(() => {
    const ac = new AbortController()
    getPartyCardLinks(code, ac.signal)
      .then(setLinks)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return
        // The route refuses anyone but the party's host with a 403.
        setError(failureWords(err, 'make the share card', { status: { 403: 'Only the party’s host can share its card.' } }) ?? 'Could not make the share card.')
      })
    return () => ac.abort()
  }, [code])

  // Escape closes, and focus lands inside the dialog on open — the modal
  // is reachable from a keyboard-driven lobby.
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const imageURL = links?.[format] ?? null
  const dims = CARD_DIMENSIONS[format]

  // A transient confirmation ("Copied", "Saved") that clears itself.
  const flash = useCallback((msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(current => (current === msg ? null : current)), 2500)
  }, [])

  const onDownload = useCallback(async () => {
    if (!imageURL || busy) return
    setBusy('download')
    setError(null)
    const res = await downloadCard(imageURL, code, format)
    setBusy(null)
    if (res.ok) flash('Saved to your downloads')
    else setError(res.error ?? 'Download failed')
  }, [imageURL, busy, code, format, flash])

  // Share… opens the OS sheet with the PNG attached where the browser
  // takes files, and saves it where it does not. A host who opens the
  // sheet and closes it again has decided something, not hit an error:
  // that path deliberately says nothing at all.
  const onShare = useCallback(async () => {
    if (!imageURL || busy) return
    setBusy('share')
    setError(null)
    const res = await shareCard(imageURL, code, format)
    setBusy(null)
    if (!res.ok) {
      setError(res.error ?? 'Could not share the card')
      return
    }
    if (res.outcome === 'shared') flash('Shared')
    else if (res.outcome === 'downloaded') flash('Saved to your downloads')
  }, [imageURL, busy, code, format, flash])

  const onCopyLink = useCallback(async () => {
    if (!links) return
    const ok = await copyToClipboard(links.page)
    if (ok) flash('Party link copied')
    else setError('Could not copy the link')
  }, [links, flash])

  const previewStyle = useMemo(
    () => ({ aspectRatio: `${dims.width} / ${dims.height}` }),
    [dims.width, dims.height],
  )

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[rgba(6,7,8,0.72)] p-4 animate-fade-in"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Watch party share card"
        // The dialog itself takes focus when it opens (tabIndex -1), and
        // keeps the app's own focus ring for a keyboard.
        className="max-h-[90vh] w-full max-w-sm overflow-y-auto overscroll-contain rounded-sheet bg-surface-raised-2 p-5 shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-[17px] font-semibold text-ink">{title ?? 'Share card'}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close share card"
            className="-mr-2 -mt-1 grid h-11 w-11 flex-none place-items-center rounded-control text-ink-2 transition-colors hover:bg-surface-raised hover:text-ink"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
        {subtitle && <p className="text-[13px] text-ink-2">{subtitle}</p>}

        {/* Format tabs. Switching one points the preview at a different
            signed URL; the token is the same for all three. */}
        <div role="tablist" aria-label="Card format" className="mt-3 flex gap-1 rounded-control bg-surface-raised p-1">
          {FORMATS.map(f => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={format === f}
              onClick={() => { setFormat(f); setImageReady(false) }}
              className={`h-11 flex-1 rounded-art text-[13px] font-semibold transition-colors ${
                format === f ? 'bg-action text-action-on' : 'text-ink-2 hover:text-ink'
              }`}
            >
              {cardFormatLabel(f)}
            </button>
          ))}
        </div>

        {/* Preview. The box reserves the card's shape up front so the
            dialog does not jump when a large image finishes decoding. */}
        <div className="mt-3 grid place-items-center rounded-control bg-surface-page p-3">
          <div className="w-40 max-w-full overflow-hidden rounded-art bg-surface-raised" style={previewStyle}>
            {imageURL && (
              <img
                src={imageURL}
                alt={`Watch party card for code ${code}`}
                width={dims.width}
                height={dims.height}
                onLoad={() => setImageReady(true)}
                onError={() => setError('The card image could not be loaded')}
                className={`h-full w-full object-cover motion-safe:transition-opacity motion-safe:duration-300 ${
                  imageReady ? 'opacity-100' : 'opacity-0'
                }`}
              />
            )}
          </div>
        </div>

        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
          Times on the card are Eastern. Only your name appears: nobody you invited is shown.
        </p>

        {error && <p className="mt-2 text-[13px] text-danger-ink" role="alert">{error}</p>}
        {notice && <p className="mt-2 text-[13px] text-ok" role="status">{notice}</p>}

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={!imageURL || busy !== null} onClick={() => void onDownload()} className="stage-btn stage-btn-primary px-4">
            {busy === 'download' ? 'Saving…' : 'Download PNG'}
          </button>
          {/* Secondary on purpose: on a desktop browser this button saves
              the file, and the predictable action should be the one that
              looks predictable. */}
          <button type="button" disabled={!imageURL || busy !== null} onClick={() => void onShare()} className="stage-btn stage-btn-ghost px-4">
            {busy === 'share' ? 'Sharing…' : 'Share…'}
          </button>
          <button type="button" disabled={!links} onClick={() => void onCopyLink()} className="stage-btn stage-btn-ghost px-4">
            Copy link
          </button>
        </div>
      </div>
    </div>
  )
}
