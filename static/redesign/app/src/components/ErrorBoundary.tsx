// ErrorBoundary — top-level React error boundary.
//
// 2026-05-19 audit (FE-H1) — the SPA previously had NO error boundary
// anywhere. A render-time throw in the ~6,000-line component tree
// would unmount the whole app and leave the user staring at a blank
// white page with no way to recover except a hard refresh. This
// component catches the throw, logs a stack to console (dev only),
// and renders the error screen (ErrorScreen) so the user gets a clear
// next step instead of an opaque void.
//
// React 19 ships a useErrorBoundary hook but it's still in beta;
// class components remain the documented stable way to implement
// the boundary contract (componentDidCatch + getDerivedStateFromError).
//
// We intentionally do NOT auto-redirect or auto-reload — both
// behaviors silently lose the user's in-flight state (e.g. a video
// they were watching, an admin form they were filling out). The
// reload button is opt-in.

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { announceStaleBundle, isStaleBundleError } from '@/lib/buildUpdate'
import { messageOf, thisPage } from '@/lib/errorReport'
import { ErrorScreen } from './ErrorScreen'
import { ErrorGuard } from './ErrorGuard'

interface Props {
  children: ReactNode
  /**
   * Optional override for the fallback UI. Receives the captured
   * error and a retry callback that resets the boundary's internal
   * state — use this for per-route boundaries that should let the
   * user back into the route after a transient error.
   */
  fallback?: (error: Error, retry: () => void) => ReactNode
}

// `caught` and not the error itself says whether something was thrown:
// anything can be, null and undefined included, and the tree that threw
// must not be drawn again because what it threw was falsy.
interface State {
  caught: boolean
  error: unknown
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { caught: false, error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { caught: true, error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Dev: surface stack to console for debugging.
    // Prod: still log but with no stack — prevents internal-detail
    // leakage if a console snapshot ends up in a bug report.
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary] caught', error, info.componentStack)
    } else {
      console.error('[ErrorBoundary] caught', messageOf(error))
    }
    // A lazy view whose chunk a deploy deleted: let the update notice check
    // now rather than at its next timer tick.
    if (isStaleBundleError(messageOf(error))) announceStaleBundle()
  }

  retry = () => {
    this.setState({ caught: false, error: null })
  }

  render() {
    const { caught, error } = this.state
    if (!caught) return this.props.children

    if (this.props.fallback) {
      return this.props.fallback(error as Error, this.retry)
    }

    // The default: the app's error screen. What it shows and offers, and
    // why it reads nothing from the tree it replaces, is in ErrorScreen.
    // It has no "try again": drawing the same tree from the same state
    // stops at the same place, and for a chunk that did not load the
    // browser keeps the failed import, so the ways forward are a reload and
    // a fresh start at Tonight.
    //
    // Nothing is above this boundary but the root, so the screen has a
    // guard of its own: if it throws, a last page drawn from fixed markup
    // takes its place, rather than a blank one.
    return (
      <ErrorGuard fallback={<LastResort />}>
        <ErrorScreen error={error} />
      </ErrorGuard>
    )
  }
}

/** The page drawn when the error screen itself could not be. Fixed words,
 *  inline styles, one way out. */
function LastResort() {
  return (
    <div
      data-error-last-resort=""
      style={{
        minHeight: '100vh', boxSizing: 'border-box', padding: '64px clamp(16px, 4vw, 48px)',
        background: '#0e0f11', color: '#f4f4f5', fontFamily: 'system-ui, sans-serif', fontSize: 16, lineHeight: 1.5,
      }}
    >
      <h1 style={{ margin: '0 0 12px', fontSize: 32, lineHeight: 1.1, fontWeight: 800 }}>That did not load.</h1>
      <p style={{ margin: '0 0 24px', maxWidth: 520, color: '#b4b6bc' }}>
        This page hit a problem and stopped. A reload usually brings it back.
      </p>
      <button
        type="button"
        onClick={() => { try { thisPage.reload() } catch { /* nothing more to try */ } }}
        style={{
          height: 52, padding: '0 28px', border: 'none', borderRadius: 999, background: '#ffffff', color: '#0e0f11',
          fontFamily: 'inherit', fontSize: 16, fontWeight: 600, cursor: 'pointer',
        }}
      >
        Reload
      </button>
    </div>
  )
}
