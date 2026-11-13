// Toast UI — live-region notifications. Extracted from App.tsx
// (2026-06-17 app split). App owns the toast state + the stable
// addToast/removeToast callbacks and mounts <ToastContainer>; the
// interface and the two presentational components live here so the
// lazy view chunks can surface toasts via their onToast prop without
// importing App. Carries the 2026-06-17 a11y quick-win (live-region
// roles + hover/focus pause + keyboard dismiss) verbatim.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/Icon'

export interface Toast {
  id: string
  message: string
  type: 'success' | 'error' | 'info'
  /** The one thing to do about it (Undo). Such a toast stays longer, and
   *  goes when its action is pressed. The action runs once at most. */
  action?: { label: string; run: () => void }
}

/** How long a toast stays: long enough to read, and to reach its action. */
const STAY_MS = 3000
const STAY_WITH_ACTION_MS = 7000

export function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  return (
    // 2026-05-27 (holistic deep-debug H1) — opt out of html2canvas
    // bug-report captures. Toasts are transient meta-UI, not the
    // page content the user is trying to demo, so they shouldn't
    // leak into bug evidence. Matches the bug report dialog's opt-out.
    //
    // In the bottom left corner, at the page's own margin, above the phone's
    // tab bar where there is one and above the update notice while that is
    // up; clear of the player's own things in that corner (its controls in
    // the window, its card while it casts minimized). All in .toast-stack.
    <div className="toast-stack" data-screenshot-exclude="true">
      {toasts.map(t => (
        <ToastItem key={t.id} t={t} onRemove={onRemove} />
      ))}
    </div>
  )
}

// 2026-06-17 (a11y quick-win) — single toast with a live-region role
// (role="alert" for errors = assertive, role="status" for success/info
// = polite) so screen readers actually announce toasts, a hover/focus
// pause, and a keyboard dismiss button. Owns its own 3s timer; the
// previous shared effect re-set a fresh 3s timeout for ALL toasts on
// every render (so a busy session could keep them alive indefinitely).
// `onRemove` (App's removeToast) is a stable useCallback, so this timer
// effect only re-runs on pause toggle, not every parent render.
function ToastItem({ t, onRemove }: { t: Toast; onRemove: (id: string) => void }) {
  // The timer waits while the pointer is on the toast or the focus is in
  // it, each for itself: one flag for both let the pointer leaving restart
  // the timer under a viewer whose focus was still on Undo.
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused
  // Exit: the toast used to vanish in one frame when its timer fired or the
  // × was clicked (App's removeToast filters it out of the array). It now
  // plays .toast.is-leaving (toastOut, --dur-base) and asks to be removed
  // when that has run. App still owns removal; this only delays the ask.
  // Under prefers-reduced-motion the exit is nulled in CSS and skipped here.
  const [leaving, setLeaving] = useState(false)
  const leaveTimer = useRef<number | null>(null)
  const leave = useCallback(() => {
    if (leaveTimer.current !== null) return
    const reduce = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) { onRemove(t.id); return }
    setLeaving(true)
    leaveTimer.current = window.setTimeout(() => onRemove(t.id), 220)
  }, [onRemove, t.id])
  useEffect(() => () => { if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current) }, [])
  useEffect(() => {
    if (paused || leaving) return
    const id = window.setTimeout(leave, t.action ? STAY_WITH_ACTION_MS : STAY_MS)
    return () => window.clearTimeout(id)
  }, [paused, leaving, leave, t.action])
  // The action is taken once. The toast stays on the page for its exit
  // (220ms) with the button still in it, and a second Enter there ran the
  // action again: an Undo, undone.
  const acted = useRef(false)
  const act = () => {
    if (acted.current) return
    acted.current = true
    t.action?.run()
    leave()
  }
  return (
    <div
      className={`toast${leaving ? ' is-leaving' : ''}`}
      // Styling hook only: index.css tints the toast's glow by type.
      data-type={t.type}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      {/* A row of words. Only an error carries a mark: it is the one kind
          that has to be told from the rest at a glance. */}
      {t.type === 'error' && <Icon name="alertTriangle" size={16} className="toast-mark flex-none" />}
      {/* role on the message <p> (not the whole toast) so the live
          region announces ONLY the message, not its buttons. */}
      <p className="toast-text" role={t.type === 'error' ? 'alert' : 'status'}>{t.message}</p>
      {t.action ? (
        <button type="button" className="toast-action" onClick={act}>
          {t.action.label}
        </button>
      ) : (
        <button type="button" onClick={leave} aria-label="Dismiss notification" className="toast-x">
          <Icon name="x" size={16} />
        </button>
      )}
    </div>
  )
}