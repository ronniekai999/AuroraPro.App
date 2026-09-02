// useExitTransition — keep a closing surface mounted for its exit animation.
//
// Every overlay in the app was `{open && <Panel/>}`: an enter animation on
// the way in (`.animate-fade-in`) and a one-frame disappearance on the way
// out. This hook gives the caller two booleans instead of one — `mounted`
// decides whether to render, `closing` decides whether to add the exit
// class — and turns `mounted` off only after the exit has had time to play.
//
// Why a timer and not `animationend`: under prefers-reduced-motion the exit
// animation is nulled and the event never fires, and jsdom has no animations
// at all, so a listener-based unmount would strand the surface. The
// reduced-motion case unmounts immediately instead (no exit to wait for).
//
// Re-open during the exit cancels the pending unmount: partyPanelLeave.test
// closes and re-opens the same confirm inside one test, and a timer that
// outlived the re-open would unmount it mid-interaction.
//
// Keep-mounted rather than CSS `@starting-style` + `transition-behavior:
// allow-discrete`: that pair has no Safari < 17.4 support and iPhone Safari
// is an explicit target here.

import { useEffect, useRef, useState } from 'react'

export interface ExitTransition {
  /** Render the surface while true: it is open, or closing and still animating. */
  mounted: boolean
  /** True while the exit is playing — the caller adds its closing class. */
  closing: boolean
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** Default exit length. Matches `--dur-fast` (150ms) in index.css; the CSS
 *  exit keyframes are authored at the same length so the unmount lands as
 *  the animation ends. Pass a longer value for a surface whose exit rule is
 *  longer (the toast slide is `--dur-base`). */
export const EXIT_MS = 150

export function useExitTransition(open: boolean, durationMs: number = EXIT_MS): ExitTransition {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (open) {
      // Re-open (possibly mid-exit): keep it mounted, drop the exit class.
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    if (durationMs <= 0 || prefersReducedMotion()) {
      setMounted(false)
      setClosing(false)
      return
    }
    setClosing(true)
    timer.current = window.setTimeout(() => {
      timer.current = null
      setMounted(false)
      setClosing(false)
    }, durationMs)
    // Cleanup runs before the next run of this effect — i.e. on re-open —
    // and on unmount of the owner, so a pending unmount can never fire late.
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
    }
  }, [open, mounted, durationMs])

  return { mounted, closing }
}
