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
      <div className={`glass-panel rounded-2xl p-5 text-sm text-white/50 ${className}`}>
        No active party code to share yet.
      </div>
    )
  }

  return (
    <div className={`glass-panel relative rounded-2xl p-5 ${className}`}>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white"
          aria-label="Close invite"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      )}

      <p className="font-display text-base font-semibold text-white">Invite to the party</p>
      <p className="mt-0.5 text-xs text-white/50">
        {partyName ? `${partyName} · ` : ''}Scan to join on your phone — chat, react, and talk along.
      </p>

      <div className="mt-4 flex items-center gap-4">
        {/* QR tile — server-rendered PNG. On a load error (endpoint not
            present), fall back to a labeled placeholder so the panel
            still works via the code + link. */}
        <div className="flex h-[124px] w-[124px] flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--glow-border)] bg-white p-1.5">
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
            <span className="px-2 text-center text-[10px] leading-tight text-gray-500">
              QR unavailable — use the code or link
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-[0.14em] text-white/40">Join code</p>
          <button
            type="button"
            onClick={() => void copy(normalized, 'code')}
            className="group mt-1 flex items-center gap-2 font-display text-2xl font-bold tracking-[0.18em] text-white transition-colors hover:text-[color:var(--stage-purple-lt)]"
            title="Copy code"
            aria-label={`Copy join code ${normalized}`}
          >
            {normalized}
            <CopyGlyph active={copied === 'code'} />
          </button>

          <button
            type="button"
            onClick={() => void copy(joinUrl, 'link')}
            className="mt-3 inline-flex items-center gap-2 rounded-xl border border-purple-500/40 bg-purple-500/[0.12] px-3 py-2 text-sm font-medium text-[color:var(--stage-purple-lt)] transition-colors hover:bg-purple-500/20"
          >
            <CopyGlyph active={copied === 'link'} />
            {copied === 'link' ? 'Link copied' : 'Copy invite link'}
          </button>

          <p className="mt-2 truncate text-[11px] text-white/35" title={joinUrl}>{joinUrl}</p>
        </div>
      </div>
    </div>
  )
}

function CopyGlyph({ active }: { active: boolean }) {
  return active ? (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-emerald-400" aria-hidden="true">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 opacity-70" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
