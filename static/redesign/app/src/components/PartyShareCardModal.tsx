// Aurora V2 — PartyShareCardModal (watch-party share card)
//
// The host taps "Share card" and gets the poster: a 1080×1920 PNG of the
// artwork, the Eastern start time, who's hosting, and a QR + six-character
// code that gets a friend into the room.
//
// The image is rendered and cached SERVER-side (internal/api/party_card.go)
// — this component only fetches the signed URLs, previews the result, and
// gets the file onto the device. That split matters: the PNG has to be a
// real URL a social crawler can fetch, which a canvas render in the tab
// could never be.
//
// Phase 1 offers Download and Copy link. The format tabs render with a
// single option today; `square` / `og` and the Web Share API file path
// land with Phase 2, which is why the tab strip exists now rather than
// being retrofitted around a lone button.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getPartyCardLinks } from '@/lib/api'
import {
  CARD_DIMENSIONS,
  cardFormatLabel,
  copyToClipboard,
  downloadCard,
  type CardFormat,
  type PartyCardLinks,
} from '@/lib/partyShare'

export interface PartyShareCardModalProps {
  code: string
  /** Heading. The composer overrides it to celebrate the booking. */
  title?: string
  /** Copy under the title — e.g. "Saturday, August 15 · 4 people invited". */
  subtitle?: string
  onClose: () => void
}

// Phase 1 renders one crop. The array (not a bare constant) is the seam
// Phase 2 widens.
const FORMATS: CardFormat[] = ['story']

export function PartyShareCardModal({ code, title, subtitle, onClose }: PartyShareCardModalProps) {
  const [links, setLinks] = useState<PartyCardLinks | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [format, setFormat] = useState<CardFormat>('story')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [imageReady, setImageReady] = useState(false)

  useEffect(() => {
    const ac = new AbortController()
    getPartyCardLinks(code, ac.signal)
      .then(setLinks)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'Could not build the share card')
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
    setBusy(true)
    setError(null)
    const res = await downloadCard(imageURL, code, format)
    setBusy(false)
    if (res.ok) flash('Saved to your downloads')
    else setError(res.error ?? 'Download failed')
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
      className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Watch party share card"
        className="w-full max-w-sm bg-[#0a0a0f] border border-white/[0.06] rounded-2xl p-5 max-h-[90vh] overflow-y-auto focus:outline-none"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-white text-base font-semibold">{title ?? 'Share card'}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close share card"
            className="text-white/40 hover:text-white/80 text-sm transition-colors"
          >
            ✕
          </button>
        </div>
        {subtitle && <p className="text-white/45 text-xs mt-1">{subtitle}</p>}

        {/* Format tabs. One option in Phase 1 — square and OG join it
            with the Phase 2 renderer. */}
        <div role="tablist" aria-label="Card format" className="flex gap-1.5 mt-3 p-1 rounded-xl bg-white/[0.04]">
          {FORMATS.map(f => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={format === f}
              onClick={() => { setFormat(f); setImageReady(false) }}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                format === f
                  ? 'bg-purple-500/25 text-white shadow-[inset_0_0_0_1px_rgba(216,180,254,0.35)]'
                  : 'text-white/55 hover:text-white/80'
              }`}
            >
              {cardFormatLabel(f)}
            </button>
          ))}
        </div>

        {/* Preview. The box reserves the card's aspect ratio up front so
            the modal doesn't jump when a 2.9 MB PNG finishes decoding. */}
        <div className="mt-3 grid place-items-center rounded-xl border border-white/[0.06] bg-black/40 p-3">
          <div className="w-40 max-w-full rounded-lg overflow-hidden bg-white/[0.03]" style={previewStyle}>
            {imageURL && (
              <img
                src={imageURL}
                alt={`Watch party card for code ${code}`}
                width={dims.width}
                height={dims.height}
                onLoad={() => setImageReady(true)}
                onError={() => setError('The card image could not be loaded')}
                className={`w-full h-full object-cover transition-opacity duration-300 ${
                  imageReady ? 'opacity-100' : 'opacity-0'
                }`}
              />
            )}
          </div>
        </div>

        <p className="text-white/35 text-[11px] mt-2 leading-relaxed">
          Times on the card are Eastern. Only your name appears — nobody
          you invited is shown.
        </p>

        {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
        {notice && <p className="text-emerald-300 text-xs mt-2" role="status">{notice}</p>}

        <div className="mt-4 flex gap-2 flex-wrap">
          <button
            type="button"
            disabled={!imageURL || busy}
            onClick={() => void onDownload()}
            className="px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Saving…' : 'Download PNG'}
          </button>
          <button
            type="button"
            disabled={!links}
            onClick={() => void onCopyLink()}
            className="px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.1] text-white/75 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Copy link
          </button>
        </div>
      </div>
    </div>
  )
}
