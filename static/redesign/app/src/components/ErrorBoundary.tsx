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
import { ErrorScreen } from './ErrorScreen'

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

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Dev: surface stack to console for debugging.
    // Prod: still log but with no stack — prevents internal-detail
    // leakage if a console snapshot ends up in a bug report.
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary] caught', error, info.componentStack)
    } else {
      console.error('[ErrorBoundary] caught', error.message)
    }
    // A lazy view whose chunk a deploy deleted: let the update notice check
    // now rather than at its next timer tick.
    if (isStaleBundleError(error)) announceStaleBundle()
  }

  retry = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    if (this.props.fallback) {
      return this.props.fallback(error, this.retry)
    }

    // The default: the app's error screen. What it shows and offers, and
    // why it reads nothing from the tree it replaces, is in ErrorScreen.
    // It has no "try again": drawing the same tree from the same state
    // stops at the same place, and for a chunk that did not load the
    // browser keeps the failed import, so the ways forward are a reload and
    // a fresh start at Tonight.
    return <ErrorScreen error={error} />
  }
}
