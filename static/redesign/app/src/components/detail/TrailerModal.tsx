// The trailer, in a dialog over the title page. Trailers are YouTube embeds
// (the app's own player is for its own streams), so this is an iframe. It
// plays as the dialog opens: pressing Trailer is the request to play it, and
// that press is the gesture autoplay needs.
//
// Rendered through a portal so no ancestor's transform or filter can become
// the containing block of this fixed overlay.

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { pushEscapeLayer } from '@/lib/escapeLayers'

interface Props {
  youtubeKey: string
  title?: string
  onClose: () => void
}

export function TrailerModal({ youtubeKey, title, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  // Escape closes the dialog and only the dialog: the app has its own Escape
  // handler on window, which on a title page goes back, and one press used
  // to do both. Through the shared layers (lib/escapeLayers), so that with
  // something of the party's still open underneath (a reaction picker left
  // open in the rail), one press closes the trailer, which is on top, and
  // not the thing under it. (Keys pressed while focus is inside the embed
  // belong to YouTube's page and never reach this one.)
  //
  // The search shortcut stops here too. It puts the focus in the top bar's
  // search field, which is in the page, inert while the trailer is up. (It
  // used to open a palette there: it appeared over the trailer and could not
  // be typed in.)
  useEffect(() => {
    const dropEscape = pushEscapeLayer(onClose)
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.stopPropagation()
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      dropEscape()
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  // While the dialog is open the page behind it is out of reach, and focus
  // lives in the dialog.
  // - Everything else in <body> is made `inert`: `aria-modal` is only a hint
  //   to assistive technology, and without this Tab from the browser's own
  //   chrome (or F6) walked the title page behind an open trailer. The dialog
  //   is portalled to <body>, so "everything else" is its siblings.
  //   That includes the page's live regions: a toast raised while the
  //   trailer is open is not announced. Accepted for a modal that is open
  //   for the length of a trailer.
  // - Focus that lands outside anyway (a sibling added later) is brought
  //   back.
  // - Focus goes to Close, which is there from the first render to the last
  //   (the embed is another document and takes its own time), and on close
  //   returns to whatever opened the dialog. One effect, so the page is
  //   reachable again BEFORE focus is handed back into it.
  useEffect(() => {
    const root = rootRef.current
    const opener = document.activeElement as HTMLElement | null
    const behind = [...document.body.children].filter(el => el !== root && !el.hasAttribute('inert'))
    for (const el of behind) el.setAttribute('inert', '')
    const onFocusIn = (e: FocusEvent) => {
      if (root && e.target instanceof Node && !root.contains(e.target)) closeRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('focusin', onFocusIn)
    closeRef.current?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      for (const el of behind) el.removeAttribute('inert')
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  // youtube-nocookie.com: YouTube's privacy-enhanced embed host.
  const src =
    `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeKey)}` +
    `?autoplay=1&rel=0&modestbranding=1`
  const label = title ? `${title} trailer` : 'Trailer'

  return createPortal(
    <div
      ref={rootRef}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[var(--scrim)] p-4 sm:p-6 stage-scrim-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      data-escape-layers=""
      aria-label={label}
      // Tab wraps at the dialog's ends instead of leaving for the browser's
      // chrome.
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return
        const stops = [...(rootRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), iframe') ?? [])]
        if (stops.length === 0) return
        const first = stops[0], last = stops[stops.length - 1]
        const active = document.activeElement
        if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
        else if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      }}
    >
      <div
        className="w-full max-w-[min(92vw,1040px)] flex flex-col gap-4 stage-dialog-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <h2 className="flex-1 min-w-0 font-display text-[22px] sm:text-[28px] font-bold leading-[1.15] tracking-[-0.015em] text-ink truncate">
            {title ?? 'Trailer'}{' '}
            <span className="font-sans text-[15px] font-normal tracking-normal text-ink-2">Trailer</span>
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close trailer"
            className="w-11 h-11 grid place-items-center rounded-control bg-action-soft text-ink hover:bg-white/[0.16] transition-colors flex-none"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="relative aspect-video rounded-control overflow-hidden bg-black shadow-[0_24px_64px_rgba(0,0,0,0.6)]">
          {/* referrerPolicy overrides the app's `Referrer-Policy: no-referrer`
              for THIS iframe only. Without a referrer YouTube's embed fails
              with "Error 153: video player configuration error", because it
              cannot see the embedding origin. */}
          <iframe
            className="absolute inset-0 h-full w-full"
            src={src}
            title={label}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>

        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="stage-btn stage-btn-ghost">
            {title ? `Back to ${title}` : 'Close'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
