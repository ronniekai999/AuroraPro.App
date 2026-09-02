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
}

export function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  return (
    // 2026-05-27 (holistic deep-debug H1) — opt out of html2canvas
    // bug-report captures. Toasts are transient meta-UI, not the
    // page content the user is trying to demo, so they shouldn't
    // leak into bug evidence. Matches the launcher + modal opt-out.
    //
    // 2026-05-27 polish pass — `bottom-[5.5rem]` (was `bottom-6`)
    // so the toast column stacks ABOVE the bug-report launcher pill
    // (which sits at `bottom-5` = 1.25rem in BugReportButton).
    // Previously the launcher was at `bottom: 5rem` to clear the
    // toast column; that flipped the natural "launcher in corner,
    // toasts stack above" pattern users expect. Now the launcher
    // owns the corner and toasts respect it.
    <div className="fixed bottom-[5.5rem] right-6 z-[200] flex flex-col gap-3" data-screenshot-exclude="true">
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
  const [paused, setPaused] = useState(false)
  // Exit: the toast used to vanish in one frame when its timer fired or the
  // × was clicked (App's removeToast filters it out of the array). It now
  // plays .toast.is-leaving (slideOut, --dur-base) and asks to be removed
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
    const id = window.setTimeout(leave, 3000)
    return () => window.clearTimeout(id)
  }, [paused, leaving, leave])
  return (
    <div
      className={`toast${leaving ? ' is-leaving' : ''}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
        t.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' :
        t.type === 'error' ? 'bg-red-500/10 text-red-400' :
        'bg-purple-500/10 text-purple-400'
      }`}>
        <Icon name={t.type === 'success' ? 'check' : t.type === 'error' ? 'x' : 'info'} size={16} />
      </div>
      {/* role on the message <p> (not the whole toast) so the live
          region announces ONLY the message — not the "×" close glyph
          or the decorative icon. */}
      <p className="text-white/80 text-sm" role={t.type === 'error' ? 'alert' : 'status'}>{t.message}</p>
      <button
        type="button"
        onClick={leave}
        aria-label="Dismiss notification"
        className="ml-1 text-white/50 hover:text-white transition-colors flex-shrink-0"
      >
        ×
      </button>
    </div>
  )
}