// Aurora V2 — PartyInvite (DESKTOP host UI)
//
// Shown on the big screen so guests can join the watch party from their
// phones. Renders the 6-char join code, a server-rendered QR PNG that
// encodes the /v2/join/<CODE> deep link, and a copy-link button. The
// integrator mounts this on the desktop host UI (e.g. inside PartyPanel
// or a "Invite" affordance) — it's self-contained and Aurora-styled.
//
// The QR is produced by the server (party_share.go image pipeline) at
// GET /api/parties/{code}/qr.png; companionQrURL() builds the URL. When
// the QR endpoint isn't available yet, the component degrades gracefully
// to "code + copy link" without throwing.

import { useCallback, useEffect, useRef, useState } from 'react'
import { companionJoinPath, companionQrURL } from '@/lib/api'

export interface PartyInviteProps {
  // 6-char party code (uppercase). The component validates shape and
  // renders a disabled state for anything malformed.
  code: string
  // Optional party/media label for the header.
  partyName?: string
  // Optional close handler — when provided, renders an ✕ in the corner
  // (so the host can dismiss the invite panel).
  onClose?: () => void
  className?: string
}

export function PartyInvite({ code, partyName, onClose, className = '' }: PartyInviteProps) {
  const normalized = (code || '').toUpperCase()
  const valid = /^[A-Z0-9]{6}$/.test(normalized)

  const joinUrl = valid ? companionJoinPath(normalized) : ''
  const qrSrc = valid ? companionQrURL(normalized) : ''

  const [qrFailed, setQrFailed] = useState(false)
  const [copied, setCopied] = useState<'link' | 'code' | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reset the QR error state if the code changes (e.g. host swaps room).
  useEffect(() => { setQrFailed(false) }, [qrSrc])

  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])

  const copy = useCallback(async (text: string, what: 'link' | 'code') => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        // Fallback for non-secure contexts where the async clipboard
        // API is unavailable.
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      }
      setCopied(what)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(null), 1800)
    } catch {
      /* clipboard blocked — the visible code/link is still selectable */
    }
  }, [])

  if (!valid) {
    return (
      <div className={`rounded-sheet bg-surface-raised-2 p-5 text-[14px] text-ink-2 ${className}`}>
        No active party code to share yet.
      </div>
    )
  }

  return (
    <div className={`relative rounded-sheet bg-surface-raised-2 p-5 shadow-[0_24px_64px_rgba(0,0,0,0.6)] ${className}`}>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="absolute right-2 top-2 grid h-11 w-11 place-items-center rounded-control text-ink-2 transition-colors hover:bg-surface-raised hover:text-ink"
          aria-label="Close invite"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      )}

      <p className="pr-10 font-display text-[17px] font-semibold text-ink">Invite to the party</p>
      <p className="mt-0.5 pr-10 text-[13px] leading-snug text-ink-2">
        {partyName ? `${partyName} · ` : ''}Scan to join on a phone, to chat, react and talk along.
      </p>

      <div className="mt-4 flex items-center gap-4">
        {/* The QR code, drawn by the server. If it does not load, the code
            and the link beside it still work. White on purpose: a scanner
            needs dark on light. */}
        <div className="flex h-[124px] w-[124px] flex-shrink-0 items-center justify-center overflow-hidden rounded-art bg-white p-1.5">
          {!qrFailed ? (
            <img
              src={qrSrc}
              alt={`QR code to join party ${normalized}`}
              width={112}
              height={112}
              className="h-full w-full"
              onError={() => setQrFailed(true)}
            />
          ) : (
            <span className="px-2 text-center text-xs leading-tight text-action-on">
              No QR code. Use the code or the link.
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-ink-2">Join code</p>
          <button
            type="button"
            onClick={() => void copy(normalized, 'code')}
            className="mt-0.5 flex min-h-11 items-center gap-2 rounded-chip font-mono text-[24px] font-bold tracking-[0.14em] text-ink"
            title="Copy code"
            aria-label={`Copy join code ${normalized}`}
          >
            {normalized}
            <CopyGlyph active={copied === 'code'} />
          </button>

          <button type="button" onClick={() => void copy(joinUrl, 'link')} className="stage-btn stage-btn-ghost mt-2 px-4">
            <CopyGlyph active={copied === 'link'} />
            {copied === 'link' ? 'Link copied' : 'Copy invite link'}
          </button>

          <p className="mt-2 truncate text-xs text-ink-2" title={joinUrl}>{joinUrl}</p>
        </div>
      </div>
      {/* Said, not only shown by a tick changing colour. */}
      <p role="status" className="sr-only">{copied === 'code' ? 'Code copied' : copied === 'link' ? 'Link copied' : ''}</p>
    </div>
  )
}

function CopyGlyph({ active }: { active: boolean }) {
  return active ? (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-ok" aria-hidden="true">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 opacity-70" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
